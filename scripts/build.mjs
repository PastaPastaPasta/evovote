import { cpSync, mkdirSync, rmSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const file of ['index.html', '404.html', 'retired.css', 'retirement.js', 'dashhq']) {
  cpSync(new URL(file, root), new URL(file, out), { recursive: true });
}
console.log('Built retirement page in dist/');
