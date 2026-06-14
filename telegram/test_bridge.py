"""
Конформанс-тесты Telegram-коннектора против Контракта 1 (Kelly↔коннектор).
Группа A (Nina), часть, не зависящая от connect-машины состояний:
  A3 — канон chat_id (round-trip + кросс-эндпоинтная стабильность, флаг F4)
  A5 — стабильный external message-id (N4, стык с журналом @Denis)

Изоляция: telethon-сущности заменены MagicMock(spec=...) — isinstance-ветки
entity_to_chat_id срабатывают, реальная сеть/сессия не нужны.

Запуск: .testenv/bin/pytest telegram/test_bridge.py -v
"""
import json
import os
import sys
from unittest.mock import MagicMock

import pytest
from telethon.tl.types import User, Chat, Channel

sys.path.insert(0, os.path.dirname(__file__))
import bridge  # noqa: E402


# ── A3 — Канон chat_id ─────────────────────────────────────────────────────

@pytest.mark.parametrize("spec,ent_id,expected", [
    (User, 123456, "user_123456"),
    (Chat, 222, "chat_222"),
    (Channel, 999, "channel_999"),
])
def test_a3_2_canon_roundtrip(spec, ent_id, expected):
    """A3.2 [MUST] entity_to_chat_id ∘ parse_chat_id — устойчивый round-trip.
    Корень P0-бага матчинга — закрепляем юнитом для user/chat/channel."""
    ent = MagicMock(spec=spec)
    ent.id = ent_id
    cid = bridge.entity_to_chat_id(ent)
    assert cid == expected
    # round-trip: parse возвращает исходный числовой id
    assert bridge.parse_chat_id(cid) == ent_id


def test_a3_4_cross_endpoint_canon():
    """A3.4 [NEG][F4] Канон стабилен МЕЖДУ эндпоинтами: id одного собеседника,
    который вернут /send (to), /chats (id) и /messages (chatId), — побайтно один.
    Все три деривят из entity_to_chat_id(entity) → проверяем единый источник."""
    ent = MagicMock(spec=User)
    ent.id = 777
    ent.first_name, ent.last_name = "Andrey", ""
    ent.username, ent.phone = "andrey", ""
    ent.bot, ent.contact = False, True

    send_to = bridge.entity_to_chat_id(ent)            # /send → to
    chats_id = bridge.entity_to_dict(ent)["id"]         # /chats → id
    # /messages эхо-прокидывает chatId, которым его дёрнули (это send_to/chats_id)
    msg = _fake_message(sender=ent, msg_id=1)
    messages_chat_id = bridge.message_to_dict(msg, send_to)["chatId"]

    assert send_to == chats_id == messages_chat_id, (
        "send.to / chats.id / messages.chatId разъехались — матчинг сломается"
    )


# ── A5 / N4 — Стабильный external message-id ───────────────────────────────

def _fake_message(sender, msg_id, body="hi", out=False):
    msg = MagicMock()
    msg.sender = sender
    msg.from_id = None
    msg.id = msg_id
    msg.out = out
    msg.text = body
    msg.message = body
    date = MagicMock()
    date.timestamp.return_value = 1781460000.0
    msg.date = date
    msg.media = None
    msg.reply_to = None
    return msg


def test_a5_stable_message_id_present_and_stable():
    """A5/N4 [MUST] message_to_dict отдаёт стабильный external id (= telethon msg.id).
    Журнал @Denis ключует idempotency на нём — id обязан быть стабилен между
    поллингами одного и того же сообщения (capability stable_message_id)."""
    ent = MagicMock(spec=User)
    ent.id = 5
    m1 = _fake_message(sender=ent, msg_id=42)
    m2 = _fake_message(sender=ent, msg_id=42)  # тот же msg при повторном поллинге
    d1 = bridge.message_to_dict(m1, "user_5")
    d2 = bridge.message_to_dict(m2, "user_5")
    assert d1["id"] == 42
    assert d1["id"] == d2["id"], "external message-id нестабилен между поллингами — дедуп журнала сломается"


def test_a5_message_id_distinct_per_message():
    """A5/N4 разные сообщения → разные id (нет коллизии, иначе UNIQUE проглотит второе)."""
    ent = MagicMock(spec=User)
    ent.id = 5
    a = bridge.message_to_dict(_fake_message(ent, 100), "user_5")
    b = bridge.message_to_dict(_fake_message(ent, 101), "user_5")
    assert a["id"] != b["id"]


def test_a4_messages_require_chatid_param():
    """A4.4 [NEG] контракт: /messages без chatId → 400. Проверяем форму ответа хендлера
    через прямой вызов с пустым query (is_ready замокан)."""
    import asyncio
    bridge.is_ready = True
    req = MagicMock()
    req.query = {}  # без chatId
    resp = asyncio.run(bridge.handle_messages(req))
    assert resp.status == 400


# ── A2 — Connect-машина состояний (telethon замокан на границе клиента) ──────

from telethon.errors import (  # noqa: E402
    PhoneCodeInvalidError, PhoneCodeExpiredError,
    SessionPasswordNeededError, PasswordHashInvalidError,
)


class _FakeMe:
    first_name, last_name, username, phone = "Test", "", "user", "+10000000000"


class FakeClient:
    """Мок telethon-клиента: sign_in проигрывает заранее заданную последовательность
    исходов (исключение или успех). Подменяет bridge.TelegramClient."""
    def __init__(self, sign_in_outcomes, authorized=False):
        self._outcomes = list(sign_in_outcomes)
        self._authorized = authorized
        self.disconnected = False

    async def connect(self):
        return None

    async def is_user_authorized(self):
        return self._authorized

    async def send_code_request(self, phone):
        return None

    async def sign_in(self, *a, **k):
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome  # success

    async def get_me(self):
        return _FakeMe()

    async def disconnect(self):
        self.disconnected = True


async def _wait_until(pred, timeout=2.0):
    import asyncio
    elapsed = 0.0
    while not pred():
        await asyncio.sleep(0.01)
        elapsed += 0.01
        if elapsed > timeout:
            raise AssertionError('condition not met in time; state=%r step=%r err=%r' % (
                bridge.auth_state, bridge.auth_step, bridge.auth_error))


def _reset_auth():
    import asyncio
    bridge.auth_code_queue = asyncio.Queue()
    bridge.is_ready = False
    bridge.client = None
    bridge.auth_state = 'collecting'
    bridge.auth_step = None
    bridge.auth_error = None
    bridge._creds = {'api_id': 1, 'api_hash': 'h', 'phone': '+1'}


def test_a2_2_wrong_code_then_right_retryable(monkeypatch):
    """A2.2 [NEG][MUST] Неверный код → шаг остаётся 'code', error.terminal=False (переспрос);
    затем верный код → connected. (Явный кейс из задачи: переспрос, не терминал.)"""
    import asyncio

    async def body():
        _reset_auth()
        monkeypatch.setattr(bridge, 'TelegramClient',
                            lambda *a, **k: FakeClient([PhoneCodeInvalidError(None), None]))
        task = asyncio.ensure_future(bridge._run_auth_flow())
        await _wait_until(lambda: bridge.auth_step and bridge.auth_step['id'] == 'code')
        assert bridge.auth_state == 'pending'
        await bridge.auth_code_queue.put('000')  # неверный
        await _wait_until(lambda: bridge.auth_error is not None)
        assert bridge.auth_step['id'] == 'code'              # переспрос того же шага
        assert bridge.auth_error['terminal'] is False        # retryable
        await bridge.auth_code_queue.put('111')  # верный
        await _wait_until(lambda: bridge.auth_state == 'connected')
        assert bridge.is_ready is True
        task.cancel()

    asyncio.run(body())


def test_a2_5_expired_code_terminal(monkeypatch):
    """A2.5 [NEG] Истёкший код → state='error', terminal=True (рестарт флоу), без зацикливания."""
    import asyncio

    async def body():
        _reset_auth()
        monkeypatch.setattr(bridge, 'TelegramClient',
                            lambda *a, **k: FakeClient([PhoneCodeExpiredError(None)]))
        task = asyncio.ensure_future(bridge._run_auth_flow())
        await _wait_until(lambda: bridge.auth_step and bridge.auth_step['id'] == 'code')
        await bridge.auth_code_queue.put('000')
        await _wait_until(lambda: bridge.auth_state == 'error')
        assert bridge.auth_error['terminal'] is True
        assert bridge.is_ready is False
        task.cancel()

    asyncio.run(body())


def test_a2_4_2fa_branch(monkeypatch):
    """A2.4 [MUST V4-ветвление] code → требуется 2FA → шаг ' 2fa'; верный пароль → connected.
    Машина ветвится по рантайм-ответу коннектора, Kelly про 2FA не знает заранее."""
    import asyncio

    async def body():
        _reset_auth()
        monkeypatch.setattr(bridge, 'TelegramClient',
                            lambda *a, **k: FakeClient([SessionPasswordNeededError(None), None]))
        task = asyncio.ensure_future(bridge._run_auth_flow())
        await _wait_until(lambda: bridge.auth_step and bridge.auth_step['id'] == 'code')
        await bridge.auth_code_queue.put('111')  # код принят, но нужен 2FA
        await _wait_until(lambda: bridge.auth_step and bridge.auth_step['id'] == '2fa')
        assert bridge.auth_step['fields'][0]['type'] == 'secret'
        await bridge.auth_code_queue.put('pass')  # верный пароль
        await _wait_until(lambda: bridge.auth_state == 'connected')
        task.cancel()

    asyncio.run(body())


def test_auth_cancel_resets_to_collecting(monkeypatch):
    """V4: /auth/cancel отменяет идущий флоу, отключает клиент, возвращает 'collecting'."""
    import asyncio

    async def body():
        _reset_auth()
        fake = FakeClient([None])
        monkeypatch.setattr(bridge, 'TelegramClient', lambda *a, **k: fake)
        task = asyncio.ensure_future(bridge._run_auth_flow())
        await _wait_until(lambda: bridge.auth_step and bridge.auth_step['id'] == 'code')
        bridge.client = fake
        bridge._auth_task = task
        resp = await bridge.handle_auth_cancel(MagicMock())
        assert bridge.auth_state == 'collecting'
        assert bridge.auth_step is None
        assert fake.disconnected is True

    asyncio.run(body())


def test_auth_submit_outside_step_rejected():
    """A2 [NEG] /auth/submit вне ожидания шага (state!=pending) → 400, не роняет машину."""
    import asyncio

    async def body():
        _reset_auth()
        bridge.auth_state = 'collecting'
        bridge.auth_step = None
        req = MagicMock()

        async def _json():
            return {'inputs': {'code': '123'}}
        req.json = _json
        resp = await bridge.handle_auth_submit(req)
        assert resp.status == 400

    asyncio.run(body())


def test_auth_start_missing_creds_rejected():
    """A2 [NEG] /auth/start без api_id/api_hash/phone (и без env) → 400."""
    import asyncio

    async def body():
        _reset_auth()
        bridge.is_ready = False
        # подменим env-значения модуля на пустые
        orig = (bridge.API_ID, bridge.API_HASH, bridge.PHONE)
        bridge.API_ID, bridge.API_HASH, bridge.PHONE = 0, '', ''
        try:
            req = MagicMock()

            async def _json():
                return {'inputs': {}}
            req.json = _json
            resp = await bridge.handle_auth_start(req)
            assert resp.status == 400
        finally:
            bridge.API_ID, bridge.API_HASH, bridge.PHONE = orig

    asyncio.run(body())


def test_auth_status_descriptor_shape():
    """GET /auth/status отдаёт дескриптор контракта: state/step/error/ready."""
    import asyncio

    async def body():
        _reset_auth()
        resp = await bridge.handle_auth_status(MagicMock())
        body_json = json.loads(resp.text)
        assert set(body_json.keys()) == {'state', 'step', 'error', 'ready'}
        assert body_json['state'] == 'collecting'

    asyncio.run(body())
