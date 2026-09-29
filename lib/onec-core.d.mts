/** Типы для lib/onec-core.mjs. */
export type RegistryItem = { barcode: string; uin: string; article: string; size: string | null };
export type TaskLine = { barcode: string; uin: string; sum: number };
export type TaskAck = {
  id: number;
  version: string;
  ok: boolean;
  document: string;
  documentNumber: string;
  documentDate: string;
  message: string;
};

export declare const TOKEN_PREFIX: string;
export declare const ONEC_TASK_STATUSES: string[];

export declare function generateToken(): string;
export declare function hashToken(token: string): string;
export declare function tokenHint(token: string): string;
export declare function bearerToken(header: string | null | undefined): string | null;
export declare function normalizeBarcode(value: unknown): string;
export declare function parseRegistryItem(raw: unknown): RegistryItem | null;
export declare function buildTaskLines(
  items: Array<{ id: number; uin: string | null; scannedAt: string | null; barcode: string | null; unitPrice: number | null }>,
): TaskLine[];
export declare function roundMoney(value: unknown): number;
export declare function taskVersion(status: string, lines: TaskLine[]): string;
export declare function parseTaskAck(raw: unknown): TaskAck | null;
