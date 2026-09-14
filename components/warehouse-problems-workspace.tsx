"use client";

/**
 * Проблемные товары.
 *
 * Товар числится в учёте, но его нет в ячейке. Пока артикул заблокирован, его
 * остаток равен нулю на обеих площадках и ОСВ его не поднимает. Снять
 * блокировку можно только вручную и только с комментарием — автоснятия нет
 * сознательно: скана при размещении в ячейку нет, а рост количества в ОСВ
 * сигнал ненадёжный.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, History, Loader2, Unlock } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatAge, formatMoment } from "@/lib/utils";

type Problem = {
  id: number;
  article: string;
  size: string | null;
  state: "blocked" | "released";
  status: "searching" | "requested" | "cancelling" | "arrived";
  failedOrderCount: number;
  taskNumber: string | null;
  marketplaceId: string | null;
  externalOrderId: string | null;
  shipmentDeadline: string | null;
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
  taskNumber: string | null;
  createdAt: string;
};

const STATUS_LABEL: Record<Problem["status"], string> = {
  searching: "Ищем",
  requested: "Запрошено на производстве",
  cancelling: "Отменяем",
  arrived: "Пришло из производства",
};

const ACTION_LABEL: Record<string, string> = {
  blocked: "заблокирован",
  repeat: "не найден повторно",
  released: "блокировка снята",
};

export function WarehouseProblemsWorkspace() {
  const [items, setItems] = useState<Problem[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [canRelease, setCanRelease] = useState(false);
  const [state, setState] = useState<"blocked" | "released" | "all">("blocked");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<Problem | null>(null);
  const [comment, setComment] = useState("");

  const load = useCallback(async (nextState: typeof state) => {
    const response = await fetch(`/api/warehouse/problems?state=${nextState}`, { cache: "no-store" });
    const data = await response.json() as { items?: Problem[]; log?: LogRow[]; canRelease?: boolean; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Список не загрузился.");
    setItems(data.items ?? []);
    setLog(data.log ?? []);
    setCanRelease(Boolean(data.canRelease));
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(() => load(state))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Список не загрузился."))
      .finally(() => setLoading(false));
  }, [load, state]);

  async function post(payload: Record<string, unknown>, message: string) {
    setBusy(`${payload.action}:${payload.id}`);
    try {
      const response = await fetch("/api/warehouse/problems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Действие не выполнено.");
      toast.success(message);
      await load(state);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Действие не выполнено.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем разбор…</div>;
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-7">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4" /> Проблемные артикулы</CardTitle>
            <CardDescription>
              Wildberries: сборочное задание нужно отменить в кабинете, иначе поставку не закрыть без УИН.
              Ozon: заказ не отменяем — изделие ищут на производстве, отправление уедет в одну из следующих поставок.
            </CardDescription>
          </div>
          <NativeSelect className="w-44" value={state} onChange={(event) => setState(event.target.value as typeof state)}>
            <option value="blocked">Заблокированные</option>
            <option value="released">Снятые</option>
            <option value="all">Все</option>
          </NativeSelect>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Артикул</TableHead>
                  <TableHead>Заблокирован</TableHead>
                  <TableHead>Заказ</TableHead>
                  <TableHead>Дедлайн отгрузки</TableHead>
                  <TableHead>Статус разбора</TableHead>
                  <TableHead className="pr-5 text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const deadlineSoon = item.shipmentDeadline
                    ? Date.parse(item.shipmentDeadline) - Date.now() < 6 * 60 * 60 * 1000
                    : false;
                  return (
                    <TableRow key={item.id} className={deadlineSoon && item.state === "blocked" ? "bg-red-50/70" : undefined}>
                      <TableCell className="pl-5">
                        <p className="font-mono text-sm font-semibold">{item.article}{item.size ? ` / ${item.size}` : ""}</p>
                        {item.failedOrderCount > 2 ? (
                          <Badge variant="destructive" className="mt-1 text-[10px]">не найден {item.failedOrderCount} раз — похоже на ошибку учёта</Badge>
                        ) : item.failedOrderCount > 1 ? (
                          <span className="text-xs text-muted-foreground">сорвано заказов: {item.failedOrderCount}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatMoment(item.blockedAt)}
                        <span className="block">{item.blockedBy ?? ""}</span>
                        {item.taskNumber ? <span className="block font-mono">{item.taskNumber}</span> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.marketplaceId === "ozon" ? "Ozon" : item.marketplaceId === "wildberries" ? "Wildberries" : "—"}
                        {item.externalOrderId ? <span className="block font-mono text-muted-foreground">{item.externalOrderId}</span> : null}
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.shipmentDeadline ? (
                          <span className={deadlineSoon ? "font-semibold text-destructive" : undefined}>
                            {formatMoment(item.shipmentDeadline)}
                            <span className="block text-muted-foreground">
                              {Date.parse(item.shipmentDeadline) < Date.now()
                                ? `просрочен на ${formatAge(item.shipmentDeadline)}`
                                : `через ${formatAge(item.shipmentDeadline)}`}
                            </span>
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        {item.state === "released" ? (
                          <span className="text-xs text-muted-foreground">
                            снята {formatMoment(item.releasedAt)}
                            <span className="block">{item.releasedBy ?? ""}</span>
                          </span>
                        ) : (
                          <NativeSelect
                            className="h-8 w-52 text-xs"
                            value={item.status}
                            disabled={busy !== null}
                            onChange={(event) => void post({ action: "status", id: item.id, status: event.target.value }, "Статус изменён")}
                          >
                            {Object.entries(STATUS_LABEL).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </NativeSelect>
                        )}
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        {item.state === "blocked" && canRelease ? (
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { setReleaseTarget(item); setComment(""); }}>
                            <Unlock className="size-4" /> Снять блокировку
                          </Button>
                        ) : item.state === "blocked" ? (
                          <span className="text-xs text-muted-foreground">снимает начальник склада</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{item.comment ?? ""}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {items.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">Проблемных артикулов нет.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-center gap-2 border-b px-5 py-4">
          <History className="size-4" />
          <p className="font-semibold">Журнал блокировок и снятий</p>
          <span className="text-xs text-muted-foreground">строки не удаляются</span>
        </div>
        <div className="max-h-[420px] overflow-auto">
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

      <Dialog open={Boolean(releaseTarget)} onOpenChange={(open) => { if (!open) setReleaseTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Снять блокировку {releaseTarget?.article}</DialogTitle>
            <DialogDescription>
              Остаток вернётся в продажу при следующей выгрузке — по данным ОСВ.
              Комментарий обязателен: без него потом не понять, что выяснилось.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            placeholder="Нашли в ячейке B-04-12, ошибка раскладки"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseTarget(null)}>Отмена</Button>
            <Button
              disabled={comment.trim().length < 3 || busy !== null}
              onClick={() => {
                const target = releaseTarget;
                setReleaseTarget(null);
                if (target) void post({ action: "release", id: target.id, comment }, "Блокировка снята");
              }}
            >
              Снять блокировку
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
