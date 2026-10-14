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
