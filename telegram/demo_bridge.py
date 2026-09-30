"""Local #1127 demo: real HTTP/auth handlers, synthetic Telethon client only.

Run with the existing connector Python. No account config/session is opened.
This file is deliberately excluded from telegram.zip.
"""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace
from aiohttp import web
from telethon.errors import ChatAdminRequiredError
from telethon.tl.types import User, Chat, Channel, Message, PeerUser
import bridge

mode = 'offline'
sent = []
peers = {
    1001: User(id=1001, first_name='Демонстрационный контакт'),
    2002: Chat(id=2002, title='Тестовая группа', photo=None, participants_count=1, date=datetime.now(timezone.utc), version=1),
    3003: Channel(id=3003, title='Тестовый канал', photo=None, date=datetime.now(timezone.utc), broadcast=True),
}


class DemoClient:
    def __init__(self, *args):
        self.connected = False

    def is_connected(self):
        return self.connected and mode != 'offline'

    async def connect(self):
        await asyncio.sleep(0.6)
        if mode == 'offline':
            raise ConnectionError('Тестовая сеть недоступна. Восстановите сеть и повторите подключение.')
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def is_user_authorized(self):
        return True

    async def get_me(self):
        return peers[1001]

    async def send_code_request(self, phone):
        raise AssertionError('Demo session is already authorized')

    async def get_dialogs(self, limit):
        if not self.is_connected():
            raise ConnectionError('Тестовая сеть недоступна')
        return []

    async def get_entity(self, peer):
        if mode == 'chat-error':
            raise ChatAdminRequiredError(None)
        return peers[peer] if isinstance(peer, int) else peers[1001]

    async def get_messages(self, entity, limit):
        return [Message(id=41, peer_id=PeerUser(1001), date=datetime.now(timezone.utc), message='Тестовое сообщение. Реальная переписка не используется.', out=False)]

    async def send_message(self, entity, text):
        sent.append({'to': bridge.entity_to_chat_id(entity), 'text': text, 'id': 42 + len(sent)})
        return SimpleNamespace(id=sent[-1]['id'])


async def control(request):
    global mode
    value = (await request.json()).get('mode')
    if value not in ('online', 'offline', 'chat-error'):
        return web.json_response({'error': 'invalid fixture mode'}, status=400)
    mode = value
    return web.json_response({'mode': mode, 'sent': sent, 'synthetic': True})


async def startup(app):
    bridge.TelegramClient = DemoClient
    bridge._creds = {'api_id': 1, 'api_hash': 'synthetic', 'phone': '+10000000000'}
    bridge.TOKEN = 'synthetic-1127'
    bridge.auth_code_queue = asyncio.Queue()
    await bridge._run_auth_flow()


app = bridge.create_app()
app.router.add_post('/demo/control', control)
app.on_startup.append(startup)
web.run_app(app, host='127.0.0.1', port=53327)
