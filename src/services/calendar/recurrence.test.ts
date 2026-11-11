import { countInstancesBefore, expandOccurrences } from "./recurrence";

/**
 * Verbatim payload from a Stalwart server, written by Apple Calendar.
 * Kept intact on purpose: the VTIMEZONE carries RRULE and DTSTART properties
 * of its own, which a parser that ignores component boundaries will mistake
 * for the event's.
 */
const WEEKLY_VIENNA = [
  "BEGIN:VCALENDAR",
  "CALSCALE:GREGORIAN",
  "PRODID:-//Apple Inc.//macOS 26.6.1//EN",
  "VERSION:2.0",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Vienna",
  "BEGIN:DAYLIGHT",
  "DTSTART:19810329T020000",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
  "TZNAME:GMT+2",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "DTSTART:19961027T030000",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
  "TZNAME:GMT+1",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "CREATED:20260810T181247Z",
  "DTEND;TZID=Europe/Vienna:20260930T220000",
  "DTSTAMP:20260811T065817Z",
  "DTSTART;TZID=Europe/Vienna:20260930T180000",
  "LAST-MODIFIED:20260810T181713Z",
  "RRULE:FREQ=WEEKLY;UNTIL=20270127T225959Z",
  "SEQUENCE:0",
  "SUMMARY:Englisch BFI",
  "TRANSP:OPAQUE",
  "UID:7CAE5FE8-6C1F-4487-BAD2-C4B1EF2DE6E5",
  "BEGIN:VALARM",
  "ACTION:NONE",
  "TRIGGER;VALUE=DATE-TIME:19760401T005545Z",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("expandOccurrences", () => {
  it("expands a weekly series into one occurrence per week", () => {
    const occurrences = expandOccurrences(
      WEEKLY_VIENNA,
      ts("2026-09-28T00:00:00Z"),
      ts("2026-11-01T00:00:00Z"),
    );

    expect(occurrences.map((o) => o.startTime)).toEqual([
      ts("2026-09-30T16:00:00Z"),
      ts("2026-10-07T16:00:00Z"),
      ts("2026-10-14T16:00:00Z"),
      ts("2026-10-21T16:00:00Z"),
      ts("2026-10-28T17:00:00Z"),
    ]);
  });

  it("keeps the wall-clock time across a DST transition", () => {
    // Europe/Vienna leaves DST on 2026-10-25. Both occurrences are 18:00
    // local, so their UTC instants must differ by an hour.
    const occurrences = expandOccurrences(
      WEEKLY_VIENNA,
      ts("2026-10-19T00:00:00Z"),
      ts("2026-11-01T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.startTime).toBe(ts("2026-10-21T16:00:00Z"));
    expect(occurrences[1]!.startTime).toBe(ts("2026-10-28T17:00:00Z"));
  });

  it("ignores the RRULE and DTSTART belonging to the VTIMEZONE", () => {
    // The VTIMEZONE's rules are yearly and start in 1981/1996. If they leaked
    // into the event, the series would neither be weekly nor start in 2026.
    const occurrences = expandOccurrences(
      WEEKLY_VIENNA,
      ts("2026-09-28T00:00:00Z"),
      ts("2026-10-12T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.startTime).toBe(ts("2026-09-30T16:00:00Z"));
    expect(occurrences[0]!.summary).toBe("Englisch BFI");
  });

  it("carries the master's duration onto every occurrence", () => {
    const occurrences = expandOccurrences(
      WEEKLY_VIENNA,
      ts("2026-09-28T00:00:00Z"),
      ts("2026-10-05T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.endTime - occurrences[0]!.startTime).toBe(4 * 3600);
  });

  it("stops the series at UNTIL", () => {
    const occurrences = expandOccurrences(
      WEEKLY_VIENNA,
      ts("2027-01-20T00:00:00Z"),
      ts("2027-03-01T00:00:00Z"),
    );

    // UNTIL is 2027-01-27T22:59:59Z; the occurrence on 2027-01-27 starts at
    // 17:00Z and so still falls inside the series.
    expect(occurrences.map((o) => o.startTime)).toEqual([
      ts("2027-01-20T17:00:00Z"),
      ts("2027-01-27T17:00:00Z"),
    ]);
  });

  it("marks every generated instance with its recurrence id", () => {
    const occurrences = expandOccurrences(
      WEEKLY_VIENNA,
      ts("2026-09-28T00:00:00Z"),
      ts("2026-10-12T00:00:00Z"),
    );

    expect(occurrences[0]!.recurrenceId).toBe(ts("2026-09-30T16:00:00Z"));
    expect(occurrences[0]!.isOverride).toBe(false);
    expect(occurrences[1]!.recurrenceId).toBe(ts("2026-10-07T16:00:00Z"));
  });

  it("returns occurrences in chronological order", () => {
    const occurrences = expandOccurrences(
      WEEKLY_VIENNA,
      ts("2026-09-28T00:00:00Z"),
      ts("2026-11-01T00:00:00Z"),
    );

    const starts = occurrences.map((o) => o.startTime);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("returns a single occurrence for an event without a rule", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:single-1",
      "SUMMARY:One Off",
      "DTSTART:20260930T160000Z",
      "DTEND:20260930T170000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const occurrences = expandOccurrences(
      ical,
      ts("2026-09-01T00:00:00Z"),
      ts("2026-10-31T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.startTime).toBe(ts("2026-09-30T16:00:00Z"));
    expect(occurrences[0]!.isOverride).toBe(false);
  });
});

/** 2026-01-05 is a Monday, which keeps the weekday-based rules readable. */
function series(opts: {
  dtstart?: string;
  dtend?: string;
  rrule?: string;
  extra?: string[];
  overrides?: string[][];
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:series-1",
    "SUMMARY:Series",
    `DTSTART:${opts.dtstart ?? "20260105T090000Z"}`,
    `DTEND:${opts.dtend ?? "20260105T100000Z"}`,
    ...(opts.rrule ? [`RRULE:${opts.rrule}`] : []),
    ...(opts.extra ?? []),
    "END:VEVENT",
  ];

  for (const override of opts.overrides ?? []) {
    lines.push("BEGIN:VEVENT", "UID:series-1", ...override, "END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

const WHOLE_2026: [number, number] = [
  Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000),
  Math.floor(Date.parse("2027-12-31T00:00:00Z") / 1000),
];

const startsOf = (ical: string, range: [number, number] = WHOLE_2026) =>
  expandOccurrences(ical, range[0], range[1]).map((o) => o.startTime);

describe("recurrence rules", () => {
  it("honours COUNT, including DTSTART as the first instance", () => {
    expect(startsOf(series({ rrule: "FREQ=DAILY;COUNT=3" }))).toEqual([
      ts("2026-01-05T09:00:00Z"),
      ts("2026-01-06T09:00:00Z"),
      ts("2026-01-07T09:00:00Z"),
    ]);
  });

  it("expands BYDAY across the week", () => {
    expect(startsOf(series({ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4" }))).toEqual([
      ts("2026-01-05T09:00:00Z"),
      ts("2026-01-07T09:00:00Z"),
      ts("2026-01-09T09:00:00Z"),
      ts("2026-01-12T09:00:00Z"),
    ]);
  });

  it("applies INTERVAL to weekly rules", () => {
    expect(startsOf(series({ rrule: "FREQ=WEEKLY;INTERVAL=2;COUNT=3" }))).toEqual([
      ts("2026-01-05T09:00:00Z"),
      ts("2026-01-19T09:00:00Z"),
      ts("2026-02-02T09:00:00Z"),
    ]);
  });

  it("resolves a negative BYDAY ordinal to the last such weekday of the month", () => {
    const ical = series({
      dtstart: "20260130T090000Z",
      dtend: "20260130T100000Z",
      rrule: "FREQ=MONTHLY;BYDAY=-1FR;COUNT=3",
    });

    expect(startsOf(ical)).toEqual([
      ts("2026-01-30T09:00:00Z"),
      ts("2026-02-27T09:00:00Z"),
      ts("2026-03-27T09:00:00Z"),
    ]);
  });

  it("skips months that are too short for BYMONTHDAY", () => {
    const ical = series({
      dtstart: "20260131T090000Z",
      dtend: "20260131T100000Z",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
    });

    // February and April have no 31st, so they produce nothing at all.
    expect(startsOf(ical)).toEqual([
      ts("2026-01-31T09:00:00Z"),
      ts("2026-03-31T09:00:00Z"),
      ts("2026-05-31T09:00:00Z"),
    ]);
  });

  it("skips short months when the rule inherits DTSTART's day", () => {
    const ical = series({
      dtstart: "20260131T090000Z",
      dtend: "20260131T100000Z",
      rrule: "FREQ=MONTHLY;COUNT=2",
    });

    expect(startsOf(ical)).toEqual([
      ts("2026-01-31T09:00:00Z"),
      ts("2026-03-31T09:00:00Z"),
    ]);
  });

  it("resolves a yearly rule pinned to a month and weekday", () => {
    const ical = series({
      dtstart: "20260329T090000Z",
      dtend: "20260329T100000Z",
      rrule: "FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU;COUNT=2",
    });

    expect(startsOf(ical)).toEqual([
      ts("2026-03-29T09:00:00Z"),
      ts("2027-03-28T09:00:00Z"),
    ]);
  });

  it("applies BYSETPOS to pick one candidate per period", () => {
    const ical = series({
      dtstart: "20260130T090000Z",
      dtend: "20260130T100000Z",
      rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2",
    });

    // The last weekday of the month, not the last day.
    expect(startsOf(ical)).toEqual([
      ts("2026-01-30T09:00:00Z"),
      ts("2026-02-27T09:00:00Z"),
    ]);
  });

  it("removes instances listed in EXDATE", () => {
    const ical = series({
      rrule: "FREQ=WEEKLY;COUNT=3",
      extra: ["EXDATE:20260112T090000Z"],
    });

    expect(startsOf(ical)).toEqual([
      ts("2026-01-05T09:00:00Z"),
      ts("2026-01-19T09:00:00Z"),
    ]);
  });

  it("keeps EXDATE from consuming a COUNT slot", () => {
    // RFC 5545 applies COUNT to the rule, then subtracts EXDATE, so excluding
    // one instance leaves two rather than pulling a fourth in.
    const ical = series({
      rrule: "FREQ=WEEKLY;COUNT=3",
      extra: ["EXDATE:20260112T090000Z"],
    });

    expect(startsOf(ical)).toHaveLength(2);
  });

  it("adds instances listed in RDATE", () => {
    const ical = series({
      rrule: "FREQ=WEEKLY;COUNT=2",
      extra: ["RDATE:20260108T110000Z"],
    });

    expect(startsOf(ical)).toEqual([
      ts("2026-01-05T09:00:00Z"),
      ts("2026-01-08T11:00:00Z"),
      ts("2026-01-12T09:00:00Z"),
    ]);
  });

  it("expands an all-day series", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:allday-series",
      "SUMMARY:Bin Day",
      "DTSTART;VALUE=DATE:20260105",
      "DTEND;VALUE=DATE:20260106",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const occurrences = expandOccurrences(ical, WHOLE_2026[0], WHOLE_2026[1]);

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.isAllDay).toBe(true);
    // All-day values are floating, so they land on local midnight.
    expect(occurrences[0]!.startTime).toBe(Math.floor(new Date(2026, 0, 5).getTime() / 1000));
    expect(occurrences[1]!.startTime).toBe(Math.floor(new Date(2026, 0, 12).getTime() / 1000));
  });

  it("caps an unbounded series at the queried range", () => {
    const occurrences = expandOccurrences(
      series({ rrule: "FREQ=DAILY" }),
      ts("2026-06-01T00:00:00Z"),
      ts("2026-06-08T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(7);
    expect(occurrences[0]!.startTime).toBe(ts("2026-06-01T09:00:00Z"));
    expect(occurrences[6]!.startTime).toBe(ts("2026-06-07T09:00:00Z"));
  });
});

describe("per-instance overrides", () => {
  const MOVED = series({
    rrule: "FREQ=WEEKLY;COUNT=3",
    overrides: [[
      "RECURRENCE-ID:20260112T090000Z",
      "DTSTART:20260112T140000Z",
      "DTEND:20260112T150000Z",
      "SUMMARY:Moved to the afternoon",
    ]],
  });

  it("replaces the generated instance with the override", () => {
    const occurrences = expandOccurrences(MOVED, WHOLE_2026[0], WHOLE_2026[1]);

    expect(occurrences.map((o) => o.startTime)).toEqual([
      ts("2026-01-05T09:00:00Z"),
      ts("2026-01-12T14:00:00Z"),
      ts("2026-01-19T09:00:00Z"),
    ]);
    expect(occurrences[1]!.summary).toBe("Moved to the afternoon");
    expect(occurrences[1]!.isOverride).toBe(true);
    expect(occurrences[1]!.recurrenceId).toBe(ts("2026-01-12T09:00:00Z"));
  });

  it("leaves the untouched instances on the master's data", () => {
    const occurrences = expandOccurrences(MOVED, WHOLE_2026[0], WHOLE_2026[1]);

    expect(occurrences[0]!.summary).toBe("Series");
    expect(occurrences[0]!.isOverride).toBe(false);
    expect(occurrences[2]!.isOverride).toBe(false);
  });

  it("inherits properties the override does not restate", () => {
    const ical = series({
      extra: ["LOCATION:Main Hall"],
      rrule: "FREQ=WEEKLY;COUNT=2",
      overrides: [[
        "RECURRENCE-ID:20260112T090000Z",
        "DTSTART:20260112T140000Z",
        "DTEND:20260112T150000Z",
      ]],
    });

    const occurrences = expandOccurrences(ical, WHOLE_2026[0], WHOLE_2026[1]);

    expect(occurrences[1]!.summary).toBe("Series");
    expect(occurrences[1]!.location).toBe("Main Hall");
  });

  it("finds an override moved outside the window its recurrence id falls in", () => {
    const ical = series({
      rrule: "FREQ=WEEKLY;COUNT=3",
      overrides: [[
        "RECURRENCE-ID:20260112T090000Z",
        "DTSTART:20260220T140000Z",
        "DTEND:20260220T150000Z",
        "SUMMARY:Pushed to February",
      ]],
    });

    // The series itself ends on 2026-01-19, so nothing but the moved instance
    // can appear in this range.
    const occurrences = expandOccurrences(
      ical,
      ts("2026-02-15T00:00:00Z"),
      ts("2026-02-25T00:00:00Z"),
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.summary).toBe("Pushed to February");
    expect(occurrences[0]!.startTime).toBe(ts("2026-02-20T14:00:00Z"));
  });

  it("does not emit an instance that is both overridden and excluded", () => {
    const ical = series({
      rrule: "FREQ=WEEKLY;COUNT=3",
      extra: ["EXDATE:20260112T090000Z"],
      overrides: [[
        "RECURRENCE-ID:20260112T090000Z",
        "DTSTART:20260112T140000Z",
        "DTEND:20260112T150000Z",
      ]],
    });

    expect(startsOf(ical)).toEqual([
      ts("2026-01-05T09:00:00Z"),
      ts("2026-01-19T09:00:00Z"),
    ]);
  });
});

describe("countInstancesBefore", () => {
  it("counts the instances the first half of a split keeps", () => {
    const ical = series({ rrule: "FREQ=WEEKLY;COUNT=10" });

    expect(countInstancesBefore(ical, ts("2026-01-05T09:00:00Z"))).toBe(0);
    expect(countInstancesBefore(ical, ts("2026-01-26T09:00:00Z"))).toBe(3);
  });

  it("counts an excluded instance too, since it already used up the count", () => {
    // EXDATE removes a date from the set the rule produced; it does not hand
    // the count back (RFC 5545 §3.8.5.1).
    const ical = series({
      rrule: "FREQ=WEEKLY;COUNT=10",
      extra: ["EXDATE:20260112T090000Z"],
    });

    expect(countInstancesBefore(ical, ts("2026-01-26T09:00:00Z"))).toBe(3);
  });

  it("returns nothing for an object without a readable event", () => {
    expect(countInstancesBefore("BEGIN:VCALENDAR\r\nEND:VCALENDAR", 0)).toBe(0);
  });
});

/**
 * RFC 5545 §3.3.10: "Recurrence rules may generate recurrence instances with
 * an invalid date... Such recurrence instances MUST be ignored and MUST NOT be
 * counted as part of the recurrence set." The monthly expansion already skips
 * a 31st in a short month; the yearly one has the same case in the leap day.
 */
const LEAP_DAY_YEARLY = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:leap-day@test",
  "DTSTART:20240229T090000Z",
  "DTEND:20240229T100000Z",
  "RRULE:FREQ=YEARLY",
  "SUMMARY:Leap day only",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("expandOccurrences — a yearly series on 29 February", () => {
  it("produces no instance in a common year", () => {
    const occurrences = expandOccurrences(
      LEAP_DAY_YEARLY,
      ts("2025-01-01T00:00:00Z"),
      ts("2026-01-01T00:00:00Z"),
    );

    expect(occurrences).toEqual([]);
  });

  it("does not move the instance to 1 March", () => {
    const occurrences = expandOccurrences(
      LEAP_DAY_YEARLY,
      ts("2025-02-25T00:00:00Z"),
      ts("2025-03-05T00:00:00Z"),
    );

    expect(occurrences.map((o) => o.startTime)).not.toContain(
      ts("2025-03-01T09:00:00Z"),
    );
  });

  it("still produces the instance in a leap year", () => {
    const occurrences = expandOccurrences(
      LEAP_DAY_YEARLY,
      ts("2028-01-01T00:00:00Z"),
      ts("2029-01-01T00:00:00Z"),
    );

    expect(occurrences.map((o) => o.startTime)).toEqual([
      ts("2028-02-29T09:00:00Z"),
    ]);
  });

  it("skips the common years between two leap years", () => {
    const occurrences = expandOccurrences(
      LEAP_DAY_YEARLY,
      ts("2024-01-01T00:00:00Z"),
      ts("2029-01-01T00:00:00Z"),
    );

    expect(occurrences.map((o) => o.startTime)).toEqual([
      ts("2024-02-29T09:00:00Z"),
      ts("2028-02-29T09:00:00Z"),
    ]);
  });
});

describe("long-running series", () => {
  it("still shows a daily series that started more than 5 000 days ago", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:daily-since-2000",
      "DTSTART:20000101T090000Z",
      "DTEND:20000101T093000Z",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const weekStart = Date.UTC(2026, 10, 9) / 1000;

    const occurrences = expandOccurrences(ical, weekStart, weekStart + 7 * 86400);

    expect(occurrences).toHaveLength(7);
  });
});
