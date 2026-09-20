// Keep the runtime local: Windows startup and listening need no npm or CDN.
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = __dirname;
// Use the ES5 distribution: the minified artifact failed to parse on the phone.
copyFileSync(join(root, 'node_modules/dexie/dist/dexie.js'), join(root, 'dexie.js'));
copyFileSync(join(root, 'node_modules/dexie/LICENSE'), join(root, 'dexie.LICENSE'));

// Fingerprint normalized source text (not a security hash). Works on HTTP phones
// where Web Crypto is unavailable; ignores Windows checkout line endings.
const source = readFileSync(join(root, 'dexie.js'), 'utf8').replace(/\r\n/g, '\n');
let hash = 2166136261;
for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
const fingerprint = source.length + ':' + (hash >>> 0).toString(16);
const htmlPath = join(root, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const updated = html.replace(/(<script src="dexie\.js[^" ]*")(?: data-source-fingerprint="[^"]*")?/, '$1 data-source-fingerprint="' + fingerprint + '"');
if (updated === html && !html.includes('data-source-fingerprint="' + fingerprint + '"')) {
  throw new Error('Dexie script tag missing; cannot update source fingerprint');
}
writeFileSync(htmlPath, updated);
