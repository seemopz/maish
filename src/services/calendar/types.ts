import type { RecurrenceForm } from "./recurrenceForm";

export type CalendarProviderType = "google_api" | "caldav";

export interface CalendarInfo {
  remoteId: string;
  displayName: string;
  color: string | null;
  isPrimary: boolean;
  /** CalDAV collection tag: unchanged means no event in it changed. */
  ctag?: string | null;
}

export interface CalendarEventData {
  remoteEventId: string;
  uid: string | null;
  etag: string | null;
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
  icalData: string | null;
  /** Raw RRULE of the series master, null for a one-off event. */
  rrule: string | null;
  /** Epoch seconds identifying one instance of a series (RFC 5545 RECURRENCE-ID). */
  recurrenceId: number | null;
}

export interface CreateEventInput {
  summary: string;
  description?: string;
  location?: string;
  startTime: string; // ISO 8601
  endTime: string;   // ISO 8601
  isAllDay?: boolean;
  attendees?: { email: string }[];
  /** How the event repeats. Absent or null creates a one-off event. */
  recurrence?: RecurrenceForm | null;
}

export interface UpdateEventInput {
  summary?: string;
  description?: string;
  location?: string;
  startTime?: string;
  endTime?: string;
  isAllDay?: boolean;
  /**
   * How the event repeats from now on. Left out the existing rule is kept
   * untouched — which is what has to happen for a rule the repeat control
   * cannot state — and null removes it, turning the series into one event.
   * Only meaningful for the series master: an instance cannot carry a rule of
   * its own, so this is ignored when a single occurrence is being changed.
   */
  recurrence?: RecurrenceForm | null;
}

export interface CalendarSyncResult {
  created: CalendarEventData[];
  updated: CalendarEventData[];
  deletedRemoteIds: string[];
  newSyncToken: string | null;
  newCtag: string | null;
  /**
   * Set when the result lists every event of this range (epoch seconds), not
   * only changes: stored events starting in it that it does not list are gone
   * from the server.
   */
  window?: { start: number; end: number };
}

/**
 * Which instances of a recurring series a change applies to. Only meaningful
 * for CalDAV: Google expands series server side, so each instance already
 * arrives as an event of its own.
 */
export type RecurrenceScope = "this" | "thisAndFollowing" | "all";

export interface OccurrenceTarget {
  /** Epoch seconds identifying the instance (RFC 5545 RECURRENCE-ID). */
  recurrenceId: number;
  scope: RecurrenceScope;
}

export interface DeleteEventResult {
  /**
   * Whether the calendar object itself is gone, so its stored row has to go
   * with it. Removing part of a series normally only rewrites the object and
   * leaves it in place — unless nothing is left of the series afterwards.
   */
  objectRemoved: boolean;
}

export interface CalendarProvider {
  readonly accountId: string;
  readonly type: CalendarProviderType;

  listCalendars(): Promise<CalendarInfo[]>;

  fetchEvents(calendarRemoteId: string, timeMin: string, timeMax: string): Promise<CalendarEventData[]>;
  createEvent(calendarRemoteId: string, event: CreateEventInput): Promise<CalendarEventData>;
  updateEvent(calendarRemoteId: string, remoteEventId: string, event: UpdateEventInput, etag?: string, occurrence?: OccurrenceTarget): Promise<CalendarEventData>;
  deleteEvent(calendarRemoteId: string, remoteEventId: string, etag?: string, occurrence?: OccurrenceTarget): Promise<DeleteEventResult>;

  syncEvents(calendarRemoteId: string, syncToken?: string): Promise<CalendarSyncResult>;

  testConnection(): Promise<{ success: boolean; message: string }>;
}
