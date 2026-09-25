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
 *
 * Два исхода требуют действия, а не только внимания:
 *   — в отправлении несколько изделий: синий экран с номером ячейки
 *     комплектации, печать — из окна отправлений, когда собрано всё;
 *   — на Wildberries размер у заказа есть, а в УПД его нет: поле ввода
 *     блокируется, пока человек не подтвердит или не отклонит.
 *
 * Работа начинается со скана листа подбора: пока лист не отсканирован, поле
 * принимает только его код (12 цифр), и выбрать задание из списка нельзя —
 * так на столе не окажется чужая партия. Дальше то же поле принимает УИН.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ClipboardCheck,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { parsePickSheetScan } from "@/lib/barcode39.mjs";
import { marketplaceLabel } from "@/lib/marketplaces";
import { formatMoment } from "@/lib/utils";

type Task = {
  id: number;
  number: string;
  marketplaceId: "ozon" | "wildberries" | "yandex";
  warehouseName: string | null;
  status: string;
  itemCount: number;
};

type Summary = {
  items: number;
  scanned: number;
  postings: number;
  multiPostings: number;
  multiComplete: number;
  preparable: number;
  labelsReady: number;
  labelsError: number;
  labelsPending: number;
};

type BoardItem = { itemId: number; article: string; size: string | null; uin: string | null; scannedAt: string | null };

type BoardRow = {
  marketplaceId: string;
  externalOrderId: string;
  slot: number | null;
  total: number;
  scanned: number;
  labelStatus: string | null;
  labelError: string | null;
  printedAt: string | null;
  printCount: number;
  items: BoardItem[];
};

type LabelError = { id: number; externalOrderId: string; article: string | null; error: string | null };

/** Отправление, по которому УИН уже у площадки и идёт проверка. */
type LabelWaiting = {
  id: number;
  externalOrderId: string;
  article: string | null;
  note: string | null;
  exemplarStatus: string | null;
};

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
  | { status: "grouped"; uin: string; item: ScanItem; slot: number | null; scanned: number; total: number; complete: boolean }
  | { status: "size_confirm"; uin: string; item: ScanItem; orderSize: string; updSize: string | null }
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
  grouped: "В ячейку комплектации, отправление из нескольких изделий",
  size_confirm: "Нужно подтвердить размер",
  repeat: "Этот УИН уже сканировали",
  uin_unknown: "УИН не найден в УПД",
  foreign_task: "Изделие из другого задания",
  not_in_task: "Изделия нет ни в одном задании",
  label_not_ready: "Этикетка ещё не готова",
};

export function WarehouseScanWorkspace() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<number | null>(null);
  // Код с листа подбора: пропуск к упаковке. Уходит с каждым сканом, и сервер
  // проверяет его сам — без листа скан УИН не принимается.
  const [sheetCode, setSheetCode] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [labelErrors, setLabelErrors] = useState<LabelError[]>([]);
  const [labelWaiting, setLabelWaiting] = useState<LabelWaiting[]>([]);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [pendingSize, setPendingSize] = useState<{ uin: string; item: ScanItem; orderSize: string } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [receiveConfirm, setReceiveConfirm] = useState<{ code: string; number: string; pendingCount: number } | null>(null);
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
  }, []);

  const loadUpd = useCallback(async () => {
    const response = await fetch("/api/warehouse/upd", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { total?: number; free?: number };
    setUpdInfo({ total: data.total ?? 0, free: data.free ?? 0 });
  }, []);

  const loadLabels = useCallback(async (id: number) => {
    const response = await fetch(`/api/warehouse/labels?task=${id}`, { cache: "no-store" });
    const data = await response.json() as {
      summary?: Summary; errors?: LabelError[]; waitingLabels?: LabelWaiting[]; board?: BoardRow[]; error?: string;
    };
    if (!response.ok) throw new Error(data.error ?? "Состояние этикеток не загрузилось.");
    setSummary(data.summary ?? null);
    setLabelErrors(data.errors ?? []);
    setLabelWaiting(data.waitingLabels ?? []);
    setBoard(data.board ?? []);
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
      // Пока ждём подтверждения размера, поле выключено: случайный скан не
      // должен проскочить мимо вопроса.
      if (pendingSize || busy) return;
      const active = document.activeElement;
      if (active === inputRef.current) return;
      // Человек сейчас работает с другим полем: выбирает задание в списке или
      // что-то вводит. Забрать фокус — значит закрыть открытый список прямо
      // под курсором, выбрать строку тогда невозможно. Фокус вернётся, когда
      // человек уйдёт из поля (выбор задания сам возвращает его в скан).
      if (active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) return;
      if (active instanceof HTMLInputElement && active.type !== "file") return;
      if (active instanceof HTMLElement && active.isContentEditable) return;
      inputRef.current?.focus();
    }, 1200);
    return () => clearInterval(timer);
  }, [busy, pendingSize]);

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
        prepared?: number; failed?: number; validating?: number; summary?: Summary;
        errors?: LabelError[]; waitingLabels?: LabelWaiting[]; board?: BoardRow[]; messages?: string[]; error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Подготовка не прошла.");
      setSummary(data.summary ?? null);
      setLabelErrors(data.errors ?? []);
      setLabelWaiting(data.waitingLabels ?? []);
      setBoard(data.board ?? []);
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
    // Отправление из нескольких изделий готовится только после того, как
    // отсканировано целиком: пока не собрано, дёргать площадку нечем.
    const left = summary.preparable - summary.labelsReady - summary.labelsError;
    if (left <= 0) return;
    // Проверка УИН в Ozon идёт минутами. Пока весь остаток — это ожидание
    // площадки, спрашивать чаще незачем: работы от этого не прибавится, а
    // запросы к API тратятся впустую.
    const onlyWaiting = summary.labelsPending > 0 && summary.labelsPending >= left;
    const timer = setTimeout(() => {
      void prepare(taskId).catch(() => undefined);
    }, onlyWaiting ? 6000 : 1500);
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

  /** Приём задания по скану листа подбора — единственный вход на стол. */
  async function receiveTask(input: { code: string; confirm?: boolean }) {
    setBusy(true);
    try {
      const response = await fetch("/api/warehouse/receive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await response.json() as {
        error?: string; needsConfirm?: boolean; pendingCount?: number; closed?: boolean;
        task?: { id: number; number: string; status: string };
      };
      if (!response.ok || !data.task) throw new Error(data.error ?? "Задание не принято.");
      if (data.needsConfirm) {
        setReceiveConfirm({ code: input.code, number: data.task.number, pendingCount: data.pendingCount ?? 0 });
        beep("warn");
        return;
      }
      setReceiveConfirm(null);
      await loadTasks();
      setTaskId(data.task.id);
      setSheetCode(input.code);
      setOutcome(null);
      beep("ok");
      toast.success(`Задание ${data.task.number} принято на упаковку`, {
        description: data.closed ? "Сборщик не закрыл его на экране — закрыто при приёме." : undefined,
      });
    } catch (error) {
      beep("error");
      toast.error(error instanceof Error ? error.message : "Задание не принято.");
    } finally {
      setBusy(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function submitScan(raw: string, confirmSize = false) {
    const uin = raw.trim();
    if (!uin) return;
    // Лист подбора в поле УИН — это приём задания, а не изделие. Он же меняет
    // задание на столе: отсканировали другой лист — упаковка идёт по нему.
    if (parsePickSheetScan(uin)) {
      setValue("");
      await receiveTask({ code: uin });
      return;
    }
    if (!taskId || !sheetCode) {
      beep("warn");
      toast.warning("Сначала отсканируйте штрихкод листа подбора.");
      setValue("");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/warehouse/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uin, code: sheetCode, confirmSize }),
      });
      const data = await response.json() as {
        outcome?: Outcome; summary?: Summary; board?: BoardRow[]; error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Скан не обработан.");
      const result = data.outcome;
      if (!result) throw new Error("Пустой ответ сервера.");

      setOutcome(result);
      setSummary(data.summary ?? null);
      if (data.board) setBoard(data.board);
      setHistory((current) => [
        { at: new Date().toISOString(), uin, status: result.status, text: OUTCOME_TEXT[result.status] },
        ...current,
      ].slice(0, 40));

      if (result.status === "size_confirm") {
        // Ничего не записано: ждём ответа человека и держим скан у себя.
        setPendingSize({ uin: result.uin, item: result.item, orderSize: result.orderSize });
        beep("warn");
        return;
      }
      setPendingSize(null);

      if (result.status === "ok") {
        beep("ok");
        printLabel(result.label.marketplaceId, result.label.externalOrderId);
      } else if (result.status === "grouped") {
        beep("ok");
        // Этикетка печатается из окна отправлений, когда собрано всё.
        if (result.complete && taskId) void prepare(taskId, 4).catch(() => undefined);
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
      if (!pendingSize) inputRef.current?.focus();
    }
  }

  function rejectSize() {
    const pending = pendingSize;
    setPendingSize(null);
    setOutcome(null);
    if (pending) {
      setHistory((current) => [
        {
          at: new Date().toISOString(),
          uin: pending.uin,
          // as const: без него литерал расширяется до string, а история
          // ждёт один из известных исходов.
          status: "size_confirm" as const,
          text: "Размер не подтверждён, изделие отложено",
        },
        ...current,
      ].slice(0, 40));
    }
    inputRef.current?.focus();
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
    : outcome?.status === "grouped"
      ? "border-sky-400 bg-sky-50 text-sky-950"
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
          {receiveConfirm ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="size-4" />
              <span className="flex-1">
                Сборщик не закрыл задание <b className="font-mono">{receiveConfirm.number}</b>
                {receiveConfirm.pendingCount > 0 ? <> — строк без отметки: <b>{receiveConfirm.pendingCount}</b>. Они будут считаться собранными.</> : "."}
                {" "}Если чего-то нет — сначала отметьте «Не найден» в задании.
              </span>
              <Button size="sm" disabled={busy} onClick={() => void receiveTask({ code: receiveConfirm.code, confirm: true })}>
                Принять задание
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setReceiveConfirm(null)}>
                Отмена
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Задание, по которому идёт упаковка</p>
              {/* Задание выбирает лист подбора, а не список: руками его тут
                  выбрать нельзя — иначе на стол попадёт чужая партия. */}
              {task && sheetCode ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xl font-bold">{task.number}</span>
                  <Badge variant="secondary">
                    {marketplaceLabel(task.marketplaceId, true)} · {task.itemCount} поз.
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">лист {sheetCode}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setSheetCode(null);
                      setTaskId(null);
                      setOutcome(null);
                      setSummary(null);
                      setBoard([]);
                      setLabelErrors([]);
                      window.setTimeout(() => inputRef.current?.focus(), 0);
                    }}
                  >
                    Закрыть стол
                  </Button>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-lg font-semibold">
                  <ClipboardCheck className="size-5" /> Отсканируйте лист подбора
                </p>
              )}
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
              placeholder={pendingSize ? "Ответьте на вопрос ниже" : taskId && sheetCode ? "Сканируйте УИН" : "Сканируйте штрихкод листа подбора"}
              className="h-16 flex-1 min-w-64 text-center font-mono text-2xl"
              value={value}
              disabled={busy || pendingSize !== null}
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
                {summary.multiPostings > 0 ? (
                  <span className="text-sky-700">
                    сборных отправлений: <b>{summary.multiComplete}</b> / {summary.multiPostings}
                  </span>
                ) : null}
                {summary.labelsError > 0 ? <span className="text-destructive">{summary.labelsError} с ошибкой</span> : null}
              </div>
            ) : null}
          </div>

          <div className={`rounded-2xl border px-5 py-6 ${banner}`}>
            {outcome === null ? (
              <p className="flex items-center gap-2 text-sm">
                <ScanLine className="size-4" />
                {taskId && sheetCode
                  ? "Отсканируйте УИН изделия — этикетка напечатается сама."
                  : "Отсканируйте штрихкод листа подбора — или введите его 12 цифр руками и нажмите Enter."}
              </p>
            ) : outcome.status === "ok" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><CheckCircle2 className="size-6" /> Этикетка на печать</p>
                <p className="font-mono text-2xl font-bold">{outcome.item.article}{outcome.item.size ? ` / ${outcome.item.size}` : ""}</p>
                <p className="text-sm">
                  {marketplaceLabel(outcome.item.marketplaceId)} · отправление{" "}
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
            ) : outcome.status === "grouped" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><Boxes className="size-6" /> В отправлении несколько изделий</p>
                <p className="font-mono text-2xl font-bold">{outcome.item.article}{outcome.item.size ? ` / ${outcome.item.size}` : ""}</p>
                <p className="text-lg">
                  Отложите в ячейку комплектации{" "}
                  <span className="rounded bg-sky-200 px-2 font-mono text-3xl font-bold">{outcome.slot ?? "—"}</span>
                </p>
                <p className="text-sm">
                  Отправление <span className="font-mono">{outcome.item.externalOrderId}</span> · отсканировано{" "}
                  <b>{outcome.scanned}</b> из <b>{outcome.total}</b>.{" "}
                  {outcome.complete
                    ? "Отправление собрано — этикетка готовится, напечатайте её в списке ниже."
                    : "Этикетка напечатается, когда отсканируете остальные изделия этого отправления."}
                </p>
              </div>
            ) : outcome.status === "size_confirm" ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Подтвердите размер</p>
                <p className="font-mono text-2xl font-bold">{outcome.item.article}</p>
                <p className="text-lg">
                  На Wildberries заказан размер{" "}
                  <span className="rounded bg-amber-200 px-2 font-mono font-bold">{outcome.orderSize}</span>, а в УПД{" "}
                  {outcome.updSize
                    ? <>указан <span className="rounded bg-amber-200 px-2 font-mono font-bold">{outcome.updSize}</span>.</>
                    : "размер не указан."}
                </p>
                <p className="text-sm">Проверьте изделие в руках. Подтверждаете, что это тот самый размер?</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="lg"
                    disabled={busy}
                    onClick={() => { const pending = pendingSize; if (pending) void submitScan(pending.uin, true); }}
                  >
                    <CheckCircle2 className="size-5" /> Да, размер тот
                  </Button>
                  <Button size="lg" variant="outline" disabled={busy} onClick={rejectSize}>
                    Нет, отложить изделие
                  </Button>
                </div>
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

      {board.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="size-4" /> Отправления из нескольких изделий
            </CardTitle>
            <CardDescription>
              Каждое такое отправление собирается в своей ячейке комплектации. Когда отсканированы все изделия,
              нажмите на номер отправления — этикетка уйдёт на печать.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 px-5 md:grid-cols-2">
            {board.map((row) => {
              const complete = row.scanned >= row.total;
              const ready = row.labelStatus === "ready";
              return (
                <div
                  key={`${row.marketplaceId}-${row.externalOrderId}`}
                  className={`rounded-xl border px-4 py-3 ${complete ? "border-sky-400 bg-sky-50" : "bg-muted/30"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="grid size-10 place-items-center rounded-lg bg-sky-200 font-mono text-xl font-bold text-sky-950">
                        {row.slot ?? "—"}
                      </span>
                      <div>
                        <button
                          type="button"
                          disabled={!complete || !ready}
                          className="font-mono text-base font-bold underline-offset-2 hover:underline disabled:no-underline disabled:opacity-60"
                          onClick={() => printLabel(row.marketplaceId, row.externalOrderId)}
                        >
                          {row.externalOrderId}
                        </button>
                        <p className="text-xs text-muted-foreground">
                          {marketplaceLabel(row.marketplaceId)} · отсканировано {row.scanned} из {row.total}
                          {row.printCount > 0 ? ` · печаталась ${row.printCount} раз` : ""}
                        </p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={complete && ready ? "default" : "outline"}
                      disabled={!complete || !ready}
                      onClick={() => printLabel(row.marketplaceId, row.externalOrderId)}
                    >
                      <Printer className="size-4" /> {ready ? "Печать" : row.labelStatus === "error" && complete ? "Ошибка" : complete ? "Готовится…" : "Не собрано"}
                    </Button>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {row.items.map((item) => (
                      <li key={item.itemId} className="flex items-center gap-2">
                        {item.scannedAt
                          ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                          : <span className="inline-block size-4 shrink-0 rounded-full border border-muted-foreground/40" />}
                        <span className="font-mono">{item.article}{item.size ? ` / ${item.size}` : ""}</span>
                        {item.uin ? <span className="font-mono text-xs text-muted-foreground">{item.uin}</span> : null}
                      </li>
                    ))}
                  </ul>
                  {row.labelError ? <p className="mt-2 text-xs text-destructive">{row.labelError}</p> : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {/* Ожидание проверки УИН — не ошибка, поэтому и список отдельный: иначе
          кладовщик видит красное и зовёт старшего там, где надо просто ждать. */}
      {labelWaiting.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Loader2 className="size-4 animate-spin" /> Ozon проверяет УИН
            </CardTitle>
            <CardDescription>
              Делать ничего не нужно: проверка идёт на стороне площадки и занимает несколько минут.
              Этикетки напечатаются сами, как только Ozon разрешит сборку.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 px-5">
            {labelWaiting.map((row) => (
              <div key={row.id} className="rounded-lg border px-3 py-2 text-sm">
                <span className="font-mono">{row.externalOrderId}</span>
                {row.article ? <span className="ml-2 font-mono text-xs text-muted-foreground">{row.article}</span> : null}
                <p className="mt-1 text-xs text-muted-foreground">
                  {row.note}
                  {row.exemplarStatus ? ` (статус ${row.exemplarStatus})` : ""}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

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
