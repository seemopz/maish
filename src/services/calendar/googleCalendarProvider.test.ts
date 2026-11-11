import { GoogleCalendarProvider } from "./googleCalendarProvider";
import { getGmailClient } from "@/services/gmail/tokenManager";

vi.mock("@/services/gmail/tokenManager", () => ({
  getGmailClient: vi.fn(),
}));

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

function createMockClient() {
  return { request: vi.fn() };
}

describe("GoogleCalendarProvider", () => {
  const accountId = "test-account-1";
  let provider: GoogleCalendarProvider;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.mocked(getGmailClient).mockResolvedValue(mockClient as never);
    provider = new GoogleCalendarProvider(accountId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("listCalendars", () => {
    it("maps Google API response to CalendarInfo array", async () => {
      mockClient.request.mockResolvedValue({
        items: [
          { id: "primary", summary: "My Calendar", backgroundColor: "#0000ff", primary: true },
          { id: "work@example.com", summary: "Work", accessRole: "owner" },
        ],
      });

      const result = await provider.listCalendars();

      expect(mockClient.request).toHaveBeenCalledWith(
        `${CALENDAR_API_BASE}/users/me/calendarList`,
      );
      expect(result).toEqual([
        { remoteId: "primary", displayName: "My Calendar", color: "#0000ff", isPrimary: true },
        { remoteId: "work@example.com", displayName: "Work", color: null, isPrimary: false },
      ]);
    });

    it("returns empty array when no items", async () => {
      mockClient.request.mockResolvedValue({});

      const result = await provider.listCalendars();

      expect(result).toEqual([]);
    });
  });

  describe("fetchEvents", () => {
    it("passes correct URL params and maps events", async () => {
      const googleEvent = {
        id: "evt-1",
        summary: "Meeting",
        description: "Discuss plans",
        location: "Room A",
        start: { dateTime: "2025-06-15T10:00:00Z" },
        end: { dateTime: "2025-06-15T11:00:00Z" },
        status: "confirmed",
        organizer: { email: "org@example.com" },
        attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
        htmlLink: "https://calendar.google.com/event/evt-1",
        iCalUID: "uid-1@google.com",
        etag: '"etag-1"',
      };

      mockClient.request.mockResolvedValue({ items: [googleEvent] });

      const result = await provider.fetchEvents("cal-id", "2025-06-01T00:00:00Z", "2025-06-30T23:59:59Z");

      const calledUrl = mockClient.request.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/calendars/cal-id/events?");
      expect(calledUrl).toContain("timeMin=2025-06-01T00%3A00%3A00Z");
      expect(calledUrl).toContain("timeMax=2025-06-30T23%3A59%3A59Z");
      expect(calledUrl).toContain("singleEvents=true");
      expect(calledUrl).toContain("orderBy=startTime");
      expect(calledUrl).toContain("maxResults=250");

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        remoteEventId: "evt-1",
        summary: "Meeting",
        description: "Discuss plans",
        location: "Room A",
        isAllDay: false,
        status: "confirmed",
        organizerEmail: "org@example.com",
        htmlLink: "https://calendar.google.com/event/evt-1",
        uid: "uid-1@google.com",
        etag: '"etag-1"',
      });
      expect(result[0].startTime).toBe(Math.floor(new Date("2025-06-15T10:00:00Z").getTime() / 1000));
      expect(result[0].endTime).toBe(Math.floor(new Date("2025-06-15T11:00:00Z").getTime() / 1000));
    });

    it("reads an all-day event's end date as the exclusive boundary", async () => {
      // Google documents `end` as the exclusive end, so a single-day event on
      // the 25th arrives with end.date on the 26th.
      mockClient.request.mockResolvedValue({
        items: [
          {
            id: "allday-1",
            summary: "Holiday",
            start: { date: "2025-12-25" },
            end: { date: "2025-12-26" },
            status: "confirmed",
          },
        ],
      });

      const result = await provider.fetchEvents("cal-id", "2025-12-01T00:00:00Z", "2025-12-31T23:59:59Z");

      expect(result[0]!.isAllDay).toBe(true);
      expect(result[0]!.startTime).toBe(new Date(2025, 11, 25).getTime() / 1000);
      expect(result[0]!.endTime).toBe(new Date(2025, 11, 26).getTime() / 1000);
    });

    it("keeps a one-day all-day event off the following day", async () => {
      mockClient.request.mockResolvedValue({
        items: [
          {
            id: "allday-1",
            summary: "Holiday",
            start: { date: "2025-12-25" },
            end: { date: "2025-12-26" },
            status: "confirmed",
          },
        ],
      });

      const result = await provider.fetchEvents("cal-id", "2025-12-01T00:00:00Z", "2025-12-31T23:59:59Z");
      const event = result[0]!;

      // The half-open overlap test the calendar views bucket by.
      const coversDay = (day: number) => {
        const dayStart = new Date(2025, 11, day).getTime() / 1000;
        const dayEnd = new Date(2025, 11, day + 1).getTime() / 1000;
        return event.startTime < dayEnd && event.endTime > dayStart;
      };

      expect(coversDay(25)).toBe(true);
      expect(coversDay(26)).toBe(false);
    });

    it("encodes calendar ID in URL", async () => {
      mockClient.request.mockResolvedValue({ items: [] });

      await provider.fetchEvents("user@example.com", "2025-01-01T00:00:00Z", "2025-01-31T23:59:59Z");

      const calledUrl = mockClient.request.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/calendars/user%40example.com/events?");
    });
  });

  describe("createEvent", () => {
    it("sends POST with correct body and returns mapped event", async () => {
      const createdEvent = {
        id: "new-evt",
        summary: "Lunch",
        description: "Team lunch",
        location: "Cafe",
        start: { dateTime: "2025-06-20T12:00:00Z" },
        end: { dateTime: "2025-06-20T13:00:00Z" },
        status: "confirmed",
      };

      mockClient.request.mockResolvedValue(createdEvent);

      const result = await provider.createEvent("cal-1", {
        summary: "Lunch",
        description: "Team lunch",
        location: "Cafe",
        startTime: "2025-06-20T12:00:00Z",
        endTime: "2025-06-20T13:00:00Z",
      });

      const [url, options] = mockClient.request.mock.calls[0];
      expect(url).toBe(`${CALENDAR_API_BASE}/calendars/cal-1/events`);
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body as string);
      expect(body.summary).toBe("Lunch");
      expect(body.description).toBe("Team lunch");
      expect(body.location).toBe("Cafe");
      expect(body.start.dateTime).toBeDefined();
      expect(body.end.dateTime).toBeDefined();

      expect(result.remoteEventId).toBe("new-evt");
      expect(result.summary).toBe("Lunch");
    });

    it("creates all-day event with date-only start/end", async () => {
      mockClient.request.mockResolvedValue({
        id: "allday-evt",
        summary: "Holiday",
        start: { date: "2025-12-25" },
        end: { date: "2025-12-26" },
      });

      await provider.createEvent("cal-1", {
        summary: "Holiday",
        startTime: "2025-12-25T00:00:00Z",
        endTime: "2025-12-26T00:00:00Z",
        isAllDay: true,
      });

      const body = JSON.parse(mockClient.request.mock.calls[0][1].body as string);
      expect(body.start).toEqual({ date: "2025-12-25" });
      expect(body.end).toEqual({ date: "2025-12-26" });
    });

    it("includes attendees when provided", async () => {
      mockClient.request.mockResolvedValue({
        id: "evt-att",
        summary: "Sync",
        start: { dateTime: "2025-06-20T14:00:00Z" },
        end: { dateTime: "2025-06-20T15:00:00Z" },
      });

      await provider.createEvent("cal-1", {
        summary: "Sync",
        startTime: "2025-06-20T14:00:00Z",
        endTime: "2025-06-20T15:00:00Z",
        attendees: [{ email: "bob@example.com" }],
      });

      const body = JSON.parse(mockClient.request.mock.calls[0][1].body as string);
      expect(body.attendees).toEqual([{ email: "bob@example.com" }]);
    });
  });

  describe("updateEvent", () => {
    it("sends PATCH with partial body", async () => {
      mockClient.request.mockResolvedValue({
        id: "evt-1",
        summary: "Updated Title",
        start: { dateTime: "2025-06-20T12:00:00Z" },
        end: { dateTime: "2025-06-20T13:00:00Z" },
      });

      const result = await provider.updateEvent("cal-1", "evt-1", {
        summary: "Updated Title",
      });

      const [url, options] = mockClient.request.mock.calls[0];
      expect(url).toBe(`${CALENDAR_API_BASE}/calendars/cal-1/events/evt-1`);
      expect(options.method).toBe("PATCH");

      const body = JSON.parse(options.body as string);
      expect(body.summary).toBe("Updated Title");
      expect(body.description).toBeUndefined();
      expect(body.start).toBeUndefined();

      expect(result.remoteEventId).toBe("evt-1");
      expect(result.summary).toBe("Updated Title");
    });

    it("includes time fields when both startTime and endTime are provided", async () => {
      mockClient.request.mockResolvedValue({
        id: "evt-1",
        summary: "Rescheduled",
        start: { dateTime: "2025-06-21T09:00:00Z" },
        end: { dateTime: "2025-06-21T10:00:00Z" },
      });

      await provider.updateEvent("cal-1", "evt-1", {
        startTime: "2025-06-21T09:00:00Z",
        endTime: "2025-06-21T10:00:00Z",
      });

      const body = JSON.parse(mockClient.request.mock.calls[0][1].body as string);
      expect(body.start.dateTime).toBeDefined();
      expect(body.end.dateTime).toBeDefined();
    });

    it("keeps an all-day event date-only when the flag is passed", async () => {
      // Left out, the dates below would be written as start.dateTime and the
      // event would quietly stop being an all-day one.
      mockClient.request.mockResolvedValue({
        id: "allday-evt",
        summary: "Holiday",
        start: { date: "2025-12-25" },
        end: { date: "2025-12-27" },
      });

      await provider.updateEvent("cal-1", "allday-evt", {
        startTime: "2025-12-25T00:00:00Z",
        endTime: "2025-12-27T00:00:00Z",
        isAllDay: true,
      });

      const body = JSON.parse(mockClient.request.mock.calls[0][1].body as string);
      expect(body.start).toEqual({ date: "2025-12-25" });
      expect(body.end).toEqual({ date: "2025-12-27" });
    });
  });

  describe("deleteEvent", () => {
    it("sends DELETE request with correct URL", async () => {
      mockClient.request.mockResolvedValue(undefined);

      await provider.deleteEvent("cal-1", "evt-1");

      const [url, options] = mockClient.request.mock.calls[0];
      expect(url).toBe(`${CALENDAR_API_BASE}/calendars/cal-1/events/evt-1`);
      expect(options.method).toBe("DELETE");
    });

    it("encodes calendar and event IDs", async () => {
      mockClient.request.mockResolvedValue(undefined);

      await provider.deleteEvent("user@example.com", "evt/special");

      const calledUrl = mockClient.request.mock.calls[0][0] as string;
      expect(calledUrl).toContain("/calendars/user%40example.com/events/evt%2Fspecial");
    });
  });

  describe("syncEvents", () => {
    it("uses syncToken for incremental sync and handles cancelled events as deletions", async () => {
      mockClient.request.mockResolvedValue({
        items: [
          {
            id: "evt-updated",
            summary: "Updated Event",
            start: { dateTime: "2025-06-15T10:00:00Z" },
            end: { dateTime: "2025-06-15T11:00:00Z" },
            status: "confirmed",
          },
          {
            id: "evt-deleted",
            summary: undefined,
            start: { dateTime: "2025-06-15T10:00:00Z" },
            end: { dateTime: "2025-06-15T11:00:00Z" },
            status: "cancelled",
          },
        ],
        nextSyncToken: "new-sync-token-123",
      });

      const result = await provider.syncEvents("cal-1", "old-sync-token");

      const calledUrl = mockClient.request.mock.calls[0][0] as string;
      expect(calledUrl).toContain("syncToken=old-sync-token");
      expect(calledUrl).not.toContain("timeMin");
      // Google requires the initial query's parameters on every incremental
      // request; without it a series comes back as one master, not its instances.
      expect(calledUrl).toContain("singleEvents=true");
      // An incremental result says nothing about events it does not list.
      expect(result.window).toBeUndefined();

      expect(result.created).toHaveLength(1);
      expect(result.created[0].remoteEventId).toBe("evt-updated");
      expect(result.deletedRemoteIds).toEqual(["evt-deleted"]);
      expect(result.newSyncToken).toBe("new-sync-token-123");
      expect(result.newCtag).toBeNull();
    });

    it("sets time range for initial sync without syncToken", async () => {
      mockClient.request.mockResolvedValue({
        items: [],
        nextSyncToken: "initial-token",
      });

      const result = await provider.syncEvents("cal-1");

      const calledUrl = mockClient.request.mock.calls[0][0] as string;
      expect(calledUrl).toContain("timeMin=");
      expect(calledUrl).toContain("timeMax=");
      expect(calledUrl).toContain("singleEvents=true");
      expect(calledUrl).not.toContain("syncToken");

      expect(result.newSyncToken).toBe("initial-token");
    });

    it("falls back to a full sync that returns a fresh token when the sync token expired", async () => {
      mockClient.request
        .mockRejectedValueOnce(new Error("Gmail API error: 410 Gone"))
        .mockResolvedValueOnce({ items: [], nextSyncToken: "fresh-token" });

      const result = await provider.syncEvents("cal-1", "expired-token");

      expect(mockClient.request).toHaveBeenCalledTimes(2);
      const retryUrl = mockClient.request.mock.calls[1][0] as string;
      expect(retryUrl).not.toContain("syncToken");
      expect(retryUrl).toContain("timeMin=");
      expect(result.newSyncToken).toBe("fresh-token");
      // The full listing replaces what is stored, so deletions missed while the token was stale go too.
      expect(result.window).toEqual({ start: expect.any(Number), end: expect.any(Number) });
    });

    it("falls back to a full sync on an 'invalid sync token' error too", async () => {
      mockClient.request
        .mockRejectedValueOnce(new Error("Invalid sync token"))
        .mockResolvedValueOnce({ items: [], nextSyncToken: "fresh-token" });

      const result = await provider.syncEvents("cal-1", "bad-token");

      expect(result.newSyncToken).toBe("fresh-token");
    });

    it("gives up after one full-sync retry when the error persists", async () => {
      mockClient.request.mockRejectedValue(new Error("Gmail API error: 410 Gone"));

      await expect(provider.syncEvents("cal-1", "expired-token")).rejects.toThrow("410");
      expect(mockClient.request).toHaveBeenCalledTimes(2);
    });

    it("rethrows non-sync-token errors", async () => {
      mockClient.request.mockRejectedValue(new Error("Network error"));

      await expect(provider.syncEvents("cal-1", "token")).rejects.toThrow("Network error");
    });

    it("follows pagination with nextPageToken", async () => {
      mockClient.request
        .mockResolvedValueOnce({
          items: [
            { id: "evt-1", summary: "Page 1", start: { dateTime: "2025-06-15T10:00:00Z" }, end: { dateTime: "2025-06-15T11:00:00Z" } },
          ],
          nextPageToken: "page-2-token",
        })
        .mockResolvedValueOnce({
          items: [
            { id: "evt-2", summary: "Page 2", start: { dateTime: "2025-06-16T10:00:00Z" }, end: { dateTime: "2025-06-16T11:00:00Z" } },
          ],
          nextSyncToken: "final-sync-token",
        });

      const result = await provider.syncEvents("cal-1", "token");

      expect(mockClient.request).toHaveBeenCalledTimes(2);
      const secondUrl = mockClient.request.mock.calls[1][0] as string;
      expect(secondUrl).toContain("pageToken=page-2-token");

      expect(result.created).toHaveLength(2);
      expect(result.created[0].remoteEventId).toBe("evt-1");
      expect(result.created[1].remoteEventId).toBe("evt-2");
      expect(result.newSyncToken).toBe("final-sync-token");
    });
  });

  describe("testConnection", () => {
    it("returns success when listCalendars succeeds", async () => {
      mockClient.request.mockResolvedValue({ items: [] });

      const result = await provider.testConnection();

      expect(result).toEqual({ success: true, message: "Connected to Google Calendar" });
    });

    it("returns failure with error message on error", async () => {
      mockClient.request.mockRejectedValue(new Error("Unauthorized"));

      const result = await provider.testConnection();

      expect(result).toEqual({ success: false, message: "Unauthorized" });
    });

    it("returns generic failure message for non-Error throws", async () => {
      mockClient.request.mockRejectedValue("something went wrong");

      const result = await provider.testConnection();

      expect(result).toEqual({ success: false, message: "Connection failed" });
    });
  });
});
