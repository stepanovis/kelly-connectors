# kelly-connectors

Мессенджер-коннекторы для Kelly. Скачиваются приложением по требованию (Настройки → Интеграции → «Скачать коннектор»).

Каждый коннектор публикуется как ассет релиза `<name>.zip` и содержит исходник моста + `connector.json` (манифест: runtime, entry, port, provision).

- `telegram.zip` — Telegram (Telethon). provision: venv + pip.
- `whatsapp.zip` — WhatsApp (whatsapp-web.js). node_modules пред-упакован.
