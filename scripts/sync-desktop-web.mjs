import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'desktop-shell', 'www');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dirname(dest), { recursive: true });
cpSync(join(root, 'public'), dest, { recursive: true });

/* 版本号只有 public/app.js 里那一处：壳的 tauri.conf.json 每次同步跟着盖一次，
   免得出「界面显示 0.5.0、装出来的包叫 0.4.0」这种对不上的包 */
const confPath = join(root, 'desktop-shell', 'src-tauri', 'tauri.conf.json');
const cargoPath = join(root, 'desktop-shell', 'src-tauri', 'Cargo.toml');
const ver = (readFileSync(join(root, 'public', 'app.js'), 'utf8').match(/const APP_VERSION\s*=\s*'([\d.]+)'/) || [])[1];
if (ver) {
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  conf.version = ver;
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  /* Cargo.toml 里的 version 只影响 exe 属性面板显示，但两处对不上迟早有人被绕进去，一起盖 */
  writeFileSync(cargoPath, readFileSync(cargoPath, 'utf8').replace(/^version = "[\d.]+"/m, `version = "${ver}"`));
} else {
  console.warn('没找到 APP_VERSION，tauri.conf.json 版本号保持原样');
}
console.log('web assets synced ->', dest, ver ? '(v' + ver + ')' : '');
