// Generates client-side-encrypted auth for the dashboard.
//  - data.enc.json : data.json encrypted with a random AES-256-GCM DATA_KEY
//  - auth.json     : per-user keystore (each password wraps the DATA_KEY via PBKDF2)
//  - .secrets/dashboard_data_key : the DATA_KEY (base64) for the cron secret (NOT committed)
// Prints ONLY the shareable credentials. Browser + cron use the same WebCrypto scheme.
import { webcrypto as wc } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
const subtle = wc.subtle, encTxt = new TextEncoder();
const b64 = (b) => Buffer.from(b).toString('base64');
const ITER = 200000;
const KEYFILE = '/Users/macbookair_1/Documents/Code/FivePrayerInfluencers/.secrets/dashboard_data_key';

const USERS = [
  { username: 'ghany', name: 'Ghany (admin)' },
  { username: 'amira', name: 'Amira Nisrina' },
  { username: 'amna', name: 'Amna' },
  { username: 'icha', name: 'Icha Annisa' },
  { username: 'hafizh', name: 'kak hafizh' },
  { username: 'raul', name: 'kak raul' },
];
function randPass() { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let p = ''; for (const x of wc.getRandomValues(new Uint8Array(14))) p += a[x % a.length]; return p; }

const dataKeyRaw = wc.getRandomValues(new Uint8Array(32));
const dataKey = await subtle.importKey('raw', dataKeyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);

const plaintext = readFileSync('data.json');
const dataIv = wc.getRandomValues(new Uint8Array(12));
const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: dataIv }, dataKey, plaintext));
writeFileSync('data.enc.json', JSON.stringify({ iv: b64(dataIv), ct: b64(ct) }));

const out = [], creds = [];
for (const u of USERS) {
  const pass = randPass(); creds.push({ ...u, pass });
  const salt = wc.getRandomValues(new Uint8Array(16));
  const baseKey = await subtle.importKey('raw', encTxt.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const userKey = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const wIv = wc.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: wIv }, userKey, dataKeyRaw));
  out.push({ username: u.username, salt: b64(salt), iv: b64(wIv), wrapped: b64(wrapped) });
}
writeFileSync('auth.json', JSON.stringify({ iter: ITER, users: out }));
writeFileSync(KEYFILE, b64(dataKeyRaw));

// ---- self-test: simulate browser login for the first user ----
const t = creds[0], entry = out[0];
const bk = await subtle.importKey('raw', encTxt.encode(t.pass), 'PBKDF2', false, ['deriveKey']);
const uk = await subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(entry.salt, 'base64'), iterations: ITER, hash: 'SHA-256' }, bk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
const unwrapped = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(entry.iv, 'base64') }, uk, Buffer.from(entry.wrapped, 'base64')));
const dk2 = await subtle.importKey('raw', unwrapped, 'AES-GCM', false, ['decrypt']);
const enc = JSON.parse(readFileSync('data.enc.json', 'utf8'));
const dec = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(enc.iv, 'base64') }, dk2, Buffer.from(enc.ct, 'base64')));
const ok = JSON.parse(new TextDecoder().decode(dec)).kpis.appOpens === JSON.parse(plaintext.toString()).kpis.appOpens;
console.log('SELF-TEST round-trip decrypt:', ok ? 'PASS ✅' : 'FAIL ❌');
console.log('wrote data.enc.json (' + ct.length + ' bytes ct), auth.json (' + out.length + ' users), key -> .secrets/dashboard_data_key');
console.log('\n=== CREDENTIALS (share each privately with the person) ===');
creds.forEach(c => console.log('  ' + c.username.padEnd(8) + ' ' + c.pass + '   — ' + c.name));
