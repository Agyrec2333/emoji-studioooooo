// Создаёт пак эмодзи из .tgs-файлов в папке репозитория через Bot API.
// Использование: node scripts/create-pack.js <папка> <user_id> <название> <короткое_имя>
// Токен берётся из переменной окружения TG_BOT_TOKEN (GitHub Secret), в логи не выводится.
// В папке можно положить emoji.json: [{"file": "smile.tgs", "emoji": "🙂"}]. Без него все .tgs получают 🙂.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TOKEN = process.env.TG_BOT_TOKEN;
const [dirArg, userId, title, slug] = process.argv.slice(2);
const TGS_MAX_BYTES = 64 * 1024;
const MAX_SECONDS = 3;
const MAX_FPS = 60;

const fail = msg => { console.error('Ошибка: ' + msg.replace(/[0-9]+:[A-Za-z0-9_-]{20,}/g, '***')); process.exit(1); };

if (!TOKEN) fail('не задан TG_BOT_TOKEN');
if (!dirArg || !userId || !title || !slug) fail('нужны: папка, user_id, название, короткое имя');

const dir = path.normalize(dirArg);
if (!dir.startsWith('packs' + path.sep) || dir.includes('..')) fail('папка должна быть внутри packs/');
if (!fs.existsSync(dir)) fail(`нет папки ${dir}`);

function checkTgs(buf) {
  if (buf.length > TGS_MAX_BYTES) return `${buf.length} байт, лимит 64 КБ`;
  let json;
  try { json = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); }
  catch (e) { return 'не TGS (нужен gzip от Lottie JSON)'; }
  if (json.w !== json.h || (json.w !== 512 && json.w !== 100)) return `холст ${json.w}×${json.h}, нужен квадрат 512 или 100`;
  if (json.fr > MAX_FPS) return `${json.fr} fps, максимум ${MAX_FPS}`;
  const sec = (json.op - json.ip) / json.fr;
  if (!(sec > 0 && sec <= MAX_SECONDS)) return `длительность ${sec.toFixed(2)} с, максимум ${MAX_SECONDS}`;
  return null;
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

async function uploadSticker(buf) {
  const boundary = '----emoji' + Date.now().toString(16);
  const field = (n, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const body = Buffer.concat([
    Buffer.from(field('user_id', userId)),
    Buffer.from(field('sticker_format', 'tgs')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sticker"; filename="emoji.tgs"\r\nContent-Type: application/x-tgsticker\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/uploadStickerFile`, {
    method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`uploadStickerFile: ${data.description}`);
  return data.result.file_id;
}

(async () => {
  const mapPath = path.join(dir, 'emoji.json');
  const map = fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, 'utf8')) : null;
  const files = map ? map.map(m => m.file) : fs.readdirSync(dir).filter(f => f.endsWith('.tgs')).sort();
  if (!files.length) fail('в папке нет .tgs-файлов');
  if (files.length > 200) fail('в одном паке не больше 200 эмодзи');

  // Проверяем все файлы до отправки, чтобы не создать полупустой пак
  const items = files.map(f => {
    const buf = fs.readFileSync(path.join(dir, f));
    const problem = checkTgs(buf);
    if (problem) fail(`${f}: ${problem}`);
    const emoji = map ? map.find(m => m.file === f).emoji : '🙂';
    return { buf, emoji, file: f };
  });

  const bot = await tg('getMe');
  const base = slug.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').slice(0, 40) || 'pack';
  const name = `${base}_by_${bot.username}`;

  const prepared = [];
  for (const it of items) {
    const id = await uploadSticker(it.buf);
    prepared.push({ sticker: id, format: 'animated', emoji_list: [it.emoji] });
    console.log(`загружен ${it.file}`);
  }
  await tg('createNewStickerSet', { user_id: Number(userId), name, title: title.slice(0, 64), stickers: [prepared[0]], sticker_type: 'custom_emoji' });
  for (const s of prepared.slice(1)) await tg('addStickerToSet', { user_id: Number(userId), name, sticker: s });
  console.log(`Готово: https://t.me/addemoji/${name} (${prepared.length} эмодзи)`);
})().catch(e => fail(e.message));
