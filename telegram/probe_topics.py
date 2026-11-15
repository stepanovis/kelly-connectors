"""Isolated real HTTP bridge for #1285. No Telegram session or external network.

python telegram/probe_topics.py --port 53285
Only TelegramClient is replaced. /_probe returns its captured send calls.
"""
import argparse
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime, timezone
from aiohttp import web
from telethon.tl.types import Channel, ForumTopic
import bridge


def make_topic(identifier, title):
    item = MagicMock(spec=ForumTopic)
    item.id, item.title = identifier, title
    item.top_message = identifier + 100
    item.date = datetime(2026, 11, 15, tzinfo=timezone.utc)
    item.closed = item.hidden = False
    return item


parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, required=True)
args = parser.parse_args()
entity = MagicMock(spec=Channel)
entity.id, entity.forum = 3003, True
network = AsyncMock()
network.is_connected = lambda: True
network.get_entity.return_value = entity
network.send_message.return_value = SimpleNamespace(id=900)
topics = [make_topic(41, 'Профи'), make_topic(57, 'Вжик')]


async def rpc(request):
    selected = [t for t in topics if t.id in request.topics] if hasattr(request, 'topics') else topics
    if getattr(request, 'offset_topic', 0):
        selected = []
    return SimpleNamespace(topics=selected, count=len(topics), order_by_create_date=True, messages=[])


network.side_effect = rpc
bridge.client, bridge.is_ready, bridge._connection_error = network, True, None
bridge.TOKEN = 'synthetic'
app = bridge.create_app()


async def trace(_request):
    return web.json_response({'synthetic_telegram': True, 'sends': [
        {'chatId': 'channel_3003', 'text': call.args[1], **call.kwargs}
        for call in network.send_message.await_args_list]})


app.router.add_get('/_probe', trace)
web.run_app(app, host='127.0.0.1', port=args.port)
