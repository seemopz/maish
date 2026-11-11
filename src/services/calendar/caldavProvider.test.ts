import { DAVClient } from "tsdav";
import { CalDAVProvider } from "./caldavProvider";
import { davFetch } from "./davFetch";
import { CalendarWriteError } from "./errors";

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

const MOCK_ICAL_DATA =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-uid\r\nSUMMARY:Test Event\r\nDTSTART:20240101T100000Z\r\nDTEND:20240101T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";

const MOCK_ICAL_DATA_2 =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-uid-2\r\nSUMMARY:Second Event\r\nDTSTART:20240102T140000Z\r\nDTEND:20240102T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";

/** tsdav hands back the raw fetch response, whatever the status. */
const davResponse = (status: number, statusText = "") =>
  new Response(null, { status, statusText });

const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockFetchCalendars = vi.fn();
const mockFetchCalendarObjects = vi.fn();
const mockCreateCalendarObject = vi.fn().mockResolvedValue(davResponse(201));
const mockUpdateCalendarObject = vi.fn().mockResolvedValue(davResponse(204));
const mockDeleteCalendarObject = vi.fn().mockResolvedValue(davResponse(204));

vi.mock("tsdav", () => {
  const MockDAVClient = vi.fn(function (this: Record<string, unknown>) {
    this.login = mockLogin;
    this.fetchCalendars = mockFetchCalendars;
    this.fetchCalendarObjects = mockFetchCalendarObjects;
    this.createCalendarObject = mockCreateCalendarObject;
    this.updateCalendarObject = mockUpdateCalendarObject;
    this.deleteCalendarObject = mockDeleteCalendarObject;
  });
  return { DAVClient: MockDAVClient };
});

vi.mock("@/services/db/accounts", () => ({
  getAccount: vi.fn().mockResolvedValue({
    id: "acc-1",
    email: "user@example.com",
    caldav_url: "https://caldav.example.com",
    caldav_username: "user@example.com",
    caldav_password: "secret",
  }),
}));

describe("CalDAVProvider", () => {
  let provider: CalDAVProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CalDAVProvider("acc-1");
  });

  it("routes DAV requests through the Rust HTTP client", async () => {
    mockFetchCalendars.mockResolvedValue([]);

    await provider.listCalendars();

    // Without an explicit override tsdav uses the webview's fetch, whose
    // requests DAV servers answer without CORS headers.
    expect(vi.mocked(DAVClient).mock.calls[0]?.[0]).toMatchObject({
      fetch: davFetch,
    });
  });

  it("logs in again after a failed login instead of keeping the half-built client", async () => {
    mockLogin.mockRejectedValueOnce(new Error("offline"));
    mockFetchCalendars.mockResolvedValue([]);

    await expect(provider.listCalendars()).rejects.toThrow("offline");
    await provider.listCalendars();

    expect(mockLogin).toHaveBeenCalledTimes(2);
  });

  describe("listCalendars", () => {
    it("maps tsdav calendars to CalendarInfo array", async () => {
      mockFetchCalendars.mockResolvedValue([
        { url: "/cal/personal/", displayName: "Personal" },
        { url: "/cal/work/", displayName: "Work", calendarColor: "#ff0000" },
      ]);

      const calendars = await provider.listCalendars();

      expect(calendars).toEqual([
        { remoteId: "/cal/personal/", displayName: "Personal", color: null, isPrimary: true },
        { remoteId: "/cal/work/", displayName: "Work", color: "#ff0000", isPrimary: false },
      ]);
    });

    it("passes the collection's ctag on, so an unchanged calendar is not downloaded again", async () => {
      mockFetchCalendars.mockResolvedValue([{ url: "/cal/personal/", displayName: "Personal", ctag: "42" }]);

      const [calendar] = await provider.listCalendars();

      expect(calendar!.ctag).toBe("42");
    });

    it("handles non-string displayName by falling back to indexed name", async () => {
      mockFetchCalendars.mockResolvedValue([
        { url: "/cal/unnamed/", displayName: undefined },
        { url: "/cal/also-unnamed/", displayName: null },
      ]);

      const calendars = await provider.listCalendars();

      expect(calendars[0]!.displayName).toBe("Calendar 1");
      expect(calendars[1]!.displayName).toBe("Calendar 2");
    });
  });

  describe("fetchEvents", () => {
    it("passes time range and parses iCalendar data from objects", async () => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"etag-1"' },
        { data: MOCK_ICAL_DATA_2, url: "/cal/personal/test-uid-2.ics", etag: '"etag-2"' },
      ]);

      const events = await provider.fetchEvents("/cal/personal/", "2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

      expect(mockFetchCalendarObjects).toHaveBeenCalledWith({
        calendar: { url: "/cal/personal/" },
        timeRange: { start: "2024-01-01T00:00:00Z", end: "2024-01-31T23:59:59Z" },
      });

      expect(events).toHaveLength(2);
      expect(events[0]!.summary).toBe("Test Event");
      expect(events[0]!.uid).toBe("test-uid");
      expect(events[0]!.etag).toBe('"etag-1"');
      expect(events[0]!.remoteEventId).toBe("/cal/personal/test-uid.ics");
      expect(events[1]!.summary).toBe("Second Event");
      expect(events[1]!.etag).toBe('"etag-2"');
    });

    it("filters out objects with no data", async () => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"etag-1"' },
        { data: null, url: "/cal/personal/empty.ics", etag: null },
      ]);

      const events = await provider.fetchEvents("/cal/personal/", "2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

      expect(events).toHaveLength(1);
    });
  });

  describe("createEvent", () => {
    it("generates iCalendar and calls createCalendarObject", async () => {
      vi.spyOn(crypto, "randomUUID").mockReturnValue("generated-uuid" as `${string}-${string}-${string}-${string}-${string}`);

      const event = await provider.createEvent("/cal/personal/", {
        summary: "New Meeting",
        startTime: "2024-03-15T09:00:00Z",
        endTime: "2024-03-15T10:00:00Z",
      });

      expect(mockCreateCalendarObject).toHaveBeenCalledWith({
        calendar: { url: "/cal/personal/" },
        filename: "generated-uuid.ics",
        iCalString: expect.stringContaining("SUMMARY:New Meeting"),
      });

      expect(event.summary).toBe("New Meeting");
      expect(event.remoteEventId).toBe("/cal/personal/generated-uuid.ics");
    });

    it("writes the recurrence rule of a repeating event", async () => {
      vi.spyOn(crypto, "randomUUID").mockReturnValue("generated-uuid" as `${string}-${string}-${string}-${string}-${string}`);

      const event = await provider.createEvent("/cal/personal/", {
        summary: "Standup",
        startTime: "2024-03-15T09:00:00Z",
        endTime: "2024-03-15T09:15:00Z",
        recurrence: { frequency: "daily", interval: 1, byDay: [], end: { kind: "count", count: 5 } },
      });

      expect(mockCreateCalendarObject).toHaveBeenCalledWith(
        expect.objectContaining({
          iCalString: expect.stringContaining("RRULE:FREQ=DAILY;COUNT=5"),
        }),
      );
      expect(event.rrule).toBe("FREQ=DAILY;COUNT=5");
    });
  });

  describe("updateEvent", () => {
    it("fetches existing, merges updates, and calls updateCalendarObject", async () => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"old-etag"' },
      ]);

      const event = await provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/test-uid.ics",
        { summary: "Updated Event" },
        '"old-etag"',
      );

      expect(mockFetchCalendarObjects).toHaveBeenCalledWith({
        calendar: { url: "/cal/personal/" },
        objectUrls: ["/cal/personal/test-uid.ics"],
      });

      expect(mockUpdateCalendarObject).toHaveBeenCalledWith({
        calendarObject: {
          url: "/cal/personal/test-uid.ics",
          data: expect.stringContaining("SUMMARY:Updated Event"),
          etag: '"old-etag"',
        },
      });

      expect(event.summary).toBe("Updated Event");
      expect(event.remoteEventId).toBe("/cal/personal/test-uid.ics");
    });

    it("throws when the existing event is not found", async () => {
      mockFetchCalendarObjects.mockResolvedValue([]);

      await expect(
        provider.updateEvent("/cal/personal/", "/cal/personal/missing.ics", { summary: "Nope" }),
      ).rejects.toThrow("Event not found on server");
    });

    it("turns a one-off event into a series", async () => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"old-etag"' },
      ]);

      await provider.updateEvent("/cal/personal/", "/cal/personal/test-uid.ics", {
        recurrence: { frequency: "weekly", interval: 1, byDay: [2], end: { kind: "never" } },
      });

      expect(mockUpdateCalendarObject).toHaveBeenCalledWith({
        calendarObject: expect.objectContaining({
          data: expect.stringContaining("RRULE:FREQ=WEEKLY;BYDAY=TU"),
        }),
      });
    });

    it("leaves the stored rule alone when the dialog sends none", async () => {
      // A rule too detailed for the repeat control must survive an edit of the
      // title, which is only possible if the field is absent rather than null.
      const recurring = MOCK_ICAL_DATA.replace(
        "DTEND:20240101T110000Z",
        "DTEND:20240101T110000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=3TH",
      );
      mockFetchCalendarObjects.mockResolvedValue([
        { data: recurring, url: "/cal/personal/test-uid.ics", etag: '"old-etag"' },
      ]);

      await provider.updateEvent("/cal/personal/", "/cal/personal/test-uid.ics", {
        summary: "Renamed",
      });

      expect(mockUpdateCalendarObject).toHaveBeenCalledWith({
        calendarObject: expect.objectContaining({
          data: expect.stringContaining("RRULE:FREQ=MONTHLY;BYDAY=3TH"),
        }),
      });
    });

    it("removes the rule when the repetition is switched off", async () => {
      const recurring = MOCK_ICAL_DATA.replace(
        "DTEND:20240101T110000Z",
        "DTEND:20240101T110000Z\r\nRRULE:FREQ=WEEKLY",
      );
      mockFetchCalendarObjects.mockResolvedValue([
        { data: recurring, url: "/cal/personal/test-uid.ics", etag: '"old-etag"' },
      ]);

      await provider.updateEvent("/cal/personal/", "/cal/personal/test-uid.ics", {
        recurrence: null,
      });

      const written = mockUpdateCalendarObject.mock.calls[0]?.[0].calendarObject.data as string;
      expect(written).not.toContain("RRULE");
    });
  });

  describe("updateEvent on a recurring series", () => {
    const RECURRING = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Vienna",
      "BEGIN:STANDARD",
      "DTSTART:19961027T030000",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:series-uid",
      "SUMMARY:Weekly",
      "DTSTART:20260105T090000Z",
      "DTEND:20260105T100000Z",
      "RRULE:FREQ=WEEKLY;COUNT=6",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const JAN_5 = Math.floor(Date.parse("2026-01-05T09:00:00Z") / 1000);
    const JAN_12 = Math.floor(Date.parse("2026-01-12T09:00:00Z") / 1000);

    const written = () =>
      (mockUpdateCalendarObject.mock.calls[0]?.[0] as { calendarObject: { data: string } })
        .calendarObject.data;

    beforeEach(() => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: RECURRING, url: "/cal/personal/series-uid.ics", etag: '"old-etag"' },
      ]);
    });

    it("preserves the rule, zone and alarm when the whole series changes", async () => {
      // Regenerating the VEVENT from the edited fields used to drop all three.
      await provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/series-uid.ics",
        { summary: "Renamed" },
        '"old-etag"',
        { recurrenceId: JAN_12, scope: "all" },
      );

      const data = written();
      expect(data).toContain("RRULE:FREQ=WEEKLY;COUNT=6");
      expect(data).toContain("BEGIN:VTIMEZONE");
      expect(data).toContain("BEGIN:VALARM");
      expect(data).toContain("SUMMARY:Renamed");
    });

    it("adds a RECURRENCE-ID override when only one instance changes", async () => {
      await provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/series-uid.ics",
        { summary: "Just this week" },
        '"old-etag"',
        { recurrenceId: JAN_12, scope: "this" },
      );

      const data = written();
      expect(data).toContain("RECURRENCE-ID:20260112T090000Z");
      expect(data).toContain("SUMMARY:Just this week");
      // The master keeps its own title and rule.
      expect(data).toContain("SUMMARY:Weekly");
      expect(data).toContain("RRULE:FREQ=WEEKLY;COUNT=6");
    });

    describe("when all events are edited from a later instance", () => {
      const JAN_19 = Math.floor(Date.parse("2026-01-19T09:00:00Z") / 1000);
      const iso = (epoch: number) => new Date(epoch * 1000).toISOString();
      const editAll = (start: number, end: number) =>
        provider.updateEvent(
          "/cal/personal/",
          "/cal/personal/series-uid.ics",
          { summary: "Renamed", startTime: iso(start), endTime: iso(end) },
          '"old-etag"',
          { recurrenceId: JAN_19, scope: "all" },
        );

      it("keeps the series start when the instance's own times come along", async () => {
        // Writing the third instance's times as DTSTART dropped the first two.
        await editAll(JAN_19, JAN_19 + 3600);

        const data = written();
        expect(data).toContain("DTSTART:20260105T090000Z");
        expect(data).toContain("DTEND:20260105T100000Z");
        expect(data).toContain("SUMMARY:Renamed");
      });

      it("moves the series start by the change made to the instance", async () => {
        await editAll(JAN_19 + 3600, JAN_19 + 3 * 3600);

        const data = written();
        expect(data).toContain("DTSTART:20260105T100000Z");
        expect(data).toContain("DTEND:20260105T120000Z");
      });

      it("measures the change from a moved instance's own time", async () => {
        // The third instance was moved to 14:00; the dialog shows that, so
        // 15:00 means one hour later, not six.
        const MOVED = RECURRING.replace("END:VCALENDAR", [
          "BEGIN:VEVENT",
          "UID:series-uid",
          "RECURRENCE-ID:20260119T090000Z",
          "DTSTART:20260119T140000Z",
          "DTEND:20260119T150000Z",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"));
        mockFetchCalendarObjects.mockResolvedValue([
          { data: MOVED, url: "/cal/personal/series-uid.ics", etag: '"old-etag"' },
        ]);
        const AT_15 = JAN_19 + 6 * 3600;

        await editAll(AT_15, AT_15 + 3600);

        expect(written()).toContain("DTSTART:20260105T100000Z");
      });

      it("shifts in wall-clock time when the move crosses a DST change", async () => {
        const BERLIN = RECURRING
          .replace("DTSTART:20260105T090000Z", "DTSTART;TZID=Europe/Berlin:20260323T180000")
          .replace("DTEND:20260105T100000Z", "DTEND;TZID=Europe/Berlin:20260323T190000");
        mockFetchCalendarObjects.mockResolvedValue([
          { data: BERLIN, url: "/cal/personal/series-uid.ics", etag: '"old-etag"' },
        ]);
        // 30 March 18:00 CEST moved to 28 March 18:00 CET: two days on the clock,
        // two days and one hour in absolute time.
        const MAR_30 = Math.floor(Date.parse("2026-03-30T16:00:00Z") / 1000);
        const MAR_28 = Math.floor(Date.parse("2026-03-28T17:00:00Z") / 1000);

        await provider.updateEvent(
          "/cal/personal/",
          "/cal/personal/series-uid.ics",
          { startTime: iso(MAR_28), endTime: iso(MAR_28 + 3600) },
          '"old-etag"',
          { recurrenceId: MAR_30, scope: "all" },
        );

        const data = written();
        expect(data).toContain("DTSTART;TZID=Europe/Berlin:20260321T180000");
        expect(data).toContain("DTEND;TZID=Europe/Berlin:20260321T190000");
      });
    });

    it("sends the etag so a concurrent change is not overwritten", async () => {
      await provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/series-uid.ics",
        { summary: "x" },
        '"old-etag"',
        { recurrenceId: JAN_12, scope: "this" },
      );

      expect(mockUpdateCalendarObject).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarObject: expect.objectContaining({ etag: '"old-etag"' }),
        }),
      );
    });

    it("splits the series into two objects for this-and-following", async () => {
      await provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/series-uid.ics",
        { summary: "From now on" },
        '"old-etag"',
        { recurrenceId: JAN_12, scope: "thisAndFollowing" },
      );

      // The original is bounded in place...
      const head = written();
      expect(head).toContain("UNTIL=");
      expect(head).not.toContain("COUNT=6");

      // ...and the remainder is stored as a new object with its own UID.
      expect(mockCreateCalendarObject).toHaveBeenCalledTimes(1);
      const created = mockCreateCalendarObject.mock.calls[0]?.[0] as {
        filename: string;
        iCalString: string;
      };
      expect(created.iCalString).toContain("SUMMARY:From now on");
      expect(created.iCalString).toContain("DTSTART:20260112T090000Z");
      expect(created.iCalString).not.toContain("UID:series-uid");
      expect(created.filename).toMatch(/\.ics$/);
    });

    /**
     * The split writes two objects. Neither half may be left standing on its
     * own: a stored tail without a bounded head shows the series twice, a
     * bounded head without a tail loses every instance from the split point on.
     */
    describe("when half of a split fails", () => {
      beforeEach(() => {
        vi.spyOn(crypto, "randomUUID").mockReturnValue(
          "tail-uuid" as `${string}-${string}-${string}-${string}-${string}`,
        );
      });

      const split = () =>
        provider.updateEvent(
          "/cal/personal/",
          "/cal/personal/series-uid.ics",
          { summary: "From now on" },
          '"old-etag"',
          { recurrenceId: JAN_12, scope: "thisAndFollowing" },
        );

      it("leaves the original series untouched when the new half cannot be stored", async () => {
        mockCreateCalendarObject.mockResolvedValueOnce(davResponse(507, "Insufficient Storage"));

        await expect(split()).rejects.toMatchObject({ status: 507 });
        expect(mockUpdateCalendarObject).not.toHaveBeenCalled();
      });

      it("removes the new half when the original cannot be bounded", async () => {
        mockUpdateCalendarObject.mockResolvedValueOnce(davResponse(412, "Precondition Failed"));

        await expect(split()).rejects.toMatchObject({ status: 412 });
        expect(mockDeleteCalendarObject).toHaveBeenCalledWith({
          calendarObject: { url: "/cal/personal/tail-uuid.ics", etag: undefined },
        });
      });
    });

    it("deletes one instance by adding an EXDATE rather than the object", async () => {
      await provider.deleteEvent(
        "/cal/personal/",
        "/cal/personal/series-uid.ics",
        '"old-etag"',
        { recurrenceId: JAN_12, scope: "this" },
      );

      expect(mockDeleteCalendarObject).not.toHaveBeenCalled();
      expect(written()).toContain("EXDATE:20260112T090000Z");
    });

    it("ends the series in place for this-and-following deletes", async () => {
      await provider.deleteEvent(
        "/cal/personal/",
        "/cal/personal/series-uid.ics",
        '"old-etag"',
        { recurrenceId: JAN_12, scope: "thisAndFollowing" },
      );

      expect(mockDeleteCalendarObject).not.toHaveBeenCalled();
      expect(written()).toContain("UNTIL=");
    });

    it("removes the whole object only when the scope is the entire series", async () => {
      await provider.deleteEvent(
        "/cal/personal/",
        "/cal/personal/series-uid.ics",
        '"old-etag"',
        { recurrenceId: JAN_12, scope: "all" },
      );

      expect(mockDeleteCalendarObject).toHaveBeenCalledTimes(1);
      expect(mockUpdateCalendarObject).not.toHaveBeenCalled();
    });

    /**
     * Cutting a series before its very first instance leaves a rule that
     * produces nothing — an object no view can show and no instance can be
     * clicked to remove again. Nothing is left to keep, so the object goes.
     */
    describe("when the cut lands on the first instance", () => {
      it("deletes the object rather than emptying the series", async () => {
        const result = await provider.deleteEvent(
          "/cal/personal/",
          "/cal/personal/series-uid.ics",
          '"old-etag"',
          { recurrenceId: JAN_5, scope: "thisAndFollowing" },
        );

        expect(mockUpdateCalendarObject).not.toHaveBeenCalled();
        expect(mockDeleteCalendarObject).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ objectRemoved: true });
      });

      it("reports that the object survives an ordinary tail cut", async () => {
        const result = await provider.deleteEvent(
          "/cal/personal/",
          "/cal/personal/series-uid.ics",
          '"old-etag"',
          { recurrenceId: JAN_12, scope: "thisAndFollowing" },
        );

        expect(result).toEqual({ objectRemoved: false });
      });

      it("edits the master instead of splitting off a headless half", async () => {
        await provider.updateEvent(
          "/cal/personal/",
          "/cal/personal/series-uid.ics",
          { summary: "Renamed after all" },
          '"old-etag"',
          { recurrenceId: JAN_5, scope: "thisAndFollowing" },
        );

        expect(mockCreateCalendarObject).not.toHaveBeenCalled();
        expect(written()).toContain("SUMMARY:Renamed after all");
        expect(written()).toContain("RRULE:FREQ=WEEKLY;COUNT=6");
      });
    });
  });

  describe("deleteEvent", () => {
    it("calls deleteCalendarObject with etag", async () => {
      await provider.deleteEvent("/cal/personal/", "/cal/personal/test-uid.ics", '"delete-etag"');

      expect(mockDeleteCalendarObject).toHaveBeenCalledWith({
        calendarObject: {
          url: "/cal/personal/test-uid.ics",
          etag: '"delete-etag"',
        },
      });
    });

    it("counts an event the server no longer has as removed", async () => {
      mockDeleteCalendarObject.mockResolvedValueOnce(davResponse(404, "Not Found"));

      await expect(
        provider.deleteEvent("/cal/personal/", "/cal/personal/test-uid.ics", '"e"'),
      ).resolves.toEqual({ objectRemoved: true });
    });

    it("calls deleteCalendarObject without etag when not provided", async () => {
      await provider.deleteEvent("/cal/personal/", "/cal/personal/test-uid.ics");

      expect(mockDeleteCalendarObject).toHaveBeenCalledWith({
        calendarObject: {
          url: "/cal/personal/test-uid.ics",
          etag: undefined,
        },
      });
    });
  });

  /**
   * tsdav returns the raw response and never throws on an error status, so a
   * refused write used to reach the UI as a success.
   */
  describe("writes the server refuses", () => {
    beforeEach(() => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"old-etag"' },
      ]);
    });

    it("reports a failed update as a conflict when the etag no longer matches", async () => {
      mockUpdateCalendarObject.mockResolvedValueOnce(davResponse(412, "Precondition Failed"));

      const failure = provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/test-uid.ics",
        { summary: "Updated Event" },
        '"stale-etag"',
      );

      await expect(failure).rejects.toBeInstanceOf(CalendarWriteError);
      await expect(failure).rejects.toMatchObject({ status: 412, isConflict: true });
    });

    it("throws on any other error status", async () => {
      mockUpdateCalendarObject.mockResolvedValueOnce(davResponse(401, "Unauthorized"));

      await expect(
        provider.updateEvent("/cal/personal/", "/cal/personal/test-uid.ics", { summary: "x" }),
      ).rejects.toMatchObject({ status: 401, isConflict: false });
    });

    it("throws when creating an event fails", async () => {
      mockCreateCalendarObject.mockResolvedValueOnce(davResponse(507, "Insufficient Storage"));

      await expect(
        provider.createEvent("/cal/personal/", {
          summary: "New Meeting",
          startTime: "2024-03-15T09:00:00Z",
          endTime: "2024-03-15T10:00:00Z",
        }),
      ).rejects.toMatchObject({ status: 507 });
    });

    it("throws when deleting fails", async () => {
      mockDeleteCalendarObject.mockResolvedValueOnce(davResponse(412, "Precondition Failed"));

      await expect(
        provider.deleteEvent("/cal/personal/", "/cal/personal/test-uid.ics", '"stale-etag"'),
      ).rejects.toMatchObject({ status: 412, isConflict: true });
    });
  });

  /**
   * tsdav merges the per-call parameters over the client's defaults one level
   * deep, so a `headers` argument replaces the authorization header rather than
   * adding to it — every PUT and DELETE then comes back 401. If-Match has to
   * come from the calendar object's etag instead.
   */
  describe("authorization on write requests", () => {
    it("leaves If-Match to tsdav rather than passing headers", async () => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"old-etag"' },
      ]);

      await provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/test-uid.ics",
        { summary: "Updated Event" },
        '"old-etag"',
      );

      const params = mockUpdateCalendarObject.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(params).not.toHaveProperty("headers");
      expect(params.calendarObject).toMatchObject({ etag: '"old-etag"' });
    });

    it("passes no headers on delete either", async () => {
      await provider.deleteEvent("/cal/personal/", "/cal/personal/test-uid.ics", '"delete-etag"');

      const params = mockDeleteCalendarObject.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(params).not.toHaveProperty("headers");
    });

    it("loses the auth header in tsdav when headers are passed", async () => {
      // The reason for the two tests above, checked against the real library so
      // an upgrade that changes the merge does not go unnoticed.
      const { DAVClient: RealDAVClient } = await vi.importActual<typeof import("tsdav")>("tsdav");
      const sent: HeadersInit[] = [];
      const stubFetch = (_url: string, init?: RequestInit) => {
        sent.push(init?.headers ?? {});
        return Promise.resolve(new Response(null, { status: 204 }));
      };

      const client = new RealDAVClient({
        serverUrl: "https://caldav.example.com",
        credentials: { username: "user@example.com", password: "secret" },
        authMethod: "Basic",
        fetch: stubFetch as unknown as typeof fetch,
      });
      // Skip login(), which would talk to the network; it only sets these.
      (client as unknown as { authHeaders: Record<string, string> }).authHeaders = {
        authorization: "Basic dXNlckBleGFtcGxlLmNvbTpzZWNyZXQ=",
      };

      const calendarObject = { url: "https://caldav.example.com/e.ics", data: "x", etag: '"e"' };
      await client.updateCalendarObject({ calendarObject, headers: { "If-Match": '"e"' } });
      await client.updateCalendarObject({ calendarObject });

      expect(sent[0]).not.toHaveProperty("authorization");
      expect(sent[1]).toHaveProperty("authorization");
      expect(sent[1]).toMatchObject({ "If-Match": '"e"' });
    });
  });

  describe("syncEvents", () => {
    it("fetches all objects in time range and returns them as created events", async () => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"sync-etag"' },
        { data: MOCK_ICAL_DATA_2, url: "/cal/personal/test-uid-2.ics", etag: '"sync-etag-2"' },
      ]);

      const result = await provider.syncEvents("/cal/personal/");

      expect(mockFetchCalendarObjects).toHaveBeenCalledWith({
        calendar: { url: "/cal/personal/" },
        timeRange: {
          start: expect.any(String),
          end: expect.any(String),
        },
      });

      expect(result.created).toHaveLength(2);
      expect(result.created[0]!.summary).toBe("Test Event");
      expect(result.created[0]!.etag).toBe('"sync-etag"');
      expect(result.created[1]!.summary).toBe("Second Event");
      expect(result.updated).toEqual([]);
      expect(result.deletedRemoteIds).toEqual([]);
      expect(result.newSyncToken).toBeNull();
      expect(result.newCtag).toBeNull();
      // A time-range fetch lists everything in the range, so it can tell deletions.
      expect(result.window).toEqual({ start: expect.any(Number), end: expect.any(Number) });
    });
  });

  describe("syncEvents and incomplete listings", () => {
    it("claims no complete listing when an object came back without its data", async () => {
      // Its stored row would otherwise be taken for deleted on the server.
      mockFetchCalendarObjects.mockResolvedValue([
        { data: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"a"' },
        { data: undefined, url: "/cal/personal/other.ics", etag: '"b"' },
      ]);

      const result = await provider.syncEvents("/cal/personal/");

      expect(result.created).toHaveLength(1);
      expect(result.window).toBeUndefined();
    });
  });

  describe("testConnection", () => {
    it("returns success with calendar count on successful connection", async () => {
      mockFetchCalendars.mockResolvedValue([
        { url: "/cal/personal/", displayName: "Personal" },
        { url: "/cal/work/", displayName: "Work" },
      ]);

      const result = await provider.testConnection();

      expect(result).toEqual({
        success: true,
        message: "Connected — found 2 calendars",
      });
    });

    it("returns singular form for one calendar", async () => {
      mockFetchCalendars.mockResolvedValue([
        { url: "/cal/personal/", displayName: "Personal" },
      ]);

      const result = await provider.testConnection();

      expect(result.message).toBe("Connected — found 1 calendar");
    });

    it("resets client and returns error message on failure", async () => {
      mockLogin.mockRejectedValueOnce(new Error("Authentication failed"));
      // Need a fresh provider so getClient() will attempt login again
      const freshProvider = new CalDAVProvider("acc-1");

      const result = await freshProvider.testConnection();

      expect(result).toEqual({
        success: false,
        message: "Authentication failed",
      });

      // Verify client was reset by confirming a second call attempts login again
      mockLogin.mockResolvedValueOnce(undefined);
      mockFetchCalendars.mockResolvedValue([]);
      const retryResult = await freshProvider.testConnection();
      expect(retryResult.success).toBe(true);
      expect(mockLogin).toHaveBeenCalledTimes(2); // initial fail + retry after client reset
    });

    it("handles non-Error thrown values gracefully", async () => {
      mockLogin.mockRejectedValueOnce("some string error");
      const freshProvider = new CalDAVProvider("acc-1");

      const result = await freshProvider.testConnection();

      expect(result).toEqual({
        success: false,
        message: "Connection failed",
      });
    });
  });
});
