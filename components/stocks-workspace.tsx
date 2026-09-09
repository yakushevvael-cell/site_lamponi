"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Boxes, CloudUpload, Layers, Loader2, PackageCheck, Play, PowerOff, RefreshCw, Ruler, Search, ShieldAlert, ShoppingCart, Warehouse, Zap } from "lucide-react";
import { toast } from "sonner";

import { describeSummary, readSyncState, runFullStockSync } from "@/lib/stock-sync-client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type StockRow = {
  variantKey: string;
  sku: string;
  size: string | null;
  physicalQuantity: number;
  unitsPerItem: number;
  reservedQuantity: number;
  safetyStock: number;
  availableQuantity: number;
  manualZero: number | boolean;
  manualZeroAt: string | null;
  updatedAt: string;
};

type StockTotals = {
  articleCount: number;
  skuCount: number;
  sizedVariantCount: number;
  physicalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  zeroStockCount: number;
  manualZeroCount: number;
};

/** Строка отчёта выборочной синхронизации: что посчитали и что ушло на площадку. */
type SelectedSyncRow = {
  marketplaceId: "wildberries" | "ozon";
  warehouseId: string;
  warehouseName: string;
  sourceSku: string;
  externalSku: string;
  size: string | null;
  osvQty: number;
  reserveQty: number;
  computedQty: number;
  sentQty: number;
  status: "success" | "error" | "skipped" | "blocked";
  message: string | null;
};

type SelectedSyncResult = {
  ok: boolean;
  selected: number;
  unmapped: string[];
  wildberries: { warehouseCount: number; mappingCount: number; sent: number };
  ozon: { warehouseCount: number; mappingCount: number; sent: number; reserveDrift: number };
  failures: string[];
  rows: SelectedSyncRow[];
};

type StockSyncPause = {
  paused: boolean;
  changedAt: string | null;
  changedBy: string | null;
  reason: string | null;
};

const marketplaceLabel = { wildberries: "Wildberries", ozon: "Ozon" } as const;

const statusLabel = {
  success: "Отправлено",
  error: "Ошибка",
  skipped: "Пропущено",
  blocked: "Заблокировано",
} as const;

const emptyTotals: StockTotals = {
  articleCount: 0,
  skuCount: 0,
  sizedVariantCount: 0,
  physicalQuantity: 0,
  reservedQuantity: 0,
  availableQuantity: 0,
  zeroStockCount: 0,
  manualZeroCount: 0,
};

function StatusBadge({ row }: { row: StockRow }) {
  if (row.manualZero) return <Badge variant="destructive">Обнулено вручную</Badge>;
  if (row.availableQuantity <= 0) return <Badge variant="secondary">Нет в наличии</Badge>;
  if (row.availableQuantity < 5) return <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Мало</Badge>;
  return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">В наличии</Badge>;
}

export function StocksWorkspace({ canSyncAll, canSyncSelected }: { canSyncAll: boolean; canSyncSelected: boolean }) {
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [totals, setTotals] = useState<StockTotals>(emptyTotals);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [unfinishedRun, setUnfinishedRun] = useState<{ startedAt: string | null; stale: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncingSelected, setSyncingSelected] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SelectedSyncResult | null>(null);
  const [pause, setPause] = useState<StockSyncPause | null>(null);
  const [pending, setPending] = useState(0);
  const [unitsOpen, setUnitsOpen] = useState(false);
  const [unitsValue, setUnitsValue] = useState("2");
  const [savingUnits, setSavingUnits] = useState(false);
  const [pushingPending, setPushingPending] = useState(false);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async (search: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/stocks?q=${encodeURIComponent(search)}&limit=5000`, { cache: "no-store" });
      const data = await response.json() as { stocks?: StockRow[]; totals?: StockTotals; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить остатки.");
      setStocks(data.stocks ?? []);
      setTotals(data.totals ?? emptyTotals);
      setSelected(new Set());
    } catch (error) {
      toast.error("Остатки не загружены", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => load("")); }, [load]);

  // Состояние стоп-крана: пока выгрузка на паузе, кнопки отправки заблокированы.
  useEffect(() => {
    void fetch("/api/stocks/pause", { cache: "no-store" })
      .then((response) => response.json())
      .then((state: StockSyncPause) => setPause(state))
      .catch(() => undefined);
  }, []);

  // Очередь доотправки: позиции, у которых изменился резерв после заказов.
  const loadPending = useCallback(async () => {
    try {
      const response = await fetch("/api/stocks/sync-pending", { cache: "no-store" });
      const data = await response.json() as { pending?: number };
      setPending(Number(data.pending ?? 0));
    } catch {
      // Индикатор вспомогательный: без него страница работает как раньше.
    }
  }, []);

  useEffect(() => { void loadPending(); }, [loadPending]);

  // Автоподхват: цикл синхронизации ведёт вкладка браузера, поэтому закрытая
  // вкладка оставляет запуск незавершённым. Показываем его администратору,
  // а не ждём, пока истечёт получасовая блокировка.
  useEffect(() => {
    if (!canSyncAll) return;
    void readSyncState()
      .then((state) => {
        if (state?.jobId && state.ownedByMe) setUnfinishedRun({ startedAt: state.startedAt, stale: state.stale });
      })
      .catch(() => undefined);
  }, [canSyncAll]);
  const paused = pause?.paused ?? false;
  const allSelected = stocks.length > 0 && stocks.slice(0, 50).every((row) => selected.has(row.variantKey));
  const selectedRows = useMemo(() => stocks.filter((row) => selected.has(row.variantKey)), [selected, stocks]);
  const canRestore = selectedRows.some((row) => Boolean(row.manualZero));

  function toggle(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function applyManualZero(action: "zero" | "restore") {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const response = await fetch("/api/stocks/manual-zero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sourceSkus: [...selected] }),
      });
      const data = await response.json() as { error?: string; selected?: number; unmapped?: string[]; errors?: string[] };
      if (!response.ok && response.status !== 207) throw new Error(data.error ?? "Операция не выполнена.");
      if (action === "zero") {
        const description = data.unmapped?.length
          ? `Обнулено локально: ${data.selected ?? selected.size}. Без соответствия на площадках: ${data.unmapped.length}.`
          : `Обнулено позиций: ${data.selected ?? selected.size}.`;
        if (response.status === 207) toast.warning("Обнуление выполнено частично", { description: data.errors?.join(" ") || description });
        else toast.success("Выбранные остатки обнулены", { description });
      } else {
        toast.success("Ручное обнуление снято", { description: "Положительный остаток на площадки не отправлялся." });
      }
      await load(query);
    } catch (error) {
      toast.error("Не удалось изменить остаток", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSaving(false);
    }
  }

  /** Стоп-кран: включение и снятие общей паузы выгрузки остатков. */
  async function toggleStockSync(next: boolean) {
    setSwitching(true);
    try {
      const response = await fetch("/api/stocks/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      const data = await response.json() as StockSyncPause & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось изменить режим выгрузки.");
      setPause(data);
      if (next) toast.success("Выгрузка остатков остановлена", { description: "Отправка на WB и Ozon прекращена. Ключи и настройки складов сохранены." });
      else toast.success("Выгрузка остатков возобновлена", { description: "Отправка на площадки снова разрешена." });
    } catch (error) {
      toast.error("Не удалось переключить выгрузку", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSwitching(false);
    }
  }

  /**
   * Кратность позиции: сколько единиц ОСВ составляют один товар на площадке.
   * Проставляется пачкой — по отмеченным строкам или сразу по всему, что нашёл поиск.
   */
  async function applyUnits(scope: "selected" | "search") {
    const parsed = Math.trunc(Number(unitsValue));
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      toast.error("Некорректная кратность", { description: "Введите целое число от 1 до 100." });
      return;
    }
    setSavingUnits(true);
    try {
      const response = await fetch("/api/stocks/units", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope === "selected"
          ? { unitsPerItem: parsed, scope: "selected", sourceSkus: [...selected] }
          : { unitsPerItem: parsed, scope: "search", query }),
      });
      const data = await response.json() as { updated?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось изменить кратность.");
      toast.success("Кратность обновлена", { description: `Позиций: ${data.updated ?? 0}. Новое значение: ${parsed}.` });
      setUnitsOpen(false);
      await load(query);
      await loadPending();
    } catch (error) {
      toast.error("Кратность не изменена", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSavingUnits(false);
    }
  }

  /** Ручной запуск доотправки: обычно её делает планировщик каждые 15 минут. */
  async function pushPendingStocks() {
    setPushingPending(true);
    try {
      const response = await fetch("/api/stocks/sync-pending", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await response.json() as { ok?: boolean; selected?: number; pendingLeft?: number; failures?: string[]; error?: string };
      if (!response.ok && response.status !== 207) throw new Error(data.error ?? "Доотправка не выполнена.");
      if (!data.selected) toast.info("Доотправлять нечего", { description: "С прошлой выгрузки остатки не менялись." });
      else if (data.ok) toast.success("Изменившиеся остатки отправлены", { description: `Позиций: ${data.selected}.` });
      else toast.warning("Отправлено частично", { description: data.failures?.[0] ?? `Позиций: ${data.selected}.` });
      await loadPending();
      await load(query);
    } catch (error) {
      toast.error("Не удалось доотправить остатки", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setPushingPending(false);
    }
  }

  /**
   * Выборочная синхронизация: одна операция по отмеченным позициям.
   * Полная синхронизация идёт заданием в несколько шагов, здесь этого не нужно —
   * выбор ограничен полусотней строк и укладывается в один запрос.
   */
  async function syncSelectedStocks() {
    if (selected.size === 0) return;
    setSyncingSelected(true);
    try {
      const response = await fetch("/api/stocks/sync-selected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSkus: [...selected] }),
      });
      const data = await response.json() as SelectedSyncResult & { error?: string };
      if (!response.ok && response.status !== 207) throw new Error(data.error ?? "Синхронизация не выполнена.");
      setSelectedResult(data);
      const sent = data.wildberries.sent + data.ozon.sent;
      if (data.ok) toast.success("Выбранные остатки отправлены", { description: `Позиций: ${data.selected}. Отправлено значений: ${sent}.` });
      else toast.warning("Отправлено частично", { description: data.failures[0] ?? `Отправлено значений: ${sent}.` });
      await load(query);
    } catch (error) {
      toast.error("Не удалось синхронизировать выбранные", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSyncingSelected(false);
    }
  }

  async function syncAllStocks() {
    setUnfinishedRun(null);
    setSyncingAll(true);
    try {
      const summary = await runFullStockSync({
        onProgress: setSyncProgress,
        // Массовое обнуление подтверждает человек: автоматически такой запуск не идёт.
        onMassZero: (info) => window.confirm(`${info.message}\n\nОтправить нули на площадки?`),
      });
      const description = describeSummary(summary);
      if (summary.ok) {
        toast.success("Все остатки синхронизированы", { description });
      } else {
        const failure = [...summary.wildberries.failures, ...summary.ozon.failures][0]?.message;
        toast.warning("Синхронизация завершена частично", { description: failure ? `${description} ${failure}` : description });
      }
      await load(query);
    } catch (error) {
      toast.error("Не удалось синхронизировать все остатки", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSyncingAll(false);
      setSyncProgress("");
    }
  }

  return (
    <div className="mx-auto max-w-[1520px] space-y-5 p-4 md:p-7">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {[
          { label: "Артикулов", value: totals.articleCount, icon: Boxes },
          { label: "Позиций", value: totals.skuCount, icon: Ruler },
          { label: "С размерами", value: totals.sizedVariantCount, icon: Ruler },
          { label: "Физически", value: totals.physicalQuantity, icon: Warehouse },
          { label: "В резерве", value: totals.reservedQuantity, icon: ShoppingCart },
          { label: "Обнулено вручную", value: totals.manualZeroCount, icon: Ban },
        ].map((item) => (
          <Card key={item.label} className="gap-0 border-border/80 py-5">
            <CardContent className="flex items-center justify-between px-5">
              <div><p className="text-sm text-muted-foreground">{item.label}</p><p className="mt-2 text-2xl font-semibold">{Number(item.value).toLocaleString("ru-RU")}</p></div>
              <span className="grid size-10 place-items-center rounded-xl bg-secondary"><item.icon className="size-[18px]" /></span>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4">
        <p className="text-sm font-semibold text-blue-950">{canSyncAll ? "Полная синхронизация остатков доступна" : "Просмотр, загрузка ОСВ и ручное обнуление доступны"}</p>
        <p className="mt-1 text-xs leading-5 text-blue-800">
          Доступный остаток рассчитывается из ОСВ с учётом активных резервов, страхового запаса и ручного обнуления. Кнопка отправляет рассчитанные значения на все подключённые склады WB и Ozon.
        </p>
        <p className="mt-2 text-xs leading-5 text-blue-800">
          После каждой загрузки заказов (каждые 15 минут) остаток по позициям, у которых изменился резерв, уходит на площадки отдельно — не дожидаясь часовой выгрузки.
          {pending > 0 ? ` Сейчас ждут отправки: ${pending}.` : " Сейчас очередь пуста."}
        </p>
        {canSyncSelected && !paused ? (
          <Button variant="outline" size="sm" className="mt-3 bg-white" onClick={() => void pushPendingStocks()} disabled={pushingPending || syncingAll || syncingSelected}>
            {pushingPending ? <Loader2 className="animate-spin" /> : <Zap />}
            {pushingPending ? "Отправляем…" : "Доотправить изменившиеся сейчас"}
          </Button>
        ) : null}
        {syncProgress ? <p className="mt-2 flex items-center gap-2 text-xs font-medium text-blue-950"><Loader2 className="size-3.5 animate-spin" />{syncProgress}</p> : null}
      </section>

      {unfinishedRun && !syncingAll ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-amber-950">Найдена незавершённая синхронизация</p>
            <p className="mt-1 text-xs leading-5 text-amber-900">
              Запуск от {unfinishedRun.startedAt ? new Date(unfinishedRun.startedAt).toLocaleString("ru-RU") : "неизвестного времени"} не был доведён до конца — вероятно, вкладка закрылась.
              Часть складов могла остаться со старыми остатками. Запустите синхронизацию заново: отправляются абсолютные значения, поэтому повтор безопасен.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setUnfinishedRun(null)}>Скрыть</Button>
            <Button onClick={() => void syncAllStocks()}>Запустить заново</Button>
          </div>
        </section>
      ) : null}

      {paused ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-red-950"><ShieldAlert className="size-4" />Выгрузка остатков на площадки остановлена</p>
            <p className="mt-1 text-xs leading-5 text-red-900">
              Сервис не отправляет остатки на Wildberries и Ozon: ни по расписанию, ни вручную. Заказы продолжают загружаться, API-ключи и настройки складов сохранены.
              {pause?.changedAt ? ` Остановлено ${new Date(pause.changedAt).toLocaleString("ru-RU")}` : ""}
              {pause?.changedBy ? `, пользователь ${pause.changedBy}.` : pause?.changedAt ? "." : ""}
            </p>
          </div>
          {canSyncAll ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={switching}>{switching ? <Loader2 className="animate-spin" /> : <Play />}Возобновить выгрузку</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Возобновить выгрузку остатков?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Отправка остатков на WB и Ozon снова станет доступна — вручную и по расписанию. Сразу после включения площадки получат остатки при ближайшей синхронизации.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Отмена</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void toggleStockSync(false)}><Play />Возобновить</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </section>
      ) : null}

      <Card className="gap-0 overflow-hidden border-border/80 py-0">
        <div className="flex flex-col gap-3 border-b px-4 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void load(query); }}
              placeholder="Артикул или размер…"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs text-muted-foreground">Выбрано: {selected.size}</span>
            <Button variant="outline" onClick={() => void applyManualZero("restore")} disabled={!canRestore || saving || syncingAll || syncingSelected || paused}>
              {saving ? <Loader2 className="animate-spin" /> : <RefreshCw />}Снять обнуление
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="destructive" disabled={selected.size === 0 || saving || syncingAll || syncingSelected || paused}><Ban />Обнулить выбранные</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Обнулить {selected.size} позиций?</AlertDialogTitle>
                  <AlertDialogDescription>Сервис установит доступный остаток 0 для выбранных сочетаний «артикул + размер» и отправит ноль только по найденным соответствиям WB и Ozon. Физический остаток ОСВ сохранится.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Отмена</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void applyManualZero("zero")} variant="destructive">Установить ноль</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {canSyncSelected ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="secondary" disabled={selected.size === 0 || saving || syncingAll || syncingSelected || paused}>
                    {syncingSelected ? <Loader2 className="animate-spin" /> : <PackageCheck />}
                    {syncingSelected ? "Отправляем…" : "Синхронизировать выбранные"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Синхронизировать {selected.size} позиций?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Сервис пересчитает резервы по текущим заказам и отправит остаток только по выбранным позициям — на все включённые склады WB и Ozon.
                      Формула та же, что и при полной синхронизации: ОСВ минус активные резервы, минус страховой запас, с учётом ручного обнуления.
                      Остальной ассортимент не затрагивается.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Отмена</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void syncSelectedStocks()}><PackageCheck />Отправить выбранные</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            {canSyncAll ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button disabled={saving || syncingAll || syncingSelected || paused}>{syncingAll ? <Loader2 className="animate-spin" /> : <CloudUpload />}{syncingAll ? "Синхронизация…" : "Синхронизировать все остатки"}</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Синхронизировать все остатки?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Сервис перезапишет остатки всех сопоставленных товаров на всех подключённых складах WB и Ozon. Будут использованы текущая ОСВ, активные резервы, страховой запас и ручные обнуления.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Отмена</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void syncAllStocks()}><CloudUpload />Начать синхронизацию</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
            ) : null}
            {canSyncAll && !paused ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800" disabled={switching || syncingAll || syncingSelected}>
                    {switching ? <Loader2 className="animate-spin" /> : <PowerOff />}Остановить выгрузку
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Остановить выгрузку остатков на площадки?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Сервис перестанет отправлять остатки по всем артикулам на все склады Wildberries и Ozon — и вручную, и по расписанию.
                      API-ключи, склады и сопоставления остаются на месте, заказы продолжат загружаться. На площадках останутся те остатки, которые были отправлены последними.
                      Включить обратно можно этой же кнопкой в любой момент.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Отмена</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void toggleStockSync(true)} variant="destructive"><PowerOff />Остановить</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            {canSyncSelected ? (
              <Button variant="outline" onClick={() => setUnitsOpen(true)} disabled={loading || savingUnits}><Layers />Кратность позиции</Button>
            ) : null}
            <Button variant="outline" onClick={() => void load(query)} disabled={loading || syncingAll || syncingSelected}><RefreshCw className={loading ? "animate-spin" : ""} />Обновить</Button>
            <Button variant="outline" asChild><a href="/upload">Загрузить ОСВ</a></Button>
          </div>
        </div>
        <div className="min-h-72 overflow-x-auto">
          {loading ? (
            <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем остатки…</div>
          ) : stocks.length === 0 ? (
            <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">Остатки не найдены.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 pl-5"><Checkbox checked={allSelected} onCheckedChange={(checked) => setSelected(checked ? new Set(stocks.slice(0, 50).map((row) => row.variantKey)) : new Set())} aria-label="Выбрать строки" /></TableHead>
                  <TableHead>Артикул из 1С</TableHead><TableHead>Размер</TableHead><TableHead className="text-right">Физически</TableHead><TableHead className="text-right">Ед. в товаре</TableHead><TableHead className="text-right">Резерв</TableHead><TableHead className="text-right">Доступно</TableHead><TableHead className="pr-5 text-right">Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stocks.map((row) => (
                  <TableRow key={row.variantKey} data-state={selected.has(row.variantKey) ? "selected" : undefined}>
                    <TableCell className="pl-5"><Checkbox checked={selected.has(row.variantKey)} disabled={!selected.has(row.variantKey) && selected.size >= 50} onCheckedChange={(checked) => toggle(row.variantKey, Boolean(checked))} aria-label={`Выбрать ${row.sku} ${row.size ?? "без размера"}`} /></TableCell>
                    <TableCell className="font-mono text-xs font-semibold">{row.sku}</TableCell>
                    <TableCell>{row.size ? <Badge variant="outline">{row.size}</Badge> : <span className="text-xs text-muted-foreground">Без размера</span>}</TableCell>
                    <TableCell className="text-right">{Number(row.physicalQuantity).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right">
                      {Number(row.unitsPerItem ?? 1) > 1
                        ? <Badge className="bg-sky-100 text-sky-900 hover:bg-sky-100">{Number(row.unitsPerItem)}</Badge>
                        : <span className="text-xs text-muted-foreground">1</span>}
                    </TableCell>
                    <TableCell className="text-right text-violet-700">{Number(row.reservedQuantity).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right font-semibold">{Number(row.availableQuantity).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="pr-5 text-right"><StatusBadge row={row} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>

      <AlertDialog open={unitsOpen} onOpenChange={(open) => { if (!savingUnits) setUnitsOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Кратность позиции</AlertDialogTitle>
            <AlertDialogDescription>
              Сколько единиц из ОСВ составляют один товар на площадке. Серьги в 1С лежат штуками, а продаются парой — для них 2:
              остаток «10 штук» станет 5 товарами. Для остального ассортимента 1, то есть как в ОСВ.
              Резерв по заказам и страховой запас не пересчитываются — они и так в единицах площадки.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">Единиц ОСВ в одном товаре</p>
            <Input
              type="number"
              min={1}
              max={100}
              value={unitsValue}
              onChange={(event) => setUnitsValue(event.target.value)}
              className="w-28"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              Быстрый способ: наберите в поиске нужный признак (например, «С» для серёг), проверьте, что в таблице остались только они,
              и примените ко всему найденному — отмечать галочками каждую строку не нужно.
            </p>
            {query
              ? <p className="text-xs font-medium text-amber-700">Поиск «{query}» — найдено позиций: {stocks.length}.</p>
              : <p className="text-xs font-medium text-red-700">Поиск пуст: «всем по поиску» затронет весь ассортимент ({stocks.length}). Сначала сузьте поиск.</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingUnits}>Отмена</AlertDialogCancel>
            <Button variant="outline" onClick={() => void applyUnits("selected")} disabled={savingUnits || selected.size === 0}>
              Выбранным ({selected.size})
            </Button>
            <Button onClick={() => void applyUnits("search")} disabled={savingUnits}>
              {savingUnits ? <Loader2 className="animate-spin" /> : <Layers />}
              Всем по поиску ({stocks.length})
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(selectedResult)} onOpenChange={(open) => { if (!open) setSelectedResult(null); }}>
        <AlertDialogContent className="max-w-4xl">
          <AlertDialogHeader>
            <AlertDialogTitle>{selectedResult?.ok ? "Выбранные позиции синхронизированы" : "Синхронизация выполнена частично"}</AlertDialogTitle>
            <AlertDialogDescription>
              Позиций выбрано: {selectedResult?.selected ?? 0}.
              {" "}Wildberries: отправлено {selectedResult?.wildberries.sent ?? 0} значений на {selectedResult?.wildberries.warehouseCount ?? 0} складов.
              {" "}Ozon: отправлено {selectedResult?.ozon.sent ?? 0} пар товар–склад.
              {selectedResult?.unmapped.length ? ` Без сопоставления на площадках: ${selectedResult.unmapped.length}.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {selectedResult?.failures.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
              {selectedResult.failures.map((failure) => (
                <p key={failure} className="text-xs leading-5 text-amber-900">{failure}</p>
              ))}
            </div>
          ) : null}

          {selectedResult?.ozon.reserveDrift ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Резерв Ozon заметно больше нашего по {selectedResult.ozon.reserveDrift} позициям — признак, что заказы подтянуты не полностью. На отправленное число это не влияет.
            </p>
          ) : null}

          <div className="max-h-[45vh] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Площадка</TableHead>
                  <TableHead>Склад</TableHead>
                  <TableHead>Артикул</TableHead>
                  <TableHead className="text-right">ОСВ</TableHead>
                  <TableHead className="text-right">Резерв</TableHead>
                  <TableHead className="text-right">Расчёт</TableHead>
                  <TableHead className="text-right">Отправлено</TableHead>
                  <TableHead className="text-right">Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(selectedResult?.rows ?? []).map((row, index) => (
                  <TableRow key={`${row.marketplaceId}-${row.warehouseId}-${row.externalSku}-${index}`}>
                    <TableCell className="text-xs">{marketplaceLabel[row.marketplaceId]}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.warehouseName}</TableCell>
                    <TableCell className="font-mono text-xs">{row.sourceSku || row.externalSku}{row.size ? ` · ${row.size}` : ""}</TableCell>
                    <TableCell className="text-right text-xs">{Number(row.osvQty).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right text-xs text-violet-700">{Number(row.reserveQty).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right text-xs">{Number(row.computedQty).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right text-xs font-semibold">{Number(row.sentQty).toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={row.status === "success" ? "outline" : row.status === "skipped" ? "secondary" : "destructive"} title={row.message ?? undefined}>
                        {statusLabel[row.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {(selectedResult?.rows.length ?? 0) === 0 ? (
                  <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-muted-foreground">Ни одной пары товар–склад не отправлено.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setSelectedResult(null)}>Закрыть</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
