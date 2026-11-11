import { generateVEvent, parseVEvent } from "./icalHelper";
import { expandOccurrences } from "./recurrence";
import { buildVTimezone } from "./timezone";
import type { CreateEventInput } from "./types";

beforeEach(() => {
  crypto.randomUUID = vi.fn(() => "test-uuid-1234") as () => `${string}-${string}-${string}-${string}-${string}`;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-06-15T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("generateVEvent", () => {
  it("generates a basic event with summary and times", () => {
    const event: CreateEventInput = {
      summary: "Team Meeting",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    const result = generateVEvent(event);

    expect(result).toContain("BEGIN:VCALENDAR");
    expect(result).toContain("VERSION:2.0");
    expect(result).toContain("PRODID:-//Maish//CalDAV Client//EN");
    expect(result).toContain("BEGIN:VEVENT");
    expect(result).toContain("UID:test-uuid-1234");
    expect(result).toContain("SUMMARY:Team Meeting");
    expect(result).toContain("DTSTART:20250620T140000Z");
    expect(result).toContain("DTEND:20250620T150000Z");
    expect(result).toContain("END:VEVENT");
    expect(result).toContain("END:VCALENDAR");
  });

  it("uses provided UID when given", () => {
    const event: CreateEventInput = {
      summary: "Test",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    const result = generateVEvent(event, "custom-uid-5678");

    expect(result).toContain("UID:custom-uid-5678");
    expect(result).not.toContain("test-uuid-1234");
  });

  it("generates an all-day event with VALUE=DATE format", () => {
    const event: CreateEventInput = {
      summary: "Holiday",
      startTime: "2025-12-25T00:00:00Z",
      endTime: "2025-12-26T00:00:00Z",
      isAllDay: true,
    };

    const result = generateVEvent(event);

    expect(result).toContain("DTSTART;VALUE=DATE:20251225");
    expect(result).toContain("DTEND;VALUE=DATE:20251226");
    expect(result).not.toContain("DTSTART:2025");
  });

  it("writes no rule for a one-off event", () => {
    const event: CreateEventInput = {
      summary: "Once",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    expect(generateVEvent(event)).not.toContain("RRULE");
  });

  it("writes the recurrence rule of a repeating event", () => {
    const event: CreateEventInput = {
      summary: "Standup",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
      recurrence: {
        frequency: "weekly",
        interval: 2,
        byDay: [1, 3],
        end: { kind: "count", count: 12 },
      },
    };

    expect(generateVEvent(event)).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=12");
  });

  it("bounds an all-day series with a bare date", () => {
    // A generated all-day event writes VALUE=DATE, and RFC 5545 §3.3.10 asks
    // UNTIL to use the same value type as DTSTART.
    const event: CreateEventInput = {
      summary: "Holiday",
      startTime: "2025-12-25T00:00:00Z",
      endTime: "2025-12-26T00:00:00Z",
      isAllDay: true,
      recurrence: {
        frequency: "yearly",
        interval: 1,
        byDay: [],
        end: { kind: "onDate", date: "2030-12-25" },
      },
    };

    expect(generateVEvent(event)).toContain("RRULE:FREQ=YEARLY;UNTIL=20301225");
  });

  it("bounds a timed series with a UTC stamp", () => {
    const event: CreateEventInput = {
      summary: "Standup",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
      recurrence: {
        frequency: "daily",
        interval: 1,
        byDay: [],
        end: { kind: "onDate", date: "2025-07-31" },
      },
    };

    // UNTIL covers the whole of the picked day in the series' zone:
    // 23:59:59 CEST is 21:59:59 UTC.
    expect(generateVEvent(event, undefined, "Europe/Berlin"))
      .toContain("RRULE:FREQ=DAILY;UNTIL=20250731T215959Z");
  });

  describe("a timed series", () => {
    // Monday 2 March 2026, 18:00 in Berlin.
    const weekly: CreateEventInput = {
      summary: "Choir",
      startTime: "2026-03-02T17:00:00Z",
      endTime: "2026-03-02T18:30:00Z",
      recurrence: { frequency: "weekly", interval: 1, byDay: [], end: { kind: "never" } },
    };

    it("is written in the zone's wall time, so its rule follows daylight saving", () => {
      // As UTC stamps the rule is evaluated in UTC, and every client showed the
      // instances after the change to summer time an hour early.
      const data = generateVEvent(weekly, "uid-1", "Europe/Berlin");

      expect(data).toContain("DTSTART;TZID=Europe/Berlin:20260302T180000");
      expect(data).toContain("DTEND;TZID=Europe/Berlin:20260302T193000");

      const MAR_30 = Date.parse("2026-03-30T00:00:00Z") / 1000;
      const [after] = expandOccurrences(data, MAR_30, MAR_30 + 86400);
      expect(after?.startTime).toBe(Date.parse("2026-03-30T16:00:00Z") / 1000);
    });

    it("carries a VTIMEZONE for its TZID ahead of the event", () => {
      // RFC 5545 §3.6.5 requires one for every TZID the object uses.
      const data = generateVEvent(weekly, "uid-1", "Europe/Berlin");

      const zone = buildVTimezone("Europe/Berlin", 2025)!.join("\r\n");
      expect(data).toContain(`PRODID:-//Maish//CalDAV Client//EN\r\n${zone}\r\nBEGIN:VEVENT`);
    });

    it("stays in UTC where the zone cannot be stated as a VTIMEZONE", () => {
      const data = generateVEvent(weekly, "uid-1", "Africa/Casablanca");

      expect(data).toContain("DTSTART:20260302T170000Z");
      expect(data).not.toContain("TZID");
      expect(data).not.toContain("VTIMEZONE");
    });

    it("leaves a one-off event in UTC", () => {
      const data = generateVEvent({ ...weekly, recurrence: undefined }, "uid-1", "Europe/Berlin");

      expect(data).toContain("DTSTART:20260302T170000Z");
      expect(data).not.toContain("VTIMEZONE");
    });
  });

  it("includes description when provided", () => {
    const event: CreateEventInput = {
      summary: "Review",
      description: "Quarterly review meeting",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    const result = generateVEvent(event);

    expect(result).toContain("DESCRIPTION:Quarterly review meeting");
  });

  it("includes location when provided", () => {
    const event: CreateEventInput = {
      summary: "Lunch",
      location: "Conference Room B",
      startTime: "2025-06-20T12:00:00Z",
      endTime: "2025-06-20T13:00:00Z",
    };

    const result = generateVEvent(event);

    expect(result).toContain("LOCATION:Conference Room B");
  });

  it("includes attendees with RSVP", () => {
    const event: CreateEventInput = {
      summary: "Standup",
      startTime: "2025-06-20T09:00:00Z",
      endTime: "2025-06-20T09:15:00Z",
      attendees: [
        { email: "alice@example.com" },
        { email: "bob@example.com" },
      ],
    };

    const result = generateVEvent(event);

    expect(result).toContain("ATTENDEE;RSVP=TRUE:mailto:alice@example.com");
    expect(result).toContain("ATTENDEE;RSVP=TRUE:mailto:bob@example.com");
  });

  it("escapes special characters in text fields", () => {
    const event: CreateEventInput = {
      summary: "Meeting; with, special\\chars",
      description: "Line1\nLine2",
      location: "Room A; Floor 2, Building 1",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    const result = generateVEvent(event);

    expect(result).toContain("SUMMARY:Meeting\\; with\\, special\\\\chars");
    expect(result).toContain("DESCRIPTION:Line1\\nLine2");
    expect(result).toContain("LOCATION:Room A\\; Floor 2\\, Building 1");
  });

  it("uses CRLF line endings", () => {
    const event: CreateEventInput = {
      summary: "Test",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    const result = generateVEvent(event);

    expect(result).toContain("\r\n");
    const lines = result.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
  });

  it("omits description and location when not provided", () => {
    const event: CreateEventInput = {
      summary: "Simple",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    const result = generateVEvent(event);

    expect(result).not.toContain("DESCRIPTION:");
    expect(result).not.toContain("LOCATION:");
    expect(result).not.toContain("ATTENDEE");
  });

  it("includes DTSTAMP with current UTC time", () => {
    const event: CreateEventInput = {
      summary: "Test",
      startTime: "2025-06-20T14:00:00Z",
      endTime: "2025-06-20T15:00:00Z",
    };

    const result = generateVEvent(event);

    expect(result).toContain("DTSTAMP:20250615T100000Z");
  });
});

describe("parseVEvent", () => {
  it("parses a basic VEVENT", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:abc-123",
      "SUMMARY:Team Sync",
      "DTSTART:20250620T140000Z",
      "DTEND:20250620T150000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.uid).toBe("abc-123");
    expect(result.summary).toBe("Team Sync");
    expect(result.isAllDay).toBe(false);
    expect(result.startTime).toBe(Math.floor(new Date("2025-06-20T14:00:00Z").getTime() / 1000));
    expect(result.endTime).toBe(Math.floor(new Date("2025-06-20T15:00:00Z").getTime() / 1000));
    expect(result.remoteEventId).toBe("abc-123");
    expect(result.status).toBe("confirmed");
    expect(result.etag).toBeNull();
    expect(result.htmlLink).toBeNull();
  });

  it("parses an all-day event with VALUE=DATE", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:allday-1",
      "SUMMARY:Conference",
      "DTSTART;VALUE=DATE:20250701",
      "DTEND;VALUE=DATE:20250703",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.isAllDay).toBe(true);
    expect(result.summary).toBe("Conference");
    const expectedStart = Math.floor(new Date(2025, 6, 1).getTime() / 1000);
    const expectedEnd = Math.floor(new Date(2025, 6, 3).getTime() / 1000);
    expect(result.startTime).toBe(expectedStart);
    expect(result.endTime).toBe(expectedEnd);
  });

  it("parses description and location", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:detail-1",
      "SUMMARY:Workshop",
      "DESCRIPTION:Learn new things",
      "LOCATION:Main Hall",
      "DTSTART:20250620T090000Z",
      "DTEND:20250620T170000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.description).toBe("Learn new things");
    expect(result.location).toBe("Main Hall");
  });

  it("parses attendees with CN and PARTSTAT", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:attend-1",
      "SUMMARY:Planning",
      'ATTENDEE;CN="Alice Smith";PARTSTAT=ACCEPTED:mailto:alice@example.com',
      "ATTENDEE;CN=Bob;PARTSTAT=TENTATIVE:mailto:bob@example.com",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.attendeesJson).not.toBeNull();
    const attendees = JSON.parse(result.attendeesJson!);
    expect(attendees).toHaveLength(2);
    expect(attendees[0]).toEqual({
      email: "alice@example.com",
      displayName: "Alice Smith",
      responseStatus: "accepted",
    });
    expect(attendees[1]).toEqual({
      email: "bob@example.com",
      displayName: "Bob",
      responseStatus: "tentative",
    });
  });

  it("parses organizer email", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:org-1",
      "SUMMARY:Review",
      "ORGANIZER;CN=Manager:mailto:manager@example.com",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.organizerEmail).toBe("manager@example.com");
  });

  it("parses STATUS field", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:status-1",
      "SUMMARY:Cancelled Event",
      "STATUS:CANCELLED",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.status).toBe("cancelled");
  });

  it("handles missing fields gracefully", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:minimal-1",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.uid).toBe("minimal-1");
    expect(result.summary).toBeNull();
    expect(result.description).toBeNull();
    expect(result.location).toBeNull();
    expect(result.organizerEmail).toBeNull();
    expect(result.attendeesJson).toBeNull();
    expect(result.startTime).toBe(0);
    // endTime defaults to startTime + 3600 when missing
    expect(result.endTime).toBe(3600);
  });

  it("uses href as remoteEventId when provided", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:uid-1",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical, "/calendars/cal1/events/event-abc.ics");

    expect(result.remoteEventId).toBe("/calendars/cal1/events/event-abc.ics");
  });

  it("falls back to randomUUID when no UID and no href", () => {
    const ical = [
      "BEGIN:VEVENT",
      "SUMMARY:No UID",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.remoteEventId).toBe("test-uuid-1234");
    expect(result.uid).toBeNull();
  });

  it("unescapes special characters in text fields", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:esc-1",
      "SUMMARY:Meeting\\; with\\, special\\\\chars",
      "DESCRIPTION:Line1\\nLine2",
      "LOCATION:Room A\\; Floor 2",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.summary).toBe("Meeting; with, special\\chars");
    expect(result.description).toBe("Line1\nLine2");
    expect(result.location).toBe("Room A; Floor 2");
  });

  it("unfolds continuation lines (RFC 5545)", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:fold-1",
      "SUMMARY:This is a very long summ",
      " ary that was folded",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.summary).toBe("This is a very long summary that was folded");
  });

  it("unfolds continuation lines with tab", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:fold-tab-1",
      "SUMMARY:Folded with",
      "\ttab character",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.summary).toBe("Folded withtab character");
  });

  it("handles values containing colons", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:colon-1",
      "SUMMARY:Meeting at 10:30:00",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.summary).toBe("Meeting at 10:30:00");
  });

  it("parses non-UTC datetime (no Z suffix)", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:local-1",
      "DTSTART:20250620T140000",
      "DTEND:20250620T150000",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    // Local time -- new Date(2025, 5, 20, 14, 0, 0)
    const expectedStart = Math.floor(new Date(2025, 5, 20, 14, 0, 0).getTime() / 1000);
    const expectedEnd = Math.floor(new Date(2025, 5, 20, 15, 0, 0).getTime() / 1000);
    expect(result.startTime).toBe(expectedStart);
    expect(result.endTime).toBe(expectedEnd);
  });

  it("stores original icalData on the result", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:raw-1",
      "SUMMARY:Test",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);

    expect(result.icalData).toBe(ical);
  });

  it("handles attendees without CN or PARTSTAT", () => {
    const ical = [
      "BEGIN:VEVENT",
      "UID:att-simple",
      "ATTENDEE;RSVP=TRUE:mailto:plain@example.com",
      "DTSTART:20250620T100000Z",
      "DTEND:20250620T110000Z",
      "END:VEVENT",
    ].join("\r\n");

    const result = parseVEvent(ical);
    const attendees = JSON.parse(result.attendeesJson!);

    expect(attendees).toHaveLength(1);
    expect(attendees[0].email).toBe("plain@example.com");
    expect(attendees[0].displayName).toBeUndefined();
    expect(attendees[0].responseStatus).toBeUndefined();
  });
});

describe("round-trip: generateVEvent -> parseVEvent", () => {
  it("preserves basic event data through generate and parse", () => {
    const input: CreateEventInput = {
      summary: "Round Trip Test",
      description: "Testing full cycle",
      location: "Office",
      startTime: "2025-07-01T09:00:00Z",
      endTime: "2025-07-01T10:30:00Z",
    };

    const ical = generateVEvent(input, "roundtrip-uid");
    const parsed = parseVEvent(ical);

    expect(parsed.uid).toBe("roundtrip-uid");
    expect(parsed.summary).toBe("Round Trip Test");
    expect(parsed.description).toBe("Testing full cycle");
    expect(parsed.location).toBe("Office");
    expect(parsed.isAllDay).toBe(false);
    expect(parsed.startTime).toBe(Math.floor(new Date("2025-07-01T09:00:00Z").getTime() / 1000));
    expect(parsed.endTime).toBe(Math.floor(new Date("2025-07-01T10:30:00Z").getTime() / 1000));
  });

  it("preserves all-day event data through round-trip", () => {
    const input: CreateEventInput = {
      summary: "Vacation",
      startTime: "2025-08-01T00:00:00Z",
      endTime: "2025-08-08T00:00:00Z",
      isAllDay: true,
    };

    const ical = generateVEvent(input, "allday-rt");
    const parsed = parseVEvent(ical);

    expect(parsed.uid).toBe("allday-rt");
    expect(parsed.summary).toBe("Vacation");
    expect(parsed.isAllDay).toBe(true);
  });

  it("preserves attendee emails through round-trip", () => {
    const input: CreateEventInput = {
      summary: "Group Call",
      startTime: "2025-07-01T15:00:00Z",
      endTime: "2025-07-01T16:00:00Z",
      attendees: [
        { email: "dev@example.com" },
        { email: "pm@example.com" },
      ],
    };

    const ical = generateVEvent(input, "att-rt");
    const parsed = parseVEvent(ical);

    const attendees = JSON.parse(parsed.attendeesJson!);
    expect(attendees).toHaveLength(2);
    expect(attendees[0].email).toBe("dev@example.com");
    expect(attendees[1].email).toBe("pm@example.com");
  });

  it("preserves special characters through round-trip", () => {
    const input: CreateEventInput = {
      summary: "Review; Q2, Results\\Final",
      description: "Line one\nLine two\nLine three",
      location: "Building A; Room 3, Floor 2",
      startTime: "2025-07-01T09:00:00Z",
      endTime: "2025-07-01T10:00:00Z",
    };

    const ical = generateVEvent(input, "escape-rt");
    const parsed = parseVEvent(ical);

    expect(parsed.summary).toBe("Review; Q2, Results\\Final");
    expect(parsed.description).toBe("Line one\nLine two\nLine three");
    expect(parsed.location).toBe("Building A; Room 3, Floor 2");
  });
});
