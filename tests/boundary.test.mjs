/**
 * pond-check · D6a 崩溃边界压测（tests/boundary.test.mjs）
 *
 * 这不是功能测试，是**攻击**测试。用真实文件系统里最难看的输入去撞读取层和判定层，
 * 目标只有两个：
 *   1. 能不能把它撞崩 —— 抛异常、挂死（FIFO / 环状软链）、把内存读爆（超大日志）；
 *   2. 能不能让它**假健康** —— 读不到 / 读不懂的东西被说成「正常 · 干净 · 活跃」。
 *
 * 八条必测（任务书原话）：
 *   1) 目录不存在      → 不抛，unknown 或空
 *   2) 文件无权限      → 降级 null + reason
 *   3) 日志为空        → 不崩，且绝不能被判成「健康」
 *   4) 日志超大 >64KB  → 只读尾部，不 OOM
 *   5) 非 UTF-8 / 二进制 → 不崩
 *   6) 符号链接成环    → 不无限递归
 *   7) 假健康反例：目录在、产物全读不到 → 必须 unknown，绝不能 healthy
 *   8) 配置带 token/secret → 该值不得出现在任何输出里
 *
 * 铁律：
 *   - 只读被测实现，**不改 src/**（发现的缺陷写进任务 output，由收口任务修）。
 *   - 夹具全部建在 mkdtemp 出来的临时目录里，退出时先复原权限再删（chmod 000 的
 *     目录删不掉，必须先 chmod 回来）。
 *   - 不押「只在本机成立」的东西：deps 一格依赖本机 ffmpeg / 凭证文件，故边界
 *     用例只断言**数据类指标**（liveness / rhythm / throughput / health / drift）
 *     与「绝不出现绿色 severity=ok」，不断言 deps 的具体档位。
 *   - 时间基准统一取真实 now：文件 mtime 是真实活动痕迹，用假 now 反而测不到东西。
 *     需要「旧痕迹」的用例自己 utimes 往回调。
 *
 * 两个 { skip } 标记的用例是**已知缺陷探针**（B1 / B2），断言代码已经写好，
 * 收口任务修完 src 把 skip 去掉即可转绿；缺陷详情见任务 output。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { readPond, readAll } from '../src/read/index.mjs';
import { readLogTail } from '../src/read/log.mjs';
import { evaluate } from '../src/evaluate/index.mjs';
import { discoverPonds } from '../src/discover/index.mjs';
import { renderHtml } from '../src/render/html.mjs';
import { renderText } from '../src/render/text.mjs';
import { renderJson } from '../src/render/json.mjs';

/* ------------------------------------------------------------------ *
 * 夹具地基
 * ------------------------------------------------------------------ */

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-check-boundary-'));
const NOW = Date.now();

/** 预算（取自 rules.json，不在这里另写一套数字） */
const RULES = JSON.parse(fs.readFileSync(new URL('../src/rules.json', import.meta.url), 'utf8'));
const TAIL_BYTES = Number(RULES?.budget?.tailBytes) > 0 ? Number(RULES.budget.tailBytes) : 262144;
const TAIL_LINES = Number(RULES?.budget?.tailLines) > 0 ? Number(RULES.budget.tailLines) : 500;

/** 数据类指标：不依赖宿主机装了什么，边界用例只对它们下断言。 */
const DATA_INDICATORS = ['liveness', 'rhythm', 'throughput', 'health', 'drift'];

/** chmod 在 root 下不生效、在 Windows 上不存在 —— 这两种情况相关用例只能跳过。 */
const CAN_CHMOD = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

let counter = 0;

/**
 * 在临时区里造一个「窝」。
 * @param {string} label 目录名（自动加序号防重）
 * @param {Record<string, string|Buffer>} files 相对路径 → 内容（支持子目录，用 / 分隔）
 * @returns {string} 绝对路径
 */
function makePond(label, files = {}) {
  counter += 1;
  const root = path.join(TEMP_ROOT, `${String(counter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

/** 把文件 mtime 拨到 secondsAgo 秒之前（造「旧的写入痕迹」）。 */
function ageFile(filePath, secondsAgo) {
  const at = (NOW - secondsAgo * 1000) / 1000;
  fs.utimesSync(filePath, at, at);
}

/** 一条鱼读 + 判，返回 { read, report, fish }（单条鱼永远是 report.fishes[0]）。 */
async function inspect(rootPath, options = {}) {
  const read = await readPond(
    { id: `fish-${counter}`, kind: 'generic', rootPath, ...options.pond },
    { now: NOW, home: TEMP_ROOT, ...options.read },
  );
  const report = evaluate({ ponds: [read] }, { now: NOW });
  return { read, report, fish: report.fishes[0] };
}

/** 断言：这条鱼的数据类指标里没有任何一格是「正常」。 */
function assertNoDataIndicatorHealthy(fish, label) {
  for (const id of DATA_INDICATORS) {
    const cell = fish.indicators[id];
    assert.notEqual(
      cell.severity, 'ok',
      `${label}：${id} 被判成「正常」（level=${cell.level}），但它的输入根本读不到/读不懂`,
    );
  }
}

/** 递归把权限改回可删（chmod 000 的目录 rmSync 会 EACCES）。 */
function restoreModes(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  try {
    if (st.isDirectory()) {
      fs.chmodSync(target, 0o700);
      for (const entry of fs.readdirSync(target)) restoreModes(path.join(target, entry));
    } else if (!st.isSymbolicLink()) {
      fs.chmodSync(target, 0o600);
    }
  } catch {
    // 复原失败也不影响测试结论，删除阶段会用 force 兜底
  }
}

after(() => {
  try {
    restoreModes(TEMP_ROOT);
  } finally {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 1. 目录不存在
 * ------------------------------------------------------------------ */

test('目录不存在：readPond 不抛，报告里仍有这条鱼（六格 unknown），不是被悄悄丢掉', async () => {
  const ghost = path.join(TEMP_ROOT, '00-nonexistent', 'deep', 'deeper');
  const read = await readPond({ id: 'ghost', kind: 'generic', rootPath: ghost }, { now: NOW, home: TEMP_ROOT });

  assert.equal(read.ok, true, '读不到目录不等于「读取失败」，它是一次成功的「什么都没找到」');
  assert.deepEqual(read.missing.sort(), ['config', 'dedupe', 'log', 'sessions']);

  const report = evaluate({ ponds: [read] }, { now: NOW });
  assert.equal(report.fishes.length, 1, '一条读不出东西的鱼必须出现在报告里，不能凭空消失');

  const fish = report.fishes[0];
  for (const id of ['rhythm', 'throughput', 'health', 'drift']) {
    assert.equal(fish.indicators[id].level, 'unknown', `${id} 没有输入就必须是 unknown`);
  }
  assertNoDataIndicatorHealthy(fish, '目录不存在');
  assert.notEqual(fish.severity, 'ok', '整条鱼不能因为「什么都没读到」被判成正常');
  assert.ok(fish.indicators.health.evidence.missing.length > 0, 'unknown 必须说清缺什么');
});

test('discoverPonds 扫不存在的家目录：返回空数组、不抛、不超时', () => {
  const started = performance.now();
  const ponds = discoverPonds({
    home: path.join(TEMP_ROOT, '00-nonexistent-home'),
    dshHome: path.join(TEMP_ROOT, '00-nonexistent-dsh'),
  });
  const elapsed = performance.now() - started;

  assert.ok(Array.isArray(ponds), '必须是数组（调用方直接 .map）');
  assert.equal(ponds.length, 0);
  assert.ok(elapsed < 5000, `扫空目录用了 ${elapsed.toFixed(0)}ms，太慢，可能没走预算上限`);
});

/* ------------------------------------------------------------------ *
 * 2. 文件无权限（chmod 000）→ 降级 null + reason
 * ------------------------------------------------------------------ */

test('文件无权限（chmod 000）：日志降级成 ok:false + reason，来源标 unreadable，不抛', { skip: CAN_CHMOD ? false : 'chmod 需要非 root 的 POSIX 环境' }, async () => {
  const root = makePond('denied', { 'app.log': '2026-11-07T10:00:00Z 她刚醒\n' });
  const logPath = path.join(root, 'app.log');
  fs.chmodSync(logPath, 0o000);

  const { read, fish } = await inspect(root);

  assert.equal(read.ok, true, '一条鱼的日志读不了，不该让整条鱼的读取「失败」');
  assert.notEqual(read.log, null, '日志对象要保留（含 reason），不能直接变 null');
  assert.equal(read.log.ok, false);
  assert.equal(read.log.reason, 'eacces', '权限错误必须如实写成 eacces，不是 read_error 也不是 enoent');
  assert.equal(read.sources.log.status, 'unreadable');
  assert.deepEqual(
    read.unreadable.find((item) => item.source === 'log'),
    { source: 'log', reason: 'eacces' },
  );
  assert.equal(fish.indicators.health.level, 'unknown', '读不到的日志不许说成「干净」');
});

test('配置 / 判重表无权限：同样降级成 reason，不是「0 条」「没漂」', { skip: CAN_CHMOD ? false : 'chmod 需要非 root 的 POSIX 环境' }, async () => {
  const root = makePond('denied-state', {
    'config.json': JSON.stringify({ schemaVersion: 1 }),
    'processed.json': JSON.stringify([{ bvid: 'BV1', processedAt: NOW - 60_000 }]),
  });
  fs.chmodSync(path.join(root, 'config.json'), 0o000);
  fs.chmodSync(path.join(root, 'processed.json'), 0o000);

  const { read, fish } = await inspect(root);

  assert.equal(read.sources.config.status, 'unreadable');
  assert.equal(read.sources.config.reason, 'permission_denied');
  assert.equal(read.config.schemaVersion, null);
  assert.equal(fish.indicators.drift.level, 'unknown', '读不到配置就不许说「没漂」');
  assert.notEqual(fish.indicators.throughput.value, 0, '读不到判重表不许报成「0 条」');
  assert.equal(fish.indicators.throughput.level, 'unknown');
});

/* ------------------------------------------------------------------ *
 * 3. 日志为空
 * ------------------------------------------------------------------ */

test('日志为空（0 字节）：不崩；健康判不出、整条鱼不是「正常」', async () => {
  const root = makePond('empty-log', { 'app.log': '' });
  const { read, report, fish } = await inspect(root);

  assert.equal(read.log.ok, false);
  assert.equal(read.log.reason, 'empty', '0 字节要如实说 empty，不是「读到了但没内容」的假通过');
  assert.equal(fish.indicators.health.level, 'unknown', '空日志没有任何内容可判，健康只能是 unknown');
  assert.equal(fish.indicators.rhythm.level, 'unknown');
  assert.notEqual(fish.severity, 'ok', '空日志的鱼不许出现在「正常」那一桶');
  assert.ok(report.footnote, '有判不出的格，脚注必须说一句，不能静静地装作正常');
});

test('日志为空且写入痕迹很旧：存活不得说成「活跃」（空文件不构成活动证据）', async () => {
  const root = makePond('empty-old', { 'app.log': '' });
  ageFile(path.join(root, 'app.log'), 10 * 86400);

  const { fish } = await inspect(root);

  assert.notEqual(fish.indicators.liveness.level, 'active', '十天没写过、内容还是空的，不能说她「刚刚还在动」');
  assert.notEqual(fish.indicators.liveness.severity, 'ok');
});

test(
  '【缺陷 B2 已修】日志为空（刚被 touch，mtime 是新的）：liveness 必须 unknown，不能说「她不到 1 分钟前还在动」',
  async () => {
    const root = makePond('empty-fresh', { 'app.log': '' });
    const { fish } = await inspect(root);
    assert.equal(fish.indicators.liveness.level, 'unknown');
  },
);

/* ------------------------------------------------------------------ *
 * 4. 日志超大 → 只读尾部
 * ------------------------------------------------------------------ */

/** 造一个 >targetBytes 的日志：头标记 + 填充 + 尾标记。 */
function makeBigLog(filePath, targetBytes, headMarker, tailMarker) {
  const line = `2026-11-07T10:00:00Z INFO filler-padding-padding-padding-padding\n`;
  const block = line.repeat(1024);
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, `${headMarker}\n`);
    let written = 0;
    while (written < targetBytes) {
      fs.writeSync(fd, block);
      written += Buffer.byteLength(block);
    }
    fs.writeSync(fd, `${tailMarker}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

test('日志超大（约 8 MiB）：只读尾部 —— 命中尾标记、读不到头标记、读取量不超预算', async () => {
  const root = makePond('big-log');
  const logPath = path.join(root, 'app.log');
  makeBigLog(logPath, 8 * 1024 * 1024, 'HEADONLY-MARKER-aaaa', 'TAILONLY-MARKER-bbbb');

  const size = fs.statSync(logPath).size;
  const { read } = await inspect(root);

  assert.ok(size > 8 * 1024 * 1024, '夹具本身要足够大，否则这个用例什么也没测到');
  assert.equal(read.log.ok, true);
  assert.equal(read.log.size, size, '报告的 size 要是真实文件大小，不是读了多少');
  assert.ok(read.log.bytesRead <= TAIL_BYTES, `读了 ${read.log.bytesRead} 字节，超过尾部预算 ${TAIL_BYTES} —— 整份读会 OOM`);
  assert.equal(read.log.truncated, true, '读的不是整份，必须标 truncated');
  assert.ok(read.log.lines.length <= TAIL_LINES, `保留 ${read.log.lines.length} 行，超过行数上限`);

  const tailText = read.log.lines.join('\n');
  assert.ok(tailText.includes('TAILONLY-MARKER-bbbb'), '尾部内容必须读到（否则「最新怎么了」无从谈起）');
  assert.ok(!tailText.includes('HEADONLY-MARKER-aaaa'), '文件头的内容不该出现在尾部窗口里 —— 读的不是尾部');
});

test('日志极大（1 GiB 稀疏文件）：读取量仍有界，不 OOM、不超时', async () => {
  const root = makePond('sparse-log');
  const logPath = path.join(root, 'app.log');
  const marker = Buffer.from('TAILONLY-SPARSE-MARKER-cccc\n', 'utf8');
  const size = 1024 * 1024 * 1024;

  const fd = fs.openSync(logPath, 'w');
  try {
    fs.writeSync(fd, marker, 0, marker.length, size - marker.length);
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }

  const started = performance.now();
  const { read } = await inspect(root);
  const elapsed = performance.now() - started;

  assert.equal(read.log.ok, true);
  assert.ok(read.log.bytesRead <= TAIL_BYTES, `1 GiB 文件读了 ${read.log.bytesRead} 字节 —— 预算失效`);
  assert.ok(elapsed < 5000, `读一个 1 GiB 的稀疏日志用了 ${elapsed.toFixed(0)}ms，体检会卡住用户机器`);
});

test('单行 1 MiB 的日志：行被裁剪，不 OOM、不崩', async () => {
  const root = makePond('one-huge-line');
  fs.writeFileSync(
    path.join(root, 'app.log'),
    `2026-11-07T10:00:00Z ${'x'.repeat(1024 * 1024)}\n`,
  );

  const { read } = await inspect(root);

  assert.equal(read.log.ok, true);
  assert.ok(read.log.bytesRead <= TAIL_BYTES);
  for (const line of read.log.lines) {
    assert.ok(line.length <= 4000, `保留了一行 ${line.length} 字符的长行，报告会被撑爆`);
  }
  assert.ok(
    read.log.degraded.some((item) => item.reason === 'long_line_clipped'),
    '裁剪长行要留痕（long_line_clipped），不能悄悄剪',
  );
});

/* ------------------------------------------------------------------ *
 * 5. 非 UTF-8 / 二进制
 * ------------------------------------------------------------------ */

test('非 UTF-8 字节（无 NUL）：宽松解码，不崩，报告照出', async () => {
  const root = makePond('latin1-log');
  fs.writeFileSync(path.join(root, 'app.log'), Buffer.concat([
    Buffer.from('2026-11-07T10:00:00Z caf'), Buffer.from([0xe9, 0xe8, 0xff]), Buffer.from(' 一行\n'),
    Buffer.from('2026-11-07T10:01:00Z second \xff\xfe line\n'),
  ]));

  const { read, report, fish } = await inspect(root);

  assert.equal(read.log.ok, true, '坏字节要被宽松解码，不是整份读取失败');
  assert.equal(read.log.encoding, 'utf8-loose');
  assert.equal(read.log.lines.length, 2, '坏字节不能把行切碎或吞行');
  assert.equal(read.log.lastTimestamp?.iso, new Date('2026-11-07T10:01:00Z').toISOString());
  // 少量坏字节（低于 10%）不算二进制：关键词统计照常可用，档位由 rules 判，不在这里押
  assert.ok(['clean', 'noisy', 'sick', 'critical', 'unknown'].includes(fish.indicators.health.level));
  assert.equal(typeof renderText(report), 'string');
  assert.doesNotThrow(() => renderHtml(report));
});

test('二进制日志（含 NUL）：不崩，hasBinary 如实标注，证据进 JSON', async () => {
  const root = makePond('binary-log');
  fs.writeFileSync(
    path.join(root, 'app.log'),
    Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x42]),
  );

  const { read, report, fish } = await inspect(root);

  assert.equal(read.log.ok, true);
  assert.equal(read.log.hasBinary, true, '二进制必须被识别出来，否则后面的关键词统计全是噪音');
  assert.equal(fish.indicators.health.evidence.hasBinary, true, '健康格的证据里要留 hasBinary');
  assert.ok(
    JSON.parse(renderJson(report)).fishes[0].indicators.health.evidence.hasBinary === true,
    '--json 输出必须保留 hasBinary，否则机器消费者也看不见',
  );
  assert.equal(typeof renderText(report), 'string');
});

test(
  '【缺陷 B1 已修】二进制日志：健康不得被判成「干净」，总评不得把它算进「正常」',
  async () => {
    const root = makePond('binary-log-health');
    fs.writeFileSync(
      path.join(root, 'app.log'),
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x42]),
    );

    const { read, report, fish } = await inspect(root);

    assert.ok(
      read.degraded.some((item) => item.indicator === 'health' && item.reason === 'binary_content'),
      '前提：D3 实际标了这条降级（这条断言当前成立）',
    );
    assert.notEqual(fish.indicators.health.level, 'clean', '内容读不懂的日志，不能说「干净」');
    assert.equal(
      report.footnote?.includes('health'), true,
      '就算不改档位，脚注也必须把 health 这条「读不懂」列出来，不能整条吞掉',
    );
  },
);

/* ------------------------------------------------------------------ *
 * 6. 符号链接成环
 * ------------------------------------------------------------------ */

test('符号链接成环（自指 / 互指）：读取在有限时间内收敛，不无限递归', async () => {
  const root = makePond('symlink-cycle', { 'config.json': JSON.stringify({ schemaVersion: 1 }) });
  fs.symlinkSync(root, path.join(root, 'self'), 'dir');
  fs.symlinkSync(path.join(root, 'self'), path.join(root, 'self2'), 'dir');
  fs.mkdirSync(path.join(root, 'logs'));
  fs.symlinkSync(root, path.join(root, 'logs', 'back'), 'dir');

  const started = performance.now();
  const { read, report } = await inspect(root);
  const elapsed = performance.now() - started;

  assert.equal(read.ok, true);
  assert.ok(elapsed < 5000, `环状软链让读取跑了 ${elapsed.toFixed(0)}ms，疑似递归`);
  assert.equal(report.fishes.length, 1);
});

test('符号链接成环：discoverPonds 不递归、不挂死，端到端仍出报告', async () => {
  const home = path.join(TEMP_ROOT, 'cycle-home');
  const fishDir = path.join(home, 'bili-whale-cycle');
  fs.mkdirSync(path.join(fishDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(fishDir, 'config.json'), JSON.stringify({ schemaVersion: 1 }));
  fs.writeFileSync(path.join(fishDir, 'logs', 'app.log'), '2026-11-07T10:00:00Z 干活了\n');
  fs.symlinkSync(home, path.join(home, 'up'), 'dir');
  fs.symlinkSync(fishDir, path.join(fishDir, 'me'), 'dir');
  fs.symlinkSync(fishDir, path.join(fishDir, 'logs', 'loop'), 'dir');

  const started = performance.now();
  const ponds = discoverPonds({ home, dshHome: path.join(home, '.dsh') });
  const elapsed = performance.now() - started;

  assert.ok(Array.isArray(ponds));
  assert.ok(elapsed < 5000, `发现阶段跑了 ${elapsed.toFixed(0)}ms，疑似顺着软链递归`);
  assert.ok(ponds.length >= 1, '名字像鱼、特征齐全的目录应当被认出来');

  // 真走一遍 发现 → 读取 → 判定：软链环不许让后半程卡住或丢鱼
  const reads = await readAll(ponds, { now: NOW, home: TEMP_ROOT });
  const report = evaluate({ ponds: reads }, { now: NOW });
  assert.equal(report.fishes.length, ponds.length, '发现了几条就要在报告里出现几条');
  assert.ok(report.fishes.every((fish) => fish.indicators !== null), '每一条都要有六格');
});

/* ------------------------------------------------------------------ *
 * 7. 假健康反例：目录在，产物全读不到
 * ------------------------------------------------------------------ */

test('假健康反例：目录存在但所有产物都读不到 → 数据类指标没有一个「正常」', { skip: CAN_CHMOD ? false : 'chmod 需要非 root 的 POSIX 环境' }, async () => {
  const root = makePond('all-unreadable', {
    'app.log': '2026-11-07T10:00:00Z 她干过活\n',
    'config.json': JSON.stringify({ schemaVersion: 1 }),
    'processed.json': JSON.stringify([{ bvid: 'BV1', processedAt: NOW - 60_000 }]),
  });
  for (const name of ['app.log', 'config.json', 'processed.json']) {
    const target = path.join(root, name);
    fs.chmodSync(target, 0o000);
    ageFile(target, 20 * 86400); // 旧的写入痕迹：连 mtime 都不该把人骗成「刚刚还在动」
  }

  const { read, report, fish } = await inspect(root);

  // 三份产物确实都读不到（否则这个反例什么也没测到）
  assert.equal(read.sources.log.status, 'unreadable');
  assert.equal(read.sources.config.status, 'unreadable');
  assert.equal(read.sources.dedupe.status, 'unreadable');
  assert.equal(read.unreadable.length, 3);

  assertNoDataIndicatorHealthy(fish, '产物全读不到');
  assert.notEqual(fish.severity, 'ok');
  assert.equal(fish.indicators.health.level, 'unknown');
  assert.equal(fish.indicators.drift.level, 'unknown');
  assert.equal(fish.indicators.throughput.level, 'unknown');
  assert.ok(report.footnote, '三项读不到，脚注必须留话');
  assert.ok(report.degradedCount >= 3, `脚注只数了 ${report.degradedCount} 项读不到，至少该数到三项`);
});

/* ------------------------------------------------------------------ *
 * 8. 配置里塞 token / secret：值零泄漏
 * ------------------------------------------------------------------ */

const LEAK_VALUES = [
  'sk-LEAKY-TOKEN-VALUE-123',
  'AKIA-LEAKY-KEY-456',
  'hunter2-LEAKY-PASSWORD',
  'NESTED-SECRET-789',
  'RTOKEN-LEAK-000',
];

test('配置带 token/secret 字段：该值不得出现在报告 / JSON / HTML / 文本任何输出里', async () => {
  const root = makePond('secret-config', {
    'config.json': JSON.stringify({
      schemaVersion: 1,
      name: 'secret-fish',
      token: LEAK_VALUES[0],
      apiKey: LEAK_VALUES[1],
      password: LEAK_VALUES[2],
      nesting: { api_secret: LEAK_VALUES[3], refresh_token: LEAK_VALUES[4] },
      baseUrl: 'https://example.invalid/v1',
      model: 'gpt-x',
    }),
    'app.log': '2026-11-07T10:00:00Z 启动完成\n',
  });

  const { read, report } = await inspect(root);
  const outputs = {
    read: JSON.stringify(read),
    report: JSON.stringify(report),
    json: renderJson(report),
    html: renderHtml(report),
    text: renderText(report),
  };

  for (const [where, text] of Object.entries(outputs)) {
    for (const secret of LEAK_VALUES) {
      assert.equal(text.includes(secret), false, `${where} 输出里出现了凭证值 ${secret.slice(0, 8)}…`);
    }
  }
  // 敏感键名连「存不存在」都不该说：fieldsPresent 只允许出现非敏感字段
  for (const key of Object.keys(read.config.fieldsPresent ?? {})) {
    assert.equal(/token|secret|password|apiKey|auth|cookie/i.test(key), false, `配置里回显了敏感键名 ${key}`);
  }
});

test('凭证味文件名的文件：整份不读，文件名也不进结果', async () => {
  // 这几个文件名是**故意**挑的：把凭证词和定位器认的惯例名拼在一起
  // （seen_* 像判重表、*.log 像日志、config.json 像配置）。
  // 只要凭证闸漏一句，定位器就会把它们当成正常产物读进来 —— 名字也会跟着进报告。
  const CREDENTIAL_FILES = [
    'auth_tokens.json',
    'credentials.json',
    'seen_tokens.json',
    'cookie_session.log',
    'config_secret.json',
    'bili-session.log',
    'sent_sessions.json',
  ];
  const files = {
    'config.json': JSON.stringify({ schemaVersion: 1 }),
    'seen_tokens.json': JSON.stringify({ access_token: LEAK_VALUES[0], refresh: LEAK_VALUES[4] }),
    'credentials.json': JSON.stringify({ password: LEAK_VALUES[2] }),
    'auth_tokens.json': JSON.stringify({ apiKey: LEAK_VALUES[1] }),
    'cookie_session.log': `2026-11-07T10:00:00Z ${LEAK_VALUES[3]}\n`,
    'config_secret.json': JSON.stringify({ secret: LEAK_VALUES[3] }),
    'app.log': '2026-11-07T10:00:00Z 启动完成\n',
    // 下面两个只靠 rules.json 的 *session* 模式才拦得住（名字里没有 credentialish 的那几个词），
    // 而且故意把 mtime 拨得比 app.log 更新：闸一漏，它们就会抢着当「最新的日志 / 判重表」。
    'bili-session.log': `2026-11-07T10:05:00Z ${LEAK_VALUES[1]}\n`,
    'sent_sessions.json': JSON.stringify([{ bvid: 'BV1', processedAt: NOW - 60_000, note: LEAK_VALUES[0] }]),
  };
  const root = makePond('credential-file', files);
  ageFile(path.join(root, 'app.log'), 3600);

  const { read, report } = await inspect(root);
  const outputs = [
    JSON.stringify(read),
    JSON.stringify(report),
    renderJson(report),
    renderHtml(report),
    renderText(report),
  ];

  for (const text of outputs) {
    for (const secret of LEAK_VALUES) {
      assert.equal(text.includes(secret), false, '凭证文件的内容被读进来了');
    }
    for (const name of CREDENTIAL_FILES) {
      assert.equal(text.includes(name), false, `凭证文件名 ${name} 漏进了输出`);
    }
  }
  // 定位器必须落在普通产物上，一个凭证味文件都不许当配置 / 判重表 / 日志
  assert.equal(path.basename(read.paths.config ?? ''), 'config.json');
  assert.equal(path.basename(read.paths.dedupe ?? ''), '', '判重表不许落到 seen_tokens.json');
  assert.equal(path.basename(read.paths.log ?? ''), 'app.log', '日志不许落到 cookie_session.log');
});

/* ------------------------------------------------------------------ *
 * 其他边界：坏配置、坏判重表、FIFO、时钟错乱、垃圾入参
 * ------------------------------------------------------------------ */

test('配置 JSON 损坏：漂移判不出、不抛，且不能说成「没漂」', async () => {
  const root = makePond('broken-config', { 'config.json': '{"schemaVersion": 1, oops' });
  const { read, fish } = await inspect(root);

  assert.equal(read.config.schemaVersion, null);
  assert.equal(fish.indicators.drift.level, 'unknown');
  assert.notEqual(fish.indicators.drift.severity, 'ok');
});

test('判重表是二进制垃圾：工作量判不出（不是「0 条」）', async () => {
  const root = makePond('garbage-dedupe', {
    'processed.json': Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x00, 0x00, 0x41]),
  });
  const { read, fish } = await inspect(root);

  assert.equal(read.dedupe.count, null, '认不出的判重表必须留 null，不许拿 0 顶替');
  assert.equal(fish.indicators.throughput.level, 'unknown');
});

test('日志路径是 FIFO：不挂住（体检工具绝不能在用户机器上卡死）', { skip: process.platform === 'win32' ? 'Windows 没有 mkfifo' : false }, async (t) => {
  const root = path.join(TEMP_ROOT, 'fifo-pond');
  fs.mkdirSync(root, { recursive: true });
  const fifoPath = path.join(root, 'app.log');
  try {
    execFileSync('mkfifo', [fifoPath], { stdio: 'ignore' });
  } catch {
    // 没有 mkfifo 的环境（容器里偶尔没有）老实标跳过，不假装测过
    t.skip('这个环境没有 mkfifo');
    return;
  }

  const started = performance.now();
  const tail = await readLogTail(fifoPath, { timeoutMs: 2000 });
  const elapsed = performance.now() - started;

  assert.equal(tail.ok, false, 'FIFO 不是日志文件，必须拒绝读（open 会永久阻塞）');
  assert.equal(tail.reason, 'not_a_file');
  assert.ok(elapsed < 3000, `读 FIFO 花了 ${elapsed.toFixed(0)}ms，说明真的去 open 了`);

  // 走完整管线同样不许卡
  const { read } = await inspect(root);
  assert.equal(read.ok, true);
});

test('日志读取器对垃圾路径永不抛：null / 数字 / 空串 / 目录 / 设备文件 / 凭证名', async () => {
  const cases = [
    [null, 'bad_path'],
    [42, 'bad_path'],
    ['', 'bad_path'],
    [TEMP_ROOT, 'not_a_file'],
    [path.join(TEMP_ROOT, 'nope', 'gone.log'), 'enoent'],
    [path.join(TEMP_ROOT, 'credentials.json'), 'sensitive_skipped'],
  ];
  // /dev/null 是「打开不会报错、但根本不是普通文件」的经典陷阱，非 POSIX 环境就没有它
  if (fs.existsSync('/dev/null')) cases.push(['/dev/null', 'not_a_file']);

  for (const [input, expected] of cases) {
    const result = await readLogTail(input, { timeoutMs: 2000 });
    assert.equal(result?.ok, false, `${String(input)} 应当返回 ok:false 而不是抛`);
    assert.equal(result.reason, expected, `${String(input)} 的 reason 应为 ${expected}`);
  }
});

test('日志 mtime 在未来：时钟异常 → 存活判不出，而不是「她刚刚还在动」', async () => {
  const root = makePond('clock-skew', { 'app.log': '2026-11-07T10:00:00Z 干活\n' });
  const future = (NOW + 2 * 86400 * 1000) / 1000;
  fs.utimesSync(path.join(root, 'app.log'), future, future);

  const { fish } = await inspect(root);
  const liveness = fish.indicators.liveness;

  assert.equal(liveness.level, 'unknown', '未来时间戳是坏数据，不能拿来当「刚刚还在动」');
  assert.ok(
    liveness.evidence.sources.some((source) => source.id === 'log_mtime' && source.status === 'invalid'),
    '要留痕：log_mtime 被判无效，而不是静静地丢掉',
  );
  assert.ok(JSON.stringify(liveness.evidence).includes('clock_skew'), '时钟异常要写进证据');
});

test('垃圾入参（null / 数字 / 字符串 / 空对象 / 畸形 paths）：readPond 永不抛，evaluate 不崩', async () => {
  const junk = [null, undefined, 'not-a-pond', 42, [], { paths: { log: 123 } }, { rootPath: 12345 }];

  for (const input of junk) {
    const read = await readPond(input, { now: NOW, home: TEMP_ROOT });
    assert.equal(typeof read, 'object', `${JSON.stringify(input)} 必须返回一个对象`);
    assert.doesNotThrow(() => evaluate({ ponds: [read] }, { now: NOW }), `${JSON.stringify(input)} 的读取结果把判定器撞崩了`);
  }
});

test('readAll：一条坏鱼不影响其它鱼，长度与顺序都不变', async () => {
  const good = makePond('readall-good', { 'app.log': '2026-11-07T10:00:00Z 干活\n' });
  const ghost = path.join(TEMP_ROOT, 'readall-ghost');

  const reads = await readAll([
    { id: 'a', kind: 'generic', rootPath: good },
    { id: 'b', kind: 'generic', rootPath: ghost },
    null,
  ], { now: NOW, home: TEMP_ROOT });

  assert.equal(reads.length, 3, '坏元素也要占位，不能因为读不出来就从数组里消失');
  assert.equal(reads[0].id, 'a');
  assert.equal(reads[1].id, 'b');
  assert.equal(reads[2].id, null);

  const report = evaluate({ ponds: reads }, { now: NOW });
  assert.equal(report.fishes.length, 3);
});

test('目录条目很多（300 个）：读取有界、不超时', async () => {
  const root = makePond('many-entries');
  for (let i = 0; i < 300; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');

  const started = performance.now();
  const { read } = await inspect(root);
  const elapsed = performance.now() - started;

  assert.equal(read.ok, true);
  assert.ok(elapsed < 5000, `扫 300 个条目用了 ${elapsed.toFixed(0)}ms，预算保护可能没生效`);
});

/* ------------------------------------------------------------------ *
 * 收口：所有边界产物都要能渲染
 * ------------------------------------------------------------------ */

test('所有边界产物都能渲染：HTML / 文本 / JSON 都不抛，HTML 零外链且带底部声明', async () => {
  const roots = [
    makePond('render-missing', {}),
    makePond('render-empty', { 'app.log': '' }),
  ];
  const reads = await readAll(roots.map((rootPath, index) => ({ id: `r${index}`, kind: 'generic', rootPath })), {
    now: NOW,
    home: TEMP_ROOT,
  });
  const report = evaluate({ ponds: reads }, { now: NOW });

  const html = renderHtml(report);
  const text = renderText(report);
  const json = renderJson(report);

  assert.ok(html.length > 0);
  assert.ok(text.length > 0);
  assert.doesNotThrow(() => JSON.parse(json), '--json 输出必须能被 JSON.parse 回读');
  assert.equal(/(src|href)="https?:/.test(html), false, 'HTML 不许出现任何外链');
  assert.equal(html.includes('本报告只读、不联网、无遥测。'), true, '底部只读声明必须一直在');
  assert.equal(/\x1b\[/.test(text), false, '文本摘要不许带 ANSI 颜色（贴到群里会变成乱码）');
});
