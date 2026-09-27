/**
 * Привязка УИН из УПД к изделиям задания.
 *
 * Одна УПД — одно задание. При загрузке УПД каждое изделие задания (строка
 * `pick_task_items`, одно изделие одного отправления) получает свой УИН из
 * этой УПД, и дальше эта связь не меняется: стол сканирования по УИН только
 * находит отправление, а на площадку уходит ровно тот УИН, что закреплён.
 *
 * Раньше УИН брался «первый свободный по артикулу» из всех когда-либо
 * загруженных УПД, и при двух одинаковых артикулах в разных отправлениях
 * отсканированный УИН расходился с переданным на площадку.
 *
 * Какой из двух УИН одного артикула достанется какому отправлению — не важно:
 * изделия одинаковые. Важно, чтобы на коробку легла этикетка того
 * отправления, за которым закреплён отсканированный УИН, — это делает скан.
 *
 * Правила:
 *  — изделие, которое уже отсканировано или чей УИН уже передан площадке,
 *    сохраняет свой УИН («закреплено»);
 *  — сначала пары с точным совпадением артикула и размера;
 *  — затем по артикулу без размера, но только если у оставшихся изделий
 *    этого артикула один размер. Если размеры разные, а УПД размер не
 *    называет, угадывать нельзя: такие изделия получат УИН при скане, где
 *    размер подтверждает кладовщик.
 */
import { articleBaseKey, articleKey, normalizeSizeValue, splitArticleSize } from "./upd-parse-core.mjs";

/**
 * @typedef {{ id: number, article: string, size: string | null, uin: string | null, locked: boolean }} BindItem
 * @typedef {{ uin: string, article: string, size: string | null }} BindUin
 *
 * @param {{ items: BindItem[], uins: BindUin[] }} input
 *   items — изделия задания без «не найден», в порядке отправлений;
 *   uins — УИН из УПД в порядке документа.
 * @returns {{
 *   assign: Array<{ itemId: number, uin: string }>,
 *   unbound: Array<{ itemId: number, article: string, size: string | null, reason: "size" | "shortage" }>,
 *   extra: BindUin[],
 *   lockedMissing: Array<{ itemId: number, uin: string, article: string }>,
 *   kept: Array<{ itemId: number, uin: string }>,
 * }}
 */
export function planUinBinding({ items, uins }) {
  const seen = new Set();
  const pool = [];
  for (const entry of uins ?? []) {
    const uin = String(entry?.uin ?? "").trim();
    if (!uin || seen.has(uin)) continue;
    seen.add(uin);
    pool.push({ uin, article: String(entry.article ?? ""), size: entry.size ?? null });
  }

  const kept = [];
  const lockedMissing = [];
  const taken = new Set();
  const open = [];
  for (const item of items ?? []) {
    const own = String(item.uin ?? "").trim();
    if (item.locked && own) {
      kept.push({ itemId: item.id, uin: own });
      taken.add(own);
      if (!seen.has(own)) lockedMissing.push({ itemId: item.id, uin: own, article: item.article });
      continue;
    }
    open.push(item);
  }

  const free = pool.filter((entry) => !taken.has(entry.uin));
  const used = new Set();
  const assign = [];
  const assigned = new Set();

  // Точная пара «артикул + размер». Пустой размер с обеих сторон — тоже пара.
  for (const item of open) {
    const key = articleKey(item.article, item.size);
    const match = free.find((entry) => !used.has(entry.uin) && articleKey(entry.article, entry.size) === key);
    if (!match) continue;
    used.add(match.uin);
    assigned.add(item.id);
    assign.push({ itemId: item.id, uin: match.uin });
  }

  // Остаток — по артикулу без размера, если размер у изделий один.
  const rest = new Map();
  for (const item of open) {
    if (assigned.has(item.id)) continue;
    const key = articleBaseKey(item.article);
    rest.set(key, [...(rest.get(key) ?? []), item]);
  }

  const unbound = [];
  const reserved = new Set();
  for (const [key, group] of rest) {
    const sizes = new Set(group.map((item) => normalizeSizeValue(splitArticleSize(item.article, item.size).size)));
    const candidates = free.filter((entry) => !used.has(entry.uin) && articleBaseKey(entry.article) === key);
    if (sizes.size > 1) {
      // Разные размеры одного артикула, а УПД их не различает: УИН достанется
      // изделию при скане, после подтверждения размера.
      for (const entry of candidates) reserved.add(entry.uin);
      for (const item of group) {
        unbound.push({
          itemId: item.id,
          article: item.article,
          size: item.size ?? null,
          reason: candidates.length > 0 ? "size" : "shortage",
        });
      }
      continue;
    }
    for (const item of group) {
      const match = candidates.find((entry) => !used.has(entry.uin));
      if (!match) {
        unbound.push({ itemId: item.id, article: item.article, size: item.size ?? null, reason: "shortage" });
        continue;
      }
      used.add(match.uin);
      assign.push({ itemId: item.id, uin: match.uin });
    }
  }

  const extra = free.filter((entry) => !used.has(entry.uin) && !reserved.has(entry.uin));
  return { assign, unbound, extra, lockedMissing, kept };
}
