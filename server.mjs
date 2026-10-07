import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, unlinkSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import net from 'node:net';
import {clientBundle, normalizeLang, te} from './i18n.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
function reqLang(req) {
  return normalizeLang(req.headers['x-savdo-lang'] || req.headers['accept-language']);
}
function E(req, key, vars) {
  return Error(te(reqLang(req), key, vars));
}
const dataDir = path.join(root, 'data');
const dbPath = path.join(dataDir, 'savdo.sqlite');
mkdirSync(dataDir, {recursive: true});
const db = new DatabaseSync(dbPath);

db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TJS',
  zone TEXT NOT NULL DEFAULT 'Asia/Dushanbe',
  low_stock INTEGER NOT NULL DEFAULT 5
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  cost INTEGER NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER NOT NULL CHECK(stock>=0),
  active INTEGER NOT NULL DEFAULT 1,
  image TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS movements(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER REFERENCES products(id),
  customer_id INTEGER REFERENCES customers(id),
  kind TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL,
  date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_ops(
  op_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_movements_user_date ON movements(user_id, date);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, customer_id);`);

for (const sql of [
  'ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE movements ADD COLUMN customer_id INTEGER REFERENCES customers(id)',
  'ALTER TABLE movements ADD COLUMN paid INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE movements ADD COLUMN batch TEXT',
  'ALTER TABLE movements ADD COLUMN doc_no TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE movements ADD COLUMN shift_id INTEGER',
  'ALTER TABLE movements ADD COLUMN supplier_id INTEGER',
  'ALTER TABLE movements ADD COLUMN pay_method TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE products ADD COLUMN barcode TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE products ADD COLUMN unit TEXT NOT NULL DEFAULT \'pcs\'',
  'ALTER TABLE products ADD COLUMN promo_price INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE products ADD COLUMN expiry TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE products ADD COLUMN stock2 INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE products ADD COLUMN wholesale_price INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE customers ADD COLUMN points INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN pin TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN void_pin TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN bonus_percent REAL NOT NULL DEFAULT 1',
  'ALTER TABLE users ADD COLUMN auto_backup INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE users ADD COLUMN last_backup TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN alert_low INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE users ADD COLUMN alert_expiry INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE users ADD COLUMN last_alert TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN low_stock INTEGER NOT NULL DEFAULT 5',
  'ALTER TABLE users ADD COLUMN sale_seq INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN vat_percent REAL NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN block_below_cost INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN telegram_token TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN telegram_chat TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN wh1_name TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN wh2_name TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT \'admin\'',
  'ALTER TABLE users ADD COLUMN owner_id INTEGER',
  'ALTER TABLE users ADD COLUMN active_shop_id INTEGER',
  'ALTER TABLE users ADD COLUMN printer_host TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN printer_port INTEGER NOT NULL DEFAULT 9100',
  'ALTER TABLE users ADD COLUMN printer_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN printer_width INTEGER NOT NULL DEFAULT 32',
  'ALTER TABLE users ADD COLUMN company_inn TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN company_address TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN company_phone TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN company_legal TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN locked_until TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN require_shift INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN fiscal_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN fiscal_reg TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN fiscal_serial TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN fiscal_seq INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN hub_url TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN hub_token TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE users ADD COLUMN biz_mode TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE movements ADD COLUMN fiscal_no TEXT NOT NULL DEFAULT \'\'',
  'ALTER TABLE shifts ADD COLUMN cashier_id INTEGER',
  'ALTER TABLE movements ADD COLUMN cashier_id INTEGER',
  `CREATE TABLE IF NOT EXISTS journal_entries(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    debit TEXT NOT NULL,
    credit TEXT NOT NULL,
    amount INTEGER NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_journal_user ON journal_entries(user_id, date)',
  `CREATE TABLE IF NOT EXISTS branch_snapshots(
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    shop_key TEXT NOT NULL,
    shop_name TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(owner_id, shop_key)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    actor_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at)',
  `CREATE TABLE IF NOT EXISTS suppliers(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_payments(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    amount INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_suppliers_user ON suppliers(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(user_id, barcode)',
  `CREATE TABLE IF NOT EXISTS shifts(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    open_cash INTEGER NOT NULL DEFAULT 0,
    close_cash INTEGER,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open'
  )`,
  `CREATE TABLE IF NOT EXISTS cash_moves(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    kind TEXT NOT NULL,
    amount INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_cash_moves_shift ON cash_moves(shift_id)'
]) {
  try { db.exec(sql); } catch {}
}

// Ensure critical columns exist (Render free DB may lag behind code).
try {
  const shiftCols = new Set(db.prepare('PRAGMA table_info(shifts)').all().map(c => c.name));
  if (!shiftCols.has('cashier_id')) db.exec('ALTER TABLE shifts ADD COLUMN cashier_id INTEGER');
} catch (e) {
  console.error('migrate shifts.cashier_id', e?.message || e);
}
try {
  const moveCols = new Set(db.prepare('PRAGMA table_info(movements)').all().map(c => c.name));
  if (!moveCols.has('cashier_id')) db.exec('ALTER TABLE movements ADD COLUMN cashier_id INTEGER');
} catch (e) {
  console.error('migrate movements.cashier_id', e?.message || e);
}

function lanUrls(port) {
  const urls = [`http://127.0.0.1:${port}`];
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) urls.push(`http://${n.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

// Legacy cash sales (before paid/customer columns): treat as fully paid
try {
  db.exec(`UPDATE movements SET paid = qty * price
    WHERE kind = 'sale' AND IFNULL(customer_id,0) = 0 AND paid = 0`);
} catch {}

const run = (q, ...a) => db.prepare(q).run(...a);
const all = (q, ...a) => db.prepare(q).all(...a);
const one = (q, ...a) => db.prepare(q).get(...a);

function hash(p, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(p, salt, 64).toString('hex');
}
function verify(p, h) {
  const [s, v] = h.split(':');
  return timingSafeEqual(Buffer.from(v, 'hex'), scryptSync(p, s, 64));
}
/**
 * Phone → canonical 9-digit TJ mobile: 9001112233
 * Accepts: 9001112233, +992 900 111 2233, 9929001112233, 09001112233
 */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('992')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  // Exactly 9 digits (e.g. 90xxxxxxx / 91xxxxxxx)
  if (d.length === 9) return d;
  return '';
}
function loginKeysFromBody(b) {
  const phone = normalizePhone(b.phone || b.login || '');
  const rawDigits = String(b.phone || b.login || '').replace(/\D/g, '');
  if (phone) {
    // Canonical + legacy forms that may already be in DB
    const keys = ['p:' + phone, 'p:992' + phone, 'p:0' + phone];
    if (rawDigits && rawDigits !== phone) keys.push('p:' + rawDigits);
    return [...new Set(keys)];
  }
  // Fallback: raw digits as stored before normalize fix
  if (rawDigits.length >= 9 && rawDigits.length <= 15) {
    return ['p:' + rawDigits];
  }
  const email = String(b.email || '').trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [email];
  return [];
}
function loginKeyFromBody(b) {
  return loginKeysFromBody(b)[0] || '';
}
function phoneFromLoginKey(key) {
  const k = String(key || '');
  if (!k.startsWith('p:')) return '';
  return normalizePhone(k.slice(2)) || k.slice(2).replace(/\D/g, '');
}
function findUserByLoginKeys(keys) {
  for (const key of keys) {
    const u = one(`SELECT * FROM users WHERE email=? AND IFNULL(role,'')!='branch'`, key);
    if (u) return u;
  }
  // Legacy rows: phone stored without p: prefix or with odd zeros/992.
  const want = keys.map(k => normalizePhone(String(k).replace(/^p:/, ''))).find(Boolean);
  if (!want) return null;
  const rows = all(`SELECT * FROM users WHERE IFNULL(role,'')!='branch' AND email LIKE 'p:%'`);
  for (const u of rows) {
    const got = normalizePhone(String(u.email || '').replace(/^p:/, ''));
    if (got && got === want) return u;
  }
  const bare = one(`SELECT * FROM users WHERE email=? AND IFNULL(role,'')!='branch'`, want);
  if (bare) return bare;
  return null;
}
function findUserByLogin(raw) {
  const keys = loginKeysFromBody(typeof raw === 'string' ? {phone: raw, email: raw} : (raw || {}));
  if (!keys.length) return null;
  return findUserByLoginKeys(keys);
}
function shopMemberCount(owner) {
  return one(
    `SELECT COUNT(*) AS n FROM users
     WHERE (id=? OR owner_id=?) AND IFNULL(role,'')!='branch'`,
    owner,
    owner
  ).n || 0;
}
function deleteShopAccount(owner) {
  const ids = all(
    `SELECT id FROM users WHERE id=? OR owner_id=?`,
    owner,
    owner
  ).map(r => r.id);
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  tx(() => {
    run(`DELETE FROM sessions WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM cash_moves WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM shifts WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM payments WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM supplier_payments WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM movements WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM products WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM customers WHERE user_id IN (${ph})`, ...ids);
    run(`DELETE FROM suppliers WHERE user_id IN (${ph})`, ...ids);
    try { run(`DELETE FROM journal_entries WHERE user_id IN (${ph})`, ...ids); } catch {}
    try { run(`DELETE FROM audit_log WHERE user_id IN (${ph})`, ...ids); } catch {}
    try { run(`DELETE FROM branch_snapshots WHERE owner_id=?`, owner); } catch {}
    try { run(`DELETE FROM sync_ops WHERE user_id IN (${ph})`, ...ids); } catch {}
    run(`DELETE FROM users WHERE id IN (${ph})`, ...ids);
  });
}
function today(u) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: u.zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function parseDate(u, value, lang = 'ru', lockedUntil = '') {
  const t = today(u);
  if (value === undefined || value === null || value === '') return t;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Error(te(lang, 'bad_date'));
  if (s > t) throw Error(te(lang, 'future_date'));
  const min = String(Number(t.slice(0, 4)) - 5).padStart(4, '0') + '-01-01';
  if (s < min) throw Error(te(lang, 'old_date'));
  const lock = String(lockedUntil || u.locked_until || '').trim();
  if (lock && /^\d{4}-\d{2}-\d{2}$/.test(lock) && s <= lock) {
    throw Error(te(lang, 'period_locked'));
  }
  return s;
}
function logAudit(shopUserId, actor, action, detail = '') {
  try {
    run(
      `INSERT INTO audit_log(user_id,actor_id,actor_name,action,detail,created_at)
       VALUES(?,?,?,?,?,?)`,
      shopUserId,
      actor?.id || null,
      String(actor?.name || '').slice(0, 100),
      String(action || '').slice(0, 60),
      String(detail || '').slice(0, 500),
      Date.now()
    );
  } catch {}
}
function tx(f) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = f();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
function isHttpsReq(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xf === 'https') return true;
  if (process.env.FORCE_SECURE_COOKIE === '1') return true;
  return !!req.socket?.encrypted;
}
function readRemoteUrl() {
  try {
    const p = path.join(dataDir, 'remote-url.txt');
    if (!existsSync(p)) return '';
    const u = String(readFileSync(p, 'utf8') || '')
      .trim()
      .split(/\r?\n/)[0]
      .trim();
    if (!/^https?:\/\/[^\s]+$/i.test(u)) return '';
    return u.replace(/\/$/, '');
  } catch {
    return '';
  }
}
function writeRemoteUrl(url) {
  const p = path.join(dataDir, 'remote-url.txt');
  if (!url) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {}
    return '';
  }
  writeFileSync(p, url + '\n', 'utf8');
  return url;
}
function session(res, id, req) {
  const t = randomBytes(32).toString('hex');
  run('INSERT INTO sessions VALUES(?,?,?)', t, id, Date.now() + 604800000);
  const secure = req && isHttpsReq(req);
  res.setHeader(
    'Set-Cookie',
    secure
      ? `savdo_session=${t}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=604800`
      : `savdo_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
  );
  return t;
}
function readSessionToken(req) {
  const cookieTok = /savdo_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  if (cookieTok) return cookieTok;
  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+([a-f0-9]+)$/i.exec(auth);
  if (m) return m[1];
  const hdr = String(req.headers['x-savdo-token'] || '').trim();
  if (/^[a-f0-9]+$/i.test(hdr)) return hdr;
  return '';
}
function ownerId(u) {
  return Number(u.owner_id) || u.id;
}
function shopId(u) {
  const owner = ownerId(u);
  const active = Number(u.active_shop_id) || owner;
  if (active === owner) return owner;
  const branch = one(
    `SELECT id FROM users WHERE id=? AND owner_id=? AND role='branch'`,
    active,
    owner
  );
  return branch ? active : owner;
}
function isAdmin(u) {
  const r = u.role || 'admin';
  return r !== 'cashier' && r !== 'branch';
}
/** Shop owner / director only (not staff cashiers or branch). */
function isDirector(u) {
  if (!u) return false;
  if ((u.role || '') === 'cashier' || (u.role || '') === 'branch') return false;
  return !Number(u.owner_id);
}
function requireDirector(u, lang) {
  if (!isDirector(u)) {
    const e = Error(te(lang, 'director_only'));
    e.status = 403;
    throw e;
  }
}
const ALL_PERMS = [
  'kassa', 'stock', 'customers', 'suppliers', 'cashbook', 'reports', 'analyze',
  'audit', 'settings', 'void', 'discount', 'import', 'backup', 'staff', 'shops',
  'accounting', 'fiscal', 'shift'
];
const DEFAULT_CASHIER_PERMS = ['kassa', 'shift'];
function parsePerms(u) {
  if (!u) return new Set();
  const role = u.role || 'admin';
  if (role === 'branch') return new Set();
  const raw = String(u.permissions || '').trim();
  let list = null;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) list = arr.filter(p => ALL_PERMS.includes(String(p)));
    } catch {}
  }
  if (role === 'cashier') {
    // Cashiers never get settings/reports — director only.
    const allowed = (list && list.length ? list : DEFAULT_CASHIER_PERMS)
      .filter(p => p !== 'settings' && p !== 'reports' && p !== 'staff' && p !== 'audit');
    return new Set(allowed.length ? allowed : DEFAULT_CASHIER_PERMS);
  }
  return new Set(list && list.length ? list : ALL_PERMS);
}
function can(u, perm) {
  if (!u) return false;
  if ((u.role || '') === 'branch') return false;
  if ((u.role || 'admin') !== 'cashier' && !Number(u.owner_id)) return true;
  return parsePerms(u).has(perm);
}
function requirePerm(u, perm, lang) {
  if (!can(u, perm)) {
    const e = Error(te(lang, 'no_access'));
    e.status = 403;
    throw e;
  }
}
function normalizePermsInput(role, perms) {
  let list = [];
  if (Array.isArray(perms)) list = perms.map(String);
  else if (typeof perms === 'string' && perms.trim()) {
    try { list = JSON.parse(perms); } catch { list = perms.split(/[,\s]+/); }
  }
  list = (Array.isArray(list) ? list : []).filter(p => ALL_PERMS.includes(p));
  if (role === 'admin' && !list.length) return '';
  if (role === 'cashier' && !list.length) list = DEFAULT_CASHIER_PERMS.slice();
  return JSON.stringify([...new Set(list)]);
}
function postJournal(shopUserId, date, debit, credit, amount, ref = '', note = '') {
  const n = Math.round(Number(amount) || 0);
  if (n <= 0) return;
  run(
    `INSERT INTO journal_entries(user_id,date,debit,credit,amount,ref,note,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    shopUserId, date, String(debit).slice(0, 40), String(credit).slice(0, 40),
    n, String(ref || '').slice(0, 60), String(note || '').slice(0, 200), Date.now()
  );
}
function postSaleAccounting(shopUserId, date, payable, costTotal, payMethod, docNo) {
  const asset = payMethod === 'card' ? 'Card' : payMethod === 'transfer' ? 'Bank' : payMethod === 'debt' ? 'AR' : 'Cash';
  if (payMethod === 'debt') postJournal(shopUserId, date, 'AR', 'Revenue', payable, docNo, 'Sale credit');
  else postJournal(shopUserId, date, asset, 'Revenue', payable, docNo, 'Sale');
  postJournal(shopUserId, date, 'COGS', 'Inventory', costTotal, docNo, 'COGS');
}
function nextFiscalNo(shop) {
  if (!Number(shop.fiscal_enabled)) return '';
  const seq = (Number(shop.fiscal_seq) || 0) + 1;
  run('UPDATE users SET fiscal_seq=? WHERE id=?', seq, shop.id);
  shop.fiscal_seq = seq;
  const reg = String(shop.fiscal_reg || '').trim() || 'FR';
  return `${reg}-${String(seq).padStart(6, '0')}`;
}
function accountingSummary(shopUserId, from, to) {
  const rows = all(
    `SELECT debit, credit, SUM(amount) AS v FROM journal_entries
     WHERE user_id=? AND date>=? AND date<=? GROUP BY debit, credit`,
    shopUserId, from, to
  );
  const bal = {};
  const add = (acc, n) => { bal[acc] = (bal[acc] || 0) + n; };
  for (const r of rows) {
    add(r.debit, r.v);
    add(r.credit, -r.v);
  }
  const revenue = rows.filter(r => r.credit === 'Revenue').reduce((a, r) => a + r.v, 0);
  const cogs = rows.filter(r => r.debit === 'COGS').reduce((a, r) => a + r.v, 0);
  const expenses = rows.filter(r => r.debit === 'Expense').reduce((a, r) => a + r.v, 0);
  return {
    revenue, cogs, expenses,
    gross: revenue - cogs,
    net: revenue - cogs - expenses,
    accounts: bal,
    entries: all(
      `SELECT * FROM journal_entries WHERE user_id=? AND date>=? AND date<=?
       ORDER BY id DESC LIMIT 200`,
      shopUserId, from, to
    )
  };
}
function listShops(owner) {
  const main = one('SELECT id, name FROM users WHERE id=?', owner);
  const branches = all(
    `SELECT id, name FROM users WHERE owner_id=? AND role='branch' ORDER BY id`,
    owner
  );
  const out = [];
  if (main) out.push({id: main.id, name: main.name, main: 1});
  for (const b of branches) out.push({id: b.id, name: b.name, main: 0});
  return out;
}
function ensureShopRow(u) {
  const owner = ownerId(u);
  if (!Number(u.active_shop_id)) {
    try { run('UPDATE users SET active_shop_id=? WHERE id=?', owner, u.id); } catch {}
    u.active_shop_id = owner;
  }
  return shopId(u);
}
function moneyFmt(cents, currency) {
  return ((Number(cents) || 0) / 100).toFixed(2) + (currency ? ' ' + currency : '');
}
function buildEscPosReceipt(opts) {
  const w = [32, 42, 48].includes(Number(opts.width)) ? Number(opts.width) : 32;
  const enc = s => Buffer.from(String(s), 'utf8');
  const chunks = [];
  const row = (left, right = '') => {
    left = String(left);
    right = String(right);
    if (!right) return left.slice(0, w) + '\n';
    const space = Math.max(1, w - left.length - right.length);
    return (left + ' '.repeat(space) + right).slice(0, w) + '\n';
  };
  chunks.push(Buffer.from([0x1b, 0x40]));
  chunks.push(Buffer.from([0x1b, 0x61, 0x01]));
  chunks.push(enc(String(opts.legal || opts.name || 'Savdo').slice(0, w) + '\n'));
  if (opts.inn) chunks.push(enc(('INN ' + opts.inn).slice(0, w) + '\n'));
  if (opts.address) chunks.push(enc(String(opts.address).slice(0, w) + '\n'));
  if (opts.phone) chunks.push(enc(String(opts.phone).slice(0, w) + '\n'));
  chunks.push(enc((opts.doc_no || '') + (opts.doc_no && opts.date ? ' · ' : '') + (opts.date || '') + '\n'));
  if (opts.cashier) chunks.push(enc(('Cashier: ' + opts.cashier).slice(0, w) + '\n'));
  chunks.push(Buffer.from([0x1b, 0x61, 0x00]));
  chunks.push(enc('-'.repeat(w) + '\n'));
  for (const it of opts.lines || []) {
    chunks.push(enc(row(String(it.name || '').slice(0, w))));
    chunks.push(enc(row(`  ${it.qty} x ${moneyFmt(it.price, '')}`, moneyFmt(it.qty * it.price, ''))));
  }
  chunks.push(enc('-'.repeat(w) + '\n'));
  if (opts.discount) chunks.push(enc(row('Discount', '-' + moneyFmt(opts.discount, opts.currency))));
  if (opts.points_spent) chunks.push(enc(row('Points -', String(opts.points_spent))));
  chunks.push(enc(row('TOTAL', moneyFmt(opts.total, opts.currency))));
  if (opts.pay_method) chunks.push(enc(row('Pay', opts.pay_method)));
  if (opts.points) chunks.push(enc(row('Points +', String(opts.points))));
  if (opts.fiscal) {
    chunks.push(enc('-'.repeat(w) + '\n'));
    chunks.push(Buffer.from([0x1b, 0x61, 0x01]));
    chunks.push(enc('FISCAL\n'));
    if (opts.fiscal_no) chunks.push(enc(('FD ' + opts.fiscal_no).slice(0, w) + '\n'));
    if (opts.fiscal_reg) chunks.push(enc(('RN ' + opts.fiscal_reg).slice(0, w) + '\n'));
    if (opts.fiscal_serial) chunks.push(enc(('SN ' + opts.fiscal_serial).slice(0, w) + '\n'));
  }
  chunks.push(enc('\n\n'));
  chunks.push(Buffer.from([0x1b, 0x61, 0x01]));
  chunks.push(enc('Savdo\n\n\n'));
  chunks.push(Buffer.from([0x1d, 0x56, 0x00]));
  return Buffer.concat(chunks);
}
function sendEscPos(host, port, data) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({host, port: Number(port) || 9100}, () => {
      sock.write(data, err => {
        if (err) { sock.destroy(); reject(err); return; }
        sock.end();
        resolve(true);
      });
    });
    sock.setTimeout(6000);
    sock.on('error', reject);
    sock.on('timeout', () => {
      sock.destroy();
      reject(Object.assign(new Error('Printer timeout'), {status: 504}));
    });
  });
}
function sellPrice(p, wholesale = false) {
  if (wholesale) {
    const w = Number(p.wholesale_price) || 0;
    if (w > 0) return w;
  }
  const promo = Number(p.promo_price) || 0;
  return promo > 0 ? promo : p.price;
}
function maybeAutoBackup(shop) {
  if (!shop || !Number(shop.auto_backup)) return null;
  const day = today(shop);
  if (shop.last_backup === day) return null;
  try {
    const dir = path.join(dataDir, 'backups');
    mkdirSync(dir, {recursive: true});
    const uid = shop.id;
    const payload = {
      version: 2,
      app: 'Savdo',
      exportedAt: new Date().toISOString(),
      user: {name: shop.name, email: shop.email, currency: shop.currency, zone: shop.zone},
      products: all('SELECT * FROM products WHERE user_id=?', uid),
      customers: all('SELECT * FROM customers WHERE user_id=?', uid),
      movements: all('SELECT * FROM movements WHERE user_id=?', uid),
      payments: all('SELECT * FROM payments WHERE user_id=?', uid)
    };
    const file = path.join(dir, `savdo-auto-${day}.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2));
    run('UPDATE users SET last_backup=? WHERE id=?', day, uid);
    const files = readdirSync(dir).filter(f => f.startsWith('savdo-auto-') && f.endsWith('.json')).sort();
    while (files.length > 14) {
      const old = files.shift();
      try { unlinkSync(path.join(dir, old)); } catch {}
    }
    return file;
  } catch {
    return null;
  }
}
async function sendTelegramText(token, chat, text) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({chat_id: chat, text: String(text).slice(0, 3500)})
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw Error(j.description || 'Telegram');
}
async function maybeTelegramAlerts(shop) {
  if (!shop) return;
  const token = String(shop.telegram_token || '').trim();
  const chat = String(shop.telegram_chat || '').trim();
  if (!token || !chat) return;
  const day = today(shop);
  if (shop.last_alert === day) return;
  const wantLow = Number(shop.alert_low) !== 0;
  const wantExp = Number(shop.alert_expiry) !== 0;
  if (!wantLow && !wantExp) {
    run('UPDATE users SET last_alert=? WHERE id=?', day, shop.id);
    return;
  }
  try {
    const products = all('SELECT * FROM products WHERE user_id=? AND active=1', shop.id);
    const limit = Math.max(0, Number(shop.low_stock) || 5);
    const lines = [];
    if (wantLow) {
      const low = products.filter(p => {
        const s = (Number(p.stock) || 0) + (Number(p.stock2) || 0);
        return s <= limit;
      }).slice(0, 25);
      if (low.length) {
        lines.push('⚠️ Low stock:');
        for (const p of low) {
          const s = (Number(p.stock) || 0) + (Number(p.stock2) || 0);
          lines.push(`• ${p.name}: ${s}`);
        }
      }
    }
    if (wantExp) {
      const soon = new Date(day + 'T00:00:00');
      soon.setDate(soon.getDate() + 14);
      const lim = soon.toISOString().slice(0, 10);
      const exp = products.filter(p => {
        const e = String(p.expiry || '');
        return /^\d{4}-\d{2}-\d{2}$/.test(e) && e <= lim;
      }).slice(0, 25);
      if (exp.length) {
        lines.push(lines.length ? '' : '', '📅 Expiry:');
        for (const p of exp) {
          const mark = p.expiry < day ? 'EXPIRED' : 'soon';
          lines.push(`• ${p.name}: ${p.expiry} (${mark})`);
        }
      }
    }
    if (lines.length) {
      await sendTelegramText(token, chat, `🛍 ${shop.name}\n${day}\n` + lines.join('\n'));
    }
    run('UPDATE users SET last_alert=? WHERE id=?', day, shop.id);
  } catch {}
}
function openShift(userId) {
  return one(`SELECT * FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1`, userId);
}
function shiftStats(u, shift) {
  if (!shift) return null;
  const uid = shopId(u);
  const cashSales = one(
    `SELECT COALESCE(SUM(paid),0) AS v FROM movements
     WHERE user_id=? AND kind='sale' AND shift_id=?
       AND (pay_method='' OR pay_method='cash')`,
    uid, shift.id
  ).v;
  const cardSales = one(
    `SELECT COALESCE(SUM(paid),0) AS v FROM movements
     WHERE user_id=? AND kind='sale' AND shift_id=? AND pay_method='card'`,
    uid, shift.id
  ).v;
  const transferSales = one(
    `SELECT COALESCE(SUM(paid),0) AS v FROM movements
     WHERE user_id=? AND kind='sale' AND shift_id=? AND pay_method='transfer'`,
    uid, shift.id
  ).v;
  const debtSales = one(
    `SELECT COALESCE(SUM(qty*price - paid),0) AS v FROM movements
     WHERE user_id=? AND kind='sale' AND shift_id=?`,
    uid, shift.id
  ).v;
  const returns = one(
    `SELECT COALESCE(SUM(qty*price),0) AS v FROM movements
     WHERE user_id=? AND kind='return' AND shift_id=?`,
    uid, shift.id
  ).v;
  const expenses = one(
    `SELECT COALESCE(SUM(price),0) AS v FROM movements
     WHERE user_id=? AND kind='expense' AND shift_id=?`,
    uid, shift.id
  ).v;
  const cashIn = one(
    `SELECT COALESCE(SUM(amount),0) AS v FROM cash_moves WHERE shift_id=? AND kind='in'`,
    shift.id
  ).v;
  const cashOut = one(
    `SELECT COALESCE(SUM(amount),0) AS v FROM cash_moves WHERE shift_id=? AND kind='out'`,
    shift.id
  ).v;
  const expected = shift.open_cash + cashSales - returns + cashIn - cashOut - expenses;
  const checks = one(
    `SELECT COUNT(DISTINCT IFNULL(NULLIF(batch,''), id)) AS v FROM movements
     WHERE user_id=? AND kind='sale' AND shift_id=?`,
    uid, shift.id
  ).v;
  return {
    cash_sales: cashSales,
    card_sales: cardSales,
    transfer_sales: transferSales,
    debt_sales: debtSales,
    returns,
    expenses,
    cash_in: cashIn,
    cash_out: cashOut,
    expected_cash: expected,
    checks,
    open_cash: shift.open_cash
  };
}
function supplierDebt(userId, supplierId) {
  const purchased = one(
    `SELECT COALESCE(SUM(qty*cost - paid),0) AS v FROM movements
     WHERE user_id=? AND supplier_id=? AND kind='receipt'`,
    userId, supplierId
  ).v;
  const paid = one(
    `SELECT COALESCE(SUM(amount),0) AS v FROM supplier_payments
     WHERE user_id=? AND supplier_id=?`,
    userId, supplierId
  ).v;
  return Math.max(0, purchased - paid);
}
function nextDocNo(userId, prefix) {
  const row = one('SELECT sale_seq FROM users WHERE id=?', userId);
  const n = Number(row?.sale_seq || 0) + 1;
  run('UPDATE users SET sale_seq=? WHERE id=?', n, userId);
  return `${prefix}-${String(n).padStart(5, '0')}`;
}
function customerDebt(userId, customerId) {
  const sales = one(
    `SELECT COALESCE(SUM(qty*price - paid),0) AS v FROM movements
     WHERE user_id=? AND customer_id=? AND kind='sale'`,
    userId,
    customerId
  ).v;
  const returns = one(
    `SELECT COALESCE(SUM(qty*price),0) AS v FROM movements
     WHERE user_id=? AND customer_id=? AND kind='return'`,
    userId,
    customerId
  ).v;
  const pays = one(
    `SELECT COALESCE(SUM(amount),0) AS v FROM payments
     WHERE user_id=? AND customer_id=?`,
    userId,
    customerId
  ).v;
  return Math.max(0, sales - returns - pays);
}
function readBody(req, limit) {
  return new Promise(async (resolve, reject) => {
    let raw = '';
    try {
      for await (const c of req) {
        raw += c;
        if (raw.length > limit) {
          reject(Object.assign(new Error('Слишком много данных'), {status: 413}));
          return;
        }
      }
      resolve(raw);
    } catch (e) {
      reject(e);
    }
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Savdo-Lang, X-Savdo-Op, X-Savdo-Hub, X-Savdo-Token, Authorization'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, 'http://127.0.0.1:4173');
  const reply = (status, data) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(data));
  };

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      return res.end(readFileSync(path.join(root, 'index.html')));
    }
    if (url.pathname === '/i18n.js') {
      res.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8'});
      return res.end(clientBundle());
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8'});
      return res.end(readFileSync(path.join(root, 'app.js')));
    }
    if (url.pathname === '/phone' || url.pathname === '/phone.html') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      return res.end(readFileSync(path.join(root, 'phone.html')));
    }
    if (url.pathname === '/download' || url.pathname === '/download.html') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      return res.end(readFileSync(path.join(root, 'download.html')));
    }
    if (
      url.pathname === '/Savdo-download.zip' ||
      url.pathname === '/savdo-download.zip' ||
      url.pathname === '/get.zip'
    ) {
      const p = path.join(root, 'Savdo-download.zip');
      if (!existsSync(p)) return reply(404, {error: te(reqLang(req), 'not_found')});
      const buf = readFileSync(p);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="Savdo-download.zip"',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      });
      return res.end(buf);
    }
    if (url.pathname === '/invite' || url.pathname === '/invite.html') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      return res.end(readFileSync(path.join(root, 'invite.html')));
    }
    if (url.pathname === '/invite-card.jpg') {
      const p = path.join(root, 'icons', 'invite-card.jpg');
      if (!existsSync(p)) return reply(404, {error: te(reqLang(req), 'not_found')});
      res.writeHead(200, {'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400'});
      return res.end(readFileSync(p));
    }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-store'
      });
      return res.end(readFileSync(path.join(root, 'sw.js')));
    }
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, {'Content-Type': 'application/manifest+json; charset=utf-8'});
      return res.end(readFileSync(path.join(root, 'manifest.webmanifest')));
    }
    if (url.pathname.startsWith('/icons/') && !url.pathname.includes('..')) {
      const iconPath = path.resolve(root, '.' + url.pathname);
      const iconsRoot = path.resolve(root, 'icons');
      if (!iconPath.startsWith(iconsRoot) || !existsSync(iconPath)) {
        return reply(404, {error: te(reqLang(req), 'not_found')});
      }
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400'});
      return res.end(readFileSync(iconPath));
    }
    if (!url.pathname.startsWith('/api/')) return reply(404, {error: te(reqLang(req), 'not_found')});

    let b = {};
    if (req.method === 'POST') {
      const origin = req.headers.origin || '';
      if (origin) {
        try {
          const o = new URL(origin);
          if (o.host !== req.headers.host) return reply(403, {error: 'Origin rejected'});
        } catch {
          return reply(403, {error: 'Origin rejected'});
        }
      }
      const limit = url.pathname === '/api/backup/restore'
        ? 12_000_000
        : ['/api/product', '/api/product/update', '/api/products/import', '/api/sync/push'].includes(url.pathname)
          ? 400_000
          : url.pathname === '/api/cart/checkout'
            ? 200_000
            : 40_000;
      const raw = await readBody(req, limit);
      b = JSON.parse(raw || '{}');
    }

    const L = reqLang(req);
    const token = readSessionToken(req);
    let u = token
      ? one(
          'SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token=? AND s.expires>?',
          token,
          Date.now()
        )
      : null;

    if (req.method === 'POST' && ['/api/register', '/api/login', '/api/login/pin'].includes(url.pathname)) {
      // Login id = phone (short). App password = PIN 4–8 digits (no long password).
      const loginKeys = loginKeysFromBody(b);
      const loginKey = loginKeys[0] || '';
      // Digits only — iPhone often inserts spaces / invisible chars in tel/password fields.
      const pin = String(b.pin || b.password || '').replace(/\D/g, '');
      if (!loginKey) return reply(400, {error: te(L, 'need_phone')});
      if (!/^\d{4,8}$/.test(pin)) return reply(400, {error: te(L, 'bad_pin')});

      if (url.pathname === '/api/register') {
        if (!String(b.name || '').trim()) return reply(400, {error: te(L, 'need_shop')});
        if (findUserByLoginKeys(loginKeys)) {
          return reply(400, {error: te(L, 'phone_used')});
        }
        const mode = b.biz_mode === 'company' ? 'company' : 'shop';
        const pinHash = hash(pin);
        const r = run(
          'INSERT INTO users(email,password,name,biz_mode,pin) VALUES(?,?,?,?,?)',
          loginKey,
          pinHash,
          String(b.name).trim().slice(0, 100),
          mode,
          pinHash
        );
        const tok = session(res, Number(r.lastInsertRowid), req);
        return reply(200, {ok: true, token: tok});
      }

      // login / login/pin — same: phone + app PIN (any phone format)
      const user = findUserByLoginKeys(loginKeys);
      if (!user) return reply(401, {error: te(L, 'phone_not_found')});
      let ok = false;
      try {
        if (user.pin) ok = verify(pin, user.pin);
        if (!ok && user.password) ok = verify(pin, user.password);
      } catch { ok = false; }
      if (!ok) return reply(401, {error: te(L, 'bad_pin')});
      const tok = session(res, user.id, req);
      return reply(200, {ok: true, token: tok});
    }

    if (req.method === 'POST' && url.pathname === '/api/central/ingest' && !u) {
      const token = String(b.token || req.headers['x-savdo-hub'] || '').trim();
      if (!token) return reply(401, {error: te(L, 'need_auth')});
      const host = one(
        `SELECT * FROM users WHERE hub_token=? AND IFNULL(role,'')!='branch' AND IFNULL(owner_id,0)=0 LIMIT 1`,
        token
      );
      if (!host) return reply(403, {error: te(L, 'no_access')});
      const key = String(b.shop_key || '').trim().slice(0, 80);
      if (!key) return reply(400, {error: te(L, 'need_shop')});
      const body = JSON.stringify({
        sales_today: Number(b.sales_today) || 0,
        sales_month: Number(b.sales_month) || 0,
        products: Number(b.products) || 0,
        owner_email: String(b.owner_email || '').slice(0, 120)
      });
      run(
        `INSERT INTO branch_snapshots(owner_id,shop_key,shop_name,payload,updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(owner_id,shop_key) DO UPDATE SET
           shop_name=excluded.shop_name, payload=excluded.payload, updated_at=excluded.updated_at`,
        host.id,
        key,
        String(b.shop_name || key).slice(0, 100),
        body,
        Date.now()
      );
      return reply(200, {ok: true, ingested: true});
    }

    if (!u) return reply(401, {error: te(L, 'need_auth')});
    if ((u.role || '') === 'branch') return reply(403, {error: te(L, 'no_access')});
    ensureShopRow(u);
    const owner = ownerId(u);
    const S = shopId(u);
    const admin = isAdmin(u);
    const shops = listShops(owner);

    if (url.pathname === '/api/sync/info' && req.method === 'GET') {
      const last = one(
        'SELECT created_at FROM sync_ops WHERE user_id=? ORDER BY created_at DESC LIMIT 1',
        S
      );
      return reply(200, {
        ok: true,
        role: 'hub',
        serverTime: Date.now(),
        lastOpAt: last?.created_at || 0,
        urls: lanUrls(4173),
        remoteUrl: readRemoteUrl(),
        shop: one('SELECT name FROM users WHERE id=?', S)?.name || u.name
      });
    }

    // Idempotent write ops from offline queue
    const opIdHeader = String(req.headers['x-savdo-op'] || b.op_id || '').trim();
    if (opIdHeader && req.method === 'POST' && opIdHeader.length <= 80) {
      if (one('SELECT op_id FROM sync_ops WHERE op_id=?', opIdHeader)) {
        return reply(200, {ok: true, duplicate: true});
      }
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const customers = all(
        'SELECT * FROM customers WHERE user_id=? AND active=1 ORDER BY name COLLATE NOCASE',
        S
      ).map(c => ({...c, debt: customerDebt(S, c.id)}));
      const payments = all(
        `SELECT p.*, c.name AS customer_name FROM payments p
         JOIN customers c ON c.id=p.customer_id
         WHERE p.user_id=? ORDER BY p.id DESC`,
        S
      );
      const shift = openShift(S);
      const cashMoves = shift
        ? all(
            `SELECT * FROM cash_moves WHERE shift_id=? ORDER BY id DESC LIMIT 30`,
            shift.id
          )
        : [];
      const suppliers = all(
        'SELECT * FROM suppliers WHERE user_id=? AND active=1 ORDER BY name COLLATE NOCASE',
        S
      ).map(s => ({...s, debt: supplierDebt(S, s.id)}));
      const supplierPayments = all(
        `SELECT sp.*, s.name AS supplier_name FROM supplier_payments sp
         JOIN suppliers s ON s.id=sp.supplier_id
         WHERE sp.user_id=? ORDER BY sp.id DESC LIMIT 50`,
        S
      );
      const cashbook = all(
        `SELECT cm.*, sh.opened_at FROM cash_moves cm
         JOIN shifts sh ON sh.id=cm.shift_id
         WHERE cm.user_id=? ORDER BY cm.id DESC LIMIT 100`,
        S
      );
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      maybeAutoBackup(shop);
      maybeTelegramAlerts(shop).catch(() => {});
      const staff = can(u, 'staff')
        ? all(
            `SELECT id, email, name, role, permissions, pin FROM users
             WHERE (id=? OR owner_id=?) AND IFNULL(role,'')!='branch' ORDER BY id`,
            owner, owner
          ).map(st => ({
            id: st.id,
            email: st.email,
            phone: phoneFromLoginKey(st.email) || '',
            login: phoneFromLoginKey(st.email) || st.email || '',
            name: st.name,
            role: st.role,
            permissions: [...parsePerms(st)],
            has_pin: !!(st.pin)
          }))
        : [];
      const cashiers = (can(u, 'shift') || can(u, 'kassa') || can(u, 'staff'))
        ? all(
            `SELECT id, name, pin FROM users
             WHERE (id=? OR owner_id=?) AND IFNULL(role,'')!='branch' ORDER BY id`,
            owner, owner
          ).map(st => ({id: st.id, name: st.name, has_pin: !!(st.pin)}))
        : [];
      const perms = [...parsePerms(u)];
      let shiftOut = shift;
      if (shiftOut) {
        let cashierName = '';
        if (shiftOut.cashier_id) {
          cashierName = one('SELECT name FROM users WHERE id=?', shiftOut.cashier_id)?.name || '';
        }
        if (!cashierName && shiftOut.note) cashierName = String(shiftOut.note);
        shiftOut = {...shiftOut, cashier_name: cashierName};
      }
      return reply(200, {
        user: {
          id: u.id,
          name: shop.name,
          email: u.email,
          phone: phoneFromLoginKey(u.email) || '',
          login: phoneFromLoginKey(u.email) || u.email || '',
          currency: shop.currency,
          zone: shop.zone,
          low_stock: Math.max(0, Number(shop.low_stock) || 5),
          vat_percent: Number(shop.vat_percent) || 0,
          block_below_cost: Number(shop.block_below_cost) || 0,
          telegram_token: can(u, 'settings') ? (shop.telegram_token || '') : '',
          telegram_chat: can(u, 'settings') ? (shop.telegram_chat || '') : '',
          wh1_name: shop.wh1_name || '',
          wh2_name: shop.wh2_name || '',
          role: u.role || 'admin',
          is_admin: admin ? 1 : 0,
          is_director: isDirector(u) ? 1 : 0,
          permissions: perms,
          has_pin: !!(u.pin),
          has_void_pin: !!(shop.void_pin),
          bonus_percent: Number(shop.bonus_percent) || 0,
          auto_backup: Number(shop.auto_backup) ? 1 : 0,
          last_backup: shop.last_backup || '',
          alert_low: Number(shop.alert_low) !== 0 ? 1 : 0,
          alert_expiry: Number(shop.alert_expiry) !== 0 ? 1 : 0,
          active_shop_id: S,
          printer_host: shop.printer_host || '',
          printer_port: Number(shop.printer_port) || 9100,
          printer_enabled: Number(shop.printer_enabled) ? 1 : 0,
          printer_width: Number(shop.printer_width) || 32,
          company_inn: shop.company_inn || '',
          company_address: shop.company_address || '',
          company_phone: shop.company_phone || '',
          company_legal: shop.company_legal || '',
          locked_until: shop.locked_until || '',
          require_shift: Number(shop.require_shift) !== 0 ? 1 : 0,
          fiscal_enabled: Number(shop.fiscal_enabled) ? 1 : 0,
          fiscal_reg: shop.fiscal_reg || '',
          fiscal_serial: shop.fiscal_serial || '',
          fiscal_seq: Number(shop.fiscal_seq) || 0,
          hub_url: can(u, 'settings') ? (shop.hub_url || '') : '',
          hub_token: can(u, 'settings') ? (shop.hub_token || '') : '',
          biz_mode: shop.biz_mode === 'company' ? 'company' : (shop.biz_mode === 'shop' ? 'shop' : ''),
          cashier_name: u.name || '',
          cashier_email: u.email || ''
        },
        shops,
        audit: can(u, 'audit')
          ? all(
              `SELECT * FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT 120`,
              S
            )
          : [],
        accounting: can(u, 'accounting')
          ? accountingSummary(S, String(today(shop)).slice(0, 8) + '01', today(shop))
          : null,
        central: can(u, 'shops')
          ? (() => {
              const day = today(shop);
              const monthFrom = day.slice(0, 8) + '01';
              const local = shops.map(sh => {
                const sales = one(
                  `SELECT COALESCE(SUM(paid),0) AS v FROM movements
                   WHERE user_id=? AND kind='sale' AND date=?`,
                  sh.id, day
                ).v;
                const month = one(
                  `SELECT COALESCE(SUM(paid),0) AS v FROM movements
                   WHERE user_id=? AND kind='sale' AND date>=? AND date<=?`,
                  sh.id, monthFrom, day
                ).v;
                return {id: sh.id, name: sh.name, main: sh.main, sales_today: sales, sales_month: month, source: 'local'};
              });
              const snaps = all(
                `SELECT shop_key, shop_name, payload, updated_at FROM branch_snapshots WHERE owner_id=?`,
                owner
              ).map(s => {
                let p = {};
                try { p = JSON.parse(s.payload || '{}'); } catch {}
                return {
                  id: s.shop_key,
                  name: s.shop_name || s.shop_key,
                  main: 0,
                  sales_today: Number(p.sales_today) || 0,
                  sales_month: Number(p.sales_month) || 0,
                  source: 'remote',
                  updated_at: s.updated_at
                };
              });
              return {shops: local, remote: snaps, day};
            })()
          : null,
        today: today(shop),
        products: all(
          'SELECT * FROM products WHERE user_id=? AND active=1 ORDER BY name COLLATE NOCASE',
          S
        ),
        customers,
        payments,
        suppliers,
        supplier_payments: supplierPayments,
        staff,
        cashiers,
        shift: shiftOut,
        shift_stats: shiftStats(u, shift),
        cash_moves: cashMoves,
        cashbook,
        pay_totals: {
          cash: one(`SELECT COALESCE(SUM(paid),0) AS v FROM movements WHERE user_id=? AND kind='sale' AND (pay_method='' OR pay_method='cash')`, S).v,
          card: one(`SELECT COALESCE(SUM(paid),0) AS v FROM movements WHERE user_id=? AND kind='sale' AND pay_method='card'`, S).v,
          transfer: one(`SELECT COALESCE(SUM(paid),0) AS v FROM movements WHERE user_id=? AND kind='sale' AND pay_method='transfer'`, S).v
        },
        supplier_debt_total: all('SELECT id FROM suppliers WHERE user_id=? AND active=1', S)
          .reduce((a, x) => a + supplierDebt(S, x.id), 0),
        movements: all(
          `SELECT m.*,
                  COALESCE(p.name, m.note) AS name,
                  c.name AS customer_name,
                  s.name AS supplier_name
           FROM movements m
           LEFT JOIN products p ON p.id=m.product_id
           LEFT JOIN customers c ON c.id=m.customer_id
           LEFT JOIN suppliers s ON s.id=m.supplier_id
           WHERE m.user_id=?
           ORDER BY m.date DESC, m.id DESC`,
          S
        )
      });
    }

    if (url.pathname === '/api/backup/export' && req.method === 'GET') {
      const payload = {
        version: 2,
        app: 'Savdo',
        exportedAt: new Date().toISOString(),
        user: {name: u.name, email: u.email, currency: u.currency, zone: u.zone},
        products: all('SELECT * FROM products WHERE user_id=?', S),
        customers: all('SELECT * FROM customers WHERE user_id=?', S),
        movements: all('SELECT * FROM movements WHERE user_id=?', S),
        payments: all('SELECT * FROM payments WHERE user_id=?', S)
      };
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="savdo-backup-${today(u)}.json"`
      });
      return res.end(body);
    }

    if (url.pathname === '/api/backup/file' && req.method === 'GET') {
      db.exec('PRAGMA wal_checkpoint(FULL)');
      const buf = readFileSync(dbPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="savdo-${today(u)}.sqlite"`,
        'Content-Length': buf.length
      });
      return res.end(buf);
    }

    if (req.method !== 'POST') return reply(405, {error: te(L, 'method')});

    const PATH_PERMS = {
      '/api/product': 'stock',
      '/api/product/update': 'stock',
      '/api/product/archive': 'stock',
      '/api/products/import': 'import',
      '/api/customer': 'customers',
      '/api/customer/update': 'customers',
      '/api/customer/archive': 'customers',
      '/api/payment': 'customers',
      '/api/customer/opening-debt': 'customers',
      '/api/customer/opening-debt/delete': 'customers',
      '/api/customer/opening-debt/update': 'customers',
      '/api/supplier': 'suppliers',
      '/api/supplier/update': 'suppliers',
      '/api/supplier/payment': 'suppliers',
      '/api/supplier/opening-debt': 'suppliers',
      '/api/supplier/opening-debt/delete': 'suppliers',
      '/api/supplier/opening-debt/update': 'suppliers',
      '/api/supplier/archive': 'suppliers',
      '/api/cart/checkout': 'kassa',
      '/api/cart/void-last': 'void',
      '/api/cart/partial-return': 'void',
      '/api/shift/open': 'shift',
      '/api/shift/close': 'shift',
      '/api/shift/cash': 'cashbook',
      '/api/inventory': 'stock',
      '/api/stock/transfer': 'stock',
      '/api/quick-receive': 'stock',
      '/api/movement': 'kassa',
      '/api/settings': 'settings',
      '/api/remote-url': 'settings',
      '/api/biz-mode': 'settings',
      '/api/shops': 'shops',
      '/api/shops/delete': 'shops',
      '/api/staff': 'staff',
      '/api/staff/delete': 'staff',
      '/api/staff/update': 'staff',
      '/api/backup/telegram': 'backup',
      '/api/backup/restore': 'backup',
      '/api/sync/push': 'shops',
      '/api/central/ingest': 'shops',
      '/api/accounting/rebuild': 'accounting'
    };
    if (PATH_PERMS[url.pathname]) requirePerm(u, PATH_PERMS[url.pathname], L);
    // Settings / remote / biz-mode: only shop director may change.
    if (['/api/settings', '/api/remote-url', '/api/biz-mode'].includes(url.pathname)) {
      requireDirector(u, L);
    }

    const money = v => {
      const n = Number(v);
      if (v === undefined || v === '' || !Number.isFinite(n) || n < 0 || n > 100000000) {
        throw Error(te(L, 'bad_amount'));
      }
      return Math.round((n + Number.EPSILON) * 100);
    };
    const qty = v => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 1000000) {
        throw Error(te(L, 'bad_qty'));
      }
      return n;
    };
    const parseImage = v => {
      if (v === undefined || v === null || v === '') return '';
      const s = String(v);
      if (s === '__keep__') return '__keep__';
      if (s === '__clear__') return '';
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(s)) {
        throw Error(te(L, 'bad_photo'));
      }
      if (s.length > 350000) throw Error(te(L, 'photo_big'));
      return s;
    };
    const resolveCustomer = id => {
      if (id === undefined || id === null || id === '' || id === '0') return null;
      const c = one('SELECT * FROM customers WHERE id=? AND user_id=? AND active=1', Number(id), S);
      if (!c) throw Error(te(L, 'customer_missing'));
      return c.id;
    };
    const resolveSupplier = id => {
      if (id === undefined || id === null || id === '' || id === '0') return null;
      const s = one('SELECT * FROM suppliers WHERE id=? AND user_id=? AND active=1', Number(id), S);
      if (!s) throw Error(te(L, 'supplier_missing'));
      return s.id;
    };
    const cleanBarcode = v => String(v || '').trim().slice(0, 64);

    let extra = {ok: true};

    if (url.pathname === '/api/product') {
      let name = String(b.name || '').trim();
      if (!name) {
        const n = one(
          `SELECT COUNT(*) AS c FROM products WHERE user_id=?`,
          S
        ).c;
        name = 'Товар ' + (n + 1);
      }
      const stock = Number(b.stock);
      if (
        b.stock === '' ||
        b.stock === undefined ||
        !Number.isInteger(stock) ||
        stock < 0 ||
        stock > 1000000
      ) {
        throw Error(te(L, 'bad_stock_qty'));
      }
      const cost = money(b.cost === undefined || b.cost === '' ? 0 : b.cost);
      // Sell price is set at checkout; catalog may omit it (defaults to 0).
      const price = (b.price === undefined || b.price === '') ? 0 : money(b.price);
      const promo = b.promo_price === undefined || b.promo_price === '' ? 0 : money(b.promo_price);
      const wholesale = b.wholesale_price === undefined || b.wholesale_price === '' ? 0 : money(b.wholesale_price);
      const unit = ['pcs', 'kg', 'l'].includes(String(b.unit || '')) ? String(b.unit) : 'pcs';
      const expiry = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expiry || '')) ? String(b.expiry) : '';
      const image = parseImage(b.image);
      const barcode = cleanBarcode(b.barcode);
      if (barcode) {
        const dup = one(
          'SELECT id FROM products WHERE user_id=? AND barcode=? AND active=1',
          S, barcode
        );
        if (dup) throw Error(te(L, 'barcode_used'));
      }
      const d = parseDate(u, b.date, L);
      tx(() => {
        const r = run(
          'INSERT INTO products(user_id,name,category,cost,price,stock,active,image,barcode,unit,promo_price,expiry,stock2,wholesale_price) VALUES(?,?,?,?,?,?,1,?,?,?,?,?,0,?)',
          S,
          name.slice(0, 100),
          String(b.category || 'Другое').slice(0, 60),
          cost,
          price,
          stock,
          image === '__keep__' ? '' : image,
          barcode,
          unit,
          promo,
          expiry,
          wholesale
        );
        if (stock) {
          run(
            `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date)
             VALUES(?,?,NULL,?,?,?,?,0,?,?)`,
            S,
            Number(r.lastInsertRowid),
            'receipt',
            stock,
            0,
            cost,
            'Start stock',
            d
          );
        }
      });
    } else if (url.pathname === '/api/product/update') {
      const p = one('SELECT * FROM products WHERE id=? AND user_id=? AND active=1', Number(b.id), S);
      if (!p) throw Error(te(L, 'product_missing'));
      let name = String(b.name || '').trim();
      if (!name) name = p.name || 'Товар';
      const image = parseImage(b.image);
      const nextImage = image === '__keep__' ? (p.image || '') : image;
      const barcode = cleanBarcode(b.barcode);
      if (barcode) {
        const dup = one(
          'SELECT id FROM products WHERE user_id=? AND barcode=? AND active=1 AND id!=?',
          S, barcode, p.id
        );
        if (dup) throw Error(te(L, 'barcode_used'));
      }
      const promo = b.promo_price === undefined || b.promo_price === '' ? 0 : money(b.promo_price);
      const wholesale = b.wholesale_price === undefined || b.wholesale_price === '' ? 0 : money(b.wholesale_price);
      const unit = ['pcs', 'kg', 'l'].includes(String(b.unit || '')) ? String(b.unit) : (p.unit || 'pcs');
      const expiry = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expiry || '')) ? String(b.expiry) : '';
      const nextCost = money(b.cost === undefined || b.cost === '' ? p.cost / 100 : b.cost);
      const nextPrice = (b.price === undefined || b.price === '') ? (Number(p.price) || 0) : money(b.price);
      run(
        'UPDATE products SET name=?, category=?, cost=?, price=?, image=?, barcode=?, unit=?, promo_price=?, expiry=?, wholesale_price=? WHERE id=? AND user_id=?',
        name.slice(0, 100),
        String(b.category || 'Другое').slice(0, 60),
        nextCost,
        nextPrice,
        nextImage,
        barcode,
        unit,
        promo,
        expiry,
        wholesale,
        p.id,
        S
      );
    } else if (url.pathname === '/api/product/archive') {
      const p = one('SELECT * FROM products WHERE id=? AND user_id=? AND active=1', Number(b.id), S);
      if (!p) throw Error(te(L, 'product_missing'));
      if (p.stock > 0 || (Number(p.stock2) || 0) > 0) throw Error(te(L, 'archive_stock'));
      run('UPDATE products SET active=0 WHERE id=? AND user_id=?', p.id, S);
    } else if (url.pathname === '/api/customer') {
      const name = String(b.name || '').trim();
      if (!name) throw Error(te(L, 'need_name'));
      const r = run(
        'INSERT INTO customers(user_id,name,phone,note,active) VALUES(?,?,?,?,1)',
        S,
        name.slice(0, 100),
        String(b.phone || '').trim().slice(0, 40),
        String(b.note || '').trim().slice(0, 200)
      );
      extra = {ok: true, id: Number(r.lastInsertRowid)};
    } else if (url.pathname === '/api/customer/update') {
      const c = one('SELECT * FROM customers WHERE id=? AND user_id=? AND active=1', Number(b.id), S);
      if (!c) throw Error(te(L, 'customer_missing'));
      const name = String(b.name || '').trim();
      if (!name) throw Error(te(L, 'need_name'));
      run(
        'UPDATE customers SET name=?, phone=?, note=? WHERE id=? AND user_id=?',
        name.slice(0, 100),
        String(b.phone || '').trim().slice(0, 40),
        String(b.note || '').trim().slice(0, 200),
        c.id,
        S
      );
    } else if (url.pathname === '/api/customer/archive') {
      const c = one('SELECT * FROM customers WHERE id=? AND user_id=? AND active=1', Number(b.id), S);
      if (!c) throw Error(te(L, 'customer_missing'));
      if (customerDebt(S, c.id) > 0) throw Error(te(L, 'close_debt'));
      run('UPDATE customers SET active=0 WHERE id=? AND user_id=?', c.id, S);
    } else if (url.pathname === '/api/supplier') {
      const name = String(b.name || '').trim();
      if (!name) throw Error(te(L, 'need_name'));
      const r = run(
        'INSERT INTO suppliers(user_id,name,phone,note,active) VALUES(?,?,?,?,1)',
        S,
        name.slice(0, 100),
        String(b.phone || '').trim().slice(0, 40),
        String(b.note || '').trim().slice(0, 200)
      );
      extra = {ok: true, id: Number(r.lastInsertRowid)};
    } else if (url.pathname === '/api/supplier/update') {
      const s = one('SELECT * FROM suppliers WHERE id=? AND user_id=? AND active=1', Number(b.id), S);
      if (!s) throw Error(te(L, 'supplier_missing'));
      const name = String(b.name || '').trim();
      if (!name) throw Error(te(L, 'need_name'));
      run(
        'UPDATE suppliers SET name=?, phone=?, note=? WHERE id=? AND user_id=?',
        name.slice(0, 100),
        String(b.phone || '').trim().slice(0, 40),
        String(b.note || '').trim().slice(0, 200),
        s.id,
        S
      );
    } else if (url.pathname === '/api/supplier/archive') {
      const s = one('SELECT * FROM suppliers WHERE id=? AND user_id=? AND active=1', Number(b.id), S);
      if (!s) throw Error(te(L, 'supplier_missing'));
      if (supplierDebt(S, s.id) > 0) throw Error(te(L, 'close_supplier_debt'));
      run('UPDATE suppliers SET active=0 WHERE id=? AND user_id=?', s.id, S);
    } else if (url.pathname === '/api/supplier/payment') {
      const sid = resolveSupplier(b.supplier);
      if (!sid) throw Error(te(L, 'pick_supplier'));
      const amount = money(b.amount);
      if (!amount) throw Error(te(L, 'need_amount'));
      const debt = supplierDebt(S, sid);
      if (amount > debt) throw Error(te(L, 'over_debt'));
      const shift = openShift(S);
      const r = run(
        'INSERT INTO supplier_payments(user_id,supplier_id,amount,note,date) VALUES(?,?,?,?,?)',
        S,
        sid,
        amount,
        String(b.note || '').slice(0, 200),
        parseDate(u, b.date, L)
      );
      if (shift && b.from_cash !== false && b.from_cash !== '0') {
        run(
          `INSERT INTO cash_moves(user_id,shift_id,kind,amount,note,date,created_at)
           VALUES(?,?,?,?,?,?,?)`,
          S,
          shift.id,
          'out',
          amount,
          'Supplier pay',
          today(u),
          Date.now()
        );
      }
      extra = {ok: true, id: Number(r.lastInsertRowid)};
    } else if (url.pathname === '/api/payment') {
      const cid = resolveCustomer(b.customer);
      if (!cid) throw Error(te(L, 'pick_customer'));
      const amount = money(b.amount);
      if (!amount) throw Error(te(L, 'need_amount'));
      const debt = customerDebt(S, cid);
      if (amount > debt) throw Error(te(L, 'over_debt'));
      const r = run(
        'INSERT INTO payments(user_id,customer_id,amount,note,date) VALUES(?,?,?,?,?)',
        S,
        cid,
        amount,
        String(b.note || 'Оплата долга').slice(0, 200),
        parseDate(u, b.date, L)
      );
      extra = {ok: true, id: Number(r.lastInsertRowid)};
    } else if (url.pathname === '/api/customer/opening-debt') {
      const cid = resolveCustomer(b.customer);
      if (!cid) throw Error(te(L, 'pick_customer'));
      const amount = money(b.amount);
      if (!amount) throw Error(te(L, 'need_amount'));
      const shop = one('SELECT locked_until FROM users WHERE id=?', S) || u;
      const d = parseDate(u, b.date, L, shop.locked_until);
      const note = `[opening] ${String(b.note || 'Қарзи пешина').slice(0, 180)}`;
      const r = run(
        `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,batch,doc_no,shift_id,pay_method)
         VALUES(?,NULL,?,'sale',?,?,0,0,?,?, '','OPEN',NULL,'debt')`,
        S, cid, 1, amount, note, d
      );
      postJournal(S, d, 'AR', 'Opening', amount, 'OPEN', note);
      logAudit(S, u, 'opening-debt', `customer #${cid} · ${(amount / 100).toFixed(2)}`);
      extra = {ok: true, id: Number(r.lastInsertRowid)};
    } else if (url.pathname === '/api/customer/opening-debt/update') {
      const id = Number(b.id);
      const m = one(
        `SELECT * FROM movements WHERE id=? AND user_id=? AND kind='sale' AND note LIKE '[opening]%' AND product_id IS NULL`,
        id, S
      );
      if (!m) throw Error(te(L, 'not_found'));
      const amount = money(b.amount);
      if (!amount) throw Error(te(L, 'need_amount'));
      const note = b.note !== undefined
        ? `[opening] ${String(b.note || '').replace(/^\[opening\]\s*/i, '').slice(0, 180)}`
        : m.note;
      const shop = one('SELECT locked_until FROM users WHERE id=?', S) || u;
      const d = parseDate(u, b.date !== undefined ? b.date : m.date, L, shop.locked_until);
      run('UPDATE movements SET price=?, note=?, date=? WHERE id=? AND user_id=?', amount, note, d, id, S);
      logAudit(S, u, 'opening-debt-edit', `#${id}`);
      extra = {ok: true};
    } else if (url.pathname === '/api/customer/opening-debt/delete') {
      if (!isAdmin(u)) throw Error(te(L, 'admin_only_delete'));
      const id = Number(b.id);
      const m = one(
        `SELECT * FROM movements WHERE id=? AND user_id=? AND kind='sale' AND note LIKE '[opening]%' AND product_id IS NULL`,
        id, S
      );
      if (!m) throw Error(te(L, 'not_found'));
      run('DELETE FROM movements WHERE id=? AND user_id=?', id, S);
      logAudit(S, u, 'opening-debt-del', `#${id}`);
      extra = {ok: true};
    } else if (url.pathname === '/api/supplier/opening-debt') {
      const sid = resolveSupplier(b.supplier);
      if (!sid) throw Error(te(L, 'pick_supplier'));
      const amount = money(b.amount);
      if (!amount) throw Error(te(L, 'need_amount'));
      const shop = one('SELECT locked_until FROM users WHERE id=?', S) || u;
      const d = parseDate(u, b.date, L, shop.locked_until);
      const note = `[opening] ${String(b.note || 'Қарзи пешина').slice(0, 180)}`;
      const r = run(
        `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,batch,doc_no,shift_id,supplier_id,pay_method)
         VALUES(?,NULL,NULL,'receipt',?,0,?,0,?,?, '','OPEN',NULL,?,'debt')`,
        S, 1, amount, note, d, sid
      );
      postJournal(S, d, 'Opening', 'AP', amount, 'OPEN', note);
      logAudit(S, u, 'opening-debt', `supplier #${sid} · ${(amount / 100).toFixed(2)}`);
      extra = {ok: true, id: Number(r.lastInsertRowid)};
    } else if (url.pathname === '/api/supplier/opening-debt/update') {
      const id = Number(b.id);
      const m = one(
        `SELECT * FROM movements WHERE id=? AND user_id=? AND kind='receipt' AND note LIKE '[opening]%' AND product_id IS NULL`,
        id, S
      );
      if (!m) throw Error(te(L, 'not_found'));
      const amount = money(b.amount);
      if (!amount) throw Error(te(L, 'need_amount'));
      const note = b.note !== undefined
        ? `[opening] ${String(b.note || '').replace(/^\[opening\]\s*/i, '').slice(0, 180)}`
        : m.note;
      const shop = one('SELECT locked_until FROM users WHERE id=?', S) || u;
      const d = parseDate(u, b.date !== undefined ? b.date : m.date, L, shop.locked_until);
      run('UPDATE movements SET cost=?, note=?, date=? WHERE id=? AND user_id=?', amount, note, d, id, S);
      logAudit(S, u, 'opening-debt-edit', `sup #${id}`);
      extra = {ok: true};
    } else if (url.pathname === '/api/supplier/opening-debt/delete') {
      if (!isAdmin(u)) throw Error(te(L, 'admin_only_delete'));
      const id = Number(b.id);
      const m = one(
        `SELECT * FROM movements WHERE id=? AND user_id=? AND kind='receipt' AND note LIKE '[opening]%' AND product_id IS NULL`,
        id, S
      );
      if (!m) throw Error(te(L, 'not_found'));
      run('DELETE FROM movements WHERE id=? AND user_id=?', id, S);
      logAudit(S, u, 'opening-debt-del', `sup #${id}`);
      extra = {ok: true};
    } else if (url.pathname === '/api/app-unlock') {
      const pin = String(b.pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) throw Error(te(L, 'bad_pin'));
      const candidates = all(
        `SELECT pin FROM users WHERE (id=? OR owner_id=?) AND IFNULL(pin,'')!='' AND IFNULL(role,'')!='branch'`,
        owner, owner
      );
      let ok = false;
      for (const c of candidates) {
        try { if (verify(pin, c.pin)) { ok = true; break; } } catch {}
      }
      if (!ok) throw Error(te(L, 'bad_pin'));
      extra = {ok: true};
    } else if (url.pathname === '/api/shift/open') {
      if (openShift(S)) throw Error(te(L, 'shift_open_exists'));
      const openCash = money(b.open_cash ?? 0);
      const cashierId = Number(b.cashier_id) || u.id;
      const cashier = one(
        `SELECT * FROM users WHERE id=? AND (id=? OR owner_id=?) AND IFNULL(role,'')!='branch'`,
        cashierId,
        owner,
        owner
      );
      if (!cashier) throw Error(te(L, 'not_found'));
      // Already logged in as this cashier → no second PIN. Director opening for another → need their PIN.
      if (cashier.id !== u.id) {
        const pin = String(b.pin || '').trim();
        if (!cashier.pin) throw Error(te(L, 'pin_not_set'));
        let pinOk = false;
        try { pinOk = /^\d{4,8}$/.test(pin) && verify(pin, cashier.pin); } catch { pinOk = false; }
        if (!pinOk) throw Error(te(L, 'bad_pin'));
      } else if (!cashier.pin) {
        throw Error(te(L, 'pin_not_set'));
      }
      const r = run(
        `INSERT INTO shifts(user_id,opened_at,open_cash,status,note,cashier_id) VALUES(?,?,?,'open',?,?)`,
        S,
        new Date().toISOString(),
        openCash,
        String(cashier.name || '').slice(0, 100),
        cashier.id
      );
      extra = {ok: true, id: Number(r.lastInsertRowid), cashier_id: cashier.id, cashier_name: cashier.name};
    } else if (url.pathname === '/api/shift/cash') {
      const shift = openShift(S);
      if (!shift) throw Error(te(L, 'shift_needed'));
      const kind = b.kind === 'out' ? 'out' : 'in';
      const amount = money(b.amount);
      if (!amount) throw Error(te(L, 'need_amount'));
      const r = run(
        `INSERT INTO cash_moves(user_id,shift_id,kind,amount,note,date,created_at)
         VALUES(?,?,?,?,?,?,?)`,
        S,
        shift.id,
        kind,
        amount,
        String(b.note || '').slice(0, 200),
        today(u),
        Date.now()
      );
      extra = {ok: true, id: Number(r.lastInsertRowid)};
    } else if (url.pathname === '/api/shift/close') {
      const shift = openShift(S);
      if (!shift) throw Error(te(L, 'shift_needed'));
      // Allow closing even when expected_cash is negative (cash buys/supplier pays).
      const closeCash = money(Math.max(0, Number(b.close_cash ?? 0)));
      const stats = shiftStats(u, shift);
      run(
        `UPDATE shifts SET status='closed', closed_at=?, close_cash=?, note=? WHERE id=? AND user_id=?`,
        new Date().toISOString(),
        closeCash,
        String(b.note || '').slice(0, 200),
        shift.id,
        S
      );
      const shopZ = one('SELECT * FROM users WHERE id=?', S) || u;
      const saleLines = all(
        `SELECT m.qty, m.price, m.paid, m.doc_no, m.pay_method,
                p.name AS product_name,
                COALESCE(
                  (SELECT name FROM users WHERE id=m.cashier_id),
                  (SELECT u2.name FROM shifts s LEFT JOIN users u2 ON u2.id=s.cashier_id WHERE s.id=m.shift_id),
                  ''
                ) AS cashier_name
         FROM movements m
         LEFT JOIN products p ON p.id=m.product_id
         WHERE m.user_id=? AND m.kind='sale' AND m.shift_id=? AND m.product_id IS NOT NULL
         ORDER BY m.id`,
        S,
        shift.id
      ).map(row => ({
        product: row.product_name || '—',
        qty: row.qty,
        price: row.price,
        total: row.qty * row.price,
        paid: row.paid,
        doc_no: row.doc_no || '',
        pay_method: row.pay_method || '',
        cashier: row.cashier_name || ''
      }));
      let cashierName = '';
      if (shift.cashier_id) {
        cashierName = one('SELECT name FROM users WHERE id=?', shift.cashier_id)?.name || '';
      }
      const zReport = {
        shift_id: shift.id,
        shop: shopZ.name,
        cashier: cashierName,
        fiscal_reg: shopZ.fiscal_reg || '',
        fiscal_serial: shopZ.fiscal_serial || '',
        inn: shopZ.company_inn || '',
        opened_at: shift.opened_at,
        closed_at: new Date().toISOString(),
        ...stats,
        close_cash: closeCash,
        diff: closeCash - stats.expected_cash,
        sale_lines: saleLines
      };
      logAudit(S, u, 'z-report', `shift #${shift.id}`);
      extra = {ok: true, id: shift.id, stats: zReport, z_report: zReport};
    } else if (url.pathname === '/api/inventory') {
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) throw Error(te(L, 'inv_empty'));
      if (items.length > 5000) throw Error(te(L, 'cart_big'));
      const d = parseDate(u, b.date, L);
      const shift = openShift(S);
      const changed = tx(() => {
        let n = 0;
        for (const it of items) {
          const p = one(
            'SELECT * FROM products WHERE id=? AND user_id=? AND active=1',
            Number(it.product),
            S
          );
          if (!p) throw Error(te(L, 'product_missing'));
          const counted = Number(it.counted);
          if (!Number.isInteger(counted) || counted < 0 || counted > 1000000) {
            throw Error(te(L, 'bad_stock_qty'));
          }
          if (counted === p.stock) continue;
          const diff = counted - p.stock;
          run('UPDATE products SET stock=? WHERE id=? AND user_id=?', counted, p.id, S);
          run(
            `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,batch,doc_no,shift_id)
             VALUES(?,?,NULL,'adjust',?,0,?,?,?,?,NULL,'',?)`,
            S,
            p.id,
            Math.abs(diff),
            p.cost,
            diff > 0 ? 1 : 0,
            `${p.stock}→${counted}`,
            d,
            shift?.id || null
          );
          n++;
        }
        return n;
      });
      extra = {ok: true, changed};
    } else if (url.pathname === '/api/cart/checkout') {
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) throw Error(te(L, 'cart_empty'));
      if (items.length > 300) throw Error(te(L, 'cart_big'));
      const mode = b.pay === 'debt' ? 'debt' : 'paid';
      let payMethod = String(b.pay_method || 'cash');
      if (mode === 'debt') payMethod = 'debt';
      else if (!['cash', 'card', 'transfer'].includes(payMethod)) payMethod = 'cash';
      let customerId = null;
      if (mode === 'debt') {
        customerId = resolveCustomer(b.customer);
        if (!customerId) throw Error(te(L, 'debt_customer'));
      } else if (b.customer) {
        customerId = resolveCustomer(b.customer);
      }
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      const d = parseDate(u, b.date, L, shop.locked_until);
      const shift = openShift(S);
      if (Number(shop.require_shift) !== 0 && !shift) throw Error(te(L, 'shift_needed'));
      const wantDisc = (Number(b.discount_percent) > 0) || (b.discount_amount !== undefined && b.discount_amount !== '' && Number(b.discount_amount) > 0);
      if (wantDisc) requirePerm(u, 'discount', L);
      const batch = randomBytes(16).toString('hex');
      const merged = new Map();
      for (const it of items) {
        const id = Number(it.product);
        const n = qty(it.qty);
        const prev = merged.get(id) || {n: 0, customPrice: null};
        prev.n += n;
        if (it.price !== undefined && it.price !== null && it.price !== '') {
          prev.customPrice = money(it.price);
        }
        merged.set(id, prev);
      }
      const wh = Number(b.warehouse) === 2 ? 2 : 1;
      const wholesale = !!(b.wholesale === true || b.wholesale === 1 || b.wholesale === '1');
      const created = tx(() => {
        const lines = [];
        let total = 0;
        for (const [productId, rowIn] of merged) {
          const n = rowIn.n;
          const p = one(
            'SELECT * FROM products WHERE id=? AND user_id=? AND active=1',
            productId,
            S
          );
          if (!p) throw Error(te(L, 'product_missing'));
          const avail = wh === 2 ? (Number(p.stock2) || 0) : p.stock;
          if (n > avail) throw Error(te(L, 'stock_only', {name: p.name, n: avail}));
          // Sale price must be entered at checkout — never use catalog price.
          let unitPrice = rowIn.customPrice != null ? rowIn.customPrice : 0;
          if (!(unitPrice > 0)) throw Error(te(L, 'need_sale_price') + ': ' + p.name);
          if (Number(shop.block_below_cost) && unitPrice < p.cost) {
            throw Error(te(L, 'below_cost') + ': ' + p.name);
          }
          const line = n * unitPrice;
          total += line;
          lines.push({p, n, line, unitPrice});
        }
        let discount = 0;
        const pct = Number(b.discount_percent);
        if (Number.isFinite(pct) && pct > 0) {
          if (pct > 100) throw Error(te(L, 'bad_discount'));
          discount = Math.round(total * pct / 100);
        }
        if (b.discount_amount !== undefined && b.discount_amount !== '') {
          discount = money(b.discount_amount);
        }
        if (discount < 0 || discount > total) throw Error(te(L, 'bad_discount'));
        let redeem = Math.max(0, Math.floor(Number(b.redeem_points) || 0));
        let pointsSpent = 0;
        if (redeem > 0) {
          if (!customerId) throw Error(te(L, 'debt_customer'));
          const cust = one('SELECT * FROM customers WHERE id=? AND user_id=? AND active=1', customerId, S);
          if (!cust) throw Error(te(L, 'customer_missing'));
          const have = Number(cust.points) || 0;
          if (redeem > have) throw Error(te(L, 'not_enough_points'));
          const maxByTotal = Math.floor((total - discount) / 100);
          pointsSpent = Math.min(redeem, Math.max(0, maxByTotal));
          discount += pointsSpent * 100;
        }
        if (discount < 0 || discount > total) throw Error(te(L, 'bad_discount'));
        const payable = total - discount;
        const docNo = nextDocNo(S, 'S');
        const fiscalNo = nextFiscalNo(shop);
        const ids = [];
        let allocated = 0;
        let costTotal = 0;
        const ptsTag = (pointsSpent ? ` · use${pointsSpent}` : '');
        lines.forEach((row, idx) => {
          const isLast = idx === lines.length - 1;
          let share = isLast
            ? payable - allocated
            : Math.round(row.line * payable / (total || 1));
          if (share < 0) share = 0;
          allocated += share;
          const unit = Math.round(share / row.n);
          const paid = mode === 'debt' ? 0 : share;
          costTotal += row.n * (Number(row.p.cost) || 0);
          if (wh === 2) {
            run('UPDATE products SET stock2=stock2-? WHERE id=? AND user_id=?', row.n, row.p.id, S);
          } else {
            run('UPDATE products SET stock=stock-? WHERE id=? AND user_id=?', row.n, row.p.id, S);
          }
          const note = discount
            ? `Cart · −${(discount / 100).toFixed(2)} · ${payMethod}${wh === 2 ? ' · WH2' : ''}${ptsTag}`
            : `Cart · ${payMethod}${wh === 2 ? ' · WH2' : ''}${ptsTag}`;
          const saleCashierId = shift?.cashier_id || u.id || null;
          const r = run(
            `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,batch,doc_no,shift_id,pay_method,fiscal_no,cashier_id)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            S,
            row.p.id,
            customerId,
            'sale',
            row.n,
            unit,
            row.p.cost,
            paid,
            note,
            d,
            batch,
            docNo,
            shift?.id || null,
            payMethod,
            fiscalNo,
            saleCashierId
          );
          ids.push(Number(r.lastInsertRowid));
        });
        if (pointsSpent > 0 && customerId) {
          run('UPDATE customers SET points=MAX(0,COALESCE(points,0)-?) WHERE id=? AND user_id=?', pointsSpent, customerId, S);
        }
        let points = 0;
        if (customerId && mode !== 'debt' && payable > 0) {
          const bp = Number(shop.bonus_percent) || 0;
          if (bp > 0) {
            points = Math.floor((payable / 100) * bp);
            if (points > 0) {
              run('UPDATE customers SET points=COALESCE(points,0)+? WHERE id=? AND user_id=?', points, customerId, S);
            }
          }
        }
        if (points > 0 && ids.length) {
          run(
            `UPDATE movements SET note=note || ? WHERE user_id=? AND batch=?`,
            ` · pts+${points}`,
            S,
            batch
          );
        }
        postSaleAccounting(S, d, payable, costTotal, mode === 'debt' ? 'debt' : payMethod, docNo);
        return {ids, total, discount, payable, batch, doc_no: docNo, fiscal_no: fiscalNo, count: lines.length, pay_method: payMethod, points, points_spent: pointsSpent, customer_id: customerId, wholesale};
      });
      if (b.send_telegram) {
        try {
          const token = String(shop.telegram_token || '').trim();
          const chat = String(shop.telegram_chat || '').trim();
          if (token && chat) {
            const text = `🧾 ${shop.name}\n${created.doc_no} · ${d}\n${te(L, 'summary')}: ${(created.payable / 100).toFixed(2)} ${shop.currency}\n${created.pay_method}${created.points ? '\n⭐ +' + created.points : ''}`;
            await sendTelegramText(token, chat, text);
            created.telegram = true;
          }
        } catch {}
      }
      logAudit(S, u, 'sale', `${created.doc_no || ''} · ${(created.payable / 100).toFixed(2)} · ${created.pay_method || ''}`);
      extra = {ok: true, ...created};
    } else if (url.pathname === '/api/cart/void-last') {
      if (!isAdmin(u)) throw Error(te(L, 'admin_only_delete'));
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      if (shop.void_pin) {
        const pin = String(b.pin || '');
        let ok = false;
        try { ok = verify(pin, shop.void_pin); } catch { ok = false; }
        if (!ok) throw Error(te(L, 'bad_void_pin'));
      }
      const last = one(
        `SELECT batch FROM movements
         WHERE user_id=? AND kind='sale' AND batch IS NOT NULL AND batch!=''
         ORDER BY id DESC LIMIT 1`,
        S
      );
      if (!last?.batch) throw Error(te(L, 'no_void'));
      const rows = all(
        `SELECT * FROM movements WHERE user_id=? AND batch=? AND kind='sale'`,
        S,
        last.batch
      );
      if (!rows.length) throw Error(te(L, 'cart_missing'));
      tx(() => {
        const first = rows[0];
        if (first?.customer_id) {
          const note = String(first.note || '');
          const used = Number(/use(\d+)/.exec(note)?.[1] || 0);
          const earned = Number(/pts\+(\d+)/.exec(note)?.[1] || 0);
          if (used > 0) {
            run('UPDATE customers SET points=COALESCE(points,0)+? WHERE id=? AND user_id=?', used, first.customer_id, S);
          }
          if (earned > 0) {
            run('UPDATE customers SET points=MAX(0,COALESCE(points,0)-?) WHERE id=? AND user_id=?', earned, first.customer_id, S);
          }
        }
        for (const m of rows) {
          if (m.product_id) {
            if (String(m.note || '').includes('WH2')) {
              run(
                'UPDATE products SET stock2=stock2+? WHERE id=? AND user_id=?',
                m.qty,
                m.product_id,
                S
              );
            } else {
              run(
                'UPDATE products SET stock=stock+? WHERE id=? AND user_id=?',
                m.qty,
                m.product_id,
                S
              );
            }
          }
          run('DELETE FROM movements WHERE id=? AND user_id=?', m.id, S);
        }
      });
      logAudit(S, u, 'void', `${last.batch} · lines ${rows.length}`);
      extra = {ok: true, voided: rows.length, batch: last.batch};
    } else if (url.pathname === '/api/cart/partial-return') {
      const batch = String(b.batch || '').trim();
      if (!batch) throw Error(te(L, 'cart_missing'));
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) throw Error(te(L, 'cart_empty'));
      const sales = all(
        `SELECT * FROM movements WHERE user_id=? AND batch=? AND kind='sale'`,
        S,
        batch
      );
      if (!sales.length) throw Error(te(L, 'cart_missing'));
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      const returned = all(
        `SELECT product_id, COALESCE(SUM(qty),0) AS q FROM movements
         WHERE user_id=? AND kind='return' AND note LIKE ?
         GROUP BY product_id`,
        S,
        `%ref:${batch}%`
      );
      const retMap = new Map(returned.map(r => [r.product_id, r.q]));
      const soldMap = new Map();
      const priceMap = new Map();
      const wh2 = new Set();
      let customerId = sales[0].customer_id || null;
      for (const m of sales) {
        soldMap.set(m.product_id, (soldMap.get(m.product_id) || 0) + m.qty);
        priceMap.set(m.product_id, m.price);
        if (String(m.note || '').includes('WH2')) wh2.add(m.product_id);
        if (m.customer_id) customerId = m.customer_id;
      }
      const d = parseDate(u, b.date, L, shop.locked_until);
      const shift = openShift(S);
      const created = tx(() => {
        const ids = [];
        let total = 0;
        for (const it of items) {
          const pid = Number(it.product);
          const n = qty(it.qty);
          const sold = soldMap.get(pid) || 0;
          const already = retMap.get(pid) || 0;
          const left = sold - already;
          if (n > left) throw Error(te(L, 'return_over'));
          const p = one('SELECT * FROM products WHERE id=? AND user_id=? AND active=1', pid, S);
          if (!p) throw Error(te(L, 'product_missing'));
          const price = priceMap.get(pid) || p.price;
          if (wh2.has(pid)) {
            run('UPDATE products SET stock2=stock2+? WHERE id=? AND user_id=?', n, pid, S);
          } else {
            run('UPDATE products SET stock=stock+? WHERE id=? AND user_id=?', n, pid, S);
          }
          const r = run(
            `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,batch,doc_no,shift_id,pay_method)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            S,
            pid,
            customerId,
            'return',
            n,
            price,
            p.cost,
            0,
            `Return · ref:${batch}${wh2.has(pid) ? ' · WH2' : ''}`,
            d,
            '',
            sales[0].doc_no || '',
            shift?.id || null,
            'return'
          );
          ids.push(Number(r.lastInsertRowid));
          total += n * price;
          retMap.set(pid, already + n);
        }
        return {ids, total, batch, doc_no: sales[0].doc_no || '', count: ids.length};
      });
      logAudit(S, u, 'return', `${batch} · ${(created.total / 100).toFixed(2)}`);
      extra = {ok: true, ...created};
    } else if (url.pathname === '/api/movement') {
      const kind = b.kind;
      if (!['sale', 'receipt', 'expense', 'return', 'writeoff'].includes(kind)) {
        throw Error(te(L, 'bad_action'));
      }
      const shopMv = one('SELECT locked_until FROM users WHERE id=?', S) || u;
      const d = parseDate(u, b.date, L, shopMv.locked_until);
      const shift = openShift(S);
      const created = tx(() => {
        if (kind === 'expense') {
          const r = run(
            `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,batch,doc_no,shift_id)
             VALUES(?,NULL,NULL,?,?,?,?,0,?,?, '','',?)`,
            S,
            kind,
            1,
            money(b.amount),
            0,
            String(b.note || 'Expense').slice(0, 200),
            d,
            shift?.id || null
          );
          return Number(r.lastInsertRowid);
        }
        const p = one(
          'SELECT * FROM products WHERE id=? AND user_id=? AND active=1',
          Number(b.product),
          S
        );
        if (!p) throw Error(te(L, 'product_missing'));
        const n = qty(b.qty);
        if ((kind === 'sale' || kind === 'writeoff') && n > p.stock) {
          throw Error(te(L, 'not_enough'));
        }
        if (kind === 'return') {
          const sold = one(
            `SELECT
              COALESCE(SUM(CASE WHEN kind='sale' THEN qty ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN kind='return' THEN qty ELSE 0 END),0) AS net
             FROM movements WHERE user_id=? AND product_id=?`,
            S,
            p.id
          ).net;
          if (n > sold) throw Error(te(L, 'return_over'));
        }
        if (kind === 'writeoff' && !String(b.note || '').trim()) {
          throw Error(te(L, 'need_reason'));
        }
        const cost = kind === 'receipt' ? money(b.cost) : p.cost;
        const price = kind === 'sale' || kind === 'return' ? money(b.price) : 0;
        const total = n * price;
        const buyTotal = n * cost;
        let customerId = null;
        let supplierId = null;
        let paid = 0;
        let payMethod = '';
        if (kind === 'sale' || kind === 'return') {
          customerId = resolveCustomer(b.customer);
          if (kind === 'sale') {
            const mode = b.pay === 'debt' ? 'debt' : b.pay === 'partial' ? 'partial' : 'cash';
            payMethod = mode === 'debt' ? 'debt' : (['card', 'transfer'].includes(b.pay_method) ? b.pay_method : 'cash');
            if (mode === 'debt') {
              if (!customerId) throw Error(te(L, 'debt_customer'));
              paid = 0;
            } else if (mode === 'partial') {
              if (!customerId) throw Error(te(L, 'partial_customer'));
              paid = money(b.paid);
              if (paid >= total) throw Error(te(L, 'partial_less'));
            } else {
              paid = total;
            }
          }
        }
        if (kind === 'receipt') {
          supplierId = resolveSupplier(b.supplier);
          const pay = b.pay === 'debt' ? 'debt' : b.pay === 'partial' ? 'partial' : 'cash';
          if (pay === 'debt') {
            if (!supplierId) throw Error(te(L, 'pick_supplier'));
            paid = 0;
          } else if (pay === 'partial') {
            if (!supplierId) throw Error(te(L, 'pick_supplier'));
            paid = money(b.paid);
            if (paid >= buyTotal) throw Error(te(L, 'partial_less'));
          } else {
            paid = buyTotal;
          }
          payMethod = pay === 'debt' ? 'debt' : 'cash';
          const wh = Number(b.warehouse) === 2 ? 2 : 1;
          const totalStock = (Number(p.stock) || 0) + (Number(p.stock2) || 0);
          const avg = Math.round((p.cost * totalStock + cost * n) / Math.max(1, totalStock + n));
          if (wh === 2) {
            run(
              'UPDATE products SET stock2=stock2+?, cost=? WHERE id=? AND user_id=?',
              n,
              avg,
              p.id,
              S
            );
          } else {
            run(
              'UPDATE products SET stock=stock+?, cost=? WHERE id=? AND user_id=?',
              n,
              avg,
              p.id,
              S
            );
          }
          if (shift && paid > 0 && payMethod === 'cash') {
            run(
              `INSERT INTO cash_moves(user_id,shift_id,kind,amount,note,date,created_at)
               VALUES(?,?,?,?,?,?,?)`,
              S,
              shift.id,
              'out',
              paid,
              'Purchase',
              d,
              Date.now()
            );
          }
        } else if (kind === 'return') {
          run('UPDATE products SET stock=stock+? WHERE id=? AND user_id=?', n, p.id, S);
        } else if (kind === 'sale' || kind === 'writeoff') {
          run('UPDATE products SET stock=stock-? WHERE id=? AND user_id=?', n, p.id, S);
        }
        const docNo = kind === 'sale' ? nextDocNo(S, 'S') : kind === 'receipt' ? nextDocNo(S, 'P') : '';
        const r = run(
          `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,batch,doc_no,shift_id,supplier_id,pay_method)
           VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`,
          S,
          p.id,
          customerId,
          kind,
          n,
          price,
          cost,
          paid,
          kind === 'return'
            ? String(b.note || 'Return').slice(0, 200)
            : String(b.note || '').slice(0, 200),
          d,
          docNo,
          shift?.id || null,
          supplierId,
          payMethod
        );
        return Number(r.lastInsertRowid);
      });
      const row = one(
        `SELECT m.*, COALESCE(p.name, m.note) AS name, c.name AS customer_name
         FROM movements m
         LEFT JOIN products p ON p.id=m.product_id
         LEFT JOIN customers c ON c.id=m.customer_id
         WHERE m.id=? AND m.user_id=?`,
        created,
        S
      );
      extra = {ok: true, id: created, movement: row};
    } else if (url.pathname === '/api/remote-url') {
      let remote = String(b.url || b.remote_url || '').trim().replace(/\/$/, '');
      if (remote && !/^https?:\/\/[^\s]+$/i.test(remote)) throw Error(te(L, 'bad_url'));
      if (b.clear === true || b.clear === 1 || b.clear === '1') remote = '';
      writeRemoteUrl(remote);
      extra = {ok: true, remoteUrl: remote};
    } else if (url.pathname === '/api/settings') {
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      const currencies = ['TJS', 'USD', 'EUR', 'RUB'];
      const currency = currencies.includes(b.currency) ? b.currency : shop.currency;
      if (!currencies.includes(currency)) throw Error(te(L, 'bad_currency'));
      const zone = String(b.zone || shop.zone || 'Asia/Dushanbe');
      try { new Intl.DateTimeFormat('en', {timeZone: zone}); }
      catch { throw Error(te(L, 'bad_date')); }
      const has = one('SELECT id FROM movements WHERE user_id=? LIMIT 1', S);
      if (has && currency !== shop.currency) {
        throw Error(te(L, 'currency_locked'));
      }
      let low = Number(b.low_stock);
      if (!Number.isInteger(low) || low < 0 || low > 1000000) {
        low = Math.max(0, Number(shop.low_stock) || 5);
      }
      let vat = Number(b.vat_percent);
      if (!Number.isFinite(vat) || vat < 0 || vat > 100) {
        vat = Number(shop.vat_percent) || 0;
      }
      const hasKey = (k) => Object.prototype.hasOwnProperty.call(b, k);
      const pickOn = (v, fallback) => {
        if (v === true || v === 1 || v === '1' || v === 'on') return 1;
        if (v === false || v === 0 || v === '0' || v === 'off') return 0;
        return fallback ? 1 : 0;
      };
      const block = hasKey('block_below_cost')
        ? pickOn(b.block_below_cost, false)
        : (Number(shop.block_below_cost) ? 1 : 0);
      const autoBackup = hasKey('auto_backup')
        ? pickOn(b.auto_backup, true)
        : (Number(shop.auto_backup) !== 0 ? 1 : 0);
      const alertLow = hasKey('alert_low')
        ? pickOn(b.alert_low, true)
        : (Number(shop.alert_low) !== 0 ? 1 : 0);
      const alertExpiry = hasKey('alert_expiry')
        ? pickOn(b.alert_expiry, true)
        : (Number(shop.alert_expiry) !== 0 ? 1 : 0);
      let bonus = Number(b.bonus_percent);
      if (!Number.isFinite(bonus) || bonus < 0 || bonus > 100) {
        bonus = Number(shop.bonus_percent) || 0;
      }
      let pinSql = '';
      const pinArgs = [];
      const pin = String(b.pin || '').trim();
      if (pin) {
        if (!/^\d{4,8}$/.test(pin)) throw Error(te(L, 'bad_pin'));
        const pinHash = hash(pin);
        // App login password = same PIN (no long password).
        pinSql += ', pin=?, password=?';
        pinArgs.push(pinHash, pinHash);
      }
      const voidPin = String(b.void_pin || '').trim();
      if (voidPin) {
        if (!/^\d{4,8}$/.test(voidPin)) throw Error(te(L, 'bad_pin'));
        pinSql += ', void_pin=?';
        pinArgs.push(hash(voidPin));
      }
      if (b.clear_void_pin) {
        pinSql += ', void_pin=?';
        pinArgs.push('');
      }
      const printerOn = hasKey('printer_enabled')
        ? pickOn(b.printer_enabled, false)
        : (Number(shop.printer_enabled) ? 1 : 0);
      const printerPort = Math.min(65535, Math.max(1, Number(b.printer_port) || Number(shop.printer_port) || 9100));
      const printerWidth = [32, 42, 48].includes(Number(b.printer_width))
        ? Number(b.printer_width)
        : ([32, 42, 48].includes(Number(shop.printer_width)) ? Number(shop.printer_width) : 32);
      const requireShift = hasKey('require_shift')
        ? pickOn(b.require_shift, true)
        : (Number(shop.require_shift) !== 0 ? 1 : 0);
      const fiscalOn = hasKey('fiscal_enabled')
        ? pickOn(b.fiscal_enabled, false)
        : (Number(shop.fiscal_enabled) ? 1 : 0);
      let lockedUntil = hasKey('locked_until')
        ? String(b.locked_until || '').trim()
        : String(shop.locked_until || '');
      if (lockedUntil && !/^\d{4}-\d{2}-\d{2}$/.test(lockedUntil)) throw Error(te(L, 'bad_date'));
      if (!lockedUntil) lockedUntil = '';
      let hubUrl = hasKey('hub_url')
        ? String(b.hub_url || '').trim().slice(0, 200)
        : String(shop.hub_url || '');
      if (hubUrl && !/^https?:\/\//i.test(hubUrl)) throw Error(te(L, 'bad_hub'));
      const hubToken = hasKey('hub_token')
        ? String(b.hub_token || '').trim().slice(0, 80)
        : String(shop.hub_token || '');
      const bizMode = b.biz_mode === 'company' || b.biz_mode === 'shop'
        ? b.biz_mode
        : (shop.biz_mode === 'company' ? 'company' : 'shop');
      run(
        `UPDATE users SET name=?, currency=?, zone=?, low_stock=?, vat_percent=?,
         block_below_cost=?, telegram_token=?, telegram_chat=?, wh1_name=?, wh2_name=?,
         bonus_percent=?, auto_backup=?, alert_low=?, alert_expiry=?,
         printer_host=?, printer_port=?, printer_enabled=?, printer_width=?,
         company_inn=?, company_address=?, company_phone=?, company_legal=?,
         locked_until=?, require_shift=?, fiscal_enabled=?, fiscal_reg=?, fiscal_serial=?,
         hub_url=?, hub_token=?, biz_mode=?${pinSql} WHERE id=?`,
        String(b.name || shop.name).slice(0, 100),
        currency,
        zone,
        low,
        vat,
        block,
        hasKey('telegram_token') ? String(b.telegram_token || '').trim().slice(0, 200) : String(shop.telegram_token || ''),
        hasKey('telegram_chat') ? String(b.telegram_chat || '').trim().slice(0, 60) : String(shop.telegram_chat || ''),
        hasKey('wh1_name') ? String(b.wh1_name || '').trim().slice(0, 60) : String(shop.wh1_name || ''),
        hasKey('wh2_name') ? String(b.wh2_name || '').trim().slice(0, 60) : String(shop.wh2_name || ''),
        bonus,
        autoBackup,
        alertLow,
        alertExpiry,
        hasKey('printer_host') ? String(b.printer_host || '').trim().slice(0, 80) : String(shop.printer_host || ''),
        printerPort,
        printerOn,
        printerWidth,
        hasKey('company_inn') ? String(b.company_inn || '').trim().slice(0, 40) : String(shop.company_inn || ''),
        hasKey('company_address') ? String(b.company_address || '').trim().slice(0, 200) : String(shop.company_address || ''),
        hasKey('company_phone') ? String(b.company_phone || '').trim().slice(0, 40) : String(shop.company_phone || ''),
        hasKey('company_legal') ? String(b.company_legal || '').trim().slice(0, 120) : String(shop.company_legal || ''),
        lockedUntil,
        requireShift,
        fiscalOn,
        hasKey('fiscal_reg') ? String(b.fiscal_reg || '').trim().slice(0, 40) : String(shop.fiscal_reg || ''),
        hasKey('fiscal_serial') ? String(b.fiscal_serial || '').trim().slice(0, 60) : String(shop.fiscal_serial || ''),
        hubUrl,
        hubToken,
        bizMode,
        ...pinArgs,
        S
      );
      logAudit(S, u, 'settings', lockedUntil ? `lock≤${lockedUntil}` : 'updated');
    } else if (url.pathname === '/api/biz-mode') {
      const mode = b.biz_mode === 'company' ? 'company' : 'shop';
      run('UPDATE users SET biz_mode=? WHERE id=?', mode, owner);
      logAudit(S, u, 'biz-mode', mode);
      extra = {ok: true, biz_mode: mode};
    } else if (url.pathname === '/api/shops') {
      const name = String(b.name || '').trim();
      if (!name) throw Error(te(L, 'need_shop'));
      const base = one('SELECT * FROM users WHERE id=?', owner) || u;
      const email = `branch-${owner}-${Date.now()}@savdo.local`;
      const r = run(
        `INSERT INTO users(email,password,name,currency,zone,low_stock,role,owner_id,vat_percent,bonus_percent,wh1_name,wh2_name,telegram_token,telegram_chat,printer_host,printer_port,printer_enabled,printer_width)
         VALUES(?,?,?,?,?,?,'branch',?,?,?,?,?,?,?,?,?,?,?)`,
        email,
        hash(randomBytes(16).toString('hex')),
        name.slice(0, 100),
        base.currency,
        base.zone,
        Number(base.low_stock) || 5,
        owner,
        Number(base.vat_percent) || 0,
        Number(base.bonus_percent) || 0,
        base.wh1_name || '',
        base.wh2_name || '',
        base.telegram_token || '',
        base.telegram_chat || '',
        base.printer_host || '',
        Number(base.printer_port) || 9100,
        Number(base.printer_enabled) || 0,
        Number(base.printer_width) || 32
      );
      extra = {ok: true, id: Number(r.lastInsertRowid), shops: listShops(owner)};
    } else if (url.pathname === '/api/shops/switch') {
      const id = Number(b.id);
      if (!id) throw Error(te(L, 'not_found'));
      const ok = id === owner || one(
        `SELECT id FROM users WHERE id=? AND owner_id=? AND role='branch'`,
        id, owner
      );
      if (!ok) throw Error(te(L, 'no_access'));
      run('UPDATE users SET active_shop_id=? WHERE id=?', id, u.id);
      extra = {ok: true, active_shop_id: id};
    } else if (url.pathname === '/api/shops/delete') {
      const id = Number(b.id);
      if (!id || id === owner) throw Error(te(L, 'no_access'));
      const br = one(
        `SELECT * FROM users WHERE id=? AND owner_id=? AND role='branch'`,
        id, owner
      );
      if (!br) throw Error(te(L, 'not_found'));
      const has = one('SELECT id FROM movements WHERE user_id=? LIMIT 1', id)
        || one('SELECT id FROM products WHERE user_id=? AND active=1 LIMIT 1', id);
      if (has) throw Error(te(L, 'shop_has_data'));
      run('UPDATE users SET active_shop_id=? WHERE active_shop_id=?', owner, id);
      run('DELETE FROM sessions WHERE user_id=?', id);
      run('DELETE FROM users WHERE id=?', id);
      extra = {ok: true, shops: listShops(owner)};
    } else if (url.pathname === '/api/print/receipt') {
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      if (!Number(shop.printer_enabled) || !String(shop.printer_host || '').trim()) {
        throw Error(te(L, 'printer_off'));
      }
      const batch = String(b.batch || '').trim();
      let lines = [];
      let total = Number(b.payable);
      let discount = Number(b.discount) || 0;
      let docNo = b.doc_no || '';
      let payMethod = b.pay_method || '';
      let points = Number(b.points) || 0;
      let pointsSpent = Number(b.points_spent) || 0;
      let date = b.date || today(shop);
      if (batch) {
        const rows = all(
          `SELECT m.*, COALESCE(p.name, m.note) AS name FROM movements m
           LEFT JOIN products p ON p.id=m.product_id
           WHERE m.user_id=? AND m.batch=? AND m.kind='sale'`,
          S, batch
        );
        if (!rows.length) throw Error(te(L, 'cart_missing'));
        lines = rows.map(m => ({name: m.name, qty: m.qty, price: m.price}));
        total = rows.reduce((a, m) => a + m.qty * m.price, 0);
        docNo = rows[0].doc_no || docNo;
        payMethod = rows[0].pay_method || payMethod;
        date = rows[0].date || date;
      } else if (Array.isArray(b.lines) && b.lines.length) {
        lines = b.lines.map(x => ({
          name: String(x.name || '').slice(0, 40),
          qty: Math.max(1, Number(x.qty) || 1),
          price: Math.max(0, Number(x.price) || 0)
        }));
        if (!Number.isFinite(total)) total = lines.reduce((a, x) => a + x.qty * x.price, 0);
      } else throw Error(te(L, 'cart_empty'));
      let fiscalNo = '';
      if (batch) {
        fiscalNo = one(
          `SELECT fiscal_no FROM movements WHERE user_id=? AND batch=? AND fiscal_no!='' LIMIT 1`,
          S, batch
        )?.fiscal_no || '';
      }
      const buf = buildEscPosReceipt({
        name: shop.name,
        legal: shop.company_legal || shop.name,
        inn: shop.company_inn || '',
        address: shop.company_address || '',
        phone: shop.company_phone || '',
        cashier: u.name || '',
        fiscal_no: fiscalNo || b.fiscal_no || '',
        fiscal_reg: shop.fiscal_reg || '',
        fiscal_serial: shop.fiscal_serial || '',
        fiscal: Number(shop.fiscal_enabled) ? 1 : 0,
        currency: shop.currency,
        width: shop.printer_width,
        doc_no: docNo,
        date,
        lines,
        total,
        discount,
        pay_method: payMethod,
        points,
        points_spent: pointsSpent
      });
      await sendEscPos(String(shop.printer_host).trim(), shop.printer_port || 9100, buf);
      extra = {ok: true, printed: true};
    } else if (url.pathname === '/api/products/import') {
      const raw = String(b.csv || b.text || '').replace(/^\uFEFF/, '');
      if (!raw.trim()) throw Error(te(L, 'import_empty'));
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) throw Error(te(L, 'import_empty'));
      const splitRow = line => {
        const out = [];
        let cur = '';
        let q = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (q && line[i + 1] === '"') { cur += '"'; i++; }
            else q = !q;
          } else if ((ch === ';' || ch === ',') && !q) {
            out.push(cur.trim());
            cur = '';
          } else cur += ch;
        }
        out.push(cur.trim());
        return out;
      };
      const rows = lines.map(splitRow);
      const head = rows[0].map(h => h.toLowerCase());
      const looksHeader = head.some(h => /name|товар|маҳсулот|product|категор|barcode|штрих/.test(h));
      const data = looksHeader ? rows.slice(1) : rows;
      if (!data.length) throw Error(te(L, 'import_empty'));
      if (data.length > 2000) throw Error(te(L, 'cart_big'));
      const idx = (keys, fallback) => {
        for (const k of keys) {
          const i = head.findIndex(h => h.includes(k));
          if (i >= 0) return i;
        }
        return fallback;
      };
      const col = {
        name: looksHeader ? idx(['name', 'товар', 'маҳсулот', 'product'], 0) : 0,
        category: looksHeader ? idx(['categor', 'категор'], 1) : 1,
        cost: looksHeader ? idx(['cost', 'себест', 'харид', 'закуп'], 2) : 2,
        price: looksHeader ? idx(['price', 'продаж', 'фурӯш', 'sell'], 3) : 3,
        promo: looksHeader ? idx(['promo', 'акци'], 4) : 4,
        wholesale: looksHeader ? idx(['wholesale', 'опт', 'яклухт'], 5) : 5,
        unit: looksHeader ? idx(['unit', 'ед', 'воҳид'], 6) : 6,
        stock: looksHeader ? idx(['stock', 'остат', 'боқим', 'склад'], 7) : 7,
        stock2: looksHeader ? idx(['stock2', 'анбор2', 'wh2'], 8) : 8,
        barcode: looksHeader ? idx(['barcode', 'штрих', 'barcode'], 9) : 9,
        expiry: looksHeader ? idx(['expiry', 'срок', 'мӯҳлат'], 10) : 10
      };
      const cell = (row, i) => (i >= 0 && i < row.length ? String(row[i] || '').trim() : '');
      const moneyLoose = v => {
        if (v === '' || v === undefined) return 0;
        const n = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
        if (!Number.isFinite(n) || n < 0 || n > 10000000) throw Error(te(L, 'bad_amount'));
        return Math.round(n * 100);
      };
      let created = 0;
      let updated = 0;
      const d = today(u);
      tx(() => {
        for (const row of data) {
          const name = cell(row, col.name).replace(/^'/, '').slice(0, 100);
          if (!name) continue;
          const barcode = cleanBarcode(cell(row, col.barcode).replace(/^'/, ''));
          const category = (cell(row, col.category) || 'Другое').slice(0, 60);
          const cost = moneyLoose(cell(row, col.cost));
          const price = moneyLoose(cell(row, col.price));
          const promo = moneyLoose(cell(row, col.promo));
          const wholesale = moneyLoose(cell(row, col.wholesale));
          const unit = ['pcs', 'kg', 'l'].includes(cell(row, col.unit)) ? cell(row, col.unit) : 'pcs';
          let stock = Number(cell(row, col.stock));
          if (!Number.isInteger(stock) || stock < 0) stock = 0;
          if (stock > 1000000) stock = 1000000;
          let stock2 = Number(cell(row, col.stock2));
          if (!Number.isInteger(stock2) || stock2 < 0) stock2 = 0;
          const expiry = /^\d{4}-\d{2}-\d{2}$/.test(cell(row, col.expiry)) ? cell(row, col.expiry) : '';
          let existing = null;
          if (barcode) {
            existing = one('SELECT * FROM products WHERE user_id=? AND barcode=? AND active=1', S, barcode);
          }
          if (!existing) {
            existing = one(
              'SELECT * FROM products WHERE user_id=? AND name=? AND active=1 LIMIT 1',
              S, name
            );
          }
          if (existing) {
            run(
              `UPDATE products SET name=?, category=?, cost=?, price=?, unit=?, promo_price=?,
               wholesale_price=?, barcode=?, expiry=?, stock=?, stock2=? WHERE id=? AND user_id=?`,
              name, category, cost, price, unit, promo, wholesale, barcode || existing.barcode || '',
              expiry, stock, stock2, existing.id, S
            );
            updated++;
          } else {
            const r = run(
              `INSERT INTO products(user_id,name,category,cost,price,stock,active,image,barcode,unit,promo_price,expiry,stock2,wholesale_price)
               VALUES(?,?,?,?,?,?,1,'',?,?,?,?,?,?)`,
              S, name, category, cost, price, stock, barcode, unit, promo, expiry, stock2, wholesale
            );
            if (stock > 0) {
              run(
                `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date)
                 VALUES(?,?,NULL,'receipt',?,0,?,0,'CSV import',?)`,
                S, Number(r.lastInsertRowid), stock, cost, d
              );
            }
            created++;
          }
        }
      });
      logAudit(S, u, 'import', `+${created} ~${updated}`);
      extra = {ok: true, created, updated, total: created + updated};
    } else if (url.pathname === '/api/staff') {
      const loginKeys = loginKeysFromBody(b);
      const loginKey = loginKeys[0] || '';
      const name = String(b.name || '').trim();
      const pin = String(b.pin || b.password || '').replace(/\D/g, '');
      if (!loginKey || !name) throw Error(te(L, 'need_phone'));
      if (!/^\d{4,8}$/.test(pin)) throw Error(te(L, 'pin_need_staff'));
      if (findUserByLoginKeys(loginKeys)) throw Error(te(L, 'phone_used'));
      const role = b.role === 'admin' ? 'admin' : 'cashier';
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      const pinHash = hash(pin);
      const permsJson = normalizePermsInput(role, b.permissions);
      run(
        'INSERT INTO users(email,password,name,currency,zone,low_stock,role,owner_id,pin,active_shop_id,permissions) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        loginKey,
        pinHash,
        name.slice(0, 100),
        shop.currency,
        shop.zone,
        Number(shop.low_stock) || 5,
        role,
        owner,
        pinHash,
        S,
        permsJson
      );
      logAudit(S, u, 'staff', `${name} · ${role}`);
      extra = {ok: true};
    } else if (url.pathname === '/api/staff/update') {
      const id = Number(b.id);
      if (!id) throw Error(te(L, 'not_found'));
      const st = one(
        `SELECT * FROM users WHERE id=? AND (id=? OR owner_id=?) AND IFNULL(role,'')!='branch'`,
        id, owner, owner
      );
      if (!st) throw Error(te(L, 'not_found'));
      if (st.id === owner && u.id !== owner) throw Error(te(L, 'no_access'));
      const role = b.role === 'admin' || b.role === 'cashier' ? b.role : st.role;
      if (st.id === owner) {
        // owner stays admin
      } else if (role !== 'admin' && role !== 'cashier') throw Error(te(L, 'bad_action'));
      const permsJson = normalizePermsInput(st.id === owner ? 'admin' : role, b.permissions);
      let pinSql = '';
      const pinArgs = [];
      const pin = String(b.pin || '').trim();
      if (pin) {
        if (!/^\d{4,8}$/.test(pin)) throw Error(te(L, 'bad_pin'));
        const pinHash = hash(pin);
        pinSql = ', pin=?, password=?';
        pinArgs.push(pinHash, pinHash);
      }
      run(
        `UPDATE users SET name=?, role=?, permissions=?${pinSql} WHERE id=?`,
        String(b.name || st.name).slice(0, 100),
        st.id === owner ? 'admin' : role,
        permsJson,
        ...pinArgs,
        id
      );
      logAudit(S, u, 'staff-update', String(st.email));
      extra = {ok: true};
    } else if (url.pathname === '/api/account/status') {
      const n = shopMemberCount(owner);
      extra = {ok: true, members: n, alone: n <= 1, is_director: isDirector(u) ? 1 : 0};
    } else if (url.pathname === '/api/account/delete') {
      requireDirector(u, L);
      const n = shopMemberCount(owner);
      if (n > 1) throw Error(te(L, 'account_has_members'));
      deleteShopAccount(owner);
      res.setHeader(
        'Set-Cookie',
        isHttpsReq(req)
          ? 'savdo_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0'
          : 'savdo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      );
      extra = {ok: true, deleted: true};
    } else if (url.pathname === '/api/quick-receive') {
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length) throw Error(te(L, 'cart_empty'));
      const supplierId = resolveSupplier(b.supplier);
      const d = parseDate(u, b.date, L);
      const shift = openShift(S);
      let pay = String(b.pay || 'debt');
      if (!['cash', 'debt', 'partial'].includes(pay)) pay = 'debt';
      const wh = Number(b.warehouse) === 2 ? 2 : 1;
      tx(() => {
        for (const it of items) {
          const p = one('SELECT * FROM products WHERE id=? AND user_id=? AND active=1', Number(it.product), S);
          if (!p) throw Error(te(L, 'product_missing'));
          const n = qty(it.qty);
          const cost = it.cost === undefined || it.cost === '' ? p.cost : money(it.cost);
          let paid = 0;
          if (pay === 'cash') paid = n * cost;
          else if (pay === 'partial') paid = money(it.paid ?? b.paid ?? 0);
          if (wh === 2) {
            run('UPDATE products SET stock2=stock2+?, cost=? WHERE id=? AND user_id=?', n, cost, p.id, S);
          } else {
            run('UPDATE products SET stock=stock+?, cost=? WHERE id=? AND user_id=?', n, cost, p.id, S);
          }
          run(
            `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date,shift_id,supplier_id,pay_method)
             VALUES(?,?,NULL,'receipt',?,0,?,?,?,?,?,?,?)`,
            S, p.id, n, cost, paid, wh === 2 ? 'Quick receive · WH2' : 'Quick receive', d, shift?.id || null, supplierId, pay === 'cash' ? 'cash' : pay
          );
        }
      });
      extra = {ok: true, count: items.length};
    } else if (url.pathname === '/api/staff/delete') {
      const id = Number(b.id);
      if (!id || id === owner || id === u.id) throw Error(te(L, 'no_access'));
      const st = one('SELECT * FROM users WHERE id=? AND owner_id=?', id, owner);
      if (!st) throw Error(te(L, 'not_found'));
      run('DELETE FROM sessions WHERE user_id=?', id);
      run('DELETE FROM users WHERE id=?', id);
      logAudit(S, u, 'staff-delete', String(st.email || id));
      extra = {ok: true};
    } else if (url.pathname === '/api/stock/transfer') {
      const p = one('SELECT * FROM products WHERE id=? AND user_id=? AND active=1', Number(b.product), S);
      if (!p) throw Error(te(L, 'product_missing'));
      const n = qty(b.qty);
      const from = Number(b.from) === 2 ? 2 : 1;
      const to = Number(b.to) === 2 ? 2 : 1;
      if (from === to) throw Error(te(L, 'bad_qty'));
      const avail = from === 2 ? (Number(p.stock2) || 0) : p.stock;
      if (n > avail) throw Error(te(L, 'stock_only', {name: p.name, n: avail}));
      tx(() => {
        if (from === 1) run('UPDATE products SET stock=stock-?, stock2=stock2+? WHERE id=? AND user_id=?', n, n, p.id, S);
        else run('UPDATE products SET stock2=stock2-?, stock=stock+? WHERE id=? AND user_id=?', n, n, p.id, S);
        run(
          `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date)
           VALUES(?,?,NULL,'expense',?,0,0,0,?,?)`,
          S, p.id, n, `Transfer WH${from}→WH${to}`, today(u)
        );
      });
      extra = {ok: true};
    } else if (url.pathname === '/api/backup/telegram') {
      const shop = one('SELECT * FROM users WHERE id=?', S) || u;
      const token = String(shop.telegram_token || '').trim();
      const chat = String(shop.telegram_chat || '').trim();
      if (!token || !chat) throw Error(te(L, 'telegram') + ': token/chat');
      const payload = {
        version: 2,
        app: 'Savdo',
        exportedAt: new Date().toISOString(),
        user: {name: shop.name, email: shop.email, currency: shop.currency, zone: shop.zone},
        products: all('SELECT * FROM products WHERE user_id=?', S),
        customers: all('SELECT * FROM customers WHERE user_id=?', S),
        movements: all('SELECT * FROM movements WHERE user_id=?', S),
        payments: all('SELECT * FROM payments WHERE user_id=?', S)
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
      const form = new FormData();
      form.append('chat_id', chat);
      form.append('caption', 'Savdo backup ' + today(shop));
      form.append('document', blob, `savdo-backup-${today(shop)}.json`);
      const tg = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form
      });
      const tj = await tg.json().catch(() => ({}));
      if (!tg.ok || !tj.ok) throw Error(tj.description || te(L, 'failed'));
      extra = {ok: true, message: te(L, 'telegram_ok')};
    } else if (url.pathname === '/api/backup/restore') {
      if (!b.data || typeof b.data !== 'object') throw Error(te(L, 'bad_backup'));
      const data = b.data;
      if (!Array.isArray(data.products) || !Array.isArray(data.movements)) {
        throw Error(te(L, 'bad_backup_struct'));
      }
      const products = data.products;
      const customers = Array.isArray(data.customers) ? data.customers : [];
      const movements = data.movements;
      const payments = Array.isArray(data.payments) ? data.payments : [];
      if (products.length > 20000 || movements.length > 200000) throw Error(te(L, 'backup_big'));

      // Safety copy of current DB file
      db.exec('PRAGMA wal_checkpoint(FULL)');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(dbPath, path.join(dataDir, `savdo-before-restore-${stamp}.sqlite`));

      tx(() => {
        run('DELETE FROM payments WHERE user_id=?', S);
        run('DELETE FROM movements WHERE user_id=?', S);
        run('DELETE FROM customers WHERE user_id=?', S);
        run('DELETE FROM products WHERE user_id=?', S);

        const productMap = new Map();
        const customerMap = new Map();

        for (const c of customers) {
          const r = run(
            'INSERT INTO customers(user_id,name,phone,note,active) VALUES(?,?,?,?,?)',
            S,
            String(c.name || 'Клиент').slice(0, 100),
            String(c.phone || '').slice(0, 40),
            String(c.note || '').slice(0, 200),
            c.active === 0 ? 0 : 1
          );
          customerMap.set(c.id, Number(r.lastInsertRowid));
        }
        for (const p of products) {
          let img = '';
          try { img = parseImage(p.image || ''); } catch { img = ''; }
          if (img === '__keep__') img = '';
          const r = run(
            'INSERT INTO products(user_id,name,category,cost,price,stock,active,image) VALUES(?,?,?,?,?,?,?,?)',
            S,
            String(p.name || 'Товар').slice(0, 100),
            String(p.category || 'Другое').slice(0, 60),
            Math.max(0, Number(p.cost) || 0),
            Math.max(0, Number(p.price) || 0),
            Math.max(0, Number(p.stock) || 0),
            p.active === 0 ? 0 : 1,
            img
          );
          productMap.set(p.id, Number(r.lastInsertRowid));
        }
        for (const m of movements) {
          run(
            `INSERT INTO movements(user_id,product_id,customer_id,kind,qty,price,cost,paid,note,date)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            S,
            m.product_id == null ? null : productMap.get(m.product_id) ?? null,
            m.customer_id == null ? null : customerMap.get(m.customer_id) ?? null,
            ['sale', 'receipt', 'expense', 'return'].includes(m.kind) ? m.kind : 'expense',
            Math.max(1, Number(m.qty) || 1),
            Math.max(0, Number(m.price) || 0),
            Math.max(0, Number(m.cost) || 0),
            Math.max(0, Number(m.paid) || 0),
            String(m.note || '').slice(0, 200),
            /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : today(u)
          );
        }
        for (const p of payments) {
          const cid = customerMap.get(p.customer_id);
          if (!cid) continue;
          run(
            'INSERT INTO payments(user_id,customer_id,amount,note,date) VALUES(?,?,?,?,?)',
            S,
            cid,
            Math.max(0, Number(p.amount) || 0),
            String(p.note || '').slice(0, 200),
            /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : today(u)
          );
        }
        if (data.user?.name) {
          run(
            'UPDATE users SET name=?, zone=? WHERE id=?',
            String(data.user.name).slice(0, 100),
            data.user.zone || u.zone,
            S
          );
        }
      });
      extra = {ok: true, message: 'Копия восстановлена'};
    } else if (url.pathname === '/api/accounting/rebuild') {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(b.from || '')) ? String(b.from) : today(u).slice(0, 8) + '01';
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(b.to || '')) ? String(b.to) : today(u);
      run(`DELETE FROM journal_entries WHERE user_id=? AND date>=? AND date<=?`, S, from, to);
      const sales = all(
        `SELECT date, doc_no, pay_method, SUM(paid) AS paid, SUM(qty*price) AS revenue, SUM(qty*cost) AS cost
         FROM movements WHERE user_id=? AND kind='sale' AND date>=? AND date<=?
           AND NOT (product_id IS NULL AND note LIKE '[opening]%')
         GROUP BY IFNULL(NULLIF(batch,''), id)`,
        S, from, to
      );
      for (const s of sales) {
        const pay = s.pay_method || 'cash';
        const rev = Number(s.revenue) || 0;
        const paid = Number(s.paid) || 0;
        if (paid > 0) postSaleAccounting(S, s.date, paid, Number(s.cost) || 0, pay, s.doc_no || '');
        if (rev > paid) postSaleAccounting(S, s.date, rev - paid, 0, 'debt', s.doc_no || '');
      }
      const openings = all(
        `SELECT * FROM movements WHERE user_id=? AND product_id IS NULL AND note LIKE '[opening]%' AND date>=? AND date<=?`,
        S, from, to
      );
      for (const o of openings) {
        if (o.kind === 'sale') postJournal(S, o.date, 'AR', 'Opening', o.price, 'OPEN', o.note || '');
        if (o.kind === 'receipt') postJournal(S, o.date, 'Opening', 'AP', o.cost, 'OPEN', o.note || '');
      }
      const expenses = all(
        `SELECT date, price, note, doc_no FROM movements WHERE user_id=? AND kind='expense' AND date>=? AND date<=?`,
        S, from, to
      );
      for (const e of expenses) {
        postJournal(S, e.date, 'Expense', 'Cash', e.price, e.doc_no || '', e.note || 'Expense');
      }
      logAudit(S, u, 'accounting', `${from}…${to}`);
      extra = {ok: true, ...accountingSummary(S, from, to)};
    } else if (url.pathname === '/api/sync/push') {
      const shop = one('SELECT * FROM users WHERE id=?', owner) || u;
      const hubUrl = String(shop.hub_url || b.hub_url || '').trim().replace(/\/$/, '');
      if (!hubUrl) throw Error(te(L, 'need_hub'));
      const day = today(shop);
      const monthFrom = day.slice(0, 8) + '01';
      const payload = {
        token: String(shop.hub_token || ''),
        owner_email: shop.email,
        shop_key: `shop-${S}`,
        shop_name: (one('SELECT name FROM users WHERE id=?', S)?.name) || shop.name,
        sales_today: one(
          `SELECT COALESCE(SUM(paid),0) AS v FROM movements WHERE user_id=? AND kind='sale' AND date=?`,
          S, day
        ).v,
        sales_month: one(
          `SELECT COALESCE(SUM(paid),0) AS v FROM movements WHERE user_id=? AND kind='sale' AND date>=? AND date<=?`,
          S, monthFrom, day
        ).v,
        products: one(`SELECT COUNT(*) AS c FROM products WHERE user_id=? AND active=1`, S).c,
        updated_at: Date.now()
      };
      const r = await fetch(hubUrl + '/api/central/ingest', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Savdo-Hub': String(shop.hub_token || '')},
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(j.error || te(L, 'hub_fail'));
      logAudit(S, u, 'sync-push', hubUrl);
      extra = {ok: true, pushed: true, remote: j};
    } else if (url.pathname === '/api/central/ingest') {
      const token = String(b.token || req.headers['x-savdo-hub'] || '').trim();
      const shop = one('SELECT * FROM users WHERE id=?', owner) || u;
      if (shop.hub_token && token !== String(shop.hub_token)) throw Error(te(L, 'no_access'));
      const key = String(b.shop_key || '').trim().slice(0, 80);
      if (!key) throw Error(te(L, 'need_shop'));
      const body = JSON.stringify({
        sales_today: Number(b.sales_today) || 0,
        sales_month: Number(b.sales_month) || 0,
        products: Number(b.products) || 0,
        owner_email: String(b.owner_email || '').slice(0, 120)
      });
      run(
        `INSERT INTO branch_snapshots(owner_id,shop_key,shop_name,payload,updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(owner_id,shop_key) DO UPDATE SET
           shop_name=excluded.shop_name, payload=excluded.payload, updated_at=excluded.updated_at`,
        owner,
        key,
        String(b.shop_name || key).slice(0, 100),
        body,
        Date.now()
      );
      extra = {ok: true, ingested: true};
    } else if (url.pathname === '/api/logout') {
      run('DELETE FROM sessions WHERE token=?', token);
      res.setHeader(
        'Set-Cookie',
        isHttpsReq(req)
          ? 'savdo_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0'
          : 'savdo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      );
    } else {
      return reply(404, {error: te(reqLang(req), 'not_found')});
    }

    if (
      opIdHeader &&
      req.method === 'POST' &&
      opIdHeader.length <= 80 &&
      ![
        '/api/register',
        '/api/login',
        '/api/logout',
        '/api/backup/restore'
      ].includes(url.pathname)
    ) {
      try {
        run(
          'INSERT INTO sync_ops(op_id,user_id,path,created_at) VALUES(?,?,?,?)',
          opIdHeader,
          S,
          url.pathname,
          Date.now()
        );
      } catch {}
    }

    reply(200, extra);
  } catch (e) {
    reply(e.status || 400, {error: e.message || te(reqLang(req), 'failed')});
  }
});

const PORT = Number(process.env.PORT) || 4173;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Savdo hub готов. PORT=' + PORT);
  for (const u of lanUrls(PORT)) console.log('  ' + u);
  const remote = readRemoteUrl();
  if (remote) console.log('  Remote: ' + remote);
  console.log('Домен/интернет: откройте https://ваш-домен → /download');
  console.log('Не закрывайте это окно (локально) / используйте systemd на VPS.');
});
