import { formatDateTimeInZone, wallClockToEpoch } from "./timezone";

/**
 * The handful of recurrence rules a person can state in a dialog, and the
 * translation to and from RFC 5545 RRULE text.
 *
 * RRULE describes far more than any repeat control can show: BYSETPOS, byweekno,
 * ordinal weekdays, sub-daily frequencies. Rather than pretend otherwise, the
 * parser reports a rule it cannot represent as "custom" and the UI leaves it
 * alone. Downgrading `FREQ=MONTHLY;BYDAY=3TH` to a plain monthly rule the moment
 * someone opens the dialog to fix a typo would silently move every instance of a
 * series another client wrote.
 *
 * This module deliberately depends on nothing but the time-zone helpers, so the
 * iCalendar reader and writer can both use it without importing each other.
 */

export type RepeatFrequency = "daily" | "weekly" | "monthly" | "yearly";

/** When the series stops. A date is inclusive: that day may still hold an instance. */
export type RepeatEnd =
  | { kind: "never" }
  | { kind: "count"; count: number }
  | { kind: "onDate"; date: string };

export interface RecurrenceForm {
  frequency: RepeatFrequency;
  /** Periods between instances, at least 1. */
  interval: number;
  /** Weekdays a weekly rule fires on, 0 = Sunday. Empty follows the start date. */
  byDay: number[];
  end: RepeatEnd;
  /**
   * Week start from the original rule, carried through untouched. It is not
   * offered in the UI but changes what INTERVAL means for a weekly rule, so
   * dropping it on a round trip would move instances.
   */
  wkst?: string;
}

/** How the series writes its date values, which decides the form UNTIL takes. */
export interface RuleDateStyle {
  /** "UTC", an IANA zone, or null for floating time. */
  zone: string | null;
  isDate: boolean;
}

/** What a stored rule turned out to be. */
export type ParsedRecurrence =
  | { kind: "none" }
  | { kind: "simple"; form: RecurrenceForm }
  | { kind: "custom" };

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

const FREQUENCIES: Record<string, RepeatFrequency> = {
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
  YEARLY: "yearly",
};

/** Everything the control knows how to write back. Anything else is custom. */
const KNOWN_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"]);

export const DEFAULT_RECURRENCE: RecurrenceForm = {
  frequency: "weekly",
  interval: 1,
  byDay: [],
  end: { kind: "never" },
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Render the form as an RRULE value, without the "RRULE:" property name. */
export function buildRRule(form: RecurrenceForm, style: RuleDateStyle): string {
  const parts = [`FREQ=${form.frequency.toUpperCase()}`];

  const interval = Math.max(1, Math.floor(form.interval) || 1);
  if (interval > 1) parts.push(`INTERVAL=${interval}`);

  // BYDAY on anything but a weekly rule means something else entirely — on a
  // monthly rule it selects weekdays of the month — so it is only written where
  // the control's meaning matches the spec's.
  if (form.frequency === "weekly" && form.byDay.length > 0) {
    const days = [...new Set(form.byDay)]
      .filter((day) => day >= 0 && day <= 6)
      .sort((a, b) => a - b)
      .map((day) => WEEKDAY_CODES[day]!);
    if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);
  }

  if (form.end.kind === "count") {
    parts.push(`COUNT=${Math.max(1, Math.floor(form.end.count) || 1)}`);
  } else if (form.end.kind === "onDate") {
    const epoch = untilEpoch(form.end.date, style);
    if (epoch !== null) parts.push(`UNTIL=${formatUntil(epoch, style)}`);
  }

  if (form.wkst) parts.push(`WKST=${form.wkst}`);

  return parts.join(";");
}

/**
 * Render an UNTIL value the way the series' DTSTART writes its dates.
 *
 * RFC 5545 §3.3.10 ties the value type to DTSTART's: a date-valued series needs
 * a bare DATE and a floating one needs local time, while a DTSTART in UTC or
 * with a TZID takes a UTC date-time.
 */
export function formatUntil(epochSeconds: number, style: RuleDateStyle): string {
  if (style.isDate) return formatDateTimeInZone(epochSeconds, null, true);
  if (style.zone === null) return formatDateTimeInZone(epochSeconds, null, false);
  return formatDateTimeInZone(epochSeconds, "UTC", false);
}

/**
 * The zone the end date picked in the dialog is a day in.
 *
 * A series carrying a TZID is expanded in that zone, so its own last day is
 * the one to bound. A DTSTART written as a UTC stamp has no zone of its own —
 * one-off events this app generates write one, and so do plenty of servers — and
 * the day the user picked was the day they were shown, which is the day in
 * their own zone. Taking those UTC stamps literally put UNTIL at 23:59:59 UTC,
 * and for anyone west of UTC an evening instance on the chosen day falls after
 * that instant and was dropped from the series.
 */
export function untilZone(style: RuleDateStyle, viewerZone: string | null): string | null {
  if (style.isDate) return null;
  if (style.zone !== null && style.zone !== "UTC") return style.zone;
  return viewerZone;
}

/** The zone the machine is in, which is the zone the dialog showed. */
export function localZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/**
 * The instant a chosen end date bounds the series at. UNTIL is inclusive and
 * compares against instance start times, so a series ending "on 31 December"
 * runs to the last second of that day in the zone that day belongs to.
 */
export function untilEpoch(
  date: string,
  style: RuleDateStyle,
  viewerZone: string | null = localZone(),
): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;

  const [, year, month, day] = match;
  // A date-valued series is rendered back as a bare day, so the time only has
  // to stay clear of the hour a daylight-saving shift could move it across.
  const wall = {
    year: parseInt(year!, 10),
    month: parseInt(month!, 10),
    day: parseInt(day!, 10),
    hour: style.isDate ? 12 : 23,
    minute: style.isDate ? 0 : 59,
    second: style.isDate ? 0 : 59,
  };

  return wallClockToEpoch(wall, untilZone(style, viewerZone));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a stored rule back into the form, or report that the control cannot
 * state it. `zone` is the series' own zone, needed to place a UTC UNTIL stamp
 * on the right calendar day — 20270101T045959Z is still 31 December in Sydney.
 */
export function parseRecurrenceForm(
  rrule: string | null | undefined,
  zone: string | null = null,
): ParsedRecurrence {
  if (!rrule || rrule.trim().length === 0) return { kind: "none" };

  const parts = new Map<string, string>();
  for (const segment of rrule.split(";")) {
    const eq = segment.indexOf("=");
    if (eq === -1) {
      if (segment.trim().length > 0) return { kind: "custom" };
      continue;
    }
    const key = segment.slice(0, eq).trim().toUpperCase();
    const value = segment.slice(eq + 1).trim();
    if (!KNOWN_PARTS.has(key)) return { kind: "custom" };
    if (value.length > 0) parts.set(key, value);
  }

  const frequency = FREQUENCIES[(parts.get("FREQ") ?? "").toUpperCase()];
  if (!frequency) return { kind: "custom" };

  const interval = parts.has("INTERVAL") ? parseInt(parts.get("INTERVAL")!, 10) : 1;
  if (!Number.isFinite(interval) || interval < 1) return { kind: "custom" };

  const byDay = readByDay(parts.get("BYDAY"), frequency);
  if (byDay === null) return { kind: "custom" };

  // COUNT and UNTIL are mutually exclusive (RFC 5545 §3.3.10); an object
  // carrying both is not something to guess at.
  if (parts.has("COUNT") && parts.has("UNTIL")) return { kind: "custom" };

  let end: RepeatEnd = { kind: "never" };
  if (parts.has("COUNT")) {
    const count = parseInt(parts.get("COUNT")!, 10);
    if (!Number.isFinite(count) || count < 1) return { kind: "custom" };
    end = { kind: "count", count };
  } else if (parts.has("UNTIL")) {
    const date = readUntilDate(parts.get("UNTIL")!, zone);
    if (date === null) return { kind: "custom" };
    end = { kind: "onDate", date };
  }

  const form: RecurrenceForm = { frequency, interval, byDay, end };
  const wkst = parts.get("WKST");
  if (wkst) form.wkst = wkst.toUpperCase();

  return { kind: "simple", form };
}

/** Null when the value is not a plain list of unqualified weekdays. */
function readByDay(value: string | undefined, frequency: RepeatFrequency): number[] | null {
  if (!value) return [];
  // On a monthly or yearly rule BYDAY picks weekdays out of the period rather
  // than listing the days of a week, which the control has no way to show.
  if (frequency !== "weekly") return null;

  const days: number[] = [];
  for (const token of value.split(",")) {
    const index = WEEKDAY_CODES.indexOf(token.trim().toUpperCase() as typeof WEEKDAY_CODES[number]);
    if (index === -1) return null;
    days.push(index);
  }
  return days;
}

/** The calendar day an UNTIL value falls on, as YYYY-MM-DD in the series' zone. */
function readUntilDate(value: string, zone: string | null): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second, utc] = match;
  if (!hour) return `${year}-${month}-${day}`;

  const epoch = wallClockToEpoch({
    year: parseInt(year!, 10),
    month: parseInt(month!, 10),
    day: parseInt(day!, 10),
    hour: parseInt(hour, 10),
    minute: parseInt(minute!, 10),
    second: parseInt(second!, 10),
  }, utc ? "UTC" : zone);

  return formatDateTimeInZone(epoch, zone, true).replace(
    /^(\d{4})(\d{2})(\d{2})$/,
    "$1-$2-$3",
  );
}

/** The weekday of a YYYY-MM-DD date, 0 = Sunday, for seeding a weekly rule. */
export function weekdayOfDate(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(
    Date.UTC(parseInt(year!, 10), parseInt(month!, 10) - 1, parseInt(day!, 10)),
  ).getUTCDay();
}
