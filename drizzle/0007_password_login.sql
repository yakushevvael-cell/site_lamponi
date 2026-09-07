-- Вход по почте и паролю вместо входа через ChatGPT.
-- Таблица app_sessions уже существует (миграция 0004) и наконец начинает
-- использоваться: до сих пор личность пользователя подтверждала платформа.
ALTER TABLE `app_users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `app_users` ADD `password_updated_at` text;--> statement-breakpoint
-- Временный пароль, выданный администратором: пользователь обязан его сменить.
ALTER TABLE `app_users` ADD `must_change_password` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Защита от подбора: считаем неудачные попытки и запоминаем время последней.
ALTER TABLE `app_users` ADD `failed_login_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_users` ADD `locked_until` text;
