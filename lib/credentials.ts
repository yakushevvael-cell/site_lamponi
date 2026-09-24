import type { MarketplaceId } from "@/lib/marketplaces";
import type { AppRuntimeEnv } from "@/lib/runtime-env";

export type MarketplaceCredentialValues = {
  WB_API_TOKEN?: string;
  OZON_CLIENT_ID?: string;
  OZON_API_KEY?: string;
  YANDEX_API_KEY?: string;
  YANDEX_CAMPAIGN_ID?: string;
  YANDEX_BUSINESS_ID?: string;
  YANDEX_DELIVERY_TOKEN?: string;
  YANDEX_DELIVERY_STATION_ID?: string;
  YANDEX_DELIVERY_SERVICE_ID?: string;
};

const allowedKeys: Record<MarketplaceId, Array<keyof MarketplaceCredentialValues>> = {
  wildberries: ["WB_API_TOKEN"],
  ozon: ["OZON_CLIENT_ID", "OZON_API_KEY"],
  yandex: [
    "YANDEX_API_KEY",
    "YANDEX_CAMPAIGN_ID",
    "YANDEX_BUSINESS_ID",
    "YANDEX_DELIVERY_TOKEN",
    "YANDEX_DELIVERY_STATION_ID",
    "YANDEX_DELIVERY_SERVICE_ID",
  ],
};

/**
 * Поля, без которых площадка не работает.
 *
 * У Яндекса реквизиты Доставки хранятся рядом с ключами Маркета, но нужны
 * только на отгрузке: заказы читаются и собираются без них, поэтому требовать
 * их при сохранении нельзя — иначе интеграцию не включить по частям.
 */
const requiredKeys: Record<MarketplaceId, Array<keyof MarketplaceCredentialValues>> = {
  wildberries: ["WB_API_TOKEN"],
  ozon: ["OZON_CLIENT_ID", "OZON_API_KEY"],
  yandex: ["YANDEX_API_KEY", "YANDEX_CAMPAIGN_ID", "YANDEX_BUSINESS_ID"],
};

/** Заполнены ли реквизиты Яндекс Доставки — без них курьера не вызвать. */
export function deliveryConfigured(values: MarketplaceCredentialValues) {
  return Boolean(
    values.YANDEX_DELIVERY_TOKEN?.trim()
    && values.YANDEX_DELIVERY_STATION_ID?.trim()
    && values.YANDEX_DELIVERY_SERVICE_ID?.trim(),
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importMasterKey(encodedKey: string) {
  const bytes = base64ToBytes(encodedKey);
  if (bytes.byteLength !== 32) throw new Error("Ключ шифрования сервера настроен неверно.");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function validateCredentialPayload(
  marketplaceId: MarketplaceId,
  values: Record<string, unknown>,
): MarketplaceCredentialValues {
  const result: MarketplaceCredentialValues = {};
  const required = new Set<string>(requiredKeys[marketplaceId]);
  for (const key of allowedKeys[marketplaceId]) {
    const value = values[key];
    const filled = typeof value === "string" && value.trim().length > 0;
    if (!filled) {
      if (required.has(key)) throw new Error(`Заполните поле ${key}.`);
      continue;
    }
    (result as Record<string, string>)[key] = (value as string).trim();
  }
  return result;
}

export async function encryptCredentialValues(
  masterKey: string,
  values: object,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importMasterKey(masterKey);
  const plaintext = new TextEncoder().encode(JSON.stringify(values));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    encryptedPayload: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptCredentialValues<T extends object>(
  masterKey: string,
  encryptedPayload: string,
  encodedIv: string,
): Promise<T> {
  const key = await importMasterKey(masterKey);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encodedIv) },
    key,
    base64ToBytes(encryptedPayload),
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

function runtimeCredentials(runtime: AppRuntimeEnv, marketplaceId: MarketplaceId): MarketplaceCredentialValues {
  if (marketplaceId === "wildberries") return { WB_API_TOKEN: runtime.WB_API_TOKEN };
  if (marketplaceId === "ozon") {
    return { OZON_CLIENT_ID: runtime.OZON_CLIENT_ID, OZON_API_KEY: runtime.OZON_API_KEY };
  }
  return {
    YANDEX_API_KEY: runtime.YANDEX_API_KEY,
    YANDEX_CAMPAIGN_ID: runtime.YANDEX_CAMPAIGN_ID,
    YANDEX_BUSINESS_ID: runtime.YANDEX_BUSINESS_ID,
    YANDEX_DELIVERY_TOKEN: runtime.YANDEX_DELIVERY_TOKEN,
    YANDEX_DELIVERY_STATION_ID: runtime.YANDEX_DELIVERY_STATION_ID,
    YANDEX_DELIVERY_SERVICE_ID: runtime.YANDEX_DELIVERY_SERVICE_ID,
  };
}

/** Ключ настройки, которым администратор отзывает доступ к маркетплейсу (ТЗ, п. 11). */
export function revokedSettingKey(marketplaceId: MarketplaceId) {
  return `credentials_revoked_${marketplaceId}`;
}

/**
 * Проверяет, отозван ли доступ администратором. Нужен, потому что ключи могут
 * приходить не только из БД, но и из переменных окружения Worker'а: без этой
 * проверки «удаление ключа» не остановило бы отправку остатков.
 */
export async function credentialsRevoked(db: D1Database, marketplaceId: MarketplaceId) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(revokedSettingKey(marketplaceId))
    .first<{ value: string }>();
  return row?.value === "1";
}

export async function getMarketplaceCredentials(
  db: D1Database,
  runtime: AppRuntimeEnv,
  marketplaceId: MarketplaceId,
) {
  if (await credentialsRevoked(db, marketplaceId)) return {} as MarketplaceCredentialValues;

  const row = await db.prepare(
    "SELECT encrypted_payload AS encryptedPayload, iv FROM marketplace_credentials WHERE marketplace_id = ?",
  ).bind(marketplaceId).first<{ encryptedPayload: string; iv: string }>();

  if (row && runtime.CREDENTIALS_MASTER_KEY) {
    try {
      return await decryptCredentialValues<MarketplaceCredentialValues>(runtime.CREDENTIALS_MASTER_KEY, row.encryptedPayload, row.iv);
    } catch {
      throw new Error("Сохранённые ключи не удалось расшифровать. Добавьте их повторно.");
    }
  }

  return runtimeCredentials(runtime, marketplaceId);
}

export function credentialsAreComplete(marketplaceId: MarketplaceId, values: MarketplaceCredentialValues) {
  return requiredKeys[marketplaceId].every((key) => Boolean(values[key]?.trim()));
}

export function hasRuntimeCredentials(runtime: AppRuntimeEnv, marketplaceId: MarketplaceId) {
  return credentialsAreComplete(marketplaceId, runtimeCredentials(runtime, marketplaceId));
}
