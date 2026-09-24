import type { AppRuntimeEnv } from "@/lib/runtime-env";

export type MarketplaceId = "wildberries" | "ozon" | "yandex";

export type MarketplaceConnector = {
  id: MarketplaceId;
  name: string;
  shortName: string;
  /** Все поля подключения — из них строится форма ввода ключей. */
  credentials: string[];
  /** Без чего площадка не работает вовсе. Остальные поля можно заполнить позже. */
  required: string[];
  isConfigured: (env: AppRuntimeEnv) => boolean;
};

/**
 * Человеческие подписи полей подключения.
 *
 * У Яндекса шесть полей из двух разных систем, и по одному имени переменной
 * непонятно, где что брать: подписи идут рядом с полем в форме.
 */
export const credentialLabels: Record<string, string> = {
  WB_API_TOKEN: "Токен API Wildberries",
  OZON_CLIENT_ID: "Client-Id Ozon",
  OZON_API_KEY: "API-ключ Ozon",
  YANDEX_API_KEY: "Api-Key кабинета Маркета",
  YANDEX_CAMPAIGN_ID: "Номер магазина (campaignId)",
  YANDEX_BUSINESS_ID: "Номер кабинета (businessId)",
  YANDEX_DELIVERY_TOKEN: "Bearer-токен Яндекс Доставки",
  YANDEX_DELIVERY_STATION_ID: "Станция отправления Яндекс Доставки",
  YANDEX_DELIVERY_SERVICE_ID: "Код службы доставки в Маркете",
};

export const marketplaceConnectors: MarketplaceConnector[] = [
  {
    id: "wildberries",
    name: "Wildberries",
    shortName: "WB",
    credentials: ["WB_API_TOKEN"],
    required: ["WB_API_TOKEN"],
    isConfigured: (env) => Boolean(env.WB_API_TOKEN),
  },
  {
    id: "ozon",
    name: "Ozon",
    shortName: "OZ",
    credentials: ["OZON_CLIENT_ID", "OZON_API_KEY"],
    required: ["OZON_CLIENT_ID", "OZON_API_KEY"],
    isConfigured: (env) => Boolean(env.OZON_CLIENT_ID && env.OZON_API_KEY),
  },
  {
    id: "yandex",
    name: "Яндекс Маркет",
    shortName: "YM",
    // Первые три поля — Маркет, последние три — Яндекс Доставка: заказы можно
    // читать сразу, а курьера вызывать только после настройки Доставки.
    credentials: [
      "YANDEX_API_KEY",
      "YANDEX_CAMPAIGN_ID",
      "YANDEX_BUSINESS_ID",
      "YANDEX_DELIVERY_TOKEN",
      "YANDEX_DELIVERY_STATION_ID",
      "YANDEX_DELIVERY_SERVICE_ID",
    ],
    required: ["YANDEX_API_KEY", "YANDEX_CAMPAIGN_ID", "YANDEX_BUSINESS_ID"],
    isConfigured: (env) => Boolean(env.YANDEX_API_KEY && env.YANDEX_CAMPAIGN_ID && env.YANDEX_BUSINESS_ID),
  },
];
