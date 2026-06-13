# kelly-connectors

Исходники мессенджер-коннекторов для [Kelly](https://github.com/stepanovis) — пакеты, которые приложение скачивает «из коробки» по кнопке **Скачать коннектор** (Настройки → Интеграции).

Коннектор — это самостоятельный локальный мост между Kelly и мессенджером: маленький HTTP-сервис на `127.0.0.1:<port>`, который Kelly поднимает как дочерний процесс и общается с ним по токену (`BRIDGE_TOKEN`, генерится при установке — в пакетах секретов НЕТ).

## Коннекторы

| Коннектор | Runtime | Порт | Provision | Описание |
|-----------|---------|------|-----------|----------|
| `telegram` | python (telethon) | 3200 | `venv` + `pip install -r requirements.txt` | Telegram через user-сессию (api_id/api_hash/телефон + код, поддержка 2FA). |
| `whatsapp` | node (whatsapp-web.js) | 3100 | `node node_modules/puppeteer/install.mjs` (тянет Chrome) | WhatsApp через QR-логин. `node_modules` пред-упакован в zip. |

## Как это устроено

Каждый коннектор — папка с `connector.json` (манифест), точкой входа (`bridge.py` / `index.js`) и зависимостями. Загрузчик Kelly:
1. качает `<name>.zip` по `releases/latest/download/<name>.zip`;
2. распаковывает в `~/.aidev/connectors/<name>/` (структура архива ПЛОСКАЯ — файлы в корне zip);
3. читает `connector.json`, выполняет шаги `provision`;
4. стартует `entry` с env: `BRIDGE_TOKEN`, `PORT` и коннектор-специфичными (`TELEGRAM_API_ID/HASH/PHONE/SESSION` и т.п.).

### connector.json
```json
{ "name": "telegram", "version": "1.1.0", "runtime": "python",
  "entry": "bridge.py", "port": 3200, "label": "Telegram",
  "provision": ["python3 -m venv venv", "venv/bin/pip install -q -r requirements.txt"] }
```

## Сборка и публикация

```bash
./build.sh                 # → dist/telegram.zip, dist/whatsapp.zip (плоские)
gh release upload connectors-v1 dist/telegram.zip --clobber --repo stepanovis/kelly-connectors
```

> Релиз должен быть **обычным, НЕ prerelease** — иначе `releases/latest/download/<name>.zip` отдаёт 404 (GitHub `/latest` игнорирует prerelease).

## Чистота пакетов

В zip НЕ попадают: личные api_id/телефоны, файлы сессий (`telegram_session*`), токены. Токен моста генерится Kelly при установке и передаётся через env. См. `.gitignore`.
