/**
 * Сверка УПД с заданием: «артикул + размер + отправление» ↔ «артикул + размер + УИН».
 *
 * Одна УПД — одно задание. УИН закрепляются за изделиями и уходят на
 * площадку только если УПД сошлась с заданием целиком: у каждого изделия есть
 * свой УИН, и в УПД нет ничего лишнего. Иначе — список расхождений, и по
 * заданию ничего не делается, пока не загрузят верную УПД.
 *
 * Какой из двух УИН одного артикула и размера достанется какому отправлению —
 * не важно: изделия одинаковые. Важно, что на столе по скану УИН печатается
 * этикетка именно того отправления, за которым этот УИН закреплён.
 *
 * Размер сравнивается по смыслу: «16,0 +» и «16+», «17,0» и «17» — один
 * размер. У браслетов размера нет ни в УПД, ни на площадке; «б/р» и «0»
 * считаются тем же отсутствием размера.
 */
import { articleBaseKey, normalizeSizeValue, splitArticleSize } from "./upd-parse-core.mjs";

const NO_SIZE = new Set(["", "Б/Р", "0"]);

/** Размер для сверки: «нет размера» одним значением. */
export function matchSize(value) {
  const size = normalizeSizeValue(value);
  return NO_SIZE.has(size) ? "" : size;
}

/** Ключ сверки: артикул без регистра и похожих букв + размер по смыслу. */
export function matchKey(article, size) {
  const split = splitArticleSize(article, size);
  return `${articleBaseKey(split.article)}|${matchSize(split.size)}`;
}

function describe(article, size) {
  const shown = String(size ?? "").trim();
  return shown ? `${article} / ${shown}` : `${article} (без размера)`;
}

/**
 * @param {{
 *   items: Array<{ id: number, externalOrderId: string, article: string, size: string | null,
 *                  uin: string | null, locked: boolean }>,
 *   uins: Array<{ uin: string, article: string, size: string | null }>,
 * }} input
 *   items — изделия задания без «не найден»; locked — изделие уже отсканировано
 *   или его УИН уже у площадки, и менять УИН нельзя.
 * @returns {{ ok: boolean, assign: Array<{ itemId: number, uin: string }>, problems: string[] }}
 */
export function matchUpdToTask({ items, uins }) {
  const problems = [];
  const byKey = new Map();
  const seen = new Set();
  for (const entry of uins ?? []) {
    const uin = String(entry?.uin ?? "").trim();
    if (!uin) continue;
    if (seen.has(uin)) {
      problems.push(`УИН ${uin} встречается в УПД дважды.`);
      continue;
    }
    seen.add(uin);
    const key = matchKey(entry.article, entry.size);
    byKey.set(key, [...(byKey.get(key) ?? []), { uin, article: String(entry.article ?? ""), size: entry.size ?? null }]);
  }

  const assign = [];
  const used = new Set();

  // Изделие с закреплённым УИН (уже отсканировано или передано площадке)
  // сохраняет его — но УИН обязан быть в этой УПД с тем же артикулом и размером.
  for (const item of items ?? []) {
    const own = String(item.uin ?? "").trim();
    if (!item.locked || !own) continue;
    const list = byKey.get(matchKey(item.article, item.size)) ?? [];
    const match = list.find((entry) => entry.uin === own);
    if (!match) {
      problems.push(
        `Отправление ${item.externalOrderId}: ${describe(item.article, item.size)} уже с УИН ${own}, а в УПД его нет с этим артикулом и размером.`,
      );
      continue;
    }
    used.add(own);
    assign.push({ itemId: item.id, uin: own });
  }

  for (const item of items ?? []) {
    if (item.locked && String(item.uin ?? "").trim()) continue;
    const list = byKey.get(matchKey(item.article, item.size)) ?? [];
    const match = list.find((entry) => !used.has(entry.uin));
    if (!match) {
      problems.push(`Отправление ${item.externalOrderId}: для ${describe(item.article, item.size)} нет УИН в УПД.`);
      continue;
    }
    used.add(match.uin);
    assign.push({ itemId: item.id, uin: match.uin });
  }

  for (const list of byKey.values()) {
    for (const entry of list) {
      if (used.has(entry.uin)) continue;
      problems.push(`УИН ${entry.uin} (${describe(entry.article, entry.size)}) — такого изделия в задании нет.`);
    }
  }

  return { ok: problems.length === 0, assign: problems.length === 0 ? assign : [], problems };
}
