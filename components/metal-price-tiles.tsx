"use client";

/**
 * Два крупных показателя вверху дашбордов: золото и серебро за грамм в рублях.
 *
 * Цены приносит фоновая задача раз в 2 часа. Экран сам перечитывает их раз в
 * 10 минут, чтобы открытая вкладка не показывала вчерашнее. Если последняя
 * попытка не удалась или цене больше трёх часов — это написано прямо на
 * плитке: устаревшая цена без пометки хуже, чем никакой.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";

import type { MetalPrices, MetalQuote } from "@/lib/metal-prices";
import { formatMoment } from "@/lib/utils";

const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
const REFRESH_EVERY_MS = 10 * 60 * 1000;

// Время всегда по Москве: страница рисуется и на сервере, и в браузере, и
// разные часовые пояса дали бы разный текст.
const MOSCOW: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" };

const rub = (value: number, digits: number) => value.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function Tile({ title, quote, digits, accent }: { title: string; quote: MetalQuote | null; digits: number; accent: string }) {
  const up = (quote?.change ?? 0) > 0;
  const down = (quote?.change ?? 0) < 0;
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-5">
      <div className={`absolute inset-y-0 left-0 w-1.5 ${accent}`} aria-hidden="true" />
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {quote ? (
        <>
          <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums md:text-5xl">
            {rub(quote.last, digits)} <span className="text-2xl font-semibold text-muted-foreground md:text-3xl">₽/г</span>
          </p>
          <p className={`mt-2 flex items-center gap-1 text-sm tabular-nums ${up ? "text-emerald-700" : down ? "text-red-700" : "text-muted-foreground"}`}>
            {up ? <TrendingUp className="size-4" /> : down ? <TrendingDown className="size-4" /> : null}
            {quote.change !== null ? `${quote.change > 0 ? "+" : ""}${rub(quote.change, digits)} ₽` : "—"}
            {quote.changePercent !== null ? ` (${quote.changePercent > 0 ? "+" : ""}${rub(quote.changePercent, 2)}%)` : ""}
            <span className="text-muted-foreground">{quote.time ? ` · котировка ${quote.time.slice(0, 5)} МСК` : ""}</span>
          </p>
        </>
      ) : (
        <p className="mt-2 text-2xl font-semibold text-muted-foreground">нет данных</p>
      )}
    </div>
  );
}

export function MetalPriceTiles({ initial }: { initial: MetalPrices }) {
  const [prices, setPrices] = useState(initial);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      void fetch("/api/metal-prices", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() as Promise<MetalPrices> : null))
        .then((data) => { if (data) setPrices(data); })
        .catch(() => undefined);
    }, REFRESH_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  const fetchedAt = prices.fetchedAt ? Date.parse(prices.fetchedAt) : NaN;
  const stale = !Number.isFinite(fetchedAt) || now - fetchedAt > STALE_AFTER_MS;
  const failedLast = Boolean(prices.error);

  return (
    <section className="mx-auto max-w-[1520px] px-4 pt-4 md:px-7 md:pt-7">
      <div className="grid gap-4 md:grid-cols-2">
        <Tile title="Золото · ProFinance, XAU/RUB за грамм" quote={prices.gold} digits={2} accent="bg-amber-400" />
        <Tile title="Серебро · ProFinance, XAG/RUB за грамм" quote={prices.silver} digits={2} accent="bg-slate-400" />
      </div>
      <p className={`mt-2 flex flex-wrap items-center gap-1 text-xs ${stale || failedLast ? "text-amber-800" : "text-muted-foreground"}`}>
        {stale || failedLast ? <AlertTriangle className="size-3.5" /> : null}
        {prices.fetchedAt ? `Обновлено ${formatMoment(prices.fetchedAt, MOSCOW)}` : "Цены ещё не загружались"}
        {" · обновляется автоматически каждые 2 часа"}
        {failedLast && prices.attemptedAt ? ` · последняя попытка ${formatMoment(prices.attemptedAt, MOSCOW)} не удалась: ${prices.error}` : ""}
        {!failedLast && stale && prices.fetchedAt ? " · цене больше 3 часов" : ""}
      </p>
    </section>
  );
}
