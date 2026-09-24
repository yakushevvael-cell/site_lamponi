"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, KeyRound, Loader2, LockKeyhole, RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { credentialLabels } from "@/lib/marketplaces";

type Integration = { id: "wildberries" | "ozon" | "yandex"; name: string; shortName: string; configured: boolean; connected: boolean; credentialsMessage: string | null; lastCheckedAt: string | null; warehouseCount: number; publishingWarehouseCount?: number; warehouses: Array<{ id: string; name: string }>; credentials: string[]; required?: string[] };
type Canary = { mode: string; items: Array<{ sourceSku: string; article: string; size: string | null; availableQuantity: number; offerId?: string }>; lastResult: null | { ok: boolean; testedAt: string; skuCount: number; verifiedWarehouseCount?: number; warehouseCount?: number; verifiedSkuCount?: number; pairCount?: number; verifiedPairCount?: number } };
const colors: Record<string, string> = { wildberries: "bg-violet-600", ozon: "bg-blue-600", yandex: "bg-amber-500" };
/** Что прячем звёздочками. Номера магазина, кабинета и станции — не секрет, и
 * вводить их вслепую значит ошибиться цифрой и потом искать причину. */
const SECRET_CREDENTIALS = new Set(["WB_API_TOKEN", "OZON_API_KEY", "YANDEX_API_KEY", "YANDEX_DELIVERY_TOKEN"]);

function CredentialDialog({ integration, onSaved }: { integration: Integration; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  // Код службы доставки руками не набирают: его подставляет справочник Маркета.
  const [services, setServices] = useState<Array<{ id: number; name: string }>>([]);
  useEffect(() => {
    if (!open || integration.id !== "yandex" || !integration.configured) return;
    void fetch("/api/integrations/yandex/delivery-services", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { suggested?: Array<{ id: number; name: string }> } : null)
      .then((data) => setServices(data?.suggested ?? []))
      .catch(() => setServices([]));
  }, [open, integration.id, integration.configured]);
  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/integrations/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marketplaceId: integration.id, credentials: values }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Ключи не сохранены.");
      toast.success(`Ключи ${integration.name} сохранены`, { description: "Теперь можно проверить соединение." });
      setValues({}); setOpen(false); await onSaved();
    } catch (error) { toast.error("Ключи не сохранены", { description: error instanceof Error ? error.message : "Повторите попытку." }); }
    finally { setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" className="w-full"><KeyRound />{integration.configured ? "Заменить API-ключи" : "Добавить API-ключи"}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{integration.name}: API-доступ</DialogTitle><DialogDescription>Значения шифруются на сервере и после сохранения не показываются в интерфейсе.{integration.configured ? " Сохранение заменяет весь набор: заполните все поля заново, включая те, что уже добавляли." : ""}</DialogDescription></DialogHeader><div className="space-y-4 py-2">{integration.credentials.map((credential) => { const optional = Boolean(integration.required) && !integration.required?.includes(credential); return <div key={credential} className="space-y-2"><Label htmlFor={`${integration.id}-${credential}`}>{credentialLabels[credential] ?? credential}{optional && <span className="ml-2 text-[11px] font-normal text-muted-foreground">необязательно</span>}</Label><Input id={`${integration.id}-${credential}`} type={SECRET_CREDENTIALS.has(credential) ? "password" : "text"} autoComplete="off" value={values[credential] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [credential]: event.target.value }))} placeholder={credential} />{credential === "YANDEX_DELIVERY_SERVICE_ID" && services.length > 0 ? <div className="flex flex-wrap gap-2 pt-1">{services.map((service) => <button key={service.id} type="button" className="rounded-full border px-3 py-1 text-[11px] hover:bg-muted" onClick={() => setValues((current) => ({ ...current, YANDEX_DELIVERY_SERVICE_ID: String(service.id) }))}>{service.name} · {service.id}</button>)}</div> : null}</div>; })}</div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Отмена</Button><Button onClick={() => void save()} disabled={saving || (integration.required ?? integration.credentials).some((key) => !values[key]?.trim())}>{saving ? <Loader2 className="animate-spin" /> : <LockKeyhole />}Сохранить защищённо</Button></DialogFooter></DialogContent></Dialog>;
}

export function IntegrationsWorkspace() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [wbCanary, setWbCanary] = useState<Canary | null>(null);
  const [ozonCanary, setOzonCanary] = useState<Canary | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/integrations/status", { cache: "no-store" });
    const data = await response.json() as { integrations?: Integration[] };
    setIntegrations(data.integrations ?? []);
  }, []);
  const loadCanaries = useCallback(async () => {
    const [wb, ozon] = await Promise.all([fetch("/api/integrations/wildberries/canary", { cache: "no-store" }), fetch("/api/integrations/ozon/canary", { cache: "no-store" })]);
    if (wb.ok) setWbCanary(await wb.json() as Canary);
    if (ozon.ok) setOzonCanary(await ozon.json() as Canary);
  }, []);
  useEffect(() => { void Promise.resolve().then(() => Promise.all([load(), loadCanaries()])).finally(() => setLoading(false)); }, [load, loadCanaries]);

  async function removeKey(id: Integration["id"]) {
    setRemoving(id);
    try {
      const response = await fetch(`/api/integrations/credentials?marketplaceId=${id}`, { method: "DELETE" });
      const data = await response.json() as { error?: string; note?: string };
      if (!response.ok) throw new Error(data.error ?? "Ключ не удалён.");
      await load();
      toast.success("API-ключ удалён", { description: data.note ?? "Новые остатки не отправляются." });
    } catch (error) {
      toast.error("Ключ не удалён", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setRemoving(null);
    }
  }

  async function check(id: Integration["id"]) {
    setChecking(id);
    try {
      const response = await fetch(`/api/integrations/${id}/check`, { method: "POST" });
      const data = await response.json() as { error?: string; warehouseCount?: number; deliveryConfigured?: boolean };
      if (!response.ok) throw new Error(data.error ?? "Соединение не подтверждено.");
      // У Яндекса склад один — магазин; важнее сказать, готова ли Доставка.
      const description = id === "yandex"
        ? data.deliveryConfigured ? "Магазин подтверждён, Яндекс Доставка настроена." : "Магазин подтверждён. Реквизиты Яндекс Доставки не заполнены — курьера вызвать нельзя."
        : `Найдено складов: ${data.warehouseCount ?? 0}.`;
      toast.success("Соединение работает", { description }); await load();
    } catch (error) { toast.error("Проверка не пройдена", { description: error instanceof Error ? error.message : "Повторите попытку." }); }
    finally { setChecking(null); }
  }

  async function runCanary(id: "wildberries" | "ozon") {
    setTesting(id);
    try {
      const response = await fetch(`/api/integrations/${id}/canary`, { method: "POST" });
      const data = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok && response.status !== 207) throw new Error(data.error ?? "Тест не выполнен.");
      if (data.ok) toast.success(`Три SKU ${id === "wildberries" ? "WB" : "Ozon"} подтверждены`); else toast.warning("Тест выполнен частично");
      await loadCanaries();
    } catch (error) { toast.error("Тест не выполнен", { description: error instanceof Error ? error.message : "Повторите попытку." }); }
    finally { setTesting(null); }
  }

  return <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-7">
    <div className="rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4"><div className="flex gap-3"><LockKeyhole className="mt-0.5 size-5 shrink-0 text-blue-700" /><div><p className="text-sm font-semibold text-blue-950">API-ключи теперь можно добавлять самостоятельно</p><p className="mt-1 text-xs leading-5 text-blue-800">Ключи шифруются в базе отдельным серверным ключом и не возвращаются в браузер. Для каждого маркетплейса есть отдельная кнопка.</p></div></div></div>
    {loading ? <div className="grid min-h-56 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Проверяем подключения…</div> : <section className="grid gap-4 lg:grid-cols-3">{integrations.map((integration) => <Card key={integration.id}><CardHeader className="px-5"><div className="flex items-start justify-between"><span className={`grid size-11 place-items-center rounded-xl text-xs font-bold text-white ${colors[integration.id]}`}>{integration.shortName}</span><Badge className={integration.connected ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : integration.configured ? "bg-amber-100 text-amber-800 hover:bg-amber-100" : "bg-muted text-muted-foreground hover:bg-muted"}>{integration.connected ? <CheckCircle2 /> : <CircleDashed />}{integration.connected ? "Работает" : integration.configured ? "Ключ добавлен" : "Нет ключа"}</Badge></div><CardTitle className="mt-3 text-base">{integration.name}</CardTitle></CardHeader><CardContent className="space-y-3 px-5"><div className="rounded-xl bg-muted p-3 text-xs"><p>FBS-складов: <b>{integration.warehouseCount}</b></p><p className="mt-1 text-muted-foreground">Последняя проверка: {integration.lastCheckedAt ? new Date(integration.lastCheckedAt).toLocaleString("ru-RU") : "не было"}</p></div><CredentialDialog integration={integration} onSaved={load} />{integration.configured ? <Button variant="outline" className="w-full text-destructive" disabled={removing === integration.id} onClick={() => void removeKey(integration.id)}>{removing === integration.id ? <Loader2 className="animate-spin" /> : <KeyRound />}Удалить API-ключ</Button> : <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center text-[11px] text-amber-900">API-ключ не добавлен. Список складов и настройки выгрузки сохранены.</p>}<Button className="w-full" disabled={!integration.configured || checking === integration.id} onClick={() => void check(integration.id)}>{checking === integration.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}Проверить соединение</Button>{integration.id === "yandex" && <p className="text-center text-[11px] text-muted-foreground">Модель DBS: доставку заказов выполняет Яндекс Доставка по заявке с сайта.</p>}</CardContent></Card>)}</section>}

    <section className="grid gap-4 lg:grid-cols-2">{[
      { id: "wildberries" as const, name: "Wildberries", data: wbCanary, color: "border-violet-200 bg-violet-50/60" },
      { id: "ozon" as const, name: "Ozon", data: ozonCanary, color: "border-blue-200 bg-blue-50/60" },
    ].map((entry) => <Card key={entry.id} className={entry.color}><CardHeader className="px-5"><div className="flex items-start justify-between"><div><CardTitle className="text-base">Тестовый контур {entry.name}</CardTitle><p className="mt-1 text-xs text-muted-foreground">Ровно 3 SKU для контрольной проверки подключения.</p></div><Badge variant="outline">3 SKU</Badge></div></CardHeader><CardContent className="space-y-4 px-5">{entry.data?.items.length ? <div className="grid gap-2 sm:grid-cols-3">{entry.data.items.map((item) => <div key={item.sourceSku} className="rounded-lg bg-white p-3 text-xs"><p className="font-mono font-semibold">{item.article}</p><p className="mt-1 text-muted-foreground">{item.size ? `Размер ${item.size}` : "Без размера"}</p><p className="mt-2 text-lg font-semibold">{item.availableQuantity}</p></div>)}</div> : <p className="text-sm text-muted-foreground">Тестовые позиции ещё не загружены.</p>}{entry.data?.lastResult && <div className="rounded-lg border bg-white p-3 text-xs"><p className="font-semibold">{entry.data.lastResult.ok ? "Контрольное чтение совпало" : "Есть расхождения"}</p><p className="mt-1 text-muted-foreground">Проверено: {new Date(entry.data.lastResult.testedAt).toLocaleString("ru-RU")}</p></div>}<Button className="w-full" disabled={testing === entry.id || !integrations.find((item) => item.id === entry.id)?.connected} onClick={() => void runCanary(entry.id)}>{testing === entry.id ? <Loader2 className="animate-spin" /> : <Zap />}Повторить тест 3 SKU</Button></CardContent></Card>)}</section>
    <Card><CardContent className="grid gap-4 px-5 md:grid-cols-3">{[
      ["Заказы", "чтение и ручное обновление из API"], ["Остатки", "три тестовых SKU + ручное обнуление"], ["Полный ассортимент", "ручной запуск во вкладке «Остатки»"],
    ].map(([title, value]) => <div key={title} className="rounded-xl border p-4"><p className="text-sm font-semibold">{title}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{value}</p></div>)}</CardContent></Card>
  </div>;
}
