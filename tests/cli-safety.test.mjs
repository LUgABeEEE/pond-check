/**
 * pond-check · CLI 安全闸（tests/cli-safety.test.mjs）
 *
 * 钉的是两条 D8 遗留（docs/AUDIT-SUMMARY.md §2）：
 *
 *   D8-M2 · `--out` 静默覆盖
 *     实测把用户的 `DO NOT TOUCH` 文件覆盖成 9008 B HTML，递归建父目录、
 *     无 `--force`、符号链接顺链写。本文件用**真文件系统**（mkdtemp）验证：
 *       1. 目标已存在 → 默认拒绝，stderr 说清原因，退出码非 0，原文件一字节不动；
 *       2. 只有 --force 才覆盖；
 *       3. 目标本身是符号链接 → 默认拒绝，且 --force 也不写穿（别处的文件不动）；
 *       4. --help 写明 --force 语义；
 *       5. 父目录不存在 → 仍可递归创建（便利功能保留）；
 *          父目录是个文件 → 明确报错，不写报告。
 *
 *   D8-M6 · Windows 未报 unsupported
 *     v0.1 只在 Linux 上验证过。platform=win32 时必须早退：stderr 明确说
 *     「不支持 Windows」、退出码非 0、**不扫描不渲染不写盘**。platform 走
 *     deps 注入，测试不必真在 Windows 上跑。
 *
 * 口径：管线（discover/readAll/evaluate/render/writeFile）可注入，写盘用真的
 *（不注入 writeFile），这样「原文件有没有被动过」是拿 byte 比出来的，不是信
 * 一个假 writer 的自述。变异验证见提交说明：去掉保护后本文件必须红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import evaluate from '../src/evaluate/index.mjs';
import renderHtml from '../src/render/html.mjs';
import { parseCliArgs, runCli, USAGE } from '../src/cli.mjs';

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 每次一个干净的真临时目录（用完删掉）。 */
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-check-cli-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 可断言的假管线：不扫真机，stdout/stderr 收集成字符串。
 * writeFile 默认**不注入** —— 用 src/cli.mjs 里真的写盘实现。
 */
function makeHarness(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const deps = {
    discover: () => [],
    readAll: async () => [],
    evaluate,
    renderHtml,
    stdout: (text) => stdout.push(String(text)),
    stderr: (text) => stderr.push(String(text)),
    now: Date.parse('2026-11-07T20:30:00+08:00'),
    ...overrides,
  };
  return { deps, stdout, stderr, out: () => stdout.join(''), err: () => stderr.join('') };
}

/* ------------------------------------------------------------------ *
 * 1. D8-M2 · 已存在文件默认拒绝
 * ------------------------------------------------------------------ */

test('D8-M2：--out 指向已存在文件 → 默认拒绝，退出码非 0，原文件一字节不动', async (t) => {
  const dir = makeTmpDir(t);
  const victim = path.join(dir, 'DO NOT TOUCH.txt');
  const original = 'DO NOT TOUCH\nthis is the user\'s file.\n';
  fs.writeFileSync(victim, original);

  // 扫描打点：拒绝必须发生在扫描之前，别让人白等一轮才知道路径不能用
  let scanned = 0;
  const { deps, out, err } = makeHarness({
    cwd: dir,
    discover: () => {
      scanned += 1;
      return [];
    },
    readAll: async () => {
      scanned += 1;
      return [];
    },
  });

  const code = await runCli(['--out', 'DO NOT TOUCH.txt'], deps);

  assert.notEqual(code, 0, '覆盖被拒绝时退出码必须非 0');
  assert.equal(fs.readFileSync(victim, 'utf8'), original, '用户的文件被改动了 —— 这正是 D8-M2 的事故');
  assert.match(err(), /已存在/, 'stderr 没说清「文件已存在」');
  assert.match(err(), /--force/, 'stderr 没告诉用户怎么覆盖');
  assert.match(err(), /换个输出路径|换一个输出路径/, 'stderr 没给「换个路径」这条路');
  assert.equal(out(), '', '被拒绝时不该往 stdout 打报告路径');
  assert.equal(scanned, 0, '拒绝发生得太晚：已经扫描过了');
});

test('D8-M2：本工具自己上一次的报告（pond-check-*.html）也默认拒绝，只提示可 --force', async (t) => {
  const dir = makeTmpDir(t);
  const own = path.join(dir, 'pond-check-20260101-000000.html');
  fs.writeFileSync(own, 'old report bytes\n');

  const { deps, err } = makeHarness({ cwd: dir });
  const code = await runCli(['--out', 'pond-check-20260101-000000.html'], deps);

  assert.notEqual(code, 0);
  assert.equal(fs.readFileSync(own, 'utf8'), 'old report bytes\n', '旧报告不该被静默覆盖');
  assert.match(err(), /--force/);
  assert.match(err(), /上一次的报告/, '自家产物应该多给一句「像是上一次的报告」');
});

/* ------------------------------------------------------------------ *
 * 2. D8-M2 · --force 才允许覆盖
 * ------------------------------------------------------------------ */

test('D8-M2：加 --force 才允许覆盖已存在文件', async (t) => {
  const dir = makeTmpDir(t);
  const target = path.join(dir, 'existing.html');
  fs.writeFileSync(target, 'old bytes\n');

  const { deps, out } = makeHarness({ cwd: dir });
  const code = await runCli(['--out', 'existing.html', '--force'], deps);

  assert.equal(code, 0, `--force 应放行，实际退出码 ${code}`);
  const written = fs.readFileSync(target, 'utf8');
  assert.ok(written.startsWith('<!doctype html>'), '文件没被写成 HTML 报告');
  assert.notEqual(written, 'old bytes\n');
  assert.equal(out(), `${target}\n`, '成功时应打印报告路径');
});

/* ------------------------------------------------------------------ *
 * 3. D8-M2 · 符号链接不许写穿
 * ------------------------------------------------------------------ */

test('D8-M2：--out 是符号链接 → 默认拒绝；--force 也不写穿，别处文件不动', async (t) => {
  const dir = makeTmpDir(t);
  const elsewhere = path.join(dir, 'elsewhere.conf');
  const original = 'precious elsewhere bytes\n';
  fs.writeFileSync(elsewhere, original);

  const link = path.join(dir, 'report.html');
  try {
    fs.symlinkSync(elsewhere, link);
  } catch (err) {
    // Windows 无权限建符号链接：跳过而不是假装通过
    t.skip(`这个环境建不了符号链接：${err.message}`);
    return;
  }

  for (const argv of [['--out', 'report.html'], ['--out', 'report.html', '--force']]) {
    const { deps, out, err } = makeHarness({ cwd: dir });
    const code = await runCli(argv, deps);

    assert.notEqual(code, 0, `${argv.join(' ')}：符号链接不该被放行`);
    assert.match(err(), /符号链接/, 'stderr 没说清目标是符号链接');
    assert.equal(
      fs.readFileSync(elsewhere, 'utf8'),
      original,
      `${argv.join(' ')}：顺着链接写到了别处 —— 这是 D8-M2 要防的事故`,
    );
    assert.ok(fs.lstatSync(link).isSymbolicLink(), '链接本身也该原样保留（没被替换成普通文件）');
    assert.equal(out(), '', '被拒绝时不该往 stdout 打报告路径');
  }
});

/* ------------------------------------------------------------------ *
 * 4. D8-M2 · --help 说明 --force
 * ------------------------------------------------------------------ */

test('D8-M2：--help 写明 --force 的语义（能覆盖 / 默认拒绝 / 符号链接不写穿）', async () => {
  const { deps, out } = makeHarness();
  const code = await runCli(['--help'], deps);
  assert.equal(code, 0);

  const help = out();
  assert.ok(help.includes('--force'), '--help 里根本没有 --force');
  assert.match(help, /--force[^\n]*覆盖/, '--help 没说 --force 是「允许覆盖」');
  assert.match(help, /默认拒绝覆盖/, '--help 没说默认拒绝');
  assert.match(help, /符号链接/, '--help 没说符号链接不写穿');
  // USAGE 是导出常量，和 runCli 用的是同一份
  assert.ok(USAGE.includes('--force'));

  // 解析层：--force 是合法开关，不是「缺值参数」；默认关闭
  assert.equal(parseCliArgs(['--force']).ok, true);
  assert.equal(parseCliArgs(['--force']).force, true);
  assert.equal(parseCliArgs([]).force, false);
  assert.equal(parseCliArgs(['--out', 'a.html', '--force']).force, true);
});

/* ------------------------------------------------------------------ *
 * 5. D8-M2 · 父目录：不存在则建，是文件则明确报错
 * ------------------------------------------------------------------ */

test('D8-M2：--out 父目录不存在 → 仍可递归创建（便利功能保留）', async (t) => {
  const dir = makeTmpDir(t);
  const { deps, out } = makeHarness({ cwd: dir });

  const code = await runCli(['--out', 'reports/2026/11/report.html'], deps);

  assert.equal(code, 0, `父目录不存在应可递归创建，实际退出码 ${code}`);
  const target = path.join(dir, 'reports', '2026', '11', 'report.html');
  assert.ok(fs.statSync(target).isFile(), '报告没写出来');
  assert.ok(fs.readFileSync(target, 'utf8').startsWith('<!doctype html>'));
  assert.equal(out(), `${target}\n`);
});

test('D8-M2：--out 父目录是个文件 → 明确报错，不写报告', async (t) => {
  const dir = makeTmpDir(t);
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'i am a file, not a directory\n');

  const { deps, out, err } = makeHarness({ cwd: dir });
  const code = await runCli(['--out', 'blocker/report.html'], deps);

  assert.notEqual(code, 0, '父目录是文件时必须非 0');
  assert.match(err(), /父目录不是目录/, 'stderr 没点名父目录不是目录');
  assert.match(err(), /blocker/, 'stderr 没说是哪个路径');
  assert.equal(out(), '', '失败时不该往 stdout 打报告路径');
  // 那个文件不许被动过
  assert.equal(fs.readFileSync(blocker, 'utf8'), 'i am a file, not a directory\n');
});

/* ------------------------------------------------------------------ *
 * 6. D8-M6 · Windows 早退（platform 注入，不依赖真 Windows）
 * ------------------------------------------------------------------ */

test('D8-M6：platform=win32 → 早退：明确报 unsupported、不扫描、不渲染、不写盘', async (t) => {
  const dir = makeTmpDir(t);
  const calls = { discover: 0, readAll: 0, evaluate: 0, renderHtml: 0, writeFile: 0 };

  const { deps, out, err } = makeHarness({
    cwd: dir,
    platform: 'win32',
    discover: () => {
      calls.discover += 1;
      return [];
    },
    readAll: async () => {
      calls.readAll += 1;
      return [];
    },
    evaluate: (...args) => {
      calls.evaluate += 1;
      return evaluate(...args);
    },
    renderHtml: () => {
      calls.renderHtml += 1;
      return '<!doctype html>被写出来就说明没早退';
    },
    writeFile: (file, data) => {
      calls.writeFile += 1;
      fs.writeFileSync(file, data);
    },
  });

  const code = await runCli([], deps);

  assert.notEqual(code, 0, 'win32 必须退出码非 0');
  assert.match(err(), /不支持 Windows/, 'stderr 没明确说「不支持 Windows」');
  assert.match(err(), /win32/, 'stderr 没点名 win32');
  assert.equal(out(), '', 'win32 不该往 stdout 打印报告路径（那会让人以为扫过了）');
  assert.deepEqual(calls, { discover: 0, readAll: 0, evaluate: 0, renderHtml: 0, writeFile: 0 },
    'win32 早退不彻底：还有环节跑了 / 写盘了');
  assert.deepEqual(fs.readdirSync(dir), [], 'win32 不许产出任何文件（包括报告）');
});

test('D8-M6：platform=win32 + --json / --out 也不产出（不装作扫描过）', async (t) => {
  const dir = makeTmpDir(t);
  for (const argv of [['--json'], ['--text'], ['--out', 'r.html']]) {
    const written = [];
    const { deps, out, err } = makeHarness({
      cwd: dir,
      platform: 'win32',
      writeFile: (file, data) => written.push({ file, data }),
    });
    const code = await runCli(argv, deps);
    assert.notEqual(code, 0, `${argv.join(' ')}：win32 下必须非 0`);
    assert.match(err(), /不支持 Windows/, `${argv.join(' ')}：没说 unsupported`);
    assert.equal(out(), '', `${argv.join(' ')}：stdout 不该有内容`);
    assert.equal(written.length, 0, `${argv.join(' ')}：不该写盘`);
  }
  assert.deepEqual(fs.readdirSync(dir), [], 'win32 不许产出文件');
});

test('D8-M6：非 win32（linux）照常出报告 —— 早退只针对 Windows', async (t) => {
  const dir = makeTmpDir(t);
  const { deps, err } = makeHarness({ cwd: dir, platform: 'linux' });
  const code = await runCli([], deps);

  assert.equal(code, 0, `linux 不该被早退拦住：${err()}`);
  assert.doesNotMatch(err(), /不支持 Windows/);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, 'linux 应正常写出 1 份报告');
  assert.match(files[0], /^pond-check-\d{8}-\d{6}\.html$/);
});
