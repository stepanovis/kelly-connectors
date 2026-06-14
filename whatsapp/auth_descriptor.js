// Connect-машина состояний WhatsApp — чистое отображение внутреннего состояния
// клиента в дескриптор Контракта 1 (тот же контракт, что у Telegram).
// Вынесено отдельным модулем без тяжёлых зависимостей (whatsapp-web.js/puppeteer),
// чтобы маппинг состояний был юнит-тестируем без запуска Chrome.

const QR_TTL_SEC = 60; // whatsapp-web.js ротирует QR ~раз в 20-30с; даём запас

// state: collecting | pending | connected | error
// step:  что показать СЕЙЧАС (QR), либо null
// error: { message, terminal } | null
function buildAuthDescriptor({ isReady, connectionStatus, qrCode, qrReceivedAt, authError }) {
  if (isReady) {
    return { state: 'connected', step: null, error: null, ready: true };
  }
  if (connectionStatus === 'auth_failure') {
    return {
      state: 'error',
      step: null,
      error: { message: authError || 'Ошибка авторизации. Перезапусти подключение.', terminal: true },
      ready: false,
    };
  }
  if (qrCode) {
    return {
      state: 'pending',
      step: {
        id: 'qr',
        fields: [{
          key: 'qr',
          type: 'qr',
          value: qrCode,
          expires_at: Math.floor((qrReceivedAt || 0) / 1000) + QR_TTL_SEC,
        }],
      },
      error: null,
      ready: false,
    };
  }
  // QR ещё не сгенерирован — инициализация
  return { state: 'pending', step: null, error: null, ready: false };
}

module.exports = { buildAuthDescriptor, QR_TTL_SEC };
