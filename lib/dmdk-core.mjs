/**
 * ГИИС ДМДК: справочники и счёт денег.
 *
 * Файл намеренно без серверных импортов и без обращений к базе — это чистая
 * логика, которую проверяют тесты. Всё, что касается запросов к сервису
 * интеграции и подписи, лежит отдельно.
 *
 * Деньги нигде не считаются в рублях с копейками после запятой: дробные числа
 * при сложении сотен позиций расходятся с кабинетом на копейки, а ГИИС
 * сравнивает суммы точно. Внутри всё в копейках целыми числами, наружу — в
 * формате ГИИС: рубли, умноженные на 10 000.
 */

/** Ставки НДС из перечисления «Ставки НДС» сервиса интеграции. */
export const VAT_RATES = [
  { code: "NDS_NULL", label: "Без НДС", percent: 0 },
  { code: "NDS_0", label: "0%", percent: 0 },
  { code: "NDS_5", label: "5%", percent: 5 },
  { code: "NDS_7", label: "7%", percent: 7 },
  { code: "NDS_20", label: "20%", percent: 20 },
  { code: "NDS_22", label: "22%", percent: 22 },
];

/** Типы стоимости. Для отгрузки на площадку нужна «Стоимость реализации». */
export const AMOUNT_TYPES = [
  { code: "P_SALE", label: "Стоимость реализации" },
  { code: "P_CONTRACT", label: "Контрактная" },
  { code: "P_PRICELIST", label: "Прейскурантная" },
  { code: "P_REPORTEDVALUE", label: "Учётная" },
  { code: "P_SALE_PER_UOM", label: "Цена реализации" },
];

/** Типы контрактов. Передача на маркетплейс идёт по «Договору на доставку». */
export const DEAL_TYPES = [
  { code: "DL_DELIVERY", label: "Договор на доставку" },
  { code: "DL_REALIZATION", label: "Договор на реализацию/комиссию" },
  { code: "DL_SALE", label: "Договор купли-продажи" },
  { code: "DL_MAIL_ERRAND", label: "Письмо-поручение" },
];

/** Состояния спецификации, которые мы отслеживаем и показываем кладовщику. */
export const SPEC_STATES = {
  DS_SP_COMPLETE_SET: "Черновик",
  DS_SP_SENT: "Отправлена получателю",
  DS_SP_ACCEPTED: "Принята получателем",
  DS_SP_RETURNED: "Возвращена отправителю",
  DS_SP_ACCEPTED_BY_SENDER: "Принята отправителем",
  DS_SP_CORRECTION: "Корректировка",
  DS_SP_ACT_CREATED: "Акт расхождения сформирован",
  DS_SP_ACT_CONFIRMED: "Акт расхождения согласован",
  DS_SP_ACT_REJECTED: "Акт расхождения отклонён",
  DS_SP_ACCEPTED_PRICE_CORRECTION: "Принята, уточнение стоимости",
};

/**
 * Откуда брать цену изделия.
 *
 * Для спецификации в адрес площадки берётся цена для покупателя из сборочного
 * задания: именно её площадка пробьёт в чеке, и по ней спецификация сойдётся
 * с выводом из оборота.
 */
export const PRICE_SOURCES = [
  { code: "order", label: "Цена для покупателя из сборочного задания" },
  { code: "osv", label: "Учётная цена из 1С" },
];

/** ГИИС принимает не больше 100 партий в одном запросе. */
export const BATCH_CHUNK = 100;

const VAT_BY_CODE = new Map(VAT_RATES.map((rate) => [rate.code, rate]));

export function vatPercent(code) {
  return VAT_BY_CODE.get(code)?.percent ?? 0;
}

export function vatLabel(code) {
  return VAT_BY_CODE.get(code)?.label ?? code ?? "не указана";
}

/**
 * Рубли (как их отдаёт площадка) в копейки.
 *
 * Площадки присылают цену числом с плавающей точкой, и 1234.565 в двоичном
 * виде чуть меньше, чем кажется. Без поправки Math.round округлил бы вниз.
 */
export function toKopecks(value) {
  const number = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100 + (number >= 0 ? 1e-6 : -1e-6));
}

/** Копейки в формат ГИИС: рубли, умноженные на 10 000. */
export function toGiisAmount(kopecks) {
  return Math.round(kopecks) * 100;
}

/** Копейки обратно в рубли — только для показа человеку. */
export function formatRubles(kopecks) {
  return (Math.round(kopecks) / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * НДС внутри цены.
 *
 * Цена для покупателя на площадке — это цена с НДС, отдельной строки налога в
 * ней нет. Поэтому налог выделяется из суммы: при ставке 22% это сумма × 22 / 122.
 */
export function vatFromGross(kopecks, rateCode) {
  const percent = vatPercent(rateCode);
  if (!percent) return 0;
  return Math.round((Math.round(kopecks) * percent) / (100 + percent));
}

/**
 * Итоги спецификации.
 *
 * Считаем построчно и только потом складываем: если сначала сложить, а потом
 * выделить налог один раз, сумма разойдётся с чеками площадки на копейки.
 *
 * @param {Array<{ priceKopecks?: number, price?: number }>} items
 * @param {string} rateCode
 */
export function specificationTotals(items, rateCode) {
  let amount = 0;
  let vat = 0;
  for (const item of items ?? []) {
    const kopecks = Number.isFinite(item?.priceKopecks) ? Math.round(item.priceKopecks) : toKopecks(item?.price);
    amount += kopecks;
    vat += vatFromGross(kopecks, rateCode);
  }
  return {
    itemCount: (items ?? []).length,
    amountKopecks: amount,
    vatKopecks: vat,
    amountExVatKopecks: amount - vat,
    amount: toGiisAmount(amount),
    amountVAT: toGiisAmount(vat),
  };
}

/** Разбивка списка УИН на запросы по 100 партий. */
export function chunkBatches(uins, size = BATCH_CHUNK) {
  const list = (uins ?? []).filter(Boolean);
  const chunks = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
  return chunks;
}

/** Поля настройки площадки в том порядке, в каком они показаны на странице. */
export const SETTINGS_FIELDS = [
  { key: "shipperOgrn", label: "Грузоотправитель", hint: "Ваша организация — она же отправитель по спецификации." },
  { key: "consigneeOgrn", label: "Грузополучатель", hint: "Головное юрлицо площадки. В адрес обособленных подразделений спецификации по договору на доставку не принимаются." },
  { key: "dealId", label: "Номер контракта", hint: "Договор на доставку с этой площадкой, учётный номер в ГИИС." },
  { key: "carrierOgrn", label: "Перевозчик", hint: "Кто везёт. Обычно ваша же организация." },
  { key: "amountType", label: "Тип стоимости", hint: "Для отгрузки на площадку — «Стоимость реализации»." },
  { key: "currency", label: "Валюта", hint: "Буквенный код по ОКВ. Для рубля — RUB." },
  { key: "priceSource", label: "Правило расчёта суммы", hint: "Откуда брать цену каждого изделия." },
  { key: "vatRate", label: "Ставка НДС", hint: "Налог выделяется из цены: он в неё уже включён." },
];

/**
 * Чего не хватает, чтобы отправлять спецификации по этой площадке.
 * Возвращает подписи полей — их же видно на странице настроек.
 */
export function missingSettings(settings) {
  const missing = [];
  for (const field of SETTINGS_FIELDS) {
    const value = settings?.[field.key];
    if (typeof value !== "string" || !value.trim()) missing.push(field.label);
  }
  return missing;
}

export function isSettingsReady(settings) {
  return missingSettings(settings).length === 0;
}
