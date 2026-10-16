"""Real HTTP routes; only the Telegram network client is synthetic."""
import asyncio
import base64
import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from aiohttp.test_utils import TestClient, TestServer
from telethon.tl.types import User
import bridge


class AvatarHttpTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        bridge.TOKEN = 'avatar-test-only'
        bridge.is_ready = True
        bridge._connection_error = None
        bridge.client = SimpleNamespace(
            is_connected=lambda: True,
            get_me=AsyncMock(return_value=User(id=42, first_name='Owner', username='test')),
            get_entity=AsyncMock(return_value=User(id=20, first_name='Contact', bot=False)),
            send_message=AsyncMock(return_value=SimpleNamespace(id=123)),
            send_file=AsyncMock(return_value=SimpleNamespace(id=124)),
        )
        self.client = TestClient(TestServer(bridge.create_app()))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer avatar-test-only'}

    async def asyncTearDown(self):
        await self.client.close()

    async def test_identity_and_text_receipt(self):
        denied = await self.client.get('/identity')
        self.assertEqual(denied.status, 401)
        identity = await self.client.get('/identity', headers=self.headers)
        self.assertEqual((await identity.json())['id'], 42)
        receipt = await self.client.post('/avatar/send', headers=self.headers,
            json={'account_id': 42, 'chat_id': 20, 'text': 'Approved reply'})
        self.assertEqual(receipt.status, 200)
        self.assertEqual(await receipt.json(), {'message_id': 123})
        self.assertEqual(bridge.client.send_message.await_args.args[1], 'Approved reply')

    async def test_changed_account_prevents_send(self):
        response = await self.client.post('/avatar/send', headers=self.headers,
            json={'account_id': 99, 'chat_id': 20, 'text': 'Must not send'})
        self.assertEqual(response.status, 409)
        bridge.client.send_message.assert_not_awaited()

    async def test_file_receipt_and_bot_refusal(self):
        response = await self.client.post('/avatar/send', headers=self.headers,
            json={'account_id': 42, 'chat_id': 20, 'filename': '../quote.txt',
                  'bytes': base64.b64encode(b'Quote').decode(), 'caption': 'Approved'})
        self.assertEqual(response.status, 200)
        file = bridge.client.send_file.await_args.args[1]
        self.assertEqual(file.name, 'quote.txt')
        self.assertEqual(file.getvalue(), b'Quote')
        bridge.client.get_entity.return_value = User(id=20, bot=True)
        denied = await self.client.post('/avatar/send', headers=self.headers,
            json={'account_id': 42, 'chat_id': 20, 'text': 'Must not send'})
        self.assertEqual(denied.status, 400)
        bridge.client.send_message.assert_not_awaited()

    async def test_history_pages_and_contact_username(self):
        contact = User(id=20, first_name='Client', username='ClientName')
        bridge.client.get_entity.return_value = contact
        bridge.client.get_dialogs = AsyncMock(return_value=[SimpleNamespace(
            entity=contact, name='Client', message=None, is_group=False, is_channel=False, unread_count=0)])
        chats = await self.client.get('/chats', headers=self.headers)
        self.assertEqual((await chats.json())[0]['username'], 'ClientName')
        messages = [SimpleNamespace(id=i, sender=contact, out=i==1, text='Manual' if i==1 else 'Client',
            message='', date=datetime.now(timezone.utc), media=None, reply_to=None) for i in range(1,102)]
        async def get_messages(entity, limit, max_id=0):
            return list(reversed([m for m in messages if not max_id or m.id < max_id][-limit:]))
        bridge.client.get_messages = AsyncMock(side_effect=get_messages)
        page = await self.client.get('/messages?chatId=user_20&limit=100', headers=self.headers)
        self.assertEqual((await page.json())['messages'][0]['id'], 2)
        earlier = await self.client.get('/messages?chatId=user_20&limit=100&beforeId=2', headers=self.headers)
        history = (await earlier.json())['messages']
        self.assertEqual(len(history), 1)
        self.assertTrue(history[0]['fromMe'])
        self.assertEqual(bridge.client.get_messages.await_args.kwargs['max_id'], 2)

if __name__ == '__main__':
    unittest.main()
