import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, syncVersions } from './version.mjs';

const { version } = syncVersions({ check: true });
const files = [join(root, 'server.js')];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) collect(target);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
}
for (const dir of ['public', 'scripts', 'tests']) collect(join(root, dir));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`语法检查失败：${relative(root, file)}`);
}
// 防止脚本更名后 HTML 仍引用已经不存在的文件。
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
for (const [, src] of html.matchAll(/<script\b[^>]*\bsrc="([^"?#]+)"/g)) {
  if (/^(?:https?:)?\/\//.test(src)) continue;
  readFileSync(join(root, 'public', src));
}
console.log(`检查通过：v${version}，${files.length} 个 JavaScript 文件和 HTML 脚本引用`);
