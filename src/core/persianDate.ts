/**
 * Persian (Jalali) date utilities for the Fibonacci Agent.
 * Provides conversion from Gregorian to Jalali calendar and Persian formatting.
 */

const PERSIAN_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

const PERSIAN_DAYS = [
  'یک‌شنبه',
  'دوشنبه',
  'سه‌شنبه',
  'چهارشنبه',
  'پنج‌شنبه',
  'جمعه',
  'شنبه',
];

const PERSIAN_NUMERALS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/**
 * Convert a number to Persian numerals.
 */
export function toPersianNumerals(num: number | string): string {
  return String(num).replace(/[0-9]/g, (d) => PERSIAN_NUMERALS[parseInt(d, 10)]);
}

/**
 * Convert Gregorian date to Jalali (Persian) date.
 * Algorithm based on https://github.com/jalaali/jalaali-js
 * 
 * @param gy Gregorian year
 * @param gm Gregorian month (1-12)
 * @param gd Gregorian day (1-31)
 * @returns { jy: Jalali year, jm: Jalali month (1-12), jd: Jalali day (1-31) }
 */
export function toJalali(gy: number, gm: number, gd: number): { jy: number; jm: number; jd: number } {
  const gDays = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

  // Convert Gregorian to Julian Day Number
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gDays[gm - 1] + gd;

  // Convert JDN to Jalali
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);

  return { jy, jm, jd };
}

/**
 * Get current Persian date as a formatted string.
 * Format: "Weekday، Day Month Year" (e.g., "یک‌شنبه، ۱ فروردین ۱۴۰۳")
 */
export function getPersianDateString(date: Date = new Date()): string {
  const gy = date.getFullYear();
  const gm = date.getMonth() + 1;
  const gd = date.getDate();
  const { jy, jm, jd } = toJalali(gy, gm, gd);
  const dayName = PERSIAN_DAYS[date.getDay()];
  const monthName = PERSIAN_MONTHS[jm - 1];

  return `${dayName}، ${toPersianNumerals(jd)} ${monthName} ${toPersianNumerals(jy)}`;
}

/**
 * Get short Persian date string (just the date, no weekday).
 * Format: "Day Month Year" (e.g., "۱ فروردین ۱۴۰۳")
 */
export function getShortPersianDate(isoDate: string): string {
  // Parse ISO date string (YYYY-MM-DD)
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    // Fallback to current date if parsing fails
    return getPersianDateString().split('، ')[1] || '';
  }
  const gy = parseInt(match[1], 10);
  const gm = parseInt(match[2], 10);
  const gd = parseInt(match[3], 10);
  const { jy, jm, jd } = toJalali(gy, gm, gd);
  const monthName = PERSIAN_MONTHS[jm - 1];

  return `${toPersianNumerals(jd)} ${monthName} ${toPersianNumerals(jy)}`;
}