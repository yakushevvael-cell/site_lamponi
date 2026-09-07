#!/usr/bin/env bash
#
# Автодеплой: сервер сам подтягивает новые коммиты из репозитория.
#
# Запускается таймером lamponi-autodeploy.timer раз в 3 минуты от root.
# Если на ветке появился новый коммит — вызывает deploy/update.sh (он делает
# копию базы, собирает и перезапускает сервис, а при неудачной сборке
# откатывается на предыдущую версию).
#
# Результат каждого прогона пишется в status.json, чтобы состояние выката было
# видно снаружи, без входа на сервер.
set -Eeuo pipefail

APP_USER="lamponi"
APP_ROOT="/opt/lamponi"
RELEASE_DIR="$APP_ROOT/current"
DATA_DIR="${DATA_DIR:-/var/lib/lamponi}"
STATUS_DIR="$DATA_DIR/deploy"
STATUS_FILE="$STATUS_DIR/status.json"
LOG_FILE="$STATUS_DIR/last-deploy.log"
PUBLIC_DIR="/var/www/lamponi"
PUBLIC_STATUS="$PUBLIC_DIR/status.json"
REPO_BRANCH="${REPO_BRANCH:-main}"
LOCK_FILE="/run/lamponi-autodeploy.lock"

mkdir -p "$STATUS_DIR"
chown -R "$APP_USER:$APP_USER" "$STATUS_DIR"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_status() { # state, commit, subject, message
  local tmp="$STATUS_FILE.tmp"
  cat > "$tmp" <<JSON
{
  "state": "$1",
  "commit": "$2",
  "subject": $(printf '%s' "${3:-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'),
  "message": $(printf '%s' "${4:-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""'),
  "branch": "$REPO_BRANCH",
  "checkedAt": "$(now)"
}
JSON
  mv "$tmp" "$STATUS_FILE"
  chown "$APP_USER:$APP_USER" "$STATUS_FILE"
  chmod 644 "$STATUS_FILE"
  # Копия для nginx: /var/lib/lamponi закрыт от посторонних, отдавать оттуда нельзя.
  mkdir -p "$PUBLIC_DIR"
  cp "$STATUS_FILE" "$PUBLIC_STATUS"
  chmod 755 "$PUBLIC_DIR"; chmod 644 "$PUBLIC_STATUS"
}

# Два прогона одновременно недопустимы: сборка занимает больше интервала таймера.
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "Предыдущий выкат ещё идёт — пропускаю."; exit 0; }

[[ -d "$RELEASE_DIR/.git" ]] || { write_status "disabled" "" "" "Код установлен не из git — автодеплой невозможен."; exit 0; }

cd "$RELEASE_DIR"
if ! sudo -u "$APP_USER" git fetch --depth 1 origin "$REPO_BRANCH" 2>"$LOG_FILE"; then
  write_status "fetch-failed" "$(git rev-parse --short HEAD)" "" "Не удалось связаться с репозиторием: $(tail -c 400 "$LOG_FILE")"
  exit 0
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$REPO_BRANCH")"

if [[ "$LOCAL" == "$REMOTE" ]]; then
  # Ничего нового: обновляем только отметку времени проверки.
  write_status "up-to-date" "${LOCAL:0:7}" "$(git log -1 --format=%s)" ""
  exit 0
fi

echo "Новый коммит ${REMOTE:0:7} — запускаю обновление" | tee "$LOG_FILE"
write_status "deploying" "${REMOTE:0:7}" "$(git log -1 --format=%s "$REMOTE" 2>/dev/null || echo '')" ""

if REPO_BRANCH="$REPO_BRANCH" bash "$RELEASE_DIR/deploy/update.sh" >>"$LOG_FILE" 2>&1; then
  cd "$RELEASE_DIR"
  write_status "deployed" "$(git rev-parse --short HEAD)" "$(git log -1 --format=%s)" ""
  echo "Выкат завершён: $(git log -1 --format='%h %s')"
else
  cd "$RELEASE_DIR"
  write_status "failed" "$(git rev-parse --short HEAD)" "$(git log -1 --format=%s)" "Сборка не удалась, работает прежняя версия. $(tail -c 600 "$LOG_FILE")"
  echo "Выкат не удался — подробности в $LOG_FILE" >&2
  exit 1
fi
