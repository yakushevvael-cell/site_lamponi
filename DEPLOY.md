# Выкат и обновление Lamponi FBS Hub

Сайт: `https://fbs.lamponi.store`

## Как работает выкат

Код живёт в этом репозитории. На сервере лежит рабочая копия репозитория
(`/opt/lamponi/current`), таймер `lamponi-autodeploy.timer` раз в 3 минуты
проверяет ветку `main` и, если появился новый коммит, запускает обновление.

```
правка кода  ->  push в main  ->  сервер сам подхватывает (<= 3 мин)  ->  сайт обновлён
```

Обновление (`deploy/update.sh`) перед сборкой делает копию базы, а при неудачной
сборке возвращает предыдущий коммит и перезапускает старую версию. Сломанный
коммит не роняет сайт — он просто не выкатывается.

Состояние последнего выката видно снаружи:

```
https://fbs.lamponi.store/deploy-status.json
```

```json
{ "state": "deployed", "commit": "a1b2c3d", "subject": "...", "branch": "main", "checkedAt": "..." }
```

`state`: `up-to-date` — новых коммитов нет; `deploying` — идёт сборка;
`deployed` — выкачено; `failed` — сборка упала, работает прежняя версия;
`fetch-failed` — сервер не достучался до репозитория.

## Установка на чистый сервер

Ubuntu 24.04, 2 vCPU, 4 ГБ RAM, дата-центр в России (API Wildberries и Ozon
режут зарубежные адреса). От root:

```bash
git clone https://github.com/yakushevvael-cell/site_lamponi.git /root/lamponi-src
DOMAIN=fbs.lamponi.store \
REPO_URL=https://github.com/yakushevvael-cell/site_lamponi.git \
bash /root/lamponi-src/deploy/install.sh
```

Сертификат выпускается отдельно, после того как домен начнёт указывать на сервер:

```bash
certbot --nginx -d fbs.lamponi.store --agree-tos -m <почта> --redirect
```

Скрипт можно запускать повторно: секреты и база не затираются.

**Важно:** ставить именно с `REPO_URL`. При установке из архива (`SOURCE_ARCHIVE`)
рабочая копия остаётся без `.git`, и ни обновление, ни автодеплой не работают.

## Перенос на другой сервер без потери данных

API-ключи маркетплейсов зашифрованы в базе ключом `CREDENTIALS_MASTER_KEY` из
`.env`. Переносить `.env` и базу нужно вместе — по отдельности они бесполезны.

На старом сервере:

```bash
systemctl stop lamponi lamponi-sync-orders.timer lamponi-sync-stocks.timer
tar -czf /root/lamponi-data.tar.gz -C / opt/lamponi/shared/.env var/lib/lamponi
```

На новом (после установки, до первого входа):

```bash
systemctl stop lamponi
tar -xzf /root/lamponi-data.tar.gz -C /
chown -R lamponi:lamponi /opt/lamponi/shared/.env /var/lib/lamponi
chmod 600 /opt/lamponi/shared/.env
sed -i "s|^MIGRATIONS_DIR=.*|MIGRATIONS_DIR=/opt/lamponi/current/drizzle|" /opt/lamponi/shared/.env
systemctl start lamponi
```

## Что где лежит

| Путь | Что это |
| --- | --- |
| `/opt/lamponi/current` | рабочая копия репозитория |
| `/opt/lamponi/shared/.env` | секреты, при обновлении не трогаются |
| `/var/lib/lamponi/lamponi.db` | база |
| `/var/lib/lamponi/storage` | загруженные ОСВ |
| `/var/lib/lamponi/backups` | копии базы, 14 дней |
| `/var/lib/lamponi/deploy/last-deploy.log` | журнал последнего выката |

## Диагностика

```bash
systemctl status lamponi
journalctl -u lamponi -n 50 --no-pager
systemctl list-timers 'lamponi*'
cat /var/lib/lamponi/deploy/last-deploy.log
bash /opt/lamponi/current/deploy/update.sh   # выкатить вручную, не дожидаясь таймера
```

## Чего в репозитории быть не должно

`.env`, файлы базы, резервные копии, ОСВ. Потеря `CREDENTIALS_MASTER_KEY`
означает, что ключи маркетплейсов придётся вводить заново.
