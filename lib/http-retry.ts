/**
 * Типизированная обёртка над lib/http-retry.mjs.
 * Сама логика повторов живёт в .mjs, чтобы её покрывали юнит-тесты `node --test`.
 */
import * as core from "./http-retry.mjs";

export type RetryOutcome<T> =
  | { retry: false; value: T }
  | { retry: true; status?: number; retryAfterMs?: number | null; error?: Error };

export type RetryOptions = {
  maxAttempts?: number;
  random?: () => number;
  wait?: (ms: number) => Promise<void>;
};

export const MAX_SLEEP_MS = core.MAX_SLEEP_MS as unknown as number;
export const DEFAULT_MAX_ATTEMPTS = core.DEFAULT_MAX_ATTEMPTS as unknown as number;
export const isRetryableStatus = core.isRetryableStatus as unknown as (status: number) => boolean;
export const parseRetryAfter = core.parseRetryAfter as unknown as (value: string | null | undefined, now?: number) => number | null;
export const backoffDelay = core.backoffDelay as unknown as (attempt: number, retryAfterMs: number | null, random?: () => number) => number;
export const exceedsBudget = core.exceedsBudget as unknown as (retryAfterMs: number | null | undefined) => boolean;
export const sleep = core.sleep as unknown as (ms: number) => Promise<void>;
export const retryAfterFromHeaders = core.retryAfterFromHeaders as unknown as (headers: Headers, now?: number) => number | null;
export const pace = core.pace as unknown as (key: string, minIntervalMs: number) => Promise<void>;
export const withRetry = core.withRetry as unknown as <T>(
  attempt: (attemptNumber: number) => Promise<RetryOutcome<T>>,
  options?: RetryOptions,
) => Promise<T>;

/** Сколько секунд просит подождать площадка, если это известно. */
export function retryAfterSecondsOf(error: unknown): number | null {
  if (error && typeof error === "object" && "retryAfterSeconds" in error) {
    const value = Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}
