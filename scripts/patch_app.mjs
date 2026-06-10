import { readFileSync, writeFileSync } from 'fs';
let s = readFileSync('app.html', 'utf8');
const loader = `async function loadData(){var k=sessionStorage.getItem('fpk');if(!k){location.replace('index.html');return new Promise(function(){});}var raw=Uint8Array.from(atob(k),function(c){return c.charCodeAt(0);});var key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);var e=await (await fetch('data.enc.json?'+Date.now())).json();var iv=Uint8Array.from(atob(e.iv),function(c){return c.charCodeAt(0);});var ct=Uint8Array.from(atob(e.ct),function(c){return c.charCodeAt(0);});var dec=await crypto.subtle.decrypt({name:'AES-GCM',iv:iv},key,ct);return JSON.parse(new TextDecoder().decode(dec));}\n`;
const find = "fetch('data.json?'+Date.now()).then(function(r){return r.json();}).then(function(D){";
if (!s.includes(find)) { console.error('FETCH ANCHOR NOT FOUND'); process.exit(1); }
s = s.replace(find, loader + "loadData().then(function(D){");
const soFind = '<span id="updated">—</span></div>';
const soBtn = soFind + ` <button onclick="sessionStorage.clear();location.replace('index.html')" style="margin-left:10px;border:1px solid var(--line);background:#fff;color:var(--mut);border-radius:999px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer">Sign out</button>`;
if (s.includes(soFind)) s = s.replace(soFind, soBtn);
writeFileSync('app.html', s);
console.log('patched app.html: decrypt-on-load + auth guard + sign-out');
