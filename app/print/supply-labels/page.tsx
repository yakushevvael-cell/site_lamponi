/**
 * Этикетки поставки на печать: QR поставки и стикеры коробов (грузомест).
 *
 * Каждая этикетка — отдельная страница 58×40 мм, как термоярлык WB (картинки
 * от WB приходят 580×400 px). ?document=N — одна этикетка, без него — все
 * этикетки поставки подряд: сначала QR поставки, затем короба по порядку.
 */
import { LabelPrintTrigger } from "@/components/label-print-trigger";
import { requirePagePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { readSupply, withDocuments } from "@/lib/supplies";

export const dynamic = "force-dynamic";

export default async function SupplyLabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ supply?: string; document?: string }>;
}) {
  await requirePagePermission("/warehouse/supplies", ["warehouse.supply", "warehouse.tasks"]);
  const params = await searchParams;
  const supplyId = Number(params.supply);
  const runtime = getRuntimeEnv();
  if (!Number.isFinite(supplyId) || supplyId <= 0 || !runtime.DB) {
    return <main style={{ padding: 24, fontFamily: "system-ui" }}>Не указана поставка.</main>;
  }

  const supply = await readSupply(runtime.DB, Math.trunc(supplyId));
  if (!supply) return <main style={{ padding: 24, fontFamily: "system-ui" }}>Поставка не найдена.</main>;

  const all = withDocuments(supply).documents
    .map((document, index) => ({ document, index }))
    .filter(({ document }) => document.storageKey && document.contentType.startsWith("image/"));
  const requested = params.document === undefined ? null : Number(params.document);
  const labels = requested === null ? all : all.filter(({ index }) => index === requested);

  if (labels.length === 0) {
    return <main style={{ padding: 24, fontFamily: "system-ui" }}>Этикеток для печати нет.</main>;
  }

  return (
    <main className="labels">
      <style>{`
        html, body { margin: 0; padding: 0; background: #fff; }
        .labels { font-family: system-ui, sans-serif; }
        .label { width: 58mm; height: 40mm; display: flex; align-items: center; justify-content: center; overflow: hidden; page-break-after: always; break-after: page; }
        .label:last-child { page-break-after: auto; break-after: auto; }
        .label img { width: 100%; height: 100%; object-fit: contain; display: block; }
        @media screen {
          .labels { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px; background: #f3f3f3; }
          .label { background: #fff; box-shadow: 0 0 0 1px #ccc; }
        }
        @media print {
          @page { size: 58mm 40mm; margin: 0; }
        }
      `}</style>
      {labels.map(({ document, index }) => (
        <section key={index} className="label">
          {/* eslint-disable-next-line @next/next/no-img-element -- PNG этикетки печатается как есть, без оптимизации */}
          <img src={`/api/warehouse/supplies/file?supply=${supply.id}&document=${index}`} alt={document.label} />
        </section>
      ))}
      <LabelPrintTrigger />
    </main>
  );
}
