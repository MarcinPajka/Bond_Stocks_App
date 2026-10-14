// Dates are plain "YYYY-MM-DD" strings, handled in UTC to avoid timezone drift.

export type IsoDate = string;

export function parse(d: IsoDate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function format(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/** Same day N years later; 29 Feb falls back to 28 Feb. */
export function addYears(d: IsoDate, years: number): IsoDate {
  const src = parse(d);
  const y = src.getUTCFullYear() + years;
  const m = src.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(y, m, Math.min(src.getUTCDate(), lastDay))));
}

/** "YYYY-MM" of the month `months` before the month of `d`. */
export function monthBefore(d: IsoDate, months: number): string {
  const src = parse(d);
  const t = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth() - months, 1));
  return format(t).slice(0, 7);
}

export function today(): IsoDate {
  return format(new Date());
}

/** Same day N months later, capped at the end of the target month. */
export function addMonths(d: IsoDate, months: number): IsoDate {
  const src = parse(d);
  const y = src.getUTCFullYear();
  const m = src.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(y, m, Math.min(src.getUTCDate(), lastDay))));
}

export function addDays(d: IsoDate, days: number): IsoDate {
  return format(new Date(parse(d).getTime() + days * 86_400_000));
}

function easterSunday(year: number): IsoDate {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return format(new Date(Date.UTC(year, month - 1, day)));
}

/** Polish public holidays (dni ustawowo wolne od pracy). */
export function isPolishHoliday(d: IsoDate): boolean {
  const year = Number(d.slice(0, 4));
  const md = d.slice(5);
  const fixed = ["01-01", "01-06", "05-01", "05-03", "08-15", "11-01", "11-11", "12-25", "12-26"];
  if (year >= 2025) fixed.push("12-24");
  if (fixed.includes(md)) return true;
  const easter = easterSunday(year);
  return [easter, addDays(easter, 1), addDays(easter, 49), addDays(easter, 60)].includes(d);
}

export function isBusinessDay(d: IsoDate): boolean {
  const dow = parse(d).getUTCDay();
  return dow !== 0 && dow !== 6 && !isPolishHoliday(d);
}

/** The Nth business day before `d` (not counting `d`). */
export function businessDaysBefore(d: IsoDate, n: number): IsoDate {
  let cur = d;
  while (n > 0) {
    cur = addDays(cur, -1);
    if (isBusinessDay(cur)) n--;
  }
  return cur;
}
