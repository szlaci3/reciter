// Keep the runtime local: Windows startup and listening need no npm or CDN.
const { copyFileSync } = require('node:fs');
const { join } = require('node:path');
const root = __dirname;
// Use the ES5 distribution: the minified artifact failed to parse on the phone.
copyFileSync(join(root, 'node_modules/dexie/dist/dexie.js'), join(root, 'dexie.js'));
copyFileSync(join(root, 'node_modules/dexie/LICENSE'), join(root, 'dexie.LICENSE'));
