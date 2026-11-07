/**
 * pond-check · 发布物完整性（tests/release.test.mjs）
 *
 * D9 集成验收抓到的坑，全部钉在这里 —— 它们**单测抓不到**，因为单测是 import 模块，
 * 从来不经过「用户真正敲的那条路径」：
 *
 *   1. `npm install -g` 装出来的 bin 是**符号链接**；入口守卫用字符串比较
 *      `import.meta.url === pathToFileURL(argv[1])` 时会不相等 →
 *      `pond-check --help` 静默退出 0、一个字都不输出（实测）。必须走 realpath。
 *   2. `package.json` 的 bin 指向的脚本**必须有 shebang**，否则 npm 装出来是坏的
 *      （JS 被当 shell 跑：`line 2: /bin: Is a directory`）。
 *   3. 版本号四处（package.json / CHANGELOG 顶部 / tag / 远端 tag）会漂——
 *      这里把「仓库内能验的两处」钉死，tag 与远端交给 D9 的验收脚本。
 *
 * 这些用例都在 Linux CI 上跑；Windows 下没有符号链接权限，相关用例自动跳过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** 当前平台能不能建符号链接（Windows 默认不行）。 */
const canSymlink = process.platform !== 'win32';

/* ------------------------------------------------------------------ *
 * 1. 入口守卫：符号链接下也必须真跑起来
 * ------------------------------------------------------------------ */

test('发布物·入口：通过符号链接执行（npm 全局安装的形态）必须真的跑，不许静默退出', { skip: !canSymlink && 'Windows 无符号链接权限' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bin-'));
  try {
    // 模拟 npm 的布局：bin/pond-check -> ../lib/node_modules/pond-check/src/cli.mjs
    const libDir = path.join(tmp, 'lib', 'node_modules', 'pond-check');
    fs.mkdirSync(libDir, { recursive: true });
    fs.cpSync(path.join(ROOT, 'src'), path.join(libDir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(libDir, 'package.json'));

    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, 'pond-check');
    fs.symlinkSync(path.join('..', 'lib', 'node_modules', 'pond-check', 'src', 'cli.mjs'), binPath);

    const run = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' });

    assert.equal(run.status, 0, `符号链接执行 exit=${run.status}，stderr=${run.stderr}`);
    assert.ok(
      (run.stdout ?? '').includes('pond-check'),
      `通过符号链接执行时一个字都没输出 —— 入口守卫没走 realpath（stdout=${JSON.stringify(run.stdout)}）`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('发布物·入口：直接执行（node src/cli.mjs）仍然工作', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.ok((run.stdout ?? '').includes('--root'), '帮助里必须列出 --root（验收门要求）');
});

/* ------------------------------------------------------------------ *
 * 2. bin 的 shebang：`npm install -g` 装出来能不能跑
 * ------------------------------------------------------------------ */

test('发布物·bin：package.json 的 bin 指向的脚本必须以 #!/usr/bin/env node 开头', () => {
  const bin = PKG.bin;
  assert.ok(bin && typeof bin === 'object', 'package.json 必须有 bin 字段');
  const entries = Object.entries(bin);
  assert.ok(entries.length > 0, 'bin 不能是空对象');
  for (const [name, rel] of entries) {
    const target = path.join(ROOT, rel);
    assert.ok(fs.existsSync(target), `bin.${name} 指向的 ${rel} 不存在 —— npm 装出来会是坏命令`);
    const head = fs.readFileSync(target, 'utf8').split('\n', 1)[0];
    assert.equal(head, '#!/usr/bin/env node', `bin.${name} 缺 shebang（第一行是 ${JSON.stringify(head)}）—— JS 会被当 shell 跑`);
  }
});

/* ------------------------------------------------------------------ *
 * 3. 版本一致：package.json ↔ CHANGELOG 顶部已发布段
 * ------------------------------------------------------------------ */

/** 从 CHANGELOG 里取「最新一个已发布版本」（跳过 Unreleased）。 */
function latestChangelogVersion() {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  // 形如 `## [0.1.0] - 2026-11-07`
  const match = text.match(/^##\s+\[(\d+\.\d+\.\d+)\]/mu);
  return match ? match[1] : null;
}

test('发布物·版本：package.json 与 CHANGELOG 顶部已发布版本一致', () => {
  const changelogVersion = latestChangelogVersion();
  assert.ok(changelogVersion, 'CHANGELOG 里找不到 `## [x.y.z]` 形式的已发布段');
  assert.equal(
    PKG.version,
    changelogVersion,
    `版本漂了：package.json=${PKG.version} / CHANGELOG=${changelogVersion} —— 发版时两处必须一起改`,
  );
});

test('发布物·版本：CHANGELOG 里必须有这个版本的小节（不是只有 Unreleased）', () => {
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(text, new RegExp(`^##\\s+\\[${PKG.version.replace(/\./gu, '\\.')}\\]`, 'mu'));
});

/* ------------------------------------------------------------------ *
 * 4. 引擎与零依赖（发布前的最后一道自我声明）
 * ------------------------------------------------------------------ */

test('发布物·engines：声明 Node >= 22（README 徽章与它同口径）', () => {
  assert.ok(PKG.engines && typeof PKG.engines.node === 'string', 'package.json 必须声明 engines.node');
  const major = Number((PKG.engines.node.match(/(\d+)/u) ?? [])[1]);
  assert.ok(Number.isFinite(major) && major >= 22, `engines.node=${PKG.engines.node}，应 >= 22`);
});

test('发布物·零依赖：package.json 不允许出现任何依赖键', () => {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const value = PKG[key];
    const isEmpty = value === undefined || (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
    assert.ok(isEmpty, `${key} 必须为空或不存在，实际是 ${JSON.stringify(value)}`);
  }
});
