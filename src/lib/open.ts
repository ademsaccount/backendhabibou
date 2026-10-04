import { env } from '../config/env';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type OpenableRestaurant = {
  is_open: boolean;
  opening_hours?: unknown;
  temp_closed_until?: Date | string | null;
};

function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = TIME_RE.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes depuis minuit (fuseau BUSINESS_TZ) pour la date donnee. */
function minutesOfDay(date: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: env.BUSINESS_TZ,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    if (hour === undefined || minute === undefined) return null;
    const value = Number(hour) * 60 + Number(minute);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Etat "ouvert" effectif d'un commerce :
 * 1. fermeture exceptionnelle active (temp_closed_until dans le futur) -> ferme ;
 * 2. drapeau admin is_open a false -> ferme ;
 * 3. sinon, ouverture selon opening_hours (HH:MM, BUSINESS_TZ), creneau de nuit pris en charge.
 * Sans horaires exploitables, le commerce suit uniquement le drapeau admin.
 */
export function isOpenNow(restaurant: OpenableRestaurant, now: Date = new Date()): boolean {
  const until = restaurant.temp_closed_until;
  if (until) {
    const timestamp = until instanceof Date ? until.getTime() : new Date(until).getTime();
    if (Number.isFinite(timestamp) && timestamp > now.getTime()) return false;
  }

  if (!restaurant.is_open) return false;

  const hours = restaurant.opening_hours as { open?: unknown; close?: unknown } | null;
  const open = toMinutes(hours?.open);
  const close = toMinutes(hours?.close);
  if (open === null || close === null || open === close) return true;

  const current = minutesOfDay(now);
  if (current === null) return true;
  if (open < close) return current >= open && current < close;
  return current >= open || current < close;
}
