import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'harmony-shell', 'entry', 'src', 'main', 'resources', 'rawfile', 'www');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(join(root, 'public'), dest, { recursive: true });
console.log('web assets synced ->', dest);
