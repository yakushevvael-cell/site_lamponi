/**
 * Подбор пункта отгрузки Wildberries под склад продавца.
 *
 * У склада продавца в кабинете WB есть привязанный склад WB (officeId) — это и
 * есть место, куда реально везут поставки. Но закрыть поставку можно только с
 * ID из нового справочника пунктов отгрузки, а идентификаторы у справочников
 * разные. Сопоставляем по координатам и адресу: у одного и того же здания они
 * совпадают, а номера — нет.
 *
 * Здесь только чистые правила: без сети и базы, чтобы их можно было проверить
 * тестами.
 */

/** Город без «г.», «Россия,» и области: WB пишет его как придётся. */
export function normalizeCity(value) {
  const parts = String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^россия$/.test(part) && !/(обл\.?|область|край|республика|респ\.?|район|р-н)(\s|$)/.test(part));
  const last = parts.length > 0 ? parts[parts.length - 1] : "";
  return last.replace(/^(г\.?|город|пгт\.?|с\.|пос\.?|п\.)\s*/u, "").trim();
}

/** Совпадает ли город пункта с искомым — с учётом разного написания. */
export function sameCity(left, right) {
  const a = normalizeCity(left);
  const b = normalizeCity(right);
  return Boolean(a) && Boolean(b) && (a === b || a.includes(b) || b.includes(a));
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function haversine(lat1, lon1, lat2, lon2) {
  const earth = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Расстояние в метрах между двумя точками. WB в разных справочниках путает
 * порядок широты и долготы, поэтому берём меньшее из двух прочтений.
 *
 * @returns {number | null}
 */
export function distanceMeters(a, b) {
  const nums = [a?.latitude, a?.longitude, b?.latitude, b?.longitude].map(Number);
  if (nums.some((value) => !Number.isFinite(value) || value === 0)) return null;
  const [lat1, lon1, lat2, lon2] = nums;
  return Math.min(haversine(lat1, lon1, lat2, lon2), haversine(lat1, lon1, lon2, lat2));
}

/** Значимые слова адреса и номера домов: «ул. Громова, д. 9» → громова, 9. */
export function addressTokens(value) {
  const text = String(value ?? "").toLowerCase().replace(/ё/g, "е");
  const words = text.match(/[a-zа-я]{4,}/gu) ?? [];
  const stop = new Set(["россия", "область", "улица", "проспект", "переулок", "шоссе", "город", "дом", "строение", "корпус", "литера", "район"]);
  const numbers = text.match(/\d+[а-я]?/gu) ?? [];
  return {
    words: new Set(words.filter((word) => !stop.has(word) && !/обл$/.test(word))),
    numbers: new Set(numbers.filter((number) => !/^\d{5,}$/.test(number))),
  };
}

function addressScore(left, right) {
  const a = addressTokens(left);
  const b = addressTokens(right);
  let words = 0;
  for (const word of a.words) if (b.words.has(word)) words += 1;
  let numbers = 0;
  for (const number of a.numbers) if (b.numbers.has(number)) numbers += 1;
  return { words, numbers };
}

/**
 * Лучший пункт отгрузки для склада WB.
 *
 * Уверенное совпадение — ближе 300 м или совпали и улица, и номер дома.
 * Иначе пункт не подставляется: неверный пункт хуже пустого — поставку
 * отвезут не туда.
 *
 * @param {{ latitude?: number, longitude?: number, address?: string | null } | null | undefined} office
 * @param {Array<{ id: number, latitude?: number, longitude?: number, address?: string | null, officeType?: string | null }>} points
 * @returns {{ id: number, distance: number | null, confident: boolean } | null}
 */
export function pickShippingPoint(office, points) {
  if (!office || !Array.isArray(points) || points.length === 0) return null;
  let best = null;
  for (const point of points) {
    const distance = distanceMeters(office, point);
    const { words, numbers } = addressScore(office.address, point.address);
    const byAddress = words > 0 && numbers > 0;
    const byDistance = distance !== null && distance <= 300;
    // Чем ближе и чем больше совпало в адресе, тем лучше. ПВЗ уступает складу
    // и сортировочному центру в том же здании.
    const score = (byDistance ? 1000 - distance : 0)
      + (byAddress ? 500 + words * 10 + numbers * 10 : words)
      + (point.officeType && point.officeType !== "pp" ? 5 : 0);
    if (!best || score > best.score) {
      best = { id: point.id, distance, confident: byDistance || byAddress, score };
    }
  }
  if (!best) return null;
  return { id: best.id, distance: best.distance, confident: best.confident };
}

/**
 * Дата отгрузки по Москве. toISOString() даёт дату по UTC: с полуночи до трёх
 * ночи по Москве это вчерашний день, и WB отклоняет его как прошедший.
 *
 * @returns {string}
 */
export function moscowDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
