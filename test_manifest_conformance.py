"""
Конформанс манифеста (connector.json) против Контракта 1 — для ВСЕХ коннекторов.
Группа A5 (Nina): валидность, обязательные поля, capabilities↔реализация.

Прогоняется по каждому коннектору в репо (telegram, whatsapp) — единый контракт,
без знания про конкретный мессенджер: новый коннектор автоматически попадает под те же
проверки, как только в его папке появляется connector.json.

Запуск: .testenv/bin/pytest test_manifest_conformance.py -v
"""
import json
import os
import re

import pytest

REPO = os.path.dirname(__file__)
REQUIRED = ["name", "bridge_id", "type", "version", "contract_version",
            "runtime", "entry", "port", "label", "capabilities"]
KNOWN_CAPS = {"send", "read", "contacts", "stable_message_id", "media", "search"}
CONTRACT_VERSION = "1.0"  # текущая версия контракта Kelly↔коннектор

# Capability → паттерн-маркер реализации в entry-файле (эндпоинт/обработчик).
# Намеренно по исходнику коннектора: «объявил capability → есть реализация» (A5.2).
CAP_MARKERS = {
    "send": [r"/messages/send", r"/send"],
    "read": [r"/messages", r"/chats"],
    "contacts": [r"/contacts"],
    "stable_message_id": [r"\bid\b"],  # message-id в форме ответа /messages
}


def _connectors():
    out = []
    for name in sorted(os.listdir(REPO)):
        cj = os.path.join(REPO, name, "connector.json")
        if os.path.isfile(cj):
            out.append((name, cj))
    return out


CONNECTORS = _connectors()


def test_there_are_connectors():
    assert CONNECTORS, "не найдено ни одного connector.json"


@pytest.mark.parametrize("name,path", CONNECTORS, ids=[c[0] for c in CONNECTORS])
def test_a5_1_manifest_valid_and_required_fields(name, path):
    """A5.1 connector.json — валидный JSON со всеми обязательными полями Контракта 1."""
    with open(path) as f:
        m = json.load(f)
    missing = [k for k in REQUIRED if k not in m]
    assert not missing, f"{name}: отсутствуют обязательные поля манифеста: {missing}"
    assert m["type"] == "messenger", f"{name}: type должен быть 'messenger'"
    assert m["bridge_id"] == m["name"], (
        f"{name}: bridge_id обязан совпадать с именем коннектора (ключ матчинга Felix)"
    )
    assert m["contract_version"] == CONTRACT_VERSION, (
        f"{name}: contract_version={m['contract_version']} != поддерживаемой {CONTRACT_VERSION}"
    )


@pytest.mark.parametrize("name,path", CONNECTORS, ids=[c[0] for c in CONNECTORS])
def test_a5_2_capabilities_known_and_realized(name, path):
    """A5.2 [NEG] каждая объявленная capability известна контракту И имеет реализацию
    в entry-файле коннектора. Объявил, но не реализовал → контракт врёт → падаем."""
    with open(path) as f:
        m = json.load(f)
    caps = m.get("capabilities", [])
    assert caps, f"{name}: пустой capabilities"
    unknown = [c for c in caps if c not in KNOWN_CAPS]
    assert not unknown, f"{name}: неизвестные контракту capabilities: {unknown}"

    entry_src = ""
    entry_path = os.path.join(REPO, name, m["entry"])
    if os.path.isfile(entry_path):
        with open(entry_path) as f:
            entry_src = f.read()
    for cap in caps:
        markers = CAP_MARKERS.get(cap)
        if not markers:
            continue
        assert any(re.search(p, entry_src) for p in markers), (
            f"{name}: capability '{cap}' объявлена, но реализация ({markers}) не найдена в {m['entry']}"
        )


@pytest.mark.parametrize("name,path", CONNECTORS, ids=[c[0] for c in CONNECTORS])
def test_n4_stable_message_id_declared(name, path):
    """N4 (стык @Denis): мессенджер-коннектор с поддержкой await_reply ОБЯЗАН объявить
    stable_message_id. Нет capability → Kelly fail-closed откажет в await_reply на входе.
    Оба наших коннектора стабильны (TG msg.id / WA _serialized) → объявлено."""
    with open(path) as f:
        m = json.load(f)
    assert "stable_message_id" in m.get("capabilities", []), (
        f"{name}: без stable_message_id Kelly не пустит await_reply (fail-closed)"
    )
