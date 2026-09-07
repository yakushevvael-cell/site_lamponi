import type { AppRuntimeEnv } from "@/lib/runtime-env";

export type MarketplaceId = "wildberries" | "ozon" | "yandex";

export type MarketplaceConnector = {
  id: MarketplaceId;
  name: string;
  shortName: string;
  credentials: string[];
  isConfigured: (env: AppRuntimeEnv) => boolean;
};

export const marketplaceConnectors: MarketplaceConnector[] = [
  {
    id: "wildberries",
    name: "Wildberries",
    shortName: "WB",
    credentials: ["WB_API_TOKEN"],
    isConfigured: (env) => Boolean(env.WB_API_TOKEN),
  },
  {
    id: "ozon",
    name: "Ozon",
    shortName: "OZ",
    credentials: ["OZON_CLIENT_ID", "OZON_API_KEY"],
    isConfigured: (env) => Boolean(env.OZON_CLIENT_ID && env.OZON_API_KEY),
  },
  {
    id: "yandex",
    name: "Яндекс Маркет",
    shortName: "YM",
    credentials: ["YANDEX_API_KEY"],
    isConfigured: (env) => Boolean(env.YANDEX_API_KEY),
  },
];
