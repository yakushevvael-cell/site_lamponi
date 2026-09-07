CREATE TABLE `marketplace_warehouses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`marketplace_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`publish_full_stock` integer DEFAULT true NOT NULL,
	`last_stock_sync_at` text,
	FOREIGN KEY (`marketplace_id`) REFERENCES `marketplaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_marketplace_external_unique` ON `marketplace_warehouses` (`marketplace_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `marketplaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`connection_status` text DEFAULT 'awaiting_keys' NOT NULL,
	`last_sync_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`product_sku` text,
	`external_sku` text NOT NULL,
	`quantity` real NOT NULL,
	`unit_price` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_sku`) REFERENCES `products`(`source_sku`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_item_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`marketplace_id` text NOT NULL,
	`external_order_id` text NOT NULL,
	`status` text NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`ordered_at` text NOT NULL,
	`shipped_at` text,
	`delivered_at` text,
	`buyout_at` text,
	`canceled_at` text,
	`region` text,
	`city` text,
	`warehouse_external_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`marketplace_id`) REFERENCES `marketplaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_marketplace_external_unique` ON `orders` (`marketplace_id`,`external_order_id`);--> statement-breakpoint
CREATE INDEX `order_ordered_at_idx` ON `orders` (`ordered_at`);--> statement-breakpoint
CREATE INDEX `order_status_idx` ON `orders` (`status`);--> statement-breakpoint
CREATE TABLE `osv_uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_name` text NOT NULL,
	`storage_key` text,
	`status` text DEFAULT 'processed' NOT NULL,
	`sku_count` integer DEFAULT 0 NOT NULL,
	`total_quantity` real DEFAULT 0 NOT NULL,
	`zero_quantity_count` integer DEFAULT 0 NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`uploaded_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`source_sku` text PRIMARY KEY NOT NULL,
	`name` text,
	`current_physical_qty` real DEFAULT 0 NOT NULL,
	`latest_upload_id` integer,
	`safety_stock` real DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`latest_upload_id`) REFERENCES `osv_uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sku_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_sku` text NOT NULL,
	`marketplace_id` text NOT NULL,
	`external_sku` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`product_sku`) REFERENCES `products`(`source_sku`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`marketplace_id`) REFERENCES `marketplaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sku_mapping_marketplace_external_unique` ON `sku_mappings` (`marketplace_id`,`external_sku`);--> statement-breakpoint
CREATE INDEX `sku_mapping_product_idx` ON `sku_mappings` (`product_sku`);--> statement-breakpoint
CREATE TABLE `stock_reservations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_item_id` integer NOT NULL,
	`product_sku` text NOT NULL,
	`marketplace_id` text NOT NULL,
	`quantity` real NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`reserved_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`released_at` text,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_sku`) REFERENCES `products`(`source_sku`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`marketplace_id`) REFERENCES `marketplaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reservation_product_status_idx` ON `stock_reservations` (`product_sku`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `reservation_order_item_unique` ON `stock_reservations` (`order_item_id`);--> statement-breakpoint
CREATE TABLE `stock_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`upload_id` integer NOT NULL,
	`product_sku` text NOT NULL,
	`physical_qty` real NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `osv_uploads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_sku`) REFERENCES `products`(`source_sku`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_snapshot_upload_sku_unique` ON `stock_snapshots` (`upload_id`,`product_sku`);--> statement-breakpoint
CREATE INDEX `stock_snapshot_product_idx` ON `stock_snapshots` (`product_sku`);--> statement-breakpoint
CREATE TABLE `sync_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`marketplace_id` text,
	`direction` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`marketplace_id`) REFERENCES `marketplaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sync_event_created_at_idx` ON `sync_events` (`created_at`);