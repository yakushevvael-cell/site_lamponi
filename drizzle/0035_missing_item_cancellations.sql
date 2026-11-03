CREATE TABLE missing_item_cancellations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL UNIQUE,
  task_id INTEGER NOT NULL,
  marketplace_id TEXT NOT NULL,
  posting TEXT NOT NULL,
  remote_posting TEXT,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  actor TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  resume_state TEXT,
  message TEXT,
  promo TEXT,
  chat_id TEXT,
  sent_at INTEGER,
  due_at INTEGER,
  cancel_requested_at INTEGER,
  before_json TEXT,
  target_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX missing_cancel_due_idx ON missing_item_cancellations(state, due_at);
--> statement-breakpoint
CREATE UNIQUE INDEX missing_cancel_posting_lock ON missing_item_cancellations(marketplace_id, posting)
WHERE state IN ('working', 'sending', 'cancelling');
--> statement-breakpoint
CREATE TABLE missing_cancel_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
