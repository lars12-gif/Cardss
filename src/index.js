require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');

const BOT_NUMBER = digits(process.env.BOT_NUMBER || '');
const DEFAULT_COUNTRY_CODE = digits(process.env.DEFAULT_COUNTRY_CODE || '964');
const GROUPS_ONLY = String(process.env.GROUPS_ONLY || 'false').toLowerCase() === 'true';
const OWNER_NUMBER = digits(process.env.OWNER_NUMBER || '');
const DATA_FILE = path.resolve(process.env.DATA_FILE || './data/collections.json');
const AUTH_DIR = path.resolve('./auth_info');

// Silence Baileys' verbose JSON logger. We print short, readable messages ourselves.
const logger = pino({ level: 'silent' });
let store = loadStore();
let sock = null;
let reconnectTimer = null;
let pairingTimer = null;
let pairingAttempts = 0;
let shuttingDown = false;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function log(message) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: process.env.TZ || 'Asia/Baghdad' });
  console.log(`[${time}] ${message}`);
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { chats: {} };
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.chats || typeof data.chats !== 'object') data.chats = {};
    return data;
  } catch {
    log('⚠️ تعذر قراءة ملف البيانات، سيتم إنشاء ملف جديد.');
    return { chats: {} };
  }
}

function saveStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}

function getChatState(chatId) {
  if (!store.chats[chatId]) {
    store.chats[chatId] = {
      active: false, startedAt: null, received: 0,
      success: 0, failed: 0, duplicates: 0, numbers: [], numberSet: []
    };
  }
  const s = store.chats[chatId];
  for (const key of ['numbers', 'numberSet']) if (!Array.isArray(s[key])) s[key] = [];
  return s;
}

function isGroup(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function senderNumber(message, chatId) {
  const participant = message.key.participant || message.key.remoteJid || chatId;
  return digits(String(participant).split('@')[0].split(':')[0]);
}

function isAuthorized(message, chatId) {
  if (GROUPS_ONLY && !isGroup(chatId)) return false;
  return !OWNER_NUMBER || senderNumber(message, chatId) === OWNER_NUMBER;
}

function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 6 && m; i++) {
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else if (m.deviceSentMessage?.message) m = m.deviceSentMessage.message;
    else if (m.editedMessage?.message) m = m.editedMessage.message;
    else if (m.keepInChatMessage?.message) m = m.keepInChatMessage.message;
    else break;
  }
  return m || {};
}

function getText(message) {
  const m = unwrapMessage(message.message);
  return (m.conversation || m.extendedTextMessage?.text ||
    m.imageMessage?.caption || m.videoMessage?.caption || '').trim();
}

function extractVCards(message) {
  const m = unwrapMessage(message.message);
  const cards = [];

  if (typeof m.contactMessage?.vcard === 'string' && m.contactMessage.vcard.trim()) {
    cards.push(m.contactMessage.vcard);
  }

  const contacts = m.contactsArrayMessage?.contacts;
  if (Array.isArray(contacts)) {
    for (const contact of contacts) {
      if (typeof contact?.vcard === 'string' && contact.vcard.trim()) {
        cards.push(contact.vcard);
      }
    }
  }

  return cards;
}

function parseTelValues(vcard) {
  const unfolded = String(vcard || '').replace(/\r?\n[ \t]/g, '');
  return unfolded.split(/\r?\n/)
    .filter(line => /^TEL(?:;[^:]*)?:/i.test(line.trim()))
    .map(line => line.slice(line.indexOf(':') + 1).trim())
    .filter(Boolean);
}

function normalizePhone(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
  value = value.replace(/^tel:/i, '').split(';')[0].split(',')[0].trim();
  value = value.replace(/(?:ext\.?|x)\s*\d+$/i, '');
  const international = value.startsWith('+') || value.startsWith('00');
  let number = digits(value);
  if (!number) return null;
  if (number.startsWith('00')) number = number.slice(2);

  if (!international && DEFAULT_COUNTRY_CODE) {
    if (number.startsWith('0')) number = DEFAULT_COUNTRY_CODE + number.slice(1);
    else if (!number.startsWith(DEFAULT_COUNTRY_CODE)) number = DEFAULT_COUNTRY_CODE + number;
  }
  if (number.length < 7 || number.length > 15) return null;
  return '+' + number;
}

function recordVCard(chatId, vcard) {
  const s = getChatState(chatId);
  s.received++;
  const numbers = parseTelValues(vcard).map(normalizePhone).filter(Boolean);
  if (!numbers.length) {
    s.failed++;
    return 'failed';
  }
  let added = 0;
  for (const number of numbers) {
    if (s.numberSet.includes(number)) {
      s.duplicates++;
      continue;
    }
    s.numberSet.push(number);
    s.numbers.push(number);
    s.success++;
    added++;
  }
  return added ? 'success' : 'duplicate';
}

async function sendText(chatId, text) {
  await sock.sendMessage(chatId, { text });
}

async function handleMessage(message) {
  if (!message.message || message.key.fromMe) return;
  const chatId = message.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast' || !isAuthorized(message, chatId)) return;

  const text = getText(message);
  const state = getChatState(chatId);

  if (text === '$احسب') {
    state.active = true;
    state.startedAt = new Date().toISOString();
    state.received = state.success = state.failed = state.duplicates = 0;
    state.numbers = [];
    state.numberSet = [];
    saveStore();
    log(`🟢 بدأت عملية جمع جديدة في ${chatId}`);
    await sendText(chatId,
      '✅ تم تفعيل نظام جمع الأرقام.\n' +
      '📥 أرسل جهات الاتصال بصيغة vCard.\n' +
      '📊 العدد الحالي: 0\n\n' +
      'عند الانتهاء أرسل: $ناتج'
    );
    return;
  }

  if (text === '$ناتج') {
    if (!state.active && state.received === 0 && state.numbers.length === 0) {
      await sendText(chatId, '⚠️ لا توجد عملية جمع حالية. أرسل $احسب أولاً.');
      return;
    }
    state.active = false;
    saveStore();

    // Keep the number dump and summary as two distinct WhatsApp messages.
    await sendText(chatId, state.numbers.length ? state.numbers.join('\n') : 'لا توجد أرقام صالحة.');
    const summary =
      '📊 ملخص عملية الحساب\n\n' +
      `📥 إجمالي الجهات المستلمة: ${state.received}\n` +
      `✅ الأرقام الناجحة: ${state.success}\n` +
      `❌ الجهات الفاشلة: ${state.failed}\n` +
      `🔁 الأرقام المكررة: ${state.duplicates}\n` +
      `📱 الأرقام الفريدة: ${state.numbers.length}\n\n` +
      'تم الانتهاء من استخراج الأرقام.';
    await sendText(chatId, summary);
    log(`📦 اكتمل الجمع: ${state.numbers.length} رقم فريد | ${state.failed} فشل | ${state.duplicates} تكرار`);
    return;
  }

  const unwrapped = unwrapMessage(message.message);
  const vcards = extractVCards(message);
  if (state.active && !vcards.length &&
      (unwrapped.contactMessage || unwrapped.contactsArrayMessage)) {
    const contactCount = Array.isArray(unwrapped.contactsArrayMessage?.contacts)
      ? unwrapped.contactsArrayMessage.contacts.length : 0;
    log(`⚠️ وصلت رسالة جهة اتصال لكن بدون vCard قابل للقراءة (نوع: ${
      unwrapped.contactMessage ? 'contactMessage' : 'contactsArrayMessage'
    } | عدد العناصر: ${contactCount})`);
  }

  if (vcards.length && state.active) {
    for (const vcard of vcards) {
      const result = recordVCard(chatId, vcard);
      if (result === 'success') log(`✅ تم استلام جهة اتصال وحفظ رقم (المجموع: ${state.numbers.length})`);
      else if (result === 'duplicate') log(`🔁 جهة اتصال مكررة (المجموع: ${state.numbers.length})`);
      else log(`❌ جهة اتصال بدون رقم صالح (الفشل: ${state.failed})`);
    }
    saveStore();
  }
}

function schedulePairingCode(currentSocket, authState) {
  if (authState.creds.registered || pairingTimer || shuttingDown) return;
  pairingTimer = setTimeout(async () => {
    pairingTimer = null;
    if (sock !== currentSocket || authState.creds.registered || shuttingDown) return;

    if (!BOT_NUMBER || BOT_NUMBER.includes('X')) {
      log('❌ ضع رقم واتساب في BOT_NUMBER داخل إعدادات البيئة أولاً.');
      return;
    }

    try {
      pairingAttempts++;
      log(`🔐 جارٍ طلب رمز الاقتران للحساب +${BOT_NUMBER} (محاولة ${pairingAttempts})...`);
      const code = await currentSocket.requestPairingCode(BOT_NUMBER);
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      log(`📲 رقم الحساب: +${BOT_NUMBER}`);
      log(`🔑 رمز الاقتران: ${code}`);
      log('افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف');
      log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch (error) {
      const status = error?.output?.statusCode || error?.statusCode;
      log(`⚠️ تعذر إصدار رمز الاقتران${status ? ` (HTTP ${status})` : ''}: ${error?.message || 'خطأ غير معروف'}`);
      if (pairingAttempts < 5 && sock === currentSocket && !shuttingDown) {
        log('⏳ سأعيد المحاولة بعد 4 ثوانٍ...');
        pairingTimer = setTimeout(() => {
          pairingTimer = null;
          schedulePairingCode(currentSocket, authState);
        }, 4000);
      } else {
        log('❌ لم أتمكن من إصدار الرمز. تحقق من رقم الهاتف وإصدار Baileys ثم أعد التشغيل.');
      }
    }
  }, 5000);
}

async function start() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    log(`📡 إصدار WhatsApp Web: ${version.join('.')}`);
  } catch {
    log('⚠️ تعذر جلب إصدار WhatsApp Web، سيتم استخدام الإصدار الافتراضي.');
  }

  const currentSocket = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  sock = currentSocket;
  pairingAttempts = 0;
  currentSocket.ev.on('creds.update', saveCreds);

  currentSocket.ev.on('connection.update', update => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting') {
      log('🔄 جارٍ الاتصال بواتساب...');
      // Do not request the pairing code immediately: the websocket handshake needs time.
      schedulePairingCode(currentSocket, state);
    }

    if (connection === 'open') {
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingTimer = null;
      log('✅ تم الاتصال بواتساب بنجاح. البوت يعمل الآن.');
    }

    if (connection === 'close') {
      if (pairingTimer) clearTimeout(pairingTimer);
      pairingTimer = null;
      const status = lastDisconnect?.error?.output?.statusCode;
      const registered = state.creds.registered;
      log(`🔌 انقطع اتصال واتساب${status ? ` (الكود ${status})` : ''}.`);

      if (shuttingDown) return;
      if (status === DisconnectReason.loggedOut && registered) {
        log('⛔ الجلسة منتهية أو تم تسجيل الخروج. احذف auth_info واربط الحساب من جديد.');
        return;
      }

      log('⏳ إعادة الاتصال بعد 5 ثوانٍ...');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        start().catch(err => log(`❌ فشل بدء الاتصال: ${err.message}`));
      }, 5000);
    }
  });

  currentSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        await handleMessage(message);
      } catch (error) {
        log(`❌ خطأ أثناء معالجة رسالة: ${error.message}`);
      }
    }
  });
}

function shutdown() {
  shuttingDown = true;
  if (pairingTimer) clearTimeout(pairingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  log('👋 إيقاف البوت...');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('🚀 بدأ تشغيل بوت جمع جهات الاتصال...');
log(`📱 حساب الربط: ${BOT_NUMBER ? '+' + BOT_NUMBER : 'غير مضبوط في BOT_NUMBER'}`);
start().catch(error => {
  log(`❌ فشل تشغيل البوت: ${error.message}`);
  // Keep the hosting process alive and retry transient startup errors.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch(err => log(`❌ فشل إعادة التشغيل: ${err.message}`));
  }, 10000);
});
