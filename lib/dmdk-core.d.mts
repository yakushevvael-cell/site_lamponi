/** Типы для lib/dmdk-core.mjs. */
export type VatRate = { code: string; label: string; percent: number };
export type CodeLabel = { code: string; label: string };
export type SettingsField = { key: string; label: string; hint: string };
export type SpecificationTotals = {
  itemCount: number;
  amountKopecks: number;
  vatKopecks: number;
  amountExVatKopecks: number;
  amount: number;
  amountVAT: number;
};

export declare const VAT_RATES: VatRate[];
export declare const AMOUNT_TYPES: CodeLabel[];
export declare const DEAL_TYPES: CodeLabel[];
export declare const PRICE_SOURCES: CodeLabel[];
export declare const SPEC_STATES: Record<string, string>;
export declare const SETTINGS_FIELDS: SettingsField[];
export declare const BATCH_CHUNK: number;

export declare function vatPercent(code: string): number;
export declare function vatLabel(code: string): string;
export declare function toKopecks(value: unknown): number;
export declare function toGiisAmount(kopecks: number): number;
export declare function formatRubles(kopecks: number): string;
export declare function vatFromGross(kopecks: number, rateCode: string): number;
export declare function specificationTotals(
  items: Array<{ priceKopecks?: number; price?: number }>,
  rateCode: string,
): SpecificationTotals;
export declare function chunkBatches(uins: string[], size?: number): string[][];
export declare function missingSettings(settings: Record<string, unknown> | null | undefined): string[];
export declare function isSettingsReady(settings: Record<string, unknown> | null | undefined): boolean;
