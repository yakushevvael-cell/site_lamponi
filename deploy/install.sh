#!/usr/bin/env bash
#
# Установка Lamponi FBS Hub на чистый сервер Ubuntu.
#
# Запускается один раз от root:
#   bash install.sh
#
# Что делает: ставит Node, nginx и сертификат, заводит отдельного пользователя
# для приложения, генерирует секреты, собирает проект, поднимает сервис и
# таймеры синхронизации. Скрипт можно запускать повторно — он не затирает
# существующие секреты и не трогает базу.
set -Eeuo pipefail

DOMAIN="${DOMAIN:-fbs.lamponi.store}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
APP_USER="lamponi"
APP_ROOT="/opt/lamponi"
RELEASE_DIR="$APP_ROOT/current"
SHARED_DIR="$APP_ROOT/shared"
DATA_DIR="/var/lib/lamponi"
NODE_MAJOR=24
PORT="${PORT:-3000}"
REPO_URL="${REPO_URL:-}"
REPO_BRANCH="${REPO_BRANCH:-main}"
SOURCE_ARCHIVE="${SOURCE_ARCHIVE:-}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "Установка прервана на строке $LINENO. Ничего не удалено, можно запустить скрипт заново."' ERR

[[ $EUID -eq 0 ]] || die "Запустите скрипт от root."
[[ -r /etc/os-release ]] || die "Не удалось определить систему."
. /etc/os-release
[[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *debian* ]] || die "Скрипт рассчитан на Ubuntu или Debian."

if [[ -z "$SOURCE_ARCHIVE" && -z "$REPO_URL" ]]; then
  die "Укажите источник кода: REPO_URL=https://... или SOURCE_ARCHIVE=/path/lamponi.tar.gz"
fi

log "Обновляю списки пакетов"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git rsync nginx ufw >/dev/null

log "Ставлю Node.js $NODE_MAJOR"
# node:sqlite — встроенный модуль, начиная с Node 24 он больше не экспериментальный.
# База лежит в обычном файле SQLite, поэтому отдельный сервер БД не нужен.
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

git config --system --add safe.directory "$RELEASE_DIR" 2>/dev/null || true

log "Готовлю пользователя и папки"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$RELEASE_DIR" "$SHARED_DIR" "$DATA_DIR" /var/www/lamponi
chmod 755 /var/www/lamponi
chown -R "$APP_USER:$APP_USER" "$APP_ROOT" "$DATA_DIR"
chmod 750 "$DATA_DIR"

log "Загружаю код приложения"
# Режим git: рабочая копия остаётся в RELEASE_DIR вместе с .git — только так
# работает deploy/update.sh и автодеплой. Режим архива оставлен как запасной.
if [[ -n "$REPO_URL" ]]; then
  if [[ -d "$RELEASE_DIR/.git" ]]; then
    log "Обновляю существующую рабочую копию"
    sudo -u "$APP_USER" git -C "$RELEASE_DIR" remote set-url origin "$REPO_URL"
    sudo -u "$APP_USER" git -C "$RELEASE_DIR" fetch --depth 1 origin "$REPO_BRANCH" || die "Не удалось получить код из $REPO_URL"
    sudo -u "$APP_USER" git -C "$RELEASE_DIR" reset --hard "origin/$REPO_BRANCH"
  else
    log "Клонирую репозиторий в $RELEASE_DIR"
    # Клонируем во временную папку и переносим внутрь: RELEASE_DIR уже создан.
    TMP_SRC="$(mktemp -d)"; chown "$APP_USER:$APP_USER" "$TMP_SRC"
    sudo -u "$APP_USER" git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$TMP_SRC/repo" || die "Не удалось склонировать репозиторий $REPO_URL"
    find "$RELEASE_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
    shopt -s dotglob
    mv "$TMP_SRC/repo"/* "$RELEASE_DIR/"
    shopt -u dotglob
    rm -rf "$TMP_SRC"
  fi
else
  [[ -f "$SOURCE_ARCHIVE" ]] || die "Архив не найден: $SOURCE_ARCHIVE"
  TMP_SRC="$(mktemp -d)"; chown "$APP_USER:$APP_USER" "$TMP_SRC"
  tar -xzf "$SOURCE_ARCHIVE" -C "$TMP_SRC"
  # Архив может содержать одну верхнюю папку — заходим внутрь.
  if [[ "$(find "$TMP_SRC" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 && ! -f "$TMP_SRC/package.json" ]]; then
    TMP_SRC="$(find "$TMP_SRC" -mindepth 1 -maxdepth 1 -type d)"
  fi
  [[ -f "$TMP_SRC/package.json" ]] || die "В исходниках нет package.json."
  warn "Установка из архива: автообновление через git работать не будет."
  rsync -a --delete --exclude ".git" --exclude "node_modules" --exclude ".env" "$TMP_SRC/" "$RELEASE_DIR/"
fi
[[ -f "$RELEASE_DIR/package.json" ]] || die "В исходниках нет package.json."
chown -R "$APP_USER:$APP_USER" "$RELEASE_DIR"

log "Готовлю настройки"
ENV_FILE="$SHARED_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  # Ключ шифрования генерируется один раз. При его потере сохранённые
  # API-ключи маркетплейсов расшифровать нельзя — их придётся ввести заново.
  CREDENTIALS_MASTER_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  SYNC_TASK_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
  cat > "$ENV_FILE" <<ENVEOF
NODE_ENV=production
PORT=$PORT
HOSTNAME=127.0.0.1
DATA_DIR=$DATA_DIR
MIGRATIONS_DIR=$RELEASE_DIR/drizzle
APP_URL=https://$DOMAIN
CREDENTIALS_MASTER_KEY=$CREDENTIALS_MASTER_KEY
SYNC_TASK_TOKEN=$SYNC_TASK_TOKEN
BACKUP_KEEP_DAYS=14
ENVEOF
  log "Секреты сгенерированы в $ENV_FILE"
else
  # Обновляем только путь к миграциям: остальное настроено и работает.
  sed -i "s|^MIGRATIONS_DIR=.*|MIGRATIONS_DIR=$RELEASE_DIR/drizzle|" "$ENV_FILE"
  log "Существующие настройки сохранены"
fi
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

log "Собираю приложение (несколько минут)"
cd "$RELEASE_DIR"
sudo -u "$APP_USER" env HOME="$APP_ROOT" npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || \
  sudo -u "$APP_USER" env HOME="$APP_ROOT" npm install --no-audit --no-fund >/dev/null
sudo -u "$APP_USER" env HOME="$APP_ROOT" npm install --no-audit --no-fund >/dev/null
sudo -u "$APP_USER" env HOME="$APP_ROOT" NODE_ENV=production npm run build

# Сборка standalone не копирует статику и публичные файлы — переносим вручную.
if [[ -d "$RELEASE_DIR/.next/standalone" ]]; then
  cp -r "$RELEASE_DIR/.next/static" "$RELEASE_DIR/.next/standalone/.next/static"
  [[ -d "$RELEASE_DIR/public" ]] && cp -r "$RELEASE_DIR/public" "$RELEASE_DIR/.next/standalone/public"
  chown -R "$APP_USER:$APP_USER" "$RELEASE_DIR/.next"
else
  die "Сборка не создала .next/standalone. Проверьте вывод сборки выше."
fi

log "Настраиваю сервис и таймеры"
install -m 644 "$RELEASE_DIR/deploy/lamponi.service" /etc/systemd/system/lamponi.service
for unit in lamponi-sync-orders lamponi-sync-stocks lamponi-backup lamponi-autodeploy; do
  install -m 644 "$RELEASE_DIR/deploy/$unit.service" "/etc/systemd/system/$unit.service"
  install -m 644 "$RELEASE_DIR/deploy/$unit.timer" "/etc/systemd/system/$unit.timer"
done
systemctl daemon-reload
systemctl enable --now lamponi.service
systemctl enable --now lamponi-sync-orders.timer lamponi-sync-stocks.timer lamponi-backup.timer
if [[ -d "$RELEASE_DIR/.git" ]]; then
  systemctl enable --now lamponi-autodeploy.timer
  log "Автодеплой включён: сервер сам подтягивает новые коммиты из $REPO_BRANCH"
else
  systemctl disable --now lamponi-autodeploy.timer 2>/dev/null || true
  warn "Автодеплой выключен: код установлен не из git."
fi

log "Настраиваю nginx"
sed "s/__DOMAIN__/$DOMAIN/g; s/__PORT__/$PORT/g" "$RELEASE_DIR/deploy/nginx-site.conf" > /etc/nginx/sites-available/lamponi.conf
ln -sf /etc/nginx/sites-available/lamponi.conf /etc/nginx/sites-enabled/lamponi.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "Настраиваю фаервол"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || warn "Не удалось включить ufw — проверьте фаервол вручную."

log "Выпускаю сертификат"
if [[ -z "$ADMIN_EMAIL" ]]; then
  warn "ADMIN_EMAIL не задан — сертификат не выпускаю. Позже: certbot --nginx -d $DOMAIN"
else
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect; then
    log "Сертификат выпущен, HTTPS включён"
  else
    warn "Сертификат не выпущен. Убедитесь, что домен $DOMAIN указывает на этот сервер, и повторите: certbot --nginx -d $DOMAIN"
  fi
fi

sleep 3
if systemctl is-active --quiet lamponi.service; then
  log "Готово. Сайт: https://$DOMAIN"
  echo "Первый зарегистрировавшийся пользователь станет администратором — откройте https://$DOMAIN/register"
else
  warn "Сервис не запустился. Журнал: journalctl -u lamponi -n 50 --no-pager"
  exit 1
fi
