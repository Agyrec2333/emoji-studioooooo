#!/usr/bin/env bash
# Запускать на своей машине из папки проекта: ./deploy.sh 77.90.25.73
# Копирует файлы на сервер и запускает сервис на порту 3000.
set -euo pipefail
HOST="${1:?укажите IP сервера}"
PORT_SSH="${SSH_PORT:-2222}"
DEST=/opt/emoji-studio

ssh -p "$PORT_SSH" "root@$HOST" "mkdir -p $DEST && command -v node >/dev/null || (apt-get update -q && apt-get install -y -q nodejs)"
scp -P "$PORT_SSH" -r server.js public emoji-studio.service "root@$HOST:$DEST/"
ssh -p "$PORT_SSH" "root@$HOST" "chown -R www-data $DEST && cp $DEST/emoji-studio.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now emoji-studio && systemctl restart emoji-studio && systemctl --no-pager status emoji-studio | head -5"
echo "Готово: http://$HOST:3000"
