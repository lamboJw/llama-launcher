import { cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist', 'renderer');

mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  const p = path.join(src, f);
  if (existsSync(p)) cpSync(p, path.join(out, f));
}
const vendor = path.join(out, 'vendor');
mkdirSync(vendor, { recursive: true });
const ansi = path.join(root, 'node_modules', 'ansi-to-html', 'ansi_to_html.min.js');
if (existsSync(ansi)) cpSync(ansi, path.join(vendor, 'ansi-to-html.min.js'));
console.log('assets copied ->', out);
