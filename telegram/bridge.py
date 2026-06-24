#!/usr/bin/env python3
"""
Telegram Bridge — HTTP API for Telegram via Telethon.
Mirrors the WhatsApp Bridge v2 API structure.

Endpoints (no auth):
  GET  /status              - Connection status

Endpoints (require Bearer token):
  GET  /contacts            - List contacts
  GET  /contacts/search?q=  - Search contacts
  GET  /chats               - List dialogs/chats
  GET  /messages?chatId=    - Read messages from a chat
  GET  /messages/unread     - Get unread messages
  POST /messages/send       - Send a message

Usage:
  1. Set environment variables (or use defaults):
     TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE, API_TOKEN, PORT
  2. Run: python3 bridge.py
  3. On first run, enter the auth code in the terminal.
"""

import os
import asyncio
import json
import logging
import signal as _signal
import time
from datetime import datetime, timezone

from aiohttp import web
from telethon import TelegramClient, types, functions
from telethon.sessions import StringSession
from telethon.tl.types import (
    User, Chat, Channel,
    PeerUser, PeerChat, PeerChannel,
    Dialog, MessageMediaDocument, MessageMediaPhoto,
)
from telethon.errors import (
    FloodWaitError,
    PhoneCodeInvalidError,
    PhoneCodeExpiredError,
    SessionPasswordNeededError,
    PasswordHashInvalidError,
)

# ── Config ──
API_ID = int(os.environ.get('TELEGRAM_API_ID', '0'))
API_HASH = os.environ.get('TELEGRAM_API_HASH', '')
PHONE = os.environ.get('TELEGRAM_PHONE', '')
SESSION_FILE = os.environ.get('TELEGRAM_SESSION', 'telegram_session')
TOKEN = os.environ.get('BRIDGE_TOKEN', os.environ.get('API_TOKEN', ''))
PORT = int(os.environ.get('PORT', '3200'))

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
log = logging.getLogger('telegram-bridge')

# ── Globals ──
client: TelegramClient = None
is_ready = False


# ── Helpers ──
def entity_to_chat_id(entity):
    """Convert entity to a string chat ID."""
    if isinstance(entity, User):
        return f"user_{entity.id}"
    elif isinstance(entity, Chat):
        return f"chat_{entity.id}"
    elif isinstance(entity, Channel):
        return f"channel_{entity.id}"
    return str(getattr(entity, 'id', 0))


def parse_chat_id(chat_id_str):
    """Parse string chat ID back to integer for Telethon."""
    if '_' in chat_id_str:
        parts = chat_id_str.split('_', 1)
        return int(parts[1])
    return int(chat_id_str)


def entity_name(entity):
    """Get display name for an entity."""
    if isinstance(entity, User):
        parts = [entity.first_name or '', entity.last_name or '']
        return ' '.join(p for p in parts if p).strip()
    return getattr(entity, 'title', '') or ''


def entity_to_dict(entity):
    """Convert entity to a JSON-friendly dict."""
    if isinstance(entity, User):
        return {
            'id': entity_to_chat_id(entity),
            'name': entity_name(entity),
            'username': entity.username or '',
            'phone': entity.phone or '',
            'isBot': entity.bot or False,
            'isContact': entity.contact or False,
        }
    elif isinstance(entity, (Chat, Channel)):
        return {
            'id': entity_to_chat_id(entity),
            'name': entity.title or '',
            'username': getattr(entity, 'username', '') or '',
            'isGroup': isinstance(entity, Chat) or (isinstance(entity, Channel) and entity.megagroup),
            'isChannel': isinstance(entity, Channel) and not entity.megagroup,
        }
    return {'id': str(getattr(entity, 'id', 0)), 'name': str(entity)}


def message_to_dict(msg, chat_id_str=''):
    """Convert a Telethon message to a JSON-friendly dict."""
    sender_id = ''
    if msg.sender:
        sender_id = entity_to_chat_id(msg.sender)
    elif msg.from_id:
        if isinstance(msg.from_id, PeerUser):
            sender_id = f"user_{msg.from_id.user_id}"
        elif isinstance(msg.from_id, PeerChat):
            sender_id = f"chat_{msg.from_id.chat_id}"
        elif isinstance(msg.from_id, PeerChannel):
            sender_id = f"channel_{msg.from_id.channel_id}"

    return {
        'id': msg.id,
        'chatId': chat_id_str,
        'from': sender_id,
        'fromMe': msg.out or False,
        'body': msg.text or msg.message or '',
        'timestamp': int(msg.date.timestamp()) if msg.date else 0,
        'type': 'chat' if not msg.media else 'media',
        'hasMedia': msg.media is not None,
        'replyTo': msg.reply_to.reply_to_msg_id if msg.reply_to else None,
    }


# ── Auth middleware ──
# Connect-flow endpoints are unauthenticated (the connection is being established —
# there is no session yet); everything else requires the bridge token. Token is still
# validated on every data/send endpoint (Контракт 1 MUST, флаг V3).
_AUTH_OPEN_PATHS = (
    '/status', '/auth/status', '/auth/code',
    '/auth/start', '/auth/submit', '/auth/cancel',
)


@web.middleware
async def auth_middleware(request, handler):
    if request.path in _AUTH_OPEN_PATHS:
        return await handler(request)
    auth = request.headers.get('Authorization', '')
    if auth != f'Bearer {TOKEN}':
        return web.json_response({'error': 'Unauthorized'}, status=401)
    return await handler(request)


# ── Routes ──
async def handle_status(request):
    dialogs_count = 0
    if is_ready:
        try:
            dialogs = await client.get_dialogs(limit=0)
            dialogs_count = dialogs.total if hasattr(dialogs, 'total') else 0
        except Exception:
            pass
    return web.json_response({
        'status': 'connected' if is_ready else 'disconnected',
        'ready': is_ready,
        'chats': dialogs_count,
        'phone': PHONE,
    })


# ── Contacts cache: avoid Telegram FloodWait from refetching the full contact
# list on every search. Refresh at most once per TTL; on FloodWait/error serve
# the cached list instead of failing. Read-only — does not touch session/auth/send.
_contacts_cache = {'users': None, 'ts': 0.0}
CONTACTS_TTL = 600  # seconds


async def get_contacts_users():
    now = time.time()
    cached = _contacts_cache['users']
    if cached is not None and (now - _contacts_cache['ts']) < CONTACTS_TTL:
        return cached
    try:
        result = await client(functions.contacts.GetContactsRequest(hash=0))
        _contacts_cache['users'] = result.users
        _contacts_cache['ts'] = now
        return result.users
    except FloodWaitError as e:
        log.warning(f'GetContacts FloodWait {e.seconds}s — serving cached ({len(cached) if cached else 0})')
        return cached or []
    except Exception as e:
        log.warning(f'GetContacts error: {e} — serving cached ({len(cached) if cached else 0})')
        return cached or []


async def handle_contacts(request):
    if not is_ready:
        return web.json_response({'error': 'Telegram not ready'}, status=503)
    try:
        users = await get_contacts_users()
        contacts = []
        for user in users:
            contacts.append(entity_to_dict(user))
        contacts.sort(key=lambda c: c.get('name', ''))
        return web.json_response(contacts)
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_contacts_search(request):
    if not is_ready:
        return web.json_response({'error': 'Telegram not ready'}, status=503)
    q = (request.query.get('q', '') or '').lower()
    if not q:
        return web.json_response([])
    try:
        users = await get_contacts_users()
        matches = []
        for user in users:
            name = entity_name(user).lower()
            username = (user.username or '').lower()
            phone = (user.phone or '').lower()
            if q in name or q in username or q in phone:
                matches.append(entity_to_dict(user))
        return web.json_response(matches)
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_chats(request):
    if not is_ready:
        return web.json_response({'error': 'Telegram not ready'}, status=503)
    try:
        limit = int(request.query.get('limit', '50'))
        dialogs = await client.get_dialogs(limit=limit)
        chats = []
        for d in dialogs:
            chat_id = entity_to_chat_id(d.entity)
            last_msg = ''
            last_ts = 0
            if d.message:
                last_msg = (d.message.text or d.message.message or '')[:100]
                last_ts = int(d.message.date.timestamp()) if d.message.date else 0
            chats.append({
                'id': chat_id,
                'name': d.name or entity_name(d.entity),
                'isGroup': d.is_group,
                'isChannel': d.is_channel and not d.is_group,
                'unreadCount': d.unread_count or 0,
                'lastMessage': last_msg,
                'timestamp': last_ts,
            })
        chats.sort(key=lambda c: c['timestamp'], reverse=True)
        return web.json_response(chats)
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_messages(request):
    if not is_ready:
        return web.json_response({'error': 'Telegram not ready'}, status=503)
    chat_id_str = request.query.get('chatId', '')
    if not chat_id_str:
        return web.json_response({'error': 'chatId parameter required'}, status=400)
    limit = int(request.query.get('limit', '50'))
    try:
        peer_id = parse_chat_id(chat_id_str)
        entity = await client.get_entity(peer_id)
        messages = await client.get_messages(entity, limit=limit)
        msg_list = []
        for msg in reversed(messages):
            msg_list.append(message_to_dict(msg, chat_id_str))
        return web.json_response({
            'chatId': chat_id_str,
            'chatName': entity_name(entity) if isinstance(entity, User) else getattr(entity, 'title', ''),
            'messages': msg_list,
            'total': len(msg_list),
        })
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_messages_unread(request):
    if not is_ready:
        return web.json_response({'error': 'Telegram not ready'}, status=503)
    try:
        dialogs = await client.get_dialogs(limit=100)
        unread = []
        for d in dialogs:
            if d.unread_count > 0:
                chat_id = entity_to_chat_id(d.entity)
                messages = await client.get_messages(d.entity, limit=d.unread_count)
                msg_list = []
                for msg in reversed(messages):
                    msg_list.append(message_to_dict(msg, chat_id))
                unread.append({
                    'chatId': chat_id,
                    'name': d.name or entity_name(d.entity),
                    'isGroup': d.is_group,
                    'unreadCount': d.unread_count,
                    'messages': msg_list,
                })
        unread.sort(key=lambda u: u['messages'][-1]['timestamp'] if u['messages'] else 0, reverse=True)
        return web.json_response(unread)
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_message_media(request):
    """GET /messages/{msg_id}/media?chatId=... — download media from a message."""
    if not is_ready:
        return web.json_response({'error': 'Telegram not ready'}, status=503)
    chat_id_str = request.query.get('chatId', '')
    if not chat_id_str:
        return web.json_response({'error': 'chatId parameter required'}, status=400)
    msg_id = int(request.match_info['msg_id'])
    try:
        peer_id = parse_chat_id(chat_id_str)
        entity = await client.get_entity(peer_id)
        messages = await client.get_messages(entity, ids=msg_id)
        if not messages or not messages.media:
            return web.json_response({'error': 'No media in message'}, status=404)
        import io
        buf = io.BytesIO()
        await client.download_media(messages, file=buf)
        buf.seek(0)
        data = buf.read()
        # Determine filename
        filename = 'file'
        if hasattr(messages.media, 'document') and messages.media.document:
            for attr in messages.media.document.attributes:
                if hasattr(attr, 'file_name') and attr.file_name:
                    filename = attr.file_name
                    break
            mime = getattr(messages.media.document, 'mime_type', 'application/octet-stream')
        else:
            mime = 'application/octet-stream'
        return web.Response(
            body=data,
            content_type=mime,
            headers={'Content-Disposition': f'attachment; filename="{filename}"'}
        )
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


async def handle_messages_send(request):
    if not is_ready:
        return web.json_response({'error': 'Telegram not ready'}, status=503)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)

    chat_id_str = data.get('chatId', '')
    phone = data.get('phone', '')
    username = data.get('username', '')
    text = data.get('text', '')

    if not text:
        return web.json_response({'error': 'text required'}, status=400)

    try:
        entity = None
        if chat_id_str:
            peer_id = parse_chat_id(chat_id_str)
            entity = await client.get_entity(peer_id)
        elif phone:
            entity = await client.get_entity(phone)
        elif username:
            entity = await client.get_entity(username)
        else:
            return web.json_response({'error': 'chatId, phone, or username required'}, status=400)

        msg = await client.send_message(entity, text)
        return web.json_response({
            'ok': True,
            'id': msg.id,
            'to': entity_to_chat_id(entity),
        })
    except Exception as e:
        return web.json_response({'error': str(e)}, status=500)


# ── Connect state machine (Контракт 1, connector-driven) ──
# state: collecting (ждём вход от Kelly) | pending (флоу идёт) | connected | error
# step:  дескриптор поля(ей), которые Kelly собирает СЕЙЧАС, либо None
# error: { message, terminal }  — terminal=True → рестарт флоу; False → переспрос шага
auth_code_queue: asyncio.Queue = None   # подаёт code/2FA в идущий флоу
auth_state = 'collecting'
auth_step = None
auth_error = None
_auth_task = None                       # asyncio.Task текущего флоу
_creds = {'api_id': API_ID or None, 'api_hash': API_HASH or None, 'phone': PHONE or None}

STEP_CODE = {'id': 'code', 'fields': [{'key': 'code', 'type': 'code', 'label': 'Код из Telegram'}]}
STEP_2FA = {'id': '2fa', 'fields': [{'key': 'password', 'type': 'secret', 'label': 'Пароль 2FA'}]}


def _auth_descriptor():
    return {'state': auth_state, 'step': auth_step, 'error': auth_error, 'ready': is_ready}


async def handle_auth_status(request):
    """GET /auth/status — дескриптор текущего шага машины (Контракт 1)."""
    return web.json_response(_auth_descriptor())


async def handle_auth_start(request):
    """POST /auth/start — начать/перезапустить connect-флоу с initial-полями
    (api_id/api_hash/phone из connect_schema). Идемпотентно, если уже connected."""
    global _creds, _auth_task, auth_state, auth_error, auth_step
    if is_ready:
        return web.json_response(_auth_descriptor())  # уже подключены — идемпотент
    try:
        data = await request.json()
    except Exception:
        data = {}
    inputs = data.get('inputs', data) or {}
    # Принимаем inputs; недостающее поле берём из env (миграция).
    api_id = inputs.get('api_id') or API_ID
    api_hash = inputs.get('api_hash') or API_HASH
    phone = inputs.get('phone') or PHONE
    if not api_id or not api_hash or not phone:
        return web.json_response({'error': 'api_id, api_hash, phone required'}, status=400)
    _creds = {'api_id': int(api_id), 'api_hash': str(api_hash), 'phone': str(phone)}
    if _auth_task and not _auth_task.done():
        _auth_task.cancel()
    auth_error = None
    auth_step = None
    auth_state = 'pending'
    _auth_task = asyncio.ensure_future(_run_auth_flow())
    return web.json_response(_auth_descriptor())


async def handle_auth_submit(request):
    """POST /auth/submit — generic-сабмит для ТЕКУЩЕГО шага (code | 2FA password).
    Заменяет /auth/code (тот остаётся временным alias на миграцию)."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({'error': 'Invalid JSON'}, status=400)
    inputs = data.get('inputs', data) or {}
    value = inputs.get('code') or inputs.get('password') or data.get('code')
    if not value:
        return web.json_response({'error': 'no input value for current step'}, status=400)
    if auth_state != 'pending' or auth_step is None or auth_code_queue is None:
        return web.json_response({'error': 'not awaiting input', **_auth_descriptor()}, status=400)
    await auth_code_queue.put(str(value))
    return web.json_response({'ok': True, **_auth_descriptor()})


async def handle_auth_code(request):
    """POST /auth/code — DEPRECATED alias of /auth/submit (миграция установленных коннекторов)."""
    return await handle_auth_submit(request)


async def handle_auth_cancel(request):
    """POST /auth/cancel — тёрдаун незавершённой сессии (Контракт 1, V4):
    отменить флоу, отключить клиент, вернуться в 'collecting'."""
    global _auth_task, auth_state, auth_step, auth_error
    if _auth_task and not _auth_task.done():
        _auth_task.cancel()
    if client is not None and not is_ready:
        try:
            await client.disconnect()
        except Exception:
            pass
    auth_state = 'collecting'
    auth_step = None
    auth_error = None
    return web.json_response(_auth_descriptor())


async def _run_auth_flow():
    """Telegram auth-флоу, запускается /auth/start, кормится /auth/submit.
    Двигает auth_state/auth_step/auth_error — их отдаёт /auth/status."""
    global client, is_ready, auth_state, auth_step, auth_error
    try:
        client = TelegramClient(SESSION_FILE, _creds['api_id'], _creds['api_hash'])
        await client.connect()

        if not await client.is_user_authorized():
            await client.send_code_request(_creds['phone'])
            auth_state = 'pending'
            auth_step = STEP_CODE
            auth_error = None
            log.info(f"Code sent to {_creds['phone']}. Waiting via POST /auth/submit ...")

            needs_2fa = False
            while True:
                code = await auth_code_queue.get()
                auth_error = None
                try:
                    await client.sign_in(_creds['phone'], code)
                    break
                except PhoneCodeInvalidError:
                    auth_step = STEP_CODE
                    auth_error = {'message': 'Неверный код. Попробуй ещё раз.', 'terminal': False}
                    log.warning('Wrong Telegram code — asking again')
                except PhoneCodeExpiredError:
                    auth_state = 'error'
                    auth_step = None
                    auth_error = {'message': 'Код истёк. Перезапусти подключение.', 'terminal': True}
                    log.warning('Telegram code expired — terminal')
                    return
                except SessionPasswordNeededError:
                    needs_2fa = True
                    auth_step = STEP_2FA
                    auth_error = None
                    log.info('2FA required. Send password via POST /auth/submit')
                    break
                except Exception as e:
                    auth_state = 'error'
                    auth_step = None
                    auth_error = {'message': str(e), 'terminal': True}
                    log.error(f'Code auth failed: {e}')
                    return

            if needs_2fa:
                while True:
                    password = await auth_code_queue.get()
                    auth_error = None
                    try:
                        await client.sign_in(password=password)
                        break
                    except PasswordHashInvalidError:
                        auth_step = STEP_2FA
                        auth_error = {'message': 'Неверный пароль 2FA. Попробуй ещё раз.', 'terminal': False}
                        log.warning('Wrong 2FA password — asking again')
                    except Exception as e:
                        auth_state = 'error'
                        auth_step = None
                        auth_error = {'message': str(e), 'terminal': True}
                        log.error(f'2FA auth failed: {e}')
                        return

        is_ready = True
        auth_state = 'connected'
        auth_step = None
        auth_error = None
        me = await client.get_me()
        log.info(f'Connected as: {me.first_name} {me.last_name or ""} (@{me.username or "no username"})')
    except asyncio.CancelledError:
        log.info('Auth flow cancelled')
        raise
    except Exception as e:
        auth_state = 'error'
        auth_step = None
        auth_error = {'message': str(e), 'terminal': True}
        log.error(f'Auth failed: {e}')


# ── App setup ──
def create_app():
    app = web.Application(middlewares=[auth_middleware])
    app.router.add_get('/status', handle_status)
    app.router.add_get('/auth/status', handle_auth_status)
    app.router.add_post('/auth/start', handle_auth_start)
    app.router.add_post('/auth/submit', handle_auth_submit)
    app.router.add_post('/auth/cancel', handle_auth_cancel)
    app.router.add_post('/auth/code', handle_auth_code)  # legacy alias → /auth/submit
    app.router.add_get('/contacts', handle_contacts)
    app.router.add_get('/contacts/search', handle_contacts_search)
    app.router.add_get('/chats', handle_chats)
    app.router.add_get('/messages', handle_messages)
    app.router.add_get('/messages/unread', handle_messages_unread)
    app.router.add_post('/messages/send', handle_messages_send)
    app.router.add_get('/messages/{msg_id}/media', handle_message_media)
    return app


async def main():
    global auth_code_queue, auth_state

    auth_code_queue = asyncio.Queue()

    # Start HTTP server first — connect-flow is driven over the API.
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', PORT)
    await site.start()
    log.info(f'Telegram Bridge running on http://127.0.0.1:{PORT}')

    # Signal handling: log SIGTERM for diagnostics; ignore SIGPIPE so a closed
    # Kelly-side pipe doesn't silently kill the bridge mid-run.
    _signal.signal(_signal.SIGTERM, lambda s, f: log.info('Received SIGTERM — shutting down'))
    _signal.signal(_signal.SIGPIPE, _signal.SIG_IGN)

    # Catch unhandled asyncio Task exceptions (e.g. Telethon internal crashes).
    def _exc_handler(loop, context):
        log.error(f'asyncio unhandled: {context.get("message")}: {context.get("exception")!r}')
    asyncio.get_event_loop().set_exception_handler(_exc_handler)

    # Migration fallback: credentials via env (current Kelly install path) →
    # auto-start the flow. New Kelly drives it via POST /auth/start with inputs.
    if API_ID and API_HASH and PHONE:
        log.info('Env credentials present — auto-starting auth (migration path)')
        auth_state = 'pending'
        asyncio.ensure_future(_run_auth_flow())
    else:
        auth_state = 'collecting'
        log.info('Awaiting POST /auth/start with api_id/api_hash/phone')

    log.info(f'Token: {TOKEN}')
    log.info('Endpoints:')
    log.info('  GET  /status              - Connection status')
    log.info('  GET  /auth/status         - Connect state-machine descriptor')
    log.info('  POST /auth/start          - Begin/restart connect flow (inputs)')
    log.info('  POST /auth/submit         - Submit current step (code / 2FA)')
    log.info('  POST /auth/cancel         - Tear down in-progress session')
    log.info('  GET  /contacts            - List contacts')
    log.info('  GET  /chats               - List dialogs')
    log.info('  GET  /messages?chatId=    - Read messages')
    log.info('  POST /messages/send       - Send message')
    log.info('')

    # Keep running
    await asyncio.Event().wait()


if __name__ == '__main__':
    asyncio.run(main())
