const digits = (value = '') => String(value).replace(/\D/g, '');

function normalizePhone(raw, defaultCountryCode) {
  if (!raw) return null;
  let value = String(raw).trim();
  // Remove vCard extensions and common formatting characters.
  value = value.replace(/\\[nN].*$/g, '').replace(/\s*(ext\.?|x|#)\s*\d+$/i, '');
  const hadPlus = value.startsWith('+');
  let number = digits(value);
  if (!number) return null;

  if (number.startsWith('00')) number = number.slice(2);
  else if (number.startsWith('0')) number = digits(defaultCountryCode) + number.slice(1);
  else if (!hadPlus && defaultCountryCode && number.length <= 10) {
    number = digits(defaultCountryCode) + number;
  }

  if (number.length < 7 || number.length > 15) return null;
  return `+${number}`;
}

export function extractPhonesFromVCard(vcard, defaultCountryCode) {
  if (typeof vcard !== 'string') return [];
  const found = [];
  const lines = vcard.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (!/^TEL(?:;[^:]*)?:/i.test(line.trim())) continue;
    const raw = line.slice(line.indexOf(':') + 1).trim();
    const normalized = normalizePhone(raw, defaultCountryCode);
    if (normalized) found.push(normalized);
  }
  return [...new Set(found)];
}

export function extractPhonesFromMessage(message, defaultCountryCode) {
  const content = message?.message;
  if (!content) return [];
  const cards = [];
  if (content.contactMessage?.vcard) cards.push(content.contactMessage.vcard);
  const array = content.contactsArrayMessage?.contacts;
  if (Array.isArray(array)) {
    for (const item of array) if (item?.vcard) cards.push(item.vcard);
  }
  return [...new Set(cards.flatMap(card => extractPhonesFromVCard(card, defaultCountryCode)))];
}
