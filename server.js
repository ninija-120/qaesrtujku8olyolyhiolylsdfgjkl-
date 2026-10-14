const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');
const COUNTRIES = require('./countries');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- simple token-based sessions (in-memory map token -> userId) ----
const sessions = new Map();
function authMiddleware(req, res, next) {
  const token = req.headers['authorization'];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'نیاز به ورود دارید' });
  req.userId = sessions.get(token);
  next();
}

function nowMs() { return Date.now(); }

function userPublic(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    country_code: u.country_code,
    balance: Math.round(u.balance * 100) / 100,
    miner_rate: u.miner_rate,
    shield_level: u.shield_level,
    attack_power: u.attack_power,
    net_down_until: u.net_down_until,
  };
}

// Accrue mined money since last_collect, respecting net_down_until (shutdown periods pause mining)
function accrue(user) {
  const t = nowMs();
  if (!user.country_code) { user.last_collect = t; return user; }
  let elapsedMs = t - user.last_collect;
  if (elapsedMs <= 0) return user;
  // if currently shut down, only count time before shutdown started being active... simplified: if still down now, no mining since last_collect to now within down window
  if (user.net_down_until > t) {
    // fully down right now; nothing mined since last_collect is still owed only for the portion before downtime started.
    // Simplify: if last_collect happened after downtime started, no mining accrues.
    elapsedMs = Math.max(0, user.net_down_until - user.last_collect) >= elapsedMs ? 0 : elapsedMs;
  }
  const hours = elapsedMs / 3600000;
  const earned = hours * user.miner_rate;
  user.balance += earned;
  user.last_collect = t;
  db.prepare('UPDATE users SET balance=?, last_collect=? WHERE id=?').run(user.balance, user.last_collect, user.id);
  return user;
}

function getUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  return u ? accrue(u) : null;
}

function logEvent({ actor, target, type, result, amount }) {
  db.prepare(`INSERT INTO logs (id,actor_id,actor_name,target_id,target_name,type,result,amount,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uuidv4(), actor?.id || null, actor?.username || null, target?.id || null, target?.username || null, type, result, amount || 0, nowMs());
}

// ---------------- AUTH ----------------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'نام کاربری یا رمز عبور نامعتبر است' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  if (exists) return res.status(400).json({ error: 'این نام کاربری قبلاً گرفته شده' });
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id,username,password_hash,balance,miner_rate,last_collect,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, username, hash, 500, 700, nowMs(), nowMs());
  const token = uuidv4();
  sessions.set(token, id);
  res.json({ token, user: userPublic(getUser(id)) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(400).json({ error: 'نام کاربری یا رمز عبور اشتباه است' });
  }
  const token = uuidv4();
  sessions.set(token, u.id);
  res.json({ token, user: userPublic(getUser(u.id)) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: userPublic(getUser(req.userId)) });
});

// ---------------- COUNTRIES ----------------
app.get('/api/countries', (req, res) => {
  const taken = db.prepare('SELECT country_code, username, id FROM users WHERE country_code IS NOT NULL').all();
  const takenMap = Object.fromEntries(taken.map(t => [t.country_code, { owner: t.username, ownerId: t.id }]));
  const list = COUNTRIES.map(c => ({ ...c, taken: takenMap[c.code] || null }));
  res.json({ countries: list });
});

app.post('/api/select-country', authMiddleware, (req, res) => {
  const { code } = req.body || {};
  const country = COUNTRIES.find(c => c.code === code);
  if (!country) return res.status(400).json({ error: 'کشور نامعتبر است' });
  const already = db.prepare('SELECT id FROM users WHERE country_code=?').get(code);
  if (already) return res.status(400).json({ error: 'این کشور قبلاً انتخاب شده' });
  const user = getUser(req.userId);
  if (user.country_code) return res.status(400).json({ error: 'شما قبلاً یک کشور انتخاب کرده‌اید' });
  db.prepare('UPDATE users SET country_code=? WHERE id=?').run(code, user.id);
  io.emit('country-taken', { code, username: user.username });
  res.json({ user: userPublic(getUser(user.id)) });
});

// ---------------- SHOP ----------------
app.get('/api/shop', (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM shop_items').all() });
});

app.post('/api/shop/buy', authMiddleware, (req, res) => {
  const { itemId } = req.body || {};
  const item = db.prepare('SELECT * FROM shop_items WHERE id=?').get(itemId);
  if (!item) return res.status(400).json({ error: 'کالا پیدا نشد' });
  const user = getUser(req.userId);
  if (user.balance < item.price) return res.status(400).json({ error: 'موجودی کافی نیست' });
  const newBalance = user.balance - item.price;
  db.prepare('UPDATE users SET balance=? WHERE id=?').run(newBalance, user.id);

  if (item.type === 'shield') {
    db.prepare('UPDATE users SET shield_level = shield_level + ? WHERE id=?').run(item.effect_value, user.id);
  } else if (item.type === 'attack') {
    db.prepare('UPDATE users SET attack_power = attack_power + ? WHERE id=?').run(item.effect_value, user.id);
  } else if (item.type === 'miner') {
    db.prepare('UPDATE users SET miner_rate = miner_rate + ? WHERE id=?').run(item.effect_value, user.id);
  } else {
    // hack / shutdown tools go into inventory as consumable charges
    const existing = db.prepare('SELECT * FROM inventory WHERE user_id=? AND item_id=?').get(user.id, item.id);
    if (existing) db.prepare('UPDATE inventory SET qty=qty+1 WHERE user_id=? AND item_id=?').run(user.id, item.id);
    else db.prepare('INSERT INTO inventory (user_id,item_id,qty) VALUES (?,?,1)').run(user.id, item.id);
  }
  res.json({ user: userPublic(getUser(user.id)) });
});

app.get('/api/inventory', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT inv.item_id, inv.qty, si.name, si.type, si.description
    FROM inventory inv JOIN shop_items si ON si.id = inv.item_id
    WHERE inv.user_id=? AND inv.qty > 0`).all(req.userId);
  res.json({ inventory: rows });
});

// ---------------- COLLECT ----------------
app.post('/api/collect', authMiddleware, (req, res) => {
  const user = getUser(req.userId); // accrue() already ran inside getUser
  res.json({ user: userPublic(user) });
});

// ---------------- LEADERBOARD ----------------
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare('SELECT id, username, country_code, balance FROM users ORDER BY balance DESC LIMIT 20').all();
  res.json({ leaderboard: rows.map(r => ({ ...r, balance: Math.round(r.balance * 100) / 100 })) });
});

// ---------------- HACK / SHUTDOWN / ATTACK ----------------
function useConsumable(userId, itemId) {
  const row = db.prepare('SELECT * FROM inventory WHERE user_id=? AND item_id=?').get(userId, itemId);
  if (!row || row.qty < 1) return false;
  db.prepare('UPDATE inventory SET qty=qty-1 WHERE user_id=? AND item_id=?').run(userId, itemId);
  return true;
}

app.post('/api/action/hack', authMiddleware, (req, res) => {
  const { targetId, itemId } = req.body || {};
  const actor = getUser(req.userId);
  const target = getUser(targetId);
  if (!target || target.id === actor.id) return res.status(400).json({ error: 'هدف نامعتبر است' });
  if (!useConsumable(actor.id, itemId || 'hacktool1')) return res.status(400).json({ error: 'ابزار هک کافی ندارید (از فروشگاه بخرید)' });

  const item = db.prepare('SELECT * FROM shop_items WHERE id=?').get(itemId || 'hacktool1');
  const hackPower = item ? item.effect_value : 1;
  const successChance = Math.max(0.1, Math.min(0.9, 0.5 + 0.15 * hackPower - 0.12 * target.shield_level));
  const success = Math.random() < successChance;

  let amountStolen = 0;
  if (success) {
    amountStolen = Math.round(target.balance * 0.1 * 100) / 100;
    db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(amountStolen, target.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amountStolen, actor.id);
  }
  logEvent({ actor, target, type: 'hack', result: success ? 'success' : 'failed', amount: amountStolen });
  io.emit('game-event', {
    type: 'hack', result: success ? 'success' : 'failed',
    actor: actor.username, target: target.username, amount: amountStolen,
  });
  res.json({ success, amountStolen, user: userPublic(getUser(actor.id)) });
});

app.post('/api/action/shutdown', authMiddleware, (req, res) => {
  const { targetId, itemId } = req.body || {};
  const actor = getUser(req.userId);
  const target = getUser(targetId);
  if (!target || target.id === actor.id) return res.status(400).json({ error: 'هدف نامعتبر است' });
  if (!useConsumable(actor.id, itemId)) return res.status(400).json({ error: 'ابزار قطع اینترنت کافی ندارید' });

  const item = db.prepare('SELECT * FROM shop_items WHERE id=?').get(itemId);
  const minutes = item ? item.effect_value : 10;
  const blockChance = Math.max(0.05, 0.4 - 0.1 * target.shield_level);
  const blocked = Math.random() < blockChance;

  let until = target.net_down_until;
  if (!blocked) {
    until = Math.max(nowMs(), target.net_down_until) + minutes * 60000;
    db.prepare('UPDATE users SET net_down_until=? WHERE id=?').run(until, target.id);
  }
  logEvent({ actor, target, type: 'shutdown', result: blocked ? 'blocked' : 'success', amount: minutes });
  io.emit('game-event', {
    type: 'shutdown', result: blocked ? 'blocked' : 'success',
    actor: actor.username, target: target.username, minutes,
  });
  res.json({ blocked, until, user: userPublic(getUser(actor.id)) });
});

app.post('/api/action/attack', authMiddleware, (req, res) => {
  const { targetId } = req.body || {};
  const actor = getUser(req.userId);
  const target = getUser(targetId);
  if (!target || target.id === actor.id) return res.status(400).json({ error: 'هدف نامعتبر است' });

  const atk = actor.attack_power + Math.random() * 2;
  const def = target.shield_level + Math.random() * 2;
  const success = atk > def;
  let amountStolen = 0;
  if (success) {
    amountStolen = Math.round(target.balance * 0.07 * 100) / 100;
    db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(amountStolen, target.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amountStolen, actor.id);
  }
  logEvent({ actor, target, type: 'attack', result: success ? 'success' : 'failed', amount: amountStolen });
  io.emit('game-event', {
    type: 'attack', result: success ? 'success' : 'failed',
    actor: actor.username, target: target.username, amount: amountStolen,
  });
  res.json({ success, amountStolen, user: userPublic(getUser(actor.id)) });
});

app.get('/api/events', (req, res) => {
  const rows = db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT 30').all();
  res.json({ events: rows });
});

io.on('connection', (socket) => {
  // presence only; all game state goes through REST + broadcast events
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`World War game server running on port ${PORT}`));
