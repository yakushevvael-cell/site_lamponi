/**
 * Подготовка отправления Ozon к сборке: что именно отправлять в
 * /v6/fbs/posting/product/exemplar/set и /v4/posting/fbs/ship.
 *
 * Цепочка та же, что годами работала в Google-таблице:
 *   exemplar/create-or-get → exemplar/set → exemplar/status → ship → label
 *
 * Здесь только сборка payload'ов — их легко проверить тестами, а ошибка в
 * них стоит дорого: Ozon отвечает невнятным INVALID_ARGUMENT.
 */

/** create-or-get отвечает то объектом, то обёрткой { result: ... }. */
export function unwrapExemplarData(created) {
  const source = created ?? {};
  if (!source.products && source.result) return source.result ?? {};
  return source;
}

/** Сколько экземпляров в отправлении. Больше одного этот путь не ведёт. */
export function countExemplars(created) {
  const products = unwrapExemplarData(created).products ?? [];
  return products.reduce((sum, product) => sum + Math.max(0, Number(product?.quantity ?? 0)), 0);
}

function copyField(source, target, field) {
  if (source[field] !== undefined && source[field] !== null && source[field] !== "") {
    target[field] = source[field];
  }
}

/**
 * Payload для передачи УИН.
 *
 * УИН ювелирного изделия уходит маркой с типом jw_uin. Уже присланные Ozon
 * марки других типов сохраняются как есть, иначе они потеряются.
 *
 * @param {string} postingNumber
 * @param {unknown} created ответ create-or-get
 * @param {string} uin
 * @returns {{ mustSet: boolean, payload: Record<string, unknown>, problems: string[] }}
 */
export function buildExemplarSetPayload(postingNumber, created, uin) {
  const source = unwrapExemplarData(created);
  const products = source.products ?? [];
  const payloadProducts = [];
  const problems = [];
  let mustSet = false;

  for (const product of products) {
    const item = product ?? {};
    const exemplars = item.exemplars ?? [];
    const quantity = Math.max(1, Number(item.quantity ?? 1));
    if (exemplars.length < quantity) {
      problems.push(
        `Ozon вернул меньше экземпляров, чем нужно: ожидается ${quantity}, получено ${exemplars.length}.`,
      );
    }

    const outExemplars = [];
    for (const raw of exemplars) {
      const exemplar = raw ?? {};
      const out = { exemplar_id: Number(exemplar.exemplar_id) };
      const marks = [];
      for (const mark of exemplar.marks ?? []) {
        if (String(mark?.mark_type ?? "") !== "jw_uin") {
          marks.push({ mark: String(mark?.mark ?? ""), mark_type: String(mark?.mark_type ?? "") });
        }
      }
      if (item.is_jw_uin_needed) {
        marks.push({ mark: String(uin ?? ""), mark_type: "jw_uin" });
        mustSet = true;
      }
      if (marks.length > 0) out.marks = marks;
      copyField(exemplar, out, "gtd");
      copyField(exemplar, out, "is_gtd_absent");
      copyField(exemplar, out, "rnpt");
      copyField(exemplar, out, "is_rnpt_absent");
      copyField(exemplar, out, "weight");

      // Ozon не примет отправление, если обязательные поля пустые. Сказать
      // об этом нужно здесь, а не ловить потом INVALID_ARGUMENT.
      if (item.is_gtd_needed && !out.gtd && out.is_gtd_absent !== true) {
        problems.push("Ozon требует ГТД для этого товара.");
      }
      if (item.is_rnpt_needed && !out.rnpt && out.is_rnpt_absent !== true) {
        problems.push("Ozon требует РНПТ для этого товара.");
      }
      if (item.is_weight_needed && !(Number(out.weight) > 0)) {
        problems.push("Ozon требует вес экземпляра.");
      }
      outExemplars.push(out);
    }

    payloadProducts.push({ product_id: Number(item.product_id), exemplars: outExemplars });
  }

  return {
    mustSet,
    problems,
    payload: {
      posting_number: postingNumber,
      multi_box_qty: Number(source.multi_box_qty ?? 0),
      products: payloadProducts,
    },
  };
}

/** Состав отправления для /v4/posting/fbs/ship. */
export function buildShipProducts(created, fallbackSku) {
  const products = unwrapExemplarData(created).products ?? [];
  const result = [];
  for (const product of products) {
    const productId = Number(product?.product_id) || 0;
    const quantity = Math.max(1, Number(product?.quantity) || 1);
    if (productId) result.push({ product_id: productId, quantity });
  }
  if (result.length === 0 && Number(fallbackSku)) {
    result.push({ product_id: Number(fallbackSku), quantity: 1 });
  }
  return result;
}

/**
 * Номера отправлений для запроса этикетки.
 * Ozon возвращает результат сборки то массивом строк, то массивом объектов —
 * если не разобрать, в запрос уедет «[object Object]» и этикетки не будет.
 */
export function normalizeLabelPostings(result, fallbackNumber) {
  let source = result;
  if (source && !Array.isArray(source) && Array.isArray(source.result)) source = source.result;
  if (!Array.isArray(source)) source = source ? [source] : [];
  const numbers = [];
  for (const entry of source) {
    const value = typeof entry === "string" || typeof entry === "number"
      ? String(entry)
      : String(entry?.posting_number ?? entry?.postingNumber ?? "");
    if (value && value !== "[object Object]") numbers.push(value);
  }
  if (numbers.length === 0 && fallbackNumber) numbers.push(String(fallbackNumber));
  return [...new Set(numbers)];
}

/** Статусы Ozon, при которых отправление уже собрано и этикетка доступна. */
export const OZON_SHIPPED_STATUSES = ["awaiting_deliver", "delivering", "awaiting_verification", "driver_pickup"];

/** Ошибки проверки УИН из ответа exemplar/status — человеческим языком. */
export function exemplarStatusErrors(data) {
  const products = (data ?? {}).products ?? [];
  const messages = [];
  for (const product of products) {
    for (const exemplar of product?.exemplars ?? []) {
      for (const mark of exemplar?.marks ?? []) {
        const codes = mark?.errors ?? mark?.error_codes ?? [];
        if (codes.length > 0) messages.push(`${mark?.mark_type ?? "марка"}: ${codes.join(", ")}`);
      }
      const gtd = exemplar?.gtd_error_codes ?? [];
      if (gtd.length > 0) messages.push(`ГТД: ${gtd.join(", ")}`);
      const rnpt = exemplar?.rnpt_error_codes ?? [];
      if (rnpt.length > 0) messages.push(`РНПТ: ${rnpt.join(", ")}`);
      const weight = exemplar?.weight_error_codes ?? [];
      if (weight.length > 0) messages.push(`Вес: ${weight.join(", ")}`);
    }
  }
  return messages.length > 0 ? messages.join("; ") : "Ozon не принял УИН, причину не назвал.";
}
