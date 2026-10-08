/**
 * Full-database cloud backup so Render free restarts do not wipe shops/staff.
 * Uses a GitHub Release asset (private via token).
 *
 * Render → Environment:
 *   SAVDO_BACKUP_TOKEN = GitHub PAT (contents:write or repo)
 *   SAVDO_BACKUP_REPO  = Sinojon-bot/savdo  (optional)
 *   SAVDO_BACKUP_TAG   = savdo-data         (optional)
 */
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';

const TABLES = [
  'users',
  'products',
  'customers',
  'suppliers',
  'shifts',
  'movements',
  'payments',
  'supplier_payments',
  'cash_moves',
  'journal_entries',
  'branch_snapshots',
  'audit_log',
  'sync_ops'
];

function token() {
  return String(process.env.SAVDO_BACKUP_TOKEN || process.env.GITHUB_TOKEN || '').trim();
}
function repo() {
  return String(process.env.SAVDO_BACKUP_REPO || 'Sinojon-bot/savdo').trim();
}
function tag() {
  return String(process.env.SAVDO_BACKUP_TAG || 'savdo-data').trim();
}
function configured() {
  return !!token();
}

function ghHeaders(extra = {}) {
  return {
    Authorization: 'Bearer ' + token(),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Savdo-Cloud-Backup',
    ...extra
  };
}

export function dumpFullDb(all) {
  const tables = {};
  for (const name of TABLES) {
    try {
      tables[name] = all(`SELECT * FROM ${name}`);
    } catch {
      tables[name] = [];
    }
  }
  return {
    version: 3,
    app: 'Savdo',
    full: true,
    exportedAt: new Date().toISOString(),
    tables
  };
}

export function restoreFullDb(payload, {run, tx, all, one}) {
  if (!payload || payload.full !== true || !payload.tables || typeof payload.tables !== 'object') {
    return false;
  }
  const tables = payload.tables;
  const users = Array.isArray(tables.users) ? tables.users : [];
  if (!users.length) return false;

  const insertRow = (table, row) => {
    if (!row || typeof row !== 'object') return;
    const cols = Object.keys(row);
    if (!cols.length) return;
    const ph = cols.map(() => '?').join(',');
    run(
      `INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES(${ph})`,
      ...cols.map(c => row[c])
    );
  };

  tx(() => {
    run('PRAGMA foreign_keys=OFF');
    for (const name of [...TABLES].reverse()) {
      try {
        run(`DELETE FROM ${name}`);
      } catch {}
    }
    try {
      run('DELETE FROM sessions');
    } catch {}
    for (const name of TABLES) {
      const rows = Array.isArray(tables[name]) ? tables[name] : [];
      for (const row of rows) insertRow(name, row);
    }
    run('PRAGMA foreign_keys=ON');
  });

  const n = one(`SELECT COUNT(*) AS c FROM users WHERE IFNULL(role,'')!='branch'`)?.c || 0;
  return Number(n) > 0;
}

async function ensureRelease() {
  const r = repo();
  const t = tag();
  const get = await fetch(`https://api.github.com/repos/${r}/releases/tags/${encodeURIComponent(t)}`, {
    headers: ghHeaders()
  });
  if (get.status === 200) return get.json();
  if (get.status !== 404) {
    const err = await get.text();
    throw Error('GitHub release read: ' + get.status + ' ' + err.slice(0, 200));
  }
  const create = await fetch(`https://api.github.com/repos/${r}/releases`, {
    method: 'POST',
    headers: ghHeaders({'Content-Type': 'application/json'}),
    body: JSON.stringify({
      tag_name: t,
      name: 'Savdo database backup',
      body: 'Automatic Savdo full DB backup. Do not delete this release.',
      draft: false,
      prerelease: false
    })
  });
  if (!create.ok) {
    const err = await create.text();
    throw Error('GitHub release create: ' + create.status + ' ' + err.slice(0, 200));
  }
  return create.json();
}

async function deleteAsset(release, name) {
  const asset = (release.assets || []).find(a => a.name === name);
  if (!asset) return;
  await fetch(`https://api.github.com/repos/${repo()}/releases/assets/${asset.id}`, {
    method: 'DELETE',
    headers: ghHeaders()
  });
}

export async function pushCloudBackup({all, dataDir}) {
  const payload = dumpFullDb(all);
  const body = JSON.stringify(payload);
  mkdirSync(dataDir, {recursive: true});
  const localPath = path.join(dataDir, 'savdo-full-backup.json');
  writeFileSync(localPath, body, 'utf8');
  if (!configured()) return {ok: false, skipped: true, reason: 'no_token', local: true};

  const release = await ensureRelease();
  const fileName = 'savdo-full-backup.json';
  await deleteAsset(release, fileName);

  const uploadUrl = String(release.upload_url || '').replace(/\{.*\}$/, '');
  const up = await fetch(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: ghHeaders({
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body))
    }),
    body
  });
  if (!up.ok) {
    const err = await up.text();
    throw Error('GitHub upload: ' + up.status + ' ' + err.slice(0, 200));
  }
  return {ok: true, bytes: body.length, at: payload.exportedAt};
}

export async function pullCloudBackup({run, tx, all, one, dataDir}) {
  // 1) Local mirror (same machine restart)
  const localPath = path.join(dataDir, 'savdo-full-backup.json');
  if (existsSync(localPath)) {
    try {
      const payload = JSON.parse(readFileSync(localPath, 'utf8'));
      if (restoreFullDb(payload, {run, tx, all, one})) {
        return {ok: true, source: 'local'};
      }
    } catch (e) {
      console.warn('Local backup restore failed:', e.message || e);
    }
  }

  if (!configured()) return {ok: false, skipped: true, reason: 'no_token'};

  const release = await ensureRelease();
  const fileName = 'savdo-full-backup.json';
  const asset = (release.assets || []).find(a => a.name === fileName);
  if (!asset) return {ok: false, skipped: true, reason: 'no_asset'};

  const dl = await fetch(asset.url, {
    headers: ghHeaders({Accept: 'application/octet-stream'})
  });
  if (!dl.ok) {
    const err = await dl.text();
    throw Error('GitHub download: ' + dl.status + ' ' + err.slice(0, 200));
  }
  const text = await dl.text();
  const payload = JSON.parse(text);
  writeFileSync(localPath, text, 'utf8');
  if (!restoreFullDb(payload, {run, tx, all, one})) {
    return {ok: false, reason: 'restore_failed'};
  }
  return {ok: true, source: 'github'};
}

export function backupStatus() {
  return {
    configured: configured(),
    repo: repo(),
    tag: tag()
  };
}
