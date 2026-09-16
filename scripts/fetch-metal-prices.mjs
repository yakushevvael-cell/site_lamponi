#!/usr/bin/env node
/**
 * Цены на золото и серебро за грамм в рублях с ProFinance — раз в 2 часа.
 *
 * Таблицу «Расчётные цены на драгоценные металлы в рублях за 1 грамм» на
 * странице заполняет её собственный скрипт, в исходном HTML цен нет. Поэтому
 * страница открывается во встроенном браузере (Chromium без окна), как у
 * человека, и цены читаются из уже нарисованной таблицы. Шифрованный поток
 * котировок не разбирается — только то, что видно на странице.
 *
 * Результат уходит в приложение через его API со служебным токеном — так же,
 * как у синхронизации заказов. Сбой не стирает прошлую цену: на дашборде
 * останется последнее удачное значение с временем и пометкой.
 *
 * Запуск: node scripts/fetch-metal-prices.mjs
 * Браузер: PLAYWRIGHT_BROWSERS_PATH (ставится командой playwright-core install).
 */
import { chromium } from "playwright-core";

import { extractMetalPrices, METAL_SOURCE_URL } from "../lib/metal-prices-core.mjs";

const APP_URL = (process.env.APP_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.SYNC_TASK_TOKEN ?? "";
const SOURCE_URL = process.env.METAL_SOURCE_URL || METAL_SOURCE_URL;
const ATTEMPTS = 2;
const PAGE_TIMEOUT_MS = 60_000;

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readTableRows() {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
  try {
    const context = await browser.newContext({
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      viewport: { width: 1366, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    // Картинки, шрифты и видео для цен не нужны — страница грузится быстрее
    // и не тянет рекламу мегабайтами.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      return ["image", "media", "font"].includes(type) ? route.abort() : route.continue();
    });

    await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      const filled = (ticker) => rows.some((row) => row.cells[0]?.textContent?.trim() === ticker
        && /\d/.test(row.cells[3]?.textContent ?? ""));
      return filled("XAU/RUB") && filled("XAG/RUB");
    }, null, { timeout: PAGE_TIMEOUT_MS, polling: 500 }).catch(() => undefined);

    return await page.$$eval("tr", (rows) => rows.map((row) => Array.from(row.cells).map((cell) => cell.textContent?.trim() ?? "")));
  } finally {
    await browser.close();
  }
}

async function report(body) {
  if (!TOKEN) throw new Error("Не задан SYNC_TASK_TOKEN — некуда сохранить цены.");
  const response = await fetch(`${APP_URL}/api/metal-prices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Приложение не приняло цены: ${data.error ?? response.status}`);
}

async function main() {
  let lastError = "неизвестная ошибка";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const rows = await readTableRows();
      const result = extractMetalPrices(rows);
      if (result.ok) {
        await report({ ok: true, gold: result.gold, silver: result.silver, source: SOURCE_URL });
        log(`Золото ${result.gold.last} ₽/г, серебро ${result.silver.last} ₽/г (${result.gold.time ?? "без времени"})`);
        return;
      }
      lastError = result.error;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    log(`Попытка ${attempt}: ${lastError}`);
    if (attempt < ATTEMPTS) await sleep(30_000);
  }

  await report({ ok: false, error: lastError.slice(0, 500), source: SOURCE_URL }).catch((error) => {
    log(`Не удалось сообщить об ошибке: ${error instanceof Error ? error.message : error}`);
  });
  console.error(`[${new Date().toISOString()}] ОШИБКА: цены не получены — ${lastError}`);
  process.exit(1);
}

await main();
