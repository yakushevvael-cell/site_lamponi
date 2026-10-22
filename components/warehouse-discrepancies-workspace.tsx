"use client";

/**
 * Расхождения между 1С и складом (ТЗ, п. 4) — экран начальника склада.
 *
 * Подсветка строки означает «количество в ОСВ выросло после блокировки» и
 * говорит только о том, куда смотреть первым делом: в ОСВ мог прийти новый
 * выпуск, а не найтись потерянное изделие. Решение всё равно за человеком:
 * в продажу товар возвращается только подтверждением остатка по ОСВ — список
 * «Ждут решения» вверху страницы.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ClipboardCheck, History, Loader2, Scale } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ZeroDecisionsList, type ZeroDecision } from "@/components/zero-decisions";
import { formatAge, formatMoment } from "@/lib/utils";

type Row = {
  id: number;
  article: string;
  size: string | null;
  state: "blocked" | "released";
  status: string;
  osvQtyAtBlock: number;
  osvQtyNow: number;
  osvGrew: boolean;
  zeroedSkuCount: number;
  failedOrderCount: number;
  taskNumber: string | null;
  marketplaceId: string | null;
  externalOrderId: string | null;
  blockedBy: string | null;
  blockedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  comment: string | null;
};

type LogRow = {
  id: number;
  article: string;
  size: string | null;
  action: string;
  actorEmail: string | null;
  comment: string | null;
  createdAt: string;
};

type Osv = { fileName: string; balanceDate: string | null; createdAt: string } | null;

const ACTION_LABEL: Record<string, string> = {
  blocked: "заблокирован",
  repeat: "не найден повторно",
  released: "блокировка снята",
  osv_confirmed: "остаток по ОСВ подтверждён",
  osv_declined: "остаток по ОСВ не подтверждён",
  wb_cancelled: "отменено задание WB",
};

export function WarehouseDiscrepanciesWorkspace() {
  const [items, setItems] = useState<Row[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [lastOsv, setLastOsv] = useState<Osv>(null);
  const [pending, setPending] = useState<ZeroDecision[]>([]);
  const [canDecide, setCanDecide] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [response, pendingResponse] = await Promise.all([
      fetch("/api/warehouse/discrepancies", { cache: "no-store" }),
      fetch("/api/stocks/zero-decisions", { cache: "no-store" }),
    ]);
    const data = await response.json() as { items?: Row[]; log?: LogRow[]; lastOsv?: Osv; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Расхождения не загрузились.");
    const pendingData = await pendingResponse.json() as { items?: ZeroDecision[]; canDecide?: boolean; error?: string };
    if (!pendingResponse.ok) throw new Error(pendingData.error ?? "Список «Ждут решения» не загрузился.");
    setItems(data.items ?? []);
    setLog(data.log ?? []);
    setLastOsv(data.lastOsv ?? null);
    setPending(pendingData.items ?? []);
    setCanDecide(Boolean(pendingData.canDecide));
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(() => load())
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Расхождения не загрузились."))
      .finally(() => setLoading(false));
  }, [load]);

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Считаем расхождения…</div>;
  }

  const blocked = items.filter((row) => row.state === "blocked");
  const grew = blocked.filter((row) => row.osvGrew);
  const osvAgeHours = lastOsv ? (Date.now() - Date.parse(`${lastOsv.createdAt.replace(" ", "T")}Z`)) / 3_600_000 : null;
  const osvStale = osvAgeHours !== null && osvAgeHours > 72;

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-7">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Ждут решения по ОСВ", value: pending.length, note: "в ОСВ есть остаток, на площадках 0" },
          { label: "Заблокировано артикулов", value: blocked.length, note: "остаток по ним обнулён" },
          { label: "Сорвано заказов", value: blocked.reduce((sum, row) => sum + row.failedOrderCount, 0), note: "с момента блокировки" },
          { label: "Количество в ОСВ выросло", value: grew.length, note: "смотреть первым делом" },
        ].map((tile) => (
          <Card key={tile.label} className="gap-0 py-5">
            <CardContent className="px-5">
              <p className="text-sm text-muted-foreground">{tile.label}</p>
              <p className="mt-2 text-2xl font-semibold">{tile.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{tile.note}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm ${osvStale ? "border-amber-300 bg-amber-50 text-amber-900" : "bg-muted/40"}`}>
        <Scale className="size-4" />
        {lastOsv ? (
          <span>
            Последняя ОСВ: {lastOsv.fileName} · загружена {formatMoment(lastOsv.createdAt)} ({formatAge(lastOsv.createdAt)} назад)
            {lastOsv.balanceDate ? ` · остатки на ${lastOsv.balanceDate}` : ""}
            {osvStale ? " — файл не обновляли больше трёх суток, цифры устарели" : ""}
          </span>
        ) : (
          <span>ОСВ ещё не загружали — количество по 1С сравнивать не с чем.</span>
        )}
      </div>

      {pending.length > 0 ? (
        <Card className="gap-0 overflow-hidden border-amber-300 py-0">
          <CardHeader className="border-b px-5 py-4">
            <CardTitle className="flex items-center gap-2 text-base"><ClipboardCheck className="size-4" /> Ждут решения: остаток в ОСВ у обнулённых товаров</CardTitle>
            <CardDescription>
              {canDecide
                ? "«Да» — остаток по ОСВ верный: товар сразу вернётся в продажу. «Нет» — остаётся 0, снова спросим, когда количество в ОСВ изменится."
                : "Подтвердить остаток может сотрудник с правом «Подтверждение остатка и расхождения». До тех пор на площадках 0."}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4">
            <ZeroDecisionsList
              items={pending}
              canDecide={canDecide}
              onItemsChange={(next) => {
                setPending(next);
                void load().catch(() => undefined);
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-5 py-4">
          <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4" /> Расхождения по артикулам</CardTitle>
          <CardDescription>
            Количество по 1С — из последней ОСВ, в единицах площадки. Подсветка: количество выросло после блокировки.
          </CardDescription>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Артикул</TableHead>
                <TableHead className="text-right">По 1С сейчас</TableHead>
                <TableHead className="text-right">Было при блокировке</TableHead>
                <TableHead>Заблокирован</TableHead>
                <TableHead className="text-right">Сорвано заказов</TableHead>
                <TableHead className="pr-5">Состояние</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id} className={row.state === "blocked" && row.osvGrew ? "bg-amber-50/70" : undefined}>
                  <TableCell className="pl-5">
                    <p className="font-mono text-sm font-semibold">{row.article}{row.size ? ` / ${row.size}` : ""}</p>
                    {row.taskNumber ? <p className="font-mono text-xs text-muted-foreground">{row.taskNumber}</p> : null}
                  </TableCell>
                  <TableCell className="text-right text-sm font-semibold">
                    {row.osvQtyNow}
                    {row.osvGrew ? <Badge variant="outline" className="ml-2 border-amber-400 text-[10px] text-amber-800">выросло</Badge> : null}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">{row.osvQtyAtBlock}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatMoment(row.blockedAt)}
                    <span className="block">{row.blockedBy ?? ""}</span>
                  </TableCell>
                  <TableCell className="text-right text-sm">{row.failedOrderCount}</TableCell>
                  <TableCell className="pr-5 text-xs">
                    {row.state === "blocked" ? (
                      <>
                        <Badge variant="destructive" className="text-[10px]">остаток обнулён</Badge>
                        <span className="mt-1 block text-muted-foreground">позиций 1С: {row.zeroedSkuCount}</span>
                      </>
                    ) : (
                      <>
                        <Badge variant="outline" className="text-[10px]">снята</Badge>
                        <span className="mt-1 block text-muted-foreground">{formatMoment(row.releasedAt)} · {row.releasedBy ?? ""}</span>
                        {row.comment ? <span className="mt-1 block">{row.comment}</span> : null}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">Расхождений нет.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-center gap-2 border-b px-5 py-4">
          <History className="size-4" />
          <p className="font-semibold">Журнал блокировок и снятий</p>
          <span className="text-xs text-muted-foreground">строки не удаляются</span>
        </div>
        <div className="max-h-96 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Дата</TableHead>
                <TableHead>Артикул</TableHead>
                <TableHead>Действие</TableHead>
                <TableHead>Кто</TableHead>
                <TableHead className="pr-5">Комментарий</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="pl-5 text-xs text-muted-foreground">{formatMoment(row.createdAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.article}{row.size ? ` / ${row.size}` : ""}</TableCell>
                  <TableCell className="text-xs">{ACTION_LABEL[row.action] ?? row.action}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.actorEmail ?? "—"}</TableCell>
                  <TableCell className="pr-5 text-xs">{row.comment ?? "—"}</TableCell>
                </TableRow>
              ))}
              {log.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">Записей нет.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>

    </div>
  );
}
