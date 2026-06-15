'use strict';

/**
 * Канонизация WhatsApp chat-id для 1:1 (lid ↔ c.us) — корень P0 #270.
 *
 * Матч await_reply в Kelly БУКВАЛЬНЫЙ (sub.chat_id === входящий chat.id). WhatsApp после
 * LID-миграции отдаёт для ОДНОГО контакта разные id: send.to = <num>@c.us, а входящее/
 * chat.id = <lid>@lid → буквальное сравнение промахивается, ответ теряется. Чиним в
 * коннекторе (нарушение контракта F4: один стабильный канон на всех концах), приводя ВСЁ
 * к канону <pn>@c.us — тому же формату, что подписки уже хранят (→ миграции не нужно,
 * застрявшие матчатся ретроактивно).
 *
 * Модуль ЧИСТЫЙ: без whatsapp-web.js. Вся wweb-специфика (getContactLidAndPhone) — в
 * index.js, сюда прилетает уже резолвленный pn. Тестируется `node --test` без живой сессии
 * (паттерн whatsapp/auth_descriptor.js). Scope — 1:1; группы (@g.us) не канонизируем
 * (LID бьёт participant внутри группы, а await_reply матчится на сам чат @g.us).
 */

const CUS_SERVER = 'c.us';
const LID_SERVER = 'lid';

/** Только цифры телефона (как в /send: phone.replace(/[^0-9]/g,'')). */
function digits(value) {
  return String(value == null ? '' : value).replace(/[^0-9]/g, '');
}

/** '<user>@<server>' → { user, server }. Без '@' → server ''. */
function parseId(serialized) {
  const s = String(serialized == null ? '' : serialized);
  const at = s.lastIndexOf('@');
  if (at < 0) return { user: s, server: '' };
  return { user: s.slice(0, at), server: s.slice(at + 1) };
}

/** Телефон (в любом виде) → канон <pn>@c.us; пусто/без цифр → null. */
function canonicalFromPn(pn) {
  const d = digits(pn);
  return d ? `${d}@${CUS_SERVER}` : null;
}

/**
 * Двусторонний кэш на процесс коннектора:
 *  • lid→pn   — чтобы канонизировать входящие @lid в <pn>@c.us;
 *  • канон→реальный serialized — ОБРАТНЫЙ резолв для getChatById: НЕ полагаемся на то, что
 *    wweb сам резолвит getChatById(<pn>@c.us) для @lid-контакта (неизвестно), а держим
 *    реальный id (@lid|@c.us), который wweb точно знает.
 * Заполняется на /chats (и /messages/unread); используется на /messages и /send.
 */
function createLidCache() {
  const lidToPn = new Map();     // '<lid>@lid' и '<lid>' → pn (digits)
  const canonToReal = new Map(); // '<pn>@c.us' → реальный serialized (@lid|@c.us)
  return {
    /** Запомнить соответствие из /chats: реальный serialized + его телефон. */
    remember(realSerialized, pn) {
      const d = digits(pn);
      if (!d) return;
      const { user, server } = parseId(realSerialized);
      if (server === LID_SERVER) {
        lidToPn.set(realSerialized, d);
        lidToPn.set(user, d);
      }
      canonToReal.set(`${d}@${CUS_SERVER}`, realSerialized);
    },
    /** pn для @lid-id (по полному serialized или по user-части), либо null. */
    pnForLid(serialized) {
      const { user } = parseId(serialized);
      return lidToPn.get(serialized) || lidToPn.get(user) || null;
    },
    /** Канон <pn>@c.us → реальный serialized для getChatById; неизвестен → сам канон. */
    realFor(canonical) {
      return canonToReal.get(canonical) || canonical;
    },
  };
}

/**
 * Канонический chat-id (1:1):
 *  • @c.us  → нормализованный <pn>@c.us (user уже телефон);
 *  • @lid   → <pn>@c.us, если pn есть в кэше; иначе null (index.js дорезолвит через
 *             getContactLidAndPhone и положит в кэш);
 *  • прочее (@g.us и т.п.) → как есть (вне scope 1:1).
 */
function toCanonical(serialized, cache) {
  const { user, server } = parseId(serialized);
  if (server === CUS_SERVER) return canonicalFromPn(user);
  if (server === LID_SERVER) {
    const pn = cache ? cache.pnForLid(serialized) : null;
    return pn ? canonicalFromPn(pn) : null;
  }
  return serialized;
}

module.exports = {
  CUS_SERVER,
  LID_SERVER,
  digits,
  parseId,
  canonicalFromPn,
  createLidCache,
  toCanonical,
};
