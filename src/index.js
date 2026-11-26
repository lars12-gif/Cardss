require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  Browsers
} = require('@whiskeysockets/baileys');

const BOT_NUMBER = digits(process.env.BOT_NUMBER || '');
const DEFAULT_COUNTRY_CODE = digits(process.env.DEFAULT_COUNTRY_CODE || '964');
const GROUPS_ONLY = String(process.env.GROUPS_ONLY || 'false').toLowerCase() === 'true';
const OWNER_NUMBER = digits(process.env.OWNER_NUMBER || '');
const DATA_FILE = path.resolve(process.env.DATA_FILE || './data/collections.json');
const AUTH_DIR = path.resolve('./auth_info');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let store = loadStore();
let sock;
let reconnecting = false;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { chats: {} };
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { chats: {} };
    if (!parsed.chats || typeof parsed.chats !== 'object') parsed.chats = {};
    return parsed;
  } catch (error) {
    logger.error({ err: error }, 'Could not read data file; starting with an empty store');
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
      active: false,
      startedAt: null,
      received: 0,
      success: 0,
      failed: 0,
      duplicates: 0,
      numbers: [],
      numberSet: []
    };
  }
  const state = store.chats[chatId];
  if (!Array.isArray(state.numbers)) state.numbers = [];
  if (!Array.isArray(state.numberSet)) state.numberSet = [...state.numbers];
  return state;
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
  if (!OWNER_NUMBER) return true;
  return senderNumber(message, chatId) === OWNER_NUMBER;
}

function unwrapMessage(message) {
  let content = message;
  for (let i = 0; i < 6; i++) {
    if (!content) break;
    if (content.ephemeralMessage?.message) content = content.ephemeralMessage.message;
    else if (content.viewOnceMessage?.message) content = content.viewOnceMessage.message;
    else if (content.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
    else if (content.documentWithCaptionMessage?.message) content = content.documentWithCaptionMessage.message;
    else break;
  }
  return content || {};
}

function getText(message) {
  const m = unwrapMessage(message.message);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function extractVCards(message) {
  const m = unwrapMessage(message.message);
  const cards = [];

  if (m.contactMessage?.vcard) {
    cards.push(m.contactMessage.vcard);
  }

  const array = m.contactsArrayMessage?.contacts;
  if (Array.isArray(array)) {
    for (const item of array) {
      if (item?.vcard) cards.push(item.vcard);
    }
  }

  return cards;
}

function parseTelValues(vcard) {
  const found = [];
  // vCard TEL lines can be folded onto the next line. Unfold before parsing.
  const unfolded = String(vcard || '').replace(/\r?\n[ \t]/g, '');
  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^TEL(?:;[^:]*)?:/i.test(line.trim())) continue;
    const value = line.slice(line.indexOf(':') + 1).trim();
    if (value) found.push(value);
  }
  return found;
}

function normalizePhone(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;

  // Strip common vCard URI prefixes and extension fragments.
  value = value.replace(/^tel:/i, '').split(';')[0].split(',')[0].trim();
  value = value.replace(/(?:ext\.?|x)\s*\d+$/i, '');
  const hadPlus = value.startsWith('+') || value.startsWith('00');
  let number = digits(value);

  if (!number) return null;
  if (number.startsWith('00')) number = number.slice(2);

  if (!hadPlus && DEFAULT_COUNTRY_CODE) {
    // Convert a national Iraqi-style trunk prefix 0 to the configured country code.
    if (number.startsWith('0')) number = DEFAULT_COUNTRY_CODE + number.slice(1);
    // Otherwise, treat an unprefixed local number as national and prepend the default code.
    else if (!number.startsWith(DEFAULT_COUNTRY_CODE)) number = DEFAULT_COUNTRY_CODE + number;
  }

  // Basic sanity check; full carrier/number allocation validation is not possible offline.
  if (number.length < 7 || number.length > 15) return null;
  return '+' + number;
}

function recordVCard(chatId, vcard) {
  const state = getChatState(chatId);
  state.received += 1;
  const telValues = parseTelValues(vcard);
  const candidates = telValues.map(normalizePhone).filter(Boolean);

  if (candidates.length === 0) {
    state.failed += 1;
    return 'failed';
  }

  // One vCard may contain more than one TEL. Count each unique number independently.
  let addedAny = false;
  for (const number of candidates) {
    if (state.numberSet.includes(number)) {
      state.duplicates += 1;
      continue;
    }
    state.numberSet.push(number);
    state.numbers.push(number);
    state.success += 1;
    addedAny = true;
  }

  if (!addedAny) return 'duplicate';
  return 'success';
}

async function sendText(chatId, text) {
  await sock.sendMessage(chatId, { text });
}

async function handleMessage(message) {
  if (!message.message || message.key.fromMe) return;
  const chatId = message.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;
  if (!isAuthorized(message, chatId)) return;

  const text = getText(message);
  const state = getChatState(chatId);

  if (text === '$احسب') {
    state.active = true;
    state.startedAt = new Date().toISOString();
    state.received = 0;
    state.success = 0;
    state.failed = 0;
    state.duplicates = 0;
    state.numbers = [];
    state.numberSet = [];
    saveStore();
    await sendText(chatId,
      '✅ تم تفعيل نظام جمع الأرقام.\\n' +
      '📥 أرسل جهات الاتصال بصيغة vCard.\\n' +
      '📊 العدد الحالي: 0\\n\\n' +
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

    // Send the complete number list as its own message, followed by a separate summary.
    const numbersText = state.numbers.length ? state.numbers.join('\n') : 'لا توجد أرقام صالحة.';
    await sendText(chatId, numbersText);

    const summary =
      '📊 ملخص عملية الحساب\\n\\n' +
      '📥 إجمالي الجهات المستلمة: ' + state.received + '\\n' +
      '✅ الأرقام الناجحة: ' + state.success + '\\n' +
      '❌ الجهات الفاشلة: ' + state.failed + '\\n' +
      '🔄 الأرقام المكررة: ' + state.duplicates + '\\n' +
      '📱 إجمالي الأرقام الفريدة: ' + state.numbers.length + '\\n\\n' +
      'تم الانتهاء من استخراج الأرقام.';
    await sendText(chatId, summary);
    return;
  }

  const vcards = extractVCards(message);
  if (vcards.length && state.active) {
    for (const vcard of vcards) recordVCard(chatId, vcard);
    saveStore();
    return;
  }

  // vCards sent before $احسب are deliberately ignored.
}

async function start() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    logger.info({ version }, 'Using latest WhatsApp Web version');
  } catch (error) {
    logger.warn({ err: error }, 'Could not fetch latest version; using library default');
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'connecting' && !sock.authState.creds.registered) {
      if (!BOT_NUMBER || BOT_NUMBER.includes('X')) {
        logger.error('Set BOT_NUMBER in .env before starting the bot.');
      } else {
        try {
          const code = await sock.requestPairingCode(BOT_NUMBER);
          console.log('\\n========================================');
          console.log('WhatsApp Pairing Code: ' + code);
          console.log('Open WhatsApp > Linked devices > Link with phone number');
          console.log('========================================\\n');
        } catch (error) {
          logger.error({ err: error }, 'Could not generate pairing code');
        }
      }
    }

    if (connection === 'open') {
      logger.info('WhatsApp bot connected successfully');
      reconnecting = false;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      logger.warn({ statusCode, loggedOut }, 'WhatsApp connection closed');
      if (!loggedOut && !reconnecting) {
        reconnecting = true;
        setTimeout(() => start().catch(err => logger.error({ err }, 'Reconnect failed')), 3000);
      } else if (loggedOut) {
        logger.error('Session logged out. Remove auth_info and pair again.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        await handleMessage(message);
      } catch (error) {
        logger.error({ err: error }, 'Message handling failed');
      }
    }
  });
}

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));

start().catch(error => {
  logger.fatal({ err: error }, 'Bot startup failed');
  process.exit(1);
});
