"use client";

/**
 * Стол сканирования УИН и печать этикеток (ТЗ, п. 5).
 *
 * Экран стоит на складе, поэтому всё крупно и без лишних кнопок: сканер
 * работает как клавиатура, поле держит фокус само, а результат скана виден
 * с расстояния вытянутой руки.
 *
 * Три сигнала, которые ловят пересорт в момент возникновения:
 *   — повторный скан: жёлтый экран и двойной звук;
 *   — УИН не найден: жёлтый экран, печати нет;
 *   — изделие из чужого задания: красный экран, печати нет.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Printer,
  RefreshCw,
  ScanLine,
  Upload,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoment } from "@/lib/utils";

type Task = {
  id: number;
  number: string;
  marketplaceId: "ozon" | "wildberries";
  warehouseName: string | null;
  status: string;
  itemCount: number;
};

type Summary = {
  items: number;
  scanned: number;
  postings: number;
  labelsReady: number;
  labelsError: number;
  labelsPending: number;
};

type LabelError = { id: number; externalOrderId: string; article: string | null; error: string | null };

type ScanItem = {
  itemId: number;
  taskId: number;
  marketplaceId: string;
  externalOrderId: string;
  article: string;
  size: string | null;
  cellCode: string | null;
};

type Outcome =
  | { status: "ok"; item: ScanItem; label: { marketplaceId: string; externalOrderId: string; contentType: string } }
  | { status: "uin_unknown"; uin: string }
  | { status: "foreign_task"; uin: string; article: string; taskNumber: string | null }
  | { status: "repeat"; uin: string; item: ScanItem }
  | { status: "not_in_task"; uin: string; article: string; size: string | null }
  | { status: "label_not_ready"; uin: string; item: ScanItem; error: string | null };

type HistoryRow = { at: string; uin: string; status: Outcome["status"]; text: string };

/** Звук нужен затем, что сборщик смотрит на товар, а не на экран. */
function beep(kind: "ok" | "warn" | "error") {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    const pattern = kind === "ok" ? [[880, 0.09]] : kind === "warn" ? [[520, 0.16], [520, 0.16]] : [[200, 0.3], [160, 0.35]];
    let offset = 0;
    for (const [frequency, duration] of pattern) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = "square";
      gain.gain.value = 0.12;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + duration);
      offset += duration + 0.06;
    }
    setTimeout(() => void context.close().catch(() => undefined), (offset + 0.4) * 1000);
  } catch {
    // Без звука экран всё равно показывает результат цветом.
  }
}

const OUTCOME_TEXT: Record<Outcome["status"], string> = {
  ok: "Этикетка отправлена на печать",
  repeat: "Этот УИН уже сканировали",
  uin_unknown: "УИН не найден в УПД",
  foreign_task: "Изделие из другого задания",
  not_in_task: "Изделия нет ни в одном задании",
  label_not_ready: "Этикетка ещё не готова",
};

export function WarehouseScanWorkspace({ initialTaskId }: { initialTaskId: number | null }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<number | null>(initialTaskId);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [labelErrors, setLabelErrors] = useState<LabelError[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [updInfo, setUpdInfo] = useState<{ total: number; free: number } | null>(null);
  const [loading, setLoading] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const printFrame = useRef<HTMLIFrameElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadTasks = useCallback(async () => {
    const response = await fetch("/api/warehouse/tasks", { cache: "no-store" });
    const data = await response.json() as { tasks?: Task[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Задания не загрузились.");
    // На столе упаковки нужны собранные задания: до них товар не доходит.
    const usable = (data.tasks ?? []).filter((task) => task.status === "picked" || task.status === "issued");
    setTasks(usable);
    setTaskId((current) => current ?? usable[0]?.id ?? null);
  }, []);

  const loadUpd = useCallback(async () => {
    const response = await fetch("/api/warehouse/upd", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { total?: number; free?: number };
    setUpdInfo({ total: data.total ?? 0, free: data.free ?? 0 });
  }, []);

  const loadLabels = useCallback(async (id: number) => {
    const response = await fetch(`/api/warehouse/labels?task=${id}`, { cache: "no-store" });
    const data = await response.json() as { summary?: Summary; errors?: LabelError[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Состояние этикеток не загрузилось.");
    setSummary(data.summary ?? null);
    setLabelErrors(data.errors ?? []);
  }, []);

  useEffect(() => {
    void Promise.all([loadTasks(), loadUpd()])
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не загрузилось."))
      .finally(() => setLoading(false));
  }, [loadTasks, loadUpd]);

  useEffect(() => {
    if (!taskId) return;
    void loadLabels(taskId).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не загрузилось."));
  }, [taskId, loadLabels]);

  // Поле не должно терять фокус: сканер печатает «в никуда», если фокус ушёл.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.activeElement !== inputRef.current && !busy) inputRef.current?.focus();
    }, 1200);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const online = () => setOffline(false);
    const down = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", down);
    setOffline(!navigator.onLine);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", down);
    };
  }, []);

  const prepare = useCallback(async (id: number, limit = 8) => {
    setPreparing(true);
    try {
      const response = await fetch("/api/warehouse/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: id, limit }),
      });
      const data = await response.json() as {
        prepared?: number; failed?: number; summary?: Summary; errors?: LabelError[]; messages?: string[]; error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Подготовка не прошла.");
      setSummary(data.summary ?? null);
      setLabelErrors(data.errors ?? []);
      for (const message of data.messages ?? []) toast.warning(message);
      return data;
    } finally {
      setPreparing(false);
    }
  }, []);

  // Этикетки готовятся заранее: пока в задании есть неготовые, экран
  // подтягивает их пачками сам, чтобы на столе не ждали API площадки.
  useEffect(() => {
    if (!taskId || !summary || preparing || offline) return;
    const left = summary.postings - summary.labelsReady - summary.labelsError;
    if (left <= 0) return;
    const timer = setTimeout(() => {
      void prepare(taskId).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [taskId, summary, preparing, offline, prepare]);

  function printLabel(marketplaceId: string, posting: string) {
    const frame = printFrame.current;
    if (!frame) return;
    frame.src = `/api/warehouse/labels/file?marketplace=${encodeURIComponent(marketplaceId)}&posting=${encodeURIComponent(posting)}`;
    // Печать запускается после загрузки файла: иначе на принтер уходит пустая страница.
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        toast.error("Не удалось открыть печать. Откройте этикетку вручную.");
      }
    };
  }

  async function submitScan(raw: string) {
    const uin = raw.trim();
    if (!uin || !taskId) return;
    setBusy(true);
    try {
      const response = await fetch("/api/warehouse/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uin, taskId }),
      });
      const data = await response.json() as { outcome?: Outcome; summary?: Summary; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Скан не обработан.");
      const result = data.outcome;
      if (!result) throw new Error("Пустой ответ сервера.");

      setOutcome(result);
      setSummary(data.summary ?? null);
      setHistory((current) => [
        { at: new Date().toISOString(), uin, status: result.status, text: OUTCOME_TEXT[result.status] },
        ...current,
      ].slice(0, 40));

      if (result.status === "ok") {
        beep("ok");
        printLabel(result.label.marketplaceId, result.label.externalOrderId);
      } else if (result.status === "foreign_task") {
        beep("error");
      } else {
        beep("warn");
      }
    } catch (error) {
      setOffline(!navigator.onLine);
      toast.error(error instanceof Error ? error.message : "Скан не обработан.");
    } finally {
      setValue("");
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function uploadUpd(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/warehouse/upd", { method: "POST", body: form });
      const data = await response.json() as { parsed?: number; newItems?: number; updated?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? "УПД не загрузилась.");
      toast.success(`УПД загружена: ${data.parsed ?? 0} УИН`, {
        description: `Новых: ${data.newItems ?? 0}, обновлено: ${data.updated ?? 0}`,
      });
      await loadUpd();
      if (taskId) await prepare(taskId).catch(() => undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "УПД не загрузилась.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
      inputRef.current?.focus();
    }
  }

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Готовим стол…</div>;
  }

  const task = tasks.find((item) => item.id === taskId) ?? null;
  const banner = outcome?.status === "ok"
    ? "border-emerald-300 bg-emerald-50 text-emerald-950"
    : outcome?.status === "foreign_task"
      ? "border-red-400 bg-red-100 text-red-950"
      : outcome
        ? "border-amber-300 bg-amber-50 text-amber-950"
        : "border-dashed bg-muted/40 text-muted-foreground";

  return (
    <div className="mx-auto max-w-[1200px] space-y-5 p-4 md:p-7">
      <iframe ref={printFrame} title="Печать этикетки" className="hidden" />

      {offline ? (
        <div className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <WifiOff className="size-4" /> Нет связи с сервером. Сканы не принимаются — дождитесь, пока связь вернётся.
        </div>
      ) : null}

      <Card>
        <CardContent className="space-y-4 px-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Задание, по которому идёт упаковка</p>
              <NativeSelect
                className="w-72"
                value={taskId ?? ""}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setTaskId(Number.isFinite(next) && next > 0 ? next : null);
                  setOutcome(null);
                }}
              >
                <option value="">Выберите задание…</option>
                {tasks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.number} — {item.marketplaceId === "ozon" ? "Ozon" : "WB"} · {item.itemCount} поз.
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                УИН в базе: {updInfo?.total ?? 0}, свободных {updInfo?.free ?? 0}
              </Badge>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadUpd(file);
                }}
              />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Upload className="size-4" /> Загрузить УПД
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!taskId || preparing}
                onClick={() => { if (taskId) void prepare(taskId, 20).catch(() => undefined); }}
              >
                {preparing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Подготовить этикетки
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Input
              ref={inputRef}
              autoFocus
              inputMode="numeric"
              placeholder="Сканируйте УИН"
              className="h-16 flex-1 min-w-64 text-center font-mono text-2xl"
              value={value}
              disabled={!taskId || busy}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitScan(value);
                }
              }}
            />
            {summary ? (
              <div className="flex gap-4 text-sm">
                <span><b className="text-lg">{summary.scanned}</b> / {summary.items} отсканировано</span>
                <span><b className="text-lg">{summary.labelsReady}</b> / {summary.postings} этикеток готово</span>
                {summary.labelsError > 0 ? <span className="text-destructive">{summary.labelsError} с ошибкой</span> : null}
              </div>
            ) : null}
          </div>

          <div className={`rounded-2xl border px-5 py-6 ${banner}`}>
            {outcome === null ? (
              <p className="flex items-center gap-2 text-sm"><ScanLine className="size-4" /> Отсканируйте УИН изделия — этикетка напечатается сама.</p>
            ) : outcome.status === "ok" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><CheckCircle2 className="size-6" /> Этикетка на печать</p>
                <p className="font-mono text-2xl font-bold">{outcome.item.article}{outcome.item.size ? ` / ${outcome.item.size}` : ""}</p>
                <p className="text-sm">
                  {outcome.item.marketplaceId === "ozon" ? "Ozon" : "Wildberries"} · отправление{" "}
                  <span className="font-mono">{outcome.item.externalOrderId}</span>
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => printLabel(outcome.label.marketplaceId, outcome.label.externalOrderId)}
                >
                  <Printer className="size-4" /> Напечатать ещё раз
                </Button>
              </div>
            ) : outcome.status === "foreign_task" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Изделие из другого задания</p>
                <p className="text-lg">Артикул <span className="font-mono font-bold">{outcome.article}</span> относится к заданию {outcome.taskNumber ?? "—"}.</p>
                <p className="text-sm">Этикетка не напечатана. Отложите изделие и проверьте, из какой партии оно пришло.</p>
              </div>
            ) : outcome.status === "repeat" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Повторный скан</p>
                <p className="text-lg">
                  УИН <span className="font-mono">{outcome.uin}</span> уже отсканирован по отправлению{" "}
                  <span className="font-mono">{outcome.item.externalOrderId}</span>.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() => printLabel(outcome.item.marketplaceId, outcome.item.externalOrderId)}
                >
                  <Printer className="size-4" /> Напечатать этикетку заново
                </Button>
              </div>
            ) : outcome.status === "uin_unknown" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> УИН не найден в УПД</p>
                <p className="text-lg font-mono">{outcome.uin}</p>
                <p className="text-sm">Загрузите свежую УПД — без неё связь «УИН → артикул» не построить.</p>
              </div>
            ) : outcome.status === "not_in_task" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Изделия нет в заданиях</p>
                <p className="text-lg">Артикул <span className="font-mono font-bold">{outcome.article}</span> не попал ни в одно открытое задание.</p>
                <p className="text-sm">Проверьте, не отменён ли заказ и сформированы ли задания.</p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Этикетка ещё не готова</p>
                <p className="text-sm">
                  Отправление <span className="font-mono">{outcome.item.externalOrderId}</span>.
                  {outcome.error ? ` ${outcome.error}` : " Подготовка идёт, повторите скан через несколько секунд."}
                </p>
                <Button size="sm" variant="outline" className="mt-2" disabled={preparing} onClick={() => { if (taskId) void prepare(taskId, 5).catch(() => undefined); }}>
                  {preparing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Подготовить сейчас
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {labelErrors.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4" /> Этикетки с ошибкой</CardTitle>
            <CardDescription>Эти отправления на столе не напечатаются, пока причина не устранена.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 px-5">
            {labelErrors.map((row) => (
              <div key={row.id} className="rounded-lg border px-3 py-2 text-sm">
                <span className="font-mono">{row.externalOrderId}</span>
                {row.article ? <span className="ml-2 font-mono text-xs text-muted-foreground">{row.article}</span> : null}
                <p className="mt-1 text-xs text-destructive">{row.error}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="border-b px-5 py-4">
          <p className="font-semibold">Последние сканы {task ? `· задание ${task.number}` : ""}</p>
        </div>
        <div className="max-h-80 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Время</TableHead>
                <TableHead>УИН</TableHead>
                <TableHead className="pr-5">Результат</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((row, index) => (
                <TableRow key={`${row.uin}-${index}`} className={row.status === "ok" ? undefined : "bg-amber-50/60"}>
                  <TableCell className="pl-5 text-xs text-muted-foreground">{formatMoment(row.at)}</TableCell>
                  <TableCell className="font-mono text-xs">{row.uin}</TableCell>
                  <TableCell className="pr-5 text-sm">{row.text}</TableCell>
                </TableRow>
              ))}
              {history.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="h-24 text-center text-muted-foreground">Сканов пока не было.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>
    </div>
  );
}
