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
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
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

# Описания служб и расписания лежат рядом с кодом, в deploy/. Раньше их
# приходилось переустанавливать руками через консоль сервера: код обновлялся
# сам, а расписание — нет. Теперь изменения подхватываются здесь же.
#
# Сравнение идёт по содержимому: если файл не менялся, systemd не трогаем
# вовсе. Сломанный файл не должен ронять выкат, поэтому перезапуск таймеров
# сделан некритичным — приложение важнее расписания.
log "Проверяю описания служб и расписания"
UNIT_DIR="/etc/systemd/system"
CHANGED_UNITS=()
for unit_path in "$RELEASE_DIR"/deploy/*.service "$RELEASE_DIR"/deploy/*.timer; do
  [[ -f "$unit_path" ]] || continue
  unit_name="$(basename "$unit_path")"
  if ! cmp -s "$unit_path" "$UNIT_DIR/$unit_name"; then
    install -m 644 "$unit_path" "$UNIT_DIR/$unit_name"
    CHANGED_UNITS+=("$unit_name")
  fi
done

if [[ ${#CHANGED_UNITS[@]} -gt 0 ]]; then
  log "Изменились: ${CHANGED_UNITS[*]}"
  systemctl daemon-reload
  for unit_name in "${CHANGED_UNITS[@]}"; do
    [[ "$unit_name" == *.timer ]] || continue
    systemctl enable "$unit_name" >/dev/null 2>&1 || warn "Не удалось включить $unit_name."
    # Таймеры синхронизации сейчас намеренно остановлены на время выката —
    # они стартуют в конце скрипта уже с новым расписанием.
    case "$unit_name" in
      lamponi-sync-orders.timer|lamponi-sync-stocks.timer) continue ;;
    esac
    systemctl restart "$unit_name" || warn "Не удалось перезапустить $unit_name — расписание осталось прежним."
  done
else
  log "Описания служб не менялись"
fi

log "Перезапускаю сервис"
systemctl restart lamponi.service
sleep 3
systemctl is-active --quiet lamponi.service || die "Сервис не поднялся. Журнал: journalctl -u lamponi -n 50 --no-pager"

systemctl start lamponi-sync-orders.timer lamponi-sync-stocks.timer
log "Расписание: $(systemctl show lamponi-sync-orders.timer -p NextElapseUSecRealtime --value) — заказы, $(systemctl show lamponi-sync-stocks.timer -p NextElapseUSecRealtime --value) — остатки"
log "Обновление завершено: $(git log -1 --format='%h %s')"
