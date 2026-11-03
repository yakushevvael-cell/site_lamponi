/** Durable outbox. Only newly marked task rows enter it; no historical bulk cancellation. */
export const CANCEL_SETTINGS_KEY = "warehouse_missing_cancel_settings";

export function renderMissingMessage(settings, item) {
  const template = String(settings?.text ?? "").trim();
  const promo = String(settings?.promo ?? "").trim();
  if (!template || !promo) throw new Error("Заполните сообщение покупателю и промокод в настройках отмены.");
  const text = template.replaceAll("{промокод}", promo).replaceAll("{артикул}", item.article)
    .replaceAll("{количество}", String(item.quantity)).replaceAll("{заказ}", item.posting);
  const result = template.includes("{промокод}") ? text : `${text}\nПромокод: ${promo}`;
  if (result.length > 1000) throw new Error("Сообщение с подставленными значениями должно быть не длиннее 1000 символов.");
  return result;
}

export function productQuantities(posting) {
  const quantities = {};
  for (const product of posting.products ?? []) {
    const sku = String(product.sku);
    const qty = Number(product.quantity);
    if (!Number.isSafeInteger(qty) || qty < 0) throw new Error("Ozon вернул некорректное количество товара.");
    quantities[sku] = (quantities[sku] ?? 0) + qty;
  }
  return quantities;
}

export function planPartialCancellation(posting, sku, quantity) {
  if (posting.status !== "awaiting_packaging" || posting.substatus === "posting_split_pending") {
    throw new Error(`Частичная отмена не запущена: отправление Ozon в статусе ${posting.status}. Остальные изделия не отменены.`);
  }
  if (!Number.isSafeInteger(Number(sku)) || Number(sku) <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Некорректный SKU или количество для отмены.");
  }
  const before = productQuantities(posting);
  if ((before[sku] ?? 0) < quantity) throw new Error("Количество в Ozon изменилось. Проверьте отсутствующее изделие вручную.");
  const target = { ...before, [sku]: before[sku] - quantity };
  return { before, target };
}

export function sameQuantities(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => (a[key] ?? 0) === (b[key] ?? 0));
}

async function setState(db, job, state, error, now) {
  await db.batch([
    db.prepare("UPDATE missing_item_cancellations SET state = ?, error = ?, updated_at = ? WHERE id = ?").bind(state, error ?? null, now(), job.id),
    db.prepare("INSERT INTO missing_cancel_events(job_id,state,detail,created_at) VALUES(?,?,?,?)").bind(job.id, state, error ?? null, now()),
  ]);
}

async function complete(db, job, now) {
  const remap = job.remote_posting && job.remote_posting !== job.posting ? [
    db.prepare("UPDATE pick_task_items SET external_order_id=? WHERE task_id=? AND marketplace_id=? AND external_order_id=? AND id<>?")
      .bind(job.remote_posting,job.task_id,job.marketplace_id,job.posting,job.item_id),
    db.prepare("UPDATE missing_item_cancellations SET posting=? WHERE task_id=? AND marketplace_id=? AND posting=? AND id<>? AND state<>'done'")
      .bind(job.remote_posting,job.task_id,job.marketplace_id,job.posting,job.id),
    db.prepare("DELETE FROM shipment_labels WHERE marketplace_id=? AND external_order_id=?").bind(job.marketplace_id,job.remote_posting),
    db.prepare("DELETE FROM ozon_label_jobs WHERE posting_number=?").bind(job.remote_posting),
  ] : [];
  await db.batch([
    ...remap,
    db.prepare("UPDATE missing_item_cancellations SET state = 'done', error = NULL, updated_at = ? WHERE id = ?").bind(now(), job.id),
    // Old PDFs must never be printed after a composition change.
    db.prepare("DELETE FROM shipment_labels WHERE marketplace_id = ? AND external_order_id = ?").bind(job.marketplace_id, job.posting),
    db.prepare("DELETE FROM ozon_label_jobs WHERE posting_number = ?").bind(job.posting),
    db.prepare("INSERT INTO missing_cancel_events(job_id,state,created_at) VALUES(?,'done',?)").bind(job.id, now()),
  ]);
}

/** @param {any} db @param {any} api @param {{now?: Function, itemId?: number, limit?: number}} options */
export async function runMissingCancellations(db, api, options = {}) {
  const now = options.now ?? Date.now;
  // An interrupted mutation may already have reached Ozon. Never replay it blindly.
  await db.prepare(`UPDATE missing_item_cancellations SET
    state = CASE WHEN cancel_requested_at IS NOT NULL THEN 'verifying'
      WHEN sent_at IS NOT NULL THEN 'scheduled'
      WHEN state='working' THEN 'queued' ELSE 'uncertain' END,
    error = CASE WHEN state='sending' AND sent_at IS NULL THEN 'Обработка сообщения прервана. Проверьте отправку в кабинете Ozon; автоматический повтор отключён.' ELSE NULL END
    WHERE state IN ('working','sending','cancelling') AND updated_at < ?`).bind(now() - 300000).run();
  const jobs = await db.prepare(`SELECT * FROM missing_item_cancellations j
    WHERE state IN ('queued','scheduled','verifying') AND (due_at IS NULL OR due_at <= ?)
    AND NOT EXISTS (SELECT 1 FROM missing_item_cancellations earlier WHERE earlier.marketplace_id=j.marketplace_id
      AND earlier.posting=j.posting AND earlier.id<j.id AND earlier.state<>'done')
    AND (? IS NULL OR item_id = ?) ORDER BY CASE WHEN state = 'scheduled' THEN 0 ELSE 1 END, id LIMIT ?`)
    .bind(now(), options.itemId ?? null, options.itemId ?? null, options.limit ?? 5).all();
  let processed = 0;
  for (const job of jobs.results) {
    let claimed;
    try {
      claimed = await db.prepare("UPDATE missing_item_cancellations SET resume_state = state, state = 'working', updated_at = ? WHERE id = ? AND state = ?")
        .bind(now(), job.id, job.state).run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint")) continue;
      throw error;
    }
    if (!claimed.meta.changes) continue;
    processed++;
    let mutation = false;
    try {
      const item = await db.prepare(`SELECT ti.*, pt.status AS task_status FROM pick_task_items ti JOIN pick_tasks pt ON pt.id = ti.task_id WHERE ti.id = ? AND ti.task_id = ?`)
        .bind(job.item_id, job.task_id).first();
      if (!item || item.status !== 'not_found' || ['shipped','cancelled'].includes(item.task_status)) throw new Error("Задание или отметка изменились. Автоматическая отмена остановлена.");
      if (item.external_order_id !== job.posting || item.external_sku !== job.sku || item.quantity !== job.quantity) throw new Error("Состав строки задания изменился. Нужна ручная проверка.");
      if (job.marketplace_id === 'wildberries') {
        const siblings = await db.prepare("SELECT COUNT(*) AS count FROM pick_task_items WHERE marketplace_id = 'wildberries' AND external_order_id = ? AND id <> ?").bind(job.posting, job.item_id).first();
        if (job.quantity !== 1 || siblings.count > 0) throw new Error("У WB-заказа несколько изделий. Полная отмена запрещена; нужна ручная проверка.");
        const status = await api.wbStatus(job.posting);
        if (status === 'cancel') { await complete(db, job, now); continue; }
        if (job.state === 'verifying') throw new Error("WB ещё не подтвердил отмену. Проверьте заказ вручную.");
        if (!['new','confirm'].includes(status)) throw new Error(`WB: отмена не запущена, статус ${status}.`);
        await db.prepare("UPDATE missing_item_cancellations SET cancel_requested_at=? WHERE id=?").bind(now(),job.id).run();
        await setState(db, job, 'cancelling', null, now); mutation = true;
        await api.wbCancel(job.posting);
        if (await api.wbStatus(job.posting) !== 'cancel') {
          await db.prepare("UPDATE missing_item_cancellations SET due_at = ? WHERE id = ?").bind(now()+5000, job.id).run();
          await setState(db, job, 'verifying', null, now); continue;
        }
        await complete(db, job, now); continue;
      }
      const posting = await api.ozonPosting(job.remote_posting ?? job.posting);
      if (job.state === 'queued') {
        const plan = planPartialCancellation(posting, job.sku, job.quantity);
        const settingsRow = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(CANCEL_SETTINGS_KEY).first();
        const settings = settingsRow ? JSON.parse(settingsRow.value) : {};
        const message = job.message ?? renderMissingMessage(settings, {article:item.article, quantity:job.quantity, posting:job.posting});
        await api.ozonCheckReason();
        const chat = job.chat_id ?? await api.ozonChat(job.posting);
        await db.prepare(`UPDATE missing_item_cancellations SET message=?, promo=?, chat_id=?, before_json=?, target_json=? WHERE id=?`)
          .bind(message, job.promo ?? settings.promo, chat, JSON.stringify(plan.before), JSON.stringify(plan.target), job.id).run();
        await setState(db, job, 'sending', null, now); mutation = true;
        await api.ozonSend(chat, message);
        const sent = now();
        await db.prepare("UPDATE missing_item_cancellations SET sent_at=?, due_at=? WHERE id=?").bind(sent, sent+60000, job.id).run();
        await setState(db, job, 'scheduled', null, now); mutation = false;
        continue;
      }
      const before = JSON.parse(job.before_json);
      const target = JSON.parse(job.target_json);
      const current = posting.status === 'cancelled' ? {} : productQuantities(posting);
      if (sameQuantities(current, target)) { await complete(db, job, now); continue; }
      if (job.state === 'verifying') {
        throw new Error("Ozon ещё не подтвердил точный состав после отмены. Повторная отмена не отправлена; проверьте заказ вручную.");
      }
      if (!sameQuantities(current, before)) throw new Error("Состав отправления изменился за время ожидания. Повторная отмена не отправлена.");
      planPartialCancellation(posting, job.sku, job.quantity);
      if (!job.sent_at || now() < job.sent_at+60000) throw new Error("Не подтверждена отправка сообщения или ещё не прошло 60 секунд.");
      await db.prepare("UPDATE missing_item_cancellations SET cancel_requested_at=? WHERE id=?").bind(now(),job.id).run();
      await setState(db, job, 'cancelling', null, now); mutation = true;
      const responsePosting = await api.ozonCancel(job.posting, job.sku, job.quantity);
      // Only a number explicitly returned by Ozon may replace the original; verify its full composition first.
      if (responsePosting) await db.prepare("UPDATE missing_item_cancellations SET remote_posting=? WHERE id=?").bind(responsePosting,job.id).run();
      await db.prepare("UPDATE missing_item_cancellations SET due_at=? WHERE id=?").bind(now()+5000, job.id).run();
      await setState(db, job, 'verifying', null, now);
    } catch (error) {
      // A definitive HTTP refusal did not apply the cancellation; a manual retry may try again.
      if (mutation && error?.definitive) {
        await db.prepare("UPDATE missing_item_cancellations SET cancel_requested_at=NULL WHERE id=?").bind(job.id).run();
      }
      const uncertain = mutation && !error?.definitive;
      await setState(db, job, uncertain ? 'uncertain' : 'error', error instanceof Error ? error.message : String(error), now);
    }
  }
  return { processed };
}
