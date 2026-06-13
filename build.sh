#!/usr/bin/env bash
# Собирает дистрибутивные zip-пакеты коннекторов из исходников этого репо.
# Результат — dist/<name>.zip с ПЛОСКОЙ структурой (файлы в корне архива),
# ровно как ждёт загрузчик Kelly (installConnector → unzip -o в
# ~/.aidev/connectors/<name>/, затем читает connector.json в корне).
#
# Использование:
#   ./build.sh            # собрать оба
#   ./build.sh telegram   # только telegram
#   ./build.sh whatsapp   # только whatsapp
#
# Готовые zip заливаются ассетами в GitHub Release (обычный, НЕ prerelease —
# иначе releases/latest/download/<name>.zip вернёт 404). Пример:
#   gh release upload connectors-v1 dist/telegram.zip --clobber
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
WHAT="${1:-all}"

build_telegram() {
  echo "▶ telegram.zip (python/telethon)"
  rm -f dist/telegram.zip
  ( cd telegram && zip -q "../dist/telegram.zip" bridge.py connector.json requirements.txt )
  echo "  ✓ $(unzip -l dist/telegram.zip | awk 'END{print $1}') байт распакованного, $(du -h dist/telegram.zip | cut -f1) zip"
}

build_whatsapp() {
  echo "▶ whatsapp.zip (node/whatsapp-web.js, node_modules ПРЕД-упакован)"
  rm -f dist/whatsapp.zip
  ( cd whatsapp && npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null 2>&1 )
  # Chrome не кладём в zip — его тянет provision (puppeteer install.mjs) на машине пользователя.
  ( cd whatsapp && zip -qr "../dist/whatsapp.zip" index.js connector.json package.json package-lock.json node_modules )
  echo "  ✓ $(du -h dist/whatsapp.zip | cut -f1) zip"
}

case "$WHAT" in
  telegram) build_telegram ;;
  whatsapp) build_whatsapp ;;
  all)      build_telegram; build_whatsapp ;;
  *) echo "Неизвестный коннектор: $WHAT (telegram|whatsapp|all)"; exit 1 ;;
esac
echo "Готово. Ассеты в dist/."
