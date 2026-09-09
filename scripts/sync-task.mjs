#!/usr/bin/env node
/**
 * Фоновая синхронизация по расписанию.
 *
 * На прежнем хостинге фоновых задач не было вовсе, и цикл синхронизации вела
 * вкладка браузера: закрыл вкладку — синхронизация оборвалась. На своём сервере
 * этот скрипт запускается таймером systemd и делает ровно то же, что делала
 * вкладка, только без человека.
 *
 * Запуск:
 *   node scripts/sync-task.mjs orders   — подтянуть заказы, пересчитать резервы
 *                                         и сразу доотправить изменившиеся остатки
 *   node scripts/sync-task.mjs stocks   — полная выгрузка остатков на площадки
 *
 * Скрипт обращается к собственному HTTP-API приложения со служебным токеном:
 * так используется тот же самый проверенный код, что и при ручном запуске,
 * а не вторая копия логики, которая со временем разошлась бы с первой.
 */

const APP_URL = (process.env.APP_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.SYNC_TASK_TOKEN ?? "";
const MAX_RATE_LIMIT_WAITS = 6;
const MAX_WAIT_SECONDS = 180;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/** Ручная остановка выгрузки — это не сбой, а осознанное решение оператора. */
class SyncPausedError extends Error {}

function fail(message) {
  console.error(`[${new Date().toISOString()}] ОШИБКА: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, body) {
  const response = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

/** Выполняет шаг, дожидаясь, если площадка попросила подождать. */
async function step(body, describe) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_WAITS; attempt += 1) {
    const { status, data } = await call("/api/stocks/sync-all", body);

    if (status === 429 && typeof data.retryAfterSeconds === "number") {
      const seconds = Math.min(Math.max(1, data.retryAfterSeconds), MAX_WAIT_SECONDS);
      log(`${describe}: площадка просит подождать ${seconds} с`);
      await sleep(seconds * 1000);
      continue;
    }

    // Стоп-кран включён на вкладке «Остатки»: отправлять на площадки нечего.
    if (status === 423 && data.stockSyncPaused) {
      throw new SyncPausedError(data.error ?? "Выгрузка остатков остановлена вручную.");
    }

    // Массовое обнуление подтверждает только человек. Фоновая задача обязана
    // остановиться: почти всегда это признак неполных данных, а не пустого склада.
    if (status === 409 && data.needsMassZeroConfirmation) {
      fail(
        `расчёт даёт ноль по ${data.zeroCount} из ${data.totalCount} позиций. ` +
        "Автоматическая выгрузка остановлена. Проверьте последнюю ОСВ и загрузку заказов, " +
        "затем запустите синхронизацию вручную.",
      );
    }

    if (status >= 400 && status !== 207) {
      throw new Error(`${describe}: ${data.error ?? `ответ ${status}`}`);
    }
    return data;
  }
  throw new Error(`${describe}: площадка слишком долго ограничивает частоту запросов.`);
}

async function syncOrders() {
  log("Загружаю заказы и пересчитываю резервы…");
  const { status, data } = await call("/api/orders/sync", { days: 30, force: true });
  if (status >= 400 && status !== 207) fail(data.error ?? `ответ ${status}`);
  const reserved = data.reservations?.reservedQuantity;
  log(`Заказы загружены. Активный резерв: ${reserved ?? "не пересчитан"}.`);
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    for (const error of data.errors) log(`Замечание: ${error.marketplace} — ${error.message}`);
    process.exitCode = 2;
  }
  await pushChangedStocks();
}

/**
 * Доотправка остатков по изменившимся позициям.
 *
 * Смысл: заказ на одной площадке должен как можно быстрее уменьшить остаток на
 * всех остальных. Ждать часовой выгрузки нельзя — за это время товар успевают
 * заказать повторно. Отправляются только те артикулы, у которых при пересчёте
 * изменился резерв, поэтому запуск дешёвый и его не жалко делать часто.
 */
async function pushChangedStocks() {
  const { status, data } = await call("/api/stocks/sync-pending", {});
  if (status === 423 && data.stockSyncPaused) {
    log("Выгрузка остатков остановлена вручную — доотправка пропущена.");
    return;
  }
  if (status >= 400 && status !== 207) {
    log(`Доотправка остатков не выполнена: ${data.error ?? `ответ ${status}`}`);
    process.exitCode = 2;
    return;
  }
  if (!data.selected) {
    log("Изменившихся позиций нет — доотправлять нечего.");
    return;
  }
  const wb = data.wildberries?.sent ?? 0;
  const ozon = data.ozon?.sent ?? 0;
  log(`Доотправка: позиций ${data.selected}, WB ${wb}, Ozon ${ozon}. В очереди осталось: ${data.pendingLeft ?? 0}.`);
  if (Array.isArray(data.failures) && data.failures.length > 0) {
    for (const failure of data.failures) log(`Замечание: ${failure}`);
    process.exitCode = 2;
  }
}

async function syncStocks() {
  log("Запускаю полную синхронизацию остатков…");
  const plan = await step({ action: "start" }, "Старт");
  const jobId = plan.jobId;
  if (!jobId) fail("сервер не выдал идентификатор синхронизации.");

  let finished = false;
  try {
    for (const [index, warehouse] of (plan.wildberries?.warehouses ?? []).entries()) {
      if (!plan.wildberries.mappingCount) break;
      log(`Wildberries: склад ${index + 1} из ${plan.wildberries.warehouses.length} — ${warehouse.name}`);
      await step({ action: "wildberries", jobId, warehouseId: warehouse.externalId }, "Wildberries");
    }

    let offset = 0;
    const ozon = plan.ozon ?? { warehouses: [], mappingCount: 0, batchSize: 100 };
    while (ozon.warehouses.length > 0 && ozon.mappingCount > 0 && offset < ozon.mappingCount) {
      log(`Ozon: товары ${offset + 1}–${Math.min(offset + ozon.batchSize, ozon.mappingCount)} из ${ozon.mappingCount}`);
      const result = await step({ action: "ozon", jobId, offset }, "Ozon");
      const next = Number(result.nextOffset);
      if (result.done && next === offset) break;
      if (!Number.isInteger(next) || next <= offset) throw new Error("Ozon не вернул следующий пакет.");
      offset = next;
      if (result.done) break;
    }

    const summary = await step({ action: "finish", jobId }, "Итог");
    finished = true;
    log(
      `Готово. WB: ${summary.wildberries.completedWarehouseCount} из ${summary.wildberries.warehouseCount} складов, ` +
      `отправлено ${summary.wildberries.sent}. Ozon: обработано ${summary.ozon.processedMappings} из ${summary.ozon.mappingCount}, ` +
      `отправлено ${summary.ozon.sent}.`,
    );
    if (summary.ozon.reserveDrift) {
      log(`Внимание: по ${summary.ozon.reserveDrift} позициям резерв Ozon больше нашего — проверьте загрузку заказов.`);
      process.exitCode = 2;
    }
    if (!summary.ok) {
      const failure = [...summary.wildberries.failures, ...summary.ozon.failures][0];
      log(`Синхронизация завершена частично: ${failure?.message ?? "см. журнал выгрузки"}`);
      process.exitCode = 2;
    }
  } finally {
    if (!finished) {
      // Не оставляем висящее задание: иначе следующий запуск упрётся в блокировку.
      await call("/api/stocks/sync-all", { action: "cancel", jobId }).catch(() => undefined);
    }
  }
}

async function main() {
  if (!TOKEN) fail("не задан SYNC_TASK_TOKEN. Добавьте его в .env приложения.");
  const action = process.argv[2];
  if (action === "orders") return syncOrders();
  if (action === "stocks") return syncStocks();
  fail("укажите режим: orders или stocks.");
}

main().catch((error) => {
  if (error instanceof SyncPausedError) {
    log(`Выгрузка остатков остановлена вручную — запуск пропущен. ${error.message}`);
    process.exit(0);
  }
  fail(error instanceof Error ? error.message : String(error));
});
