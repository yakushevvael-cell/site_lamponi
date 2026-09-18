/**
 * Лист подбора на печать.
 *
 * Страница нарочно без бокового меню и без интерактивных элементов: её
 * открывают в отдельной вкладке и сразу отправляют на принтер. Номер задания
 * напечатан крупно и продублирован штрихкодом — сборщик находит свой лист
 * глазами, а сканер связывает бумагу с заданием в системе.
 */
import { PrintTrigger } from "@/components/print-trigger";
import { code39Svg, taskBarcodeValue } from "@/lib/barcode39.mjs";
import { requirePagePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { formatMoment } from "@/lib/utils";
import { readTask, readTaskItems } from "@/lib/warehouse";

export const dynamic = "force-dynamic";

const MARKETPLACE_LABEL: Record<string, string> = { ozon: "Ozon", wildberries: "Wildberries" };

export default async function PickSheetPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  await requirePagePermission("/warehouse", ["warehouse.tasks", "warehouse.pick"]);
  const params = await searchParams;
  const taskId = Number(params.task);
  const runtime = getRuntimeEnv();

  if (!Number.isFinite(taskId) || taskId <= 0 || !runtime.DB) {
    return <main style={{ padding: 24, fontFamily: "system-ui" }}>Не указано задание.</main>;
  }

  const task = await readTask(runtime.DB, Math.trunc(taskId));
  if (!task) return <main style={{ padding: 24, fontFamily: "system-ui" }}>Задание не найдено.</main>;
  const items = await readTaskItems(runtime.DB, task.id);
  // Код листа у каждого задания свой. У заданий, созданных до его появления,
  // в штрихкоде по-прежнему едет номер задания в базе — такие листы читаются.
  const code = taskBarcodeValue(task.barcode ?? task.id) as string;
  const barcode = code39Svg(code, { moduleWidth: 2, height: 64 }) as string;

  return (
    <main className="pick-sheet">
      <style>{`
        .pick-sheet { padding: 16px 20px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; background: #fff; }
        .pick-sheet__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 12px; }
        .pick-sheet__number { font-size: 34px; font-weight: 800; letter-spacing: 0.02em; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .pick-sheet__meta { margin-top: 6px; font-size: 13px; color: #333; }
        .pick-sheet__barcode { text-align: center; border: 2px solid #111; border-radius: 6px; padding: 8px 12px 6px; }
        .pick-sheet__barcode-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #444; margin-bottom: 4px; }
        .pick-sheet__code { display: block; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 22px; font-weight: 800; letter-spacing: 0.16em; }
        .pick-sheet__barcode-hint { font-size: 10px; color: #444; margin-top: 2px; }
        table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
        th, td { border-bottom: 1px solid #ccc; padding: 7px 6px; text-align: left; vertical-align: top; }
        th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #444; }
        .cell { font-family: ui-monospace, monospace; font-size: 17px; font-weight: 700; white-space: nowrap; }
        .article { font-family: ui-monospace, monospace; font-weight: 600; }
        .qty { text-align: right; font-size: 16px; font-weight: 700; }
        .mark { width: 34px; }
        .mark span { display: inline-block; width: 20px; height: 20px; border: 1.5px solid #111; }
        .posting { font-family: ui-monospace, monospace; font-size: 11px; color: #444; }
        .no-cell { color: #8a5300; font-weight: 600; }
        .pick-sheet__foot { margin-top: 18px; display: flex; justify-content: space-between; font-size: 12px; color: #333; }
        @media print {
          @page { size: A4; margin: 10mm; }
          .pick-sheet { padding: 0; }
          tr { break-inside: avoid; }
        }
      `}</style>

      <PrintTrigger taskId={task.id} />

      <header className="pick-sheet__head">
        <div>
          <p className="pick-sheet__number">{task.number}</p>
          <p className="pick-sheet__meta">
            {MARKETPLACE_LABEL[task.marketplaceId] ?? task.marketplaceId} · {task.warehouseName ?? "склад не указан"}
            <br />
            {task.orderCount} заказов · {task.itemCount} позиций · {task.unitCount} шт. · {task.cellCount} ячеек
            <br />
            сформировано {formatMoment(task.createdAt)}
            {task.assigneeEmail ? ` · сборщик ${task.assigneeEmail}` : ""}
          </p>
        </div>
        <div className="pick-sheet__barcode">
          <p className="pick-sheet__barcode-title">Код листа подбора</p>
          <div dangerouslySetInnerHTML={{ __html: barcode }} />
          {/* Цифры крупно: если сканер не прочитал, код вводят руками. */}
          <span className="pick-sheet__code">{code}</span>
          <p className="pick-sheet__barcode-hint">сканировать или ввести вручную</p>
        </div>
      </header>

      <table>
        <thead>
          <tr>
            <th className="mark">✓</th>
            <th>Ячейка</th>
            <th>Артикул</th>
            <th>Размер</th>
            <th style={{ textAlign: "right" }}>Кол-во</th>
            <th>Заказ</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td className="mark"><span /></td>
              <td className={item.cellCode ? "cell" : "no-cell"}>{item.cellCode ?? "нет адреса"}</td>
              <td className="article">{item.article}</td>
              <td>{item.size ?? "—"}</td>
              <td className="qty">{item.quantity}</td>
              <td className="posting">{item.externalOrderId}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="pick-sheet__foot">
        <span>Сборщик: ______________________</span>
        <span>Время начала: __:__ · Время окончания: __:__</span>
      </footer>
    </main>
  );
}
