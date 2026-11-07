/**
 * pond-check · 分桶口径回归（tests/bucket.test.mjs）
 *
 * 清 D8 的两条 medium —— 都在「鱼级分桶」的口径上，一起钉死：
 *
 *   D8-M4 分桶 bad 同页两个词：四灯/统计行写「死了」、summary 写「坏了」；
 *         更糟的是 deps broken 但 liveness active 的鱼同屏 🔴 +「活跃 刚刚」。
 *         → bad 档统一「坏了」；「死了」只留给 liveness=dead 那一格。
 *   D8-M5 ok 门槛过低：六格里只判得出 1 格的鱼仍算 bucket: ok，
 *         与 summary 的 unknown:5 两处自相矛盾。
 *         → 门槛抬到「已知格 ≥ 2 且 liveness 已知」；达不到落 unknown（不是 watch，
 *           「判不出」不是「要注意」）。统计行要能看出有几条鱼是多格判不出的。
 *
 * 变异验证（每条用例都要能在口径被改坏时变红，commit 记录里有实测）：
 *   - 门槛改回「有任一已知格就算 ok」→ 「只判得出 1 格」的用例必须红；
 *   - 「坏了」改回「死了」→ 用词统一的用例必须红。
 *
 * 硬约束：三处口径必须一致 —— evaluate.fishBuckets ＝ 文本统计行 ＝ HTML 四灯。
 *
 * 夹具全部是构造输入（手搓 D3 的 PondRead），不读真实文件系统、不依赖本机状态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import evaluate, {
  classifyFishBucket,
  countMultiUnknown,
  INDICATOR_IDS,
} from '../src/evaluate/index.mjs';
import renderText from '../src/render/text.mjs';
import renderHtml from '../src/render/html.mjs';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0); // 2026-11-07T12:00:00Z
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;

/* ------------------------------------------------------------------ *
 * 夹具：手搓 PondRead（形状对齐 tests/evaluate.test.mjs 的基线）
 * ------------------------------------------------------------------ */

function iso(ms) {
  return new Date(ms).toISOString();
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

/**
 * 日志对象：只给 mtime（存活）与关键词计数（健康）两条输入。
 * keywords 传 null 就是「健康这格没数据」；size > 0 是存活源的硬条件
 * （0 字节日志的 mtime 不算干活痕迹，队长裁定 B2）。
 */
function logObj({ ageMs, keywords, size = 512 }) {
  const ms = NOW - ageMs;
  return {
    ok: true,
    path: '/tmp/fish/logs/app.log',
    size,
    bytesRead: size,
    fromOffset: 0,
    truncated: false,
    firstLinePartial: false,
    hasBinary: false,
    lines: [],
    lineCount: 0,
    linesTruncated: false,
    lastTimestamp: null,
    mtimeMs: ms,
    mtimeAt: iso(ms),
    ageSec: Math.round(ageMs / SEC),
    keywords,
    degraded: [],
  };
}

const FULL_DEPS = Object.freeze({
  ffmpeg: { found: true },
  node: { version: '22.11.0', major: 22 },
  homeWritable: { writable: true },
  disk: { freeBytes: 5 * 1024 ** 3, freeHuman: '5.0 GiB' },
});

/** ① 只判得出 1 格（liveness active），其余 5 格 unknown —— D8-M5 的关键用例。 */
function oneKnownRead() {
  return emptyRead({
    id: 'dsh-plugin:web/one-cell',
    kind: 'dsh-plugin',
    rootPath: '/home/u/one-cell',
    sources: { log: { status: 'ok', reason: null } },
    log: logObj({ ageMs: 1 * MIN, keywords: null }),
  });
}

/** ② 判得出 2 格（liveness active + deps ready），过门槛 —— 「2 格已知才算 ok」的达标线。 */
function okRead() {
  return emptyRead({
    id: 'dsh-plugin:web/ok-two-cells',
    kind: 'dsh-plugin',
    rootPath: '/home/u/ok-two-cells',
    sources: { log: { status: 'ok', reason: null }, config: { status: 'ok', reason: null } },
    log: logObj({ ageMs: 1 * MIN, keywords: null }),
    deps: { ...FULL_DEPS },
    credentials: { foundCount: 1, newestAgeSec: (2 * DAY) / SEC, reason: null },
    config: {
      schemaVersion: 3,
      schemaVersionField: 'schemaVersion',
      pluginVersion: '1.2.3',
      fieldsPresent: { model: true, provider: true },
      reason: null,
    },
  });
}

/** ③ deps broken（Node 主版本过低）+ liveness active —— D8-M4 的关键用例。 */
function depsBrokenRead() {
  return emptyRead({
    id: 'dsh-plugin:web/deps-broken',
    kind: 'dsh-plugin',
    rootPath: '/home/u/deps-broken',
    sources: { log: { status: 'ok', reason: null } },
    log: logObj({ ageMs: 1 * MIN, keywords: null }),
    deps: { ...FULL_DEPS, node: { version: '18.0.0', major: 18 } },
  });
}

/** ④ liveness dead（日志 10 天没写）—— 「死了」唯一允许出现的地方。 */
function deadRead() {
  return emptyRead({
    id: 'dsh-home:dead-fish',
    kind: 'dsh-home',
    rootPath: '/home/u/dead-fish',
    sources: { log: { status: 'ok', reason: null } },
    log: logObj({ ageMs: 10 * DAY, keywords: null }),
  });
}

/** ⑤ 什么都没有 —— 六格全 unknown。 */
function emptyPondRead() {
  return emptyRead({ id: 'standalone:mystery', kind: 'standalone', rootPath: '/home/u/mystery' });
}

/** 合成鱼：只用来单测 classifyFishBucket / countMultiUnknown 的口径矩阵。 */
function syntheticFish(spec) {
  const indicators = {};
  for (const id of INDICATOR_IDS) {
    const [level, severity] = spec[id] ?? ['unknown', 'unknown'];
    indicators[id] = { id, level, severity, evidence: { missing: [] }, phenomenon: '', nextStep: '' };
  }
  return { indicators };
}

function knownCells(fish) {
  return INDICATOR_IDS.filter((id) => fish?.indicators?.[id]?.level !== 'unknown').length;
}

/** 从文本摘要读统计行（末行）：四桶 + 多格判不出条数。 */
function statBucketsFromText(text) {
  const line = text.split('\n').find((row) => row.startsWith('共 '));
  assert.ok(line, '文本摘要里没有统计行');
  const match = line.match(
    /^共 (\d+) 条，活跃 (\d+) \/ 疲软 (\d+) \/ 坏了 (\d+) \/ 认不出 (\d+)。(多格判不出的鱼 (\d+) 条（活跃不代表六格全绿）。)?$/u,
  );
  assert.ok(match, `统计行格式变了：${line}`);
  return {
    total: Number(match[1]),
    ok: Number(match[2]),
    watch: Number(match[3]),
    bad: Number(match[4]),
    unknown: Number(match[5]),
    multi: match[6] ? Number(match[7]) : 0,
  };
}

/** 从 HTML 四灯读同样的四桶。 */
function statBucketsFromHtml(html) {
  const counts = {};
  const re = /<div class="ov ov-(ok|watch|bad|unknown)">\s*<span class="ov-count">(\d+)<\/span>\s*<span class="ov-label">([^<]+)<\/span>/gu;
  for (const m of html.matchAll(re)) {
    counts[m[1]] = Number(m[2]);
    counts[`${m[1]}Label`] = m[3];
  }
  for (const key of ['ok', 'watch', 'bad', 'unknown']) {
    assert.ok(Number.isFinite(counts[key]), `HTML 缺 ${key} 灯`);
  }
  return counts;
}

/* ------------------------------------------------------------------ *
 * D8-M5 · ok 门槛：已知格 ≥ 2 且 liveness 已知
 * ------------------------------------------------------------------ */

test('D8-M5 端到端：六格只判得出 1 格的鱼不再算 ok，落到 unknown', () => {
  const report = evaluate({ ponds: [oneKnownRead()] }, { now: NOW });
  const fish = report.fishes[0];
  // 前提自检：这条鱼确实只有 liveness 一格判出来了（夹具漂了要先知道）
  assert.equal(fish.indicators.liveness.level, 'active', '前提：liveness 该判出来');
  assert.equal(knownCells(fish), 1, `前提：只该有 1 格已知，实际 ${knownCells(fish)}`);
  assert.equal(fish.bucket, 'unknown', '1/6 格已知的鱼不许算 ok');
  assert.deepEqual(report.fishBuckets, { ok: 0, watch: 0, bad: 0, unknown: 1 },
    'fishBuckets 里不许有 ok —— 这正是 D8-M5「两处自相矛盾」的病根');
});

test('D8-M5 门槛矩阵：liveness 已知 + 至少 2 格已知才算 ok', () => {
  // 只有 1 格已知（就是 liveness 自己）→ unknown
  assert.equal(classifyFishBucket(syntheticFish({
    liveness: ['active', 'ok'],
  })), 'unknown', '1 格已知（还是 liveness 自己）不许算 ok');

  // liveness 判不出时，哪怕判得出的格再多也不算 ok
  assert.equal(classifyFishBucket(syntheticFish({
    rhythm: ['steady', 'ok'],
    throughput: ['productive', 'ok'],
    health: ['clean', 'ok'],
    deps: ['ready', 'ok'],
  })), 'unknown', 'liveness 判不出就不许算 ok');

  // 刚好 2 格已知（liveness + 任意另一格）→ ok
  assert.equal(classifyFishBucket(syntheticFish({
    liveness: ['active', 'ok'],
    health: ['clean', 'ok'],
  })), 'ok', 'liveness 已知 + 共 2 格已知，过门槛');

  // 2 格已知但没有 liveness → unknown
  assert.equal(classifyFishBucket(syntheticFish({
    health: ['clean', 'ok'],
    deps: ['ready', 'ok'],
  })), 'unknown', '2 格已知但 liveness 判不出，不算 ok');

  // 六格全 unknown → unknown
  assert.equal(classifyFishBucket(syntheticFish({})), 'unknown');

  // 半截指标（有档位没严重度，或反过来）不算已知 —— 宁可多报「判不出」也不许少报
  assert.equal(classifyFishBucket({
    indicators: Object.fromEntries(INDICATOR_IDS.map((id) => [id, {
      id, level: 'active', severity: 'unknown', evidence: {}, phenomenon: '', nextStep: '',
    }])),
  }), 'unknown', 'level 有值但 severity=unknown 的格子不算已知，6 格全半截不许算 ok');
});

test('D8-M5：bad/watch 优先于门槛 —— 确定的坏消息不许降级成「判不出」', () => {
  // 1 格 bad + 5 格 unknown → bad（门槛检查必须排在 bad/watch 之后）
  assert.equal(classifyFishBucket(syntheticFish({
    deps: ['broken', 'bad'],
  })), 'bad', '1 格 bad + 5 格 unknown 必须进 bad，不是 unknown');

  assert.equal(classifyFishBucket(syntheticFish({
    drift: ['drifted', 'bad'],
  })), 'bad');

  // 1 格 watch + 5 格 unknown → watch
  assert.equal(classifyFishBucket(syntheticFish({
    liveness: ['slack', 'watch'],
  })), 'watch', '1 格 watch + 5 格 unknown 必须进 watch，不是 unknown');
});

test('D8-M5 统计行能看出「有几条鱼是多格判不出的」，HTML 同句', () => {
  const report = evaluate({ ponds: [oneKnownRead()] }, { now: NOW });
  const text = renderText(report);
  const html = renderHtml(report);
  const stat = statBucketsFromText(text);
  assert.equal(stat.multi, 1, `统计行要带「多格判不出的鱼 1 条」：${text.split('\n').at(-1)}`);
  assert.ok(text.includes('多格判不出的鱼 1 条'), '统计行没写多格判不出的鱼条数');
  assert.ok(html.includes('多格判不出的鱼 1 条'), 'HTML 也要能看到多格判不出的鱼条数');
});

test('D8-M5 口径边界：多格 = 至少 2 格判不出（1 格判不出不算）', () => {
  const oneBlind = syntheticFish({
    liveness: ['active', 'ok'],
    rhythm: ['steady', 'ok'],
    throughput: ['productive', 'ok'],
    health: ['clean', 'ok'],
    deps: ['ready', 'ok'],
  });
  const twoBlind = syntheticFish({
    liveness: ['active', 'ok'],
    rhythm: ['steady', 'ok'],
    throughput: ['productive', 'ok'],
    health: ['clean', 'ok'],
  });
  assert.equal(countMultiUnknown([oneBlind]), 0, '只有 1 格判不出的鱼不算「多格判不出」');
  assert.equal(countMultiUnknown([twoBlind]), 1, '2 格判不出就算「多格判不出」');
  assert.equal(countMultiUnknown([oneBlind, twoBlind]), 1);
});

/* ------------------------------------------------------------------ *
 * D8-M4 · 用词统一：bad 档写「坏了」，「死了」只留给 liveness=dead
 * ------------------------------------------------------------------ */

test('D8-M4 回归：deps broken + liveness active 的鱼，报告里不得出现「死了」', () => {
  const report = evaluate({ ponds: [depsBrokenRead()] }, { now: NOW });
  const fish = report.fishes[0];
  // 前提自检：这条鱼正是「依赖坏了但还活跃」的形态
  assert.equal(fish.indicators.deps.level, 'broken', '前提：deps 该判 broken');
  assert.equal(fish.indicators.deps.severity, 'bad');
  assert.equal(fish.indicators.liveness.level, 'active', '前提：liveness 该判 active');
  assert.equal(fish.bucket, 'bad');

  const text = renderText(report);
  const html = renderHtml(report);
  assert.ok(!text.includes('死了'),
    `deps broken + liveness active 的文本报告里出现了「死了」：\n${text}`);
  assert.ok(!html.includes('死了'),
    'deps broken + liveness active 的 HTML 报告里出现了「死了」');

  // bad 档两个渲染层都用「坏了」，和 summary（总评）的「坏了」是同一个词
  assert.ok(text.includes('/ 坏了 1 /'), `文本统计行 bad 档没用「坏了」：\n${text}`);
  assert.ok(String(report.verdict).includes('坏了'), `summary（总评）没用「坏了」：${report.verdict}`);
  assert.ok(html.includes('坏了'), 'HTML 里连一个「坏了」都没有，与 summary 不一致');
  const lamps = statBucketsFromHtml(html);
  assert.equal(lamps.badLabel, '坏了', 'HTML 四灯 bad 档没用「坏了」');
});

test('D8-M4：「死了」只属于 liveness=dead 那一格，统计行照样写「坏了」', () => {
  const report = evaluate({ ponds: [deadRead()] }, { now: NOW });
  const fish = report.fishes[0];
  assert.equal(fish.indicators.liveness.level, 'dead', '前提：liveness 该判 dead');

  const text = renderText(report);
  assert.ok(text.includes('死了'), 'liveness=dead 的鱼该出现「死了」');
  assert.ok(text.includes('存活 死了'), '「死了」应出现在存活那一格的档位名里');

  const lastLine = text.split('\n').at(-1);
  assert.ok(!lastLine.includes('死了'), `分桶词不许再用「死了」：${lastLine}`);
  assert.ok(lastLine.includes('/ 坏了 1 /'), `dead 的鱼进 bad 档，统计行写「坏了」：${lastLine}`);
  const lamps = statBucketsFromHtml(renderHtml(report));
  assert.equal(lamps.badLabel, '坏了', 'HTML 四灯 bad 档写「坏了」，不是「死了」');
});

/* ------------------------------------------------------------------ *
 * 硬约束：三处口径一致（evaluate.fishBuckets ＝ 文本统计行 ＝ HTML 四灯）
 * ------------------------------------------------------------------ */

test('三处口径一致：抬门槛后 evaluate.fishBuckets ＝ 文本统计行 ＝ HTML 四灯', () => {
  const report = evaluate({
    ponds: [okRead(), depsBrokenRead(), oneKnownRead(), emptyPondRead()],
  }, { now: NOW });

  // 抬门槛后的期望：2 格已知的过门槛进 ok，1 格已知的落 unknown
  assert.deepEqual(report.fishBuckets, { ok: 1, watch: 0, bad: 1, unknown: 2 });

  const textStat = statBucketsFromText(renderText(report));
  const lamps = statBucketsFromHtml(renderHtml(report));
  assert.equal(textStat.total, report.fishes.length);
  for (const key of ['ok', 'watch', 'bad', 'unknown']) {
    assert.equal(textStat[key], report.fishBuckets[key], `文本统计行 ${key} 与 evaluate.fishBuckets 不一致`);
    assert.equal(lamps[key], report.fishBuckets[key], `HTML 四灯 ${key} 与 evaluate.fishBuckets 不一致`);
    assert.equal(textStat[key], lamps[key], `文本统计行 ${key} 与 HTML 四灯不一致`);
  }
  // 这批鱼每条都至少 2 格判不出（多格判不出的条数在两处也是同一个数）
  assert.equal(textStat.multi, 4, '四条鱼都是多格判不出，统计行该写 4');
  assert.ok(renderHtml(report).includes('多格判不出的鱼 4 条'), 'HTML 的多格判不出条数与文本不一致');
});
