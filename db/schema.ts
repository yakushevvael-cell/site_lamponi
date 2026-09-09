import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const osvUploads = sqliteTable("osv_uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileName: text("file_name").notNull(),
  storageKey: text("storage_key"),
  status: text("status", { enum: ["processed", "failed"] }).notNull().default("processed"),
  articleCount: integer("article_count").notNull().default(0),
  skuCount: integer("sku_count").notNull().default(0),
  sizedVariantCount: integer("sized_variant_count").notNull().default(0),
  totalQuantity: real("total_quantity").notNull().default(0),
  zeroQuantityCount: integer("zero_quantity_count").notNull().default(0),
  warningCount: integer("warning_count").notNull().default(0),
  warningsJson: text("warnings_json").notNull().default("[]"),
  /** Дата, на которую актуальны остатки в этой ОСВ. */
  balanceDate: text("balance_date"),
  /** Загрузка принята администратором несмотря на несходимость итогов. */
  acceptedWithBlockers: integer("accepted_with_blockers", { mode: "boolean" }).notNull().default(false),
  blockersJson: text("blockers_json").notNull().default("[]"),
  uploadedBy: text("uploaded_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const products = sqliteTable(
  "products",
  {
    sourceSku: text("source_sku").primaryKey(),
    article: text("article").notNull().default(""),
    size: text("size"),
    name: text("name"),
    currentPhysicalQty: real("current_physical_qty").notNull().default(0),
    /**
     * Сколько единиц ОСВ составляют один товар на площадке.
     * Серьги: в 1С штуки, на площадке пара — значит 2. Обычный товар — 1.
     */
    unitsPerItem: integer("units_per_item").notNull().default(1),
    latestUploadId: integer("latest_upload_id").references(() => osvUploads.id),
    safetyStock: real("safety_stock").notNull().default(0),
    manualZero: integer("manual_zero", { mode: "boolean" }).notNull().default(false),
    manualZeroAt: text("manual_zero_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("product_article_size_idx").on(table.article, table.size)],
);

export const stockSnapshots = sqliteTable(
  "stock_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uploadId: integer("upload_id").notNull().references(() => osvUploads.id, { onDelete: "cascade" }),
    productSku: text("product_sku").notNull().references(() => products.sourceSku),
    physicalQty: real("physical_qty").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("stock_snapshot_upload_sku_unique").on(table.uploadId, table.productSku),
    index("stock_snapshot_product_idx").on(table.productSku),
  ],
);

export const marketplaces = sqliteTable("marketplaces", {
  id: text("id", { enum: ["wildberries", "ozon", "yandex"] }).primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  connectionStatus: text("connection_status", { enum: ["awaiting_keys", "connected", "error"] })
    .notNull()
    .default("awaiting_keys"),
  lastSyncAt: text("last_sync_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const marketplaceCredentials = sqliteTable("marketplace_credentials", {
  marketplaceId: text("marketplace_id").primaryKey().references(() => marketplaces.id, { onDelete: "cascade" }),
  encryptedPayload: text("encrypted_payload").notNull(),
  iv: text("iv").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const marketplaceWarehouses = sqliteTable(
  "marketplace_warehouses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    marketplaceId: text("marketplace_id").notNull().references(() => marketplaces.id),
    /** Уникальный ID склада из API маркетплейса. Сопоставление идёт только по нему. */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    /** Склад активен в кабинете маркетплейса. Архив/отключён = false. */
    remoteActive: integer("remote_active", { mode: "boolean" }).notNull().default(false),
    /** Исходная строка статуса из API — чтобы новый статус площадки не читался вслепую. */
    remoteStatus: text("remote_status"),
    /** Администратор включил выгрузку остатков на этот склад. Новый склад всегда выключен. */
    publishFullStock: integer("publish_full_stock", { mode: "boolean" }).notNull().default(false),
    /** Внутренний статус последней выгрузки: ok | error | never. */
    syncStatus: text("sync_status", { enum: ["never", "ok", "error"] }).notNull().default("never"),
    syncError: text("sync_error"),
    publishEnabledBy: text("publish_enabled_by"),
    publishEnabledAt: text("publish_enabled_at"),
    lastCheckedAt: text("last_checked_at"),
    lastStockSyncAt: text("last_stock_sync_at"),
  },
  (table) => [uniqueIndex("warehouse_marketplace_external_unique").on(table.marketplaceId, table.externalId)],
);

export const skuMappings = sqliteTable(
  "sku_mappings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productSku: text("product_sku").notNull().references(() => products.sourceSku),
    marketplaceId: text("marketplace_id").notNull().references(() => marketplaces.id),
    externalSku: text("external_sku").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    uniqueIndex("sku_mapping_marketplace_external_unique").on(table.marketplaceId, table.externalSku),
    index("sku_mapping_product_idx").on(table.productSku),
  ],
);

export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    marketplaceId: text("marketplace_id").notNull().references(() => marketplaces.id),
    externalOrderId: text("external_order_id").notNull(),
    status: text("status").notNull(),
    amount: real("amount").notNull().default(0),
    orderedAt: text("ordered_at").notNull(),
    shippedAt: text("shipped_at"),
    deliveredAt: text("delivered_at"),
    buyoutAt: text("buyout_at"),
    canceledAt: text("canceled_at"),
    cancellationSource: text("cancellation_source"),
    sellerCancelled: integer("seller_cancelled", { mode: "boolean" }).notNull().default(false),
    region: text("region"),
    city: text("city"),
    warehouseExternalId: text("warehouse_external_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("order_marketplace_external_unique").on(table.marketplaceId, table.externalOrderId),
    index("order_ordered_at_idx").on(table.orderedAt),
    index("order_status_idx").on(table.status),
  ],
);

export const orderItems = sqliteTable(
  "order_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
    productSku: text("product_sku").references(() => products.sourceSku),
    externalSku: text("external_sku").notNull(),
    sellerArticle: text("seller_article"),
    size: text("size"),
    quantity: real("quantity").notNull(),
    unitPrice: real("unit_price").notNull().default(0),
  },
  (table) => [index("order_item_order_idx").on(table.orderId)],
);

export const stockReservations = sqliteTable(
  "stock_reservations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderItemId: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
    productSku: text("product_sku").notNull().references(() => products.sourceSku),
    marketplaceId: text("marketplace_id").notNull().references(() => marketplaces.id),
    quantity: real("quantity").notNull(),
    status: text("status", { enum: ["active", "released", "closed_by_osv"] }).notNull().default("active"),
    /** Статус заказа на момент последнего пересчёта — видно, почему резерв снят. */
    orderStatus: text("order_status"),
    reservedAt: text("reserved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    releasedAt: text("released_at"),
  },
  (table) => [
    index("reservation_product_status_idx").on(table.productSku, table.status),
    uniqueIndex("reservation_order_item_unique").on(table.orderItemId),
  ],
);

/**
 * Очередь позиций, у которых изменился резерв и остаток ещё не доехал до площадок.
 * Наполняется при пересчёте резервов, разбирается фоновой доотправкой.
 */
export const stockDirtySkus = sqliteTable(
  "stock_dirty_skus",
  {
    productSku: text("product_sku").primaryKey(),
    reason: text("reason"),
    markedAt: text("marked_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("stock_dirty_marked_at_idx").on(table.markedAt)],
);

export const syncEvents = sqliteTable(
  "sync_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    marketplaceId: text("marketplace_id").references(() => marketplaces.id),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    kind: text("kind", { enum: ["orders", "stocks", "warehouses", "analytics"] }).notNull(),
    status: text("status", { enum: ["success", "error"] }).notNull(),
    itemCount: integer("item_count").notNull().default(0),
    message: text("message"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("sync_event_created_at_idx").on(table.createdAt)],
);

export const stockSyncRuns = sqliteTable(
  "stock_sync_runs",
  {
    id: text("id").primaryKey(),
    status: text("status", { enum: ["running", "success", "partial", "error", "cancelled"] })
      .notNull()
      .default("running"),
    trigger: text("trigger").notNull(),
    /** Версия ОСВ, на которой считался остаток: запрещает отправку старых данных. */
    osvUploadId: integer("osv_upload_id").references(() => osvUploads.id),
    actorEmail: text("actor_email"),
    message: text("message"),
    startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    finishedAt: text("finished_at"),
  },
  (table) => [index("stock_sync_run_started_idx").on(table.startedAt)],
);

export const stockSyncLog = sqliteTable(
  "stock_sync_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    marketplaceId: text("marketplace_id").notNull(),
    warehouseId: text("warehouse_id"),
    productSku: text("product_sku"),
    externalSku: text("external_sku"),
    article: text("article"),
    size: text("size"),
    osvQty: real("osv_qty"),
    reserveQty: real("reserve_qty"),
    computedQty: real("computed_qty"),
    sentQty: real("sent_qty"),
    apiStatus: text("api_status", { enum: ["success", "error", "blocked", "skipped"] }).notNull(),
    apiMessage: text("api_message"),
    actorEmail: text("actor_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("stock_sync_log_run_idx").on(table.runId),
    index("stock_sync_log_created_idx").on(table.createdAt),
    index("stock_sync_log_article_idx").on(table.article, table.size),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const appUsers = sqliteTable(
  "app_users",
  {
    email: text("email").primaryKey(),
    phone: text("phone"),
    fullName: text("full_name"),
    role: text("role", { enum: ["admin", "manager", "user"] }).notNull().default("user"),
    status: text("status", { enum: ["pending", "active", "blocked"] }).notNull().default("pending"),
    /** scrypt-хеш пароля. Сам пароль нигде не хранится. */
    passwordHash: text("password_hash"),
    passwordUpdatedAt: text("password_updated_at"),
    /** Выдан временный пароль — при следующем входе его нужно сменить. */
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: text("locked_until"),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("app_user_status_idx").on(table.status),
    uniqueIndex("app_user_phone_unique").on(table.phone),
  ],
);

export const serviceCredentials = sqliteTable("service_credentials", {
  id: text("id").primaryKey(),
  encryptedPayload: text("encrypted_payload").notNull(),
  iv: text("iv").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const phoneLoginCodes = sqliteTable(
  "phone_login_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    phone: text("phone").notNull(),
    fullName: text("full_name"),
    codeHash: text("code_hash").notNull(),
    nonce: text("nonce").notNull(),
    ipHash: text("ip_hash"),
    attempts: integer("attempts").notNull().default(0),
    status: text("status", { enum: ["active", "used", "failed"] }).notNull().default("active"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("phone_code_phone_created_idx").on(table.phone, table.createdAt),
    index("phone_code_ip_created_idx").on(table.ipHash, table.createdAt),
  ],
);

export const appSessions = sqliteTable(
  "app_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userEmail: text("user_email").notNull().references(() => appUsers.email, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("app_session_user_idx").on(table.userEmail),
    index("app_session_expires_idx").on(table.expiresAt),
  ],
);
