import { countInstancesBefore, expandOccurrences } from "./recurrence";
import {
  buildRRule,
  formatUntil,
  type RecurrenceForm,
  type RuleDateStyle,
} from "./recurrenceForm";
import { epochToWallClock, formatDateTimeInZone, wallClockToEpoch } from "./timezone";

/**
 * In-place editing of a stored calendar object.
 *
 * Regenerating a VEVENT from the handful of fields the UI knows about throws
 * away everything else the object carries: the recurrence rule, the VTIMEZONE
 * its DTSTART refers to, alarms, per-instance overrides, and any property
 * another client wrote. These helpers patch the existing text instead, which
 * is also what makes single-instance edits possible at all — CalDAV keeps
 * every component sharing a UID in one resource (RFC 4791 §4.1), so changing
 * one occurrence means rewriting the whole object.
 */

export interface EventEdits {
  summary?: string;
  description?: string | null;
  location?: string | null;
  /** Epoch seconds. */
  startTime?: number;
  endTime?: number;
  /**
   * How the event repeats from now on. Left out the stored rule is kept as it
   * is, null removes it. Only the series master takes one — an override has no
   * rule of its own, so the occurrence editors ignore this.
   */
  recurrence?: RecurrenceForm | null;
}

/** How a component writes its date values, so edits keep the original form. */
type DateStyle = RuleDateStyle;

/**
 * A calendar object split at its VEVENT boundaries: everything before the
 * first one (VCALENDAR header and VTIMEZONE), the events themselves, and
 * everything after (END:VCALENDAR). Editing then means array surgery on whole
 * components rather than arithmetic on line offsets.
 */
interface CalDoc {
  prefix: string[];
  events: string[][];
  suffix: string[];
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/** Apply edits to the series master, or to the sole VEVENT of a plain event. */
export function editMaster(icalData: string, edits: EventEdits): string {
  const doc = parse(icalData);
  const master = masterOf(doc);
  if (!master) return icalData;

  const style = styleOf(master);
  const startIndex = propertyIndex(master, "DTSTART");
  const oldStart = startIndex === -1 ? null : valueToEpoch(master[startIndex]!, style);
  if (edits.startTime !== undefined && oldStart !== null && edits.startTime !== oldStart) {
    shiftSeriesAnchors(doc, master, icalData, oldStart, edits.startTime, style);
  }
  applyEdits(master, edits, style);
  if (edits.recurrence !== undefined) {
    applyRule(doc, master, edits.recurrence, style);
  }
  touch(master, { bumpSequence: true });
  return serialize(doc);
}

/**
 * Moving a series' DTSTART moves its instances; everything anchored to the old
 * instance times has to move by the same wall-clock change or it stops
 * matching: EXDATE excludes nothing, an override's RECURRENCE-ID names no
 * instance, a BYDAY keeps the old weekday, and an UNTIL set on the last
 * instance now falls before it.
 */
function shiftSeriesAnchors(
  doc: CalDoc,
  master: string[],
  icalData: string,
  from: number,
  to: number,
  style: DateStyle,
): void {
  const zone = style.isDate ? null : style.zone;
  const naive = (epoch: number) => {
    const w = epochToWallClock(epoch, zone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) / 1000;
  };
  const delta = naive(to) - naive(from);
  const shift = (epoch: number) => {
    const d = new Date((naive(epoch) + delta) * 1000);
    return wallClockToEpoch({
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    }, zone);
  };

  // EXDATE, possibly several properties with several values each.
  const exdates: number[] = [];
  for (const line of master.filter((l) => nameOf(l) === "EXDATE")) {
    const params = paramsOf(line);
    for (const value of valueOf(line).split(",")) {
      const epoch = valueToEpoch(`EXDATE${params}:${value.trim()}`, style);
      if (epoch !== null) exdates.push(epoch);
    }
  }
  if (exdates.length > 0) {
    removeProperty(master, "EXDATE");
    for (const epoch of exdates) addProperty(master, dateLine("EXDATE", shift(epoch), style));
  }

  for (const event of doc.events) {
    if (event === master) continue;
    const at = recurrenceIdOf(event, style);
    if (at !== null) {
      setProperty(event, "RECURRENCE-ID", dateLine("RECURRENCE-ID", shift(at), style));
    }
    for (const name of ["DTSTART", "DTEND"]) {
      const index = propertyIndex(event, name);
      const epoch = index === -1 ? null : valueToEpoch(event[index]!, style);
      if (epoch !== null) setProperty(event, name, dateLine(name, shift(epoch), style));
    }
  }

  const ruleIndex = propertyIndex(master, "RRULE");
  if (ruleIndex === -1) return;
  const days = Math.floor(naive(to) / 86400) - Math.floor(naive(from) / 86400);
  const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const parts = valueOf(master[ruleIndex]!).split(";").map((part) => {
    const eq = part.indexOf("=");
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1);
    if (key === "BYDAY" && days % 7 !== 0) {
      return `BYDAY=${value.split(",").map((entry) => {
        const m = /^([+-]?\d*)([A-Z]{2})$/i.exec(entry.trim());
        const index = m ? weekdays.indexOf(m[2]!.toUpperCase()) : -1;
        return index === -1 ? entry : `${m![1]}${weekdays[(((index + days) % 7) + 7) % 7]}`;
      }).join(",")}`;
    }
    if (key === "UNTIL") {
      // Only an UNTIL that is an instance itself moves; one at the end of a
      // day already lies past the last instance and keeps covering it.
      const until = valueToEpoch(`UNTIL:${value}`, style);
      const exact = until !== null
        && expandOccurrences(icalData, until, until + 1).some((o) => o.recurrenceId === until);
      if (exact) return `UNTIL=${formatUntil(shift(until), style)}`;
    }
    return part;
  });
  master[ruleIndex] = `RRULE:${parts.join(";")}`;
}

/**
 * Apply edits to a single instance by creating or replacing its RECURRENCE-ID
 * component. The master keeps its rule, so every other instance is untouched.
 */
export function editOccurrence(
  icalData: string,
  recurrenceId: number,
  edits: EventEdits,
): string {
  const doc = parse(icalData);
  const master = masterOf(doc);
  if (!master) return icalData;

  const style = styleOf(master);
  const existing = overrideAt(doc, recurrenceId, style);

  if (existing) {
    applyEdits(existing, edits, style);
    touch(existing, { bumpSequence: true });
  } else {
    doc.events.push(buildOverride(master, recurrenceId, edits, style));
  }

  return serialize(doc);
}

/** Drop a single instance: add an EXDATE and remove any override for it. */
export function excludeOccurrence(icalData: string, recurrenceId: number): string {
  const doc = parse(icalData);
  const master = masterOf(doc);
  if (!master) return icalData;

  const style = styleOf(master);
  doc.events = doc.events.filter((event) => {
    if (event === master) return true;
    return recurrenceIdOf(event, style) !== recurrenceId;
  });

  const value = formatDateTimeInZone(recurrenceId, style.zone, style.isDate);
  addProperty(master, `EXDATE${styleParams(style)}:${value}`);
  touch(master, { bumpSequence: false });
  return serialize(doc);
}

/**
 * End the series just before the given instance. Instances from that point on
 * disappear, along with any overrides that belonged to them.
 */
export function truncateSeriesBefore(icalData: string, recurrenceId: number): string {
  const doc = parse(icalData);
  const master = masterOf(doc);
  if (!master) return icalData;

  const index = propertyIndex(master, "RRULE");
  if (index === -1) {
    // Nothing to bound, so the instance can only be excluded.
    return excludeOccurrence(icalData, recurrenceId);
  }

  const style = styleOf(master);
  // UNTIL is inclusive, so stop one second before the instance being cut.
  const until = formatUntil(recurrenceId - 1, style);
  master[index] = `RRULE:${boundRule(valueOf(master[index]!), until)}`;

  doc.events = doc.events.filter((event) => {
    if (event === master) return true;
    const at = recurrenceIdOf(event, style);
    return at === null || at < recurrenceId;
  });

  touch(master, { bumpSequence: true });
  return serialize(doc);
}

/**
 * Build a fresh calendar object holding the instances from `recurrenceId`
 * onward, with `edits` applied. Used together with truncateSeriesBefore to
 * split a series in two, which is how "this and following" is represented:
 * RFC 5545 defines a THISANDFUTURE range on RECURRENCE-ID, but server support
 * for it is patchy, whereas two plain objects work everywhere.
 */
export function splitSeriesFrom(
  icalData: string,
  recurrenceId: number,
  newUid: string,
  edits: EventEdits,
): string {
  const doc = parse(icalData);
  const master = masterOf(doc);
  if (!master) return icalData;

  const style = styleOf(master);
  const duration = durationOf(master, style);

  // Keep only the overrides belonging to the part being carried forward.
  doc.events = doc.events.filter((event) => {
    if (event === master) return true;
    const at = recurrenceIdOf(event, style);
    return at !== null && at >= recurrenceId;
  });

  setProperty(master, "UID", `UID:${newUid}`);
  removeProperty(master, "RECURRENCE-ID");

  if (edits.recurrence !== undefined) {
    // A rule stated in the dialog describes the tail on its own terms: its
    // COUNT means "this many from here", so there is nothing to rebase.
    applyRule(doc, master, edits.recurrence, style);
  } else {
    // The tail starts its own count, so it may only claim the instances the
    // head does not keep. Left as it was, a series of ten split after four
    // would run to fourteen.
    const ruleIndex = propertyIndex(master, "RRULE");
    if (ruleIndex !== -1) {
      const consumed = countInstancesBefore(icalData, recurrenceId);
      master[ruleIndex] = `RRULE:${rebaseCount(valueOf(master[ruleIndex]!), consumed)}`;
    }
  }

  const start = edits.startTime ?? recurrenceId;
  const end = edits.endTime ?? start + duration;
  setProperty(master, "DTSTART", dateLine("DTSTART", start, style));
  removeProperty(master, "DURATION");
  setProperty(master, "DTEND", dateLine("DTEND", end, style));

  applyEdits(master, { ...edits, startTime: undefined, endTime: undefined }, style);
  touch(master, { bumpSequence: false, resetSequence: true });

  for (const override of doc.events) {
    if (override !== master) setProperty(override, "UID", `UID:${newUid}`);
  }

  return serialize(doc);
}

/** The RRULE of the series master, if any. */
export function masterRule(icalData: string): string | null {
  const master = masterOf(parse(icalData));
  if (!master) return null;
  const index = propertyIndex(master, "RRULE");
  return index === -1 ? null : valueOf(master[index]!);
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

function parse(icalData: string): CalDoc {
  const lines = unfold(icalData);
  const prefix: string[] = [];
  const events: string[][] = [];
  const suffix: string[] = [];

  let current: string[] | null = null;
  let depth = 0;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (current) {
      current.push(line);
      if (upper.startsWith("BEGIN:")) depth++;
      else if (upper.startsWith("END:")) {
        depth--;
        if (depth === 0) {
          events.push(current);
          current = null;
        }
      }
      continue;
    }

    if (upper === "BEGIN:VEVENT") {
      current = [line];
      depth = 1;
      continue;
    }

    if (events.length === 0) prefix.push(line);
    else suffix.push(line);
  }

  // An unterminated component still has to survive the round trip.
  if (current) events.push(current);

  return { prefix, events, suffix };
}

function serialize(doc: CalDoc): string {
  return fold([...doc.prefix, ...doc.events.flat(), ...doc.suffix]).join("\r\n");
}

function unfold(icalData: string): string[] {
  return icalData
    .replace(/\r\n[ \t]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((line) => line.length > 0);
}

/** Re-fold at 75 octets, as RFC 5545 §3.1 asks for. */
function fold(lines: string[]): string[] {
  const out: string[] = [];

  for (const line of lines) {
    if (byteLength(line) <= 75) {
      out.push(line);
      continue;
    }

    let current = "";
    let bytes = 0;

    for (const char of line) {
      const size = byteLength(char);
      const limit = current.startsWith(" ") ? 75 : 75;
      if (bytes + size > limit) {
        out.push(current);
        current = " ";
        bytes = 1;
      }
      current += char;
      bytes += size;
    }

    if (current.length > 0) out.push(current);
  }

  return out;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// Component lookup
// ---------------------------------------------------------------------------

function masterOf(doc: CalDoc): string[] | null {
  return doc.events.find((e) => propertyIndex(e, "RECURRENCE-ID") === -1)
    ?? doc.events[0]
    ?? null;
}

function overrideAt(doc: CalDoc, recurrenceId: number, style: DateStyle): string[] | null {
  const master = masterOf(doc);
  return doc.events.find(
    (e) => e !== master && recurrenceIdOf(e, style) === recurrenceId,
  ) ?? null;
}

function recurrenceIdOf(event: string[], style: DateStyle): number | null {
  const index = propertyIndex(event, "RECURRENCE-ID");
  if (index === -1) return null;
  return valueToEpoch(event[index]!, style);
}

// ---------------------------------------------------------------------------
// Property manipulation
// ---------------------------------------------------------------------------

/**
 * Index of a property directly on the component, skipping nested ones: a
 * VALARM inside a VEVENT has its own DURATION, and an unqualified search would
 * find that instead.
 */
function propertyIndex(event: string[], name: string): number {
  const wanted = name.toUpperCase();
  let depth = 0;

  for (let i = 1; i < event.length; i++) {
    const line = event[i]!;
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) { depth++; continue; }
    if (upper.startsWith("END:")) { depth--; continue; }
    if (depth !== 0) continue;
    if (nameOf(line) === wanted) return i;
  }

  return -1;
}

function setProperty(event: string[], name: string, line: string): void {
  const index = propertyIndex(event, name);
  if (index === -1) addProperty(event, line);
  else event[index] = line;
}

/** Insert directly after BEGIN:VEVENT, before any nested component. */
function addProperty(event: string[], line: string): void {
  event.splice(1, 0, line);
}

function removeProperty(event: string[], name: string): void {
  let index = propertyIndex(event, name);
  while (index !== -1) {
    event.splice(index, 1);
    index = propertyIndex(event, name);
  }
}

function nameOf(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if ((ch === ":" || ch === ";") && !inQuotes) return line.slice(0, i).toUpperCase();
  }
  return line.toUpperCase();
}

function valueOf(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) return line.slice(i + 1);
  }
  return "";
}

function paramsOf(line: string): string {
  const name = nameOf(line);
  let inQuotes = false;
  for (let i = name.length; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) return line.slice(name.length, i);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function styleOf(event: string[]): DateStyle {
  const index = propertyIndex(event, "DTSTART");
  if (index === -1) return { zone: "UTC", isDate: false };

  const line = event[index]!;
  const params = paramsOf(line);

  if (/VALUE=DATE(?!-TIME)/i.test(params)) return { zone: null, isDate: true };
  if (valueOf(line).endsWith("Z")) return { zone: "UTC", isDate: false };

  const tzid = params.match(/;TZID=([^;:]+)/i)?.[1];
  return { zone: tzid ? stripQuotes(tzid) : null, isDate: false };
}

function styleParams(style: DateStyle): string {
  if (style.isDate) return ";VALUE=DATE";
  if (style.zone && style.zone !== "UTC") return `;TZID=${style.zone}`;
  return "";
}

function dateLine(name: string, epochSeconds: number, style: DateStyle): string {
  return `${name}${styleParams(style)}:${formatDateTimeInZone(epochSeconds, style.zone, style.isDate)}`;
}

function valueToEpoch(line: string, fallback: DateStyle): number | null {
  const value = valueOf(line).split(",")[0]?.trim();
  if (!value) return null;

  const params = paramsOf(line);
  const isDate = /VALUE=DATE(?!-TIME)/i.test(params) || /^\d{8}$/.test(value);
  const tzid = params.match(/;TZID=([^;:]+)/i)?.[1];
  const zone = value.endsWith("Z") ? "UTC" : (tzid ? stripQuotes(tzid) : fallback.zone);

  const cleaned = value.replace("Z", "");
  const year = parseInt(cleaned.substring(0, 4), 10);
  if (!Number.isFinite(year)) return null;

  return wallClockToEpoch({
    year,
    month: parseInt(cleaned.substring(4, 6), 10) || 1,
    day: parseInt(cleaned.substring(6, 8), 10) || 1,
    hour: isDate ? 0 : parseInt(cleaned.substring(9, 11), 10) || 0,
    minute: isDate ? 0 : parseInt(cleaned.substring(11, 13), 10) || 0,
    second: isDate ? 0 : parseInt(cleaned.substring(13, 15), 10) || 0,
  }, isDate ? null : zone);
}

function durationOf(event: string[], style: DateStyle): number {
  const startIndex = propertyIndex(event, "DTSTART");
  const endIndex = propertyIndex(event, "DTEND");
  const fallback = style.isDate ? 86400 : 3600;
  if (startIndex === -1 || endIndex === -1) return fallback;

  const start = valueToEpoch(event[startIndex]!, style);
  const end = valueToEpoch(event[endIndex]!, style);
  if (start === null || end === null) return fallback;
  return Math.max(0, end - start);
}

function stripQuotes(text: string): string {
  return text.replace(/^"(.*)"$/, "$1");
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function applyEdits(event: string[], edits: EventEdits, style: DateStyle): void {
  if (edits.summary !== undefined) {
    setProperty(event, "SUMMARY", `SUMMARY:${escapeText(edits.summary)}`);
  }

  if (edits.description !== undefined) {
    if (edits.description) {
      setProperty(event, "DESCRIPTION", `DESCRIPTION:${escapeText(edits.description)}`);
    } else {
      removeProperty(event, "DESCRIPTION");
    }
  }

  if (edits.location !== undefined) {
    if (edits.location) {
      setProperty(event, "LOCATION", `LOCATION:${escapeText(edits.location)}`);
    } else {
      removeProperty(event, "LOCATION");
    }
  }

  if (edits.startTime !== undefined) {
    setProperty(event, "DTSTART", dateLine("DTSTART", edits.startTime, style));
  }

  if (edits.endTime !== undefined) {
    // DTEND and DURATION are mutually exclusive (RFC 5545 §3.6.1).
    removeProperty(event, "DURATION");
    setProperty(event, "DTEND", dateLine("DTEND", edits.endTime, style));
  }
}

/**
 * Set, replace or remove the series rule on the master.
 *
 * A different rule produces different instance times, and both EXDATE and the
 * per-instance overrides are anchored to the times the old rule produced. Kept
 * around they would describe instances the series no longer has: an EXDATE
 * excluding nothing, and an override the expander still renders even though no
 * instance of the rule matches its RECURRENCE-ID. So changing the rule clears
 * them. RDATE survives — an explicitly added date stands on its own and does
 * not depend on the rule at all.
 */
function applyRule(
  doc: CalDoc,
  master: string[],
  recurrence: RecurrenceForm | null,
  style: DateStyle,
): void {
  const index = propertyIndex(master, "RRULE");
  const current = index === -1 ? null : valueOf(master[index]!);
  const next = recurrence ? buildRRule(recurrence, style) : null;
  if (current === next) return;

  if (next === null) removeProperty(master, "RRULE");
  else setProperty(master, "RRULE", `RRULE:${next}`);

  removeProperty(master, "EXDATE");
  doc.events = doc.events.filter((event) => event === master);
}

function buildOverride(
  master: string[],
  recurrenceId: number,
  edits: EventEdits,
  style: DateStyle,
): string[] {
  const uidIndex = propertyIndex(master, "UID");
  const uid = uidIndex === -1 ? crypto.randomUUID() : valueOf(master[uidIndex]!);
  const duration = durationOf(master, style);

  const start = edits.startTime ?? recurrenceId;
  const end = edits.endTime ?? start + duration;

  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `RECURRENCE-ID${styleParams(style)}:${formatDateTimeInZone(recurrenceId, style.zone, style.isDate)}`,
    `DTSTAMP:${stamp()}`,
    "SEQUENCE:0",
    dateLine("DTSTART", start, style),
    dateLine("DTEND", end, style),
  ];

  // Carry over what the override does not restate, so a server or client that
  // reads the component on its own still shows the right event.
  for (const name of ["SUMMARY", "DESCRIPTION", "LOCATION", "ORGANIZER", "STATUS"]) {
    const index = propertyIndex(master, name);
    if (index !== -1) lines.push(master[index]!);
  }

  lines.push("END:VEVENT");
  applyEdits(lines, { ...edits, startTime: undefined, endTime: undefined }, style);
  return lines;
}

function touch(
  event: string[],
  opts: { bumpSequence: boolean; resetSequence?: boolean },
): void {
  setProperty(event, "DTSTAMP", `DTSTAMP:${stamp()}`);
  setProperty(event, "LAST-MODIFIED", `LAST-MODIFIED:${stamp()}`);

  if (opts.resetSequence) {
    setProperty(event, "SEQUENCE", "SEQUENCE:0");
    return;
  }
  if (!opts.bumpSequence) return;

  const index = propertyIndex(event, "SEQUENCE");
  const current = index === -1 ? 0 : parseInt(valueOf(event[index]!), 10) || 0;
  setProperty(event, "SEQUENCE", `SEQUENCE:${current + 1}`);
}

/** Reduce a rule's COUNT by the instances that stayed with the other half. */
function rebaseCount(rule: string, consumed: number): string {
  if (consumed <= 0) return rule;

  return rule
    .split(";")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1 || part.slice(0, eq).toUpperCase() !== "COUNT") return part;
      const count = parseInt(part.slice(eq + 1), 10);
      if (!Number.isFinite(count)) return part;
      return `COUNT=${Math.max(1, count - consumed)}`;
    })
    .join(";");
}

/** Add or tighten UNTIL on a rule, dropping COUNT since the two conflict. */
function boundRule(rule: string, until: string): string {
  const parts = rule.split(";").filter((part) => {
    const key = part.split("=")[0]?.toUpperCase();
    return key !== "UNTIL" && key !== "COUNT";
  });
  parts.push(`UNTIL=${until}`);
  return parts.join(";");
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}
