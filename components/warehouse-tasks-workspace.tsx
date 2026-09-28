"use client";

/**
 * Экран кладовщика: что ждёт сборки, кнопки формирования заданий и список
 * заданий за день.
 *
 * Заказы сюда приходят сами — по таймеру из API площадок. Кладовщику не нужно
 * заходить в кабинет продавца и выгружать файлы, поэтому на экране нет ни
 * одной кнопки загрузки.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ClipboardList,
  Clock,
  Loader2,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  Undo2,
  Settings2,
  UserRound,
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatAge, formatMoment } from "@/lib/utils";

type Task = {
  id: number;
  number: string;
  metal?: Metal;
  marketplaceId: "ozon" | "wildberries" | "yandex";
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
  printedAt: string | null;
  barcode: string | null;
  manualCloseAt: string | null;
  manualCloseBy: string | null;
  manualCloseNote: string | null;
};

type WaitingGroup = {
  marketplaceId: "ozon" | "wildberries" | "yandex";
  warehouseExternalId: string | null;
  warehouseName: string;
  postingCount: number;
  itemCount: number;
  unitCount: number;
  oldestOrderedAt: string | null;
  withoutCell: number;
  silverCount: number;
  goldCount: number;
  /** Отправления, где серебро и золото вместе: в задания не идут. */
  mixed: string[];
  /** Есть проблемный товар или часть уже в задании: в задания не идут. */
  held?: HeldPosting[];
};

type HeldPosting = { externalOrderId: string; articles: string[]; reasons: string[] };

type Metal = "silver" | "gold";

const METAL_LABEL: Record<Metal, string> = { silver: "серебро", gold: "золото" };

type Picker = { email: string; fullName: string | null; role: string };

const STATUS_LABEL: Record<Task["status"], string> = {
  created: "Не выдано",
  issued: "У сборщика",
  picked: "Собрано",
  shipped: "Отгружено",
  cancelled: "Отменено",
};

const MARKETPLACE_LABEL: Record<Task["marketplaceId"], string> = {
  ozon: "Ozon",
  wildberries: "Wildberries",
  yandex: "Яндекс Маркет",
};

function StatusBadge({ task }: { task: Task }) {
  // Отметка о ручном закрытии важнее статуса: по такому заданию поставку
  // оформляли в кабинете площадки, и искать её документы на сайте не надо.
  if (task.manualCloseAt) {
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge variant="outline">{STATUS_LABEL.shipped}</Badge>
        <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">закрыто вручную</Badge>
      </span>
    );
  }
  if (task.status === "created") return <Badge variant="secondary">{STATUS_LABEL.created}</Badge>;
  if (task.status === "issued") return <Badge className="bg-blue-100 text-blue-900 hover:bg-blue-100">{STATUS_LABEL.issued}</Badge>;
  if (task.status === "picked") return <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100">{STATUS_LABEL.picked}</Badge>;
  if (task.status === "shipped") return <Badge variant="outline">{STATUS_LABEL.shipped}</Badge>;
  return <Badge variant="destructive">{STATUS_LABEL.cancelled}</Badge>;
}

export function WarehouseTasksWorkspace() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [waiting, setWaiting] = useState<WaitingGroup[]>([]);
  const [pickers, setPickers] = useState<Picker[]>([]);
  const [batchSizes, setBatchSizes] = useState({ ozon: 30, wildberries: 0, yandex: 30 });
  const [draftBatch, setDraftBatch] = useState({ ozon: "30", wildberries: "0", yandex: "30" });
  const [blockedCount, setBlockedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Task | null>(null);
  const [manualTarget, setManualTarget] = useState<Task | null>(null);
  const [manualNote, setManualNote] = useState("");
  const [reopenTarget, setReopenTarget] = useState<Task | null>(null);
  const [returnTarget, setReturnTarget] = useState<Task | null>(null);

  const load = useCallback(async () => {
    const [tasksResponse, pickersResponse] = await Promise.all([
      fetch("/api/warehouse/tasks", { cache: "no-store" }),
      fetch("/api/warehouse/pickers", { cache: "no-store" }),
    ]);
    const data = await tasksResponse.json() as {
      tasks?: Task[];
      waiting?: WaitingGroup[];
      batchSizes?: { ozon: number; wildberries: number; yandex: number };
      blockedCount?: number;
      error?: string;
    };
    if (!tasksResponse.ok) throw new Error(data.error ?? "Не удалось загрузить задания.");
    setTasks(data.tasks ?? []);
    setWaiting(data.waiting ?? []);
    setBlockedCount(data.blockedCount ?? 0);
    if (data.batchSizes) {
      setBatchSizes(data.batchSizes);
      setDraftBatch({
        ozon: String(data.batchSizes.ozon),
        wildberries: String(data.batchSizes.wildberries),
        yandex: String(data.batchSizes.yandex),
      });
    }
    if (pickersResponse.ok) {
      const pickerData = await pickersResponse.json() as { pickers?: Picker[] };
      setPickers(pickerData.pickers ?? []);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(() => load())
      .catch((error: unknown) => toast.error("Не загрузилось", { description: error instanceof Error ? error.message : "Повторите попытку." }))
      .finally(() => setLoading(false));
  }, [load]);

  async function refresh() {
    setBusy("refresh");
    try {
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить.");
    } finally {
      setBusy(null);
    }
  }

  async function createTasks(
    marketplaceId: "ozon" | "wildberries" | "yandex",
    metal: Metal,
    warehouseExternalId?: string | null,
    maxBatches?: number,
  ) {
    const key = `create:${marketplaceId}:${metal}:${warehouseExternalId ?? "all"}:${maxBatches ?? 0}`;
    setBusy(key);
    try {
      const response = await fetch("/api/warehouse/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplaceId, metal, warehouseExternalId, maxBatches }),
      });
      const data = await response.json() as {
        created?: Array<{ number: string; itemCount: number }>;
        skipped?: string | null;
        mixed?: Array<{ externalOrderId: string; articles: string[] }>;
        held?: HeldPosting[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Не удалось сформировать задания.");
      const created = data.created ?? [];
      if (created.length === 0) {
        toast.info(data.skipped ?? "Формировать нечего.");
      } else {
        toast.success(`Сформировано заданий (${METAL_LABEL[metal]}): ${created.length}`, {
          description: created.slice(0, 4).map((task) => `${task.number} — ${task.itemCount} поз.`).join("; "),
        });
      }
      if ((data.mixed ?? []).length > 0) {
        toast.warning(`Отправлений с серебром и золотом вместе: ${data.mixed?.length}`, {
          description: "Они не попали в задания — соберите их вручную и отправьте через кабинет площадки. Список — в карточке площадки.",
        });
      }
      if ((data.held ?? []).length > 0) {
        toast.warning(`Отправлений с проблемным товаром или уже частично в задании: ${data.held?.length}`, {
          description: "Они не попали в задания целиком — соберите их вручную и отправьте через кабинет площадки. Список — в карточке площадки.",
        });
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сформировать задания.");
    } finally {
      setBusy(null);
    }
  }

  async function act(task: Task, action: string, payload: Record<string, unknown> = {}, message?: string) {
    setBusy(`task:${task.id}:${action}`);
    try {
      const response = await fetch("/api/warehouse/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, action, ...payload }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Действие не выполнено.");
      if (message) toast.success(message);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Действие не выполнено.");
    } finally {
      setBusy(null);
    }
  }

  async function saveBatchSizes() {
    setBusy("batch");
    try {
      const response = await fetch("/api/warehouse/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ozon: Number(draftBatch.ozon),
          wildberries: Number(draftBatch.wildberries),
          yandex: Number(draftBatch.yandex),
        }),
      });
      const data = await response.json() as { batchSizes?: { ozon: number; wildberries: number; yandex: number }; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось сохранить.");
      if (data.batchSizes) {
        setBatchSizes(data.batchSizes);
        setDraftBatch({
          ozon: String(data.batchSizes.ozon),
          wildberries: String(data.batchSizes.wildberries),
          yandex: String(data.batchSizes.yandex),
        });
      }
      toast.success("Размер партии сохранён");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить.");
    } finally {
      setBusy(null);
    }
  }

  const ozonWaiting = waiting.filter((group) => group.marketplaceId === "ozon");
  const wbWaiting = waiting.filter((group) => group.marketplaceId === "wildberries");
  const yandexWaiting = waiting.filter((group) => group.marketplaceId === "yandex");
  const ozonPostings = ozonWaiting.reduce((sum, group) => sum + group.postingCount, 0);
  const wbPostings = wbWaiting.reduce((sum, group) => sum + group.postingCount, 0);
  const yandexPostings = yandexWaiting.reduce((sum, group) => sum + group.postingCount, 0);
  const withoutCell = waiting.reduce((sum, group) => sum + group.withoutCell, 0);

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем склад…</div>;
  }

  return (
    <div className="mx-auto max-w-[1520px] space-y-6 p-4 md:p-7">
      {blockedCount > 0 ? (
        <Link
          href="/warehouse/problems"
          className="flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100"
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Проблемных артикулов в работе: <b>{blockedCount}</b>. Остаток по ним обнулён на обеих площадках.
          </span>
          <ArrowRight className="size-4 shrink-0" />
        </Link>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2"><PackagePlus className="size-4" /> Wildberries</span>
              <Badge variant={wbPostings ? "default" : "secondary"}>{wbPostings} заданий ждёт</Badge>
            </CardTitle>
            <CardDescription>
              Одно задание на каждый региональный склад: сортировка идёт уже на сборке. Серебро и золото — разными
              заданиями: для золота отдельная УПД.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetalButtons
              counts={metalCounts(wbWaiting)}
              busy={busy}
              busyKey={(metal) => `create:wildberries:${metal}:all:0`}
              label={(metal) => `Выдать задания на ${METAL_LABEL[metal]} по всем складам`}
              onCreate={(metal) => void createTasks("wildberries", metal)}
            />
            <div className="space-y-2">
              {wbPostings === 0 ? <p className="text-sm text-muted-foreground">Новых сборочных заданий нет.</p> : null}
              {wbWaiting.filter((group) => group.postingCount > 0).map((group) => (
                <div key={`${group.warehouseExternalId}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{group.warehouseName}</p>
                    <p className="text-xs text-muted-foreground">
                      серебро {group.silverCount} · золото {group.goldCount} · {group.unitCount} шт. · ждёт {formatAge(group.oldestOrderedAt)}
                      {group.withoutCell > 0 ? ` · без ячейки ${group.withoutCell}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || group.silverCount === 0}
                      onClick={() => void createTasks("wildberries", "silver", group.warehouseExternalId)}
                    >
                      Серебро
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-400 text-amber-900"
                      disabled={busy !== null || group.goldCount === 0}
                      onClick={() => void createTasks("wildberries", "gold", group.warehouseExternalId)}
                    >
                      Золото
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <HeldWarning marketplace="Wildberries" groups={wbWaiting} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2"><PackagePlus className="size-4" /> Ozon</span>
              <Badge variant={ozonPostings ? "default" : "secondary"}>{ozonPostings} отправлений ждёт</Badge>
            </CardTitle>
            <CardDescription>
              Партиями по {batchSizes.ozon} отправлений. Остаток уходит как есть, не добивается. Серебро и золото —
              разными заданиями.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetalButtons
              counts={metalCounts(ozonWaiting)}
              busy={busy}
              busyKey={(metal) => `create:ozon:${metal}:all:0`}
              label={(metal) => `Выдать задания на ${METAL_LABEL[metal]}`}
              onCreate={(metal) => void createTasks("ozon", metal)}
              onOne={(metal) => void createTasks("ozon", metal, null, 1)}
            />
            <MixedWarning marketplace="Ozon" groups={ozonWaiting} />
            <HeldWarning marketplace="Ozon" groups={ozonWaiting} />
            {withoutCell > 0 ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Без адреса в раскладке: {withoutCell} позиций. Они попадут в задание, но в конец списка —
                добавьте ячейки на странице «Ячейки и раскладка».
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2"><PackagePlus className="size-4" /> Яндекс Маркет</span>
              <Badge variant={yandexPostings ? "default" : "secondary"}>{yandexPostings} заказов ждёт</Badge>
            </CardTitle>
            <CardDescription>
              Партиями по {batchSizes.yandex} заказов. Доставку выполняет Яндекс Доставка — курьер вызывается на отгрузке.
              Серебро и золото — разными заданиями.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetalButtons
              counts={metalCounts(yandexWaiting)}
              busy={busy}
              busyKey={(metal) => `create:yandex:${metal}:all:0`}
              label={(metal) => `Выдать задания на ${METAL_LABEL[metal]}`}
              onCreate={(metal) => void createTasks("yandex", metal)}
              onOne={(metal) => void createTasks("yandex", metal, null, 1)}
            />
            <MixedWarning marketplace="Яндекс Маркета" groups={yandexWaiting} />
            <HeldWarning marketplace="Яндекс Маркета" groups={yandexWaiting} />
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Settings2 className="size-4" /> Размер партии</CardTitle>
            <CardDescription>Ozon и Яндекс делятся на партии этого размера. У WB ноль — не делить, одно задание на склад.</CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void saveBatchSizes()}>
            {busy === "batch" ? <Loader2 className="size-4 animate-spin" /> : null} Сохранить
          </Button>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          <div className="space-y-1">
            <Label htmlFor="batch-ozon" className="text-xs">Ozon, отправлений в партии</Label>
            <Input
              id="batch-ozon"
              className="w-32"
              inputMode="numeric"
              value={draftBatch.ozon}
              onChange={(event) => setDraftBatch((current) => ({ ...current, ozon: event.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="batch-wb" className="text-xs">Wildberries, 0 — не делить</Label>
            <Input
              id="batch-wb"
              className="w-32"
              inputMode="numeric"
              value={draftBatch.wildberries}
              onChange={(event) => setDraftBatch((current) => ({ ...current, wildberries: event.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="batch-yandex" className="text-xs">Яндекс Маркет, заказов в партии</Label>
            <Input
              id="batch-yandex"
              className="w-32"
              inputMode="numeric"
              value={draftBatch.yandex}
              onChange={(event) => setDraftBatch((current) => ({ ...current, yandex: event.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <ClipboardList className="size-4" />
            <p className="font-semibold">Задания</p>
          </div>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>
            {busy === "refresh" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Обновить
          </Button>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Номер</TableHead>
                <TableHead>Площадка и склад</TableHead>
                <TableHead className="text-right">Состав</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Сборщик</TableHead>
                <TableHead>Создано</TableHead>
                <TableHead className="pr-5 text-right">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell className="pl-5 font-mono text-xs font-semibold">
                    <Link href={`/warehouse/task?id=${task.id}`} className="hover:underline">{task.number}</Link>
                    {task.metal === "gold" ? <Badge className="ml-2 bg-amber-400 text-amber-950 hover:bg-amber-400">ЗОЛОТО</Badge> : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {MARKETPLACE_LABEL[task.marketplaceId]}
                    <span className="block text-xs text-muted-foreground">{task.warehouseName ?? "—"}</span>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {task.itemCount} поз. / {task.unitCount} шт.
                    <span className="block text-xs text-muted-foreground">
                      {task.cellCount} ячеек
                      {task.notFoundCount > 0 ? ` · не найдено ${task.notFoundCount}` : ""}
                    </span>
                  </TableCell>
                  <TableCell><StatusBadge task={task} /></TableCell>
                  <TableCell className="text-xs">
                    {task.assigneeEmail ? (
                      <span className="flex items-center gap-1"><UserRound className="size-3.5" />{task.assigneeEmail}</span>
                    ) : task.status === "created" ? (
                      <NativeSelect
                        className="h-8 w-40 text-xs"
                        defaultValue=""
                        disabled={busy !== null}
                        onChange={(event) => {
                          const assigneeEmail = event.target.value;
                          if (assigneeEmail) void act(task, "assign", { assigneeEmail }, "Задание выдано");
                        }}
                      >
                        <option value="">Выдать сборщику…</option>
                        {pickers.map((picker) => (
                          <option key={picker.email} value={picker.email}>{picker.fullName || picker.email}</option>
                        ))}
                      </NativeSelect>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatMoment(task.createdAt)}
                    {task.pickedAt ? <span className="block">собрано {formatMoment(task.pickedAt)}</span> : null}
                    {task.issuedAt && !task.pickedAt ? <span className="block flex items-center gap-1"><Clock className="size-3" />в работе {formatAge(task.issuedAt)}</span> : null}
                  </TableCell>
                  <TableCell className="pr-5">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/warehouse/task?id=${task.id}`}>Открыть</Link>
                      </Button>
                      {/* Лист подбора печатает сборщик на «Набрать товары»:
                          один лист на задание, и код на нём не дублируется. */}
                      {task.status !== "cancelled" && !task.manualCloseAt && task.status !== "shipped" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => setManualTarget(task)}
                        >
                          <CheckCircle2 className="size-4" /> Закрыть вручную
                        </Button>
                      ) : null}
                      {task.status === "picked" && !task.manualCloseAt ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => setReturnTarget(task)}
                        >
                          {busy === `task:${task.id}:return_to_picking`
                            ? <Loader2 className="size-4 animate-spin" />
                            : <Undo2 className="size-4" />} Вернуть на сборку
                        </Button>
                      ) : null}
                      {task.manualCloseAt && task.status !== "cancelled" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => setReopenTarget(task)}
                        >
                          {busy === `task:${task.id}:reopen_manual`
                            ? <Loader2 className="size-4 animate-spin" />
                            : <RotateCcw className="size-4" />} Вернуть в работу
                        </Button>
                      ) : null}
                      {task.status !== "shipped" && task.status !== "cancelled" ? (
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy !== null} onClick={() => setCancelTarget(task)}>
                          <Ban className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {tasks.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="h-32 text-center text-muted-foreground">Заданий пока нет.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>

      <AlertDialog
        open={Boolean(manualTarget)}
        onOpenChange={(open) => { if (!open) { setManualTarget(null); setManualNote(""); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Закрыть отгрузку {manualTarget?.number} вручную?</AlertDialogTitle>
            <AlertDialogDescription>
              Так закрывают задания, поставку по которым оформили руками в кабинете площадки.
              Задание перестанет числиться неотгруженным, а отметка «закрыто вручную» — кто и
              когда — останется при задании и в журнале. Заказы и этикетки не меняются.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <Label htmlFor="manual-note" className="text-xs">Комментарий (необязательно)</Label>
            <Input
              id="manual-note"
              placeholder="например: поставка 123456 оформлена в кабинете WB"
              value={manualNote}
              onChange={(event) => setManualNote(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Не закрывать</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const task = manualTarget;
                const comment = manualNote.trim();
                setManualTarget(null);
                setManualNote("");
                if (task) void act(task, "close_manual", { comment }, "Отгрузка закрыта вручную");
              }}
            >
              Закрыть вручную
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(returnTarget)} onOpenChange={(open) => { if (!open) setReturnTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Вернуть задание {returnTarget?.number} на сборку?</AlertDialogTitle>
            <AlertDialogDescription>
              Задание снова станет «у сборщика», отметки строк сохранятся. Откройте задание и
              у товаров, которых на деле нет, нажмите «Не найден» — остаток обнулится, артикул
              попадёт в проблемные. Потом закройте задание кнопкой «Задание собрано».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Не возвращать</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const task = returnTarget;
                setReturnTarget(null);
                if (task) void act(task, "return_to_picking", {}, "Задание возвращено на сборку");
              }}
            >
              Вернуть на сборку
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(reopenTarget)} onOpenChange={(open) => { if (!open) setReopenTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Вернуть отгрузку {reopenTarget?.number} в работу?</AlertDialogTitle>
            <AlertDialogDescription>
              Отметка «закрыто вручную» снимется, задание вернётся в статус, который был до
              закрытия, а поставка по нему снова станет незакрытой — с заданием можно будет
              работать дальше. Закрытие и возврат останутся в журнале событий.
              {reopenTarget?.manualCloseAt ? (
                <span className="mt-2 block text-xs">
                  Закрыто {formatMoment(reopenTarget.manualCloseAt)}
                  {reopenTarget.manualCloseBy ? ` · ${reopenTarget.manualCloseBy}` : ""}
                  {reopenTarget.manualCloseNote ? ` · «${reopenTarget.manualCloseNote}»` : ""}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Оставить закрытым</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const task = reopenTarget;
                setReopenTarget(null);
                if (task) void act(task, "reopen_manual", {}, "Отгрузка возвращена в работу");
              }}
            >
              Вернуть в работу
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(cancelTarget)} onOpenChange={(open) => { if (!open) setCancelTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить задание {cancelTarget?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              Строки задания освободятся и вернутся в отбор — их можно будет выдать заново.
              Отметки «собрано» и «не найден» по этому заданию останутся в журнале, блокировки артикулов не снимаются.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Не отменять</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const task = cancelTarget;
                setCancelTarget(null);
                if (task) void act(task, "cancel", {}, "Задание отменено");
              }}
            >
              Отменить задание
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Сколько отправлений ждёт по серебру и по золоту. */
function metalCounts(groups: WaitingGroup[]): Record<Metal, number> {
  return {
    silver: groups.reduce((sum, group) => sum + group.silverCount, 0),
    gold: groups.reduce((sum, group) => sum + group.goldCount, 0),
  };
}

/** Две кнопки на площадку: серебро и золото, у каждой своя УПД. */
function MetalButtons({
  counts,
  busy,
  busyKey,
  label,
  onCreate,
  onOne,
}: {
  counts: Record<Metal, number>;
  busy: string | null;
  busyKey: (metal: Metal) => string;
  label: (metal: Metal) => string;
  onCreate: (metal: Metal) => void;
  onOne?: (metal: Metal) => void;
}) {
  return (
    <div className="space-y-2">
      {(["silver", "gold"] as const).map((metal) => (
        <div key={metal} className="flex flex-col gap-2 sm:flex-row">
          <Button
            className={metal === "gold" ? "flex-1 bg-amber-500 text-amber-950 hover:bg-amber-400" : "flex-1"}
            disabled={counts[metal] === 0 || busy !== null}
            onClick={() => onCreate(metal)}
          >
            {busy === busyKey(metal) ? <Loader2 className="size-4 animate-spin" /> : <PackagePlus className="size-4" />}
            {label(metal)} · {counts[metal]}
          </Button>
          {onOne ? (
            <Button variant="outline" disabled={counts[metal] === 0 || busy !== null} onClick={() => onOne(metal)}>
              Одну партию
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * Отправления, где серебро и золото вместе. В задания они не попадают: на
 * серебро и золото 1С выписывает разные УПД, а задание сверяется с одной.
 */
function MixedWarning({ marketplace, groups }: { marketplace: string; groups: WaitingGroup[] }) {
  const mixed = groups.flatMap((group) => group.mixed);
  if (mixed.length === 0) return null;
  return (
    <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p className="flex items-center gap-1 font-semibold">
        <AlertTriangle className="size-3.5" /> Серебро и золото в одном отправлении: {mixed.length}
      </p>
      <p>
        Для серебра и золота оформляются разные УПД, а задание сверяется с одной, поэтому эти отправления не попадают
        в задания. Соберите их артикулы вручную и отправьте через портал {marketplace}.
      </p>
      <p className="font-mono">{mixed.slice(0, 20).join(", ")}{mixed.length > 20 ? ` и ещё ${mixed.length - 20}` : ""}</p>
    </div>
  );
}

/**
 * Отправления, где есть проблемный товар или часть уже лежит в другом
 * задании. В задания они не попадают целиком: площадка собирает отправление
 * одним запросом, и половину посылки передать нельзя.
 */
function HeldWarning({ marketplace, groups }: { marketplace: string; groups: WaitingGroup[] }) {
  const held = groups.flatMap((group) => group.held ?? []);
  if (held.length === 0) return null;
  return (
    <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p className="flex items-center gap-1 font-semibold">
        <AlertTriangle className="size-3.5" /> Собрать вручную: {held.length}
      </p>
      <p>
        В этих отправлениях есть проблемный товар или часть товаров уже в другом задании, поэтому ни один их товар
        не попадает в задания. Соберите отправление целиком вручную и отправьте через портал {marketplace} — или
        дождитесь, пока проблемный товар найдётся.
      </p>
      <ul className="space-y-0.5">
        {held.slice(0, 20).map((posting) => (
          <li key={posting.externalOrderId}>
            <span className="font-mono">{posting.externalOrderId}</span>
            {" "}<span className="font-mono text-amber-800/80">{posting.articles.join(", ")}</span>
            {" — "}{posting.reasons.join("; ")}
          </li>
        ))}
      </ul>
      {held.length > 20 ? <p>и ещё {held.length - 20}</p> : null}
    </div>
  );
}
