/** Pure recurrence calculation. Does not enable a schedule, connect or enqueue. */
export const catalogTimeZone = "America/Sao_Paulo";
export type WeeklySlot = { weekday: number; hour: number; minute: number };
export const defaultWeeklySlot: WeeklySlot = { weekday: 1, hour: 8, minute: 0 };
const minuteMs = 60000;
const dayMs = 24 * 60 * minuteMs;
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: catalogTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
type WallTime = { year: number; month: number; day: number; hour: number; minute: number };
function wallTime(instant: number): WallTime {
  const fields = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
  };
}
function wallNumber(time: WallTime) {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);
}
function validateSlot(slot: WeeklySlot) {
  if (
    ![slot.weekday, slot.hour, slot.minute].every(Number.isInteger) ||
    slot.weekday < 1 ||
    slot.weekday > 7 ||
    slot.hour < 0 ||
    slot.hour > 23 ||
    slot.minute < 0 ||
    slot.minute > 59
  )
    throw Error("weekly_schedule_time_invalid");
}
function validateNow(now: Date) {
  if (!Number.isFinite(now.getTime()) || now.getUTCFullYear() < 1900 || now.getUTCFullYear() > 9998)
    throw Error("weekly_schedule_time_invalid");
}
function localDate(day: number) {
  return new Date(day).toISOString().slice(0, 10);
}
function parseDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error("weekly_schedule_date_invalid");
  const day = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(day) || localDate(day) !== value || new Date(day).getUTCFullYear() < 1900)
    throw Error("weekly_schedule_date_invalid");
  return day;
}
export type WeeklyOccurrence = {
  localDate: string;
  scheduledAt: Date;
  shiftedMinutes: number;
};
/** Resolve a nominal local day. In a gap, use its first available minute;
 * in a fold, use the earlier instant, so a repeated wall clock is one occurrence. */
function resolveOccurrence(day: number, slot: WeeklySlot): WeeklyOccurrence {
  const target = day + (slot.hour * 60 + slot.minute) * minuteMs;
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 12) {
    const instant = target + delta * 60 * minuteMs;
    offsets.add(wallNumber(wallTime(instant)) - instant);
  }
  for (let shiftedMinutes = 0; shiftedMinutes <= 180; shiftedMinutes++) {
    const wall = target + shiftedMinutes * minuteMs;
    // Do not silently move a nominal date to a different day.
    if (Math.floor(wall / dayMs) !== Math.floor(day / dayMs)) break;
    const candidates = [...offsets]
      .map((offset) => wall - offset)
      .filter((instant) => wallNumber(wallTime(instant)) === wall)
      .sort((a, b) => a - b);
    if (candidates.length) return { localDate: localDate(day), scheduledAt: new Date(candidates[0]!), shiftedMinutes };
  }
  throw Error("weekly_schedule_time_unresolvable");
}
export function weeklyOccurrenceAtOrBefore(now: Date, slot: WeeklySlot = defaultWeeklySlot): WeeklyOccurrence {
  validateNow(now);
  validateSlot(slot);
  const local = wallTime(now.getTime());
  const today = Date.UTC(local.year, local.month - 1, local.day);
  const weekday = new Date(today).getUTCDay() || 7;
  let day = today - ((weekday - slot.weekday + 7) % 7) * dayMs;
  let occurrence = resolveOccurrence(day, slot);
  if (occurrence.scheduledAt > now) {
    day -= 7 * dayMs;
    occurrence = resolveOccurrence(day, slot);
  }
  return occurrence;
}
export function weeklyOccurrenceAfter(now: Date, slot: WeeklySlot = defaultWeeklySlot): WeeklyOccurrence {
  const previous = weeklyOccurrenceAtOrBefore(now, slot);
  return resolveOccurrence(parseDay(previous.localDate) + 7 * dayMs, slot);
}
/** One coalesced due occurrence, never one task for every offline week.
 * The persisted next local date belongs to the same immutable slot revision. */
export function coalesceWeeklyOccurrences(nextLocalDate: string, now: Date, slot: WeeklySlot = defaultWeeklySlot) {
  validateNow(now);
  validateSlot(slot);
  const first = parseDay(nextLocalDate);
  if ((new Date(first).getUTCDay() || 7) !== slot.weekday) throw Error("weekly_schedule_date_invalid");
  if (resolveOccurrence(first, slot).scheduledAt > now) return null;
  const latest = weeklyOccurrenceAtOrBefore(now, slot);
  const weeks = (parseDay(latest.localDate) - first) / (7 * dayMs);
  if (!Number.isInteger(weeks) || weeks < 0) throw Error("weekly_schedule_date_invalid");
  return {
    ...latest,
    firstDueLocalDate: nextLocalDate,
    coalescedWeeks: weeks,
    next: resolveOccurrence(parseDay(latest.localDate) + 7 * dayMs, slot),
  };
}
