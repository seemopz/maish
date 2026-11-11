import {
  splitCalendarObject,
  eventDataFromFields,
  type IcalDateTime,
  type VEventFields,
} from "./icalHelper";
import { epochToWallClock, wallClockKey, wallClockToEpoch, type WallClock } from "./timezone";
import type { CalendarEventData } from "./types";

/**
 * Expansion of recurring VEVENTs into the individual instances a calendar view
 * shows.
 *
 * CalDAV servers answer a time-range REPORT with the series master — the
 * VEVENT carrying the RRULE — not with its instances (RFC 4791 §7.8: the
 * server matches expanded instances against the range but returns the calendar
 * object as stored). A client that renders what it received therefore shows a
 * weekly appointment exactly once. Google's API hides this by expanding server
 * side via singleEvents=true; over CalDAV the client has to do it.
 *
 * Rules are evaluated in the wall-clock time of DTSTART's zone and only
 * converted to absolute time at the end, so an 18:00 appointment stays at
 * 18:00 across a daylight-saving transition.
 */

export interface Occurrence extends CalendarEventData {
  /** Epoch seconds of the instance this occurrence stands for (RFC 5545 RECURRENCE-ID). */
  recurrenceId: number;
  /** True when a RECURRENCE-ID component supplied this instance's data. */
  isOverride: boolean;
}

type Frequency = "SECONDLY" | "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface ByDay {
  /** 0 = Sunday, matching Date#getUTCDay. */
  weekday: number;
  /** Position within the period, e.g. -1 for "last"; null when unqualified. */
  ordinal: number | null;
}

export interface RRuleSpec {
  freq: Frequency;
  interval: number;
  count: number | null;
  /** Epoch seconds; the series produces nothing starting after this. */
  until: number | null;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  byYearDay: number[];
  bySetPos: number[];
  byHour: number[];
  byMinute: number[];
  bySecond: number[];
  /** Week start, 0 = Sunday. Defaults to Monday per RFC 5545. */
  wkst: number;
}

const WEEKDAYS: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * Safety nets: a malformed rule must not spin forever. Instances are capped by
 * how many land in the window, not how many were counted from DTSTART: a daily
 * series older than the cap would otherwise show nothing at all. The period
 * cap covers a daily series of ~270 years.
 */
const MAX_PERIODS = 100_000;
const MAX_INSTANCES = 5_000;

// ---------------------------------------------------------------------------
// Rule parsing
// ---------------------------------------------------------------------------

export function parseRRule(value: string, zone: string | null): RRuleSpec | null {
  const spec: RRuleSpec = {
    freq: "DAILY",
    interval: 1,
    count: null,
    until: null,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    byYearDay: [],
    bySetPos: [],
    byHour: [],
    byMinute: [],
    bySecond: [],
    wkst: 1,
  };

  let sawFreq = false;

  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const raw = part.slice(eq + 1).trim();
    if (raw.length === 0) continue;

    switch (key) {
      case "FREQ":
        spec.freq = raw.toUpperCase() as Frequency;
        sawFreq = true;
        break;
      case "INTERVAL": {
        const interval = parseInt(raw, 10);
        if (interval > 0) spec.interval = interval;
        break;
      }
      case "COUNT": {
        const count = parseInt(raw, 10);
        if (count > 0) spec.count = count;
        break;
      }
      case "UNTIL":
        spec.until = parseUntil(raw, zone);
        break;
      case "BYDAY":
        spec.byDay = raw.split(",").map(parseByDay).filter((d): d is ByDay => d !== null);
        break;
      case "BYMONTHDAY":
        spec.byMonthDay = parseIntList(raw);
        break;
      case "BYMONTH":
        spec.byMonth = parseIntList(raw);
        break;
      case "BYYEARDAY":
        spec.byYearDay = parseIntList(raw);
        break;
      case "BYSETPOS":
        spec.bySetPos = parseIntList(raw);
        break;
      case "BYHOUR":
        spec.byHour = parseIntList(raw);
        break;
      case "BYMINUTE":
        spec.byMinute = parseIntList(raw);
        break;
      case "BYSECOND":
        spec.bySecond = parseIntList(raw);
        break;
      case "WKST": {
        const day = WEEKDAYS[raw.toUpperCase()];
        if (day !== undefined) spec.wkst = day;
        break;
      }
    }
  }

  return sawFreq ? spec : null;
}

function parseByDay(token: string): ByDay | null {
  const match = token.trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
  if (!match) return null;
  const weekday = WEEKDAYS[match[2]!];
  if (weekday === undefined) return null;
  return { weekday, ordinal: match[1] ? parseInt(match[1], 10) : null };
}

function parseIntList(raw: string): number[] {
  return raw
    .split(",")
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * UNTIL is normally a UTC date-time. When the rule belongs to a DATE-valued
 * series it may be a bare date, which is read in the series' own zone.
 */
function parseUntil(raw: string, zone: string | null): number | null {
  if (!/^\d{8}(T\d{6}Z?)?$/.test(raw)) return null;
  const isUtc = raw.endsWith("Z");
  const cleaned = raw.replace("Z", "");
  const hasTime = cleaned.length > 8;

  const wall: WallClock = {
    year: parseInt(cleaned.substring(0, 4), 10),
    month: parseInt(cleaned.substring(4, 6), 10),
    day: parseInt(cleaned.substring(6, 8), 10),
    hour: hasTime ? parseInt(cleaned.substring(9, 11), 10) : 23,
    minute: hasTime ? parseInt(cleaned.substring(11, 13), 10) : 59,
    second: hasTime ? parseInt(cleaned.substring(13, 15), 10) : 59,
  };

  return wallClockToEpoch(wall, isUtc ? "UTC" : zone);
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Expand a calendar object into the occurrences overlapping [rangeStart, rangeEnd).
 * Non-recurring objects yield their single event; unparsable ones yield nothing.
 */
export function expandOccurrences(
  icalData: string,
  rangeStart: number,
  rangeEnd: number,
  href?: string,
): Occurrence[] {
  const { master, overrides } = splitCalendarObject(icalData);
  if (!master || !master.start) return [];

  const base = eventDataFromFields(master, icalData, href);
  const duration = Math.max(0, base.endTime - base.startTime);
  const zone = seriesZone(master);

  const overrideByRecurrenceId = new Map<number, VEventFields>();
  for (const override of overrides) {
    if (override.recurrenceId) {
      overrideByRecurrenceId.set(override.recurrenceId.epoch, override);
    }
  }

  const starts = collectStarts(master, zone, rangeStart, rangeEnd, duration);
  const excluded = new Set(master.exdates.map((d) => d.epoch));

  const occurrences: Occurrence[] = [];
  const seen = new Set<number>();

  for (const start of starts) {
    if (excluded.has(start)) continue;
    seen.add(start);

    const override = overrideByRecurrenceId.get(start);
    const occurrence = override
      ? buildOverride(override, start, icalData, href, base)
      : { ...base, startTime: start, endTime: start + duration, recurrenceId: start, isOverride: false };

    if (occurrence.startTime < rangeEnd && occurrence.endTime > rangeStart) {
      occurrences.push(occurrence);
    }
  }

  // An override may have been moved outside the window its recurrence id falls
  // in — it still belongs in the range it was moved to.
  for (const [recurrenceId, override] of overrideByRecurrenceId) {
    if (seen.has(recurrenceId) || excluded.has(recurrenceId)) continue;
    const occurrence = buildOverride(override, recurrenceId, icalData, href, base);
    if (occurrence.startTime < rangeEnd && occurrence.endTime > rangeStart) {
      occurrences.push(occurrence);
    }
  }

  occurrences.sort((a, b) => a.startTime - b.startTime);
  return occurrences;
}

function buildOverride(
  override: VEventFields,
  recurrenceId: number,
  icalData: string,
  href: string | undefined,
  base: CalendarEventData,
): Occurrence {
  const data = eventDataFromFields(override, icalData, href);
  return {
    ...data,
    // The override component often omits properties it does not change.
    summary: data.summary ?? base.summary,
    description: data.description ?? base.description,
    location: data.location ?? base.location,
    organizerEmail: data.organizerEmail ?? base.organizerEmail,
    attendeesJson: data.attendeesJson ?? base.attendeesJson,
    rrule: base.rrule,
    recurrenceId,
    isOverride: true,
  };
}

/** The zone recurrence is computed in: DTSTART's TZID, or floating/UTC. */
function seriesZone(master: VEventFields): string | null {
  if (!master.start) return null;
  if (master.start.tzid) return master.start.tzid;
  return master.start.raw.endsWith("Z") ? "UTC" : null;
}

/**
 * All instance start times of the series, as epoch seconds, restricted to
 * those that could overlap the queried range.
 */
function collectStarts(
  master: VEventFields,
  zone: string | null,
  rangeStart: number,
  rangeEnd: number,
  duration: number,
): number[] {
  const dtstart = master.start!;
  const spec = master.rrule ? parseRRule(master.rrule, zone) : null;

  const rdates = master.rdates.map((d) => d.epoch);

  if (!spec) {
    return dedupeSorted([dtstart.epoch, ...rdates]);
  }

  // Compare in wall-clock space so the zone conversion only runs for the few
  // candidates that survive. The slack absorbs both the event duration and the
  // hour a daylight-saving shift can move a boundary by.
  const slack = Math.max(duration, 86400) + 3600;
  const lowerKey = wallClockKey(epochToWallClock(rangeStart - slack, zone));
  const upperKey = wallClockKey(epochToWallClock(rangeEnd + slack, zone));
  const untilKey = spec.until === null
    ? null
    : wallClockKey(epochToWallClock(spec.until, zone));

  const startWall = dtstart.wall;
  const startKey = wallClockKey(startWall);

  const kept: number[] = [];
  let emitted = 0;
  let periods = 0;
  let cursor = periodStart(startWall, spec);

  while (periods < MAX_PERIODS && kept.length < MAX_INSTANCES) {
    periods++;
    const candidates = candidatesForPeriod(cursor, spec, startWall);

    let exhausted = false;
    for (const candidate of candidates) {
      const key = wallClockKey(candidate);
      if (key < startKey) continue;
      if (untilKey !== null && key > untilKey) {
        exhausted = true;
        break;
      }

      emitted++;
      if (spec.count !== null && emitted > spec.count) {
        exhausted = true;
        break;
      }

      if (key >= lowerKey && key <= upperKey) {
        kept.push(wallClockToEpoch(candidate, zone));
      }
      if (kept.length >= MAX_INSTANCES) break;
    }

    if (exhausted) break;
    // Everything from here on starts later than the window.
    if (wallClockKey(cursor) > upperKey) break;

    cursor = advancePeriod(cursor, spec);
  }

  return dedupeSorted([...kept, ...rdates.filter((d) => d >= rangeStart - slack && d <= rangeEnd + slack)]);
}

function dedupeSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Period arithmetic — all in wall-clock terms, no zone involved
// ---------------------------------------------------------------------------

function periodStart(start: WallClock, spec: RRuleSpec): WallClock {
  switch (spec.freq) {
    case "YEARLY":
      return { ...start, month: 1, day: 1 };
    case "MONTHLY":
      return { ...start, day: 1 };
    case "WEEKLY": {
      const offset = (weekdayOf(start) - spec.wkst + 7) % 7;
      return addDays(start, -offset);
    }
    default:
      return { ...start };
  }
}

function advancePeriod(cursor: WallClock, spec: RRuleSpec): WallClock {
  switch (spec.freq) {
    case "YEARLY":
      return { ...cursor, year: cursor.year + spec.interval };
    case "MONTHLY":
      return addMonths(cursor, spec.interval);
    case "WEEKLY":
      return addDays(cursor, 7 * spec.interval);
    case "DAILY":
      return addDays(cursor, spec.interval);
    case "HOURLY":
      return addSeconds(cursor, 3600 * spec.interval);
    case "MINUTELY":
      return addSeconds(cursor, 60 * spec.interval);
    case "SECONDLY":
      return addSeconds(cursor, spec.interval);
  }
}

/** The instance start times the rule produces within one period, in order. */
function candidatesForPeriod(cursor: WallClock, spec: RRuleSpec, start: WallClock): WallClock[] {
  const days = daysForPeriod(cursor, spec, start);
  const times = timesForPeriod(spec, start, cursor);

  let candidates: WallClock[] = [];
  for (const day of days) {
    for (const time of times) {
      candidates.push({ ...day, hour: time.hour, minute: time.minute, second: time.second });
    }
  }

  candidates.sort((a, b) => wallClockKey(a) - wallClockKey(b));

  if (spec.bySetPos.length > 0) {
    const picked: WallClock[] = [];
    for (const pos of spec.bySetPos) {
      const index = pos > 0 ? pos - 1 : candidates.length + pos;
      const chosen = candidates[index];
      if (chosen) picked.push(chosen);
    }
    candidates = picked.sort((a, b) => wallClockKey(a) - wallClockKey(b));
  }

  return candidates;
}

function daysForPeriod(cursor: WallClock, spec: RRuleSpec, start: WallClock): WallClock[] {
  switch (spec.freq) {
    case "YEARLY":
      return yearlyDays(cursor, spec, start);
    case "MONTHLY":
      return monthlyDays(cursor.year, cursor.month, spec, start);
    case "WEEKLY":
      return weeklyDays(cursor, spec, start);
    default:
      // DAILY and the sub-day frequencies produce a single day, filtered by
      // the BY* parts that only limit rather than expand.
      return matchesLimits(cursor, spec) ? [cursor] : [];
  }
}

function yearlyDays(cursor: WallClock, spec: RRuleSpec, start: WallClock): WallClock[] {
  const expands = spec.byMonth.length > 0
    || spec.byMonthDay.length > 0
    || spec.byDay.length > 0
    || spec.byYearDay.length > 0;

  if (!expands) {
    // A series starting on 29 February has no instance in a common year.
    // RFC 5545 §3.3.10 requires such a date to be ignored rather than moved,
    // and Date.UTC would otherwise roll it forward to 1 March. monthlyDays
    // makes the same check for a 31st in a short month.
    if (start.day > daysInMonth(cursor.year, start.month)) return [];
    return [{ ...cursor, month: start.month, day: start.day }];
  }

  const days: WallClock[] = [];

  if (spec.byYearDay.length > 0) {
    const yearLength = isLeapYear(cursor.year) ? 366 : 365;
    for (const dayOfYear of spec.byYearDay) {
      const index = dayOfYear > 0 ? dayOfYear : yearLength + dayOfYear + 1;
      if (index < 1 || index > yearLength) continue;
      days.push(addDays({ ...cursor, month: 1, day: 1 }, index - 1));
    }
    return days.filter((d) => spec.byMonth.length === 0 || spec.byMonth.includes(d.month));
  }

  const months = spec.byMonth.length > 0 ? spec.byMonth : ALL_MONTHS;

  // An ordinal BYDAY without BYMONTH counts across the whole year.
  if (spec.byMonth.length === 0 && spec.byDay.some((d) => d.ordinal !== null)) {
    return yearlyOrdinalDays(cursor.year, spec);
  }

  for (const month of months) {
    days.push(...monthlyDays(cursor.year, month, spec, start));
  }
  return days;
}

function yearlyOrdinalDays(year: number, spec: RRuleSpec): WallClock[] {
  const days: WallClock[] = [];
  const yearLength = isLeapYear(year) ? 366 : 365;
  const jan1: WallClock = { year, month: 1, day: 1, hour: 0, minute: 0, second: 0 };

  for (const byDay of spec.byDay) {
    const matching: WallClock[] = [];
    for (let i = 0; i < yearLength; i++) {
      const day = addDays(jan1, i);
      if (weekdayOf(day) === byDay.weekday) matching.push(day);
    }
    if (byDay.ordinal === null) {
      days.push(...matching);
      continue;
    }
    const index = byDay.ordinal > 0 ? byDay.ordinal - 1 : matching.length + byDay.ordinal;
    const chosen = matching[index];
    if (chosen) days.push(chosen);
  }

  return days;
}

function monthlyDays(year: number, month: number, spec: RRuleSpec, start: WallClock): WallClock[] {
  if (spec.byMonth.length > 0 && !spec.byMonth.includes(month)) return [];

  const length = daysInMonth(year, month);
  const base: WallClock = { year, month, day: 1, hour: 0, minute: 0, second: 0 };
  const days: WallClock[] = [];

  if (spec.byMonthDay.length > 0) {
    for (const monthDay of spec.byMonthDay) {
      const day = monthDay > 0 ? monthDay : length + monthDay + 1;
      if (day < 1 || day > length) continue;
      const candidate = { ...base, day };
      if (spec.byDay.length === 0 || spec.byDay.some((d) => d.weekday === weekdayOf(candidate))) {
        days.push(candidate);
      }
    }
    return days;
  }

  if (spec.byDay.length > 0) {
    for (const byDay of spec.byDay) {
      const matching: WallClock[] = [];
      for (let day = 1; day <= length; day++) {
        const candidate = { ...base, day };
        if (weekdayOf(candidate) === byDay.weekday) matching.push(candidate);
      }
      if (byDay.ordinal === null) {
        days.push(...matching);
        continue;
      }
      const index = byDay.ordinal > 0 ? byDay.ordinal - 1 : matching.length + byDay.ordinal;
      const chosen = matching[index];
      if (chosen) days.push(chosen);
    }
    return days;
  }

  // Months shorter than the start day simply skip, as RFC 5545 §3.3.10 requires.
  if (start.day > length) return [];
  return [{ ...base, day: start.day }];
}

function weeklyDays(cursor: WallClock, spec: RRuleSpec, start: WallClock): WallClock[] {
  const weekdays = spec.byDay.length > 0
    ? spec.byDay.map((d) => d.weekday)
    : [weekdayOf(start)];

  const days: WallClock[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(cursor, i);
    if (!weekdays.includes(weekdayOf(day))) continue;
    if (spec.byMonth.length > 0 && !spec.byMonth.includes(day.month)) continue;
    days.push(day);
  }
  return days;
}

function matchesLimits(day: WallClock, spec: RRuleSpec): boolean {
  if (spec.byMonth.length > 0 && !spec.byMonth.includes(day.month)) return false;
  if (spec.byDay.length > 0 && !spec.byDay.some((d) => d.weekday === weekdayOf(day))) return false;
  if (spec.byMonthDay.length > 0) {
    const length = daysInMonth(day.year, day.month);
    const matches = spec.byMonthDay.some((d) => (d > 0 ? d : length + d + 1) === day.day);
    if (!matches) return false;
  }
  return true;
}

function timesForPeriod(
  spec: RRuleSpec,
  start: WallClock,
  cursor: WallClock,
): { hour: number; minute: number; second: number }[] {
  // Below daily granularity the cursor already carries the time of day.
  if (spec.freq === "HOURLY" || spec.freq === "MINUTELY" || spec.freq === "SECONDLY") {
    return [{ hour: cursor.hour, minute: cursor.minute, second: cursor.second }];
  }

  const hours = spec.byHour.length > 0 ? spec.byHour : [start.hour];
  const minutes = spec.byMinute.length > 0 ? spec.byMinute : [start.minute];
  const seconds = spec.bySecond.length > 0 ? spec.bySecond : [start.second];

  const times: { hour: number; minute: number; second: number }[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      for (const second of seconds) {
        times.push({ hour, minute, second });
      }
    }
  }
  return times;
}

// ---------------------------------------------------------------------------
// Wall-clock date arithmetic
// ---------------------------------------------------------------------------

function toUtcMs(wall: WallClock): number {
  const ms = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  if (wall.year >= 0 && wall.year < 100) {
    const corrected = new Date(ms);
    corrected.setUTCFullYear(wall.year);
    return corrected.getTime();
  }
  return ms;
}

function fromUtcMs(ms: number): WallClock {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function addDays(wall: WallClock, days: number): WallClock {
  return fromUtcMs(toUtcMs(wall) + days * 86400_000);
}

function addSeconds(wall: WallClock, seconds: number): WallClock {
  return fromUtcMs(toUtcMs(wall) + seconds * 1000);
}

function addMonths(wall: WallClock, months: number): WallClock {
  const total = (wall.year * 12 + (wall.month - 1)) + months;
  return { ...wall, year: Math.floor(total / 12), month: (total % 12) + 1, day: 1 };
}

function weekdayOf(wall: WallClock): number {
  return new Date(toUtcMs(wall)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

// ---------------------------------------------------------------------------
// Series metadata for the database
// ---------------------------------------------------------------------------

/**
 * Last instant the series can still produce an instance, or null when it runs
 * forever. Stored alongside the master so a range query can find series whose
 * DTSTART lies before the viewed window.
 */
export function seriesEnd(icalData: string): number | null {
  const { master } = splitCalendarObject(icalData);
  if (!master || !master.start) return null;

  const base = eventDataFromFields(master, icalData);
  const duration = Math.max(0, base.endTime - base.startTime);

  if (!master.rrule) {
    const rdateEnd = master.rdates.reduce((max, d) => Math.max(max, d.epoch), base.startTime);
    return rdateEnd + duration;
  }

  const zone = seriesZone(master);
  const spec = parseRRule(master.rrule, zone);
  if (!spec) return base.endTime;
  if (spec.until !== null) return spec.until + duration;
  if (spec.count === null) return null;

  // A COUNT-bounded series ends at its last instance; ask the expander for a
  // window wide enough to contain it.
  const far = base.startTime + 200 * 365 * 86400;
  const all = expandOccurrences(icalData, base.startTime - duration - 1, far);
  const last = all[all.length - 1];
  return last ? last.endTime : base.endTime;
}

/**
 * How many instances the series produces before `recurrenceId`.
 *
 * Splitting a series has to know this: COUNT counts from the rule's own start,
 * so the second half needs the instances the first half keeps taken off its
 * count. Excluded dates are counted as well — the rule produces its COUNT
 * instances first and EXDATE subtracts from that set afterwards (RFC 5545
 * §3.8.5.1), so an exclusion does not hand the count back.
 */
export function countInstancesBefore(icalData: string, recurrenceId: number): number {
  const { master } = splitCalendarObject(icalData);
  if (!master || !master.start) return 0;

  const base = eventDataFromFields(master, icalData);
  const duration = Math.max(0, base.endTime - base.startTime);
  const zone = seriesZone(master);

  const starts = collectStarts(
    master,
    zone,
    master.start.epoch - duration - 1,
    recurrenceId,
    duration,
  );

  return starts.filter((start) => start < recurrenceId).length;
}

/** The RRULE of the series master, for storing next to the event. */
export function seriesRule(icalData: string): string | null {
  return splitCalendarObject(icalData).master?.rrule ?? null;
}

/**
 * The zone the series' rule is evaluated in. The repeat control needs it to
 * place a UTC UNTIL stamp on the right calendar day: 20270101T045959Z is still
 * 31 December in Sydney, and reading it as 1 January would hand the series an
 * extra instance every time someone opened the dialog.
 */
export function seriesTimeZone(icalData: string | null): string | null {
  if (!icalData) return null;
  const { master } = splitCalendarObject(icalData);
  return master ? seriesZone(master) : null;
}

/**
 * Whether the object holds a VEVENT the expander can work from.
 *
 * This separates "the series produces nothing in this window" — a truthful
 * empty result — from "this object could not be read at all", where an empty
 * result would make the event disappear from the calendar instead of showing
 * something.
 */
export function hasReadableMaster(icalData: string): boolean {
  const { master } = splitCalendarObject(icalData);
  return master !== null && master.start !== null;
}

const FREQUENCY_NAMES: Record<Frequency, [string, string]> = {
  SECONDLY: ["second", "seconds"],
  MINUTELY: ["minute", "minutes"],
  HOURLY: ["hour", "hours"],
  DAILY: ["day", "days"],
  WEEKLY: ["week", "weeks"],
  MONTHLY: ["month", "months"],
  YEARLY: ["year", "years"],
};

/** Short human-readable summary of a rule, for the event detail panel. */
export function describeRule(rrule: string | null): string | null {
  if (!rrule) return null;
  const spec = parseRRule(rrule, null);
  if (!spec) return null;

  const names = FREQUENCY_NAMES[spec.freq];
  if (!names) return "Repeats";

  return spec.interval === 1
    ? `Repeats every ${names[0]}`
    : `Repeats every ${spec.interval} ${names[1]}`;
}

/** True when this occurrence was generated from a rule rather than stored as-is. */
export function isRecurring(icalData: string | null): boolean {
  if (!icalData) return false;
  const { master } = splitCalendarObject(icalData);
  return Boolean(master?.rrule) || (master?.rdates.length ?? 0) > 0;
}

export type { IcalDateTime };
