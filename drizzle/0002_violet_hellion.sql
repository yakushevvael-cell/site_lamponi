CREATE TABLE `marketplace_credentials` (
	`marketplace_id` text PRIMARY KEY NOT NULL,
	`encrypted_payload` text NOT NULL,
	`iv` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`marketplace_id`) REFERENCES `marketplaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `order_items` ADD `seller_article` text;--> statement-breakpoint
ALTER TABLE `order_items` ADD `size` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `cancellation_source` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `seller_cancelled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `manual_zero` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `manual_zero_at` text;