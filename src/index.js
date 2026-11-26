import 'dotenv/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { extractPhonesFromMessage } from './vcard.js';
import { readChat, writeChat, addNumbers, clearChat } from './store.js';

const BOT_NUMBER = String(process.env.BOT_NUMBER || '').replace(/\D/g, '');
const DEFAULT_COUNTRY_CODE = String(process.env.DEFAULT_COUNTRY_CODE || '964').replace(/\D/g, '');
const MAX_CONTACTS = Math.min(500, Math.max(1, Number.parseInt(process.env.MAX_CONTACTS || '500', 10) || 500));
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const AUTH_DIR = '.auth';
const logger = pino({ level: LOG_LEVEL });
let reconnectTimer;
let isStarting = false;
let pairingRequested = false;

if (!BOT_NUMBER) {
  console.error('خطأ: ضع رقم البوت في BOT_NUMBER داخل ملف .env');
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const getText = message => {
  const m = message?.message;
  return m?.conversation
    || m?.extendedTextMessage?.text
    || m?.imageMessage?.caption
    || m?.videoMessage?.caption
    || '';
};
const isGroup = jid => typeof jid === 'string' && jid.endsWith('@g.us');

async function sendText(sock, jid, text, quoted) {
  await sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
}

async function handleIncoming(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast' || msg.key?.fromMe) return;
  // This tool is intended for groups; private chats are ignored.
  if (!isGroup(jid)) return;

  const phones = extractPhonesFromMessage(msg, DEFAULT_COUNTRY_CODE);
  if (phones.length) {
    const result = await addNumbers(jid, phones, MAX_CONTACTS);
    let note = `تم استلام بطاقة جهة اتصال.\nأُضيف: ${result.added}\nالمجموع المحفوظ: ${result.total}/${MAX_CONTACTS}`;
    if (result.overflow) note += `\nتم تجاهل ${result.overflow} رقم بسبب بلوغ الحد الأعلى.`;
    await sendText(sock, jid, note, msg);
    return;
  }

  const text = getText(msg).trim();
  if (!text) return;
  const command = text.split(/\s+/)[0];

  if (command === '$احسب') {
    const data = await readChat(jid);
    const unique = [...new Set(data.numbers)];
    const valid = unique.filter(n => /^\+\d{7,15}$/.test(n));
    const invalid = unique.length - valid.length;
    await writeChat(jid, valid, data.duplicatesRemoved);
    await sendText(sock, jid,
      `📊 ملخص جهات الاتصال\n\n` +
      `الإجمالي المحفوظ: ${data.numbers.length}\n` +
      `الناجح: ${valid.length}\n` +
      `الفاشل: ${invalid}\n` +
      `المكرر المحذوف: ${data.duplicatesRemoved}\n\n` +
      `لإرسال الأرقام فقط استخدم: $ناتج`, msg);
    return;
  }

  if (command === '$ناتج') {
    const data = await readChat(jid);
    const numbers = [...new Set(data.numbers)].filter(n => /^\+\d{7,15}$/.test(n));
    if (!numbers.length) {
      await sendText(sock, jid, 'ماكو أرقام محفوظة حالياً. أرسل بطاقات جهات الاتصال أولاً.', msg);
      return;
    }
    // Only the phone numbers are included in this message.
    const chunks = [];
    for (let i = 0; i < numbers.length; i += 80) chunks.push(numbers.slice(i, i + 80).join('\n'));
    for (const chunk of chunks) await sendText(sock, jid, chunk);
    return;
  }

  if (command === '$مسح') {
    await clearChat(jid);
    await sendText(sock, jid, 'تم مسح قائمة الأرقام لهذه المجموعة.', msg);
    return;
  }

  if (command === '$مساعدة') {
    await sendText(sock, jid,
      'أوامر البوت:\n' +
      '• أرسل بطاقة جهة اتصال (vCard) حتى تُحفظ أرقامها.\n' +
      '• $احسب — ملخص الإجمالي والناجح والفاشل.\n' +
      '• $ناتج — إرسال الأرقام فقط، كل رقم بسطر.\n' +
      '• $مسح — مسح قائمة هذه المجموعة.\n' +
      `الحد الأعلى: ${MAX_CONTACTS} جهة اتصال.`, msg);
  }
}

async function startBot() {
  if (isStarting) return;
  isStarting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      logger.warn('تعذر جلب إصدار واتساب؛ سيتم استخدام الإصدار الافتراضي للمكتبة.');
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2_000
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleIncoming(sock, msg); }
        catch (error) { logger.error({ err: error }, 'فشل التعامل مع رسالة'); }
      }
    });

    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect } = update;
      if (connection === 'connecting') logger.info('جاري الاتصال بواتساب...');
      if (connection === 'open') {
        logger.info('تم الاتصال بواتساب بنجاح.');
        pairingRequested = false;
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn({ statusCode, loggedOut }, 'انقطع اتصال واتساب.');
        if (!loggedOut && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            isStarting = false;
            startBot().catch(err => logger.error({ err }, 'فشل إعادة التشغيل'));
          }, 5_000);
        } else if (loggedOut) {
          logger.error('الجلسة غير مسجلة حالياً. لا تحذف .auth مباشرة؛ خذ نسخة احتياطية أولاً، ثم أعد الاقتران فقط إذا تأكدت أن واتساب ألغى ربط الجهاز.');
          isStarting = false;
        }
      }
      if (update.qr) logger.info('تم تعطيل QR؛ استخدم كود الاقتران.');
      if (connection === 'connecting' && !state.creds.registered && !pairingRequested) {
        pairingRequested = true;
        await sleep(2_000);
        try {
          const code = await sock.requestPairingCode(BOT_NUMBER);
          console.log('\n========================================');
          console.log(`كود اقتران واتساب: ${code}`);
          console.log('افتح واتساب > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف');
          console.log('========================================\n');
        } catch (error) {
          pairingRequested = false;
          logger.error({ err: error }, 'تعذر إنشاء كود الاقتران؛ سيُعاد المحاولة عند إعادة الاتصال.');
        }
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'خطأ أثناء بدء البوت');
    isStarting = false;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        startBot().catch(err => logger.error({ err }, 'فشل إعادة التشغيل'));
      }, 8_000);
    }
  }
}

process.on('uncaughtException', error => logger.fatal({ err: error }, 'uncaughtException'));
process.on('unhandledRejection', error => logger.error({ err: error }, 'unhandledRejection'));
process.on('SIGINT', () => { logger.info('إيقاف البوت...'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('إيقاف البوت...'); process.exit(0); });

logger.info(`WA vCard Bot v2.1.0 | الحد الأعلى ${MAX_CONTACTS} | رمز الدولة ${DEFAULT_COUNTRY_CODE}`);
startBot();
