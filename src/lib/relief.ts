/**
 * Opening-hours reasoning for relief sites.
 *
 * This module exists because of a correctness bug, not a feature request.
 *
 * Both publishers give us per-day opening hours, and until now the app ignored
 * them except to print a string in a popup. That means every coverage number
 * counted sites that were shut. A hydration station that closes at 3 PM does
 * not help a crew at 4 PM - and 4 PM is precisely when the field is hottest,
 * so the error runs in the worst possible direction: coverage looks best
 * exactly when it is least true.
 *
 * The rule adopted here: a site counts as relief at time T only if it is open
 * at T, OR if the publisher told us nothing about its hours. The second half
 * matters. Treating unknown hours as "closed" would silently delete real sites
 * from the map because of a blank field in someone else's database, so unknown
 * is treated as available and counted separately (`hoursKnown: false`) so the
 * UI can be honest about which is which.
 */
import type { ReliefSite } from './types';

/** Day index used throughout: 0 = Sunday .. 6 = Saturday, matching Date#getDay. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Parse a published time string into minutes from midnight.
 * Handles "8:00 AM", "8:00AM", "08:00", "8 AM", "noon", "midnight".
 * Returns null for anything it cannot read, which is the honest answer.
 */
export function parseClock(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === '' || s === 'null' || s === 'closed' || s === 'n/a') return null;
  if (s === 'noon') return 12 * 60;
  if (s === 'midnight') return 0;

  const m = s.match(/^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?$/);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];

  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (hour > 23 || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  return hour * 60 + minute;
}

/**
 * Is this site open at a given local day and time?
 *
 * A closing time at or before the opening time is read as running past
 * midnight (a respite centre open 20:00-06:00 is a real thing), which is why
 * this is not a plain `>= open && < close`.
 */
export function isOpenAt(
  site: ReliefSite,
  dayIndex: number,
  minutesOfDay: number,
): boolean {
  if (site.open24) return true;
  if (!site.hoursKnown) return true; // unknown, not closed - see module note

  const today = site.hoursByDay[dayIndex] ?? null;
  if (today) {
    if (today.closeMin > today.openMin) {
      if (minutesOfDay >= today.openMin && minutesOfDay < today.closeMin) return true;
    } else {
      // Overnight window: opens late, closes the following morning.
      if (minutesOfDay >= today.openMin || minutesOfDay < today.closeMin) return true;
    }
  }

  // A window opened yesterday may still be running.
  const yesterday = site.hoursByDay[(dayIndex + 6) % 7] ?? null;
  if (yesterday && yesterday.closeMin <= yesterday.openMin) {
    if (minutesOfDay < yesterday.closeMin) return true;
  }

  return false;
}

export interface OpenFilterResult {
  /** Sites usable at the requested time. */
  open: ReliefSite[];
  /** Sites excluded because they are shut then. */
  closed: ReliefSite[];
  /** Of the open set, how many are open only because we have no hours for them. */
  unknownHours: number;
}

/**
 * Split a site list by whether it is open at a local day/hour.
 *
 * Callers pass the hour the heat field describes, NOT the wall-clock hour -
 * scoring a 15:00 forecast against 9 AM opening hours would be its own kind
 * of wrong.
 */
export function filterOpenAt(
  sites: ReliefSite[],
  dayIndex: number,
  hourLocal: number,
): OpenFilterResult {
  const minutes = Math.round(hourLocal * 60);
  const open: ReliefSite[] = [];
  const closed: ReliefSite[] = [];
  let unknownHours = 0;

  for (const s of sites) {
    // Scenario-proposed stations are notional and always count.
    if (s.proposed || isOpenAt(s, dayIndex, minutes)) {
      open.push(s);
      if (!s.open24 && !s.hoursKnown && !s.proposed) unknownHours++;
    } else {
      closed.push(s);
    }
  }
  return { open, closed, unknownHours };
}

/** Weekday index for an ISO timestamp, in Arizona local time. */
export function localDayIndex(isoTimestamp: string): number {
  const d = new Date(isoTimestamp);
  // Arizona is a fixed UTC-7 with no DST, so shifting and reading the UTC day
  // gives the local weekday without pulling in a timezone library.
  const shifted = new Date(d.getTime() - 7 * 3600 * 1000);
  return shifted.getUTCDay();
}

/** Human summary of a site's hours for the day in question. */
export function hoursSummary(site: ReliefSite, dayIndex: number): string {
  if (site.open24) return 'Open 24 hours';
  if (!site.hoursKnown) return 'Hours not published';
  const today = site.hoursByDay[dayIndex];
  if (!today) return `Closed ${DAY_NAMES[dayIndex]}`;
  return `${fmtClock(today.openMin)} - ${fmtClock(today.closeMin)}`;
}

export function fmtClock(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const meridiem = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}
