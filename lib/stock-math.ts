/**
 * Типизированная обёртка над lib/stock-math.mjs.
 *
 * Сама арифметика живёт в .mjs, чтобы её без сборки импортировали юнит-тесты
 * (`node --test tests/stock-math.test.mjs`). Рантайм приложения импортирует
 * только этот файл.
 */
import * as core from "./stock-math.mjs";

export type MarketplaceStockId = "wildberries" | "ozon";

export type StockBasis = {
  osvQty: number;
  reserveQty: number;
  safetyStock: number;
  manualZero?: boolean;
};

export type SendableInput = StockBasis & {
  marketplaceId: MarketplaceStockId;
  warehouseId: string | number;
  externalSku: string;
  productSku?: string | null;
  article?: string | null;
  size?: string | null;
  /** Значение `reserved`, которое вернул Ozon по паре товар–склад. Для WB не используется. */
  remoteReserved?: number;
};

export type SendableRow = {
  marketplaceId: MarketplaceStockId;
  warehouseId: string;
  productSku: string | null;
  externalSku: string;
  article: string | null;
  size: string | null;
  osvQty: number;
  reserveQty: number;
  computedQty: number;
  sentQty: number;
};

export const toWholeQty = core.toWholeQty as unknown as (value: unknown) => number;
export const computeAvailable = core.computeAvailable as unknown as (basis: StockBasis) => number;
export const wildberriesAmount = core.wildberriesAmount as unknown as (basis: StockBasis) => number;
export const ozonTotalStock = core.ozonTotalStock as unknown as (basis: StockBasis, remoteReserved: number) => number;
export const assertSendable = core.assertSendable as unknown as (row: Partial<SendableRow>) => number;
export const buildSendableRow = core.buildSendableRow as unknown as (input: SendableInput) => SendableRow;

export const StockGuardError = core.StockGuardError as unknown as {
  new (row: Partial<SendableRow>): Error & { row: Partial<SendableRow> };
  prototype: Error;
};

export type StockGuardErrorInstance = Error & { row: Partial<SendableRow> };

export function isStockGuardError(error: unknown): error is StockGuardErrorInstance {
  return error instanceof Error && error.name === "StockGuardError";
}
