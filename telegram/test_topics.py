"""Public bridge HTTP contract; the Telegram network alone is synthetic."""
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from aiohttp.test_utils import TestClient, TestServer
from telethon.tl.types import Channel, ForumTopic, ForumTopicDeleted, User
import bridge


def topic(identifier, title):
    item = MagicMock(spec=ForumTopic)
    item.id, item.title = identifier, title
    item.top_message = identifier + 100
    item.date = datetime(2026, 11, 15, tzinfo=timezone.utc)
    item.closed = item.hidden = False
    return item


class TopicsHttpTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        bridge.TOKEN = 'topics-test-only'
        bridge.is_ready = True
        bridge._connection_error = None
        self.entity = MagicMock(spec=Channel)
        self.entity.id, self.entity.forum = 3003, True
        self.network = AsyncMock()
        self.network.is_connected = lambda: True
        self.network.get_entity.return_value = self.entity
        self.network.send_message.return_value = SimpleNamespace(id=900)
        self.network.return_value = SimpleNamespace(
            topics=[topic(41, 'Профи'), topic(57, 'Вжик')], count=2,
            messages=[SimpleNamespace(id=157, date=datetime(2026, 11, 15, tzinfo=timezone.utc))],
            order_by_create_date=False)
        bridge.client = self.network
        self.client = TestClient(TestServer(bridge.create_app()))
        await self.client.start_server()
        self.headers = {'Authorization': 'Bearer topics-test-only'}

    async def asyncTearDown(self):
        await self.client.close()

    async def send(self, **extra):
        return await self.client.post('/messages/send', headers=self.headers,
            json={'chatId': 'channel_3003', 'text': 'Проверка темы', **extra})

    async def test_send_to_selected_topic(self):
        response = await self.send(topic_id=41)
        self.assertEqual(response.status, 200, await response.text())
        self.network.send_message.assert_awaited_once_with(self.entity, 'Проверка темы', reply_to=41)
        self.assertEqual((await response.json())['topic_id'], 41)

    async def test_send_without_topic_is_unchanged(self):
        response = await self.send()
        self.assertEqual(response.status, 200)
        self.network.send_message.assert_awaited_once_with(self.entity, 'Проверка темы')
        self.assertNotIn('topic_id', await response.json())

    async def test_general_topic_has_no_reply_to_message_one(self):
        self.network.return_value.topics = [topic(1, 'Общая')]
        response = await self.send(topic_id=1)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['topic_id'], 1)
        self.network.send_message.assert_awaited_once_with(self.entity, 'Проверка темы')

    async def test_create_date_pagination_and_deleted_topic(self):
        self.network.return_value.order_by_create_date = True
        self.network.return_value.topics.append(ForumTopicDeleted(id=99))
        self.network.return_value.messages = []
        response = await self.client.get('/topics?chatId=channel_3003', headers=self.headers)
        result = await response.json()
        self.assertEqual(len(result['topics']), 2)
        self.assertEqual(result['next_offset']['offset_date'], 1794700800)
        self.network.get_messages.assert_not_awaited()

    async def test_older_telethon_uses_channel_constructor(self):
        factory = MagicMock()
        with patch.object(bridge.functions.messages, 'GetForumTopicsRequest', None), \
             patch.object(bridge.functions.channels, 'GetForumTopicsRequest', factory, create=True):
            response = await self.client.get('/topics?chatId=channel_3003', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertIs(factory.call_args.kwargs['channel'], self.entity)
        self.assertNotIn('peer', factory.call_args.kwargs)

    async def test_invalid_topic_never_sends(self):
        for bad in [0, -1, True, '41', 1.5, None, 2147483648]:
            with self.subTest(topic_id=bad):
                self.assertEqual((await self.send(topic_id=bad)).status, 400)
        self.network.send_message.assert_not_awaited()

    async def test_unknown_topic_and_nonforum_never_send(self):
        self.network.return_value.topics = [ForumTopicDeleted(id=41)]
        self.assertEqual((await self.send(topic_id=41)).status, 404)
        self.network.get_entity.return_value = User(id=123)
        self.assertEqual((await self.send(topic_id=41)).status, 400)
        self.network.send_message.assert_not_awaited()

    async def test_topics_names_ids_and_pagination(self):
        response = await self.client.get('/topics?chatId=channel_3003&limit=2&q=и', headers=self.headers)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        self.assertEqual([(t['topic_id'], t['name']) for t in result['topics']], [(41, 'Профи'), (57, 'Вжик')])
        self.assertEqual(result['count'], 2)
        request = self.network.await_args.args[0]
        self.assertEqual((request.q, request.limit, request.offset_topic), ('и', 2, 0))
        next_offset = result['next_offset']
        self.assertEqual(next_offset, {'offset_date': 1794700800, 'offset_id': 157, 'offset_topic': 57})
        self.network.return_value.topics = []
        response = await self.client.get('/topics', params={'chatId': 'channel_3003', **next_offset}, headers=self.headers)
        self.assertEqual((await response.json())['next_offset'], None)
        request = self.network.await_args.args[0]
        self.assertEqual((request.offset_id, request.offset_topic), (157, 57))

    async def test_topics_errors_and_empty_results(self):
        self.assertEqual((await self.client.get('/topics?chatId=channel_3003')).status, 401)
        self.assertEqual((await self.client.get('/topics', headers=self.headers)).status, 400)
        self.assertEqual((await self.client.get('/topics?chatId=channel_3003&limit=bad', headers=self.headers)).status, 400)
        self.network.return_value.topics = []
        self.network.return_value.count = 0
        response = await self.client.get('/topics?chatId=channel_3003', headers=self.headers)
        self.assertEqual((await response.json())['topics'], [])
        self.network.side_effect = RuntimeError('Telegram unavailable')
        self.assertEqual((await self.client.get('/topics?chatId=channel_3003', headers=self.headers)).status, 502)
        bridge.is_ready = False
        self.assertEqual((await self.client.get('/topics?chatId=channel_3003', headers=self.headers)).status, 503)
