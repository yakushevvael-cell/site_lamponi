ALTER TABLE `osv_uploads` ADD `article_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `osv_uploads` ADD `sized_variant_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `article` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `size` text;--> statement-breakpoint
CREATE INDEX `product_article_size_idx` ON `products` (`article`,`size`);