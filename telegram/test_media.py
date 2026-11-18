"""#1293: history metadata and the selected attachment's bytes, with real TL messages."""
import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from telethon import types
from aiohttp.test_utils import TestClient, TestServer

import bridge

NOW = datetime(2026, 11, 18, tzinfo=timezone.utc)
MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def document(name='Доступы.xlsx'):
    return types.Message(id=42, peer_id=types.PeerUser(7), date=NOW, message='caption',
                         media=types.MessageMediaDocument(document=types.Document(
                             id=1, access_hash=2, file_reference=b'', date=NOW,
                             mime_type=MIME, size=12, dc_id=1,
                             attributes=[types.DocumentAttributeFilename(name)])))


def photo():
    return types.Message(id=43, peer_id=types.PeerUser(7), date=NOW, message='',
                         media=types.MessageMediaPhoto(photo=types.Photo(
                             id=1, access_hash=2, file_reference=b'', date=NOW,
                             sizes=[types.PhotoSize(type='x', w=10, h=10, size=8)], dc_id=1)))


def test_history_document_metadata_preserves_caption():
    result = bridge.message_to_dict(document(), 'user_7')
    assert result['attachment'] == {'name': 'Доступы.xlsx', 'mimeType': MIME,
                                    'sizeBytes': 12, 'kind': 'document'}
    assert result['body'] == 'caption'
    assert result['hasMedia'] is True


def test_history_photo_has_a_readable_name_and_type():
    result = bridge.message_to_dict(photo(), 'user_7')
    assert result['attachment'] == {'name': 'photo-43.jpg', 'mimeType': 'image/jpeg',
                                    'sizeBytes': 8, 'kind': 'photo'}


def test_text_and_web_preview_do_not_claim_downloadable_files():
    message = types.Message(id=44, peer_id=types.PeerUser(7), message='text')
    assert bridge.message_to_dict(message, 'user_7').get('attachment') is None
    message.media = types.MessageMediaWebPage(types.WebPageEmpty(id=1))
    assert bridge.message_to_dict(message, 'user_7').get('attachment') is None


def download(monkeypatch, message, data=b'file-content', chat_id='user_7'):
    client = SimpleNamespace(get_entity=AsyncMock(return_value='entity'),
                             get_messages=AsyncMock(return_value=message))
    async def read(_message, file):
        file.write(data)
        return file
    client.download_media = AsyncMock(side_effect=read)
    monkeypatch.setattr(bridge, 'client', client)
    monkeypatch.setattr(bridge, '_ready', lambda: True)
    request = SimpleNamespace(query={'chatId': chat_id}, match_info={'msg_id': '42'})
    return asyncio.run(bridge.handle_message_media(request)), client


def test_download_preserves_unicode_filename_and_document_bytes(monkeypatch):
    result, client = download(monkeypatch, document())
    assert result.status == 200
    assert result.body == b'file-content'
    assert result.content_type == MIME
    assert "filename*=UTF-8''" in result.headers['Content-Disposition']
    assert client.get_messages.call_args.kwargs == {'ids': 42}


@pytest.mark.parametrize('chat_id,peer', [('channel_7', types.PeerChannel(7)),
                                        ('chat_7', types.PeerChat(7)), ('user_7', types.PeerUser(7))])
def test_download_keeps_peer_kind_and_photo_mime(monkeypatch, chat_id, peer):
    result, client = download(monkeypatch, photo(), b'jpeg-data', chat_id)
    assert result.status == 200
    assert result.content_type == 'image/jpeg'
    assert client.get_entity.call_args.args == (peer,)


def test_missing_and_empty_downloads_are_errors(monkeypatch):
    result, _ = download(monkeypatch, None)
    assert result.status == 404
    result, _ = download(monkeypatch, document(), b'')
    assert result.status == 502
    assert 'error' in json.loads(result.body)


def test_history_and_download_http_contract(monkeypatch):
    async def run():
        message = document()
        client = SimpleNamespace(get_entity=AsyncMock(return_value=SimpleNamespace(title='Test channel')))
        client.get_messages = AsyncMock(side_effect=lambda entity, **kwargs: message if 'ids' in kwargs else [message])
        async def read(_message, file):
            file.write(b'spreadsheet-bytes')
        client.download_media = AsyncMock(side_effect=read)
        monkeypatch.setattr(bridge, 'client', client)
        monkeypatch.setattr(bridge, 'TOKEN', 'synthetic-media-token')
        monkeypatch.setattr(bridge, '_ready', lambda: True)
        http = TestClient(TestServer(bridge.create_app()))
        await http.start_server()
        try:
            headers = {'Authorization': 'Bearer synthetic-media-token'}
            denied = await http.get('/messages/42/media?chatId=channel_7')
            assert denied.status == 401
            history = await http.get('/messages?chatId=channel_7', headers=headers)
            payload = await history.json()
            assert payload['messages'][0]['attachment']['name'] == 'Доступы.xlsx'
            result = await http.get('/messages/42/media?chatId=channel_7', headers=headers)
            assert result.status == 200
            assert await result.read() == b'spreadsheet-bytes'
            assert result.content_type == MIME
            assert "filename*=UTF-8''" in result.headers['Content-Disposition']
            assert all(call.args == (types.PeerChannel(7),) for call in client.get_entity.call_args_list)
        finally:
            await http.close()
    asyncio.run(run())
