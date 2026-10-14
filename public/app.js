let token = localStorage.getItem('ww_token') || null;
let me = null;
let countries = [];
let isRegisterMode = false;
let countryPos = {}; // code -> {x,y}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg, cls='') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  opts.headers['Content-Type'] = 'application/json';
  if (token) opts.headers['Authorization'] = token;
  if (opts.body) opts.body = JSON.stringify(opts.body);
  const res = await fetch('/api' + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'خطا');
  return data;
}

// ---------- AUTH ----------
$('#switch-mode').onclick = () => {
  isRegisterMode = !isRegisterMode;
  $('#btn-submit').textContent = isRegisterMode ? 'ثبت‌نام' : 'ورود';
  $('#switch-mode').innerHTML = isRegisterMode
    ? 'حساب داری؟ <span>وارد شو</span>'
    : 'حساب نداری؟ <span>ثبت‌نام کن</span>';
};

$('#btn-submit').onclick = async () => {
  const username = $('#in-username').value.trim();
  const password = $('#in-password').value;
  $('#auth-err').textContent = '';
  try {
    const data = await api(isRegisterMode ? '/register' : '/login', {
      method: 'POST', body: { username, password }
    });
    token = data.token;
    localStorage.setItem('ww_token', token);
    me = data.user;
    startGame();
  } catch (e) {
    $('#auth-err').textContent = e.message;
  }
};

// ---------- TABS ----------
$$('#tabs button').forEach(btn => {
  btn.onclick = () => {
    $$('#tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['map','shop','inventory','leaderboard','log'].forEach(t => {
      $('#tab-' + t).classList.toggle('hidden', t !== btn.dataset.tab);
    });
    if (btn.dataset.tab === 'shop') loadShop();
    if (btn.dataset.tab === 'inventory') loadInventory();
    if (btn.dataset.tab === 'leaderboard') loadLeaderboard();
    if (btn.dataset.tab === 'log') loadLog();
  };
});

// ---------- HUD ----------
function renderHud() {
  $('#hud-username').textContent = me.username;
  $('#hud-country').textContent = me.country_code || 'انتخاب نشده';
  const balEl = $('#balance');
  balEl.textContent = '$' + Math.round(me.balance).toLocaleString();
  balEl.classList.remove('pulse'); void balEl.offsetWidth; balEl.classList.add('pulse');
  $('#hud-rate').textContent = '$' + me.miner_rate + '/h';
  $('#hud-shield').textContent = me.shield_level;
  $('#hud-atk').textContent = me.attack_power;
}

$('#btn-collect').onclick = async () => {
  try {
    const data = await api('/collect', { method: 'POST' });
    me = data.user;
    renderHud();
    toast('💰 موجودی برداشت شد!');
  } catch (e) { toast(e.message); }
};

// live ticking balance estimate between collects (visual only)
setInterval(() => {
  if (!me || !me.country_code) return;
  const down = me.net_down_until && me.net_down_until > Date.now();
  if (down) return;
  const perMs = me.miner_rate / 3600000;
  me.balance += perMs * 1000;
  $('#balance').textContent = '$' + Math.round(me.balance).toLocaleString();
}, 1000);

// ---------- MAP ----------
async function loadCountries() {
  const data = await api('/countries');
  countries = data.countries;
  const nodes = $('#nodes');
  nodes.innerHTML = '';
  countries.forEach(c => {
    countryPos[c.code] = { x: c.x, y: c.y };
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'country-node' + (c.taken ? ' taken' : '') + (me && c.taken && c.taken.ownerId === me.id ? ' mine' : ''));
    g.setAttribute('data-code', c.code);
    g.innerHTML = `
      <circle class="ring" cx="${c.x}" cy="${c.y}" r="6"></circle>
      <circle cx="${c.x}" cy="${c.y}" r="6"></circle>
      <text x="${c.x}" y="${c.y - 10}">${c.name}</text>
    `;
    g.onclick = () => showCountry(c.code);
    nodes.appendChild(g);
  });
}

function showCountry(code) {
  const c = countries.find(x => x.code === code);
  if (!c) return;
  const info = $('#countryInfo');
  info.style.display = 'block';
  const isMine = me.country_code === code;
  const isTaken = !!c.taken;

  if (!me.country_code) {
    info.innerHTML = `<h3>${c.name}</h3><p>این کشور ${isTaken ? 'توسط ' + c.taken.owner + ' گرفته شده' : 'آزاده'}</p>
      ${!isTaken ? `<button id="selBtn">انتخاب این کشور</button>` : ''}`;
    if (!isTaken) $('#selBtn').onclick = async () => {
      try {
        const data = await api('/select-country', { method: 'POST', body: { code } });
        me = data.user; renderHud(); loadCountries();
        toast('🏁 کشور ' + c.name + ' انتخاب شد!');
      } catch (e) { toast(e.message); }
    };
    return;
  }

  if (isMine) {
    info.innerHTML = `<h3>${c.name} (کشور شما)</h3><p>نرخ ماینر: $${me.miner_rate}/ساعت</p><p>سپر: ${me.shield_level} | قدرت حمله: ${me.attack_power}</p>`;
    return;
  }

  if (!isTaken) {
    info.innerHTML = `<h3>${c.name}</h3><p>این کشور هنوز گرفته نشده (فقط بازیکنان بدون کشور می‌توانند آن را انتخاب کنند)</p>`;
    return;
  }

  info.innerHTML = `<h3>${c.name} — بازیکن: ${c.taken.owner}</h3>
    <div class="target-actions">
      <button class="act-hack" data-act="hack">🕵️ هک</button>
      <button class="act-shutdown" data-act="shutdown">🔌 قطع اینترنت</button>
      <button class="act-attack" data-act="attack">⚔️ حمله نظامی</button>
    </div>`;
  info.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = () => doAction(btn.dataset.act, c);
  });
}

async function doAction(act, targetCountry) {
  const targetId = targetCountry.taken.ownerId;
  try {
    let data;
    if (act === 'hack') {
      data = await api('/action/hack', { method: 'POST', body: { targetId, itemId: 'hacktool1' } });
      fireBeam(me.country_code, targetCountry.code, data.success);
      toast(data.success ? `✅ هک موفق! $${data.amountStolen} سرقت شد` : '❌ هک ناموفق بود', data.success ? 'ok':'fail');
    } else if (act === 'shutdown') {
      data = await api('/action/shutdown', { method: 'POST', body: { targetId, itemId: 'ddos1' } });
      fireBeam(me.country_code, targetCountry.code, !data.blocked);
      toast(!data.blocked ? `🔌 اینترنت ${targetCountry.name} قطع شد!` : '🛡️ حمله دفع شد', !data.blocked ? 'ok':'fail');
    } else if (act === 'attack') {
      data = await api('/action/attack', { method: 'POST', body: { targetId } });
      fireBeam(me.country_code, targetCountry.code, data.success);
      toast(data.success ? `⚔️ حمله موفق! $${data.amountStolen} غنیمت` : '🛡️ حمله دفع شد', data.success ? 'ok':'fail');
    }
    me = data.user; renderHud();
  } catch (e) { toast(e.message); }
}

function fireBeam(fromCode, toCode, success) {
  const from = countryPos[fromCode], to = countryPos[toCode];
  if (!from || !to) return;
  const beams = $('#beams');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', from.x); line.setAttribute('y1', from.y);
  line.setAttribute('x2', to.x); line.setAttribute('y2', to.y);
  line.setAttribute('class', 'attack-beam fire');
  line.style.stroke = success ? 'var(--accent2)' : '#555';
  beams.appendChild(line);
  setTimeout(() => line.remove(), 1000);
}

// ---------- SHOP ----------
async function loadShop() {
  const data = await api('/shop');
  const grid = $('#shopGrid');
  grid.innerHTML = '';
  data.items.forEach(it => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<h3>${it.name}</h3><p>${it.description}</p><p class="price">$${it.price.toLocaleString()}</p>
      <button>خرید</button>`;
    div.querySelector('button').onclick = async () => {
      try {
        const res = await api('/shop/buy', { method: 'POST', body: { itemId: it.id } });
        me = res.user; renderHud();
        toast('🛒 خریداری شد: ' + it.name);
      } catch (e) { toast(e.message); }
    };
    grid.appendChild(div);
  });
}

// ---------- INVENTORY ----------
async function loadInventory() {
  const data = await api('/inventory');
  const el = $('#invList');
  el.innerHTML = data.inventory.length ? '' : '<p style="color:var(--muted)">کوله‌پشتی خالی است</p>';
  data.inventory.forEach(it => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<span>${it.name}</span><span>تعداد: ${it.qty}</span>`;
    el.appendChild(row);
  });
}

// ---------- LEADERBOARD ----------
async function loadLeaderboard() {
  const data = await api('/leaderboard');
  const el = $('#lbList');
  el.innerHTML = '';
  data.leaderboard.forEach((u, i) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<span>#${i+1} ${u.username} (${u.country_code||'-'})</span><span>$${u.balance.toLocaleString()}</span>`;
    el.appendChild(row);
  });
}

// ---------- LOG ----------
async function loadLog() {
  const data = await api('/events');
  const el = $('#log');
  el.innerHTML = '';
  data.events.forEach(ev => {
    const div = document.createElement('div');
    const okClass = (ev.result === 'success') ? 'ok' : 'fail';
    div.innerHTML = `<span class="${okClass}">${ev.type.toUpperCase()}</span> — ${ev.actor_name || '?'} → ${ev.target_name || '?'} (${ev.result})`;
    el.appendChild(div);
  });
}

// ---------- SOCKET ----------
function initSocket() {
  const socket = io();
  socket.on('game-event', (ev) => {
    const label = { hack: '🕵️ هک', shutdown: '🔌 قطع اینترنت', attack: '⚔️ حمله' }[ev.type] || ev.type;
    toast(`${label}: ${ev.actor} → ${ev.target} (${ev.result === 'success' ? 'موفق' : 'ناموفق'})`, ev.result === 'success' ? 'ok' : 'fail');
    if (ev.actor === me?.country_code) return;
    loadCountries();
  });
  socket.on('country-taken', () => loadCountries());
}

// ---------- BOOT ----------
async function startGame() {
  $('#auth').classList.add('hidden');
  $('#game').classList.remove('hidden');
  renderHud();
  await loadCountries();
  initSocket();
}

(async function boot() {
  if (token) {
    try {
      const data = await api('/me');
      me = data.user;
      startGame();
    } catch (e) {
      localStorage.removeItem('ww_token');
      token = null;
    }
  }
})();
