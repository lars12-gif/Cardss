import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');

function safeName(chatId) {
  return Buffer.from(String(chatId)).toString('base64url');
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function readChat(chatId) {
  await ensureDir();
  const file = path.join(DATA_DIR, `${safeName(chatId)}.json`);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return { numbers: Array.isArray(parsed.numbers) ? parsed.numbers : [], duplicatesRemoved: Number(parsed.duplicatesRemoved || 0), updatedAt: parsed.updatedAt ?? null };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return { numbers: [], duplicatesRemoved: 0, updatedAt: null };
  }
}

export async function writeChat(chatId, numbers, duplicatesRemoved = 0) {
  await ensureDir();
  const file = path.join(DATA_DIR, `${safeName(chatId)}.json`);
  const temp = `${file}.tmp`;
  const payload = { numbers: [...new Set(numbers)], duplicatesRemoved: Math.max(0, Number(duplicatesRemoved) || 0), updatedAt: new Date().toISOString() };
  await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(temp, file);
}

export async function clearChat(chatId) {
  await writeChat(chatId, [], 0);
}
