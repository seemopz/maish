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
