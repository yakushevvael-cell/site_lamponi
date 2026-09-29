/**
 * История остатков по одной позиции: чистые правила без базы и сети.
 *
 * Маршрут /api/stocks/history достаёт из базы заказы, корректировки
 * (журнал выгрузки) и проверки площадок, а здесь они складываются в одну
 * ленту событий. Отдельный .mjs нужен, чтобы правила проверялись юнит-тестами
 * без сборки (`node --test tests/stock-history-core.test.mjs`).
 *
 * Лента идёт по времени: заказ → корректировка на всех складах площадок →
 * проверка площадок через 10 минут. Корректировка свёрнута в одну строку:
 * «Остатки откорректированы успешно», если ни один склад не вернул ошибку,
 * иначе «Ошибка корректировки остатков»; по складам — в раскрытии.
 */

export const CORRECTION_OK_TITLE = "Остатки откорректированы успешно";
export const CORRECTION_ERROR_TITLE = "Ошибка корректировки остатков";

/** Служебный пользователь фоновых задач — как SYNC_TASK_ACTOR в lib/app-auth. */
const SCHEDULER_ACTOR = "планировщик";

const MARKETPLACE_ORDER = ["wildberries", "ozon", "yandex"];

/**
 * Время из базы в ISO. CURRENT_TIMESTAMP SQLite пишет «2026-09-29 10:15:00»
 * без пояса, и это UTC; время площадок уже приходит в ISO.
 * @param {string | null | undefined} value
 */
export function toIso(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) return `${text.replace(" ", "T")}Z`;
  return text;
}

/** @param {string | null} iso */
function timeOf(iso) {
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Что за корректировка. Полная синхронизация до появления отдельного
 * trigger писалась как «manual»; её выдаёт автор — планировщик: ручную
 * выгрузку выбранных позиций запускает только человек.
 * @param {string} trigger
 * @param {string | null} actorEmail
 */
export function correctionKind(trigger, actorEmail) {
  if (trigger === "full_sync") return actorEmail === SCHEDULER_ACTOR ? "scheduled_full_sync" : "full_sync";
  if (trigger === "manual") return actorEmail === SCHEDULER_ACTOR ? "scheduled_full_sync" : "manual";
  return trigger;
}

export const CORRECTION_LABELS = {
  orders_sync: "Корректировка после заказов",
  manual: "Ручная выгрузка выбранных позиций",
  full_sync: "Полная синхронизация (запущена вручную)",
  scheduled_full_sync: "Плановая полная синхронизация",
  osv_upload: "Корректировка после загрузки ОСВ",
  warehouse_enabled: "Включение выгрузки на склад",
  warehouse_disabled: "Отключение выгрузки на склад",
  manual_zero: "Ручное обнуление",
  canary: "Канареечный тест",
};

/**
 * @typedef {{ marketplaceId: string, externalId: string, name: string, publishing: boolean }} Warehouse
 * @typedef {{ marketplaceId: string, warehouseId: string | null, sentQty: number | null, apiStatus: string, apiMessage: string | null, createdAt?: string | null }} LogRow
 * @typedef {{ marketplaceId: string, warehouseId: string, warehouseName: string, status: string, sentQty: number | null, message: string | null }} CorrectionWarehouse
 */

/**
 * Статус корректировки по каждому складу каждой площадки.
 *
 * Показываются все активные склады площадок, с которыми сопоставлена
 * позиция: куда отправляли — со статусом ответа, куда нет — с пометкой
 * «склад отключён». Ошибка уровня склада (без строки по позиции) ложится
 * на склад, а ошибка без склада — на все склады с выгрузкой этой площадки.
 *
 * @param {{ rows: LogRow[], runRows?: LogRow[], warehouses: Warehouse[], marketplaces: string[] }} input
 */
export function summarizeCorrection({ rows, runRows = [], warehouses, marketplaces }) {
  /** @type {Map<string, LogRow>} */
  const byWarehouse = new Map();
  for (const row of rows) {
    if (!row.warehouseId) continue;
    byWarehouse.set(`${row.marketplaceId}::${row.warehouseId}`, row);
  }
  /** Ошибки уровня склада или всей площадки: для этой позиции строки нет. */
  const warehouseErrors = new Map();
  const marketplaceErrors = new Map();
  for (const row of runRows) {
    if (row.apiStatus === "success") continue;
    if (row.warehouseId) {
      const key = `${row.marketplaceId}::${row.warehouseId}`;
      if (!warehouseErrors.has(key)) warehouseErrors.set(key, row);
    } else if (!marketplaceErrors.has(row.marketplaceId)) {
      marketplaceErrors.set(row.marketplaceId, row);
    }
  }

  const involved = new Set([...marketplaces, ...rows.map((row) => row.marketplaceId)]);
  /** @type {CorrectionWarehouse[]} */
  const result = [];
  for (const marketplaceId of MARKETPLACE_ORDER.filter((id) => involved.has(id))) {
    const known = warehouses.filter((warehouse) => warehouse.marketplaceId === marketplaceId);
    const ids = new Set(known.map((warehouse) => warehouse.externalId));
    // Склад, которого уже нет в списке активных, но на который отправляли.
    for (const row of rows) {
      if (row.marketplaceId === marketplaceId && row.warehouseId && !ids.has(String(row.warehouseId))) {
        ids.add(String(row.warehouseId));
        known.push({ marketplaceId, externalId: String(row.warehouseId), name: `Склад ${row.warehouseId}`, publishing: false });
      }
    }
    // Сначала склады, куда отправляли или где выгрузка включена, затем отключённые.
    const active = (warehouse) => byWarehouse.has(`${marketplaceId}::${warehouse.externalId}`) || warehouse.publishing;
    known.sort((left, right) => Number(active(right)) - Number(active(left)) || left.name.localeCompare(right.name, "ru"));
    for (const warehouse of known) {
      const key = `${marketplaceId}::${warehouse.externalId}`;
      const row = byWarehouse.get(key);
      const levelError = warehouseErrors.get(key) ?? (warehouse.publishing ? marketplaceErrors.get(marketplaceId) : undefined);
      let status;
      let message = null;
      let sentQty = null;
      if (row) {
        status = row.apiStatus;
        message = row.apiMessage ?? null;
        sentQty = row.apiStatus === "success" && row.sentQty !== null && row.sentQty !== undefined ? Number(row.sentQty) : null;
      } else if (levelError) {
        status = levelError.apiStatus === "blocked" ? "blocked" : "error";
        message = levelError.apiMessage ?? null;
      } else if (marketplaceId === "yandex") {
        // Выгрузку остатков на Маркет сервис не делает (ЯНДЕКС.md).
        status = warehouse.publishing ? "unsupported" : "disabled";
      } else {
        status = warehouse.publishing ? "not_sent" : "disabled";
      }
      result.push({ marketplaceId, warehouseId: warehouse.externalId, warehouseName: warehouse.name, status, sentQty, message });
    }
  }

  const failed = result.filter((item) => item.status === "error" || item.status === "blocked").length;
  const succeeded = result.filter((item) => item.status === "success").length;
  const ok = failed === 0;
  return {
    ok,
    title: ok ? CORRECTION_OK_TITLE : CORRECTION_ERROR_TITLE,
    succeeded,
    failed,
    skipped: result.filter((item) => item.status === "skipped").length,
    disabled: result.filter((item) => item.status === "disabled").length,
    warehouses: result,
  };
}

/**
 * Расхождение на складе после проверки: площадка показывает не то, что сервис
 * туда отправил. Смотрим только склады с включённой выгрузкой — на отключённые
 * сервис ничего не шлёт, и сравнивать там не с чем.
 * @param {{ publishing: boolean, status: string, amount: number | null, expectedQty: number | null }} row
 */
export function isCheckMismatch(row) {
  if (!row.publishing || row.expectedQty === null || row.expectedQty === undefined) return false;
  if (row.status === "ok") return Number(row.amount) !== Number(row.expectedQty);
  if (row.status === "missing") return Number(row.expectedQty) > 0;
  return false;
}

/** @param {{ warehouses: CorrectionWarehouse[], ok: boolean }} correction */
function correctionSignature(correction) {
  return `${correction.ok}|${correction.warehouses.map((item) => `${item.marketplaceId}:${item.warehouseId}:${item.status}:${item.sentQty}`).join(",")}`;
}

/**
 * Лента событий по времени.
 *
 * Плановая полная синхронизация идёт каждый час: за неделю это 170 строк,
 * среди которых теряются заказы. Поэтому подряд идущие плановые
 * синхронизации с тем же результатом сворачиваются в одну строку
 * «×N, с … по …».
 *
 * @param {{
 *   orders: Array<{ orderId: string | number, externalOrderId: string, marketplaceId: string, orderedAt: string | null, canceledAt: string | null, cancellationSource: string | null, sellerCancelled: boolean, warehouseId: string | null, warehouseName: string | null, quantity: number, status: string | null }>,
 *   corrections: Array<{ runId: string, trigger: string, actorEmail: string | null, startedAt: string | null, rows: LogRow[], runRows?: LogRow[] }>,
 *   checks: Array<{ id: number, trigger: string, dueAt: string | null, status: string, checkedAt: string | null, message: string | null, rows: Array<{ marketplaceId: string, warehouseId: string, warehouseName: string | null, publishing: boolean, status: string, amount: number | null, reserved: number | null, expectedQty: number | null, message: string | null }> }>,
 *   warehouses: Warehouse[],
 *   marketplaces: string[],
 *   since?: string | null,
 * }} input
 */
export function buildHistory({ orders, corrections, checks, warehouses, marketplaces, since = null }) {
  const sinceMs = since ? timeOf(toIso(since)) : 0;
  const events = [];

  for (const order of orders) {
    const orderedAt = toIso(order.orderedAt);
    const base = {
      marketplaceId: order.marketplaceId,
      externalOrderId: order.externalOrderId,
      warehouseId: order.warehouseId,
      warehouseName: order.warehouseName ?? (order.warehouseId ? `Склад ${order.warehouseId}` : null),
      quantity: Number(order.quantity) || 0,
    };
    if (orderedAt && timeOf(orderedAt) >= sinceMs) {
      events.push({ type: "order", id: `order-${order.orderId}`, at: orderedAt, ...base });
    }
    const canceledAt = toIso(order.canceledAt);
    if (canceledAt && timeOf(canceledAt) >= sinceMs) {
      events.push({
        type: "cancel",
        id: `cancel-${order.orderId}`,
        at: canceledAt,
        ...base,
        source: order.sellerCancelled ? "seller" : order.cancellationSource,
      });
    }
  }

  for (const run of corrections) {
    const at = toIso(run.startedAt) ?? toIso(run.rows[0]?.createdAt ?? null);
    if (!at) continue;
    const kind = correctionKind(run.trigger, run.actorEmail);
    const summary = summarizeCorrection({ rows: run.rows, runRows: run.runRows ?? [], warehouses, marketplaces });
    events.push({
      type: "correction",
      id: `run-${run.runId}`,
      at,
      until: null,
      count: 1,
      runId: run.runId,
      kind,
      label: CORRECTION_LABELS[kind] ?? kind,
      actorEmail: run.actorEmail,
      ...summary,
    });
  }

  for (const check of checks) {
    if (check.status === "pending" || check.status === "running") {
      const at = toIso(check.dueAt);
      if (at) events.push({ type: "check_pending", id: `check-${check.id}`, at, trigger: check.trigger });
      continue;
    }
    const at = toIso(check.checkedAt) ?? toIso(check.dueAt);
    if (!at) continue;
    const rows = [...check.rows]
      .map((row) => ({ ...row, mismatch: isCheckMismatch(row) }))
      .sort((left, right) => MARKETPLACE_ORDER.indexOf(left.marketplaceId) - MARKETPLACE_ORDER.indexOf(right.marketplaceId)
        || Number(right.mismatch) - Number(left.mismatch)
        || Number(right.publishing) - Number(left.publishing)
        || String(left.warehouseName ?? "").localeCompare(String(right.warehouseName ?? ""), "ru"));
    events.push({
      type: "check",
      id: `check-${check.id}`,
      at,
      trigger: check.trigger,
      status: check.status,
      message: check.message,
      mismatches: rows.filter((row) => row.mismatch).length,
      errors: rows.filter((row) => row.status === "error").length,
      rows,
    });
  }

  // Внутри одной минуты порядок цикла важнее секунд: заказ, затем корректировка, затем проверка.
  const rank = { order: 0, cancel: 1, correction: 2, check: 3, check_pending: 4 };
  events.sort((left, right) => timeOf(left.at) - timeOf(right.at) || rank[left.type] - rank[right.type]);

  const merged = [];
  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (
      event.type === "correction"
      && event.kind === "scheduled_full_sync"
      && previous?.type === "correction"
      && previous.kind === "scheduled_full_sync"
      && correctionSignature(previous) === correctionSignature(event)
    ) {
      previous.count += 1;
      previous.until = event.at;
      continue;
    }
    merged.push(event);
  }
  return merged;
}
