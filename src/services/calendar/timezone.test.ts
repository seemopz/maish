import { buildVTimezone } from "./timezone";

describe("buildVTimezone", () => {
  it("states a central European zone as two yearly last-Sunday rules", () => {
    expect(buildVTimezone("Europe/Berlin", 2025)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "BEGIN:DAYLIGHT",
      "DTSTART:20250330T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:20251026T030000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("states a US zone with its second and first Sunday rules", () => {
    expect(buildVTimezone("America/New_York", 2025)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:DAYLIGHT",
      "DTSTART:20250309T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:20251102T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("puts a southern zone's daylight time at the end of the year", () => {
    expect(buildVTimezone("Australia/Sydney", 2025)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Australia/Sydney",
      "BEGIN:STANDARD",
      "DTSTART:20250406T030000",
      "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU",
      "TZOFFSETFROM:+1100",
      "TZOFFSETTO:+1000",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:20251005T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU",
      "TZOFFSETFROM:+1000",
      "TZOFFSETTO:+1100",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
    ]);
  });

  it("writes half-hour offsets", () => {
    const lines = buildVTimezone("Australia/Adelaide", 2025);
    expect(lines).toContain("TZOFFSETFROM:+1030");
    expect(lines).toContain("TZOFFSETTO:+0930");
  });

  it("gives a zone without daylight saving a single standard observance", () => {
    expect(buildVTimezone("Asia/Kolkata", 2025)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Kolkata",
      "BEGIN:STANDARD",
      "DTSTART:20250101T000000",
      "TZOFFSETFROM:+0530",
      "TZOFFSETTO:+0530",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("refuses a zone whose changes follow no yearly weekday rule", () => {
    // Morocco suspends its offset for Ramadan, which moves through the year.
    expect(buildVTimezone("Africa/Casablanca", 2025)).toBeNull();
  });

  it("refuses a zone the runtime does not know", () => {
    expect(buildVTimezone("W. Europe Standard Time", 2025)).toBeNull();
  });
});
