"use client";

/**
 * Одно задание на сборку.
 *
 * Один и тот же экран открывают сборщик и кладовщик — разница только в наборе
 * кнопок, и решает её сервер: он же отдаёт признаки manages и own.
 *
 * У сборщика в строке ровно две кнопки: «собрано» и «не найден». Быстрее
 * всего так: «Собрано всё» одним нажатием, затем «Не найден» только на том,
 * чего не оказалось в ячейке. Всё остальное — цифры, которые видно с
 * расстояния вытянутой руки, потому что экран стоит на складе, а не на столе.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  CircleSlash,
  Loader2,
  MapPin,
  PackageCheck,
  Printer,
  RefreshCw,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAge, formatMoment } from "@/lib/utils";

type Task = {
  id: number;
  number: string;
  marketplaceId: "ozon" | "wildberries";
  warehouseName: string | null;
  status: "created" | "issued" | "picked" | "shipped" | "cancelled";
  assigneeEmail: string | null;
  orderCount: number;
  itemCount: number;
  unitCount: number;
  pickedCount: number;
  notFoundCount: number;
  cellCount: number;
  createdAt: string;
  issuedAt: string | null;
  pickedAt: string | null;
};

type Item = {
  id: number;
  externalOrderId: string;
  article: string;
  size: string | null;
  quantity: number;
  cellCode: string | null;
  status: "pending" | "picked" | "not_found";
  orderedAt: string | null;
  shipmentDeadline: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
};

const MARKETPLACE_LABEL = { ozon: "Ozon", wildberries: "Wildberries" } as const;

export function WarehouseTaskView({ taskId }: { taskId: number }) {
  const [task, setTask] = useState<Task | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [manages, setManages] = useState(false);
  const [own, setOwn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notFoundTarget, setNotFoundTarget] = useState<Item | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/warehouse/task?id=${taskId}`, { cache: "no-store" });
    const data = await response.json() as { task?: Task; items?: Item[]; manages?: boolean; own?: boolean; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Задание не загрузилось.");
    setTask(data.task ?? null);
    setItems(data.items ?? []);
    setManages(Boolean(data.manages));
    setOwn(Boolean(data.own));
  }, [taskId]);

  useEffect(() => {
    void Promise.resolve()
      .then(() => load())
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Задание не загрузилось."))
      .finally(() => setLoading(false));
  }, [load]);

  async function act(action: string, payload: Record<string, unknown> = {}, message?: string) {
    setBusy(`${action}:${payload.itemId ?? ""}`);
    try {
      const response = await fetch("/api/warehouse/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId, action, ...payload }),
      });
      const data = await response.json() as {
        error?: string;
        problem?: { warning?: string | null; repeated?: boolean; pushed?: { error?: string | null } } | null;
      };
      if (!response.ok) throw new Error(data.error ?? "Действие не выполнено.");
      if (message) toast.success(message);
      // Блокировка проблемного товара могла пройти не до конца — молчать нельзя.
      if (data.problem?.warning) toast.warning(data.problem.warning);
      else if (data.problem?.pushed?.error) {
        toast.warning("Остаток обнулён в системе, но площадка не ответила", { description: data.problem.pushed.error });
      }
      await load();
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : "Действие не выполнено.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Открываем задание…</div>;
  }
  if (error || !task) {
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6 text-center">
        <p className="text-sm text-muted-foreground">{error ?? "Задание не найдено."}</p>
        <Button asChild variant="outline"><Link href="/warehouse/my"><ArrowLeft className="size-4" /> К списку заданий</Link></Button>
      </div>
    );
  }

  const pending = items.filter((item) => item.status === "pending").length;
  const closed = task.status === "picked" || task.status === "shipped" || task.status === "cancelled";
  const canWork = !closed && (manages || own || !task.assigneeEmail);

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 p-4 md:p-7">
      <Card>
        <CardContent className="flex flex-wrap items-start justify-between gap-4 px-5">
          <div className="min-w-0">
            <p className="font-mono text-2xl font-bold tracking-tight md:text-3xl">{task.number}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {MARKETPLACE_LABEL[task.marketplaceId]} · {task.warehouseName ?? "склад не указан"} ·
              {" "}{task.orderCount} заказов · {task.itemCount} позиций · {task.unitCount} шт. · {task.cellCount} ячеек
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              создано {formatMoment(task.createdAt)}
              {task.assigneeEmail ? ` · сборщик ${task.assigneeEmail}` : " · не выдано"}
              {task.issuedAt && !task.pickedAt ? ` · в работе ${formatAge(task.issuedAt)}` : ""}
              {task.pickedAt ? ` · собрано ${formatMoment(task.pickedAt)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {task.notFoundCount > 0 ? <Badge variant="destructive">не найдено: {task.notFoundCount}</Badge> : null}
            {closed ? <Badge variant="outline">задание закрыто</Badge> : <Badge>осталось отметить: {pending}</Badge>}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void load()}>
              <RefreshCw className="size-4" />
            </Button>
            {/* Лист печатает сборщик, за которым закреплено задание: один
                лист на задание, и код на нём не размножается по копиям. */}
            {own ? (
              <Button asChild size="sm" variant="outline">
                <a href={`/print/pick-sheet?task=${task.id}`} target="_blank" rel="noreferrer"><Printer className="size-4" /> Лист подбора</a>
              </Button>
            ) : null}
            {/* Дальше работа идёт по скану листа: номер задания в ссылке не
                передаём — стол и поставки открывают задание сами. */}
            {manages && task.status === "picked" ? (
              <Button asChild size="sm">
                <Link href="/warehouse/supplies"><Truck className="size-4" /> Поставки</Link>
              </Button>
            ) : null}
            {manages && task.status === "picked" ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/warehouse/scan">Стол сканирования</Link>
              </Button>
            ) : null}
            {!closed && !task.assigneeEmail ? (
              <Button size="sm" disabled={busy !== null} onClick={() => void act("take", {}, "Задание закреплено за вами")}>
                Взять задание
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {canWork && pending > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-sm text-emerald-950">
            Собрали всё по листу? Отметьте все строки разом, а потом нажмите «Не найден» только у того, чего нет.
          </p>
          <Button
            size="lg"
            disabled={busy !== null}
            onClick={() => void act("pick_all", {}, "Все строки отмечены собранными")}
          >
            {busy === "pick_all:" ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
            Собрано всё · {pending}
          </Button>
        </div>
      ) : null}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Ячейка</TableHead>
                <TableHead>Артикул</TableHead>
                <TableHead>Размер</TableHead>
                <TableHead className="text-right">Кол-во</TableHead>
                <TableHead>Заказ</TableHead>
                <TableHead className="pr-5 text-right">Отметка</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} className={item.status === "not_found" ? "bg-red-50/70" : item.status === "picked" ? "bg-emerald-50/50" : undefined}>
                  <TableCell className="pl-5">
                    {item.cellCode ? (
                      <span className="font-mono text-base font-bold">{item.cellCode}</span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-amber-700"><MapPin className="size-3.5" /> нет в раскладке</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm font-semibold">{item.article}</TableCell>
                  <TableCell className="text-sm">{item.size ?? "—"}</TableCell>
                  <TableCell className="text-right text-base font-semibold">{item.quantity}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <span className="font-mono">{item.externalOrderId}</span>
                    <span className="block">ждёт {formatAge(item.orderedAt)}</span>
                  </TableCell>
                  <TableCell className="pr-5">
                    <div className="flex flex-wrap justify-end gap-2">
                      {item.status === "picked" ? <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100">собрано</Badge> : null}
                      {item.status === "not_found" ? <Badge variant="destructive">не найден</Badge> : null}
                      {canWork ? (
                        <>
                          {/* Отмеченная строка показывает только обратное действие. */}
                          {item.status !== "picked" ? (
                            <Button
                              size="sm"
                              variant={item.status === "not_found" ? "outline" : "default"}
                              disabled={busy !== null}
                              onClick={() => void act("resolve", { itemId: item.id, status: "picked" })}
                            >
                              {busy === `resolve:${item.id}` ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                              Собрано
                            </Button>
                          ) : null}
                          {item.status !== "not_found" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive hover:text-destructive"
                              disabled={busy !== null}
                              onClick={() => setNotFoundTarget(item)}
                            >
                              <CircleSlash className="size-4" /> Не найден
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    {item.resolvedAt ? (
                      <p className="mt-1 text-right text-[11px] text-muted-foreground">{formatMoment(item.resolvedAt)} · {item.resolvedBy ?? ""}</p>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">В задании нет строк.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>

      {canWork ? (
        <div className="sticky bottom-4 flex justify-end">
          <Button
            size="lg"
            className="shadow-lg"
            disabled={busy !== null}
            onClick={() => void act("close", {}, "Задание закрыто")}
          >
            {busy === "close:" ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
            Задание собрано
            {pending > 0 ? <span className="opacity-80">· без отметки {pending}</span> : null}
          </Button>
        </div>
      ) : null}

      <AlertDialog open={Boolean(notFoundTarget)} onOpenChange={(open) => { if (!open) setNotFoundTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Товара нет в ячейке?</AlertDialogTitle>
            <AlertDialogDescription>
              {notFoundTarget?.article}{notFoundTarget?.size ? `, размер ${notFoundTarget.size}` : ""} —
              остаток по артикулу сразу уйдёт в ноль на Wildberries и Ozon, чтобы его не заказали снова.
              Артикул попадёт в проблемные: разбирает кладовщик, снимает блокировку начальник склада.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const item = notFoundTarget;
                setNotFoundTarget(null);
                if (item) void act("resolve", { itemId: item.id, status: "not_found" }, "Отмечено: не найден");
              }}
            >
              Не найден, обнулить остаток
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
