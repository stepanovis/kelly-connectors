#!/usr/bin/env bash
# Собирает дистрибутивные zip-пакеты коннекторов из исходников этого репо.
# Результат — dist/<name>.zip с ПЛОСКОЙ структурой (файлы в корне архива),
# ровно как ждёт загрузчик Kelly (installConnector → unzip -o в
# ~/.aidev/connectors/<name>/, затем читает connector.json в корне).
#
# Также генерирует dist/manifest.json — карту актуальных версий всех коннекторов.
# Kelly читает его при проверке обновлений (checkConnectorUpdates).
#
# Использование:
#   ./build.sh            # собрать оба + manifest
#   ./build.sh telegram   # только telegram + manifest
#   ./build.sh whatsapp   # только whatsapp + manifest
#
# Готовые файлы заливаются ассетами в GitHub Release (обычный, НЕ prerelease —
# иначе releases/latest/download/... вернёт 404). Пример:
#   gh release upload connectors-v1 dist/telegram.zip dist/manifest.json --clobber
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
  ( cd whatsapp && zip -qr "../dist/whatsapp.zip" index.js auth_descriptor.js connector.json package.json package-lock.json node_modules )
  echo "  ✓ $(du -h dist/whatsapp.zip | cut -f1) zip"
}

build_manifest() {
  echo "▶ manifest.json (карта версий коннекторов)"
  local entries=""
  for dir in telegram whatsapp; do
    local cjson="$dir/connector.json"
    [ -f "$cjson" ] || continue
    local ver
    ver=$(python3 -c "import json,sys; print(json.load(open('$cjson'))['version'])")
    [ -n "$entries" ] && entries="$entries,"
    entries="$entries\"$dir\": \"$ver\""
  done
  printf '{%s}\n' "$entries" > dist/manifest.json
  echo "  ✓ dist/manifest.json: $(cat dist/manifest.json)"
}

case "$WHAT" in
  telegram) build_telegram ;;
  whatsapp) build_whatsapp ;;
  all)      build_telegram; build_whatsapp ;;
  *) echo "Неизвестный коннектор: $WHAT (telegram|whatsapp|all)"; exit 1 ;;
esac
build_manifest
echo "Готово. Ассеты в dist/."
