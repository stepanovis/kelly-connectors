"""Exercise candidate Telethon bridge HTTP handlers with synthetic peers only.

No production credentials/session opened; no real Telegram client is constructed.
--negative-control breaks the send payload in memory and must exit nonzero.
"""
import asyncio
import hashlib
import json
import logging
from pathlib import Path
import sys
import types
from datetime import datetime, timezone

from aiohttp.test_utils import TestClient, TestServer
from telethon.tl.types import User, Chat, Channel, Message, PeerUser

BRIDGE = Path(__file__).with_name('bridge.py')
source = BRIDGE.read_text()
print('candidate_bridge_sha256=' + hashlib.sha256(BRIDGE.read_bytes()).hexdigest())
if '--negative-control' in sys.argv:
    old = 'await client.send_message(entity, text)'
    assert source.count(old) == 1
    source = source.replace(old, "await client.send_message(entity, '')")
bridge = types.ModuleType('isolated_telegram_bridge')
exec(compile(source, str(BRIDGE), 'exec'), bridge.__dict__)
bridge.log.setLevel(logging.CRITICAL)
logging.getLogger('aiohttp.access').setLevel(logging.CRITICAL)
bridge.TOKEN = 'synthetic-token'
peers = {
    1001: User(id=1001, first_name='Synthetic user'),
    2002: Chat(id=2002, title='Synthetic group', photo=None, participants_count=1,
               date=datetime.now(timezone.utc), version=1),
    3003: Channel(id=3003, title='Synthetic channel', photo=None,
                  date=datetime.now(timezone.utc), broadcast=True),
}


class FakeClient:
    fail_connect = False
    fail_rpc = False
    attempts = 0
    sent = []

    def __init__(self, *args):
        pass

    def is_connected(self):
        return True

    async def connect(self):
        FakeClient.attempts += 1
        if self.fail_connect:
            raise ConnectionError('synthetic connect failure')

    async def is_user_authorized(self):
        return True

    async def get_me(self):
        return peers[1001]

    async def send_code_request(self, phone):
        raise AssertionError('Authorized fake session must not request a code')

    async def get_entity(self, peer):
        if self.fail_rpc:
            raise ConnectionError('synthetic disconnected client')
        return peers[peer] if isinstance(peer, int) else peers[1001]

    async def get_messages(self, entity, limit):
        return [Message(id=41, peer_id=PeerUser(1001), date=datetime.now(timezone.utc),
                        message='synthetic-read', out=False)]

    async def send_message(self, entity, text):
        self.sent.append((entity.id, text))
        return types.SimpleNamespace(id=42)

    async def get_dialogs(self, limit):
        if self.fail_rpc:
            raise ConnectionError('synthetic disconnected client')
        return []


async def run():
    bridge.TelegramClient = FakeClient
    bridge.client = FakeClient()
    bridge.is_ready = True
    bridge.auth_state = 'connected'
    client = TestClient(TestServer(bridge.create_app()))
    await client.start_server()
    headers = {'Authorization': 'Bearer synthetic-token'}
    checks = 0
    try:
        for chat_id, peer in [('user_1001', 1001), ('chat_2002', 2002), ('channel_3003', 3003)]:
            res = await client.get('/messages', params={'chatId': chat_id, 'limit': '1'}, headers=headers)
            data = await res.json()
            assert res.status == 200 and data['messages'][0]['body'] == 'synthetic-read'
            assert data['messages'][0]['chatId'] == chat_id
            checks += 1
            res = await client.post('/messages/send', json={'chatId': chat_id, 'text': 'synthetic-send'}, headers=headers)
            data = await res.json()
            assert res.status == 200 and data == {'ok': True, 'id': 42, 'to': chat_id}
            assert FakeClient.sent[-1] == (peer, 'synthetic-send'), 'SEND_PAYLOAD_BROKEN'
            checks += 1
        for target in [{'phone': '+10000000000'}, {'username': 'synthetic_user'}]:
            res = await client.post('/messages/send', json={**target, 'text': 'synthetic-send'}, headers=headers)
            assert res.status == 200 and (await res.json())['to'] == 'user_1001'
            checks += 1
        before = len(FakeClient.sent)
        for payload, status in [({'chatId': 'user_1001'}, 400), ({'text': 'synthetic-send'}, 400)]:
            res = await client.post('/messages/send', json=payload, headers=headers)
            assert res.status == status
            checks += 1
        res = await client.post('/messages/send', json={'chatId': 'user_1001', 'text': 'synthetic-send'})
        assert res.status == 401
        checks += 1
        bridge.is_ready = False
        res = await client.post('/messages/send', json={'chatId': 'user_1001', 'text': 'synthetic-send'}, headers=headers)
        assert res.status == 503 and len(FakeClient.sent) == before
        checks += 1
        print(f'HTTP read/send contracts: PASS {checks}/12 (synthetic Telethon client)')

    finally:
        await client.close()


asyncio.run(run())
