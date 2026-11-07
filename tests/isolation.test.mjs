/**
 * pond-check · C7 架构隔离测试（tests/isolation.test.mjs）
 *
 * 这个文件钉的是**两层之间的那条线**，不是任何一个能力的功能：
 *
 *   诊断层（discover / read / evaluate / render / cli）  只读、不联网、无状态
 *   能力层（shared / memory / wake / tts / image）        可写 <POND_HOME>、可联网、有状态
 *
 * 唯一允许的接缝是**文件**：能力层写 `~/.pond/events.jsonl`，诊断层读它。
 * 两边**永远不互相 import 代码**（CAPABILITIES-SPEC §6.1）。
 *
 * 为什么这条线比功能测试更要紧：
 *   诊断层的价值完全来自「不联网、不写、无状态」。一旦它 import 了会联网 / 会写
 *   的能力模块，这个保证就在代码层面失守了，而用户从报告上看不出来——报告照样
 *   绿油油，但她已经在用户的机器上连了网、写了盘、有了状态。这种失守不会有
 *   任何功能测试发现，只能靠本文件这种架构断言 + 变异验证提前钉死。
 *
 * 本文件九组断言：
 *   1. 红线：诊断层不许 import memory / tts / image / wake（规格 §6.1）
 *   2. 加固：诊断层连 shared 基座也不许 import（接缝是文件，不是代码）
 *   3. 反向：能力层不许 import 诊断层（依赖只能单向）
 *   4. fail-closed：src 下每个目录都必须被显式归类（新目录默认进不了能力层白名单）
 *   5. 零运行时依赖：package.json 无依赖字段，src 里只 import 内置模块 / 相对路径
 *   6. 行为：整条诊断管线跑完，fetch / WebSocket 调用次数必须为 0
 *   7. 行为：`<POND_HOME>` 里堆满能力层状态、再整目录删掉，诊断结果完全一致，
 *      且诊断层不会把目录重新建出来
 *   8. 接缝契约：事件流必备八字段齐备、额外键（attempt/errorCategory/…）必须
 *      被容忍、文件只追加不重写
 *   9. 包入口：exports map 覆盖五个能力 + 诊断入口，bin 不受影响，自引用可用
 *
 * 变异验证（见任务 commandsRun）：
 *   往 src/render/text.mjs 加一行 `import '../memory/index.mjs'` → 第 1 组必红；
 *   往 src/render/text.mjs 加 shared import → 第 2 组必红；
 *   往 src/memory/index.mjs 加诊断 import → 第 3 组必红。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import discoverPonds from '../src/discover/index.mjs';
import { readAll } from '../src/read/index.mjs';
import { probeDependencies } from '../src/read/state.mjs';
import evaluate from '../src/evaluate/index.mjs';
import renderJson from '../src/render/json.mjs';
import { appendAttempt, EVENT_FIELDS } from '../src/shared/events.mjs';
import { createMemory } from '../src/memory/index.mjs';
import { createWake } from '../src/wake/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'normal');
const NOW = Date.now();

/** 诊断层目录（`check` 是规格 §1 的名字，当前仓库叫 discover；两个都守）。 */
const DIAGNOSTIC_DIRS = Object.freeze(['check', 'discover', 'read', 'evaluate', 'render']);

/** 能力层目录（与 tests/source-guards.test.mjs 的 CAPABILITY_DIRS 同一张表）。 */
const CAPABILITY_DIRS = Object.freeze(['shared', 'memory', 'wake', 'tts', 'image']);

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-isolation-'));
let counter = 0;

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeTemp(label) {
  counter += 1;
  const dir = path.join(TEMP_ROOT, `${String(counter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 递归收集 .mjs。 */
function collectMjs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMjs(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/** 剥掉注释：注释里的 import 示例不是依赖。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

/**
 * 提取一个文件里所有**字面量** import 说明符。
 *   - `import x from 'a'` / `import { x } from 'a'` / `import 'a'`
 *   - `export { x } from 'a'` / `export * from 'a'`
 *   - `import('a')` / `require('a')`
 * 计算型说明符（`import(workerData.url)`）故意不猜——它没有静态可判的路径；
 * 第 5 组会另查这类写法里不许出现能力层目录名。
 */
function importSpecifiers(text) {
  const code = stripComments(text);
  const found = new Set();
  const patterns = [
    /\bimport\s+(?!\()(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gu,
    /\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** 相对说明符 → 仓库相对 POSIX 路径；非相对（node: / 裸包名）返回 null。 */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  return path.relative(ROOT, path.resolve(path.dirname(fromFile), specifier)).split(path.sep).join('/');
}

/** 收集某类文件的 { relative, imports: [{ specifier, target }] }。 */
function importsOf(files) {
  return files.map((file) => ({
    relative: path.relative(ROOT, file).split(path.sep).join('/'),
    imports: importSpecifiers(fs.readFileSync(file, 'utf8')).map((specifier) => ({
      specifier,
      target: resolveSpecifier(file, specifier),
    })),
  }));
}

function existingDirs(names) {
  return names.filter((name) => {
    const dir = path.join(SRC, name);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  });
}

function diagnosticFiles() {
  const files = [path.join(SRC, 'cli.mjs')];
  for (const name of existingDirs(DIAGNOSTIC_DIRS)) files.push(...collectMjs(path.join(SRC, name)));
  return files.filter((file) => fs.existsSync(file));
}

function capabilityFiles() {
  const files = [];
  for (const name of existingDirs(CAPABILITY_DIRS)) files.push(...collectMjs(path.join(SRC, name)));
  return files;
}

/* ================================================================== *
 * 1–3. import 方向
 * ================================================================== */

test('架构红线：诊断层不许 import memory / tts / image / wake', () => {
  const forbidden = ['src/memory/', 'src/tts/', 'src/image/', 'src/wake/'];
  const scanned = importsOf(diagnosticFiles());
  assert.ok(scanned.length >= 5, `诊断层文件太少（${scanned.length}），扫描路径可能写错了`);
  assert.ok(scanned.some((item) => item.relative === 'src/cli.mjs'), 'src/cli.mjs 没被扫到');

  const violations = [];
  for (const { relative, imports } of scanned) {
    for (const { specifier, target } of imports) {
      if (!target) continue;
      if (forbidden.some((prefix) => target.startsWith(prefix))) {
        violations.push(`${relative} → ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `诊断层 import 了能力层 —— 接缝只能是 ~/.pond/events.jsonl 这个文件：\n${violations.join('\n')}`,
  );
});

test('加固：诊断层连 shared 基座也不许 import（接缝是文件，不是代码）', () => {
  const violations = [];
  for (const { relative, imports } of importsOf(diagnosticFiles())) {
    for (const { specifier, target } of imports) {
      if (target && target.startsWith('src/shared/')) violations.push(`${relative} → ${specifier}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `诊断层 import 了能力层共享基座：\n${violations.join('\n')}\n`
      + '（EVENT_FIELDS 这类常量宁可在诊断侧复制，也不要让两层在代码层相连）',
  );
});

test('反向：能力层不许 import 诊断层（依赖只能单向）', () => {
  const forbidden = [
    'src/check/', 'src/discover/', 'src/read/', 'src/evaluate/', 'src/render/', 'src/cli.mjs',
  ];
  const scanned = importsOf(capabilityFiles());
  assert.ok(scanned.length >= 20, `能力层文件太少（${scanned.length}），扫描路径可能写错了`);

  const violations = [];
  for (const { relative, imports } of scanned) {
    for (const { specifier, target } of imports) {
      if (!target) continue;
      if (forbidden.some((prefix) => target === prefix || target.startsWith(prefix))) {
        violations.push(`${relative} → ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `能力层 import 了诊断层 —— 能力层必须能整目录删除而不影响体检：\n${violations.join('\n')}`,
  );
});

test('fail-closed：src 下每个目录都必须被显式归类为诊断层或能力层', () => {
  const dirs = fs.readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(dirs.length >= 5, 'src 目录数异常，扫描可能没读到');

  const unknown = dirs.filter((name) => !DIAGNOSTIC_DIRS.includes(name) && !CAPABILITY_DIRS.includes(name));
  assert.deepEqual(
    unknown,
    [],
    `新目录没有被归类：${unknown.join(', ')}\n`
      + '加进 CAPABILITY_DIRS 就意味着它获得「可写可联网」的许可，必须同时接受能力层约束；'
      + '没归类就默认按诊断层（只读、不联网）对待 —— 这是 fail-closed。',
  );

  // 能力层目录必须真实存在（C2–C6 都交付了），否则说明有人删掉了某一层。
  for (const name of CAPABILITY_DIRS) {
    assert.ok(fs.existsSync(path.join(SRC, name, 'index.mjs')), `src/${name}/index.mjs 不存在`);
  }
});

/* ================================================================== *
 * 5. 零运行时依赖
 * ================================================================== */

test('零运行时依赖：package.json 无依赖字段，src 只 import 内置模块 / 相对路径', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = pkg[key];
    assert.ok(
      value === undefined || Object.keys(value).length === 0,
      `package.json 出现了 ${key} —— 零运行时依赖是本项目的硬约束`,
    );
  }
  assert.match(String(pkg.engines?.node ?? ''), />=\s*22/u, 'engines.node 必须声明 >= 22');

  const violations = [];
  const badComputed = [];
  for (const file of collectMjs(SRC)) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const specifier of importSpecifiers(code)) {
      if (specifier.startsWith('node:') || specifier.startsWith('.')) continue;
      violations.push(`${relative} → ${specifier}`);
    }
    // 计算型 import(expr)：没有静态路径可判，但至少不许出现能力层目录名。
    for (const match of code.matchAll(/\bimport\s*\(\s*([^'")][^)]*)\)/gu)) {
      if (/(?:memory|tts|image|wake|shared)/u.test(match[1])) badComputed.push(`${relative}: import(${match[1]})`);
    }
  }
  assert.deepEqual(violations, [], `src 里出现了非内置、非相对的 import（等于引入 npm 依赖）：\n${violations.join('\n')}`);
  assert.deepEqual(badComputed, [], `计算型 import 指向了能力层目录：\n${badComputed.join('\n')}`);
});

/* ================================================================== *
 * 6. 行为：诊断路径不联网
 * ================================================================== */

/**
 * 跑一遍完整诊断管线（discover → read → evaluate → render）。
 * deps 用**一次**探测结果注入，抵消磁盘余量之类的机器噪声，保证可重复。
 */
async function runDiagnostic({ home, deps }) {
  const ponds = discoverPonds({
    home: path.join(FIXTURES, 'home'),
    dshHome: path.join(FIXTURES, 'dsh'),
  });
  const reads = await readAll(ponds, { now: NOW, home, allowExec: false, deps: structuredClone(deps) });
  const report = evaluate({ ponds: reads }, { now: NOW });
  return JSON.parse(renderJson(report));
}

test('边界复核：整条诊断管线跑完，fetch / WebSocket 调用次数必须为 0', async () => {
  const home = makeTemp('no-network-home');
  const deps = probeDependencies({ home, allowExec: false });

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let fetchCalls = 0;
  let socketCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    return Promise.reject(new Error('诊断层不许联网'));
  };
  globalThis.WebSocket = class ForbiddenWebSocket {
    constructor() {
      socketCalls += 1;
      throw new Error('诊断层不许联网');
    }
  };

  let report;
  try {
    report = await runDiagnostic({ home, deps });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }

  assert.equal(fetchCalls, 0, '诊断路径调用了 fetch —— 只读/离线承诺在代码层失守');
  assert.equal(socketCalls, 0, '诊断路径创建了 WebSocket');
  assert.ok(Array.isArray(report.fishes), '报告结构不对，断言无意义');
  assert.ok(report.fishes.length >= 1, '夹具里至少有 1 条鱼，否则等于没跑管线');
});

/* ================================================================== *
 * 7. 行为：~/.pond 整删不影响诊断层
 * ================================================================== */

test('边界复核：<POND_HOME> 堆满能力层状态再整删，诊断结果一致且不被重建', async () => {
  const emptyHome = makeTemp('empty-home');
  const deps = probeDependencies({ home: emptyHome, allowExec: false });
  const pondHome = makeTemp('pond-home');

  // 先塞一份「能力层完整状态」：事件流、记忆库、图配置、出图目录。
  await appendAttempt(
    { capability: 'tts', provider: 'edge', units: 12, ok: true },
    { env: { POND_HOME: pondHome }, now: () => NOW },
  );
  const memory = createMemory({ env: { POND_HOME: pondHome }, now: () => NOW });
  memory.remember('主人住在杭州');
  memory.close();
  fs.writeFileSync(path.join(pondHome, 'image.json'), JSON.stringify({ chain: ['comfyui'] }));
  fs.mkdirSync(path.join(pondHome, 'out'), { recursive: true });
  fs.writeFileSync(path.join(pondHome, 'out', 'image-x.png'), Buffer.from('not-a-real-png'));

  const original = process.env.POND_HOME;
  let withState;
  let afterDelete;
  let withBrokenHome;
  let withoutHome;
  try {
    process.env.POND_HOME = pondHome;
    withState = await runDiagnostic({ home: emptyHome, deps });

    fs.rmSync(pondHome, { recursive: true, force: true });
    assert.equal(fs.existsSync(pondHome), false);

    // 目录已删、环境变量还指着它：诊断层不许把它重新建出来。
    afterDelete = await runDiagnostic({ home: emptyHome, deps });
    assert.equal(
      fs.existsSync(pondHome),
      false,
      '诊断层把 <POND_HOME> 重新建出来了 —— 说明它在读写能力层状态目录',
    );

    // POND_HOME 指到一个文件上（能力层会降级/告警）：诊断层照样跑。
    const blocker = path.join(emptyHome, 'blocker');
    fs.writeFileSync(blocker, '不是目录');
    process.env.POND_HOME = blocker;
    withBrokenHome = await runDiagnostic({ home: emptyHome, deps });

    delete process.env.POND_HOME;
    withoutHome = await runDiagnostic({ home: emptyHome, deps });
  } finally {
    if (original === undefined) delete process.env.POND_HOME;
    else process.env.POND_HOME = original;
  }

  // meta.generatedAt 用固定 NOW，全部可重复；deps 也是同一份注入值。
  assert.deepEqual(withState, afterDelete, '删掉 <POND_HOME> 改变了诊断结论');
  assert.deepEqual(withState, withBrokenHome, 'POND_HOME 坏掉改变了诊断结论');
  assert.deepEqual(withState, withoutHome, '不设 POND_HOME 改变了诊断结论');
  assert.ok(withState.fishes.length >= 1, '夹具里至少有 1 条鱼');
  assert.equal(typeof withState.meta?.generatedAt, 'string');
});

/* ================================================================== *
 * 8. 接缝契约：events.jsonl
 * ================================================================== */

test('接缝契约：事件八字段齐备、额外键可容忍、只追加不重写', async () => {
  const home = makeTemp('seam');
  const env = { POND_HOME: home };

  await appendAttempt(
    { capability: 'tts', provider: 'edge', units: 10, ok: true },
    { env, now: () => NOW },
  );
  const memory = createMemory({ env, now: () => NOW });
  memory.remember('阿杰是主人大学室友');
  memory.close();
  const wake = createWake({ env, now: () => NOW });
  wake.pick({ now: NOW });
  wake.close();

  const file = path.join(home, 'events.jsonl');
  const beforeBytes = fs.readFileSync(file, 'utf8');
  const lines = beforeBytes.trim().split('\n');
  assert.ok(lines.length >= 3, `三类能力至少要各写一条事件，实际 ${lines.length}`);

  let sawExtraKeys = false;
  for (const line of lines) {
    const entry = JSON.parse(line);
    // 必备八字段：诊断层只按这八个读，也必须能读全。
    assert.deepEqual(
      Object.keys(entry).slice(0, EVENT_FIELDS.length),
      [...EVENT_FIELDS],
      `事件的前八个字段必须是与诊断层的契约：${line}`,
    );
    assert.equal(typeof entry.ts, 'string');
    assert.ok(Number.isFinite(Date.parse(entry.ts)), `ts 不是合法时间：${entry.ts}`);
    assert.equal(typeof entry.capability, 'string');
    assert.equal(typeof entry.provider, 'string');
    assert.equal(typeof entry.units, 'number');
    assert.equal(typeof entry.costEstimate, 'number');
    assert.equal(typeof entry.durationMs, 'number');
    assert.equal(typeof entry.ok, 'boolean');
    assert.ok(entry.error === null || typeof entry.error === 'string');
    if (Object.keys(entry).length > EVENT_FIELDS.length) sawExtraKeys = true;
  }
  assert.equal(sawExtraKeys, true, '应至少有一条事件带额外键（attempt/errorCategory/op/…）');

  // 模拟一个「只认八字段」的诊断读者：额外键不该让它算错数。
  const totals = { calls: 0, units: 0, failures: 0 };
  for (const line of lines) {
    const entry = JSON.parse(line);
    totals.calls += 1;
    totals.units += entry.units;
    if (entry.ok !== true) totals.failures += 1;
  }
  assert.equal(totals.calls, lines.length);
  assert.ok(totals.units >= 10);

  // append-only：再写一条，旧内容必须逐字节保持前缀。
  await appendAttempt(
    { capability: 'image', provider: 'comfyui', units: 1, ok: true },
    { env, now: () => NOW },
  );
  const afterBytes = fs.readFileSync(file, 'utf8');
  assert.ok(afterBytes.startsWith(beforeBytes), '事件流被重写/轮转了 —— 必须只追加');
  assert.equal(afterBytes.trim().split('\n').length, lines.length + 1);
});

/* ================================================================== *
 * 9. 包入口：exports / bin / 自引用
 * ================================================================== */

test('包入口：exports 覆盖五个能力与诊断入口，目标文件存在；bin 不变', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  const expected = {
    '.': './src/cli.mjs',
    './shared': './src/shared/index.mjs',
    './memory': './src/memory/index.mjs',
    './wake': './src/wake/index.mjs',
    './tts': './src/tts/index.mjs',
    './image': './src/image/index.mjs',
    './package.json': './package.json',
  };
  assert.ok(pkg.exports, 'package.json 缺少 exports：npm 装出来的包只能 import 主入口');
  for (const [subpath, target] of Object.entries(expected)) {
    assert.equal(pkg.exports[subpath], target, `exports['${subpath}'] 不对`);
    assert.ok(fs.existsSync(path.join(ROOT, target)), `exports['${subpath}'] 指向的文件不存在：${target}`);
  }

  // bin 不受 exports 影响：命令行入口还在。
  assert.deepEqual(pkg.bin, { 'pond-check': 'src/cli.mjs' });
  const help = execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), '--help'], {
    encoding: 'utf8',
    env: { ...process.env, POND_HOME: path.join(TEMP_ROOT, 'help-home') },
  });
  assert.match(help, /用法/u, '--help 输出不对，bin 入口可能坏了');

  // 自引用：包内模块按包名 import 子路径（Node 靠 exports + name 解析）。
  const expectations = {
    'pond-check/shared': 'createRegistry',
    'pond-check/memory': 'createMemory',
    'pond-check/wake': 'createWake',
    'pond-check/tts': 'createTts',
    'pond-check/image': 'createImageClient',
    'pond-check': 'parseCliArgs',
  };
  for (const [specifier, symbol] of Object.entries(expectations)) {
    const mod = await import(specifier);
    assert.equal(typeof mod[symbol], 'function', `${specifier} 没有导出 ${symbol}()`);
  }
});
