const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, 'game.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  country_code TEXT UNIQUE,
  balance REAL NOT NULL DEFAULT 500,
  miner_rate REAL NOT NULL DEFAULT 700,
  last_collect INTEGER NOT NULL,
  shield_level INTEGER NOT NULL DEFAULT 0,
  attack_power INTEGER NOT NULL DEFAULT 1,
  net_down_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  price REAL NOT NULL,
  effect_value REAL NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_name TEXT,
  target_id TEXT,
  target_name TEXT,
  type TEXT NOT NULL,
  result TEXT NOT NULL,
  amount REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

const SHOP_SEED = [
  { id: 'shield1', name: 'سپر دفاعی سطح ۱', type: 'shield', price: 2000, effect_value: 1, description: 'کاهش شانس هک شدن' },
  { id: 'shield2', name: 'سپر دفاعی سطح ۲', type: 'shield', price: 6000, effect_value: 2, description: 'کاهش بیشتر شانس هک شدن' },
  { id: 'shield3', name: 'فایروال کوانتومی', type: 'shield', price: 15000, effect_value: 3, description: 'بالاترین سطح ضدهک' },
  { id: 'hacktool1', name: 'ابزار هک پایه', type: 'hack', price: 1500, effect_value: 1, description: 'امکان هک کردن کشورهای دیگر' },
  { id: 'hacktool2', name: 'تروجان پیشرفته', type: 'hack', price: 5000, effect_value: 2, description: 'افزایش موفقیت هک' },
  { id: 'ddos1', name: 'حمله‌ی قطع اینترنت', type: 'shutdown', price: 4000, effect_value: 10, description: 'قطع اینترنت کشور هدف به مدت ۱۰ دقیقه (ماینر متوقف می‌شود)' },
  { id: 'ddos2', name: 'حمله‌ی قطع اینترنت کلان', type: 'shutdown', price: 9000, effect_value: 25, description: 'قطع اینترنت کشور هدف به مدت ۲۵ دقیقه' },
  { id: 'weapon1', name: 'سلاح حمله سبک', type: 'attack', price: 3000, effect_value: 1, description: 'افزایش قدرت حمله' },
  { id: 'weapon2', name: 'سلاح حمله سنگین', type: 'attack', price: 8000, effect_value: 2, description: 'افزایش بیشتر قدرت حمله' },
  { id: 'minerboost1', name: 'ارتقای ماینر', type: 'miner', price: 10000, effect_value: 150, description: 'افزایش ۱۵۰ دلار به نرخ ماینر در ساعت' },
];

const insertItem = db.prepare(`INSERT OR IGNORE INTO shop_items (id,name,type,price,effect_value,description) VALUES (@id,@name,@type,@price,@effect_value,@description)`);
const seedTx = db.transaction((items) => { for (const it of items) insertItem.run(it); });
seedTx(SHOP_SEED);

module.exports = db;
