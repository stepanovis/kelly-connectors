"""#1127: HTTP readiness/retry contracts; no real account, client or session."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer
from telethon.errors import ChatAdminRequiredError
from telethon.tl.types import User
import bridge


class Client:
    def __init__(self, *args):
        self.connected = True
        self.failure = None
        self.code_requests = 0
        self.disconnects = 0

    def is_connected(self):
        return self.connected

    async def connect(self):
        if self.failure:
            raise self.failure
        self.connected = True

    async def disconnect(self):
        self.connected = False
        self.disconnects += 1

    async def is_user_authorized(self):
        return True

    async def get_me(self):
        return User(id=1001, first_name='Synthetic')

    async def send_code_request(self, phone):
        self.code_requests += 1
        raise AssertionError('Saved authorized session must not request a code')

    async def get_dialogs(self, limit):
        if self.failure:
            raise self.failure
        return []

    async def get_entity(self, peer):
        if self.failure:
            raise self.failure
        return User(id=1001, first_name='Synthetic')

    async def get_messages(self, peer, limit):
        return []

    async def send_message(self, peer, text):
        return SimpleNamespace(id=42)


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake = Client()
        bridge.client = self.fake
        bridge.is_ready = True
        bridge.auth_state = 'connected'
        bridge.auth_step = bridge.auth_error = bridge._auth_task = None
        bridge._connection_error = None
        bridge.TOKEN = 'synthetic-token'
        bridge._creds = {'api_id': 1, 'api_hash': 'synthetic', 'phone': '+10000000000'}
        self.http = TestClient(TestServer(bridge.create_app()))
        await self.http.start_server()
        self.headers = {'Authorization': 'Bearer synthetic-token'}

    async def asyncTearDown(self):
        if bridge._auth_task and not bridge._auth_task.done():
            bridge._auth_task.cancel()
            await asyncio.gather(bridge._auth_task, return_exceptions=True)
        await self.http.close()

    async def get_json(self, path):
        res = await self.http.get(path, headers=self.headers)
        return res.status, await res.json()

    async def test_transport_loss_and_recovery_agree_in_status_and_auth(self):
        self.fake.connected = False
        _, status = await self.get_json('/status')
        _, auth = await self.get_json('/auth/status')
        self.assertFalse(status['ready'])
        self.assertEqual(auth['state'], 'error')
        self.assertTrue(auth['error']['terminal'])
        self.fake.connected = True
        _, status = await self.get_json('/status')
        _, auth = await self.get_json('/auth/status')
        self.assertTrue(status['ready'])
        self.assertEqual(auth['state'], 'connected')
        self.assertIsNone(auth['error'])
        self.assertEqual(self.fake.disconnects, 0)

    async def test_transport_exception_is_visible_until_successful_probe(self):
        self.fake.failure = ConnectionError('synthetic network failure')
        _, status = await self.get_json('/status')
        _, auth = await self.get_json('/auth/status')
        self.assertFalse(status['ready'])
        self.assertIn('synthetic network failure', auth['error']['message'])
        self.fake.failure = None
        _, auth = await self.get_json('/auth/status')
        self.assertTrue(auth['ready'])
        self.assertIsNone(auth['error'])

    async def test_chat_rpc_failure_keeps_authorization_and_preserves_error(self):
        self.fake.failure = ChatAdminRequiredError(None)
        code, data = await self.get_json('/messages?chatId=channel_3003')
        self.assertEqual(code, 500)
        self.assertIn('admin', data['error'].lower())
        _, status = await self.get_json('/status')
        _, auth = await self.get_json('/auth/status')
        self.assertTrue(status['ready'])
        self.assertTrue(auth['ready'])
        self.assertEqual(self.fake.disconnects, 0)

    async def test_explicit_retry_releases_old_client_and_reuses_session(self):
        self.fake.connected = False
        replacement = Client()
        with patch.object(bridge, 'TelegramClient', return_value=replacement) as factory:
            response = await self.http.post('/auth/start', json={'inputs': bridge._creds})
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())['state'], 'pending')
            await bridge._auth_task
            self.assertEqual(factory.call_args.args[0], bridge.SESSION_FILE)
        _, auth = await self.get_json('/auth/status')
        self.assertTrue(auth['ready'])
        self.assertEqual(self.fake.disconnects, 1)
        self.assertEqual(replacement.code_requests, 0)

    async def test_initial_failure_then_explicit_retry_without_code(self):
        bridge.is_ready = False
        bridge.auth_state = 'collecting'
        first, second = Client(), Client()
        first.failure = ConnectionError('synthetic initial failure')
        with patch.object(bridge, 'TelegramClient', side_effect=[first, second]) as factory:
            await self.http.post('/auth/start', json={'inputs': bridge._creds})
            await bridge._auth_task
            _, auth = await self.get_json('/auth/status')
            self.assertEqual(auth['state'], 'error')
            self.assertFalse(auth['ready'])
            for _ in range(3):
                await self.get_json('/auth/status')
            self.assertEqual(factory.call_count, 1)
            await self.http.post('/auth/start', json={'inputs': bridge._creds})
            await bridge._auth_task
        _, auth = await self.get_json('/auth/status')
        self.assertTrue(auth['ready'])
        self.assertEqual(first.disconnects, 1)
        self.assertEqual(second.code_requests, 0)


if __name__ == '__main__':
    unittest.main()
