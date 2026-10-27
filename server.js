// Сервер: раздаёт редактор и создаёт пак эмодзи через Bot API.
// Токен бота приходит в запросе, используется только для этого запроса и не сохраняется.
// Запуск: node server.js   (порт по умолчанию 3000, переменная PORT)

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 25 * 1024 * 1024;
const TGS_MAX_BYTES = 64 * 1024;   // лимит Telegram для анимированного эмодзи
const MAX_SECONDS = 3;
const MAX_FPS = 60;
const SIZE = 100;                  // эмодзи Telegram: 100×100 в TGS

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// ---------- проверка TGS ----------
function checkTgs(buf) {
  if (buf.length > TGS_MAX_BYTES) return `файл ${buf.length} байт, лимит 64 КБ`;
  let json;
  try { json = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); }
  catch (e) { return 'не TGS: нужен gzip от Lottie JSON'; }
  if (json.w !== 512 && json.w !== SIZE) return `ширина ${json.w}, нужна 512 или 100`;
  if (json.h !== json.w) return 'холст должен быть квадратным';
  if (json.fr > MAX_FPS) return `${json.fr} fps, максимум ${MAX_FPS}`;
  const seconds = (json.op - json.ip) / json.fr;
  if (!(seconds > 0 && seconds <= MAX_SECONDS)) return `длительность ${seconds.toFixed(2)} с, максимум ${MAX_SECONDS}`;
  return null;
}

// ---------- Bot API ----------
async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

// multipart вручную, чтобы не тянуть зависимости
async function uploadSticker(token, userId, tgsBuf) {
  const boundary = '----emoji' + Date.now().toString(16);
  const head = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(head('user_id', userId)),
    Buffer.from(head('sticker_format', 'tgs')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sticker"; filename="emoji.tgs"\r\nContent-Type: application/x-tgsticker\r\n\r\n`),
    tgsBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`https://api.telegram.org/bot${token}/uploadStickerFile`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`uploadStickerFile: ${data.description}`);
  return data.result.file_id;
}

// Имя пака: латиница, цифры, _, начинается с буквы, заканчивается на _by_<username бота>
function packName(slug, botUsername) {
  const base = slug.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '') || 'pack';
  return `${base.slice(0, 40)}_by_${botUsername}`;
}

async function createPack(input) {
  const { token, userId, slug, title, stickers } = input;
  if (!token || !userId || !title || !Array.isArray(stickers) || !stickers.length) throw new Error('нужны token, userId, title и хотя бы один стикер');
  if (stickers.length > 200) throw new Error('в одном паке не больше 200 эмодзи');

  const bot = await tg(token, 'getMe');
  const name = packName(slug || title, bot.username);

  const prepared = [];
  for (const s of stickers) {
    const buf = Buffer.from(s.tgs, 'base64');
    const problem = checkTgs(buf);
    if (problem) throw new Error(`эмодзи ${s.emoji}: ${problem}`);
    const fileId = await uploadSticker(token, userId, buf);
    prepared.push({ sticker: fileId, format: 'animated', emoji_list: [s.emoji || '🙂'] });
  }

  await tg(token, 'createNewStickerSet', {
    user_id: Number(userId),
    name,
    title: title.slice(0, 64),
    stickers: [prepared[0]],
    sticker_type: 'custom_emoji',
  });
  for (const s of prepared.slice(1)) {
    await tg(token, 'addStickerToSet', { user_id: Number(userId), name, sticker: s });
  }
  return { name, link: `https://t.me/addemoji/${name}`, count: prepared.length };
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/pack') {
    try {
      const input = JSON.parse(await readBody(req));
      const result = await createPack(input);
      send(res, 200, { ok: true, ...result });
    } catch (e) {
      // токен в ответе и логах не показываем
      send(res, 400, { ok: false, error: String(e.message).replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot***') });
    }
    return;
  }

  if (req.method === 'GET') {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  res.writeHead(405); res.end();
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Emoji Studio: http://localhost:${PORT}`));
}

module.exports = { checkTgs, packName };
