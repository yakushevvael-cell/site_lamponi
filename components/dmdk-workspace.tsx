"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AMOUNT_TYPES, PRICE_SOURCES, VAT_RATES } from "@/lib/dmdk-core.mjs";

type DictionaryItem = { externalId: string; name: string };
type Dictionaries = { contractor: DictionaryItem[]; deal: DictionaryItem[]; currency: DictionaryItem[] };

type General = { serviceUrl: string; ogrn: string; signerUrl: string; signingEnabled: boolean; testMode: boolean };

type MarketplaceSettings = {
  marketplaceId: "wildberries" | "ozon";
  name: string;
  shipperOgrn: string;
  shipperName: string;
  consigneeOgrn: string;
  consigneeName: string;
  dealId: string;
  dealNumber: string;
  carrierOgrn: string;
  carrierName: string;
  amountType: string;
  currency: string;
  vatRate: string;
  priceSource: string;
  enabled: boolean;
  missing: string[];
  updatedAt: string | null;
  updatedBy: string | null;
};

const EMPTY_DICTIONARIES: Dictionaries = { contractor: [], deal: [], currency: [] };

/**
 * Поле «значение из справочника ГИИС».
 *
 * Пока справочники не загружены — обычное поле ввода: учётный номер видно в
 * личном кабинете, и настроить площадку можно, не дожидаясь подписи. Как
 * только справочник появится, то же поле становится списком, и опечатка в
 * номере перестаёт быть возможной.
 */
function DictionaryField({
  label,
  hint,
  items,
  valueId,
  valueName,
  onChange,
  idPlaceholder = "Учётный номер в ГИИС",
}: {
  label: string;
  hint: string;
  items: DictionaryItem[];
  valueId: string;
  valueName: string;
  onChange: (id: string, name: string) => void;
  idPlaceholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {items.length ? (
        <NativeSelect
          className="w-full"
          value={valueId}
          onChange={(event) => {
            const id = event.target.value;
            onChange(id, items.find((item) => item.externalId === id)?.name ?? "");
          }}
        >
          <NativeSelectOption value="">Не выбрано</NativeSelectOption>
          {items.map((item) => (
            <NativeSelectOption key={item.externalId} value={item.externalId}>
              {item.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={valueId} placeholder={idPlaceholder} onChange={(event) => onChange(event.target.value, valueName)} />
          <Input value={valueName} placeholder="Название для экрана" onChange={(event) => onChange(valueId, event.target.value)} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function MarketplaceCard({
  settings,
  dictionaries,
  onSaved,
}: {
  settings: MarketplaceSettings;
  dictionaries: Dictionaries;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);

  const patch = (values: Partial<MarketplaceSettings>) => setDraft((current) => ({ ...current, ...values }));

  async function save() {
    setSaving(true);
    try {
      const response = await fetch("/api/dmdk/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplace: draft }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Настройки не сохранены.");
      toast.success(`Настройки ${draft.name} сохранены`);
      await onSaved();
    } catch (error) {
      toast.error("Настройки не сохранены", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <DictionaryField
          label="Грузоотправитель"
          hint="Ваша организация — она же отправитель по спецификации. Укажите её ОГРН."
          items={dictionaries.contractor}
          valueId={draft.shipperOgrn}
          valueName={draft.shipperName}
          onChange={(id, name) => patch({ shipperOgrn: id, shipperName: name })}
          idPlaceholder="ОГРН организации (13 цифр, 15 для ИП)"
        />
        <DictionaryField
          label="Грузополучатель"
          hint="ОГРН головного юрлица площадки (для WB — ООО «РВБ», для Ozon — юрлицо Ozon). В адрес обособленных подразделений спецификации по договору на доставку не принимаются, поэтому не СЦ."
          items={dictionaries.contractor}
          valueId={draft.consigneeOgrn}
          valueName={draft.consigneeName}
          onChange={(id, name) => patch({ consigneeOgrn: id, consigneeName: name })}
          idPlaceholder="ОГРН организации (13 цифр, 15 для ИП)"
        />
        <DictionaryField
          label="Номер контракта"
          hint="Договор на доставку с этой площадкой. Укажите его идентификатор (учётный номер) в ГИИС."
          items={dictionaries.deal}
          valueId={draft.dealId}
          valueName={draft.dealNumber}
          onChange={(id, name) => patch({ dealId: id, dealNumber: name })}
          idPlaceholder="Идентификатор контракта в ГИИС"
        />
        <DictionaryField
          label="Перевозчик"
          hint="Курьерская компания по договору на доставку (для WB — ООО «РВБ», для Ozon — юрлицо Ozon). Укажите её ОГРН."
          items={dictionaries.contractor}
          valueId={draft.carrierOgrn}
          valueName={draft.carrierName}
          onChange={(id, name) => patch({ carrierOgrn: id, carrierName: name })}
          idPlaceholder="ОГРН организации (13 цифр, 15 для ИП)"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-2">
          <Label>Тип стоимости</Label>
          <NativeSelect className="w-full" value={draft.amountType} onChange={(event) => patch({ amountType: event.target.value })}>
            {AMOUNT_TYPES.map((type) => (
              <NativeSelectOption key={type.code} value={type.code}>
                {type.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">Для отгрузки на площадку — «Стоимость реализации».</p>
        </div>

        <div className="space-y-2">
          <Label>Валюта</Label>
          <Input
            value={draft.currency}
            maxLength={3}
            onChange={(event) => patch({ currency: event.target.value.toUpperCase() })}
            placeholder="RUB"
          />
          <p className="text-xs text-muted-foreground">Буквенный код по ОКВ. Для рубля — RUB.</p>
        </div>

        <div className="space-y-2">
          <Label>Правило расчёта суммы</Label>
          <NativeSelect className="w-full" value={draft.priceSource} onChange={(event) => patch({ priceSource: event.target.value })}>
            {PRICE_SOURCES.map((source) => (
              <NativeSelectOption key={source.code} value={source.code}>
                {source.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            Цена для покупателя из сборочного задания — та же, что площадка пробьёт в чеке.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Ставка НДС</Label>
          <NativeSelect className="w-full" value={draft.vatRate} onChange={(event) => patch({ vatRate: event.target.value })}>
            {VAT_RATES.map((rate) => (
              <NativeSelectOption key={rate.code} value={rate.code}>
                {rate.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            Налог выделяется из цены: при 22% это сумма × 22 / 122. Отдельно к цене он не добавляется.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border p-4">
        <div className="flex items-center gap-3">
          <Switch id={`${draft.marketplaceId}-enabled`} checked={draft.enabled} onCheckedChange={(checked) => patch({ enabled: checked })} />
          <div>
            <Label htmlFor={`${draft.marketplaceId}-enabled`}>Передавать спецификации по этой площадке</Label>
            <p className="text-xs text-muted-foreground">
              Пока выключено, сайт ничего в ГИИС по этой площадке не создаёт.
            </p>
          </div>
        </div>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Сохранить
        </Button>
      </div>

      {settings.updatedAt ? (
        <p className="text-xs text-muted-foreground">
          Изменено {new Date(settings.updatedAt).toLocaleString("ru-RU")}
          {settings.updatedBy ? `, ${settings.updatedBy}` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function DmdkWorkspace() {
  const [general, setGeneral] = useState<General>({ serviceUrl: "", ogrn: "", signerUrl: "", signingEnabled: false, testMode: true });
  const [marketplaces, setMarketplaces] = useState<MarketplaceSettings[]>([]);
  const [dictionaries, setDictionaries] = useState<Dictionaries>(EMPTY_DICTIONARIES);
  const [loading, setLoading] = useState(true);
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/dmdk/settings", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { general: General; marketplaces: MarketplaceSettings[]; dictionaries: Dictionaries };
    setGeneral(data.general);
    setMarketplaces(data.marketplaces);
    setDictionaries(data.dictionaries ?? EMPTY_DICTIONARIES);
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  async function saveGeneral() {
    setSavingGeneral(true);
    try {
      const response = await fetch("/api/dmdk/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ general }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Настройки не сохранены.");
      toast.success("Общие настройки сохранены");
      await load();
    } catch (error) {
      toast.error("Настройки не сохранены", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSavingGeneral(false);
    }
  }

  async function refreshDictionaries() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/dmdk/dictionaries", { method: "POST" });
      const data = (await response.json()) as { error?: string; hint?: string };
      if (!response.ok) {
        toast.warning(data.error ?? "Справочники не обновлены", { description: data.hint });
        return;
      }
      toast.success("Справочники обновлены");
      await load();
    } catch {
      toast.error("Справочники не обновлены", { description: "Сервис интеграции не ответил." });
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) {
    return (
      <div className="grid min-h-56 place-items-center text-sm text-muted-foreground">
        <span>
          <Loader2 className="mr-2 inline size-4 animate-spin" />
          Загружаем настройки…
        </span>
      </div>
    );
  }

  const dictionariesLoaded = dictionaries.contractor.length > 0 || dictionaries.deal.length > 0;

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-7">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700" />
          <div>
            <p className="text-sm font-semibold text-amber-950">Подписание спецификаций остаётся в личном кабинете ГИИС</p>
            <p className="mt-1 text-xs leading-5 text-amber-900">
              Через сервис интеграции можно создать черновик, прикрепить УИН и посчитать суммы. Подписать и отправить
              спецификацию получателю можно только в личном кабинете — там это делается пакетом сразу по нескольким.
              Сайт следит за состоянием и, как только спецификация принята, сам вносит УИН в сборочные задания площадки.
            </p>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader className="px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardTitle className="text-base">Подключение</CardTitle>
            <Badge className={general.testMode ? "bg-amber-100 text-amber-800 hover:bg-amber-100" : "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"}>
              {general.testMode ? <CircleDashed /> : <CheckCircle2 />}
              {general.testMode ? "Тестовый контур" : "Боевой контур"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5 px-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="dmdk-service">Адрес сервиса интеграции</Label>
              <Input
                id="dmdk-service"
                value={general.serviceUrl}
                placeholder="https://dmdk.goznak.ru/..."
                onChange={(event) => setGeneral((current) => ({ ...current, serviceUrl: event.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Пока идёт отладка — тестовый контур dmdk.goznak.ru. Второй тестовый адрес закрыт.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dmdk-ogrn">ОГРН организации</Label>
              <Input
                id="dmdk-ogrn"
                value={general.ogrn}
                inputMode="numeric"
                placeholder="13 цифр для юрлица, 15 для ИП"
                onChange={(event) => setGeneral((current) => ({ ...current, ogrn: event.target.value.replace(/\D/g, "") }))}
              />
              <p className="text-xs text-muted-foreground">Уходит в каждом запросе к сервису интеграции.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dmdk-signer">Адрес подписного модуля</Label>
              <Input
                id="dmdk-signer"
                value={general.signerUrl}
                placeholder="http://127.0.0.1:8080/sign"
                onChange={(event) => setGeneral((current) => ({ ...current, signerUrl: event.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Отдельная служба с сертификатом организации. Сайт отдаёт ей XML и получает подпись.
              </p>
            </div>

            <div className="space-y-4 rounded-xl border p-4">
              <div className="flex items-center gap-3">
                <Switch
                  id="dmdk-signing"
                  checked={general.signingEnabled}
                  onCheckedChange={(checked) => setGeneral((current) => ({ ...current, signingEnabled: checked }))}
                />
                <div>
                  <Label htmlFor="dmdk-signing">Подписание включено</Label>
                  <p className="text-xs text-muted-foreground">
                    Выключатель на случай сбоя: работа склада не останавливается, спецификации копятся в очереди.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="dmdk-test"
                  checked={general.testMode}
                  onCheckedChange={(checked) => setGeneral((current) => ({ ...current, testMode: checked }))}
                />
                <div>
                  <Label htmlFor="dmdk-test">Тестовый контур</Label>
                  <p className="text-xs text-muted-foreground">
                    Запросы помечаются признаком тестовых. Снимать только после проверки на боевой поставке.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void saveGeneral()} disabled={savingGeneral}>
              {savingGeneral ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Сохранить подключение
            </Button>
            <Button variant="outline" onClick={() => void refreshDictionaries()} disabled={refreshing}>
              {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Обновить справочники
            </Button>
          </div>

          {!dictionariesLoaded ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Справочники ГИИС ещё не загружены — реквизиты пока вводятся вручную. Учётные номера организаций и
              контрактов видно в личном кабинете. Когда подпись заработает, поля станут списками, и значения
              подтянутся сами.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-5">
          <CardTitle className="text-base">Настройки площадок</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            У каждой площадки свой грузополучатель и свой контракт. Перепутанный получатель — непринятая спецификация
            и остановка отгрузки.
          </p>
        </CardHeader>
        <CardContent className="px-5">
          <Tabs defaultValue={marketplaces[0]?.marketplaceId ?? "wildberries"}>
            <TabsList>
              {marketplaces.map((item) => (
                <TabsTrigger key={item.marketplaceId} value={item.marketplaceId}>
                  {item.name}
                  {item.enabled ? <CheckCircle2 className="text-emerald-600" /> : null}
                </TabsTrigger>
              ))}
            </TabsList>
            {marketplaces.map((item) => (
              <TabsContent key={item.marketplaceId} value={item.marketplaceId} className="pt-5">
                {item.missing.length ? (
                  <p className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Не заполнено: {item.missing.join(", ")}.
                  </p>
                ) : null}
                <MarketplaceCard settings={item} dictionaries={dictionaries} onSaved={load} />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
