-- Номер асинхронного задания переживает обновление страницы и перезапуск сервера.
CREATE TABLE IF NOT EXISTS ozon_label_jobs (
  client_id TEXT NOT NULL,
  posting_number TEXT NOT NULL,
  task_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, posting_number)
);
--> statement-breakpoint
ALTER TABLE shipment_labels ADD ozon_label_lines TEXT;
