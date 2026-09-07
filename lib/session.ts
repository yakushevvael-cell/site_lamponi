/**
 * Сессии пользователей.
 *
 * До переезда личность пользователя приходила заголовком от платформы, которая
 * его аутентифицировала. На своём сервере это делаем мы: после входа выдаётся
 * случайный токен в cookie, а в базе хранится только его SHA-256 — утечка
 * таблицы сессий не даёт войти под чужим именем.
 *
 * Таблица `app_sessions` была заведена в схеме заранее и до сих пор пустовала.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

import { getRuntimeEnv } from "@/lib/runtime-env";

export const SESSION_COOKIE = "lamponi_session";
const SESSION_TTL_DAYS = 30;
/** Реже раза в 15 минут дату последнего визита не обновляем: лишняя запись в базу. */
const TOUCH_INTERVAL_MS = 15 * 60 * 1000;

export type SessionUser = {
  email: string;
  fullName: string | null;
  role: "admin" | "manager" | "user";
  status: "pending" | "active" | "blocked";
  createdAt: string;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function expiryDate() {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Создаёт сессию и ставит cookie. Возвращает срок её действия. */
export async function createSession(email: string) {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) throw new Error("База данных недоступна.");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = expiryDate();
  await runtime.DB.prepare(
    `INSERT INTO app_sessions (token_hash, user_email, expires_at, last_seen_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
  ).bind(hashToken(token), email.trim().toLowerCase(), expiresAt.toISOString()).run();

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // За HTTPS отвечает nginx; в разработке по http cookie тоже должна работать.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });

  await cleanupExpiredSessions();
  return expiresAt;
}

/** Завершает текущую сессию и убирает cookie. */
export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const runtime = getRuntimeEnv();
    await runtime.DB?.prepare("DELETE FROM app_sessions WHERE token_hash = ?").bind(hashToken(token)).run();
  }
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/** Завершает все сессии пользователя — например, после смены пароля. */
export async function destroyAllSessions(email: string) {
  const runtime = getRuntimeEnv();
  await runtime.DB?.prepare("DELETE FROM app_sessions WHERE user_email = ?").bind(email.trim().toLowerCase()).run();
}

async function cleanupExpiredSessions() {
  const runtime = getRuntimeEnv();
  await runtime.DB?.prepare("DELETE FROM app_sessions WHERE expires_at < ?")
    .bind(new Date().toISOString())
    .run()
    .catch(() => undefined);
}

/**
 * Возвращает пользователя текущей сессии или null.
 * Просроченная сессия считается отсутствующей и удаляется.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return null;

  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const tokenHash = hashToken(token);
  const row = await runtime.DB.prepare(
    `SELECT s.token_hash AS tokenHash,
            s.expires_at AS expiresAt,
            s.last_seen_at AS lastSeenAt,
            u.email, u.full_name AS fullName, u.role, u.status, u.created_at AS createdAt
     FROM app_sessions s
     JOIN app_users u ON u.email = s.user_email
     WHERE s.token_hash = ?`,
  ).bind(tokenHash).first<SessionUser & { tokenHash: string; expiresAt: string; lastSeenAt: string }>();

  if (!row) return null;

  // Сравнение с постоянным временем: значение из базы найдено по хешу,
  // но подтверждаем совпадение явно, не полагаясь на поиск по индексу.
  const stored = Buffer.from(row.tokenHash, "utf8");
  const actual = Buffer.from(tokenHash, "utf8");
  if (stored.length !== actual.length || !timingSafeEqual(stored, actual)) return null;

  if (Date.parse(row.expiresAt) <= Date.now()) {
    await runtime.DB.prepare("DELETE FROM app_sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }

  const lastSeen = Date.parse(row.lastSeenAt);
  if (!Number.isFinite(lastSeen) || Date.now() - lastSeen > TOUCH_INTERVAL_MS) {
    await runtime.DB.batch([
      runtime.DB.prepare("UPDATE app_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(tokenHash),
      runtime.DB.prepare("UPDATE app_users SET last_seen_at = CURRENT_TIMESTAMP WHERE email = ?").bind(row.email),
    ]).catch(() => undefined);
  }

  return {
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    status: row.status,
    createdAt: row.createdAt,
  };
}
