const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const Database = require('better-sqlite3');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ==========================================
// 1. تنظيف اللوق من ضجيج libsignal (Bad MAC / SessionEntry)
// ==========================================
const noisyPatterns = [
  'Bad MAC',
  'Failed to decrypt message',
  'Closing session:',
  'Session error:',
  'libsignal/src/'
];

function isNoisyLog(args) {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a && typeof a === 'object') {
        try {
          return a.stack || a.message || JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
  return noisyPatterns.some((p) => text.includes(p));
}

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

console.log = (...args) => {
  if (!isNoisyLog(args)) origLog(...args);
};
console.error = (...args) => {
  if (!isNoisyLog(args)) origError(...args);
};
console.warn = (...args) => {
  if (!isNoisyLog(args)) origWarn(...args);
};

// ==========================================
// 2. الإعدادات وقاعدة البيانات الدائمة
// ==========================================
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '9647703270534').replace(/\D/g, '');

const db = new Database('contacts.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    added_by TEXT,
    group_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertContactStmt = db.prepare(`
  INSERT OR IGNORE INTO contacts (phone, name, added_by, group_id)
  VALUES (@phone, @name, @added_by, @group_id)
`);
const getContactByPhoneStmt = db.prepare(`SELECT * FROM contacts WHERE phone = ?`);
const getCountStmt = db.prepare(`SELECT COUNT(*) AS total FROM contacts`);
const getAllPhonesStmt = db.prepare(`SELECT phone FROM contacts ORDER BY id ASC`);
const clearAllStmt = db.prepare(`DELETE FROM contacts`);

// تتبع معرفات الرسائل التي أرسلها البوت لتجنب الرد على نفسه
const botSentIds = new Set();

async function sendBotMessage(sock, jid, content, options = {}) {
  const sent = await sock.sendMessage(jid, content, options);
  if (sent?.key?.id) {
    botSentIds.add(sent.key.id);
    if (botSentIds.size > 500) {
      const firstKey = botSentIds.values().next().value;
      botSentIds.delete(firstKey);
    }
  }
  return sent;
}

// ==========================================
// 3. دوال معالجة الأرقام والبطاقات والرسائل
// ==========================================
function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  let cleaned = String(rawPhone).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2);
  }
  cleaned = cleaned.replace(/^\+/, '');
  return cleaned.length >= 7 ? cleaned : null;
}

function parseSingleVCard(vcardStr) {
  const results = [];
  if (!vcardStr || typeof vcardStr !== 'string') return results;

  const fnMatch = vcardStr.match(/FN[^:]*:([^\r\n]+)/i);
  const name = fnMatch ? fnMatch[1].trim() : 'بدون اسم';

  const telMatches = [...vcardStr.matchAll(/TEL[^:]*:([^\r\n]+)/gi)];
  for (const match of telMatches) {
    const waidMatch = match[0].match(/waid=(\d+)/i);
    const rawNum = waidMatch ? waidMatch[1] : match[1];
    const phone = normalizePhone(rawNum);
    if (phone) {
      results.push({ name, phone });
    }
  }
  return results;
}

function unwrapMessage(msgContent) {
  let m = msgContent;
  while (
    m?.ephemeralMessage?.message ||
    m?.viewOnceMessage?.message ||
    m?.viewOnceMessageV2?.message ||
    m?.documentWithCaptionMessage?.message
  ) {
    m =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message;
  }
  return m;
}

function detectMessageType(m) {
  if (!m) return 'فارغة / غير معروفة';
  if (m.contactMessage) return 'بطاقة اتصال (Contact)';
  if (m.contactsArrayMessage) return 'بطاقات اتصال متعددة (Multi Contact)';
  if (m.conversation || m.extendedTextMessage) return 'رسالة نصية';
  if (m.imageMessage) return 'صورة';
  if (m.videoMessage) return 'فيديو';
  if (m.audioMessage) return 'رسالة صوتية';
  if (m.documentMessage) return 'ملف / مستند';
  if (m.stickerMessage) return 'ملصق';
  if (m.locationMessage || m.liveLocationMessage) return 'موقع جغرافي';
  if (m.reactionMessage) return 'تفاعل (Reaction)';
  if (m.pollCreationMessage) return 'استطلاع';
  return Object.keys(m)[0] || 'أخرى';
}

function extractContactsFromMessage(m) {
  const extracted = [];
  if (!m) return extracted;

  if (m.contactMessage?.vcard) {
    extracted.push(...parseSingleVCard(m.contactMessage.vcard));
  }

  if (m.contactsArrayMessage?.contacts?.length) {
    for (const c of m.contactsArrayMessage.contacts) {
      if (c.vcard) {
        extracted.push(...parseSingleVCard(c.vcard));
      } else if (c.displayName || c.phoneNumber) {
        const phone = normalizePhone(c.phoneNumber);
        if (phone) {
          extracted.push({
            name: c.displayName || 'بدون اسم',
            phone
          });
        }
      }
    }
  }

  return extracted;
}

function getMessageText(m) {
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

function formatJidDisplay(jid) {
  if (!jid) return 'غير معروف';
  return jid.split('@')[0].split(':')[0];
}

function logIncomingMessage({ chatId, senderId, isGroup, fromMe, typeLabel, preview, statusNote }) {
  const timeStr = new Date().toLocaleTimeString('ar-IQ', { hour12: false });
  const place = isGroup ? `مجموعة (${formatJidDisplay(chatId)})` : `خاص (${formatJidDisplay(chatId)})`;
  const sender = fromMe ? `أنت / البوت (${formatJidDisplay(senderId)})` : formatJidDisplay(senderId);

  const lines = [
    `────────────────────────────────────────`,
    `📩 رسالة واردة [${timeStr}]`,
    `• المكان  : ${place}`,
    `• المرسل  : ${sender}`,
    `• النوع   : ${typeLabel}`
  ];
  if (preview) lines.push(`• المحتوى : ${preview}`);
  if (statusNote) lines.push(`• المعالجة: ${statusNote}`);
  lines.push(`────────────────────────────────────────`);

  origLog(lines.join('\n'));
}

async function isSenderGroupAdmin(sock, groupJid, senderJid, fromMe) {
  if (fromMe) return true;
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const senderNum = formatJidDisplay(senderJid);
    const participant = metadata.participants.find((p) => {
      const pNum = formatJidDisplay(p.id);
      const pLidNum = p.lid ? formatJidDisplay(p.lid) : '';
      return p.id === senderJid || p.lid === senderJid || (senderNum && (pNum === senderNum || pLidNum === senderNum));
    });
    return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
  } catch {
    return false;
  }
}

// ==========================================
// 4. تشغيل البوت والربط عبر Pairing Code
// ==========================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER || PHONE_NUMBER.length < 8) {
      origError('❌ يرجى تحديد رقم الهاتف بالصيغة الدولية في PHONE_NUMBER (مثال: 9647703270534)');
      process.exit(1);
    }

    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        origLog(`\n🔐 رمز الاقتران للرقم ${PHONE_NUMBER}: ${code}`);
        origLog('افتح واتساب > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف وأدخل الرمز.\n');
      } catch (err) {
        origError('❌ فشل طلب رمز الاقتران:', err?.message || err);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      origLog('✅ تم الاتصال بواتساب بنجاح وجاهز لاستقبال الرسائل والأوامر.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      origLog(`⚠️ انقطع الاتصال (الرمز: ${statusCode}) | إعادة الاتصال: ${shouldReconnect ? 'نعم' : 'لا'}`);
      if (shouldReconnect) {
        startBot();
      } else {
        origLog('🚫 تم تسجيل الخروج من الحساب. احذف مجلد auth_info وأعد الربط.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.key?.id) continue;
        if (botSentIds.has(msg.key.id)) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId || chatId === 'status@broadcast') continue;

        const m = unwrapMessage(msg.message);
        if (!m) continue;

        const isGroup = chatId.endsWith('@g.us');
        const fromMe = Boolean(msg.key.fromMe);
        const senderId = fromMe
          ? sock.user?.id || `${PHONE_NUMBER}@s.whatsapp.net`
          : isGroup
            ? msg.key.participant || chatId
            : chatId;

        const typeLabel = detectMessageType(m);
        const body = getMessageText(m);
        const extractedContacts = extractContactsFromMessage(m);

        let preview = '';
        if (body) {
          preview = body.length > 90 ? `${body.slice(0, 90)}...` : body;
        } else if (extractedContacts.length > 0) {
          preview = extractedContacts.map((c) => `${c.name} (${c.phone})`).join(' ، ');
        }

        // --- 1. الأوامر (تعمل من أي رقم ومن رقم البوت نفسه أيضاً) ---
        if (body === '$مساعدة') {
          const helpText = [
            '📋 *قائمة أوامر البوت:*',
            '• *$احسب* : عرض العدد الكلي للأرقام المسجلة.',
            '• *$ناتج* : تصدير جميع الأرقام المحفوظة بملف TXT (كل رقم بسطر).',
            '• *$مسح* : حذف الأرقام المسجلة (للإدارة فقط).',
            '• *$مساعدة* : عرض قائمة الأوامر ووظائفها.',
            '',
            '💡 لإضافة رقم، أرسل بطاقة جهة اتصال (Contact / vCard) داخل المجموعة.'
          ].join('\n');

          await sendBotMessage(sock, chatId, { text: helpText }, { quoted: msg });
          logIncomingMessage({ chatId, senderId, isGroup, fromMe, typeLabel, preview, statusNote: 'نُفّذ أمر $مساعدة' });
          continue;
        }

        if (body === '$احسب') {
          const { total } = getCountStmt.get();
          await sendBotMessage(
            sock,
            chatId,
            { text: `📊 العدد الكلي للأرقام المسجلة: *${total}*` },
            { quoted: msg }
          );
          logIncomingMessage({
            chatId,
            senderId,
            isGroup,
            fromMe,
            typeLabel,
            preview,
            statusNote: `نُفّذ أمر $احسب (المجموع: ${total})`
          });
          continue;
        }

        if (body === '$ناتج') {
          const rows = getAllPhonesStmt.all();
          if (rows.length === 0) {
            await sendBotMessage(
              sock,
              chatId,
              { text: '⚠️ لا توجد أرقام محفوظة حالياً لتصديرها.' },
              { quoted: msg }
            );
            logIncomingMessage({
              chatId,
              senderId,
              isGroup,
              fromMe,
              typeLabel,
              preview,
              statusNote: 'نُفّذ أمر $ناتج (لا توجد أرقام)'
            });
            continue;
          }

          const content = rows.map((r) => r.phone).join('\n');
          const tempPath = path.join(__dirname, 'numbers_export.txt');
          fs.writeFileSync(tempPath, content, 'utf8');

          await sendBotMessage(
            sock,
            chatId,
            {
              document: fs.readFileSync(tempPath),
              mimetype: 'text/plain',
              fileName: 'numbers.txt',
              caption: `📁 تم استخراج *${rows.length}* رقم بنجاح.`
            },
            { quoted: msg }
          );

          fs.unlinkSync(tempPath);
          logIncomingMessage({
            chatId,
            senderId,
            isGroup,
            fromMe,
            typeLabel,
            preview,
            statusNote: `نُفّذ أمر $ناتج (تم إرسال ${rows.length} رقم)`
          });
          continue;
        }

        if (body === '$مسح') {
          if (!isGroup) {
            await sendBotMessage(
              sock,
              chatId,
              { text: '⚠️ هذا الأمر مخصص للمجموعات فقط.' },
              { quoted: msg }
            );
            logIncomingMessage({
              chatId,
              senderId,
              isGroup,
              fromMe,
              typeLabel,
              preview,
              statusNote: 'رُفض أمر $مسح (خارج مجموعة)'
            });
            continue;
          }

          const admin = await isSenderGroupAdmin(sock, chatId, senderId, fromMe);
          if (!admin) {
            await sendBotMessage(
              sock,
              chatId,
              { text: '🚫 عذراً، أمر *$مسح* متاح لإدارة المجموعة فقط.' },
              { quoted: msg }
            );
            logIncomingMessage({
              chatId,
              senderId,
              isGroup,
              fromMe,
              typeLabel,
              preview,
              statusNote: 'رُفض أمر $مسح (المرسل ليس مشرفاً)'
            });
            continue;
          }

          const info = clearAllStmt.run();
          await sendBotMessage(
            sock,
            chatId,
            { text: `🗑️ تم حذف جميع الأرقام المسجلة (تم حذف *${info.changes}* رقم).` },
            { quoted: msg }
          );
          logIncomingMessage({
            chatId,
            senderId,
            isGroup,
            fromMe,
            typeLabel,
            preview,
            statusNote: `نُفّذ أمر $مسح (حُذف ${info.changes} رقم)`
          });
          continue;
        }

        // --- 2. استقبال بطاقات الاتصال داخل المجموعات ---
        if (isGroup && extractedContacts.length > 0) {
          const statusLines = [];
          let addedCount = 0;
          let dupCount = 0;

          for (const item of extractedContacts) {
            const exists = getContactByPhoneStmt.get(item.phone);
            if (exists) {
              dupCount++;
              statusLines.push(`ℹ️ الرقم *${item.phone}* (${item.name}) مسجل مسبقاً.`);
            } else {
              const res = insertContactStmt.run({
                phone: item.phone,
                name: item.name,
                added_by: senderId,
                group_id: chatId
              });
              if (res.changes > 0) {
                addedCount++;
                statusLines.push(`✅ تم حفظ الرقم *${item.phone}* باسم: *${item.name}*`);
              } else {
                dupCount++;
                statusLines.push(`ℹ️ الرقم *${item.phone}* (${item.name}) مسجل مسبقاً.`);
              }
            }
          }

          await sendBotMessage(sock, chatId, { text: statusLines.join('\n') }, { quoted: msg });
          logIncomingMessage({
            chatId,
            senderId,
            isGroup,
            fromMe,
            typeLabel,
            preview,
            statusNote: `بطاقة اتصال (مضاف: ${addedCount} ، مكرر: ${dupCount})`
          });
          continue;
        }

        // --- 3. تسجيل أي رسالة أخرى تصل بشكل مرتب في اللوق ---
        logIncomingMessage({
          chatId,
          senderId,
          isGroup,
          fromMe,
          typeLabel,
          preview,
          statusNote: 'تمت القراءة والتعرف على الرسالة'
        });
      } catch (err) {
        origError('❌ خطأ أثناء معالجة الرسالة:', err?.message || err);
      }
    }
  });
}

startBot();
