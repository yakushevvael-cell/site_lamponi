#!/usr/bin/env bash
#
# Обновление уже установленного приложения.
#
# Забирает свежий код, пересобирает и перезапускает сервис. База, загруженные
# ОСВ и секреты не трогаются: они лежат отдельно от кода.
#
# Запуск от root:  bash /opt/lamponi/current/deploy/update.sh
set -Eeuo pipefail

APP_USER="lamponi"
APP_ROOT="/opt/lamponi"
RELEASE_DIR="$APP_ROOT/current"
SHARED_DIR="$APP_ROOT/shared"
REPO_BRANCH="${REPO_BRANCH:-main}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Запустите от root."
[[ -d "$RELEASE_DIR/.git" ]] || die "Обновление через git недоступно: код ставился из архива. Используйте install.sh с новым архивом."

# Пока идёт выкат, синхронизация не должна стартовать по таймеру.
log "Останавливаю таймеры синхронизации"
systemctl stop lamponi-sync-orders.timer lamponi-sync-stocks.timer || true

log "Резервная копия базы перед обновлением"
sudo -u "$APP_USER" env $(grep -v '^#' "$SHARED_DIR/.env" | xargs) node "$RELEASE_DIR/scripts/backup.mjs" || die "Копия не создана — обновление остановлено."

log "Забираю свежий код"
cd "$RELEASE_DIR"
PREVIOUS="$(git rev-parse HEAD)"
sudo -u "$APP_USER" git fetch --depth 1 origin "$REPO_BRANCH"
sudo -u "$APP_USER" git reset --hard "origin/$REPO_BRANCH"

log "Собираю"
if ! sudo -u "$APP_USER" env HOME="$APP_ROOT" npm install --no-audit --no-fund >/dev/null ||
   ! sudo -u "$APP_USER" env HOME="$APP_ROOT" NODE_ENV=production npm run build; then
  log "Сборка не удалась — возвращаю предыдущую версию"
  sudo -u "$APP_USER" git reset --hard "$PREVIOUS"
  sudo -u "$APP_USER" env HOME="$APP_ROOT" npm install --no-audit --no-fund >/dev/null
  sudo -u "$APP_USER" env HOME="$APP_ROOT" NODE_ENV=production npm run build
  systemctl start lamponi-sync-orders.timer lamponi-sync-stocks.timer
  die "Обновление отменено, работает прежняя версия."
fi

cp -r "$RELEASE_DIR/.next/static" "$RELEASE_DIR/.next/standalone/.next/static"
[[ -d "$RELEASE_DIR/public" ]] && cp -r "$RELEASE_DIR/public" "$RELEASE_DIR/.next/standalone/public"
chown -R "$APP_USER:$APP_USER" "$RELEASE_DIR/.next"

log "Перезапускаю сервис"
systemctl restart lamponi.service
sleep 3
systemctl is-active --quiet lamponi.service || die "Сервис не поднялся. Журнал: journalctl -u lamponi -n 50 --no-pager"

systemctl start lamponi-sync-orders.timer lamponi-sync-stocks.timer
log "Обновление завершено: $(git log -1 --format='%h %s')"
