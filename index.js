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

// رقم الحساب الذي سيربط بالبوت بالصيغة الدولية بدون (+) أو أصفار بادئة
// مثال للعراق: '9647700000000' — أو مرره عبر متغير بيئة PHONE_NUMBER
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '9647700000000').replace(/\D/g, '');

// 1. إعداد قاعدة البيانات الدائمة (SQLite)
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

// 2. توحيد وتنظيف الأرقام لمنع التكرار
function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  let cleaned = String(rawPhone).replace(/[^\d+]/g, '');
  if (cleaned.startsWith('00')) {
    cleaned = cleaned.slice(2);
  }
  cleaned = cleaned.replace(/^\+/, '');
  return cleaned.length >= 7 ? cleaned : null;
}

// 3. استخراج الاسم والرقم من بطاقة vCard واحدة
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

// 4. استخراج البطاقات سواء كانت بطاقة واحدة أو عدة بطاقات
function extractContactsFromMessage(msgContent) {
  const extracted = [];
  if (!msgContent) return extracted;

  if (msgContent.contactMessage?.vcard) {
    extracted.push(...parseSingleVCard(msgContent.contactMessage.vcard));
  }

  if (msgContent.contactsArrayMessage?.contacts?.length) {
    for (const c of msgContent.contactsArrayMessage.contacts) {
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

// 5. استخراج نص الرسالة من مختلف أنواع الرسائل
function getMessageText(msgContent) {
  if (!msgContent) return '';
  return (
    msgContent.conversation ||
    msgContent.extendedTextMessage?.text ||
    msgContent.imageMessage?.caption ||
    msgContent.videoMessage?.caption ||
    ''
  ).trim();
}

// 6. التحقق من أن المرسل مشرف (Admin) داخل المجموعة
async function isSenderGroupAdmin(sock, groupJid, senderJid) {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    const participant = metadata.participants.find((p) => p.id === senderJid);
    return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
  } catch {
    return false;
  }
}

// 7. تشغيل البوت والربط عبر Pairing Code
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

  // طلب رمز الاقتران إذا لم يكن الحساب مسجلاً مسبقاً
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER || PHONE_NUMBER.length < 8) {
      console.error('❌ يرجى تحديد رقم الهاتف بالصيغة الدولية في PHONE_NUMBER (مثال: 9647700000000)');
      process.exit(1);
    }

    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(PHONE_NUMBER);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(`\n🔐 رمز الاقتران (Pairing Code) للرقم ${PHONE_NUMBER}: ${code}\n`);
        console.log('افتح واتساب > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف وأدخل الرمز.');
      } catch (err) {
        console.error('❌ فشل طلب رمز الاقتران:', err);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('✅ تم الاتصال بواتساب بنجاح والملفات محفوظة في ./auth_info');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ انقطع الاتصال (الرمز: ${statusCode}). إعادة الاتصال: ${shouldReconnect}`);
      if (shouldReconnect) {
        startBot();
      } else {
        console.log('🚫 تم تسجيل الخروج من الحساب. احذف مجلد auth_info وأعد الربط.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId || chatId === 'status@broadcast') continue;

        const isGroup = chatId.endsWith('@g.us');
        const senderId = isGroup ? msg.key.participant : chatId;
        const body = getMessageText(msg.message);

        // --- الأوامر النصية ---
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

          await sock.sendMessage(chatId, { text: helpText }, { quoted: msg });
          continue;
        }

        if (body === '$احسب') {
          const { total } = getCountStmt.get();
          await sock.sendMessage(
            chatId,
            { text: `📊 العدد الكلي للأرقام المسجلة: *${total}*` },
            { quoted: msg }
          );
          continue;
        }

        if (body === '$ناتج') {
          const rows = getAllPhonesStmt.all();
          if (rows.length === 0) {
            await sock.sendMessage(
              chatId,
              { text: '⚠️ لا توجد أرقام محفوظة حالياً لتصديرها.' },
              { quoted: msg }
            );
            continue;
          }

          const content = rows.map((r) => r.phone).join('\n');
          const tempPath = path.join(__dirname, 'numbers_export.txt');
          fs.writeFileSync(tempPath, content, 'utf8');

          await sock.sendMessage(
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
          continue;
        }

        if (body === '$مسح') {
          if (!isGroup) {
            await sock.sendMessage(
              chatId,
              { text: '⚠️ هذا الأمر مخصص للمجموعات فقط.' },
              { quoted: msg }
            );
            continue;
          }

          const admin = await isSenderGroupAdmin(sock, chatId, senderId);
          if (!admin) {
            await sock.sendMessage(
              chatId,
              { text: '🚫 عذراً، أمر *$مسح* متاح لإدارة المجموعة فقط.' },
              { quoted: msg }
            );
            continue;
          }

          const info = clearAllStmt.run();
          await sock.sendMessage(
            chatId,
            { text: `🗑️ تم حذف جميع الأرقام المسجلة (تم حذف *${info.changes}* رقم).` },
            { quoted: msg }
          );
          continue;
        }

        // --- استقبال بطاقات الاتصال (Contact / vCard) ---
        if (isGroup) {
          const extracted = extractContactsFromMessage(msg.message);
          if (extracted.length > 0) {
            const statusLines = [];

            for (const item of extracted) {
              const exists = getContactByPhoneStmt.get(item.phone);
              if (exists) {
                statusLines.push(`ℹ️ الرقم *${item.phone}* (${item.name}) مسجل مسبقاً.`);
              } else {
                const res = insertContactStmt.run({
                  phone: item.phone,
                  name: item.name,
                  added_by: senderId,
                  group_id: chatId
                });
                if (res.changes > 0) {
                  statusLines.push(`✅ تم حفظ الرقم *${item.phone}* باسم: *${item.name}*`);
                } else {
                  statusLines.push(`ℹ️ الرقم *${item.phone}* (${item.name}) مسجل مسبقاً.`);
                }
              }
            }

            await sock.sendMessage(chatId, { text: statusLines.join('\n') }, { quoted: msg });
          }
        }
      } catch (err) {
        console.error('❌ خطأ أثناء معالجة الرسالة:', err);
      }
    }
  });
}

startBot();
