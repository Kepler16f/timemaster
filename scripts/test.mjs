import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './version.mjs';

// 显式限定 tests/，避免 Node 自动发现扫描到本机工作树或下载目录。
const tests = readdirSync(join(root, 'tests')).filter((name) => name.endsWith('.test.js')).sort();
if (!tests.length) throw new Error('tests/ 中没有测试文件');
const result = spawnSync(process.execPath, ['--test', ...tests.map((name) => join(root, 'tests', name))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
