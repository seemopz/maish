import { getDb } from "./connection";

export interface DbCalendarEvent {
  id: string;
  account_id: string;
  google_event_id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start_time: number;
  end_time: number;
  is_all_day: number;
  status: string;
  organizer_email: string | null;
  attendees_json: string | null;
  html_link: string | null;
  updated_at: number;
  // New CalDAV fields (nullable for backward compat)
  calendar_id: string | null;
  remote_event_id: string | null;
  etag: string | null;
  ical_data: string | null;
  uid: string | null;
  /** RRULE of the series master; null when the event does not recur. */
  rrule: string | null;
  /** Last instant the series can produce an instance; null means unbounded. */
  recurrence_end: number | null;
}

export async function upsertCalendarEvent(event: {
  accountId: string;
  googleEventId: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  startTime: number;
  endTime: number;
  isAllDay: boolean;
  status: string;
  organizerEmail: string | null;
  attendeesJson: string | null;
  htmlLink: string | null;
  calendarId?: string | null;
  remoteEventId?: string | null;
  etag?: string | null;
  icalData?: string | null;
  uid?: string | null;
  rrule?: string | null;
  recurrenceEnd?: number | null;
}): Promise<void> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO calendar_events (id, account_id, google_event_id, summary, description, location, start_time, end_time, is_all_day, status, organizer_email, attendees_json, html_link, calendar_id, remote_event_id, etag, ical_data, uid, rrule, recurrence_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT(account_id, google_event_id) DO UPDATE SET
       summary = $4, description = $5, location = $6, start_time = $7, end_time = $8,
       is_all_day = $9, status = $10, organizer_email = $11, attendees_json = $12,
       html_link = $13, calendar_id = $14, remote_event_id = $15, etag = $16,
       ical_data = $17, uid = $18, rrule = $19, recurrence_end = $20,
       updated_at = unixepoch()`,
    [
      id, event.accountId, event.googleEventId, event.summary, event.description,
      event.location, event.startTime, event.endTime, event.isAllDay ? 1 : 0,
      event.status, event.organizerEmail, event.attendeesJson, event.htmlLink,
      event.calendarId ?? null, event.remoteEventId ?? null, event.etag ?? null,
      event.icalData ?? null, event.uid ?? null,
      event.rrule ?? null, event.recurrenceEnd ?? null,
    ],
  );
}

/**
 * A recurring event is stored once, as the series master, and its instances
 * are produced on read. The master's own start and end therefore say nothing
 * about where its instances fall, so a plain overlap test would drop a weekly
 * appointment from every week but its first. Recurring rows are instead
 * admitted whenever the series can still be running at the start of the
 * window; the expander then discards the ones that miss it.
 */
const RANGE_PREDICATE = `
  start_time < $3
  AND (
    end_time > $2
    OR (
      (rrule IS NOT NULL OR recurrence_end IS NOT NULL)
      AND (recurrence_end IS NULL OR recurrence_end > $2)
    )
  )`;

export async function getCalendarEventsInRange(
  accountId: string,
  startTime: number,
  endTime: number,
): Promise<DbCalendarEvent[]> {
  const db = await getDb();
  return db.select<DbCalendarEvent[]>(
    `SELECT * FROM calendar_events
     WHERE account_id = $1 AND ${RANGE_PREDICATE}
     ORDER BY start_time ASC`,
    [accountId, startTime, endTime],
  );
}

export async function getCalendarEventsInRangeMulti(
  accountId: string,
  calendarIds: string[],
  startTime: number,
  endTime: number,
): Promise<DbCalendarEvent[]> {
  if (calendarIds.length === 0) {
    return getCalendarEventsInRange(accountId, startTime, endTime);
  }
  const db = await getDb();
  const placeholders = calendarIds.map((_, i) => `$${i + 4}`).join(", ");
  return db.select<DbCalendarEvent[]>(
    `SELECT * FROM calendar_events
     WHERE account_id = $1 AND ${RANGE_PREDICATE}
       AND (calendar_id IN (${placeholders}) OR calendar_id IS NULL)
     ORDER BY start_time ASC`,
    [accountId, startTime, endTime, ...calendarIds],
  );
}

export async function deleteEventByRemoteId(
  calendarId: string,
  remoteEventId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM calendar_events WHERE calendar_id = $1 AND remote_event_id = $2",
    [calendarId, remoteEventId],
  );
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM calendar_events WHERE id = $1", [eventId]);
}
