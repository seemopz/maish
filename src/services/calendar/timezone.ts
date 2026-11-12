/**
 * Conversion between epoch seconds and wall-clock time in an IANA time zone.
 *
 * Recurrence rules are evaluated in the local time of the series' DTSTART
 * (RFC 5545 §3.8.5.3), not in UTC: a weekly 18:00 appointment stays at 18:00
 * after a daylight-saving transition even though its UTC instant moves. So the
 * expander works on wall-clock fields and converts to absolute time only at
 * the boundaries, which is what this module provides.
 *
 * Intl.DateTimeFormat carries the zone database, so no dependency is needed.
 */

export interface WallClock {
  year: number;
  /** 1-12, unlike Date's 0-11. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Returns null for a TZID the runtime does not know. Exchange and some older
 * clients write non-IANA identifiers ("W. Europe Standard Time", "Customized
 * Time Zone"); those fall back to floating time rather than throwing.
 */
function getFormatter(tzid: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(tzid);
  if (cached !== undefined) return cached;

  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    formatter = null;
  }

  formatterCache.set(tzid, formatter);
  return formatter;
}

export function epochToWallClock(epochSeconds: number, tzid: string | null): WallClock {
  const date = new Date(epochSeconds * 1000);
  const formatter = tzid ? getFormatter(tzid) : null;

  if (!formatter) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = parseInt(part.value, 10);
  }

  return {
    year: parts.year ?? date.getUTCFullYear(),
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    // h23 renders midnight as 00, but some engines still emit 24.
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/**
 * The inverse. A wall clock plus a zone does not uniquely identify an instant
 * during a daylight-saving transition, so the offset is resolved twice: the
 * first guess uses the offset at the naive instant, the second corrects it
 * when that guess landed on the far side of a transition. Times that do not
 * exist (the hour skipped in spring) resolve to the instant just after the
 * jump; times that occur twice (autumn) resolve to the first of the two, which
 * is the convention RFC 5545 §3.3.5 leaves implementations to choose.
 */
export function wallClockToEpoch(wall: WallClock, tzid: string | null): number {
  const formatter = tzid ? getFormatter(tzid) : null;

  if (!formatter) {
    // Floating time: interpret in the machine's zone, as a calendar client
    // is expected to.
    const local = new Date(
      wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second,
    );
    local.setFullYear(wall.year);
    return Math.floor(local.getTime() / 1000);
  }

  const naive = utcFromWallClock(wall);
  let instant = naive - zoneOffsetMs(naive, tzid!);
  instant = naive - zoneOffsetMs(instant, tzid!);
  return Math.floor(instant / 1000);
}

/** Offset of `tzid` at the given instant, in milliseconds east of UTC. */
function zoneOffsetMs(epochMs: number, tzid: string): number {
  const seconds = Math.floor(epochMs / 1000);
  const wall = epochToWallClock(seconds, tzid);
  return utcFromWallClock(wall) - seconds * 1000;
}

/** Date.UTC, but without the two-digit-year remapping that turns 26 into 1926. */
function utcFromWallClock(wall: WallClock): number {
  const ms = Date.UTC(
    wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second,
  );
  if (wall.year >= 0 && wall.year < 100) {
    const corrected = new Date(ms);
    corrected.setUTCFullYear(wall.year);
    return corrected.getTime();
  }
  return ms;
}

/**
 * Render epoch seconds as an iCalendar value, for DTSTART, RECURRENCE-ID,
 * EXDATE and UNTIL. Pass "UTC" for a Z-suffixed value and null for floating
 * time, which is rendered in the machine's zone as a calendar client is
 * expected to.
 */
export function formatDateTimeInZone(
  epochSeconds: number,
  zone: string | null,
  isDate: boolean,
): string {
  const wall = epochToWallClock(epochSeconds, zone);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  const day = `${p(wall.year, 4)}${p(wall.month)}${p(wall.day)}`;
  if (isDate) return day;

  const time = `${p(wall.hour)}${p(wall.minute)}${p(wall.second)}`;
  return `${day}T${time}${zone === "UTC" ? "Z" : ""}`;
}

/**
 * Wall clocks as a single comparable integer (YYYYMMDDhhmmss). The expander
 * compares thousands of candidate dates per range; doing that numerically
 * keeps the expensive zone conversion for the few that survive.
 */
export function wallClockKey(wall: WallClock): number {
  return (
    wall.year * 10_000_000_000 +
    wall.month * 100_000_000 +
    wall.day * 1_000_000 +
    wall.hour * 10_000 +
    wall.minute * 100 +
    wall.second
  );
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** Years after the first one over which a derived rule must match Intl. */
const RULE_CHECK_YEARS = 10;

interface Transition {
  /** Instant of the change, epoch seconds. */
  at: number;
  /** Offsets before and after, in seconds east of UTC. */
  from: number;
  to: number;
}

/**
 * A VTIMEZONE for `zone` (RFC 5545 §3.6.5) whose observances begin in
 * `fromYear`, derived from the zone data Intl carries. Each offset change is
 * written as a yearly nth-weekday rule (BYMONTH + BYDAY) taken from that
 * year's transitions and checked against Intl for the following years.
 * A zone whose changes follow no such rule gets its changes listed year by
 * year. Returns null only for a zone Intl does not know, so the caller can fall
 * back to UTC instead of writing a TZID with a wrong definition.
 */
export function buildVTimezone(zone: string, fromYear: number): string[] | null {
  if (!getFormatter(zone)) return null;

  const first = transitionsIn(zone, fromYear);
  const rules = first.map(weekdayRule);

  // Checked up to a decade past now too: a back-dated open series still runs today.
  const lastYear = Math.max(fromYear, new Date().getUTCFullYear()) + RULE_CHECK_YEARS;
  let followsRule = first.length <= 2;
  for (let year = fromYear + 1; followsRule && year <= lastYear; year++) {
    const actual = transitionsIn(zone, year);
    followsRule = actual.length === rules.length && rules.every((rule, i) => {
      const t = actual[i]!;
      return t.from === rule.from && t.to === rule.to && t.at === ruleInstant(rule, year);
    });
  }
  if (!followsRule) return listedVTimezone(zone, fromYear, lastYear);

  const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`];
  if (rules.length === 0) {
    const offset = formatOffset(offsetSeconds(Date.UTC(fromYear, 0, 1) / 1000, zone));
    lines.push(
      "BEGIN:STANDARD",
      `DTSTART:${fromYear}0101T000000`,
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      "END:STANDARD",
    );
  }
  for (const rule of rules) {
    const kind = rule.to > rule.from ? "DAYLIGHT" : "STANDARD";
    const p = (n: number) => String(n).padStart(2, "0");
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${fromYear}${p(rule.month)}${p(rule.day)}T${p(rule.hour)}${p(rule.minute)}${p(rule.second)}`,
      `RRULE:FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${rule.nth}${DAY_CODES[rule.weekday]}`,
      `TZOFFSETFROM:${formatOffset(rule.from)}`,
      `TZOFFSETTO:${formatOffset(rule.to)}`,
      `END:${kind}`,
    );
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

/**
 * A zone whose changes follow no yearly weekday rule (Morocco's Ramadan
 * suspension, Jerusalem's Friday before the last Sunday) as one observance per
 * change, taken from Intl.
 * shortcut: after `lastYear` the last offset simply continues; a series still running a decade on drifts then.
 */
function listedVTimezone(zone: string, fromYear: number, lastYear: number): string[] {
  const p = (n: number) => String(n).padStart(2, "0");
  const local = (epoch: number, offset: number) => {
    const w = new Date((epoch + offset) * 1000);
    return `${w.getUTCFullYear()}${p(w.getUTCMonth() + 1)}${p(w.getUTCDate())}T${p(w.getUTCHours())}${p(w.getUTCMinutes())}${p(w.getUTCSeconds())}`;
  };
  const startOffset = formatOffset(offsetSeconds(Date.UTC(fromYear, 0, 1) / 1000, zone));
  const lines = [
    "BEGIN:VTIMEZONE",
    `TZID:${zone}`,
    "BEGIN:STANDARD",
    `DTSTART:${fromYear}0101T000000`,
    `TZOFFSETFROM:${startOffset}`,
    `TZOFFSETTO:${startOffset}`,
    "END:STANDARD",
  ];
  for (let year = fromYear; year <= lastYear; year++) {
    for (const t of transitionsIn(zone, year)) {
      const kind = t.to > t.from ? "DAYLIGHT" : "STANDARD";
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${local(t.at, t.from)}`,
        `TZOFFSETFROM:${formatOffset(t.from)}`,
        `TZOFFSETTO:${formatOffset(t.to)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

function offsetSeconds(epochSeconds: number, zone: string): number {
  return Math.round(zoneOffsetMs(epochSeconds * 1000, zone) / 1000);
}

/** Offset changes within a calendar year (UTC), found day by day and narrowed to the second. */
function transitionsIn(zone: string, year: number): Transition[] {
  const found: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1) / 1000;
  let t = Date.UTC(year, 0, 1) / 1000;
  let offset = offsetSeconds(t, zone);

  while (t < end) {
    const next = Math.min(t + 86400, end);
    const nextOffset = offsetSeconds(next, zone);
    if (nextOffset !== offset) {
      let lo = t;
      let hi = next;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetSeconds(mid, zone) === offset) lo = mid;
        else hi = mid;
      }
      found.push({ at: hi, from: offset, to: nextOffset });
    }
    t = next;
    offset = nextOffset;
  }
  return found;
}

interface WeekdayRule extends Transition {
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  /** 1-4 for the nth weekday of the month, -1 for the last one. */
  nth: number;
}

/** The transition as "nth weekday of the month" in the wall time before it. */
function weekdayRule(t: Transition): WeekdayRule {
  const wall = new Date((t.at + t.from) * 1000);
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth() + 1;
  const day = wall.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    ...t,
    month,
    day,
    hour: wall.getUTCHours(),
    minute: wall.getUTCMinutes(),
    second: wall.getUTCSeconds(),
    weekday: wall.getUTCDay(),
    nth: day + 7 > daysInMonth ? -1 : Math.ceil(day / 7),
  };
}

/** Where the rule puts the transition in `year`, epoch seconds. */
function ruleInstant(rule: WeekdayRule, year: number): number {
  const m = rule.month - 1;
  let day: number;
  if (rule.nth > 0) {
    const firstWeekday = new Date(Date.UTC(year, m, 1)).getUTCDay();
    day = 1 + ((rule.weekday - firstWeekday + 7) % 7) + 7 * (rule.nth - 1);
  } else {
    const last = new Date(Date.UTC(year, m + 1, 0));
    day = last.getUTCDate() - ((last.getUTCDay() - rule.weekday + 7) % 7);
  }
  return Date.UTC(year, m, day, rule.hour, rule.minute, rule.second) / 1000 - rule.from;
}

/** ±HHMM, or ±HHMMSS for the odd historical offset with seconds. */
function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  const p = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${p(Math.floor(abs / 3600))}${p(Math.floor((abs % 3600) / 60))}`;
  return `${sign}${hhmm}${abs % 60 ? p(abs % 60) : ""}`;
}
