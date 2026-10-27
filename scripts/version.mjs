import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function appVersion() {
  const source = readFileSync(join(root, 'public/app.js'), 'utf8');
  const version = source.match(/^const APP_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/m)?.[1];
  if (!version) throw new Error('public/app.js 缺少有效的 APP_VERSION');
  return version;
}

// APP_VERSION 是版本名称的唯一来源；移动端 versionCode 仍由发布者递增。
export function syncVersions({ check = false } = {}) {
  const version = appVersion();
  const changed = [];
  function update(file, transform) {
    const target = join(root, file);
    const before = readFileSync(target, 'utf8');
    const after = transform(before);
    if (after === before) return;
    changed.push(file);
    if (!check) writeFileSync(target, after);
  }
  function jsonVersion(file) {
    update(file, (text) => {
      const data = JSON.parse(text);
      if (data.version === version) return text;
      return text.replace(/("version"\s*:\s*")[^"]+"/, `$1${version}"`);
    });
  }
  jsonVersion('package.json');
  update('package-lock.json', (text) => {
    const data = JSON.parse(text);
    if (data.version === version && data.packages[''].version === version) return text;
    data.version = version;
    data.packages[''].version = version;
    return JSON.stringify(data, null, 2) + '\n';
  });
  jsonVersion('desktop-shell/package.json');
  jsonVersion('desktop-shell/src-tauri/tauri.conf.json');
  update('desktop-shell/src-tauri/Cargo.toml', (text) => {
    if (!/^version = "[^"]+"/m.test(text)) throw new Error('Cargo.toml 缺少 package version');
    return text.replace(/^version = "[^"]+"/m, `version = "${version}"`);
  });
  update('android-shell/app/build.gradle', (text) => {
    if (!/versionName "[^"]+"/.test(text)) throw new Error('build.gradle 缺少 versionName');
    return text.replace(/versionName "[^"]+"/, `versionName "${version}"`);
  });
  update('harmony-shell/AppScope/app.json5', (text) => {
    if (!/"versionName"\s*:\s*"[^"]+"/.test(text)) throw new Error('app.json5 缺少 versionName');
    return text.replace(/("versionName"\s*:\s*")[^"]+"/, `$1${version}"`);
  });
  const androidCode = readFileSync(join(root, 'android-shell/app/build.gradle'), 'utf8').match(/\bversionCode\s+(\d+)/)?.[1];
  const harmonyCode = readFileSync(join(root, 'harmony-shell/AppScope/app.json5'), 'utf8').match(/"versionCode"\s*:\s*(\d+)/)?.[1];
  if (!androidCode || Number(androidCode) < 1 || androidCode !== harmonyCode) {
    throw new Error('Android 与 HarmonyOS 的 versionCode 必须是相同的正整数，请在发版时一起递增');
  }
  if (check && changed.length) {
    throw new Error(`版本与 APP_VERSION ${version} 不一致：${changed.join(', ')}。请运行 npm run version:sync`);
  }
  return { version, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = syncVersions({ check: process.argv.includes('--check') });
    console.log(`版本 ${result.version}：${result.changed.length ? '已同步 ' + result.changed.join(', ') : '所有平台一致'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
