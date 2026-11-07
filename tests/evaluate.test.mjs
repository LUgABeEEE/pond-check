/**
 * pond-check · D4 收口测试（tests/evaluate.test.mjs）
 *
 * 覆盖：六指标 × 各档位 + unknown 分支、聚合排序、修复清单、总评/最该做的事、
 * 凭证闸、永不抛、阈值真从 rules.json 来。
 *
 * 全部用**构造输入**（手搓 D3 的 PondRead），不读真实文件系统、不依赖本机状态：
 * 判定层就该能在没有鱼、没有日志、没有配置的情况下被完整测到。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { evaluate, evaluateFish, INDICATOR_IDS, BAND_LABELS } from '../src/evaluate/index.mjs';
import { getRules as getSystemRules } from '../src/evaluate/system.mjs';
import { SENSITIVE_PATH_TOKEN } from '../src/discover/generic.mjs';

const RULES = getSystemRules();

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0); // 2026-11-07T12:00:00Z
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function iso(ms) {
  return new Date(ms).toISOString();
}

/** 一条能按 ISO 解析出时间戳的日志行 */
function lineAt(offsetMs, text = 'poll ok') {
  return `${iso(NOW - offsetMs)} ${text}`;
}

/** 空的 PondRead：六格全 unknown 的基线 */
function emptyRead(overrides = {}) {
  return {
    id: 'standalone:empty-fish',
    kind: 'standalone',
    rootPath: '/tmp/fish',
    ok: true,
    now: NOW,
    paths: {},
    sources: {},
    missing: [],
    unreadable: [],
    skippedSensitive: [],
    sensitiveSkippedCount: 0,
    log: null,
    dedupe: null,
    config: null,
    sessions: null,
    deps: null,
    credentials: null,
    degraded: [],
    notes: [],
    ...overrides,
  };
}

/** 六格全绿的鱼（用来验证「真的全 ok」时报告不会乱报） */
function perfectRead(overrides = {}) {
  const lines = [];
  for (let day = 6; day >= 0; day -= 1) lines.push(lineAt(day * DAY + HOUR));
  const lastMs = NOW - MIN;
  return emptyRead({
    id: 'dsh-plugin:web/demo-fish',
    kind: 'dsh-plugin',
    rootPath: '/home/u/.dsh/profiles/web/node_modules/demo-fish',
    sources: {
      log: { status: 'ok', reason: null },
      config: { status: 'ok', reason: null },
      dedupe: { status: 'ok', reason: null },
      sessions: { status: 'missing', reason: null },
    },
    log: {
      ok: true,
      path: '/home/u/.dsh/profiles/web/logs/app.log',
      size: 512,
      bytesRead: 512,
      fromOffset: 0,
      truncated: false,
      firstLinePartial: false,
      hasBinary: false,
      lines,
      lineCount: lines.length,
      linesTruncated: false,
      lastTimestamp: { ms: lastMs, iso: iso(lastMs) },
      mtimeMs: lastMs,
      mtimeAt: iso(lastMs),
      ageSec: 60,
      keywords: { categories: [], hardHits: 0, softHits: 0, matched: [] },
      degraded: [],
    },
    dedupe: {
      format: 'json_array',
      count: 42,
      countEstimated: false,
      lastEntryAt: NOW - 5 * MIN,
      fileMtimeAt: NOW - 5 * MIN,
      lastUpdateAt: NOW - 5 * MIN,
      todayNew: 3,
      reason: null,
      reasonText: null,
    },
    config: {
      schemaVersion: 3,
      schemaVersionField: 'schemaVersion',
      pluginVersion: '1.2.3',
      fieldsPresent: { model: true, provider: true },
      reason: null,
    },
    sessions: {
      dir: null, fileCount: 0, newestMtimeMs: null, newestMtimeAt: null,
      ageSec: null, reason: 'not_found', reasonText: null,
    },
    deps: {
      ffmpeg: { found: true },
      node: { version: '22.11.0', major: 22 },
      homeWritable: { writable: true },
      disk: { freeBytes: 5 * 1024 * 1024 * 1024, freeHuman: '5.0 GiB' },
    },
    credentials: { foundCount: 1, newestAgeSec: 2 * DAY / SEC, reason: null },
    ...overrides,
  });
}

/** 一条「死了」的鱼：日志 10 天没写 */
function deadRead(overrides = {}) {
  const mtimeMs = NOW - 10 * DAY;
  return emptyRead({
    id: 'dsh-home:bili-duty',
    kind: 'dsh-home',
    rootPath: '/home/u/.dsh/bili-duty',
    log: {
      ok: true,
      path: '/home/u/.dsh/bili-duty/logs/app.log',
      size: 200,
      bytesRead: 200,
      fromOffset: 0,
      truncated: false,
      firstLinePartial: false,
      hasBinary: false,
      lines: [lineAt(10 * DAY)],
      lineCount: 1,
      linesTruncated: false,
      lastTimestamp: { ms: mtimeMs, iso: iso(mtimeMs) },
      mtimeMs,
      mtimeAt: iso(mtimeMs),
      ageSec: (10 * DAY) / SEC,
      keywords: { categories: [], hardHits: 0, softHits: 0, matched: [] },
      degraded: [],
    },
    ...overrides,
  });
}

/** 六格各档检查用：按 rules 里声明的 level 断言 */
function assertIndicatorContract(indicator, id) {
  assert.equal(indicator.id, id, `${id}: id 不符`);
  const spec = RULES.indicators[id];
  assert.ok(spec, `${id}: rules 里没有这个指标`);
  const levels = Object.keys(spec.diagnosis);
  assert.ok(levels.includes(indicator.level), `${id}: level=${indicator.level} 不在 rules 声明里`);
  assert.equal(
    indicator.severity,
    spec.diagnosis[indicator.level].severity,
    `${id}: severity 必须等于 rules diagnosis[${indicator.level}].severity`,
  );
  assert.equal(typeof indicator.phenomenon, 'string');
  assert.ok(indicator.phenomenon.length > 0, `${id}: phenomenon 不能空`);
  assert.equal(typeof indicator.nextStep, 'string');
  assert.ok(indicator.nextStep.length > 0, `${id}: nextStep 不能空`);
  assert.ok(!/\{[A-Za-z_]/.test(indicator.phenomenon), `${id}: phenomenon 有未替换 {var}: ${indicator.phenomenon}`);
  assert.ok(!/\{[A-Za-z_]/.test(indicator.nextStep), `${id}: nextStep 有未替换 {var}: ${indicator.nextStep}`);
  assert.ok(Array.isArray(indicator.evidence.missing), `${id}: evidence.missing 必须是数组`);
  if (indicator.level === 'unknown') {
    assert.equal(indicator.severity, 'unknown', `${id}: unknown 的 severity 必须是 unknown`);
    assert.ok(indicator.evidence.missing.length > 0, `${id}: unknown 必须列 missing`);
  }
}

/* ------------------------------------------------------------------ *
 * 1. 空输入 / 报告骨架
 * ------------------------------------------------------------------ */

test('S01 空列表：报告骨架齐全、总评走「没扫到鱼」、绝不空转', () => {
  const report = evaluate({ ponds: [] }, { now: NOW });
  assert.deepEqual(Object.keys(report), [
    'schemaVersion', 'generatedAt', 'host', 'fishes', 'summary',
    // fishBuckets（数鱼，按关键格）/ traceCounts（有没有运行痕迹）/ bucketNote（认不出怎么讲）
    'fishBuckets', 'traceCounts', 'bucketNote', 'traceNote',
    'verdict', 'nextAction', 'footnote', 'degradedCount', 'skippedSensitive',
  ]);
  assert.deepEqual(report.fishes, []);
  assert.deepEqual(report.summary, { fish: 0, ok: 0, watch: 0, bad: 0, unknown: 0 });
  assert.match(report.verdict, /没扫到鱼/);
  assert.match(report.nextAction, /--root/);
  assert.equal(report.footnote, null);
  assert.equal(report.generatedAt, new Date(NOW).toISOString());
  assert.equal(report.host.platform, process.platform);
  assert.equal(report.skippedSensitive.names, SENSITIVE_PATH_TOKEN);
});

test('S02 六格全绿的鱼：六项都判出 ok，fixes 为空、总评 6 正常', () => {
  const report = evaluate({ ponds: [perfectRead()] }, { now: NOW, fieldPresence: {} });
  const fish = report.fishes[0];
  assert.deepEqual(Object.keys(fish.indicators), INDICATOR_IDS);
  assert.equal(fish.indicators.liveness.level, 'active');
  assert.equal(fish.indicators.rhythm.level, 'steady');
  assert.equal(fish.indicators.throughput.level, 'productive');
  assert.equal(fish.indicators.health.level, 'clean');
  assert.equal(fish.indicators.deps.level, 'ready');
  assert.equal(fish.indicators.drift.level, 'aligned');
  assert.equal(fish.severity, 'ok');
  assert.deepEqual(fish.fixes, []);
  assert.deepEqual(report.summary, { fish: 1, ok: 6, watch: 0, bad: 0, unknown: 0 });
  assert.match(report.verdict, /1 条鱼 · 六格口径：6 正常 · 0 要注意 · 0 坏了 · 0 判不出/);
  assert.match(report.nextAction, /继续养/);
  assert.equal(report.footnote, null);
  for (const id of INDICATOR_IDS) assertIndicatorContract(fish.indicators[id], id);
});

/* ------------------------------------------------------------------ *
 * 2. 各档位
 * ------------------------------------------------------------------ */

test('S03 死了的鱼：liveness=dead、severity=bad、修复清单里有「进程」', () => {
  const report = evaluate({ ponds: [deadRead()] }, { now: NOW });
  const fish = report.fishes[0];
  assert.equal(fish.indicators.liveness.level, 'dead');
  assert.equal(fish.indicators.liveness.severity, 'bad');
  assert.equal(fish.severity, 'bad');
  assert.equal(fish.worstIndicator, 'liveness');
  assert.match(fish.headline, /存活 死了/);
  assert.ok(fish.fixes.length > 0);
  assert.match(fish.fixes[0], /进程/);
  assert.match(report.nextAction, /进程/);
  assertIndicatorContract(fish.indicators.liveness, 'liveness');
});

test('S04 空窝（没有日志/判重表/配置）：六格全 unknown，绝不出现 ok', () => {
  const report = evaluate({ ponds: [emptyRead()] }, { now: NOW });
  const fish = report.fishes[0];
  for (const id of INDICATOR_IDS) {
    assert.equal(fish.indicators[id].level, 'unknown', `${id} 不该判出档位`);
    assert.equal(fish.indicators[id].severity, 'unknown');
    assertIndicatorContract(fish.indicators[id], id);
  }
  assert.equal(fish.severity, 'unknown');
  assert.deepEqual(report.summary, { fish: 1, ok: 0, watch: 0, bad: 0, unknown: 6 });
  assert.match(report.verdict, /1 条鱼 · 六格口径：0 正常 · 0 要注意 · 0 坏了 · 6 判不出/);
  assert.match(report.verdict, /这些项不是正常，是没看到。/);
  assert.ok(report.footnote);
  assert.equal(report.degradedCount, 6);
});

test('S05 有点吵的健康 + 停摆的工作量：watch/bad 各自成立', () => {
  const read = perfectRead({
    log: {
      ...perfectRead().log,
      keywords: { categories: [], hardHits: 0, softHits: 2, matched: [] },
    },
    dedupe: {
      ...perfectRead().dedupe,
      todayNew: 0,
      lastEntryAt: NOW - 5 * DAY,
      lastUpdateAt: NOW - 5 * DAY,
      fileMtimeAt: NOW - 5 * DAY,
    },
  });
  const fish = evaluateFish(read, { now: NOW, fieldPresence: {} });
  assert.equal(fish.indicators.health.level, 'noisy');
  assert.equal(fish.indicators.health.severity, 'watch');
  assert.equal(fish.indicators.throughput.level, 'stalled');
  assert.equal(fish.indicators.throughput.severity, 'bad');
  assert.equal(fish.severity, 'bad');
  assert.equal(fish.worstIndicator, 'throughput');
});

test('S06 依赖坏了（缺 ffmpeg）：deps=broken，且逐项都带 detail/fix', () => {
  const read = perfectRead({
    deps: {
      ...perfectRead().deps,
      ffmpeg: { found: false },
    },
  });
  const fish = evaluateFish(read, { now: NOW, fieldPresence: {} });
  assert.equal(fish.indicators.deps.level, 'broken');
  const checks = fish.indicators.deps.evidence.checks;
  assert.ok(Array.isArray(checks));
  assert.equal(checks.length, RULES.indicators.deps.thresholds.checks.length);
  const ffmpeg = checks.find((check) => check.id === 'ffmpeg');
  assert.equal(ffmpeg.status, 'fail');
  assert.ok(ffmpeg.detail && ffmpeg.fix);
});

test('S07 配置旧格式（schemaVersion=1）：drift=drifted', () => {
  const read = perfectRead({
    config: { ...perfectRead().config, schemaVersion: 1, schemaVersionField: 'schemaVersion' },
  });
  const fish = evaluateFish(read, { now: NOW, fieldPresence: {} });
  assert.equal(fish.indicators.drift.level, 'drifted');
  assert.equal(fish.indicators.drift.severity, 'bad');
});

/* ------------------------------------------------------------------ *
 * 3. 聚合行为
 * ------------------------------------------------------------------ */

test('S08 排序：bad → unknown → ok（同档按 id 稳定）', () => {
  const report = evaluate({
    ponds: [
      perfectRead({ id: 'ok-fish', rootPath: '/tmp/ok' }),
      emptyRead({ id: 'unknown-fish', rootPath: '/tmp/unknown' }),
      deadRead({ id: 'bad-fish', rootPath: '/tmp/bad' }),
    ],
  }, { now: NOW, fieldPresence: {} });
  assert.deepEqual(report.fishes.map((fish) => fish.severity), ['bad', 'unknown', 'ok']);
  assert.deepEqual(report.fishes.map((fish) => fish.id), ['bad-fish', 'unknown-fish', 'ok-fish']);
});

test('S09 每个指标的严重度都必须来自 rules.json', () => {
  const report = evaluate({
    ponds: [perfectRead(), deadRead(), emptyRead()],
  }, { now: NOW, fieldPresence: {} });
  for (const fish of report.fishes) {
    assert.deepEqual(Object.keys(fish.indicators), INDICATOR_IDS);
    for (const id of INDICATOR_IDS) assertIndicatorContract(fish.indicators[id], id);
    assert.ok(['ok', 'watch', 'bad', 'unknown'].includes(fish.severity));
    assert.equal(typeof fish.headline, 'string');
    assert.equal(fish.headline.split(' · ').length, INDICATOR_IDS.length);
    for (const [id, label] of Object.entries(BAND_LABELS)) {
      assert.ok(label[fish.indicators[id].level] || fish.indicators[id].level === 'unknown');
    }
  }
  const total = INDICATOR_IDS.length * report.fishes.length;
  const { ok, watch, bad, unknown } = report.summary;
  assert.equal(ok + watch + bad + unknown, total);
});

test('S10 fixes：去重、封顶 rules.rollup.maxFixesPerFish，且只收非 ok 的 nextStep', () => {
  const read = perfectRead({
    dedupe: { ...perfectRead().dedupe, todayNew: 0, lastEntryAt: NOW - 6 * DAY, lastUpdateAt: NOW - 6 * DAY, fileMtimeAt: NOW - 6 * DAY },
    log: { ...perfectRead().log, keywords: { categories: [], hardHits: 4, softHits: 0, matched: [] } },
  });
  const fish = evaluateFish({ ...read, config: { ...read.config, schemaVersion: 1 } }, { now: NOW, fieldPresence: {} });
  const nonOk = INDICATOR_IDS.filter((id) => fish.indicators[id].severity !== 'ok');
  assert.ok(nonOk.length >= 3, '这个夹具至少要让三格不正常');
  assert.equal(fish.fixes.length, Math.min(RULES.rollup.maxFixesPerFish, new Set(fish.fixes).size));
  assert.ok(fish.fixes.length <= RULES.rollup.maxFixesPerFish);
  assert.equal(new Set(fish.fixes).size, fish.fixes.length, 'fixes 不许重复');
  for (const fix of fish.fixes) assert.ok(!/\{[A-Za-z_]/.test(fix), `fix 有未替换 {var}: ${fix}`);
});

test('S11 degraded 合并：同一指标只留一条，脚注只数真判不出的那几格', () => {
  const read = emptyRead({
    degraded: [
      { indicator: 'liveness', reason: 'log_missing', missing: ['log'] },
      { indicator: 'health', reason: 'no_log', missing: ['log'] },
    ],
  });
  const report = evaluate({ ponds: [read] }, { now: NOW });
  const fish = report.fishes[0];
  const healthEntries = fish.degraded.filter((item) => item.indicator === 'health');
  assert.equal(healthEntries.length, 1, '同一指标不该在脚注里数两次');
  assert.equal(report.degradedCount, fish.degraded.length);
  assert.ok(fish.degraded.every((item) => INDICATOR_IDS.includes(item.indicator)));
  assert.ok(report.footnote.includes(String(report.degradedCount)));
});

/* ------------------------------------------------------------------ *
 * 4. 隐私 / 稳健 / 阈值来源
 * ------------------------------------------------------------------ */

test('S12 凭证闸：窝路径命中凭证目录 → 显示成常量，报告里不出现真实路径', () => {
  const read = emptyRead({
    id: 'standalone:secret-fish',
    rootPath: '/home/u/.ssh/agent-fish',
  });
  const fish = evaluateFish(read, { now: NOW });
  assert.equal(fish.stateRoot, SENSITIVE_PATH_TOKEN);
  const serialized = JSON.stringify(fish);
  assert.ok(!serialized.includes('.ssh'), '报告里不许出现凭证目录名');
  assert.ok(!serialized.includes('agent-fish'), '报告里不许出现凭证目录下的路径');
});

test('S13 乱参数永不抛，且一律不给 ok', () => {
  const weird = [
    null, undefined, 0, '', 'x', [], {}, { ponds: 'nope' }, { ponds: [null, 42, 'x', []] },
    { foo: 1 }, { read: null }, { ponds: [{ id: 42, log: 'bad', dedupe: 7, config: [] }] },
    { ponds: [{ log: { ok: true, lines: [null, 42] }, dedupe: { count: 'x' }, deps: 'nope' }] },
  ];
  for (const input of weird) {
    const report = evaluate(input, { now: NOW });
    assert.ok(report && typeof report === 'object');
    assert.ok(Array.isArray(report.fishes));
    assert.equal(typeof report.verdict, 'string');
    assert.equal(typeof report.nextAction, 'string');
    for (const fish of report.fishes) {
      for (const id of INDICATOR_IDS) {
        assert.notEqual(fish.indicators[id].level, undefined);
        assert.notEqual(fish.indicators[id].severity, 'ok', '构造不出来的输入不该判成 ok');
      }
    }
  }
});

test('S14 输入形状：单个 PondRead / 数组 / {read} / {ponds} 都能用', () => {
  const single = perfectRead();
  const viaSingle = evaluate(single, { now: NOW, fieldPresence: {} });
  assert.equal(viaSingle.fishes.length, 1);
  const viaArray = evaluate([perfectRead()], { now: NOW, fieldPresence: {} });
  assert.equal(viaArray.fishes.length, 1);
  const viaRead = evaluate({ read: perfectRead() }, { now: NOW, fieldPresence: {} });
  assert.equal(viaRead.fishes.length, 1);
  const viaPonds = evaluate({ ponds: [perfectRead(), perfectRead({ id: 'x', rootPath: '/tmp/x' })] }, { now: NOW, fieldPresence: {} });
  assert.equal(viaPonds.fishes.length, 2);
  assert.equal(viaPonds.summary.fish, 2);
});

test('S15 阈值真的来自 rules.json：注入 activeMaxSec=60 后 120 秒前的日志变 slack', () => {
  const custom = JSON.parse(JSON.stringify(RULES));
  custom.indicators.liveness.thresholds.constants.activeMaxSec = 60;
  const read = perfectRead({ log: { ...perfectRead().log, mtimeMs: NOW - 120 * SEC, ageSec: 120 } });
  const fish = evaluateFish(read, { now: NOW, rules: custom, fieldPresence: {} });
  assert.equal(fish.indicators.liveness.level, 'slack');
  // 基线（默认 rules）同一份输入是 active
  const base = evaluateFish(read, { now: NOW, fieldPresence: {} });
  assert.equal(base.indicators.liveness.level, 'active');
  // 用完必须把 system.mjs 的全局 rules 还原，别污染同进程后面的调用
  assert.equal(getSystemRules().indicators.liveness.thresholds.constants.activeMaxSec, 3600);
});

test('S16 显示名：带 profile scope 区分同包多份安装，$HOME 缩成 ~', () => {
  const home = os.homedir();
  const read = perfectRead({
    id: 'dsh-plugin:web/pkg-fish',
    rootPath: `${home}/.dsh/profiles/web/node_modules/pkg-fish`,
  });
  const fish = evaluateFish(read, { now: NOW, fieldPresence: {} });
  assert.match(fish.name, /pkg-fish/);
  assert.match(fish.name, /web/);
  assert.equal(fish.stateRoot, '~/.dsh/profiles/web/node_modules/pkg-fish');
});

test('S17 skippedSensitive 只出聚合数量与常量 token', () => {
  const a = emptyRead({ sensitiveSkippedCount: 2 });
  const b = emptyRead({ id: 'other', rootPath: '/tmp/other', sensitiveSkippedCount: 1 });
  const report = evaluate({ ponds: [a, b] }, { now: NOW });
  assert.equal(report.skippedSensitive.count, 3);
  assert.equal(report.skippedSensitive.names, SENSITIVE_PATH_TOKEN);
  assert.deepEqual(Object.keys(report.skippedSensitive), ['count', 'names']);
});

test('S18 六格键集合固定：不许少、不许多（D5 渲染按这个遍历）', () => {
  const fish = evaluateFish(emptyRead(), { now: NOW });
  assert.deepEqual(Object.keys(fish.indicators), ['liveness', 'rhythm', 'throughput', 'health', 'deps', 'drift']);
  assert.deepEqual([...INDICATOR_IDS], ['liveness', 'rhythm', 'throughput', 'health', 'deps', 'drift']);
});

test('S19 聚合自身炸了也要给出一条六格全 unknown 的鱼（绝不从报告里消失）', () => {
  const bomb = new Proxy({}, {
    get() { throw new Error('boom'); },
    has() { throw new Error('boom'); },
    ownKeys() { throw new Error('boom'); },
  });
  const report = evaluate({ ponds: [bomb] }, { now: NOW });
  assert.equal(report.fishes.length, 1, '炸掉的鱼也必须出现在报告里');
  const fish = report.fishes[0];
  assert.equal(fish.severity, 'unknown');
  for (const id of INDICATOR_IDS) {
    assert.equal(fish.indicators[id].level, 'unknown');
    assert.equal(fish.indicators[id].severity, 'unknown');
  }
  assert.ok(fish.fixes.length > 0, '判不出也要给一句下一步');
  assert.equal(typeof report.verdict, 'string');
  assert.equal(report.summary.fish, 1);
  assert.equal(report.summary.unknown, INDICATOR_IDS.length);
});
