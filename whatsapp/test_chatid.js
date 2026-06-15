'use strict';

// Юниты канонизации chat-id (P0 #270). Чистые, без живой WA-сессии (паттерн
// test_auth_descriptor.js): node --test test_chatid.js

const test = require('node:test');
const assert = require('node:assert');
const { digits, parseId, canonicalFromPn, createLidCache, toCanonical } = require('./chatid');

test('digits — оставляет только цифры (как /send)', () => {
  assert.strictEqual(digits('+7 (999) 123-45-67'), '79991234567');
  assert.strictEqual(digits(''), '');
  assert.strictEqual(digits(null), '');
});

test('parseId — user/server по последнему @', () => {
  assert.deepStrictEqual(parseId('79991234567@c.us'), { user: '79991234567', server: 'c.us' });
  assert.deepStrictEqual(parseId('111222333@lid'), { user: '111222333', server: 'lid' });
  assert.deepStrictEqual(parseId('123-456@g.us'), { user: '123-456', server: 'g.us' });
  assert.deepStrictEqual(parseId('plainnoat'), { user: 'plainnoat', server: '' });
});

test('canonicalFromPn — <pn>@c.us, мусор → null', () => {
  assert.strictEqual(canonicalFromPn('7999 123 45 67'), '79991234567@c.us');
  assert.strictEqual(canonicalFromPn(''), null);
  assert.strictEqual(canonicalFromPn('+++'), null);
});

test('toCanonical — @c.us уже канон (нормализуется)', () => {
  assert.strictEqual(toCanonical('79991234567@c.us', null), '79991234567@c.us');
});

test('toCanonical — @lid БЕЗ кэша → null (index.js дорезолвит)', () => {
  assert.strictEqual(toCanonical('111222333@lid', createLidCache()), null);
});

test('toCanonical — @lid С кэшем → <pn>@c.us', () => {
  const cache = createLidCache();
  cache.remember('111222333@lid', '79991234567');
  assert.strictEqual(toCanonical('111222333@lid', cache), '79991234567@c.us');
});

test('toCanonical — группа @g.us не трогается (scope 1:1)', () => {
  assert.strictEqual(toCanonical('123456789-987@g.us', createLidCache()), '123456789-987@g.us');
});

test('ЯДРО БАГА #270: send.to(@c.us) и incoming(@lid) одного контакта → ОДИН канон', () => {
  const cache = createLidCache();
  // /chats увидел реальный @lid-чат и резолвил его телефон
  cache.remember('111222333@lid', '79991234567');
  const fromSend = toCanonical('79991234567@c.us', cache);   // send.to (подписка хранит это)
  const fromIncoming = toCanonical('111222333@lid', cache);  // входящее/chat.id
  assert.strictEqual(fromSend, fromIncoming);                // буквальный матч Kelly теперь сходится
  assert.strictEqual(fromSend, '79991234567@c.us');
});

test('realFor — обратный резолв канон→реальный serialized для getChatById', () => {
  const cache = createLidCache();
  cache.remember('111222333@lid', '79991234567');
  // канон отдаём Kelly, а getChatById зовём с РЕАЛЬНЫМ @lid-id (его wweb точно знает)
  assert.strictEqual(cache.realFor('79991234567@c.us'), '111222333@lid');
  // незнакомый канон → сам канон (для нативных @c.us-контактов)
  assert.strictEqual(cache.realFor('70000000000@c.us'), '70000000000@c.us');
});

test('remember(@c.us) — канон→self (нативный контакт, getChatById(<pn>@c.us) ок)', () => {
  const cache = createLidCache();
  cache.remember('79991234567@c.us', '79991234567');
  assert.strictEqual(cache.realFor('79991234567@c.us'), '79991234567@c.us');
  assert.strictEqual(cache.pnForLid('79991234567@c.us'), null); // не lid → в lidToPn не кладём
});

test('pn из getContactLidAndPhone может прийти как <num>@c.us — digits нормализует', () => {
  const cache = createLidCache();
  cache.remember('111222333@lid', '79991234567@c.us'); // pn-поле в формате serialized
  assert.strictEqual(toCanonical('111222333@lid', cache), '79991234567@c.us');
});
