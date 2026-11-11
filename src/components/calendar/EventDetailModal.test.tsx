import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { EventDetailModal } from "./EventDetailModal";
import { CalendarWriteError } from "@/services/calendar/errors";
import type { CalendarOccurrence } from "@/services/calendar/occurrences";
import type { DbCalendar } from "@/services/db/calendars";

const mockUpdateEvent = vi.fn();
const mockDeleteEvent = vi.fn();
const mockDeleteCalendarEventDb = vi.fn();

vi.mock("@/services/calendar/providerFactory", () => ({
  getCalendarProvider: vi.fn(async () => ({
    updateEvent: mockUpdateEvent,
    deleteEvent: mockDeleteEvent,
  })),
}));

vi.mock("@/services/db/calendarEvents", () => ({
  deleteCalendarEvent: (...args: unknown[]) => mockDeleteCalendarEventDb(...args),
}));

const CALENDAR: DbCalendar = {
  id: "cal-1",
  account_id: "acc-1",
  provider: "caldav",
  remote_id: "/cal/personal/",
  display_name: "Personal",
  color: null,
  is_primary: 1,
  is_visible: 1,
  sync_token: null,
  ctag: null,
  created_at: 0,
  updated_at: 0,
};

const JAN_5 = Math.floor(Date.parse("2026-01-05T09:00:00Z") / 1000);

function makeOccurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return {
    id: "row-1#" + JAN_5,
    account_id: "acc-1",
    google_event_id: "/cal/personal/series-uid.ics",
    summary: "Weekly",
    description: null,
    location: null,
    start_time: JAN_5,
    end_time: JAN_5 + 3600,
    is_all_day: 0,
    status: "confirmed",
    organizer_email: null,
    attendees_json: null,
    html_link: null,
    updated_at: 0,
    calendar_id: "cal-1",
    remote_event_id: "/cal/personal/series-uid.ics",
    etag: '"old-etag"',
    ical_data: null,
    uid: "series-uid",
    rrule: "FREQ=WEEKLY;COUNT=6",
    recurrence_end: null,
    masterId: "row-1",
    occurrenceId: JAN_5,
    isOverride: false,
    isSeriesInstance: true,
    ...overrides,
  };
}

function renderModal(event = makeOccurrence(), onUpdated = vi.fn()) {
  render(
    <EventDetailModal
      event={event}
      calendars={[CALENDAR]}
      accountId="acc-1"
      onClose={vi.fn()}
      onUpdated={onUpdated}
    />,
  );
  return { onUpdated };
}

describe("EventDetailModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateEvent.mockResolvedValue(undefined);
    mockDeleteEvent.mockResolvedValue({ objectRemoved: true });
  });

  describe("a write the server refuses", () => {
    it("reports a conflict instead of closing as if the save had worked", async () => {
      const { onUpdated } = renderModal();
      mockUpdateEvent.mockRejectedValueOnce(
        new CalendarWriteError("Saving the event failed: it changed on the server", 412),
      );

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      expect(await screen.findByText(/changed (elsewhere|on the server)/i)).toBeInTheDocument();
      expect(onUpdated).not.toHaveBeenCalled();
    });

    it("reports a failed delete", async () => {
      const { onUpdated } = renderModal();
      mockDeleteEvent.mockRejectedValueOnce(new CalendarWriteError("Deleting the event failed: 401", 401));

      fireEvent.click(screen.getByRole("button", { name: /delete/i }));
      fireEvent.click(screen.getByRole("button", { name: /all events in the series/i }));

      expect(await screen.findByText(/could not delete/i)).toBeInTheDocument();
      expect(onUpdated).not.toHaveBeenCalled();
      expect(mockDeleteCalendarEventDb).not.toHaveBeenCalled();
    });
  });

  describe("deleting part of a series", () => {
    it("keeps the stored row while the calendar object survives", async () => {
      mockDeleteEvent.mockResolvedValueOnce({ objectRemoved: false });
      const { onUpdated } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: /delete/i }));
      fireEvent.click(screen.getByRole("button", { name: /this and following events/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(mockDeleteCalendarEventDb).not.toHaveBeenCalled();
    });

    it("removes the stored row once the provider removed the object", async () => {
      // Cutting a series before its first instance leaves nothing behind, so
      // the provider deletes the whole object and the row has to follow.
      mockDeleteEvent.mockResolvedValueOnce({ objectRemoved: true });
      const { onUpdated } = renderModal();

      fireEvent.click(screen.getByRole("button", { name: /delete/i }));
      fireEvent.click(screen.getByRole("button", { name: /this and following events/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(mockDeleteCalendarEventDb).toHaveBeenCalledWith("row-1");
    });
  });

  describe("an all-day event", () => {
    const DEC_25 = new Date(2025, 11, 25).getTime() / 1000;
    const DEC_26 = new Date(2025, 11, 26).getTime() / 1000;

    /** One day long: the stored end is the exclusive boundary after it. */
    const allDay = (overrides: Partial<CalendarOccurrence> = {}) =>
      makeOccurrence({
        is_all_day: 1,
        start_time: DEC_25,
        end_time: DEC_26,
        rrule: null,
        isSeriesInstance: false,
        occurrenceId: null,
        ...overrides,
      });

    const savedUpdate = () => mockUpdateEvent.mock.calls[0]?.[2];

    it("says all day instead of naming a time", () => {
      renderModal(allDay());

      expect(screen.getByText("All day")).toBeInTheDocument();
      expect(screen.queryByText(/12:00 AM/i)).not.toBeInTheDocument();
    });

    it("asks for days rather than times", () => {
      renderModal(allDay());
      fireEvent.click(screen.getByRole("button", { name: /edit/i }));

      expect(screen.getByLabelText(/^start$/i)).toHaveAttribute("type", "date");
      expect(screen.getByLabelText(/^end$/i)).toHaveAttribute("type", "date");
    });

    it("shows the day the event ends on, not the boundary after it", () => {
      renderModal(allDay());
      fireEvent.click(screen.getByRole("button", { name: /edit/i }));

      expect(screen.getByLabelText(/^start$/i)).toHaveValue("2025-12-25");
      expect(screen.getByLabelText(/^end$/i)).toHaveValue("2025-12-25");
    });

    it("sends the day after the one that was picked", async () => {
      const { onUpdated } = renderModal(allDay());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.change(screen.getByLabelText(/^end$/i), { target: { value: "2025-12-27" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate()).toMatchObject({
        isAllDay: true,
        startTime: new Date(2025, 11, 25).toISOString(),
        endTime: new Date(2025, 11, 28).toISOString(),
      });
    });

    it("keeps the event all day when nothing about its dates was touched", async () => {
      // Without the flag the Google provider writes start.dateTime, which turns
      // the event into a timed one on the next save of any field at all.
      const { onUpdated } = renderModal(allDay());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate()).toMatchObject({
        isAllDay: true,
        startTime: new Date(2025, 11, 25).toISOString(),
        endTime: new Date(2025, 11, 26).toISOString(),
      });
    });

    it("does not offer to turn the event into a timed one", () => {
      // The stored CalDAV object dictates the value type of every date it
      // carries, so the switch could not be honoured there.
      renderModal(allDay());
      fireEvent.click(screen.getByRole("button", { name: /edit/i }));

      expect(screen.getByLabelText(/all day/i)).toBeDisabled();
      expect(screen.getByLabelText(/all day/i)).toBeChecked();
    });

    it("leaves a timed event with its times and says so", async () => {
      const { onUpdated } = renderModal(makeOccurrence({ isSeriesInstance: false, occurrenceId: null }));

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      expect(screen.getByLabelText(/^start$/i)).toHaveAttribute("type", "datetime-local");
      expect(screen.queryByLabelText(/all day/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate()).toMatchObject({
        isAllDay: false,
        startTime: new Date(JAN_5 * 1000).toISOString(),
        endTime: new Date((JAN_5 + 3600) * 1000).toISOString(),
      });
    });
  });

  describe("editing all events from a later occurrence", () => {
    const JAN_19 = JAN_5 + 14 * 86400;
    const third = () => makeOccurrence({
      id: "row-1#" + JAN_19,
      start_time: JAN_19,
      end_time: JAN_19 + 3600,
      occurrenceId: JAN_19,
    });
    const savedUpdate = () => mockUpdateEvent.mock.calls[0]?.[2];

    it("sends no times when only the title changed", async () => {
      // The dialog shows the clicked instance's times; sent for the whole
      // series they would move its start onto that instance.
      const { onUpdated } = renderModal(third());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.click(screen.getByRole("radio", { name: /all events/i }));
      fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate()).toMatchObject({ summary: "Renamed" });
      expect(savedUpdate()).not.toHaveProperty("startTime");
      expect(savedUpdate()).not.toHaveProperty("endTime");
    });

    it("sends the times once they were changed", async () => {
      const { onUpdated } = renderModal(third());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.click(screen.getByRole("radio", { name: /all events/i }));
      const later = toLocal(JAN_19 + 3600);
      fireEvent.change(screen.getByLabelText(/^start$/i), { target: { value: later } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate().startTime).toBe(new Date((JAN_19 + 3600) * 1000).toISOString());
      expect(mockUpdateEvent.mock.calls[0]?.[4]).toEqual({ recurrenceId: JAN_19, scope: "all" });
    });

    const toLocal = (epoch: number) => {
      const d = new Date(epoch * 1000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    };
  });

  describe("changing the repetition", () => {
    const SERIES_ICAL = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:series-uid",
      "DTSTART:20260105T090000Z",
      "DTEND:20260105T100000Z",
      "RRULE:FREQ=WEEKLY;COUNT=6",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const withIcal = (overrides = {}) =>
      makeOccurrence({ ical_data: SERIES_ICAL, ...overrides });

    /** The last argument of the update call the modal made, minus the scope. */
    const savedUpdate = () => mockUpdateEvent.mock.calls[0]?.[2];

    it("sends nothing about the rule when only the title changed", async () => {
      // Resending the rule on every save would clear the exceptions and
      // per-instance changes the series carries.
      const { onUpdated } = renderModal(withIcal());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate()).not.toHaveProperty("recurrence");
    });

    it("seeds the control from the stored rule", () => {
      renderModal(withIcal());
      fireEvent.click(screen.getByRole("button", { name: /edit/i }));

      expect(screen.getByLabelText(/^repeat$/i)).toHaveValue("weekly");
      expect(screen.getByLabelText(/number of times/i)).toHaveValue(6);
    });

    it("sends the new rule once the control is touched", async () => {
      const { onUpdated } = renderModal(withIcal());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      // "All events in the series" — a rule belongs to the series, not to one
      // instance of it.
      fireEvent.click(screen.getByRole("radio", { name: /all events/i }));
      fireEvent.change(screen.getByLabelText(/^repeat$/i), { target: { value: "monthly" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate().recurrence).toMatchObject({ frequency: "monthly" });
    });

    it("removes the repetition when it is switched off", async () => {
      const { onUpdated } = renderModal(withIcal());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.click(screen.getByRole("radio", { name: /all events/i }));
      fireEvent.change(screen.getByLabelText(/^repeat$/i), { target: { value: "none" } });
      fireEvent.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate().recurrence).toBeNull();
    });

    it("does not rewrite the rule while a single occurrence is the target", async () => {
      // "This event" writes an override, and an override cannot carry a rule.
      const { onUpdated } = renderModal(withIcal());

      fireEvent.click(screen.getByRole("button", { name: /edit/i }));
      fireEvent.change(screen.getByLabelText(/^repeat$/i), { target: { value: "monthly" } });

      expect(screen.getByText(/repetition belongs to the whole series/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /save/i }));
      await waitFor(() => expect(onUpdated).toHaveBeenCalled());
      expect(savedUpdate()).not.toHaveProperty("recurrence");
    });

    it("shows a rule it cannot state without offering to edit it", () => {
      renderModal(withIcal({
        rrule: "FREQ=MONTHLY;BYDAY=3TH",
        ical_data: SERIES_ICAL.replace("FREQ=WEEKLY;COUNT=6", "FREQ=MONTHLY;BYDAY=3TH"),
      }));
      fireEvent.click(screen.getByRole("button", { name: /edit/i }));

      expect(screen.getByText(/kept as it is/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/^repeat$/i)).not.toBeInTheDocument();
    });

    it("offers no repeat control where the calendar object is out of reach", () => {
      // Google expands its series server side and sends single instances with
      // no iCalendar data behind them, so there is nothing here to patch.
      renderModal(makeOccurrence({ ical_data: null, rrule: null, isSeriesInstance: false }));
      fireEvent.click(screen.getByRole("button", { name: /edit/i }));

      expect(screen.queryByLabelText(/^repeat$/i)).not.toBeInTheDocument();
    });
  });
});
