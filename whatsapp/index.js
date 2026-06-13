const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');

const PORT = process.env.PORT || 3100;
const TOKEN = process.env.BRIDGE_TOKEN || process.env.API_TOKEN || '';

let qrCode = null;
let connectionStatus = 'disconnected';
let isReady = false;

// ── WhatsApp Client ──
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'auth') }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    protocolTimeout: 120000,
  },
});

client.on('qr', (qr) => {
  qrCode = qr;
  connectionStatus = 'awaiting_qr';
  console.log('[WhatsApp] QR code received. Open /qr in browser to scan.');
});

client.on('ready', () => {
  qrCode = null;
  connectionStatus = 'connected';
  isReady = true;
  console.log('[WhatsApp] Connected and ready!');
});

client.on('authenticated', () => {
  console.log('[WhatsApp] Authenticated.');
});

client.on('auth_failure', (msg) => {
  connectionStatus = 'auth_failure';
  console.error('[WhatsApp] Auth failure:', msg);
});

client.on('disconnected', (reason) => {
  connectionStatus = 'disconnected';
  isReady = false;
  console.log('[WhatsApp] Disconnected:', reason);
});

// ── Auth middleware ──
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Express API ──
const app = express();
app.use(express.json());

// Health / status (no auth)
app.get('/status', async (req, res) => {
  let contactCount = 0;
  let chatCount = 0;
  if (isReady) {
    try {
      const chats = await client.getChats();
      chatCount = chats.length;
    } catch (e) {}
  }
  res.json({
    status: connectionStatus,
    ready: isReady,
    chats: chatCount,
    qrPending: !!qrCode,
  });
});

// QR code as HTML page (no auth)
app.get('/qr', async (req, res) => {
  if (!qrCode) {
    return res.send(`<html><body style="font-family:monospace;text-align:center;padding:40px">
      <h2>WhatsApp Bridge v2</h2><p>Status: ${connectionStatus}</p>
      <p>${connectionStatus === 'connected' ? 'Already connected!' : 'No QR code available. Wait...'}</p>
      <script>setTimeout(()=>location.reload(),3000)</script></body></html>`);
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(qrCode, { width: 400 });
    res.send(`<html><body style="font-family:monospace;text-align:center;padding:40px">
      <h2>WhatsApp Bridge v2 — Scan QR Code</h2>
      <p>Open WhatsApp > Settings > Linked Devices > Link a Device</p>
      <img src="${qrDataUrl}" style="margin:20px"/>
      <p>Status: ${connectionStatus}</p>
      <script>setTimeout(()=>location.reload(),20000)</script></body></html>`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QR as JSON
app.get('/qr.json', (req, res) => {
  res.json({ qr: qrCode, status: connectionStatus });
});

// All routes below require auth
app.use(authMiddleware);

// List contacts
app.get('/contacts', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  try {
    const contacts = await client.getContacts();
    const list = contacts
      .filter((c) => c.isMyContact && c.id && c.id.server === 'c.us')
      .map((c) => ({
        id: c.id._serialized,
        name: c.name || '',
        pushName: c.pushname || '',
        phone: c.number || c.id.user || '',
        isMyContact: c.isMyContact,
      }))
      .sort((a, b) => (a.name || a.pushName || '').localeCompare(b.name || b.pushName || ''));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search contacts
app.get('/contacts/search', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json([]);
  try {
    const contacts = await client.getContacts();
    const results = contacts
      .filter((c) => {
        const name = (c.name || '').toLowerCase();
        const pushName = (c.pushname || '').toLowerCase();
        const phone = c.number || c.id?.user || '';
        return name.includes(q) || pushName.includes(q) || phone.includes(q);
      })
      .map((c) => ({
        id: c.id._serialized,
        name: c.name || '',
        pushName: c.pushname || '',
        phone: c.number || c.id?.user || '',
        isMyContact: c.isMyContact || false,
      }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List chats
app.get('/chats', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  try {
    const chats = await client.getChats();
    const list = chats.map((chat) => ({
      id: chat.id._serialized,
      name: chat.name || '',
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount || 0,
      lastMessage: chat.lastMessage?.body?.slice(0, 100) || '',
      timestamp: chat.lastMessage?.timestamp || 0,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Read messages from a chat
app.get('/messages', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  const { chatId, limit = 50 } = req.query;
  if (!chatId) return res.status(400).json({ error: 'chatId parameter required' });
  try {
    const chat = await client.getChatById(chatId);
    // Open chat in background to trigger WhatsApp Web loading before fetchMessages
    try { await chat.sendSeen(); } catch (_) {}
    await new Promise(r => setTimeout(r, 1500));
    const messages = await chat.fetchMessages({ limit: Number(limit) });
    const list = messages.map((msg) => ({
      id: msg.id._serialized,
      from: msg.from,
      to: msg.to,
      fromMe: msg.fromMe,
      body: msg.body,
      timestamp: msg.timestamp,
      type: msg.type,
      hasMedia: msg.hasMedia,
      author: msg.author || null,
    }));
    res.json({
      chatId,
      chatName: chat.name || '',
      messages: list,
      total: list.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get unread messages
app.get('/messages/unread', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  try {
    const chats = await client.getChats();
    const unread = [];
    for (const chat of chats) {
      if (chat.unreadCount > 0) {
        const messages = await chat.fetchMessages({ limit: chat.unreadCount });
        unread.push({
          chatId: chat.id._serialized,
          name: chat.name || '',
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount,
          messages: messages.map((msg) => ({
            id: msg.id._serialized,
            from: msg.from,
            fromMe: msg.fromMe,
            body: msg.body,
            timestamp: msg.timestamp,
            type: msg.type,
            author: msg.author || null,
          })),
        });
      }
    }
    unread.sort((a, b) => {
      const aTs = a.messages[a.messages.length - 1]?.timestamp || 0;
      const bTs = b.messages[b.messages.length - 1]?.timestamp || 0;
      return bTs - aTs;
    });
    res.json(unread);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send message
app.post('/messages/send', async (req, res) => {
  if (!isReady) return res.status(503).json({ error: 'WhatsApp not ready' });
  const { chatId, phone, text } = req.body;

  let target = chatId;
  if (!target && phone) {
    const cleaned = phone.replace(/[^0-9]/g, '');
    target = cleaned + '@c.us';
  }
  if (!target) return res.status(400).json({ error: 'chatId or phone required' });
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const msg = await client.sendMessage(target, text);
    res.json({ ok: true, id: msg.id._serialized, to: target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[API] WhatsApp Bridge v2 running on http://127.0.0.1:${PORT}`);
  console.log(`[API] Token: ${TOKEN}`);
  console.log(`[API] Endpoints:`);
  console.log(`  GET  /status             - Connection status`);
  console.log(`  GET  /qr                 - QR code for linking`);
  console.log(`  GET  /contacts           - List contacts (with names!)`);
  console.log(`  GET  /contacts/search?q= - Search contacts`);
  console.log(`  GET  /chats              - List chats`);
  console.log(`  GET  /messages?chatId=   - Read messages`);
  console.log(`  GET  /messages/unread    - Unread messages`);
  console.log(`  POST /messages/send      - Send message`);
  console.log('');
});

console.log('[WhatsApp] Initializing client (launching headless Chrome)...');
client.initialize();
