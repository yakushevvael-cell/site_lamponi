/**
 * Типизированная обёртка над lib/dmdk-core.mjs и работа с настройками ГИИС ДМДК.
 *
 * Сама арифметика и справочники живут в .mjs, чтобы их без сборки импортировали
 * юнит-тесты. Здесь — только типы и чтение/запись настроек в базе.
 */
import * as core from "./dmdk-core.mjs";

import { getRuntimeEnv } from "@/lib/runtime-env";

export type DmdkMarketplaceId = "wildberries" | "ozon";

export const DMDK_MARKETPLACES: Array<{ id: DmdkMarketplaceId; name: string; shortName: string }> = [
  { id: "wildberries", name: "Wildberries", shortName: "WB" },
  { id: "ozon", name: "Ozon", shortName: "OZ" },
];

export type DictionaryKind = "contractor" | "deal" | "currency";

export type DictionaryItem = {
  kind: DictionaryKind;
  externalId: string;
  name: string;
  fetchedAt: string;
};

export type DmdkMarketplaceSettings = {
  marketplaceId: DmdkMarketplaceId;
  shipperOgrn: string;
  shipperName: string;
  consigneeOgrn: string;
  consigneeName: string;
  dealId: string;
  dealNumber: string;
  carrierOgrn: string;
  carrierName: string;
  amountType: string;
  currency: string;
  vatRate: string;
  priceSource: string;
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** Общие настройки: адреса сервисов и реквизиты организации. */
export type DmdkGeneralSettings = {
  serviceUrl: string;
  ogrn: string;
  signerUrl: string;
  signingEnabled: boolean;
  testMode: boolean;
};

export const {
  VAT_RATES,
  AMOUNT_TYPES,
  DEAL_TYPES,
  PRICE_SOURCES,
  SETTINGS_FIELDS,
  SPEC_STATES,
  BATCH_CHUNK,
  toKopecks,
  toGiisAmount,
  formatRubles,
  vatFromGross,
  vatLabel,
  chunkBatches,
  missingSettings,
  isSettingsReady,
  specificationTotals,
} = core;

const GENERAL_KEYS = {
  serviceUrl: "dmdk_service_url",
  ogrn: "dmdk_ogrn",
  signerUrl: "dmdk_signer_url",
  signingEnabled: "dmdk_signing_enabled",
  testMode: "dmdk_test_mode",
} as const;

/**
 * Адрес тестового контура ГИИС.
 *
 * Пока идёт отладка, запросы должны уходить в тестовый контур: ошибка в
 * боевом — это реальное движение ценностей, которое потом придётся отзывать.
 */
export const DMDK_TEST_HOST = "dmdk.goznak.ru";

export function defaultMarketplaceSettings(marketplaceId: DmdkMarketplaceId): DmdkMarketplaceSettings {
  return {
    marketplaceId,
    shipperOgrn: "",
    shipperName: "",
    consigneeOgrn: "",
    consigneeName: "",
    dealId: "",
    dealNumber: "",
    carrierOgrn: "",
    carrierName: "",
    amountType: "P_SALE",
    currency: "RUB",
    vatRate: "NDS_22",
    priceSource: "order",
    enabled: false,
    updatedAt: null,
    updatedBy: null,
  };
}

type SettingsRow = {
  marketplace_id: string;
  shipper_ogrn: string | null;
  shipper_name: string | null;
  consignee_ogrn: string | null;
  consignee_name: string | null;
  deal_id: string | null;
  deal_number: string | null;
  carrier_ogrn: string | null;
  carrier_name: string | null;
  amount_type: string;
  currency: string;
  vat_rate: string;
  price_source: string;
  enabled: number;
  updated_at: string | null;
  updated_by: string | null;
};

function rowToSettings(row: SettingsRow): DmdkMarketplaceSettings {
  return {
    marketplaceId: row.marketplace_id as DmdkMarketplaceId,
    shipperOgrn: row.shipper_ogrn ?? "",
    shipperName: row.shipper_name ?? "",
    consigneeOgrn: row.consignee_ogrn ?? "",
    consigneeName: row.consignee_name ?? "",
    dealId: row.deal_id ?? "",
    dealNumber: row.deal_number ?? "",
    carrierOgrn: row.carrier_ogrn ?? "",
    carrierName: row.carrier_name ?? "",
    amountType: row.amount_type ?? "P_SALE",
    currency: row.currency ?? "RUB",
    vatRate: row.vat_rate ?? "NDS_22",
    priceSource: row.price_source ?? "order",
    enabled: Boolean(row.enabled),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Настройки всех площадок: отсутствующие возвращаются значениями по умолчанию. */
export async function loadMarketplaceSettings(): Promise<DmdkMarketplaceSettings[]> {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return DMDK_MARKETPLACES.map((item) => defaultMarketplaceSettings(item.id));
  const rows = await runtime.DB.prepare("SELECT * FROM dmdk_settings").all<SettingsRow>();
  const saved = new Map((rows.results ?? []).map((row) => [row.marketplace_id, rowToSettings(row)]));
  return DMDK_MARKETPLACES.map((item) => saved.get(item.id) ?? defaultMarketplaceSettings(item.id));
}

export async function loadGeneralSettings(): Promise<DmdkGeneralSettings> {
  const runtime = getRuntimeEnv();
  const empty: DmdkGeneralSettings = { serviceUrl: "", ogrn: "", signerUrl: "", signingEnabled: false, testMode: true };
  if (!runtime.DB) return empty;
  const keys = Object.values(GENERAL_KEYS);
  const placeholders = keys.map(() => "?").join(", ");
  const rows = await runtime.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const map = new Map((rows.results ?? []).map((row) => [row.key, row.value]));
  return {
    serviceUrl: map.get(GENERAL_KEYS.serviceUrl) ?? "",
    ogrn: map.get(GENERAL_KEYS.ogrn) ?? "",
    signerUrl: map.get(GENERAL_KEYS.signerUrl) ?? "",
    signingEnabled: map.get(GENERAL_KEYS.signingEnabled) === "1",
    // Пока ничего не настроено, безопаснее считать режим тестовым.
    testMode: (map.get(GENERAL_KEYS.testMode) ?? "1") === "1",
  };
}

export async function saveGeneralSettings(values: DmdkGeneralSettings) {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) throw new Error("База данных недоступна.");
  const pairs: Array<[string, string]> = [
    [GENERAL_KEYS.serviceUrl, values.serviceUrl.trim()],
    [GENERAL_KEYS.ogrn, values.ogrn.trim()],
    [GENERAL_KEYS.signerUrl, values.signerUrl.trim()],
    [GENERAL_KEYS.signingEnabled, values.signingEnabled ? "1" : "0"],
    [GENERAL_KEYS.testMode, values.testMode ? "1" : "0"],
  ];
  await runtime.DB.batch(
    pairs.map(([key, value]) =>
      runtime.DB!.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      ).bind(key, value),
    ),
  );
}

/** Справочники для выпадающих списков. Пустой список — справочники ещё не загружены. */
export async function loadDictionaries(): Promise<Record<DictionaryKind, DictionaryItem[]>> {
  const empty: Record<DictionaryKind, DictionaryItem[]> = { contractor: [], deal: [], currency: [] };
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return empty;
  const rows = await runtime.DB.prepare(
    "SELECT kind, external_id AS externalId, name, fetched_at AS fetchedAt FROM dmdk_dictionary_items WHERE active = 1 ORDER BY name",
  ).all<DictionaryItem>();
  for (const row of rows.results ?? []) {
    if (row.kind in empty) empty[row.kind].push(row);
  }
  return empty;
}
