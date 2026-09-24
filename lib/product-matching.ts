import type { OzonProduct } from "@/lib/ozon";
import type { WildberriesCard } from "@/lib/wildberries";

export type LocalProductIdentity = {
  sourceSku: string;
  article: string;
  size: string | null;
};

export type MarketplaceMapping = LocalProductIdentity & {
  externalSku: string;
};

export function normalizeProductKey(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLocaleUpperCase("ru-RU")
    .replaceAll("Ё", "Е")
    .replace(/[^0-9A-ZА-Я]/g, "");
}

/**
 * Канонический вид размера.
 *
 * Один и тот же размер кольца пишут по-разному: в ОСВ «16», на Wildberries
 * «16.0», на Ozon «16,0», в старых карточках попадается «16,00». Посимвольное
 * сравнение считало их разными размерами, и позиция оставалась без
 * сопоставления — на площадку она не уходила вообще.
 *
 * Поэтому числовой размер приводим к числу, а не к строке: 16 = 16.0 = 16,00,
 * при этом 16,5 остаётся отдельным размером. Нечисловые размеры (XL, Б/Р)
 * трогаем только по регистру и пробелам — там подменять ничего нельзя.
 */
export function normalizeSize(value: string | null | undefined) {
  const text = String(value ?? "")
    .toLocaleUpperCase("ru-RU")
    // \s покрывает и неразрывный пробел, который приходит из выгрузок 1С.
    .replace(/\s+/g, "")
    .replaceAll(",", ".");
  if (!text) return "";
  if (!/^\d+(?:\.\d+)?$/.test(text)) return text;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? String(numeric) : text;
}

function sizeTokens(value: string | null) {
  if (!value) return [];
  const match = value.replace(",", ".").match(/\d+(?:\.\d+)?/);
  if (!match) return [normalizeProductKey(value)].filter(Boolean);
  const rawDigits = match[0].replace(".", "");
  const numeric = Number(match[0]);
  const normalizedDigits = Number.isFinite(numeric) ? String(numeric).replace(".", "") : rawDigits;
  return [...new Set([rawDigits, normalizedDigits])].filter(Boolean);
}

/**
 * Те же цифры, но в других написаниях размера.
 *
 * В offerId разделитель съедается вместе с остальными знаками, поэтому «16»
 * превращается в «16», а «16,0» — в «160»: одинаковые размеры дают разные
 * ключи. Эти варианты пробуются вторым проходом, когда точного совпадения
 * не нашлось, — так прежние сопоставления не меняются.
 */
function alternateSizeTokens(value: string | null) {
  const normalized = normalizeSize(value);
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return [];
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return [];
  const primary = new Set(sizeTokens(value));
  return [...new Set([numeric.toFixed(1), numeric.toFixed(2)].map((text) => text.replace(".", "")))]
    .filter((token) => token && !primary.has(token));
}

export function expectedOfferKeys(product: LocalProductIdentity) {
  const article = normalizeProductKey(product.article);
  if (!article) return [];
  if (product.size === null) return [article];
  return sizeTokens(product.size).map((size) => `${article}${size}`);
}

/** Запасные ключи: те же размеры, записанные иначе. Пробуются вторым проходом. */
function alternateOfferKeys(product: LocalProductIdentity) {
  const article = normalizeProductKey(product.article);
  if (!article || product.size === null) return [];
  return alternateSizeTokens(product.size).map((size) => `${article}${size}`);
}

/**
 * Сопоставление по артикулу продавца.
 *
 * Годится для площадок, где внешний идентификатор товара — наш собственный
 * артикул с размером: у Ozon это offerId, у Яндекс Маркета — тоже offerId.
 * Пара принимается, только если ключ однозначен с обеих сторон: два товара с
 * одним ключом — это ошибка каталога, и молча выбирать из них нельзя.
 */
function matchByOfferId(
  localProducts: LocalProductIdentity[],
  catalog: Array<{ offerId: string; archived?: boolean }>,
) {
  const remote = catalog.filter((item) => !item.archived);
  const matches: MarketplaceMapping[] = [];
  const takenLocal = new Set<string>();
  const takenRemote = new Set<string>();

  // Два прохода: сначала точные ключи, потом другие написания размера.
  // Порядок важен — иначе запасной ключ одной позиции мог бы перехватить
  // товар, который точно совпадает с другой.
  const pass = (keysOf: (product: LocalProductIdentity) => string[]) => {
    const localByKey = new Map<string, LocalProductIdentity[]>();
    for (const product of localProducts) {
      if (takenLocal.has(product.sourceSku)) continue;
      for (const key of keysOf(product)) {
        const rows = localByKey.get(key) ?? [];
        rows.push(product);
        localByKey.set(key, rows);
      }
    }

    const remoteByKey = new Map<string, Array<{ offerId: string }>>();
    for (const product of remote) {
      if (takenRemote.has(product.offerId)) continue;
      const key = normalizeProductKey(product.offerId);
      const rows = remoteByKey.get(key) ?? [];
      rows.push(product);
      remoteByKey.set(key, rows);
    }

    for (const [key, localRows] of localByKey) {
      const remoteRows = remoteByKey.get(key) ?? [];
      // Пара принимается, только если ключ однозначен с обеих сторон.
      if (localRows.length !== 1 || remoteRows.length !== 1) continue;
      const [local] = localRows;
      const [match] = remoteRows;
      if (takenLocal.has(local.sourceSku) || takenRemote.has(match.offerId)) continue;
      matches.push({ ...local, externalSku: match.offerId });
      takenLocal.add(local.sourceSku);
      takenRemote.add(match.offerId);
    }
  };

  pass(expectedOfferKeys);
  pass(alternateOfferKeys);

  return [...new Map(matches.map((match) => [match.sourceSku, match])).values()];
}

export function matchOzonCatalog(localProducts: LocalProductIdentity[], catalog: OzonProduct[]) {
  return matchByOfferId(localProducts, catalog);
}

export function matchYandexCatalog(
  localProducts: LocalProductIdentity[],
  catalog: Array<{ offerId: string; archived?: boolean }>,
) {
  return matchByOfferId(localProducts, catalog);
}

export function matchWildberriesCatalog(localProducts: LocalProductIdentity[], cards: WildberriesCard[]) {
  const byArticle = new Map<string, LocalProductIdentity[]>();
  for (const product of localProducts) {
    const key = normalizeProductKey(product.article);
    const rows = byArticle.get(key) ?? [];
    rows.push(product);
    byArticle.set(key, rows);
  }

  const matches: MarketplaceMapping[] = [];
  for (const card of cards) {
    const localRows = byArticle.get(normalizeProductKey(card.vendorCode)) ?? [];
    for (const product of localRows) {
      const remoteSize = product.size === null
        ? (card.sizes.length === 1 && ["", "0"].includes(normalizeSize(card.sizes[0]?.techSize ?? card.sizes[0]?.wbSize)) ? card.sizes[0] : undefined)
        : card.sizes.find((size) => [size.techSize, size.wbSize].some((value) => normalizeSize(value) === normalizeSize(product.size)));
      if (!remoteSize || typeof remoteSize.chrtID !== "number") continue;
      matches.push({ ...product, externalSku: String(remoteSize.chrtID) });
    }
  }
  return [...new Map(matches.map((match) => [match.sourceSku, match])).values()];
}
