/**
 * Хранение паролей.
 *
 * Используется scrypt из встроенного модуля node:crypto — без внешних
 * зависимостей, которые пришлось бы обновлять и пересобирать на сервере.
 * Пароль в базе не хранится: только соль и производный ключ, сравнение —
 * с постоянным временем, чтобы по длительности ответа нельзя было подбирать.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const ALGORITHM = "scrypt";
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** Параметры scrypt: N=16384 — принятый компромисс между стойкостью и скоростью. */
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

export const MIN_PASSWORD_LENGTH = 10;

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: 128 * COST * BLOCK_SIZE * 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** @returns {Promise<string>} строка вида scrypt$N$r$p$соль$ключ */
export async function hashPassword(password) {
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt);
  return [ALGORITHM, COST, BLOCK_SIZE, PARALLELIZATION, salt.toString("base64"), key.toString("base64")].join("$");
}

/** @returns {Promise<boolean>} */
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string" || !stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const [, cost, blockSize, parallelization, saltBase64, keyBase64] = parts;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltBase64, "base64");
    expected = Buffer.from(keyBase64, "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await new Promise((resolve) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      expected.length,
      { N: Number(cost), r: Number(blockSize), p: Number(parallelization), maxmem: 128 * Number(cost) * Number(blockSize) * 2 },
      (error, key) => resolve(error ? null : key),
    );
  });
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Требования к паролю намеренно скромные: длина важнее «обязательной цифры и
 * спецсимвола», которые люди обходят приписыванием «1!» в конец.
 * @returns {string|null} текст ошибки или null
 */
export function validatePassword(password) {
  if (typeof password !== "string") return "Пароль не передан.";
  const value = password.normalize("NFKC");
  if (value.length < MIN_PASSWORD_LENGTH) return `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов.`;
  if (value.length > 200) return "Пароль слишком длинный.";
  if (/^\s|\s$/.test(value)) return "Пароль не должен начинаться или заканчиваться пробелом.";
  if (new Set(value).size < 4) return "Пароль слишком однообразный.";
  return null;
}

/** Временный пароль для нового сотрудника: показывается администратору один раз. */
export function generateTemporaryPassword() {
  // Без похожих символов (0/O, 1/l/I), чтобы пароль можно было продиктовать.
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  let password = "";
  for (const byte of bytes) password += alphabet[byte % alphabet.length];
  return `${password.slice(0, 4)}-${password.slice(4, 8)}-${password.slice(8, 12)}-${password.slice(12, 16)}`;
}
