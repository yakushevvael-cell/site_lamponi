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
 * В отправлении несколько изделий — синий экран с номером ячейки
 * комплектации, печать — из окна отправлений, когда собрано всё.
 *
 * Работа начинается со скана листа подбора: пока лист не отсканирован, поле
 * принимает только его код (12 цифр), и выбрать задание из списка нельзя —
 * так на столе не окажется чужая партия. Затем загружается УПД этого задания:
 * сайт сверяет её с заданием по «артикул + размер» и закрепляет УИН за
 * отправлениями. Пока УПД не сверена, скан УИН и этикетки заблокированы.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
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
  updMatched: boolean;
  items: number;
  scanned: number;
  postings: number;
  multiPostings: number;
  multiComplete: number;
  preparable: number;
  labelsReady: number;
  labelsError: number;
  labelsPending: number;
  /** Отменено площадкой: не ошибка, а «не упаковывать». */
  labelsCancelled?: number;
};

/** УПД задания: сверена ли и что не сошлось в последней загрузке. */
type UpdInfo = {
  matched: boolean;
  matchedAt: string | null;
  lastUpload: {
    fileName: string;
    status: "matched" | "mismatch" | null;
    problems: string[];
    conflicts: Array<{ uin: string; taskId: number; taskNumber: string | null }>;
    createdAt: string;
  } | null;
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

/** Отправление, отменённое площадкой: изделие возвращается в ячейку. */
type LabelCancelled = { id: number; marketplaceId: string; externalOrderId: string; article: string | null; size: string | null };

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
  | { status: "uin_unknown"; uin: string }
  | { status: "foreign_task"; uin: string; article: string; taskNumber: string | null }
  | { status: "repeat"; uin: string; item: ScanItem }
  | { status: "cancelled"; uin: string; item: ScanItem; message: string }
  | { status: "label_not_ready"; uin: string; item: ScanItem; error: string | null };

/** timing — сколько шли скан и файл этикетки: видно, ждали сайт или окно печати. */
type HistoryRow = { at: string; uin: string; status: Outcome["status"]; text: string; timing?: string };

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
}

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
  repeat: "Этот УИН уже сканировали",
  uin_unknown: "Этого УИН нет в этом сборочном задании",
  foreign_task: "Изделие из другого задания",
  cancelled: "Заказ отменён — не упаковывать",
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
  const [labelCancelled, setLabelCancelled] = useState<LabelCancelled[]>([]);
  const [labelWaiting, setLabelWaiting] = useState<LabelWaiting[]>([]);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [receiveConfirm, setReceiveConfirm] = useState<{ code: string; number: string; pendingCount: number } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [updInfo, setUpdInfo] = useState<UpdInfo | null>(null);
  const [detachingUin, setDetachingUin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const printFrame = useRef<HTMLIFrameElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadTasks = useCallback(async () => {
    const response = await fetch("/api/warehouse/tasks?brief=1", { cache: "no-store" });
    const data = await response.json() as { tasks?: Task[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Задания не загрузились.");
    // На столе упаковки нужны собранные задания: до них товар не доходит.
    const usable = (data.tasks ?? []).filter((task) => task.status === "picked" || task.status === "issued");
    setTasks(usable);
  }, []);

  const loadUpd = useCallback(async (id: number) => {
    const response = await fetch(`/api/warehouse/upd?task=${id}`, { cache: "no-store" });
    if (!response.ok) return;
    setUpdInfo(await response.json() as UpdInfo);
  }, []);

  const loadLabels = useCallback(async (id: number) => {
    const response = await fetch(`/api/warehouse/labels?task=${id}`, { cache: "no-store" });
    const data = await response.json() as {
      summary?: Summary; errors?: LabelError[]; cancelled?: LabelCancelled[];
      waitingLabels?: LabelWaiting[]; board?: BoardRow[]; error?: string;
    };
    if (!response.ok) throw new Error(data.error ?? "Состояние этикеток не загрузилось.");
    setSummary(data.summary ?? null);
    setLabelErrors(data.errors ?? []);
    setLabelCancelled(data.cancelled ?? []);
    setLabelWaiting(data.waitingLabels ?? []);
    setBoard(data.board ?? []);
  }, []);

  useEffect(() => {
    void loadTasks()
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не загрузилось."))
      .finally(() => setLoading(false));
  }, [loadTasks]);

  useEffect(() => {
    if (!taskId) return;
    void Promise.all([loadLabels(taskId), loadUpd(taskId)])
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не загрузилось."));
  }, [taskId, loadLabels, loadUpd]);

  // Поле не должно терять фокус: сканер печатает «в никуда», если фокус ушёл.
  useEffect(() => {
    const timer = setInterval(() => {
      if (busy) return;
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

  // retryStopped — только по кнопке: строки, на которые WB ответил 409, сам
  // стол больше не повторяет.
  const prepare = useCallback(async (id: number, limit = 8, retryStopped = false) => {
    setPreparing(true);
    try {
      const response = await fetch("/api/warehouse/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: id, limit, retryStopped }),
      });
      const data = await response.json() as {
        prepared?: number; failed?: number; validating?: number; summary?: Summary;
        errors?: LabelError[]; cancelled?: LabelCancelled[]; waitingLabels?: LabelWaiting[];
        board?: BoardRow[]; messages?: string[]; error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Подготовка не прошла.");
      setSummary(data.summary ?? null);
      setLabelErrors(data.errors ?? []);
      setLabelCancelled(data.cancelled ?? []);
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
    // Пока УПД задания не сверена, готовить нечего: УИН не закреплены.
    if (!taskId || !summary || !summary.updMatched || preparing || offline) return;
    // Отправление из нескольких изделий готовится только после того, как
    // отсканировано целиком: пока не собрано, дёргать площадку нечем.
    const left = summary.preparable - summary.labelsReady - summary.labelsError - (summary.labelsCancelled ?? 0);
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

  function printLabel(marketplaceId: string, posting: string, onLoaded?: (ms: number) => void) {
    const frame = printFrame.current;
    if (!frame) return;
    const started = performance.now();
    frame.src = `/api/warehouse/labels/file?marketplace=${encodeURIComponent(marketplaceId)}&posting=${encodeURIComponent(posting)}`;
    // Печать запускается после загрузки файла: иначе на принтер уходит пустая страница.
    frame.onload = () => {
      onLoaded?.(performance.now() - started);
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
      if (data.task.id !== taskId) setUpdInfo(null);
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

  async function submitScan(raw: string) {
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
    const started = performance.now();
    try {
      const response = await fetch("/api/warehouse/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uin, code: sheetCode }),
      });
      const data = await response.json() as {
        outcome?: Outcome; summary?: Summary; board?: BoardRow[]; error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Скан не обработан.");
      const result = data.outcome;
      if (!result) throw new Error("Пустой ответ сервера.");
      const scanMs = performance.now() - started;
      const at = new Date().toISOString();

      setOutcome(result);
      setSummary(data.summary ?? null);
      if (data.board) setBoard(data.board);
      setHistory((current) => [
        { at, uin, status: result.status, text: OUTCOME_TEXT[result.status], timing: `скан ${seconds(scanMs)}` },
        ...current,
      ].slice(0, 40));

      if (result.status === "ok") {
        beep("ok");
        // Время до окна печати делится на скан, файл этикетки и сам браузер:
        // если первые два малы, а окно всё равно долго не появляется, ждут
        // принтер или окно печати, а не сайт.
        printLabel(result.label.marketplaceId, result.label.externalOrderId, (fileMs) => {
          setHistory((current) => current.map((row) => (
            row.at === at && row.uin === uin ? { ...row, timing: `скан ${seconds(scanMs)} · этикетка ${seconds(fileMs)}` } : row
          )));
        });
      } else if (result.status === "grouped") {
        beep("ok");
        // Этикетка печатается из окна отправлений, когда собрано всё.
        if (result.complete && taskId) void prepare(taskId, 4).catch(() => undefined);
      } else if (result.status === "label_not_ready") {
        beep("warn");
        // Этикетка ещё готовится — подтолкнём подготовку, повторный скан напечатает.
        if (taskId) void prepare(taskId, 4).catch(() => undefined);
      } else if (result.status === "foreign_task" || result.status === "cancelled") {
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

  /**
   * УПД загружается к заданию на столе: сервер сверяет её с заданием и при
   * полном совпадении закрепляет УИН за отправлениями. Расхождения остаются
   * на экране списком — до верной УПД упаковка по заданию заблокирована.
   */
  async function uploadUpd(file: File) {
    if (!taskId || !sheetCode) {
      toast.warning("Сначала отсканируйте лист подбора, затем загрузите УПД.");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("code", sheetCode);
      const response = await fetch("/api/warehouse/upd", { method: "POST", body: form });
      const data = await response.json() as { bound?: number; problems?: string[]; error?: string };
      await loadUpd(taskId);
      if (!response.ok) {
        beep("error");
        throw new Error(data.error ?? "УПД не загрузилась.");
      }
      beep("ok");
      toast.success(`УПД сверена: закреплено ${data.bound ?? 0} УИН`, {
        description: "УИН передаются на площадку, этикетки готовятся.",
      });
      await loadLabels(taskId);
      // Подготовка идёт фоном: ответы площадок по пачке этикеток — секунды,
      // и держать на них поле скана заблокированным незачем.
      void prepare(taskId).catch(() => undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "УПД не загрузилась.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
      inputRef.current?.focus();
    }
  }

  async function detachForeignUin(uin: string) {
    if (!taskId || !sheetCode) return;
    setBusy(true);
    setDetachingUin(uin);
    try {
      const response = await fetch("/api/warehouse/upd", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uin, code: sheetCode }),
      });
      const data = await response.json() as {
        error?: string;
        previousTaskNumber?: string | null;
        alreadyDetached?: boolean;
      };
      if (!response.ok) throw new Error(data.error ?? `Не удалось открепить УИН ${uin}.`);
      await loadUpd(taskId);
      beep("ok");
      toast.success(data.alreadyDetached ? `УИН ${uin} уже был откреплён` : `УИН ${uin} откреплён`, {
        description: data.previousTaskNumber
          ? `Прежнее задание: ${data.previousTaskNumber}. Загрузите УПД снова.`
          : "Загрузите УПД снова.",
      });
    } catch (error) {
      beep("error");
      toast.error(error instanceof Error ? error.message : `Не удалось открепить УИН ${uin}.`);
    } finally {
      setDetachingUin(null);
      setBusy(false);
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
      : outcome?.status === "foreign_task" || outcome?.status === "cancelled"
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
                      setUpdInfo(null);
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
              {taskId && sheetCode ? (
                updInfo?.matched
                  ? <Badge variant="secondary"><CheckCircle2 className="size-3" /> УПД сверена</Badge>
                  : <Badge variant="destructive">УПД не загружена</Badge>
              ) : null}
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
              <Button
                size="sm"
                variant={taskId && sheetCode && updInfo && !updInfo.matched ? "default" : "outline"}
                disabled={busy || !taskId || !sheetCode || Boolean(updInfo?.matched)}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="size-4" /> Загрузить УПД задания
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!taskId || preparing || !updInfo?.matched}
                onClick={() => { if (taskId) void prepare(taskId, 20, true).catch(() => undefined); }}
              >
                {preparing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Подготовить этикетки
              </Button>
            </div>
          </div>

          {taskId && sheetCode && updInfo && !updInfo.matched ? (
            <div className="space-y-2 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-950">
              <p className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="size-4" />
                {updInfo.lastUpload?.status === "mismatch"
                  ? updInfo.lastUpload.conflicts.length > 0
                    ? `УПД «${updInfo.lastUpload.fileName}» не сходится с заданием. Открепите УИН из других заданий и загрузите УПД снова.`
                    : `УПД «${updInfo.lastUpload.fileName}» не сходится с заданием. Исправьте УПД и загрузите заново.`
                  : "Загрузите УПД этого задания."}
              </p>
              <p>Пока УПД не сверена с заданием, скан УИН и этикетки по заданию заблокированы, на площадку ничего не передаётся.</p>
              {updInfo.lastUpload?.status === "mismatch" && updInfo.lastUpload.conflicts.length > 0 ? (
                <div className="space-y-2">
                  <p>Эти УИН присутствуют в других заданиях. Если прежний заказ отменён, открепите УИН и загрузите УПД снова.</p>
                  <div className="space-y-2">
                    {updInfo.lastUpload.conflicts.map((conflict) => (
                      <div
                        key={`${conflict.uin}-${conflict.taskId}`}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-white/70 px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 font-mono text-xs">
                          УИН {conflict.uin} · задание {conflict.taskNumber ?? conflict.taskId}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void detachForeignUin(conflict.uin)}
                        >
                          {detachingUin === conflict.uin ? <Loader2 className="size-4 animate-spin" /> : null}
                          Открепить
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {updInfo.lastUpload?.status === "mismatch" && updInfo.lastUpload.problems.length > 0 ? (
                <ul className="max-h-60 list-disc space-y-0.5 overflow-auto pl-5 font-mono text-xs">
                  {updInfo.lastUpload.problems
                    .filter((problem) => !updInfo.lastUpload?.conflicts.some(
                      (conflict) => problem === `УИН ${conflict.uin} уже закреплён за заданием ${conflict.taskNumber ?? conflict.taskId}.`,
                    ))
                    .map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Input
              ref={inputRef}
              autoFocus
              inputMode="numeric"
              placeholder={taskId && sheetCode ? (updInfo?.matched ? "Сканируйте УИН" : "Загрузите УПД задания") : "Сканируйте штрихкод листа подбора"}
              className="h-16 flex-1 min-w-64 text-center font-mono text-2xl"
              value={value}
              disabled={busy}
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
                {summary.labelsCancelled ? <span className="font-semibold text-red-700">{summary.labelsCancelled} отменено — не упаковывать</span> : null}
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
            ) : outcome.status === "foreign_task" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Изделие из другого задания</p>
                <p className="text-lg">Артикул <span className="font-mono font-bold">{outcome.article}</span> относится к заданию {outcome.taskNumber ?? "—"}.</p>
                <p className="text-sm">Этикетка не напечатана. Отложите изделие и проверьте, из какой партии оно пришло.</p>
              </div>
            ) : outcome.status === "cancelled" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><Ban className="size-6" /> Заказ отменён — не упаковывать</p>
                <p className="font-mono text-2xl font-bold">{outcome.item.article}{outcome.item.size ? ` / ${outcome.item.size}` : ""}</p>
                <p className="text-lg">
                  Верните изделие в ячейку{" "}
                  <span className="rounded bg-red-200 px-2 font-mono text-3xl font-bold">{outcome.item.cellCode ?? "—"}</span>
                </p>
                <p className="text-sm">
                  {marketplaceLabel(outcome.item.marketplaceId)} · отправление{" "}
                  <span className="font-mono">{outcome.item.externalOrderId}</span>. {outcome.message}
                </p>
              </div>
            ) : outcome.status === "repeat" ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Повторный скан</p>
                <p className="text-lg">
                  УИН <span className="font-mono">{outcome.uin}</span> уже отсканирован по отправлению{" "}
                  <span className="font-mono">{outcome.item.externalOrderId}</span>. Распечатать уже напечатанную этикетку ещё раз?
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
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Этого УИН нет в этом сборочном задании</p>
                <p className="text-lg font-mono">{outcome.uin}</p>
                <p className="text-sm">Этикетка не напечатана. УИН нет в УПД задания — отложите изделие и проверьте, откуда оно.</p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="flex items-center gap-2 text-xl font-bold"><AlertTriangle className="size-6" /> Этикетка ещё не готова</p>
                <p className="text-sm">
                  Отправление <span className="font-mono">{outcome.item.externalOrderId}</span>.
                  {outcome.error ? ` ${outcome.error}` : " Подготовка идёт, повторите скан через несколько секунд."}
                </p>
                <Button size="sm" variant="outline" className="mt-2" disabled={preparing} onClick={() => { if (taskId) void prepare(taskId, 5, true).catch(() => undefined); }}>
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

      {labelCancelled.length > 0 ? (
        <Card className="border-red-300">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-red-800">
              <Ban className="size-4" /> Отменены площадкой — не упаковывать ({labelCancelled.length})
            </CardTitle>
            <CardDescription>
              Этикеток по этим отправлениям не будет. Изделия верните в ячейки: при скане стол покажет, в какую.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 px-5 md:grid-cols-2">
            {labelCancelled.map((row) => (
              <div key={row.id} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm">
                <span className="font-mono">{row.externalOrderId}</span>
                <span className="ml-2 text-xs text-muted-foreground">{marketplaceLabel(row.marketplaceId)}</span>
                {row.article ? (
                  <p className="font-mono text-xs">{row.article}{row.size ? ` / ${row.size}` : ""}</p>
                ) : null}
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
                  <TableCell className="pr-5 text-sm">
                    {row.text}
                    {row.timing ? <span className="ml-2 text-xs text-muted-foreground">{row.timing}</span> : null}
                  </TableCell>
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
