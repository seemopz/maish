import { useState, useCallback } from "react";
import { MapPin, Clock, User, Pencil, Trash2, Repeat } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { TextField } from "@/components/ui/TextField";
import type { CalendarOccurrence } from "@/services/calendar/occurrences";
import type { DbCalendar } from "@/services/db/calendars";
import type { OccurrenceTarget, RecurrenceScope } from "@/services/calendar/types";
import { getCalendarProvider } from "@/services/calendar/providerFactory";
import { describeRule, seriesTimeZone } from "@/services/calendar/recurrence";
import { parseRecurrenceForm, type RecurrenceForm } from "@/services/calendar/recurrenceForm";
import { dayRange, lastDayInstant, localDay, toLocalISOString } from "@/services/calendar/allDay";
import { CalendarWriteError } from "@/services/calendar/errors";
import { deleteCalendarEvent as deleteCalendarEventDb } from "@/services/db/calendarEvents";
import { RecurrenceField } from "./RecurrenceField";

interface EventDetailModalProps {
  event: CalendarOccurrence;
  calendars: DbCalendar[];
  accountId: string;
  onClose: () => void;
  onUpdated: () => void;
}

const SCOPE_LABELS: { value: RecurrenceScope; label: string }[] = [
  { value: "this", label: "This event" },
  { value: "thisAndFollowing", label: "This and following events" },
  { value: "all", label: "All events in the series" },
];

export function EventDetailModal({ event, calendars, accountId, onClose, onUpdated }: EventDetailModalProps) {
  const allDay = event.is_all_day === 1;
  // The stored end is the exclusive boundary, so the last day the event covers
  // is the one holding the moment before it — the day to show and to ask for.
  const lastInstant = lastDayInstant(event.start_time, event.end_time);

  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(event.summary ?? "");
  const [description, setDescription] = useState(event.description ?? "");
  const [location, setLocation] = useState(event.location ?? "");
  const initialStart = toLocalISOString(new Date(event.start_time * 1000));
  const initialEnd = allDay
    ? `${localDay(lastInstant)}T00:00`
    : toLocalISOString(new Date(event.end_time * 1000));
  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scope, setScope] = useState<RecurrenceScope>("this");
  const [error, setError] = useState<string | null>(null);

  const calendar = calendars.find((c) => c.id === event.calendar_id);

  // Only a generated instance can be changed for part of a series; a one-off
  // event has nothing to choose between.
  const isSeries = event.isSeriesInstance && event.occurrenceId !== null;
  const repeatLabel = describeRule(event.rrule);

  // Changing a rule means patching the stored calendar object, so it is offered
  // only where that object is at hand. Google expands its series server side
  // and sends single instances with no iCalendar data behind them, which is
  // also why an instance there has no rule to edit in the first place.
  const canEditRepeat = Boolean(event.ical_data);
  const [parsedRule] = useState(() =>
    parseRecurrenceForm(event.rrule, seriesTimeZone(event.ical_data)),
  );
  const [recurrence, setRecurrence] = useState<RecurrenceForm | null>(
    parsedRule.kind === "simple" ? parsedRule.form : null,
  );
  // A rule the control cannot state is left alone until it is deliberately
  // replaced, and an untouched control sends nothing at all — so a change to
  // the title never rewrites the repetition as a side effect.
  const [customRule, setCustomRule] = useState(
    parsedRule.kind === "custom" ? (repeatLabel ?? "Repeats on a custom schedule") : null,
  );
  const [repeatChanged, setRepeatChanged] = useState(false);

  // An instance cannot carry a rule of its own: repetition belongs to the
  // series, so it can only be changed together with one.
  const repeatLocked = isSeries && scope === "this";

  const handleRecurrenceChange = useCallback((next: RecurrenceForm | null) => {
    setRecurrence(next);
    setCustomRule(null);
    setRepeatChanged(true);
  }, []);

  const startDate = startTime.slice(0, 10);
  const endDate = endTime.slice(0, 10);

  const setStartDate = useCallback((date: string) => {
    setStartTime((current) => `${date}T${current.slice(11)}`);
    // The end follows a start that moves past it, so the range never runs
    // backwards while it is being changed.
    setEndTime((current) => (current.slice(0, 10) < date ? `${date}T${current.slice(11)}` : current));
  }, []);

  const setEndDate = useCallback((date: string) => {
    setEndTime((current) => `${date}T${current.slice(11)}`);
  }, []);

  const targetFor = useCallback((chosen: RecurrenceScope): OccurrenceTarget | undefined => {
    if (!isSeries || event.occurrenceId === null) return undefined;
    return { recurrenceId: event.occurrenceId, scope: chosen };
  }, [isSeries, event.occurrenceId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const provider = await getCalendarProvider(accountId);
      const calendarRemoteId = calendar?.remote_id ?? "primary";
      const remoteEventId = event.remote_event_id ?? event.google_event_id;
      // The dialog holds the day the event ends on; a provider is handed the
      // day after it.
      const range = dayRange(allDay, startTime, endTime);
      // The fields hold the clicked instance's times: for the whole series they
      // go out only when changed (the provider shifts the series by the change),
      // since sent untouched they would move the series start onto this instance.
      const sendTimes = !(isSeries && scope === "all")
        || startTime !== initialStart || endTime !== initialEnd;

      await provider.updateEvent(calendarRemoteId, remoteEventId, {
        summary,
        // An empty field is sent as "" so clearing it reaches the server.
        description,
        location,
        ...(sendTimes ? {
          startTime: new Date(range.startTime).toISOString(),
          endTime: new Date(range.endTime).toISOString(),
        } : {}),
        // Stated on every save: without it the Google provider writes
        // start.dateTime, which turns an all-day event into a timed one behind
        // the user's back.
        isAllDay: allDay,
        // Leaving the field out keeps the stored rule, which is what has to
        // happen whenever the repetition was not touched.
        ...(repeatChanged && !repeatLocked ? { recurrence } : {}),
      }, event.etag ?? undefined, targetFor(scope));

      onUpdated();
    } catch (err) {
      console.error("Failed to update event:", err);
      setError(writeErrorMessage(err, "Could not save the event."));
    } finally {
      setSaving(false);
    }
  }, [accountId, calendar, event, summary, description, location, startTime, endTime, initialStart, initialEnd, allDay, isSeries, scope, recurrence, repeatChanged, repeatLocked, targetFor, onUpdated]);

  const handleDelete = useCallback(async (chosen: RecurrenceScope) => {
    setDeleting(true);
    setError(null);
    try {
      const provider = await getCalendarProvider(accountId);
      const calendarRemoteId = calendar?.remote_id ?? "primary";
      const remoteEventId = event.remote_event_id ?? event.google_event_id;

      const result = await provider.deleteEvent(
        calendarRemoteId,
        remoteEventId,
        event.etag ?? undefined,
        targetFor(chosen),
      );

      // Removing part of a series usually only rewrites the stored object, so
      // the row stays and is refreshed by the reload below. The provider says
      // when the object itself is gone — deleting the whole series, or cutting
      // one so early that nothing is left of it.
      if (result.objectRemoved) {
        await deleteCalendarEventDb(event.masterId);
      }

      onUpdated();
    } catch (err) {
      console.error("Failed to delete event:", err);
      setError(writeErrorMessage(err, "Could not delete the event."));
    } finally {
      setDeleting(false);
    }
  }, [accountId, calendar, event, isSeries, targetFor, onUpdated]);

  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatDay = (ts: number) => {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  };

  const attendees = event.attendees_json ? JSON.parse(event.attendees_json) as { email: string; displayName?: string }[] : [];

  if (editing) {
    return (
      <Modal isOpen={true} onClose={onClose} title="Edit Event" width="w-full max-w-md">
        <div className="p-4 space-y-3">
          <TextField
            label="Title"
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            autoFocus
          />

          {/* Shown only where there is something to say: an inert switch on a
              timed event would just invite a click that does nothing. */}
          {allDay && (
            <div>
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input
                  type="checkbox"
                  checked
                  readOnly
                  disabled
                  className="rounded accent-accent"
                />
                All day
              </label>
              <p className="text-xs text-text-tertiary mt-1">
                An event cannot be changed between all day and timed here.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {allDay ? (
              <>
                <TextField
                  label="Start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
                <TextField
                  label="End"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </>
            ) : (
              <>
                <TextField
                  label="Start"
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
                <TextField
                  label="End"
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </>
            )}
          </div>

          {canEditRepeat && (
            <RecurrenceField
              value={recurrence}
              onChange={handleRecurrenceChange}
              startDate={startTime.slice(0, 10)}
              customRule={customRule}
              disabledReason={
                repeatLocked
                  ? "Repetition belongs to the whole series. Choose another option below to change it."
                  : undefined
              }
            />
          )}

          <TextField
            label="Location"
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Add location"
          />

          <div>
            <label htmlFor="event-detail-description" className="label-mono block mb-1.5">Description</label>
            <textarea
              id="event-detail-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add description"
              rows={3}
              className="w-full px-3 py-2 bg-bg-primary border border-border-primary rounded-md text-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-text-tertiary focus:ring-2 focus:ring-text-primary/10 resize-none"
            />
          </div>

          {isSeries && (
            <fieldset className="border-t border-border-primary pt-3">
              <legend className="sr-only">Which events to change</legend>
              <div className="label-mono mb-1.5">Apply changes to</div>
              <div className="space-y-1">
                {SCOPE_LABELS.map((option) => (
                  <label key={option.value} className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                    <input
                      type="radio"
                      name="edit-scope"
                      value={option.value}
                      checked={scope === option.value}
                      onChange={() => setScope(option.value)}
                      className="accent-accent"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="md" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="md" onClick={handleSave} disabled={saving || !summary.trim()}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={true} onClose={onClose} title={event.summary ?? "Event"} width="w-full max-w-md">
      <div className="p-4 space-y-3">
        {calendar && (
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: calendar.color ?? "var(--color-accent)" }}
            />
            {calendar.display_name}
          </div>
        )}

        <div className="flex items-start gap-2.5 text-sm text-text-secondary">
          <Clock size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
          <div className="font-mono text-[13px] tabular-nums">
            {allDay ? (
              <>
                <div>
                  {formatDay(event.start_time)}
                  {localDay(event.start_time) !== localDay(lastInstant) && ` – ${formatDay(lastInstant)}`}
                </div>
                <div>All day</div>
              </>
            ) : (
              <>
                <div>{formatTime(event.start_time)}</div>
                <div>{formatTime(event.end_time)}</div>
              </>
            )}
          </div>
        </div>

        {repeatLabel && (
          <div className="flex items-start gap-2.5 text-sm text-text-secondary">
            <Repeat size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
            <span>
              {repeatLabel}
              {event.isOverride && " — this occurrence was changed"}
            </span>
          </div>
        )}

        {event.location && (
          <div className="flex items-start gap-2.5 text-sm text-text-secondary">
            <MapPin size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
            <span>{event.location}</span>
          </div>
        )}

        {event.description && (
          <div className="text-sm text-text-secondary whitespace-pre-wrap border-t border-border-primary pt-3">
            {event.description}
          </div>
        )}

        {attendees.length > 0 && (
          <div className="border-t border-border-primary pt-3">
            <div className="label-mono mb-1.5">Attendees</div>
            <div className="space-y-1">
              {attendees.map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-text-secondary">
                  <User size={12} className="text-text-tertiary" />
                  <span>{a.displayName ?? a.email}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="pt-2 border-t border-border-primary">
          {confirmDelete && isSeries ? (
            <div className="space-y-2">
              <div className="text-xs text-danger">Delete which events?</div>
              <div className="flex flex-wrap gap-2">
                {SCOPE_LABELS.map((option) => (
                  <Button
                    key={option.value}
                    variant="danger"
                    size="xs"
                    onClick={() => handleDelete(option.value)}
                    disabled={deleting}
                  >
                    {option.label}
                  </Button>
                ))}
                <Button variant="secondary" size="xs" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-danger">Delete this event?</span>
              <Button variant="danger" size="xs" onClick={() => handleDelete("all")} disabled={deleting}>
                {deleting ? "Deleting..." : "Yes, delete"}
              </Button>
              <Button variant="secondary" size="xs" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex justify-between">
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil size={14} />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * What to tell the user about a refused write. A conflict is the one case they
 * can do something about: the stored event moved on since it was opened, so the
 * change has to be made again on the current version.
 */
function writeErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof CalendarWriteError && err.isConflict) {
    return "This event was changed elsewhere. Close it, reopen it and try again.";
  }
  return fallback;
}
