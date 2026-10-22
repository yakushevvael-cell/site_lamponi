/**
 * Обнулённые позиции, по которым новая ОСВ показала остаток больше нуля.
 *
 * Список видят те, кто грузит ОСВ или смотрит расхождения; отвечать «Да» /
 * «Нет» может только сотрудник с правом «Подтверждение остатка и расхождения».
 * Подробности — в lib/zero-decisions.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { applyZeroDecisions, readPendingZeroDecisions, type DecisionInput } from "@/lib/zero-decisions";

const MAX_DECISIONS = 500;

export async function GET() {
  const auth = await authorizePermission(["warehouse.problems.release", "warehouse.reports", "warehouse.osv"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const items = await readPendingZeroDecisions(runtime.DB);
  return Response.json({ items, canDecide: auth.permissions.includes("warehouse.problems.release") });
}

export async function POST(request: Request) {
  const auth = await authorizePermission("warehouse.problems.release");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { decisions?: unknown } | null;
  const decisions: DecisionInput[] = (Array.isArray(body?.decisions) ? body.decisions : [])
    .map((value) => value as { sourceSku?: unknown; confirm?: unknown; osvQty?: unknown })
    .filter((value) => typeof value?.sourceSku === "string" && value.sourceSku.trim() && typeof value.confirm === "boolean" && Number.isFinite(Number(value.osvQty)))
    .map((value) => ({ sourceSku: String(value.sourceSku).trim(), confirm: Boolean(value.confirm), osvQty: Number(value.osvQty) }));
  if (decisions.length === 0) return Response.json({ error: "Нет решений по позициям." }, { status: 400 });
  if (decisions.length > MAX_DECISIONS) return Response.json({ error: `За один раз не больше ${MAX_DECISIONS} позиций.` }, { status: 400 });

  const result = await applyZeroDecisions(runtime.DB, runtime, decisions, auth.user.email);
  const items = await readPendingZeroDecisions(runtime.DB);
  return Response.json({ ok: true, ...result, items });
}
