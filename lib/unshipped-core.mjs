/**
 * Отчёт «Не отгружено на момент»: какие заказы в указанное время ещё стояли
 * у нас на складе.
 *
 * Истории статусов база не хранит, поэтому состояние восстанавливается по
 * датам событий заказа: заказ ждал отгрузки, если к моменту среза он уже был
 * оформлен, но ещё не передан в доставку, не отгружен, не доставлен и не
 * отменён. У Маркета и части Ozon время передачи и отмены — момент, когда
 * синхронизация (раз в 15 минут) это увидела, так что граница размыта на
 * эти 15 минут.
 *
 * Чистые правила без базы и сети — их проверяют тесты.
 */

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Время из базы в миллисекундах. Строки без часового пояса — это
 * CURRENT_TIMESTAMP SQLite, то есть UTC: читаем их как UTC, а не по часам сервера.
 *
 * @param {string | null | undefined} value
 * @returns {number | null}
 */
export function parseUtc(value) {
  if (!value) return null;
  const text = String(value).trim();
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const time = Date.parse(hasZone ? text : `${text.replace(" ", "T")}Z`);
  return Number.isFinite(time) ? time : null;
}

/**
 * Значение поля «дата и время» (ГГГГ-ММ-ДДTЧЧ:ММ) по Москве — в миллисекунды UTC.
 *
 * @param {string | null | undefined} value
 * @returns {number | null}
 */
export function moscowInputToTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute) - MOSCOW_OFFSET_MS;
  const check = new Date(time + MOSCOW_OFFSET_MS);
  // 31.02 и 25:00 Date.UTC молча переносит на соседний день — такое не принимаем.
  if (check.getUTCDate() !== day || check.getUTCHours() !== hour) return null;
  return time;
}

/**
 * Миллисекунды в значение поля «дата и время» по Москве.
 *
 * @param {number} time
 */
export function timeToMoscowInput(time) {
  return new Date(time + MOSCOW_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * Время по Москве для людей: ДД.ММ.ГГГГ ЧЧ:ММ.
 *
 * @param {string | null | undefined} value
 */
export function formatMoscow(value) {
  const time = parseUtc(value);
  if (time === null) return "";
  const [date, clock] = timeToMoscowInput(time).split("T");
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year} ${clock}`;
}

/**
 * Ждал ли заказ отгрузки в момент cutoff.
 *
 * @param {{ orderedAt: string, handedOverAt?: string | null, shippedAt?: string | null, deliveredAt?: string | null, canceledAt?: string | null }} order
 * @param {number} cutoff миллисекунды UTC
 */
export function wasAwaitingAt(order, cutoff) {
  const ordered = parseUtc(order.orderedAt);
  if (ordered === null || ordered >= cutoff) return false;
  for (const value of [order.handedOverAt, order.shippedAt, order.deliveredAt, order.canceledAt]) {
    const time = parseUtc(value);
    if (time !== null && time < cutoff) return false;
  }
  return true;
}

/**
 * CSV для Excel: разделитель «;», BOM, чтобы кириллица открылась без танцев.
 *
 * @param {string[]} header
 * @param {Array<Array<string | number | null | undefined>>} rows
 */
export function toCsv(header, rows) {
  const cell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `﻿${[header, ...rows].map((row) => row.map(cell).join(";")).join("\r\n")}\r\n`;
}
