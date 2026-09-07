import { authorizeApi } from "@/lib/app-auth";
import { revokedSettingKey } from "@/lib/credentials";
import { marketplaceConnectors } from "@/lib/marketplaces";
import { getRuntimeEnv } from "@/lib/runtime-env";

type WarehouseView = {
  id: string;
  name: string;
  remoteActive: boolean;
  remoteStatus: string | null;
  publishFullStock: boolean;
  syncStatus: "never" | "ok" | "error";
  syncError: string | null;
  publishEnabledBy: string | null;
  publishEnabledAt: string | null;
  lastCheckedAt: string | null;
  lastStockSyncAt: string | null;
};

export async function GET() {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  const states = new Map<string, {
    connectionStatus: string;
    lastSyncAt: string | null;
    warehouseCount: number;
    activeWarehouseCount: number;
    publishingWarehouseCount: number;
    lastWarehouseCheckAt: string | null;
  }>();
  const warehouses = new Map<string, WarehouseView[]>();
  const storedCredentials = new Set<string>();
  const revokedCredentials = new Set<string>();

  if (runtime.DB) {
    const stateRows = await runtime.DB.prepare(
      `SELECT m.id,
              m.connection_status AS connectionStatus,
              m.last_sync_at AS lastSyncAt,
              COUNT(w.id) AS warehouseCount,
              COUNT(CASE WHEN w.remote_active = 1 THEN 1 END) AS activeWarehouseCount,
              COUNT(CASE WHEN w.remote_active = 1 AND w.publish_full_stock = 1 THEN 1 END) AS publishingWarehouseCount,
              MAX(w.last_checked_at) AS lastWarehouseCheckAt
       FROM marketplaces m
       LEFT JOIN marketplace_warehouses w ON w.marketplace_id = m.id
       GROUP BY m.id, m.connection_status, m.last_sync_at`,
    ).all<{
      id: string;
      connectionStatus: string;
      lastSyncAt: string | null;
      warehouseCount: number;
      activeWarehouseCount: number;
      publishingWarehouseCount: number;
      lastWarehouseCheckAt: string | null;
    }>();

    for (const row of stateRows.results) states.set(row.id, row);

    const warehouseRows = await runtime.DB.prepare(
      `SELECT marketplace_id AS marketplaceId,
              external_id AS id,
              name,
              remote_active AS remoteActive,
              remote_status AS remoteStatus,
              publish_full_stock AS publishFullStock,
              sync_status AS syncStatus,
              sync_error AS syncError,
              publish_enabled_by AS publishEnabledBy,
              publish_enabled_at AS publishEnabledAt,
              last_checked_at AS lastCheckedAt,
              last_stock_sync_at AS lastStockSyncAt
       FROM marketplace_warehouses
       ORDER BY remote_active DESC, name`,
    ).all<{
      marketplaceId: string;
      id: string;
      name: string;
      remoteActive: number;
      remoteStatus: string | null;
      publishFullStock: number;
      syncStatus: "never" | "ok" | "error";
      syncError: string | null;
      publishEnabledBy: string | null;
      publishEnabledAt: string | null;
      lastCheckedAt: string | null;
      lastStockSyncAt: string | null;
    }>();

    for (const row of warehouseRows.results) {
      const list = warehouses.get(row.marketplaceId) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        remoteActive: Boolean(row.remoteActive),
        remoteStatus: row.remoteStatus,
        publishFullStock: Boolean(row.publishFullStock),
        syncStatus: row.syncStatus ?? "never",
        syncError: row.syncError,
        publishEnabledBy: row.publishEnabledBy,
        publishEnabledAt: row.publishEnabledAt,
        lastCheckedAt: row.lastCheckedAt,
        lastStockSyncAt: row.lastStockSyncAt,
      });
      warehouses.set(row.marketplaceId, list);
    }

    const credentialRows = await runtime.DB.prepare(
      "SELECT marketplace_id AS marketplaceId FROM marketplace_credentials",
    ).all<{ marketplaceId: string }>();
    for (const row of credentialRows.results) storedCredentials.add(row.marketplaceId);

    const revokedRows = await runtime.DB.prepare(
      "SELECT key FROM settings WHERE key LIKE 'credentials_revoked_%' AND value = '1'",
    ).all<{ key: string }>();
    for (const row of revokedRows.results) revokedCredentials.add(row.key.replace("credentials_revoked_", ""));
  }

  return Response.json({
    integrations: marketplaceConnectors.map((connector) => {
      const state = states.get(connector.id);
      const revoked = revokedCredentials.has(connector.id);
      // Ключ считается добавленным, только если доступ не отозван администратором.
      const configured = !revoked && (connector.isConfigured(runtime) || storedCredentials.has(connector.id));
      return {
        id: connector.id,
        name: connector.name,
        shortName: connector.shortName,
        configured,
        connected: configured && state?.connectionStatus === "connected",
        connectionStatus: configured ? (state?.connectionStatus ?? "awaiting_keys") : "awaiting_keys",
        credentialsMessage: configured ? null : "API-ключ не добавлен",
        lastCheckedAt: state?.lastWarehouseCheckAt ?? state?.lastSyncAt ?? null,
        warehouseCount: Number(state?.warehouseCount ?? 0),
        activeWarehouseCount: Number(state?.activeWarehouseCount ?? 0),
        publishingWarehouseCount: Number(state?.publishingWarehouseCount ?? 0),
        warehouses: warehouses.get(connector.id) ?? [],
        credentials: connector.credentials,
      };
    }),
  });
}
