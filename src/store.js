import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const pendingWrites = new Map();

function safeName(chatId) {
  return Buffer.from(String(chatId)).toString('base64url');
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function normalizeData(parsed = {}) {
  return {
    numbers: Array.isArray(parsed.numbers) ? [...new Set(parsed.numbers.filter(n => typeof n === 'string'))] : [],
    duplicatesRemoved: Math.max(0, Number(parsed.duplicatesRemoved) || 0),
    updatedAt: parsed.updatedAt ?? null
  };
}

export async function readChat(chatId) {
  await ensureDir();
  const file = path.join(DATA_DIR, `${safeName(chatId)}.json`);
  try {
    return normalizeData(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return { numbers: [], duplicatesRemoved: 0, updatedAt: null };
  }
}

async function writeChatUnlocked(chatId, numbers, duplicatesRemoved = 0) {
  await ensureDir();
  const file = path.join(DATA_DIR, `${safeName(chatId)}.json`);
  // Unique temp file prevents overlapping writes from clobbering one another.
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const payload = {
    numbers: [...new Set(numbers)],
    duplicatesRemoved: Math.max(0, Number(duplicatesRemoved) || 0),
    updatedAt: new Date().toISOString()
  };
  try {
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function serialize(chatId, task) {
  const key = String(chatId);
  const previous = pendingWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  pendingWrites.set(key, current);
  return current.finally(() => {
    if (pendingWrites.get(key) === current) pendingWrites.delete(key);
  });
}

export function writeChat(chatId, numbers, duplicatesRemoved = 0) {
  return serialize(chatId, () => writeChatUnlocked(chatId, numbers, duplicatesRemoved));
}

// Read-modify-write is serialized per chat so simultaneous WhatsApp batches
// cannot overwrite numbers added by another batch.
export function addNumbers(chatId, incomingNumbers, maxContacts = 500) {
  return serialize(chatId, async () => {
    const current = await readChat(chatId);
    const before = new Set(current.numbers);
    const incoming = [...new Set(incomingNumbers)];
    const added = incoming.filter(number => !before.has(number));
    const merged = [...before, ...added].slice(0, maxContacts);
    const overflow = Math.max(0, before.size + added.length - maxContacts);
    const duplicatesRemoved = current.duplicatesRemoved + (incomingNumbers.length - added.length);
    await writeChatUnlocked(chatId, merged, duplicatesRemoved);
    return {
      total: merged.length,
      added: merged.length - before.size,
      overflow,
      duplicatesRemoved
    };
  });
}

export function clearChat(chatId) {
  return serialize(chatId, () => writeChatUnlocked(chatId, [], 0));
}
