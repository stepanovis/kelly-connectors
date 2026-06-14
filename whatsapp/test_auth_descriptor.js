// Конформанс connect-машины WhatsApp (Контракт 1, группа A2) — без Chrome.
// Запуск: node --test whatsapp/test_auth_descriptor.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildAuthDescriptor, QR_TTL_SEC } = require('./auth_descriptor');

test('A2 connected → state=connected, ready=true, без шага', () => {
  const d = buildAuthDescriptor({ isReady: true, connectionStatus: 'connected' });
  assert.strictEqual(d.state, 'connected');
  assert.strictEqual(d.ready, true);
  assert.strictEqual(d.step, null);
  assert.strictEqual(d.error, null);
});

test('A2 QR-шаг: pending + step.id=qr, поле type=qr с value и expires_at', () => {
  const now = 1781460000000;
  const d = buildAuthDescriptor({ isReady: false, connectionStatus: 'awaiting_qr', qrCode: 'QRPAYLOAD', qrReceivedAt: now });
  assert.strictEqual(d.state, 'pending');
  assert.strictEqual(d.step.id, 'qr');
  const f = d.step.fields[0];
  assert.strictEqual(f.type, 'qr');
  assert.strictEqual(f.value, 'QRPAYLOAD');
  assert.strictEqual(f.expires_at, Math.floor(now / 1000) + QR_TTL_SEC);
});

test('A2 [NEG] auth_failure → state=error, terminal=true (рестарт флоу)', () => {
  const d = buildAuthDescriptor({ isReady: false, connectionStatus: 'auth_failure', authError: 'session lost' });
  assert.strictEqual(d.state, 'error');
  assert.strictEqual(d.error.terminal, true);
  assert.strictEqual(d.error.message, 'session lost');
  assert.strictEqual(d.ready, false);
});

test('A2 инициализация (нет QR, не connected) → pending, step=null', () => {
  const d = buildAuthDescriptor({ isReady: false, connectionStatus: 'disconnected', qrCode: null });
  assert.strictEqual(d.state, 'pending');
  assert.strictEqual(d.step, null);
  assert.strictEqual(d.error, null);
});

test('дескриптор всегда несёт ровно ключи контракта state/step/error/ready', () => {
  const d = buildAuthDescriptor({ isReady: false, connectionStatus: 'awaiting_qr', qrCode: 'X', qrReceivedAt: 0 });
  assert.deepStrictEqual(Object.keys(d).sort(), ['error', 'ready', 'state', 'step']);
});
