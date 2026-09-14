import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Время из базы в читаемый вид.
 *
 * CURRENT_TIMESTAMP в SQLite пишет время по UTC и без указания пояса — если
 * отдать такую строку браузеру как есть, он посчитает её местной и покажет
 * событие на три часа раньше.
 */
export function asUtcIso(value: string | null | undefined) {
  if (!value) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return `${value.replace(" ", "T")}Z`;
}

export function formatMoment(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  const iso = asUtcIso(value);
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Date(time).toLocaleString("ru-RU", options ?? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** «2 ч 15 мин» — сколько прошло. Для дедлайнов и времени ожидания. */
export function formatAge(value: string | null | undefined, now = Date.now()) {
  const iso = asUtcIso(value);
  if (!iso) return "—";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const minutes = Math.round(Math.abs(now - time) / 60000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  const days = Math.floor(hours / 24);
  return `${days} дн ${hours % 24} ч`;
}
