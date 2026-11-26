# إعداد سريع على Euizhost

- Runtime: Node.js 26 LTS إن كان متاحاً في لوحة الاستضافة.
- Install command: `npm install`
- Start command: `npm start`
- Environment variables: `BOT_NUMBER`, `DEFAULT_COUNTRY_CODE`, `MAX_CONTACTS`, `LOG_LEVEL`.
- Persistent storage مطلوب للمجلدين `.auth/` و`data/`.

إذا كانت الاستضافة لا تدعم Node.js 26، استخدم أحدث إصدار LTS متاح لديها يدعم Node.js 20 أو أحدث. لا تحذف مجلد `.auth` بعد نجاح الربط.
