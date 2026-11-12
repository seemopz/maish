import {
  getCalendarEventsInRangeMulti,
  upsertCalendarEvent,
  type DbCalendarEvent,
} from "@/services/db/calendarEvents";
import {
  expandOccurrences,
  hasReadableMaster,
  isRecurring,
  seriesEnd,
  seriesRule,
  type Occurrence,
} from "./recurrence";
import type { CalendarEventData } from "./types";

/**
 * Bridge between the stored calendar rows and what a calendar view renders.
 *
 * The database holds what the server holds: one row per calendar object, so a
 * recurring event is a single row carrying an RRULE. Views need one entry per
 * visible instance, which is produced here on read rather than stored. Keeping
 * instances out of the database means a changed rule takes effect immediately,
 * no rows go stale, and the UNIQUE(account_id, google_event_id) constraint —
 * which every instance of a series would otherwise collide on, since they all
 * share one href — stays intact.
 */
export interface CalendarOccurrence extends DbCalendarEvent {
  /** Row id of the stored series master this instance came from. */
  masterId: string;
  /** Epoch seconds identifying the instance within its series; null for one-off events. */
  occurrenceId: number | null;
  /** The server stores a separate VEVENT for this instance. */
  isOverride: boolean;
  /** Generated from a recurrence rule rather than stored in its own right. */
  isSeriesInstance: boolean;
}

/** True when the stored row describes a series rather than a single event. */
export function rowRecurs(row: DbCalendarEvent): boolean {
  return row.rrule !== null || row.recurrence_end !== null;
}

/**
 * Turn stored rows into the instances overlapping [startTime, endTime).
 * Non-recurring rows pass through untouched, so the common case costs nothing.
 */
export function expandRows(
  rows: DbCalendarEvent[],
  startTime: number,
  endTime: number,
): CalendarOccurrence[] {
  const occurrences: CalendarOccurrence[] = [];

  /** Show the stored row itself, if the window actually covers it. */
  const passThrough = (row: DbCalendarEvent) => {
    if (row.start_time < endTime && row.end_time > startTime) {
      occurrences.push({
        ...row,
        masterId: row.id,
        occurrenceId: null,
        isOverride: false,
        isSeriesInstance: false,
      });
    }
  };

  for (const row of rows) {
    if (!rowRecurs(row) || !row.ical_data) {
      passThrough(row);
      continue;
    }

    try {
      // An object the parser cannot read would expand to nothing, which is
      // indistinguishable from a series that genuinely has no instance here —
      // and would quietly drop the event from the calendar. Only a readable
      // master is allowed to produce an empty result.
      if (!hasReadableMaster(row.ical_data)) {
        console.warn("Calendar object has no readable event, showing it as stored", row.id);
        passThrough(row);
        continue;
      }

      for (const occurrence of expandOccurrences(row.ical_data, startTime, endTime)) {
        occurrences.push(toOccurrence(row, occurrence));
      }
    } catch (err) {
      console.warn("Could not expand recurring event", row.id, err);
      passThrough(row);
    }
  }

  occurrences.sort((a, b) => a.start_time - b.start_time);
  return occurrences;
}

function toOccurrence(row: DbCalendarEvent, occurrence: Occurrence): CalendarOccurrence {
  return {
    ...row,
    // Unique per rendered instance, so React keys and selection stay distinct.
    id: `${row.id}#${occurrence.recurrenceId}`,
    masterId: row.id,
    summary: occurrence.summary,
    description: occurrence.description,
    location: occurrence.location,
    start_time: occurrence.startTime,
    end_time: occurrence.endTime,
    is_all_day: occurrence.isAllDay ? 1 : 0,
    status: occurrence.status,
    organizer_email: occurrence.organizerEmail,
    attendees_json: occurrence.attendeesJson,
    occurrenceId: occurrence.recurrenceId,
    isOverride: occurrence.isOverride,
    isSeriesInstance: true,
  };
}

/** Read a range from the database and expand it in one step. */
export async function getOccurrencesInRange(
  accountId: string,
  calendarIds: string[],
  startTime: number,
  endTime: number,
): Promise<CalendarOccurrence[]> {
  const rows = await getCalendarEventsInRangeMulti(accountId, calendarIds, startTime, endTime);
  return expandRows(rows, startTime, endTime);
}

/** Store an event as a provider returned it. Every sync path goes through here. */
export async function storeProviderEvent(
  accountId: string,
  calendarId: string | null,
  event: CalendarEventData,
): Promise<void> {
  // A recurring event is stored once, as the server's master. The rule and the
  // end of the series are kept alongside it so the range query can find it in
  // months its own DTSTART does not fall in.
  const recurring = event.icalData ? isRecurring(event.icalData) : false;

  await upsertCalendarEvent({
    accountId,
    googleEventId: event.remoteEventId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    startTime: event.startTime,
    endTime: event.endTime,
    isAllDay: event.isAllDay,
    status: event.status,
    organizerEmail: event.organizerEmail,
    attendeesJson: event.attendeesJson,
    htmlLink: event.htmlLink,
    calendarId,
    remoteEventId: event.remoteEventId,
    etag: event.etag,
    icalData: event.icalData,
    uid: event.uid,
    rrule: recurring ? seriesRule(event.icalData!) : null,
    recurrenceEnd: recurring ? seriesEnd(event.icalData!) : null,
  });
}
