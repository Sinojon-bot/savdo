import {cpSync, mkdirSync, rmSync, existsSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(path.dirname(fileURLToPath(import.meta.url)), 'www');
if (existsSync(www)) rmSync(www, {recursive: true, force: true});
mkdirSync(www, {recursive: true});

for (const f of ['index.html', 'app.js', 'sw.js', 'manifest.webmanifest', 'download.html', 'invite.html', 'phone.html']) {
  cpSync(path.join(root, f), path.join(www, f));
}
cpSync(path.join(root, 'icons'), path.join(www, 'icons'), {recursive: true});

// Capacitor shell loads local files; user enters hub URL on login.
writeFileSync(
  path.join(www, 'README-SHELL.txt'),
  'Savdo mobile shell. On first login enter hub URL (PC Wi-Fi or REMOTE https) + same email/password.\n',
  'utf8'
);
console.log('www synced for Capacitor');
