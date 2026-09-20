// Keep the runtime local: Windows startup and listening need no npm or CDN.
const { copyFileSync } = require('node:fs');
const { join } = require('node:path');
const root = __dirname;
copyFileSync(join(root, 'node_modules/dexie/dist/dexie.min.js'), join(root, 'dexie.min.js'));
copyFileSync(join(root, 'node_modules/dexie/LICENSE'), join(root, 'dexie.LICENSE'));
