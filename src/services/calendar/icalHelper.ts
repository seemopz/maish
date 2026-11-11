import type { CalendarEventData, CreateEventInput, UpdateEventInput } from "./types";
import { buildVTimezone, formatDateTimeInZone, wallClockToEpoch, type WallClock } from "./timezone";
// iCalendar and vCard share a line format, so they share its parser.
import {
  escapeText,
  parseContentLine,
  unescapeText,
  unfoldLines,
} from "@/services/dav/contentLine";
import { buildRRule, localZone, type RuleDateStyle } from "./recurrenceForm";

/**
 * Generate a VEVENT iCalendar string from event input.
 */
export function generateVEvent(
  event: CreateEventInput | UpdateEventInput,
  uid?: string,
  zone: string | null = localZone(),
): string {
  const eventUid = uid ?? crypto.randomUUID();
  const now = formatDateTimeUTC(new Date());

  // A timed series is written in local wall time with its zone, so the rule is
  // evaluated there and keeps its time of day across DST (as UTC stamps it
  // drifts by an hour). A TZID needs a VTIMEZONE; without one, stay in UTC.
  // shortcut: zones whose changes follow no nth-weekday rule (buildVTimezone
  // returns null) still drift; upgrade with per-year observances if users hit it.
  const vtimezone = event.recurrence && !event.isAllDay && event.startTime && zone
    ? buildVTimezone(zone, new Date(event.startTime).getUTCFullYear() - 1)
    : null;
  const seriesZone = vtimezone ? zone : null;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Maish//CalDAV Client//EN",
    ...(vtimezone ?? []),
    "BEGIN:VEVENT",
    `UID:${eventUid}`,
    `DTSTAMP:${now}`,
  ];

  if (event.summary) {
    lines.push(`SUMMARY:${escapeText(event.summary)}`);
  }

  if (event.startTime && event.endTime) {
    if (event.isAllDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(new Date(event.startTime))}`);
      lines.push(`DTEND;VALUE=DATE:${formatDateOnly(new Date(event.endTime))}`);
    } else if (seriesZone) {
      lines.push(`DTSTART;TZID=${seriesZone}:${zonedValue(event.startTime, seriesZone)}`);
      lines.push(`DTEND;TZID=${seriesZone}:${zonedValue(event.endTime, seriesZone)}`);
    } else {
      lines.push(`DTSTART:${formatDateTimeUTC(new Date(event.startTime))}`);
      lines.push(`DTEND:${formatDateTimeUTC(new Date(event.endTime))}`);
    }
  }

  if (event.recurrence) {
    const style = seriesZone ? { zone: seriesZone, isDate: false } : styleFor(event.isAllDay);
    lines.push(`RRULE:${buildRRule(event.recurrence, style)}`);
  }

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  }

  if (event.location) {
    lines.push(`LOCATION:${escapeText(event.location)}`);
  }

  if ("attendees" in event && event.attendees) {
    for (const attendee of event.attendees) {
      lines.push(`ATTENDEE;RSVP=TRUE:mailto:${attendee.email}`);
    }
  }

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.join("\r\n");
}

/**
 * How a freshly generated event writes its dates, which is what UNTIL has to
 * match: an all-day event gets bare DATE values, a timed one without a zone a UTC stamp.
 */
function styleFor(isAllDay: boolean | undefined): RuleDateStyle {
  return isAllDay ? { zone: null, isDate: true } : { zone: "UTC", isDate: false };
}

// ---------------------------------------------------------------------------
// Component-aware parsing
// ---------------------------------------------------------------------------

export interface IcalProperty {
  /** Upper-case property name, e.g. DTSTART. */
  name: string;
  /** Upper-case parameter names mapped to their values, quotes stripped. */
  params: Record<string, string>;
  /** Raw value, still escaped. */
  value: string;
}

export interface IcalComponent {
  /** Upper-case component name, e.g. VEVENT. */
  name: string;
  props: IcalProperty[];
  children: IcalComponent[];
}

/**
 * Parse an iCalendar stream into a component tree.
 *
 * The tree matters: a VCALENDAR that Apple Calendar writes carries a VTIMEZONE
 * with DAYLIGHT and STANDARD sub-components, and those have RRULE and DTSTART
 * properties of their own. Reading the stream as a flat list of properties —
 * which this parser used to do — makes the zone's yearly DST rule
 * indistinguishable from the event's own recurrence rule.
 */
export function parseIcalComponents(icalData: string): IcalComponent[] {
  const roots: IcalComponent[] = [];
  const stack: IcalComponent[] = [];

  for (const line of unfoldLines(icalData)) {
    const parsed = parseContentLine(line);
    if (!parsed) continue;

    if (parsed.name === "BEGIN") {
      const component: IcalComponent = {
        name: parsed.value.toUpperCase(),
        props: [],
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(component);
      else roots.push(component);
      stack.push(component);
      continue;
    }

    if (parsed.name === "END") {
      stack.pop();
      continue;
    }

    const current = stack[stack.length - 1];
    if (current) current.props.push(parsed);
  }

  return roots;
}

/** Depth-first search for every component with the given name. */
function collectComponents(components: IcalComponent[], name: string): IcalComponent[] {
  const found: IcalComponent[] = [];
  const walk = (list: IcalComponent[]) => {
    for (const component of list) {
      if (component.name === name) found.push(component);
      walk(component.children);
    }
  };
  walk(components);
  return found;
}

/** Every VEVENT in the stream, in document order. */
export function findVEvents(icalData: string): IcalComponent[] {
  return collectComponents(parseIcalComponents(icalData), "VEVENT");
}

export interface IcalDateTime {
  /** Raw value as it appeared, e.g. 20260930T180000. */
  raw: string;
  /** IANA zone from the TZID parameter, or null for UTC, DATE and floating values. */
  tzid: string | null;
  /** VALUE=DATE rather than a date-time. */
  isDate: boolean;
  wall: WallClock;
  epoch: number;
}

export interface VEventFields {
  uid: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  status: string;
  organizerEmail: string | null;
  attendees: { email: string; displayName?: string; responseStatus?: string }[];
  isAllDay: boolean;
  start: IcalDateTime | null;
  end: IcalDateTime | null;
  /** Seconds, from a DURATION property when DTEND is absent. */
  durationSeconds: number | null;
  /** Raw RRULE value, e.g. FREQ=WEEKLY;UNTIL=20270127T225959Z. */
  rrule: string | null;
  rdates: IcalDateTime[];
  exdates: IcalDateTime[];
  /** Set on an override component that replaces one instance of a series. */
  recurrenceId: IcalDateTime | null;
  sequence: number;
}

/** Read the properties this app understands out of a single VEVENT component. */
export function readVEventFields(component: IcalComponent): VEventFields {
  const fields: VEventFields = {
    uid: null,
    summary: null,
    description: null,
    location: null,
    status: "confirmed",
    organizerEmail: null,
    attendees: [],
    isAllDay: false,
    start: null,
    end: null,
    durationSeconds: null,
    rrule: null,
    rdates: [],
    exdates: [],
    recurrenceId: null,
    sequence: 0,
  };

  for (const prop of component.props) {
    switch (prop.name) {
      case "UID":
        fields.uid = prop.value;
        break;
      case "SUMMARY":
        fields.summary = unescapeText(prop.value);
        break;
      case "DESCRIPTION":
        fields.description = unescapeText(prop.value);
        break;
      case "LOCATION":
        fields.location = unescapeText(prop.value);
        break;
      case "DTSTART":
        fields.start = readDateTime(prop);
        fields.isAllDay = fields.start.isDate;
        break;
      case "DTEND":
        fields.end = readDateTime(prop);
        break;
      case "DURATION":
        fields.durationSeconds = parseDuration(prop.value);
        break;
      case "RRULE":
        fields.rrule = prop.value;
        break;
      case "RDATE":
        fields.rdates.push(...readDateTimeList(prop));
        break;
      case "EXDATE":
        fields.exdates.push(...readDateTimeList(prop));
        break;
      case "RECURRENCE-ID":
        fields.recurrenceId = readDateTime(prop);
        break;
      case "SEQUENCE":
        fields.sequence = parseInt(prop.value, 10) || 0;
        break;
      case "STATUS":
        fields.status = prop.value.toLowerCase();
        break;
      case "ORGANIZER": {
        const mailto = prop.value.match(/mailto:(.+)/i);
        if (mailto) fields.organizerEmail = mailto[1]!;
        break;
      }
      case "ATTENDEE": {
        const mailto = prop.value.match(/mailto:(.+)/i);
        if (mailto) {
          fields.attendees.push({
            email: mailto[1]!,
            displayName: prop.params.CN,
            responseStatus: prop.params.PARTSTAT?.toLowerCase(),
          });
        }
        break;
      }
    }
  }

  return fields;
}

/**
 * Split a calendar object into the series master and its per-instance
 * overrides. CalDAV keeps every component sharing a UID in one resource
 * (RFC 4791 §4.1), so a recurring event arrives as one master VEVENT plus one
 * VEVENT per modified instance, each carrying a RECURRENCE-ID.
 */
export function splitCalendarObject(icalData: string): {
  master: VEventFields | null;
  overrides: VEventFields[];
} {
  const components = findVEvents(icalData).map(readVEventFields);
  const master = components.find((c) => c.recurrenceId === null) ?? null;
  const overrides = components.filter((c) => c.recurrenceId !== null);
  return { master, overrides };
}

/**
 * Parse a VEVENT from iCalendar data into CalendarEventData.
 *
 * Returns the series master when the object holds a recurring event; the
 * individual instances are produced by the expander in recurrence.ts.
 */
export function parseVEvent(icalData: string, href?: string): CalendarEventData {
  const events = findVEvents(icalData);
  const component = events.find((c) => !c.props.some((p) => p.name === "RECURRENCE-ID"))
    ?? events[0];
  const fields = component
    ? readVEventFields(component)
    : readVEventFields({ name: "VEVENT", props: [], children: [] });

  return eventDataFromFields(fields, icalData, href);
}

/** Build the stored/rendered shape from parsed VEVENT properties. */
export function eventDataFromFields(
  fields: VEventFields,
  icalData: string,
  href?: string,
): CalendarEventData {
  const startTime = fields.start ? fields.start.epoch : 0;
  const endTime = resolveEnd(fields, startTime);

  return {
    remoteEventId: href ?? fields.uid ?? crypto.randomUUID(),
    uid: fields.uid,
    etag: null,
    summary: fields.summary,
    description: fields.description,
    location: fields.location,
    startTime,
    endTime,
    isAllDay: fields.isAllDay,
    status: fields.status,
    organizerEmail: fields.organizerEmail,
    attendeesJson: fields.attendees.length > 0 ? JSON.stringify(fields.attendees) : null,
    htmlLink: null,
    icalData,
    rrule: fields.rrule,
    recurrenceId: fields.recurrenceId ? fields.recurrenceId.epoch : null,
  };
}

function resolveEnd(fields: VEventFields, startTime: number): number {
  if (fields.end) return fields.end.epoch;
  if (fields.durationSeconds !== null) return startTime + fields.durationSeconds;
  // RFC 5545 §3.6.1: a DATE-valued start with no end lasts one day.
  if (fields.isAllDay) return startTime + 86400;
  return startTime + 3600;
}

function readDateTime(prop: IcalProperty): IcalDateTime {
  const isDate = prop.params.VALUE === "DATE" || /^\d{8}$/.test(prop.value);
  const tzid = prop.params.TZID ?? null;
  return buildDateTime(prop.value, tzid, isDate);
}

function readDateTimeList(prop: IcalProperty): IcalDateTime[] {
  const isDate = prop.params.VALUE === "DATE";
  const tzid = prop.params.TZID ?? null;
  return prop.value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => buildDateTime(part, tzid, isDate || /^\d{8}$/.test(part)));
}

function buildDateTime(raw: string, tzid: string | null, isDate: boolean): IcalDateTime {
  const isUtc = raw.endsWith("Z");
  const cleaned = raw.replace("Z", "");

  const wall: WallClock = {
    year: parseInt(cleaned.substring(0, 4), 10) || 1970,
    month: (parseInt(cleaned.substring(4, 6), 10) || 1),
    day: parseInt(cleaned.substring(6, 8), 10) || 1,
    hour: isDate ? 0 : parseInt(cleaned.substring(9, 11), 10) || 0,
    minute: isDate ? 0 : parseInt(cleaned.substring(11, 13), 10) || 0,
    second: isDate ? 0 : parseInt(cleaned.substring(13, 15), 10) || 0,
  };

  // A trailing Z always wins over TZID; RFC 5545 forbids combining them.
  const zone = isUtc ? "UTC" : tzid;

  return {
    raw,
    tzid: isUtc ? null : tzid,
    isDate,
    wall,
    epoch: wallClockToEpoch(wall, zone),
  };
}

/** RFC 5545 §3.3.6 duration, e.g. PT1H30M or -P1DT2H. Returns seconds. */
export function parseDuration(value: string): number | null {
  const match = value.match(
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/,
  );
  if (!match) return null;

  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    (parseInt(weeks ?? "0", 10) || 0) * 604800 +
    (parseInt(days ?? "0", 10) || 0) * 86400 +
    (parseInt(hours ?? "0", 10) || 0) * 3600 +
    (parseInt(minutes ?? "0", 10) || 0) * 60 +
    (parseInt(seconds ?? "0", 10) || 0);

  return sign === "-" ? -total : total;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDateTimeUTC(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function zonedValue(iso: string, zone: string): string {
  return formatDateTimeInZone(Math.floor(new Date(iso).getTime() / 1000), zone, false);
}

function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
