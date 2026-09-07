"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Boxes, CloudUpload, Loader2, RefreshCw, Ruler, Search, ShoppingCart, Warehouse } from "lucide-react";
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

export function StocksWorkspace({ canSyncAll }: { canSyncAll: boolean }) {
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [totals, setTotals] = useState<StockTotals>(emptyTotals);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [unfinishedRun, setUnfinishedRun] = useState<{ startedAt: string | null; stale: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
            <Button variant="outline" onClick={() => void applyManualZero("restore")} disabled={!canRestore || saving || syncingAll}>
              {saving ? <Loader2 className="animate-spin" /> : <RefreshCw />}Снять обнуление
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="destructive" disabled={selected.size === 0 || saving || syncingAll}><Ban />Обнулить выбранные</Button></AlertDialogTrigger>
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
            {canSyncAll ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button disabled={saving || syncingAll}>{syncingAll ? <Loader2 className="animate-spin" /> : <CloudUpload />}{syncingAll ? "Синхронизация…" : "Синхронизировать все остатки"}</Button>
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
            <Button variant="outline" onClick={() => void load(query)} disabled={loading || syncingAll}><RefreshCw className={loading ? "animate-spin" : ""} />Обновить</Button>
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
                  <TableHead>Артикул из 1С</TableHead><TableHead>Размер</TableHead><TableHead className="text-right">Физически</TableHead><TableHead className="text-right">Резерв</TableHead><TableHead className="text-right">Доступно</TableHead><TableHead className="pr-5 text-right">Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stocks.map((row) => (
                  <TableRow key={row.variantKey} data-state={selected.has(row.variantKey) ? "selected" : undefined}>
                    <TableCell className="pl-5"><Checkbox checked={selected.has(row.variantKey)} disabled={!selected.has(row.variantKey) && selected.size >= 50} onCheckedChange={(checked) => toggle(row.variantKey, Boolean(checked))} aria-label={`Выбрать ${row.sku} ${row.size ?? "без размера"}`} /></TableCell>
                    <TableCell className="font-mono text-xs font-semibold">{row.sku}</TableCell>
                    <TableCell>{row.size ? <Badge variant="outline">{row.size}</Badge> : <span className="text-xs text-muted-foreground">Без размера</span>}</TableCell>
                    <TableCell className="text-right">{Number(row.physicalQuantity).toLocaleString("ru-RU")}</TableCell>
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
    </div>
  );
}
