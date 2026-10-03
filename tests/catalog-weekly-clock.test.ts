import { describe, expect, it } from "vitest";
import {
  catalogTimeZone,
  defaultWeeklySlot,
  weeklyOccurrenceAtOrBefore,
  weeklyOccurrenceAfter,
  coalesceWeeklyOccurrences,
} from "../packages/database/src/catalog-weekly-clock.js";

describe("weekly catalogue clock, without scheduling or source requests", () => {
  it("uses the São Paulo calendar week and waits until Monday at 08:00", () => {
    expect(catalogTimeZone).toBe("America/Sao_Paulo");
    expect(defaultWeeklySlot).toEqual({ weekday: 1, hour: 8, minute: 0 });
    const before = new Date("2030-01-07T10:59:59.999Z");
    expect(weeklyOccurrenceAtOrBefore(before).localDate).toBe("2029-12-31");
    expect(weeklyOccurrenceAfter(before).scheduledAt.toISOString()).toBe("2030-01-07T11:00:00.000Z");
    expect(weeklyOccurrenceAtOrBefore(new Date("2030-01-07T11:00:00Z")).localDate).toBe("2030-01-07");
    expect(weeklyOccurrenceAfter(new Date("2030-01-07T11:00:00Z")).localDate).toBe("2030-01-14");
  });
  it("does not use UTC midnight to change the local weekday", () => {
    expect(
      weeklyOccurrenceAtOrBefore(new Date("2030-01-07T01:00:00Z"), { weekday: 7, hour: 23, minute: 0 }).localDate,
    ).toBe("2029-12-30");
    expect(
      weeklyOccurrenceAfter(new Date("2030-01-07T01:00:00Z"), {
        weekday: 7,
        hour: 23,
        minute: 0,
      }).scheduledAt.toISOString(),
    ).toBe("2030-01-07T02:00:00.000Z");
  });
  it("consolidates offline weeks into a single latest occurrence and one next date", () => {
    expect(coalesceWeeklyOccurrences("2030-01-07", new Date("2030-01-07T10:59:59Z"))).toBeNull();
    const due = coalesceWeeklyOccurrences("2030-01-07", new Date("2030-02-04T11:00:00Z"))!;
    expect(due).toMatchObject({ localDate: "2030-02-04", firstDueLocalDate: "2030-01-07", coalescedWeeks: 4 });
    expect(due.next.localDate).toBe("2030-02-11");
    expect(coalesceWeeklyOccurrences(due.next.localDate, new Date("2030-02-04T11:00:00Z"))).toBeNull();
  });
  it("resolves a historical skipped minute with a declared shift", () => {
    const occurrence = weeklyOccurrenceAtOrBefore(new Date("2018-11-04T03:00:00Z"), { weekday: 7, hour: 0, minute: 0 });
    expect(occurrence).toMatchObject({ localDate: "2018-11-04", shiftedMinutes: 60 });
    expect(occurrence.scheduledAt.toISOString()).toBe("2018-11-04T03:00:00.000Z");
  });
  it("uses only the first instant of a repeated wall-clock minute", () => {
    const slot = { weekday: 6, hour: 23, minute: 30 };
    const occurrence = weeklyOccurrenceAtOrBefore(new Date("2019-02-17T02:30:00Z"), slot);
    expect(occurrence.localDate).toBe("2019-02-16");
    expect(occurrence.scheduledAt.toISOString()).toBe("2019-02-17T01:30:00.000Z");
    expect(weeklyOccurrenceAfter(new Date("2019-02-17T01:30:00Z"), slot).localDate).toBe("2019-02-23");
  });
  it("advances local weeks rather than adding a fixed 168 UTC hours across an offset change", () => {
    const next = weeklyOccurrenceAfter(new Date("2018-10-29T11:00:00Z"));
    expect(next.localDate).toBe("2018-11-05");
    expect(next.scheduledAt.toISOString()).toBe("2018-11-05T10:00:00.000Z");
  });
  it("rejects malformed times, dates, weekday mismatches and invalid clocks", () => {
    for (const slot of [
      { weekday: 0, hour: 8, minute: 0 },
      { weekday: 8, hour: 8, minute: 0 },
      { weekday: 1, hour: 24, minute: 0 },
      { weekday: 1, hour: 8, minute: 60 },
      { weekday: 1.5, hour: 8, minute: 0 },
    ])
      expect(() => weeklyOccurrenceAfter(new Date("2030-01-07T11:00:00Z"), slot)).toThrow(
        "weekly_schedule_time_invalid",
      );
    for (const value of ["2030-02-30", "2030-01-08", "2030-1-7", ""])
      expect(() => coalesceWeeklyOccurrences(value, new Date("2030-02-04T11:00:00Z"))).toThrow(
        "weekly_schedule_date_invalid",
      );
    expect(() => weeklyOccurrenceAfter(new Date("invalid"))).toThrow("weekly_schedule_time_invalid");
  });
});
