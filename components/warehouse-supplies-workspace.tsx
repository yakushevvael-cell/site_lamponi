"use client";

/**
 * Оформление поставок (ТЗ, п. 6).
 *
 * Один склад = одна поставка. Кнопка активна, когда по заданию всё
 * отсканировано и проблемные разобраны — иначе поставку потом не закрыть.
 * Документы печатаются прямо из браузера и лежат на сервере.
 *
 * Задание открывается сканом листа подбора: выбрать его из списка нельзя,
 * чтобы поставка не ушла по чужой партии.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  Plus,
  Sparkles,
  X,
  CheckCircle2,
  Loader2,
  MapPin,
  Printer,
  RefreshCw,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
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

type DropoffPoint = {
  id: number;
  marketplaceId: string;
  name: string;
  address: string | null;
  city: string | null;
  officeType: string | null;
  lastUsedAt: string | null;
};

type SupplyDocument = { kind: string; label: string; storageKey: string; contentType: string };

type Supply = {
  id: number;
  marketplaceId: "ozon" | "wildberries" | "yandex";
  taskId: number | null;
  externalId: string | null;
  name: string | null;
  status: "open" | "created" | "closed" | "error";
  boxCount: number;
  postingCount: number;
  dropoffName: string | null;
  error: string | null;
  createdAt: string;
  closedAt: string | null;
  closedManually: number;
  closedBy: string | null;
  documents: SupplyDocument[];
};

type Blocker = { reason: string; details: string[] } | null;

type DropoffResolution = {
  city: string;
  officeName: string | null;
  officeAddress: string | null;
  found: number;
  recommendedPointId: number | null;
  confident: boolean;
  distance: number | null;
};

const OFFICE_TYPE: Record<string, string> = { sc: "сортировочный центр", sw: "склад WB", pp: "ПВЗ" };

function pointLabel(point: DropoffPoint) {
  // У пунктов WB название часто просто город («Кострома») — различает их адрес.
  const place = point.address && point.address !== point.name ? point.address : point.name;
  const type = point.officeType ? OFFICE_TYPE[point.officeType] : null;
  return type ? `${type === "ПВЗ" ? "ПВЗ" : type.charAt(0).toUpperCase() + type.slice(1)} · ${place}` : place;
}

function normalize(value: string | null | undefined) {
  return String(value ?? "").toLowerCase().replace(/ё/g, "е");
}

/** Город пункта из списка городов отгрузки: WB пишет «г Кострома», «Кострома». */
function cityOf(point: DropoffPoint, cities: string[]) {
  const pointCity = normalize(point.city);
  return cities.find((city) => pointCity.includes(normalize(city))) ?? "Другие";
}

export function WarehouseSuppliesWorkspace() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<number | null>(null);
  // Код с листа подбора: и выбор задания, и пропуск к оформлению поставки.
  const [sheetCode, setSheetCode] = useState<string | null>(null);
  const [sheetInput, setSheetInput] = useState("");
  const [points, setPoints] = useState<DropoffPoint[]>([]);
  const [pointId, setPointId] = useState<number | null>(null);
  const [boxCount, setBoxCount] = useState("1");
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [blocker, setBlocker] = useState<Blocker>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [cities, setCities] = useState<string[]>([]);
  const [newCity, setNewCity] = useState("");
  const [pointFilter, setPointFilter] = useState("");
  const [dropoffProblems, setDropoffProblems] = useState<string[]>([]);
  const [resolution, setResolution] = useState<DropoffResolution | null>(null);
  const printFrame = useRef<HTMLIFrameElement>(null);

  /**
   * Этикетки печатаются через скрытое окно: страница печати сама открывает
   * диалог, когда картинки догрузились, и со страницы «Поставки» уходить не надо.
   */
  function printLabels(supplyId: number, documentIndex?: number) {
    const frame = printFrame.current;
    const url = `/print/supply-labels?supply=${supplyId}${documentIndex === undefined ? "" : `&document=${documentIndex}`}`;
    if (!frame) {
      window.open(url, "_blank", "noopener");
      return;
    }
    // Тот же адрес повторно не перезагрузится — добавляем метку времени.
    frame.src = `${url}&t=${Date.now()}`;
  }

  const loadTasks = useCallback(async () => {
    const response = await fetch("/api/warehouse/tasks", { cache: "no-store" });
    const data = await response.json() as { tasks?: Task[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Задания не загрузились.");
    const ready = (data.tasks ?? []).filter((task) => task.status === "picked");
    setTasks(ready);
  }, []);

  const loadSupplies = useCallback(async (id: number | null) => {
    const response = await fetch(`/api/warehouse/supplies${id ? `?task=${id}` : ""}`, { cache: "no-store" });
    const data = await response.json() as {
      supplies?: Supply[]; blocker?: Blocker; dropoffPoints?: DropoffPoint[]; canManage?: boolean; error?: string;
      shippingCities?: string[]; dropoffProblems?: string[]; recommendedPointId?: number | null;
    };
    if (!response.ok) throw new Error(data.error ?? "Поставки не загрузились.");
    const list = data.dropoffPoints ?? [];
    setSupplies(data.supplies ?? []);
    setBlocker(data.blocker ?? null);
    setPoints(list);
    setCities(data.shippingCities ?? []);
    setDropoffProblems(data.dropoffProblems ?? []);
    setCanManage(Boolean(data.canManage));
    // Пункт наугад не подставляется: неверный пункт хуже пустого. Берём
    // проверенный для этого склада, иначе оставляем выбор, если он ещё в списке.
    const recommended = data.recommendedPointId && list.some((point) => point.id === data.recommendedPointId)
      ? data.recommendedPointId
      : null;
    setPointId((current) => recommended ?? (current && list.some((point) => point.id === current) ? current : null));
  }, []);

  useEffect(() => {
    void Promise.all([loadTasks(), loadSupplies(null)])
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не загрузилось."))
      .finally(() => setLoading(false));
  }, [loadTasks, loadSupplies]);

  useEffect(() => {
    if (loading) return;
    void loadSupplies(taskId).catch(() => undefined);
  }, [taskId, loading, loadSupplies]);

  /** Открыть задание по листу подбора: другого способа выбрать его нет. */
  async function openSheet(raw: string) {
    const code = raw.trim();
    if (!code) return;
    setBusy("sheet");
    try {
      const response = await fetch(`/api/warehouse/pick-sheet?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const data = await response.json() as { task?: { id: number; number: string; status: string }; error?: string };
      if (!response.ok || !data.task) throw new Error(data.error ?? "Лист подбора не найден.");
      if (data.task.status !== "picked" && data.task.status !== "shipped") {
        throw new Error(`Задание ${data.task.number} ещё не собрано — поставку по нему рано оформлять.`);
      }
      await loadTasks();
      setTaskId(data.task.id);
      setSheetCode(code);
      setResolution(null);
      setSheetInput("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Лист подбора не найден.");
    } finally {
      setBusy(null);
    }
  }

  async function dropoffRequest(body: Record<string, unknown>, busyKey: string) {
    setBusy(busyKey);
    try {
      const response = await fetch("/api/warehouse/dropoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as Partial<DropoffResolution> & {
        points?: DropoffPoint[]; cities?: string[]; error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обновить пункты отгрузки.");
      const list = data.points ?? [];
      setPoints(list);
      setCities(data.cities ?? []);
      setDropoffProblems([]);
      // Выбранный пункт сохраняется, если он остался в списке.
      setPointId((current) => (current && list.some((point) => point.id === current) ? current : null));
      return data;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить пункты отгрузки.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function addCity() {
    const city = newCity.trim();
    if (!city) return;
    const data = await dropoffRequest({ city, cargoType: 1 }, "city");
    if (data) {
      setNewCity("");
      toast.success(`${city}: пунктов отгрузки ${data.found ?? 0}`);
    }
  }

  async function reloadCity(city: string) {
    const data = await dropoffRequest({ city, cargoType: 1 }, `city:${city}`);
    if (data) toast.success(`${city}: список обновлён, пунктов ${data.found ?? 0}`);
  }

  async function removeCity(city: string) {
    await dropoffRequest({ action: "remove_city", city }, `city:${city}`);
  }

  async function suggestFromCabinet() {
    if (!taskId) return;
    const data = await dropoffRequest({ action: "suggest", taskId }, "suggest");
    if (!data) return;
    const resolved: DropoffResolution = {
      city: data.city ?? "",
      officeName: data.officeName ?? null,
      officeAddress: data.officeAddress ?? null,
      found: data.found ?? 0,
      recommendedPointId: data.recommendedPointId ?? null,
      confident: Boolean(data.confident),
      distance: data.distance ?? null,
    };
    setResolution(resolved);
    if (!resolved.confident) {
      toast.warning("Точного пункта для склада сдачи из кабинета WB нет — выберите пункт сами", {
        description: resolved.officeAddress ?? undefined,
      });
    }
  }

  async function createSupply() {
    if (!taskId) return;
    setBusy("create");
    try {
      const response = await fetch("/api/warehouse/supplies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", code: sheetCode, boxCount: Number(boxCount), dropoffPointId: pointId }),
      });
      const data = await response.json() as { supply?: Supply; error?: string; details?: string[] };
      if (!response.ok) {
        throw new Error([data.error, ...(data.details ?? []).slice(0, 5)].filter(Boolean).join(" · "));
      }
      if (data.supply?.status === "error") {
        toast.error("Площадка отклонила оформление", { description: data.supply.error ?? undefined });
      } else {
        toast.success("Поставка оформлена", { description: "Печатайте QR и акт из списка ниже." });
      }
      await Promise.all([loadTasks(), loadSupplies(taskId)]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось оформить поставку.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshDocuments(supply: Supply) {
    setBusy(`docs:${supply.id}`);
    try {
      const response = await fetch("/api/warehouse/supplies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh_documents", supplyId: supply.id }),
      });
      const data = await response.json() as { status?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обновить документы.");
      toast.success("Документы обновлены", { description: data.status ? `Статус акта: ${data.status}` : undefined });
      await loadSupplies(taskId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить документы.");
    } finally {
      setBusy(null);
    }
  }

  const selectedTask = tasks.find((item) => item.id === taskId) ?? null;

  // Список пунктов с фильтром по адресу. Выбранный пункт остаётся в списке,
  // даже если не подходит под фильтр, — иначе select молча сбросит выбор.
  const groupedPoints = useMemo<Array<[string, DropoffPoint[]]>>(() => {
    const query = normalize(pointFilter).trim();
    const visible = points.filter((point) => (
      (!selectedTask || point.marketplaceId === selectedTask.marketplaceId)
      && (!query || point.id === pointId || normalize(`${point.address} ${point.name}`).includes(query))
    ));
    const groups = new Map<string, DropoffPoint[]>();
    for (const point of visible) {
      const city = cityOf(point, cities);
      groups.set(city, [...(groups.get(city) ?? []), point]);
    }
    return [...groups.entries()];
  }, [points, pointFilter, pointId, cities, selectedTask]);

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем поставки…</div>;
  }

  const task = selectedTask;
  const selectedPoint = points.find((point) => point.id === pointId) ?? null;

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-7">
      <iframe
        ref={printFrame}
        title="Печать этикеток поставки"
        aria-hidden="true"
        style={{ position: "fixed", right: 0, bottom: 0, width: 1, height: 1, border: 0, opacity: 0, pointerEvents: "none" }}
      />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Truck className="size-4" /> Оформить поставку</CardTitle>
          <CardDescription>
            Задание попадает сюда, когда собрано. Wildberries: поставка, короба и QR. Ozon: акт приёма-передачи —
            он готовится не мгновенно, документы догружаются кнопкой.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5">
          <div className="flex flex-wrap items-end gap-3">
            {/* Задание открывает лист подбора: скан штрихкода или те же
                12 цифр руками, если сканер не дотянулся до стола. */}
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="supply-sheet">Лист подбора</Label>
              {task && sheetCode ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xl font-bold">{task.number}</span>
                  <Badge variant="secondary">
                    {marketplaceLabel(task.marketplaceId, true)}
                    {task.warehouseName ? ` · ${task.warehouseName}` : ""}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">лист {sheetCode}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setSheetCode(null);
                      setTaskId(null);
                      setResolution(null);
                    }}
                  >
                    Другой лист
                  </Button>
                </div>
              ) : (
                <Input
                  id="supply-sheet"
                  autoFocus
                  className="h-11 w-72 font-mono text-lg"
                  placeholder="Сканируйте лист подбора"
                  value={sheetInput}
                  disabled={busy !== null}
                  onChange={(event) => setSheetInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void openSheet(sheetInput);
                  }}
                />
              )}
            </div>
            {task?.marketplaceId === "wildberries" ? <div className="space-y-1">
              <Label className="text-xs">Пункт отгрузки — куда фактически повезёте коробки</Label>
              <NativeSelect
                className="w-[28rem] max-w-full"
                value={pointId ?? ""}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPointId(Number.isFinite(next) && next > 0 ? next : null);
                }}
              >
                <option value="">Выберите пункт…</option>
                {groupedPoints.map(([city, list]: [string, DropoffPoint[]]) => (
                  <optgroup key={city} label={`${city} · ${list.length}`}>
                    {list.map((point) => (
                      <option key={point.id} value={point.id}>
                        {point.id === resolution?.recommendedPointId && resolution.confident ? "★ " : ""}
                        {pointLabel(point)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </div> : null}
            {/* У Яндекса место считается по заказу: курьер забирает по посылке на каждый. */}
            {task?.marketplaceId === "yandex" ? null : <div className="space-y-1">
              <Label className="text-xs">Коробов</Label>
              <Input className="w-24" inputMode="numeric" value={boxCount} onChange={(event) => setBoxCount(event.target.value)} />
            </div>}
            <Button disabled={!taskId || !sheetCode || Boolean(blocker) || busy !== null || !canManage} onClick={() => void createSupply()}>
              {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />}
              {task?.marketplaceId === "yandex" ? "Вызвать курьера Яндекс Доставки" : "Оформить поставку"}
            </Button>
          </div>

          {task?.marketplaceId === "wildberries" ? (
            <div className="space-y-3 rounded-xl border bg-muted/30 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex items-center gap-1 text-muted-foreground"><MapPin className="size-4" /> Города отгрузки:</span>
                {cities.length === 0 ? <span className="text-muted-foreground">не заданы</span> : null}
                {cities.map((city) => (
                  <span key={city} className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pl-3 pr-1">
                    <button
                      type="button"
                      className="hover:underline"
                      title="Обновить пункты этого города из WB"
                      disabled={busy !== null}
                      onClick={() => void reloadCity(city)}
                    >
                      {busy === `city:${city}` ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null}{city}
                    </button>
                    <button
                      type="button"
                      className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Убрать город из списка"
                      disabled={busy !== null}
                      onClick={() => void removeCity(city)}
                    >
                      <X className="size-3.5" />
                    </button>
                  </span>
                ))}
                <form
                  className="flex items-center gap-1"
                  onSubmit={(event) => { event.preventDefault(); void addCity(); }}
                >
                  <Input className="h-8 w-44" placeholder="Добавить город" value={newCity} onChange={(event) => setNewCity(event.target.value)} />
                  <Button type="submit" size="sm" variant="outline" disabled={busy !== null || !newCity.trim()}>
                    {busy === "city" ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Добавить
                  </Button>
                </form>
                <Button size="sm" variant="ghost" disabled={busy !== null || !taskId} onClick={() => void suggestFromCabinet()}>
                  {busy === "suggest" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Подсказка из кабинета WB
                </Button>
              </div>

              {points.length > 12 ? (
                <Input
                  className="h-8 w-72"
                  placeholder="Найти пункт по адресу: улица, дом"
                  value={pointFilter}
                  onChange={(event) => setPointFilter(event.target.value)}
                />
              ) : null}

              {selectedPoint ? (
                <p className="text-xs text-muted-foreground">
                  {selectedPoint.officeType === "pp"
                    ? "ПВЗ: Wildberries требует короба — будут заведены короба по числу в поле «Коробов» и напечатаны их стикеры."
                    : "Сортировочный центр или склад WB: короба не заводятся, печатается QR поставки."}
                </p>
              ) : null}

              {resolution ? (
                <p className="text-xs text-muted-foreground">
                  В кабинете WB к складу задания привязан склад сдачи: {resolution.officeName ?? "—"}
                  {resolution.officeAddress ? ` — ${resolution.officeAddress}` : ""}.{" "}
                  {resolution.confident ? "Подходящий пункт отмечен ★ — выбирать его не обязательно." : "Точного пункта для него в справочнике нет."}
                </p>
              ) : null}

              {dropoffProblems.length > 0 ? (
                <p className="text-xs text-amber-800">Не загрузились пункты: {dropoffProblems.join("; ")}</p>
              ) : null}
            </div>
          ) : null}

          {blocker ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" /> {blocker.reason}</p>
              {blocker.details.length > 0 ? (
                <ul className="mt-1 list-inside list-disc font-mono text-xs">
                  {blocker.details.map((line) => <li key={line}>{line}</li>)}
                </ul>
              ) : null}
            </div>
          ) : taskId ? (
            <p className="flex items-center gap-2 text-sm text-emerald-800">
              <CheckCircle2 className="size-4" /> Задание готово к отгрузке: всё отсканировано, проблемных нет.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold"><Boxes className="size-4" /> Поставки</p>
        {supplies.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            Поставок пока нет.
          </p>
        ) : supplies.map((supply) => (
          <Card key={supply.id}>
            <CardContent className="space-y-3 px-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-lg font-bold">
                    {supply.externalId ?? `№${supply.id}`}
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {marketplaceLabel(supply.marketplaceId)}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    задание {supply.name ?? "—"} · {supply.postingCount}
                    {supply.marketplaceId === "yandex" ? " заявок в Яндекс Доставку" : ` отправлений · ${supply.boxCount} коробов`}
                    {supply.dropoffName ? ` · ${supply.dropoffName}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    оформлена {formatMoment(supply.createdAt)}
                    {supply.closedAt ? ` · закрыта ${formatMoment(supply.closedAt)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {supply.status === "open" ? <Badge className="bg-sky-100 text-sky-900 hover:bg-sky-100">открыта, идёт упаковка</Badge> : null}
                  {supply.status === "error" ? <Badge variant="destructive">ошибка</Badge> : null}
                  {supply.status === "closed" && !supply.closedManually ? <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100">закрыта</Badge> : null}
                  {supply.closedManually ? (
                    <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">
                      закрыто вручную{supply.closedBy ? ` · ${supply.closedBy}` : ""}
                    </Badge>
                  ) : null}
                  {supply.marketplaceId === "ozon" ? (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void refreshDocuments(supply)}>
                      {busy === `docs:${supply.id}` ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Обновить документы
                    </Button>
                  ) : null}
                </div>
              </div>

              {supply.error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-900">{supply.error}</p> : null}

              <div className="flex flex-wrap gap-2">
                {supply.documents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Документов пока нет.</p>
                ) : null}
                {supply.documents.filter((document) => document.storageKey && document.contentType.startsWith("image/")).length > 1 ? (
                  <Button size="sm" onClick={() => printLabels(supply.id)}>
                    <Printer className="size-4" /> Печать всех этикеток
                  </Button>
                ) : null}
                {supply.documents.map((document, index) => (
                  document.storageKey && document.contentType.startsWith("image/") ? (
                    <Button key={`${document.kind}-${index}`} size="sm" variant="outline" onClick={() => printLabels(supply.id, index)}>
                      <Printer className="size-4" /> {document.label}
                    </Button>
                  ) : document.storageKey ? (
                    <Button key={`${document.kind}-${index}`} asChild size="sm" variant="outline">
                      <a
                        href={`/api/warehouse/supplies/file?supply=${supply.id}&document=${index}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Printer className="size-4" /> {document.label}
                      </a>
                    </Button>
                  ) : (
                    <span key={`${document.kind}-${index}`} className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                      {document.label}
                    </span>
                  )
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
