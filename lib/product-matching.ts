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

function normalizeSize(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLocaleUpperCase("ru-RU").replace(",", ".");
  return /^\d+\.0$/.test(normalized) ? normalized.slice(0, -2) : normalized;
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

export function expectedOfferKeys(product: LocalProductIdentity) {
  const article = normalizeProductKey(product.article);
  if (!article) return [];
  if (product.size === null) return [article];
  return sizeTokens(product.size).map((size) => `${article}${size}`);
}

export function matchOzonCatalog(localProducts: LocalProductIdentity[], catalog: OzonProduct[]) {
  const localByKey = new Map<string, LocalProductIdentity[]>();
  for (const product of localProducts) {
    for (const key of expectedOfferKeys(product)) {
      const rows = localByKey.get(key) ?? [];
      rows.push(product);
      localByKey.set(key, rows);
    }
  }

  const remoteByKey = new Map<string, OzonProduct[]>();
  for (const product of catalog.filter((item) => !item.archived)) {
    const key = normalizeProductKey(product.offerId);
    const rows = remoteByKey.get(key) ?? [];
    rows.push(product);
    remoteByKey.set(key, rows);
  }

  const matches: MarketplaceMapping[] = [];
  for (const [key, localRows] of localByKey) {
    const remoteRows = remoteByKey.get(key) ?? [];
    if (localRows.length !== 1 || remoteRows.length !== 1) continue;
    matches.push({ ...localRows[0], externalSku: remoteRows[0].offerId });
  }
  return [...new Map(matches.map((match) => [match.sourceSku, match])).values()];
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
