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
import { normalizeArticle, splitArticleSize } from "./upd-parse-core.mjs";

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
 * Сколько УИН нужно отправлению.
 *
 * В отправлении может быть несколько товаров, и у каждого — своё количество.
 * Знать это число надо до обращений к API: если УИН меньше, чем изделий,
 * передавать нечего и отправление собирать нельзя.
 *
 * @param {unknown} created ответ create-or-get
 * @returns {number}
 */
export function neededUinCount(created) {
  const products = unwrapExemplarData(created).products ?? [];
  let total = 0;
  for (const product of products) {
    if (!product?.is_jw_uin_needed) continue;
    total += Math.max(1, Number(product?.quantity ?? 1));
  }
  return total;
}

/**
 * Выдача УИН по товарам отправления.
 *
 * Сначала берётся УИН, отсканированный именно под этот товар (product_id), и
 * только если такого нет — из общего запаса отправления. Так изделие не
 * уедет под чужим product_id, когда в отправлении два разных товара.
 *
 * Отдельно стоит `preferred` — УИН, который уже лежит на экземпляре в Ozon.
 * Он всегда важнее запаса из УПД: см. комментарий в buildExemplarSetPayload.
 *
 * @param {string | { byProduct?: Record<string, string[]>, pool?: string[] }} uins
 */
function uinTaker(uins) {
  const byProduct = new Map();
  const pool = [];
  if (typeof uins === "string") {
    if (uins) pool.push(uins);
  } else if (uins && typeof uins === "object") {
    for (const [key, list] of Object.entries(uins.byProduct ?? {})) {
      byProduct.set(String(key), [...(list ?? [])].filter(Boolean).map(String));
    }
    for (const value of uins.pool ?? []) if (value) pool.push(String(value));
  }
  const used = new Set();
  /** Убирает УИН из запаса, чтобы он не достался второму экземпляру. */
  const drop = (value) => {
    for (const list of [...byProduct.values(), pool]) {
      const at = list.indexOf(value);
      if (at >= 0) list.splice(at, 1);
    }
  };
  return (productId, offerId, preferred = "") => {
    const keep = String(preferred ?? "").trim();
    if (keep && !used.has(keep)) {
      used.add(keep);
      drop(keep);
      return keep;
    }
    const lists = [byProduct.get(String(productId)) ?? []];
    if (offerId !== undefined && offerId !== null && String(offerId) !== "") {
      lists.push(byProduct.get(String(offerId)) ?? []);
    }
    for (const list of [...lists, pool]) {
      while (list.length > 0) {
        const value = list.shift();
        if (value && !used.has(value)) {
          used.add(value);
          return value;
        }
      }
    }
    return null;
  };
}

/**
 * Payload для передачи УИН.
 *
 * УИН ювелирного изделия уходит маркой с типом jw_uin. Уже присланные Ozon
 * марки других типов сохраняются как есть, иначе они потеряются.
 *
 * Третий аргумент — либо один УИН (отправление из одного изделия), либо
 * раскладка «product_id → УИН» и общий запас: в отправлении с несколькими
 * товарами каждому изделию нужна своя марка.
 *
 * `mustSet` — признак того, что состав марок изменился и его надо передать.
 * Если нужный УИН уже стоит на экземпляре, `set` не нужен: проверка марки в
 * Ozon асинхронная и занимает минуты, а каждая пересылка начинает её заново.
 * Именно из-за безусловной пересылки отправления могли висеть «на проверке»
 * бесконечно — сколько раз кладовщик нажмёт «Подготовить», столько раз
 * счётчик проверки и обнулится.
 *
 * @param {string} postingNumber
 * @param {unknown} created ответ create-or-get
 * @param {string | { byProduct?: Record<string, string[]>, pool?: string[] }} uins
 * @returns {{ mustSet: boolean, payload: Record<string, unknown>, problems: string[], marks: number,
 *            assigned: Array<{ productId: number, offerId: string, uin: string, reused: boolean }> }}
 */
export function buildExemplarSetPayload(postingNumber, created, uins) {
  const source = unwrapExemplarData(created);
  const products = source.products ?? [];
  const payloadProducts = [];
  const problems = [];
  const assigned = [];
  const take = uinTaker(uins);
  let mustSet = false;
  let marksCount = 0;

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
      let currentUin = "";
      for (const mark of exemplar.marks ?? []) {
        if (String(mark?.mark_type ?? "") === "jw_uin") {
          currentUin = String(mark?.mark ?? "").trim();
        } else {
          marks.push({ mark: String(mark?.mark ?? ""), mark_type: String(mark?.mark_type ?? "") });
        }
      }
      if (item.is_jw_uin_needed) {
        const uin = take(item.product_id, item.offer_id, currentUin);
        if (!uin) {
          problems.push(
            `Не хватает УИН для товара ${item.offer_id ?? item.product_id ?? "без артикула"} в отправлении ${postingNumber}.`,
          );
        } else {
          marks.push({ mark: uin, mark_type: "jw_uin" });
          marksCount += 1;
          if (uin !== currentUin) mustSet = true;
          assigned.push({
            productId: Number(item.product_id) || 0,
            offerId: String(item.offer_id ?? ""),
            uin,
            reused: uin === currentUin,
          });
        }
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

  // Количество коробок передаётся, только если Ozon его назвал. Раньше сюда
  // уходил ноль — значение, которого у отправления быть не может.
  const boxes = Number(source.multi_box_qty ?? 0);
  const payload = Number.isFinite(boxes) && boxes > 0
    ? { posting_number: postingNumber, multi_box_qty: boxes, products: payloadProducts }
    : { posting_number: postingNumber, products: payloadProducts };

  return { mustSet, problems: [...new Set(problems)], marks: marksCount, assigned, payload };
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


/**
 * Упаковки для /v4/posting/fbs/ship.
 *
 * Отдельного метода «разделить отправление» у Ozon нет: деление делается
 * упаковками при сборке. Сколько упаковок передали — столько отправлений
 * станет (номера с суффиксами -1, -2), и у каждого своя этикетка. Отменить
 * деление нельзя, поэтому упаковки собираются только из уже проверенного
 * состава отправления.
 *
 * @param {unknown} created ответ exemplar/create-or-get
 * @param {number} fallbackSku товар, если состав не разобрался
 * @param {boolean} split каждое изделие — отдельным отправлением
 * @returns {Array<{ products: Array<{ product_id: number, quantity: number }> }>}
 */
export function buildShipPackages(created, fallbackSku, split = false) {
  const products = buildShipProducts(created, fallbackSku);
  if (!split) return [{ products }];
  const packages = [];
  for (const product of products) {
    for (let index = 0; index < product.quantity; index += 1) {
      packages.push({ products: [{ product_id: product.product_id, quantity: 1 }] });
    }
  }
  return packages.length > 1 ? packages : [{ products }];
}

/**
 * Строки «артикул / размер» под страницы этикетки — в том же порядке и с тем же
 * числом элементов, как buildShipPackages режет отправление на упаковки. Значит
 * строка[i] встаёт на страницу[i] итогового PDF.
 *
 * @param {unknown} created ответ exemplar/create-or-get
 * @param {Array<{externalSku?: string|number, article?: string, size?: string|null}>} products отсканированные изделия
 * @param {boolean} split делится ли отправление поштучно
 * @returns {Array<{article: string, size: string|null}>}
 */
export function buildLabelLines(created, products, split = false) {
  const list = Array.isArray(products) ? products : [];

  // product_id → offer_id (артикул), как Ozon отдаёт состав отправления.
  const offerByProduct = new Map();
  for (const item of unwrapExemplarData(created).products ?? []) {
    const productId = Number(item?.product_id) || 0;
    const offerId = String(item?.offer_id ?? "").trim();
    if (productId && offerId) offerByProduct.set(productId, offerId);
  }

  // Размера в Ozon нет — берём его из задания по артикулу, запасной ключ — sku.
  const sizeByArticle = new Map();
  const infoBySku = new Map();
  for (const product of list) {
    const article = String(product?.article ?? "").trim();
    const size = product?.size == null ? null : String(product.size).trim() || null;
    if (article && !sizeByArticle.has(article)) sizeByArticle.set(article, size);
    const sku = String(product?.externalSku ?? "").trim();
    if (sku && !infoBySku.has(sku)) infoBySku.set(sku, { article, size });
  }

  const lineForProduct = (productId) => {
    const offer = offerByProduct.get(Number(productId)) || "";
    const bySku = infoBySku.get(String(productId));
    const article = offer || bySku?.article || "";
    const size = sizeByArticle.get(article) ?? bySku?.size ?? null;
    // Размер уже вписан в артикул («К-1298з (16-21)») — второй раз не пишем.
    const split = splitArticleSize(article, size);
    if (split.article !== normalizeArticle(article)) return { article, size: null };
    return { article, size };
  };

  // Порядок и число упаковок — ровно как в buildShipPackages.
  const shipProducts = buildShipProducts(created, list[0]?.externalSku);
  const flat = [];
  for (const product of shipProducts) {
    for (let unit = 0; unit < product.quantity; unit += 1) flat.push(product.product_id);
  }

  // Одна страница на всё отправление: не делим либо изделие единственное.
  if (!split || flat.length <= 1) {
    if (list.length === 1) {
      const only = list[0];
      return [{
        article: String(only?.article ?? "").trim(),
        size: only?.size == null ? null : String(only.size).trim() || null,
      }];
    }
    const article = [...new Set(list.map((p) => String(p?.article ?? "").trim()).filter(Boolean))].join(", ");
    return [{ article, size: null }];
  }

  return flat.map(lineForProduct);
}

/** Статусы Ozon, при которых отправление уже собрано и этикетка доступна. */
export const OZON_SHIPPED_STATUSES = ["awaiting_deliver", "delivering", "awaiting_verification", "driver_pickup"];

/** Статусы отправления Ozon FBS так, как их видит склад. */
const OZON_STATUS_TEXT = {
  awaiting_registration: "ожидает регистрации",
  acceptance_in_progress: "идёт приёмка",
  awaiting_approve: "ожидает подтверждения",
  awaiting_packaging: "ожидает сборки",
  awaiting_deliver: "ожидает отгрузки",
  awaiting_verification: "на проверке",
  arbitration: "арбитраж",
  client_arbitration: "клиентский арбитраж",
  delivering: "доставляется",
  driver_pickup: "у водителя",
  delivered: "доставлено",
  sent_by_seller: "отправлено продавцом",
  not_accepted: "не принято на сортировке",
  cancelled: "отменено",
};

/**
 * Что делать складу, когда Ozon отказал в сборке («INVALID_POSTING_STATE» и
 * подобное): по статусу отправления из /v3/posting/fbs/get.
 *
 * - `cancelled` — собирать нечего, изделия возвращаются на полку;
 * - `shipped` — отправление уже собрано (например, вручную в кабинете), и
 *   остаётся только забрать этикетку;
 * - `other` — собрать сейчас нельзя, статус называется по-русски.
 *
 * @returns {{ kind: "cancelled" | "shipped" | "other" | "unknown", message: string }}
 */
export function describeOzonPostingState(status) {
  const code = String(status ?? "").trim().toLowerCase();
  if (!code) return { kind: "unknown", message: "" };
  const text = OZON_STATUS_TEXT[code] ?? code;
  if (code === "cancelled") {
    return {
      kind: "cancelled",
      message: `Отправление ${text} в Ozon — собирать не нужно. Изделия верните на полку: их УИН снова свободны.`,
    };
  }
  if (OZON_SHIPPED_STATUSES.includes(code)) {
    return { kind: "shipped", message: `Отправление уже собрано в Ozon (статус «${text}»).` };
  }
  return { kind: "other", message: `В Ozon отправление в статусе «${text}» — собрать его сейчас нельзя.` };
}

/**
 * Ошибки из ответа exemplar/status. Пустая строка значит «ошибок нет» —
 * это важно отличать от «ошибка есть, но Ozon её не назвал».
 */
export function collectExemplarErrors(data) {
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
  return [...new Set(messages)].join("; ");
}

/** Ошибки проверки УИН из ответа exemplar/status — человеческим языком. */
export function exemplarStatusErrors(data) {
  return collectExemplarErrors(data) || "Ozon не принял УИН, причину не назвал.";
}

/** Статусы проверки марки: заказ готов к сборке / ещё считается / не обработан. */
const MARK_CHECK_PASSED = "passed";
const MARK_CHECK_FAILED = "failed";

/**
 * Что делать с отправлением по ответу exemplar/status.
 *
 * Поле `status` смешивает две независимые оси: готовность к сборке
 * (`ship_available` / `ship_not_available`) и возможность править экземпляры
 * (`update_available` / `update_not_available`). Вторая пара о результате
 * проверки не говорит ничего — а прежний код считал её продолжением проверки
 * и после короткого ожидания объявлял ошибку «Ozon всё ещё проверяет УИН».
 *
 * Поэтому решение принимается по самим маркам:
 *   `processing` — проверка идёт, ждём;
 *   `failed`     — Ozon не успел обработать запрос, данные надо передать заново;
 *   `passed`     — проверка пройдена.
 *
 * @param {unknown} data ответ /v5/fbs/posting/product/exemplar/status
 * @returns {{ decision: "ship" | "wait" | "resend" | "fail", status: string, message: string }}
 */
export function readExemplarProgress(data) {
  const status = String((data ?? {}).status ?? "");
  const errors = collectExemplarErrors(data);
  if (errors) return { decision: "fail", status, message: `Ozon отклонил экземпляры: ${errors}` };
  if (status === "ship_not_available") {
    return { decision: "fail", status, message: `Ozon отклонил экземпляры: ${exemplarStatusErrors(data)}` };
  }
  if (status === "ship_available") return { decision: "ship", status, message: "Сборка доступна." };

  const checks = [];
  for (const product of (data ?? {}).products ?? []) {
    for (const exemplar of product?.exemplars ?? []) {
      for (const mark of exemplar?.marks ?? []) checks.push(String(mark?.check_status ?? ""));
      for (const field of ["gtd_check_status", "rnpt_check_status", "weight_check_status"]) {
        const value = String(exemplar?.[field] ?? "");
        if (value) checks.push(value);
      }
    }
  }

  if (checks.length === 0) {
    return { decision: "wait", status, message: "Ozon ещё не зарегистрировал экземпляры отправления." };
  }
  if (checks.some((value) => value === MARK_CHECK_FAILED)) {
    return { decision: "resend", status, message: "Ozon не успел обработать УИН — передаём заново." };
  }
  if (checks.some((value) => value !== MARK_CHECK_PASSED)) {
    return { decision: "wait", status, message: "Ozon проверяет УИН." };
  }
  // Все проверки пройдены, а `ship_available` так и не объявлен. Ждать дальше
  // нечего: пробуем собрать. Откажет — Ozon назовёт настоящую причину, и она
  // попадёт кладовщику на экран вместо выдуманной «ещё проверяет».
  return { decision: "ship", status, message: "Проверка пройдена." };
}
