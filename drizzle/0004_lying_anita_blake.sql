CREATE TABLE `app_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_email` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_email`) REFERENCES `app_users`(`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `app_session_user_idx` ON `app_sessions` (`user_email`);--> statement-breakpoint
CREATE INDEX `app_session_expires_idx` ON `app_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `phone_login_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`phone` text NOT NULL,
	`full_name` text,
	`code_hash` text NOT NULL,
	`nonce` text NOT NULL,
	`ip_hash` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `phone_code_phone_created_idx` ON `phone_login_codes` (`phone`,`created_at`);--> statement-breakpoint
CREATE INDEX `phone_code_ip_created_idx` ON `phone_login_codes` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `service_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`encrypted_payload` text NOT NULL,
	`iv` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `app_users` ADD `phone` text;--> statement-breakpoint
CREATE UNIQUE INDEX `app_user_phone_unique` ON `app_users` (`phone`);