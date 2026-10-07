#!/usr/bin/env node
/**
 * MVP end-to-end API test against one hub (local or Render).
 * Usage: node tools/mvp-test.mjs [baseUrl]
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:4173').replace(/\/$/, '');
const email = `mvp_${Date.now()}@test.local`;
const password = 'Test1234!';
const pin = '4321';
const jar = new Map();

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const line of raw) {
    const part = String(line).split(';')[0];
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(path, body, method) {
  const m = method || (body === undefined ? 'GET' : 'POST');
  const r = await fetch(`${BASE}/api/${path.replace(/^\//, '')}`, {
    method: m,
    headers: {
      'Content-Type': 'application/json',
      'X-Savdo-Lang': 'tg',
      ...(cookieHeader() ? {Cookie: cookieHeader()} : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  parseSetCookie(r);
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = {raw: text}; }
  if (!r.ok) {
    const err = new Error(j.error || text || r.statusText);
    err.status = r.status;
    err.body = j;
    throw err;
  }
  return j;
}

const results = [];
function ok(name, detail = '') {
  results.push({ok: true, name, detail});
  console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, e) {
  results.push({ok: false, name, detail: String(e.message || e)});
  console.error(`✗ ${name} — ${e.message || e}`);
}

async function step(name, fn) {
  try {
    const d = await fn();
    ok(name, typeof d === 'string' ? d : '');
    return d;
  } catch (e) {
    fail(name, e);
    throw e;
  }
}

async function soft(name, fn) {
  try {
    const d = await fn();
    ok(name, typeof d === 'string' ? d : '');
    return d;
  } catch (e) {
    fail(name, e);
    return null;
  }
}

async function main() {
  console.log(`MVP test → ${BASE}\n`);
  let state, productId, customerId, supplierId, staffId, cashierId, staffEmail;

  await step('register shop', async () => {
    await api('register', {email, password, name: 'MVP Test Shop', biz_mode: 'shop'});
    return email;
  });

  await soft('biz-mode shop', () => api('biz-mode', {biz_mode: 'shop'}));

  state = await step('state after register', async () => {
    const s = await api('state');
    if (!s.user) throw Error('no user');
    return `user#${s.user.id} · ${s.user.name}`;
  });

  await step('set owner PIN via settings', async () => {
    await api('settings', {pin});
    const s = await api('state');
    if (!s.user.has_pin) throw Error('has_pin still false');
    cashierId = s.user.id;
  });

  await soft('login/pin with email', async () => {
    jar.clear();
    await api('login/pin', {email, pin});
    const s = await api('state');
    if (!s.user) throw Error('pin login failed');
    if (!s.user.is_director) throw Error('owner should be director');
  });

  await soft('login/pin without email rejected', async () => {
    jar.clear();
    try {
      await api('login/pin', {pin});
      throw Error('BUG: pin login without email accepted');
    } catch (e) {
      if (/email|PIN|пин|need/i.test(e.message) || e.status === 400 || e.status === 401) return e.message;
      throw e;
    }
  });

  // re-login email for rest (pin may switch session)
  jar.clear();
  await step('re-login email', () => api('login', {email, password}));

  await step('shift open with PIN', async () => {
    const s = await api('state');
    const id = s.user.id;
    const r = await api('shift/open', {open_cash: 100, cashier_id: id, pin});
    if (!r.ok && !r.id) throw Error(JSON.stringify(r));
    return `shift#${r.id} · ${r.cashier_name || ''}`;
  });

  await soft('shift open twice blocked', async () => {
    try {
      await api('shift/open', {open_cash: 0, cashier_id: cashierId, pin});
      throw Error('should block second open');
    } catch (e) {
      if (/аллакай|already|существует|open/i.test(e.message) || e.status === 400) return e.message;
      throw e;
    }
  });

  productId = await step('create product', async () => {
    const r = await api('product', {
      name: 'MVP Non',
      category: 'Test',
      cost: 50,
      price: 160,
      stock: 20,
      unit: 'pcs'
    });
    const s = await api('state');
    const p = s.products.find(x => x.name === 'MVP Non');
    if (!p) throw Error('product missing in state');
    return String(p.id);
  });
  productId = Number(productId);

  customerId = await step('create customer', async () => {
    await api('customer', {name: 'MVP Customer', phone: '900111222'});
    const s = await api('state');
    const c = s.customers.find(x => x.name === 'MVP Customer');
    if (!c) throw Error('customer missing');
    return String(c.id);
  });
  customerId = Number(customerId);

  supplierId = await step('create supplier', async () => {
    await api('supplier', {name: 'MVP Supplier', phone: '900333444'});
    const s = await api('state');
    const c = s.suppliers.find(x => x.name === 'MVP Supplier');
    if (!c) throw Error('supplier missing');
    return String(c.id);
  });
  supplierId = Number(supplierId);

  await step('customer opening debt', async () => {
    await api('customer/opening-debt', {customer: customerId, amount: 25, note: 'қарзи пешина', date: (await api('state')).today});
  });

  await step('supplier opening debt', async () => {
    await api('supplier/opening-debt', {supplier: supplierId, amount: 40, note: 'қарзи пешина', date: (await api('state')).today});
  });

  await step('cart cash with custom price 140', async () => {
    const r = await api('cart/checkout', {
      pay: 'cash',
      pay_method: 'cash',
      items: [{product: productId, qty: 2, price: 140}],
      date: (await api('state')).today
    });
    if (!r.ok && !r.doc_no) throw Error(JSON.stringify(r));
    // 2 * 140 = 280 major? money() converts - price 140 means 140 somoni = 14000 tiyin
    // payable should be 28000 if price is major units
    return `doc ${r.doc_no} payable=${r.payable}`;
  });

  await step('cart debt sale', async () => {
    const r = await api('cart/checkout', {
      pay: 'debt',
      customer: customerId,
      items: [{product: productId, qty: 1, price: 150}],
      date: (await api('state')).today
    });
    return `doc ${r.doc_no}`;
  });

  await soft('stock decreased', async () => {
    const s = await api('state');
    const p = s.products.find(x => x.id === productId);
    // started 20, sold 2+1=3 → 17
    if (p.stock !== 17) throw Error(`stock=${p.stock} expected 17`);
    return `stock=${p.stock}`;
  });

  await step('add staff with unique PIN', async () => {
    staffEmail = `cashier_${Date.now()}@test.local`;
    await api('staff', {
      name: 'MVP Cashier',
      email: staffEmail,
      password: 'Cashier12',
      role: 'cashier',
      pin: '5678',
      permissions: ['kassa', 'shift']
    });
    const s = await api('state');
    const st = (s.staff || []).find(x => x.email === staffEmail);
    if (!st) throw Error('staff not in list');
    if (!st.has_pin) throw Error('staff has_pin false');
    staffId = st.id;
    return `staff#${st.id}`;
  });

  await soft('cashiers list has pins', async () => {
    const s = await api('state');
    const list = s.cashiers || [];
    if (!list.length) throw Error('no cashiers');
    const withPin = list.filter(c => c.has_pin);
    if (!withPin.length) throw Error('no has_pin');
    return `${list.length} cashiers, ${withPin.length} with PIN`;
  });

  await soft('wrong PIN rejected on shift', async () => {
    // close current first
    const s = await api('state');
    if (s.shift) {
      const c = Math.max(0, (Number(s.shift_stats?.expected_cash) || 0) / 100);
      await api('shift/close', {close_cash: Number(c.toFixed(2))});
    }
    try {
      await api('shift/open', {open_cash: 0, cashier_id: staffId, pin: '0000'});
      throw Error('accepted wrong pin');
    } catch (e) {
      if (/PIN|пин|pin/i.test(e.message)) return e.message;
      throw e;
    }
  });

  await soft('open shift as staff with correct PIN', async () => {
    const r = await api('shift/open', {open_cash: 50, cashier_id: staffId, pin: '5678'});
    return `shift#${r.id} · ${r.cashier_name}`;
  });

  await soft('shift cash in/out', async () => {
    await api('shift/cash', {kind: 'in', amount: 10, note: 'test in'});
    await api('shift/cash', {kind: 'out', amount: 5, note: 'test out'});
  });

  await soft('supplier payment', async () => {
    await api('supplier/payment', {supplier: supplierId, amount: 10, date: (await api('state')).today, note: 'test'});
  });

  await soft('customer payment', async () => {
    await api('payment', {customer: customerId, amount: 5, date: (await api('state')).today});
  });

  await soft('receipt movement', async () => {
    await api('movement', {kind: 'receipt', product: productId, qty: 5, cost: 50, pay: 'cash', date: (await api('state')).today});
  });

  await soft('sync/info', async () => {
    const i = await api('sync/info');
    if (!i.ok && i.role !== 'hub') throw Error(JSON.stringify(i));
    return `role=${i.role}`;
  });

  await soft('backup export', async () => {
    const r = await fetch(`${BASE}/api/backup/export`, {headers: {Cookie: cookieHeader(), 'X-Savdo-Lang': 'tg'}});
    if (!r.ok) throw Error(await r.text());
    const j = await r.json();
    if (!j.products && !j.data && !j.user) {
      // structure may vary
      return `keys=${Object.keys(j).slice(0, 8).join(',')}`;
    }
    return 'ok';
  });

  await soft('close shift Z with sale lines', async () => {
    const s = await api('state');
    if (!s.shift) return 'no open shift';
    const cashAmt = Math.max(0, Math.round(Number(s.shift_stats?.expected_cash) || 0) / 100);
    const r = await api('shift/close', {close_cash: Number(cashAmt.toFixed(2)), note: 'mvp'});
    const lines = r.stats?.sale_lines || r.z_report?.sale_lines || [];
    if (!Array.isArray(lines)) throw Error('sale_lines missing');
    // Staff shift may have cash moves only; lines can be empty — still ok structure
    return `diff=${r.stats?.diff ?? r.z_report?.diff} lines=${lines.length} cashier=${r.stats?.cashier || ''}`;
  });

  await soft('second device same DB (re-login)', async () => {
    jar.clear();
    await api('login', {email, password});
    const s = await api('state');
    const p = s.products.find(x => x.id === productId);
    if (!p) throw Error('product not visible on second session');
    const c = s.customers.find(x => x.id === customerId);
    if (!c) throw Error('customer missing');
    return `products=${s.products.length} stock=${p.stock}`;
  });

  // --- Feature tests: unlock / warehouse / sale price / admin delete ---
  await soft('app-unlock wrong PIN rejected', async () => {
    try {
      await api('app-unlock', {pin: '9999'});
      throw Error('accepted wrong unlock pin');
    } catch (e) {
      if (/PIN|пин|pin/i.test(e.message) || e.status === 400) return e.message;
      throw e;
    }
  });

  await soft('app-unlock correct PIN', async () => {
    const r = await api('app-unlock', {pin});
    if (!r.ok) throw Error(JSON.stringify(r));
    return 'unlocked';
  });

  await soft('checkout without sale price rejected', async () => {
    const s0 = await api('state');
    if (!s0.shift) {
      await api('shift/open', {open_cash: 0, cashier_id: s0.user.id, pin});
    }
    let accepted = false;
    try {
      await api('cart/checkout', {
        pay: 'cash',
        pay_method: 'cash',
        items: [{product: productId, qty: 1}],
        date: (await api('state')).today
      });
      accepted = true;
    } catch (e) {
      if (/нарх|need_sale|цена|price/i.test(e.message) || e.status === 400) return e.message;
      throw e;
    }
    if (accepted) throw Error('BUG: sale without price was accepted');
  });

  await soft('product without catalog price + cart price ok', async () => {
    await api('product', {
      name: 'MVP NoPrice',
      category: 'Test',
      cost: 30,
      price: 0,
      stock: 10,
      unit: 'pcs'
    });
    const s = await api('state');
    const p = s.products.find(x => x.name === 'MVP NoPrice');
    if (!p) throw Error('no-price product missing');
    if (Number(p.price) !== 0) throw Error(`catalog price=${p.price}`);
    const r = await api('cart/checkout', {
      pay: 'cash',
      pay_method: 'cash',
      items: [{product: p.id, qty: 1, price: 55}],
      date: s.today
    });
    return `doc ${r.doc_no} payable=${r.payable}`;
  });

  await soft('receipt into warehouse 2', async () => {
    const s = await api('state');
    if (!s.shift) await api('shift/open', {open_cash: 0, cashier_id: s.user.id, pin});
    const before = (await api('state')).products.find(x => x.id === productId);
    const stock2Before = Number(before.stock2) || 0;
    await api('movement', {
      kind: 'receipt',
      product: productId,
      qty: 3,
      cost: 50,
      pay: 'debt',
      supplier: supplierId,
      warehouse: 2,
      date: (await api('state')).today
    });
    const after = (await api('state')).products.find(x => x.id === productId);
    if ((Number(after.stock2) || 0) !== stock2Before + 3) {
      throw Error(`stock2=${after.stock2} expected ${stock2Before + 3}`);
    }
    return `stock2=${after.stock2}`;
  });

  await soft('cashier cannot void last sale', async () => {
    if (!staffEmail) throw Error('no staffEmail');
    jar.clear();
    await api('login', {email: staffEmail, password: 'Cashier12'});
    try {
      await api('cart/void-last', {});
      throw Error('cashier void allowed');
    } catch (e) {
      if (/админ|admin|директор|director|only|дастрас|access/i.test(e.message) || e.status === 403 || e.status === 400) {
        return e.message;
      }
      throw e;
    }
  });

  await soft('cashier cannot change settings', async () => {
    if (!staffEmail) throw Error('no staffEmail');
    // still logged in as cashier from previous soft, or re-login
    jar.clear();
    await api('login', {email: staffEmail, password: 'Cashier12'});
    const s = await api('state');
    if (s.user.is_director) throw Error('cashier marked as director');
    try {
      await api('settings', {pin: '1111'});
      throw Error('cashier settings allowed');
    } catch (e) {
      if (/директор|director|дастрас|access|only/i.test(e.message) || e.status === 403) return e.message;
      throw e;
    }
  });

  await soft('cashier login via email+PIN', async () => {
    jar.clear();
    await api('login/pin', {email: staffEmail, pin: '5678'});
    const s = await api('state');
    if (!s.user || s.user.email !== staffEmail) throw Error('wrong user after pin login');
    return s.user.name;
  });

  await soft('admin can void last sale', async () => {
    jar.clear();
    await api('login', {email, password});
    const s = await api('state');
    if (!s.shift) await api('shift/open', {open_cash: 0, cashier_id: s.user.id, pin});
    const p = s.products.find(x => x.id === productId) || s.products[0];
    await api('cart/checkout', {
      pay: 'cash',
      pay_method: 'cash',
      items: [{product: p.id, qty: 1, price: 10}],
      date: s.today
    });
    const r = await api('cart/void-last', {});
    if (!r.ok && !r.voided) throw Error(JSON.stringify(r));
    return `voided=${r.voided}`;
  });

  await soft('admin can delete customer opening debt', async () => {
    const s = await api('state');
    await api('customer/opening-debt', {
      customer: customerId,
      amount: 7,
      note: 'mvp-del',
      date: s.today
    });
    const s2 = await api('state');
    const row = (s2.movements || []).find(m =>
      m.kind === 'sale' && String(m.note || '').includes('mvp-del') && !m.product_id
    );
    if (!row) throw Error('opening debt row missing in movements');
    await api('customer/opening-debt/delete', {id: row.id});
    return `deleted#${row.id}`;
  });

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n=== MVP RESULT ${BASE} ===`);
  console.log(`passed=${passed} failed=${failed}`);
  if (failed) {
    console.log('Failures:');
    for (const r of results.filter(x => !x.ok)) console.log(' -', r.name, ':', r.detail);
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
