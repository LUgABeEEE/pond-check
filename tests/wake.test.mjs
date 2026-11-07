/**
 * pond-check · C3 加权唤醒测试（tests/wake.test.mjs）
 *
 * 这个文件钉的是 CAPABILITIES-SPEC §3.5：
 *   1. 候选池：importance >= 3、archived=0、距 last_recalled >= 24h、半衰期内
 *   2. 权重：weight = importance² × recency × silence，**每个因子单独都能主导**
 *   3. 频率控制：每日 3 次 / 间隔 4h / 同 kind 每日 2 次，历史从事件流重放
 *   4. reason 能说人话（「重要（5 分）且 9 天未提」），不是 JSON 黑盒
 *   5. pick 的副作用（事件 + last_recalled）、schedule 的纯预排语义
 *   6. 降级链与失败路径：sqlite→易失、读库失败、计数失败、事件写不进去都只 warn
 *   7. 层间隔离：src/wake 不 import 诊断层、不联网
 *
 * 任务书验收门：
 *   node --test tests/wake.test.mjs 全绿；覆盖权重各因子单独生效、频率控制拦超额、
 *   候选池过滤、reason 可读。
 * 变异验证（commandsRun 记真实退出码）：把 importance² 改成 importance，本文件必须红
 * （M1，见 §2 的 0.70 阈值用例与分布用例）。
 *
 * 测试纪律：
 *   - 所有写入都指向 mkdtemp 的临时 POND_HOME，绝不碰真实 `~/.pond`；
 *   - 时间由注入的 clock 驱动（事件 ts 也跟着假时间走），不靠真时钟；
 *   - 随机源注入成确定函数 / 固定种子 LCG，不用 Math.random；
 *   - 浮点比较走 closeTo，不用裸 ===。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWake,
  pick as pickOnce,
  schedule as scheduleOnce,
  WAKE_DEFAULTS,
  WEIGHT_FORMULA,
  RECENCY_FORMULA,
  SILENCE_FORMULA,
  WAKE_EVENT_FIELDS,
  WAKE_PROVIDER,
  HOUR_MS,
  DAY_MS,
  computeWeight,
  candidatePool,
  classifyRow,
  nextEligibleAt,
  weightedPick,
  buildReason,
  normalizeLimits,
  frequencyAt,
  kindAtCap,
  wakeHistoryFromEntries,
  readWakeHistory,
} from '../src/wake/index.mjs';
import { createMemory, KINDS, halfLifeDaysFor } from '../src/memory/index.mjs';
import { EVENT_FIELDS } from '../src/shared/events.mjs';
import { startOfLocalDay } from '../src/shared/budget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-wake-'));

// 本地时区零点 + 10 小时：无论 CI 在哪个时区，10:00 都稳稳落在「当天」。
const DAY0 = startOfLocalDay(Date.parse('2026-11-01T10:00:00+08:00'));
const NOW = DAY0 + 10 * HOUR_MS;

let homeCounter = 0;

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 夹具地基
 * ------------------------------------------------------------------ */

function makeHome(label) {
  homeCounter += 1;
  const home = path.join(TEMP_ROOT, `${String(homeCounter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function envFor(home) {
  return { POND_HOME: home };
}

/** 造一条记忆行（默认 fact、4 分、30 天前创建、从没提过）。 */
function makeRow(overrides = {}) {
  const id = overrides.id ?? 1;
  return {
    id,
    kind: 'fact',
    content: overrides.content ?? `记忆 ${id}`,
    entities: [],
    importance: 4,
    confidence: 0.8,
    source: 'chat',
    sourceRef: null,
    createdAt: NOW - 30 * DAY_MS,
    updatedAt: NOW - 30 * DAY_MS,
    lastRecalled: null,
    recallCount: 0,
    ttlDays: null,
    archived: false,
    ...overrides,
  };
}

/** 与真实 store 同行接口的假存储：可注入 list / bumpRecall 失败。 */
class FakeStore {
  constructor(rows = []) {
    this.provider = 'fake';
    this.rows = rows.map((row) => ({ ...row }));
    this.listCalls = [];
    this.bumpCalls = [];
    this.listThrows = false;
    this.bumpThrows = false;
  }

  list(options = {}) {
    if (this.listThrows) throw new Error('模拟读库失败：磁盘坏了');
    this.listCalls.push({ ...options });
    return this.rows.map((row) => ({ ...row }));
  }

  bumpRecall(ids, now) {
    if (this.bumpThrows) throw new Error('模拟写库失败：只读文件系统');
    this.bumpCalls.push({ ids: [...ids], now });
    for (const id of ids) {
      const row = this.rows.find((item) => item.id === id);
      if (!row) continue;
      row.recallCount = (Number(row.recallCount) || 0) + 1;
      row.lastRecalled = now;
    }
  }

  close() {
    this.closed = true;
  }
}

function makeWake(label, overrides = {}) {
  const home = overrides.home ?? makeHome(label);
  const clock = { t: overrides.now ?? NOW };
  const store = overrides.store ?? new FakeStore(overrides.rows ?? []);
  const warns = [];
  const wake = createWake({
    store,
    env: envFor(home),
    eventsPath: overrides.eventsPath,
    now: overrides.nowFn ?? (() => clock.t),
    random: overrides.random ?? (() => 0),
    limits: overrides.limits,
    warn: (message) => warns.push(String(message)),
  });
  return { wake, store, home, clock, warns };
}

function eventsOf(home) {
  const file = path.join(home, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** 往事件流里塞一条历史唤醒（模拟过去真的提过一次）。 */
function seedWakeEvent(home, {
  ts,
  memoryId = 1,
  kind = 'fact',
  action = 'picked',
  ok = true,
  capability = 'wake',
} = {}) {
  const entry = {
    ts: new Date(ts).toISOString(),
    capability,
    provider: 'wake-local',
    units: ok ? 1 : 0,
    costEstimate: 0,
    durationMs: 1,
    ok,
    error: ok ? null : 'seed',
    attempt: 1,
    errorCategory: ok ? null : 'storage',
    degradedFrom: null,
    op: 'wake',
    action,
    reason: 'seed',
    blockedBy: null,
    memoryId,
    kind,
    weight: 1,
  };
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'events.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
}

function closeTo(actual, expected, epsilon = 1e-9, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label} 期望 ${expected}，实际 ${actual}（容差 ${epsilon}）`,
  );
}

/** 固定种子 LCG：分布用例可复现，不靠 Math.random。 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/* ================================================================== *
 * 1. 权重公式
 * ================================================================== */

test('权重·公式：weight = importance² × recency × silence（数值可复算）', () => {
  const row = makeRow({
    id: 1,
    importance: 4,
    kind: 'fact',
    createdAt: NOW - 30 * DAY_MS,
    lastRecalled: NOW - 7 * DAY_MS,
  });
  const metrics = computeWeight(row, NOW);

  assert.equal(metrics.importance, 4);
  assert.equal(metrics.halfLifeDays, 365, 'fact 的半衰期应是 365 天');
  closeTo(metrics.daysSinceCreated, 30, 1e-9, 'daysSinceCreated');
  closeTo(metrics.daysSinceRecalled, 7, 1e-9, 'daysSinceRecalled');
  // 独立复算（不调用实现里的 freshnessFactor）：真半衰 0.5^(days/halfLife)。
  closeTo(metrics.recency, Math.pow(0.5, 30 / 365), 1e-12, 'recency');
  closeTo(metrics.silence, 1, 1e-12, 'silence 在 7 天到顶');
  closeTo(metrics.weight, 16 * Math.pow(0.5, 30 / 365), 1e-12, 'weight');

  assert.equal(WEIGHT_FORMULA, 'weight = importance² × recency × silence');
  assert.equal(RECENCY_FORMULA, 'recency = 0.5^(daysSinceCreated / halfLife)');
  assert.equal(SILENCE_FORMULA, 'silence = min(1, daysSinceRecalled / 7)');
});

test('权重·importance² 不是笔误：5 分与 3 分的权重比是 25:9（不是 5:3）', () => {
  const rows = [
    makeRow({ id: 1, importance: 5, createdAt: NOW - 30 * DAY_MS, lastRecalled: NOW - 9 * DAY_MS }),
    makeRow({ id: 2, importance: 3, createdAt: NOW - 30 * DAY_MS, lastRecalled: NOW - 9 * DAY_MS }),
  ];
  const { candidates } = candidatePool(rows, NOW);
  assert.equal(candidates.length, 2);
  closeTo(candidates[0].weight / candidates[1].weight, 25 / 9, 1e-12, '权重比');
});

test('权重·importance² 变异闸：0.70 阈值下平方版本选 5 分、线性版本会选 3 分', () => {
  const rows = [
    makeRow({ id: 1, importance: 5, createdAt: NOW - 30 * DAY_MS, lastRecalled: NOW - 9 * DAY_MS }),
    makeRow({ id: 2, importance: 3, createdAt: NOW - 30 * DAY_MS, lastRecalled: NOW - 9 * DAY_MS }),
  ];
  const { candidates } = candidatePool(rows, NOW);
  // 平方：5²/(5²+3²) = 25/34 ≈ 0.7353 > 0.70 → 选 id 1
  // 线性：5/(5+3)   = 5/8  = 0.6250 < 0.70 → 会选 id 2（变异必须被这条抓住）
  const chosen = weightedPick(candidates, () => 0.70);
  assert.equal(chosen.id, 1, 'importance² 被改成 importance 后，这条会选到 3 分那条');
  assert.ok(25 / 34 > 0.70 && 5 / 8 < 0.70, '阈值必须卡在两种实现之间，否则这条闸失效');
});

test('权重·importance² 分布：固定种子 6000 次，5 分被选中约 2.78 倍于 3 分', () => {
  const rows = [
    makeRow({ id: 1, importance: 5 }),
    makeRow({ id: 2, importance: 3 }),
  ];
  const { candidates } = candidatePool(rows, NOW);
  const random = lcg(20261101);
  const counts = { 1: 0, 2: 0 };
  for (let i = 0; i < 6000; i += 1) {
    const chosen = weightedPick(candidates, random);
    counts[chosen.id] += 1;
  }
  const ratio = counts[1] / counts[2];
  assert.ok(
    ratio > 2.2 && ratio < 3.4,
    `25:9 期望约 2.78，实际 ${ratio.toFixed(3)}（线性实现会掉到约 1.67）`,
  );
  assert.equal(counts[1] + counts[2], 6000);
});

test('权重·recency 单独生效：新记忆比 300 天前的旧记忆权重高（真半衰）', () => {
  const fresh = makeRow({ id: 1, importance: 5, createdAt: NOW - 1 * DAY_MS, lastRecalled: NOW - 9 * DAY_MS });
  const stale = makeRow({ id: 2, importance: 5, createdAt: NOW - 300 * DAY_MS, lastRecalled: NOW - 9 * DAY_MS });
  const { candidates } = candidatePool([fresh, stale], NOW);
  closeTo(candidates[0].recency, Math.pow(0.5, 1 / 365), 1e-12, 'fresh recency');
  closeTo(candidates[1].recency, Math.pow(0.5, 300 / 365), 1e-12, 'stale recency');
  assert.ok(candidates[0].weight > candidates[1].weight, '新记忆权重必须更高');

  const freshFraction = candidates[0].weight / (candidates[0].weight + candidates[1].weight);
  assert.ok(freshFraction > 0.5, `新记忆占比 ${freshFraction} 应超过一半`);
  assert.equal(weightedPick(candidates, () => 0.5).id, 1);
  assert.equal(weightedPick(candidates, () => 0.8).id, 2, '大权重随机也可能落到旧记忆（这才是加权随机）');
});

test('权重·silence 单独生效：20 天未提的权重是 2 天未提的 3.5 倍', () => {
  const twoDays = makeRow({ id: 1, importance: 5, createdAt: NOW - 30 * DAY_MS, lastRecalled: NOW - 2 * DAY_MS });
  const twentyDays = makeRow({ id: 2, importance: 5, createdAt: NOW - 30 * DAY_MS, lastRecalled: NOW - 20 * DAY_MS });
  const { candidates } = candidatePool([twoDays, twentyDays], NOW);
  closeTo(candidates[0].silence, 2 / 7, 1e-12, '2 天 silence');
  closeTo(candidates[1].silence, 1, 1e-12, '20 天 silence 已封顶');
  closeTo(candidates[1].weight / candidates[0].weight, 3.5, 1e-12, 'silence 权重比');
  assert.equal(weightedPick(candidates, () => 0.15).id, 1);
  assert.equal(weightedPick(candidates, () => 0.5).id, 2);
});

test('权重·silence 封顶 1：30 天与 90 天未提权重相同（分母是 7，不是 30）', () => {
  const thirty = makeRow({ id: 1, importance: 4, createdAt: NOW - 60 * DAY_MS, lastRecalled: NOW - 30 * DAY_MS });
  const ninety = makeRow({ id: 2, importance: 4, createdAt: NOW - 60 * DAY_MS, lastRecalled: NOW - 90 * DAY_MS });
  const { candidates } = candidatePool([thirty, ninety], NOW);
  assert.equal(candidates[0].silence, 1);
  assert.equal(candidates[1].silence, 1);
  closeTo(candidates[0].weight, candidates[1].weight, 1e-12, '封顶后权重相同');
});

test('权重·未来时间钳零：时钟漂移不许产生负天数或 >1 的分数', () => {
  const row = makeRow({
    id: 1,
    importance: 5,
    createdAt: NOW + 5 * DAY_MS,
    lastRecalled: NOW + 2 * DAY_MS,
  });
  const metrics = computeWeight(row, NOW);
  assert.equal(metrics.daysSinceCreated, 0);
  assert.equal(metrics.daysSinceRecalled, 0);
  assert.equal(metrics.recency, 1);
  assert.equal(metrics.silence, 0);
  assert.equal(metrics.weight, 0);
});

test('权重·relation 也走 fact 的 365 天半衰期（C2 新增的第四类）', () => {
  assert.ok(KINDS.includes('relation'), 'C2 应已扩出 relation 一类');
  assert.equal(halfLifeDaysFor({ kind: 'relation', ttlDays: null }), 365);
  const row = makeRow({ id: 1, kind: 'relation', importance: 4, createdAt: NOW - 30 * DAY_MS });
  assert.equal(computeWeight(row, NOW).halfLifeDays, 365);
  assert.equal(classifyRow(row, NOW).status, 'candidate');
});

/* ================================================================== *
 * 2. 候选池
 * ================================================================== */

test('候选池·四条条件各自拦人：低分 / 已归档 / 刚提过 / 过期', () => {
  const rows = [
    makeRow({ id: 1, importance: 2 }),                                             // 低分
    makeRow({ id: 2, importance: 3 }),                                             // 入选
    makeRow({ id: 3, importance: 5, archived: true }),                             // 已归档
    makeRow({ id: 4, importance: 4, lastRecalled: NOW - 1 * HOUR_MS }),            // 刚提过
    makeRow({ id: 5, kind: 'episode', createdAt: NOW - 100 * DAY_MS }),            // 45×2=90 天，过期
    makeRow({ id: 6, kind: 'fact', createdAt: NOW - 100 * DAY_MS }),               // 365×2=730，还在
    makeRow({ id: 7, importance: 4, createdAt: NOW - 25 * DAY_MS, ttlDays: 10 }),  // 覆盖半衰期 → 20 天过期
    makeRow({ id: 8, importance: 4, lastRecalled: NOW - 25 * HOUR_MS }),           // 25h 够格
  ];
  const { candidates, filtered } = candidatePool(rows, NOW);
  assert.deepEqual(candidates.map((item) => item.id), [2, 6, 8]);
  assert.deepEqual(filtered, {
    total: 8,
    archived: 1,
    lowImportance: 1,
    recentlyRecalled: 1,
    expired: 2,
    kindLimit: 0,
  });
});

test('候选池·归档 fail-closed：archived 给 1（sqlite 原始行）也不算候选', () => {
  const { candidates, filtered } = candidatePool([
    makeRow({ id: 1, archived: 1 }),
    makeRow({ id: 2, archived: true }),
    makeRow({ id: 3 }),
  ], NOW);
  assert.deepEqual(candidates.map((item) => item.id), [3]);
  assert.equal(filtered.archived, 2);
});

test('候选池·边界：距 last_recalled 正好 24h 入选，差 1ms 出局', () => {
  const exactly = makeRow({ id: 1, lastRecalled: NOW - 24 * HOUR_MS });
  const justUnder = makeRow({ id: 2, lastRecalled: NOW - 24 * HOUR_MS + 1 });
  const { candidates, filtered } = candidatePool([exactly, justUnder], NOW);
  assert.deepEqual(candidates.map((item) => item.id), [1]);
  assert.equal(filtered.recentlyRecalled, 1);
});

test('候选池·边界：半衰期正好 2 倍出局（< 而非 <=），差 1ms 入选', () => {
  const episodeHalfLife = 45;
  const atLimit = makeRow({ id: 1, kind: 'episode', createdAt: NOW - episodeHalfLife * 2 * DAY_MS });
  const inside = makeRow({ id: 2, kind: 'episode', createdAt: NOW - episodeHalfLife * 2 * DAY_MS + 1 });
  const { candidates, filtered } = candidatePool([atLimit, inside], NOW);
  assert.deepEqual(candidates.map((item) => item.id), [2]);
  assert.equal(filtered.expired, 1);
});

test('候选池·同 kind 每日上限：到顶的 kind 被剔除，其他 kind 照常', () => {
  const rows = [
    makeRow({ id: 1, kind: 'episode' }),
    makeRow({ id: 2, kind: 'fact' }),
  ];
  const { candidates, filtered } = candidatePool(rows, NOW, WAKE_DEFAULTS, {
    kindCounts: { episode: 2 },
  });
  assert.deepEqual(candidates.map((item) => item.id), [2]);
  assert.equal(filtered.kindLimit, 1);
  assert.equal(kindAtCap({ episode: 2 }, 'episode', 2), true);
  assert.equal(kindAtCap({ episode: 1 }, 'episode', 2), false);
});

test('候选池·确定性：候选按 id 升序，random=0 永远选可预期的第一条', () => {
  const rows = [
    makeRow({ id: 9, importance: 3 }),
    makeRow({ id: 2, importance: 3 }),
    makeRow({ id: 5, importance: 3 }),
  ];
  const { candidates } = candidatePool(rows, NOW);
  assert.deepEqual(candidates.map((item) => item.id), [2, 5, 9]);
  assert.equal(weightedPick(candidates, () => 0).id, 2);
});

test('候选池·空池给机器可读原因（诊断层不用猜）', () => {
  const none = candidatePool([], NOW);
  assert.deepEqual(none.candidates, []);
  assert.equal(none.filtered.total, 0);

  const onlyLow = candidatePool([makeRow({ id: 1, importance: 1 })], NOW);
  assert.equal(onlyLow.filtered.lowImportance, 1);
});

test('候选池·nextEligibleAt：算出「太新」的记忆何时重新够格', () => {
  const rows = [
    makeRow({ id: 1, lastRecalled: NOW - 1 * HOUR_MS }),  // 还差 23h
    makeRow({ id: 2, lastRecalled: NOW - 23 * HOUR_MS }), // 还差 1h
    makeRow({ id: 3, lastRecalled: null }),               // 现在就够格，不算等待
  ];
  const readyAt = nextEligibleAt(rows, NOW);
  assert.equal(readyAt, NOW - 23 * HOUR_MS + 24 * HOUR_MS);
  assert.equal(nextEligibleAt([rows[0]], NOW), NOW - 1 * HOUR_MS + 24 * HOUR_MS);
});

/* ================================================================== *
 * 3. reason 可读
 * ================================================================== */

test('reason·能说人话：重要（5 分）且 9 天未提', () => {
  const { candidates } = candidatePool([
    makeRow({ id: 1, importance: 5, lastRecalled: NOW - 9 * DAY_MS }),
  ], NOW);
  assert.equal(candidates[0].reason, '重要（5 分）且 9 天未提');
  assert.match(candidates[0].reason, /^重要（5 分）且 \d+ 天未提$/u);
});

test('reason·从没提过时说「从未提过」，不说 null / undefined / JSON', () => {
  const reason = buildReason({ importance: 4, daysSinceRecalled: null });
  assert.equal(reason, '重要（4 分）且从未提过');
  for (const forbidden of ['null', 'undefined', '{', '}']) {
    assert.equal(reason.includes(forbidden), false, `reason 里出现了 ${forbidden}`);
  }
});

test('reason·会被 pick 原样带回来（用户看得到为什么提这条）', () => {
  const { wake } = makeWake('reason-pick', {
    rows: [makeRow({ id: 1, importance: 5, lastRecalled: NOW - 9 * DAY_MS })],
  });
  const result = wake.pick();
  assert.equal(result.reason, '重要（5 分）且 9 天未提');
  assert.equal(result.memory.id, 1);
  assert.equal(result.why.formula, WEIGHT_FORMULA);
  assert.equal(result.why.importance, 5);
  wake.close();
});

/* ================================================================== *
 * 4. 频率控制
 * ================================================================== */

test('频率·每日上限：今天已提 3 次 → pick 返回 null，事件记 daily-limit', () => {
  const { wake, home } = makeWake('freq-daily', { rows: [makeRow({ id: 1 })] });
  seedWakeEvent(home, { ts: DAY0 + 1 * HOUR_MS, memoryId: 11 });
  seedWakeEvent(home, { ts: DAY0 + 6 * HOUR_MS, memoryId: 12 });
  seedWakeEvent(home, { ts: DAY0 + 9 * HOUR_MS, memoryId: 13 });

  const result = wake.pick();
  assert.equal(result, null);

  const blocked = eventsOf(home).filter((event) => event.action === 'blocked').at(-1);
  assert.ok(blocked, '拦截必须写进事件流，否则「今天为什么没说话」是黑盒');
  assert.equal(blocked.capability, 'wake');
  assert.equal(blocked.blockedBy, 'daily-limit');
  assert.match(blocked.reason, /今日唤醒已达上限（3\/3 次）/u);
  assert.equal(blocked.units, 0);
  wake.close();
});

test('频率·最小间隔：2 小时前提过 → 拦到 4 小时，reason 说清还差多少分钟', () => {
  const { wake, home } = makeWake('freq-interval', { rows: [makeRow({ id: 1 })] });
  const lastTs = NOW - 2 * HOUR_MS;
  seedWakeEvent(home, { ts: lastTs, memoryId: 11 });

  const result = wake.pick();
  assert.equal(result, null);
  const blocked = eventsOf(home).filter((event) => event.action === 'blocked').at(-1);
  assert.equal(blocked.blockedBy, 'min-interval');
  assert.match(blocked.reason, /还需 120 分钟/u);
  wake.close();
});

test('频率·同一 kind 每日上限：episode 提过 2 次 → episode 出局、fact 被选中', () => {
  const { wake, home } = makeWake('freq-kind', {
    rows: [
      makeRow({ id: 1, kind: 'episode' }),
      makeRow({ id: 2, kind: 'fact' }),
    ],
  });
  seedWakeEvent(home, { ts: NOW - 9 * HOUR_MS, memoryId: 11, kind: 'episode' });
  seedWakeEvent(home, { ts: NOW - 5 * HOUR_MS, memoryId: 12, kind: 'episode' });

  const result = wake.pick();
  assert.ok(result, 'fact 没到上限，应该还能提');
  assert.equal(result.memory.id, 2);
  assert.equal(result.memory.kind, 'fact');
  wake.close();
});

test('频率·同一 kind 每日上限：唯一候选的 kind 已到顶 → null + kind-limit', () => {
  const { wake, home } = makeWake('freq-kind-block', {
    rows: [makeRow({ id: 1, kind: 'episode' })],
  });
  seedWakeEvent(home, { ts: NOW - 9 * HOUR_MS, memoryId: 11, kind: 'episode' });
  seedWakeEvent(home, { ts: NOW - 5 * HOUR_MS, memoryId: 12, kind: 'episode' });

  assert.equal(wake.pick(), null);
  const blocked = eventsOf(home).filter((event) => event.action === 'blocked').at(-1);
  assert.equal(blocked.blockedBy, 'kind-limit');
  wake.close();
});

test('频率·只认 wake 的 picked：memory / blocked 事件不占唤醒预算', () => {
  const { wake, home } = makeWake('freq-filter', { rows: [makeRow({ id: 1 })] });
  // memory 的 recall 事件、wake 的 blocked 事件都不该计入次数
  seedWakeEvent(home, { ts: NOW - 1 * HOUR_MS, capability: 'memory', action: 'recalled' });
  seedWakeEvent(home, { ts: NOW - 2 * HOUR_MS, action: 'blocked' });
  seedWakeEvent(home, { ts: NOW - 3 * HOUR_MS, action: 'blocked' });

  const result = wake.pick();
  assert.ok(result, '非 picked 事件被算进频率了');
  wake.close();
});

test('频率·跨天重置：昨天提满 3 次，今天照样可以提', () => {
  const { wake, home } = makeWake('freq-reset', { rows: [makeRow({ id: 1 })] });
  seedWakeEvent(home, { ts: DAY0 - 1 * HOUR_MS });
  seedWakeEvent(home, { ts: DAY0 - 5 * HOUR_MS });
  seedWakeEvent(home, { ts: DAY0 - 9 * HOUR_MS });

  const result = wake.pick();
  assert.ok(result, '昨天用满的次数不该跨天占用今天');
  wake.close();
});

test('频率·坏行不影响计数：坏 JSON 跳过，好的事件照算', () => {
  const home = makeHome('freq-corrupt');
  seedWakeEvent(home, { ts: DAY0 + 1 * HOUR_MS });
  fs.appendFileSync(path.join(home, 'events.jsonl'), 'this is not json\n', 'utf8');
  seedWakeEvent(home, { ts: DAY0 + 6 * HOUR_MS });
  fs.appendFileSync(path.join(home, 'events.jsonl'), '{"capability":"wake","action":"picked","ts":"nope"}\n', 'utf8');
  seedWakeEvent(home, { ts: DAY0 + 9 * HOUR_MS });

  const history = readWakeHistory({ env: envFor(home) });
  assert.equal(history.length, 3, '三条合法 picked 事件都应该被读到');
  const freq = frequencyAt(history, NOW, WAKE_DEFAULTS);
  assert.equal(freq.todayCount, 3);
  assert.equal(freq.blockedBy, 'daily-limit');
});

test('频率·事件文件不存在 = 没有历史，不抛', () => {
  const home = makeHome('freq-missing');
  assert.deepEqual(readWakeHistory({ env: envFor(home) }), []);
  const freq = frequencyAt([], NOW, WAKE_DEFAULTS);
  assert.equal(freq.allowed, true);
  assert.equal(freq.todayCount, 0);
  assert.equal(freq.lastWakeAt, null);
});

test('频率·wakeHistoryFromEntries 只收合法形状', () => {
  const history = wakeHistoryFromEntries([
    { capability: 'wake', action: 'picked', ok: true, ts: new Date(NOW).toISOString(), memoryId: 3, kind: 'fact' },
    { capability: 'wake', action: 'picked', ok: false, ts: new Date(NOW).toISOString(), memoryId: 4 },
    { capability: 'wake', action: 'blocked', ok: true, ts: new Date(NOW).toISOString(), memoryId: 5 },
    { capability: 'memory', action: 'picked', ok: true, ts: new Date(NOW).toISOString(), memoryId: 6 },
    { capability: 'wake', action: 'picked', ok: true, ts: 'not-a-date', memoryId: 7 },
    null,
  ]);
  assert.deepEqual(history, [{ ts: NOW, memoryId: 3, kind: 'fact' }]);
});

test('频率·budget 数字 = 今天剩余额度：budget:0 立刻拦，budget:2 放行', () => {
  const { wake, home } = makeWake('freq-budget', { rows: [makeRow({ id: 1 })] });
  seedWakeEvent(home, { ts: DAY0 + 1 * HOUR_MS, kind: 'episode' });
  seedWakeEvent(home, { ts: DAY0 + 6 * HOUR_MS, kind: 'episode' });

  assert.equal(wake.pick({ budget: 0 }), null, '剩余额度 0 不该再提');
  const blocked = eventsOf(home).filter((event) => event.action === 'blocked').at(-1);
  assert.equal(blocked.blockedBy, 'daily-limit');

  const allowed = wake.pick({ budget: 2 });
  assert.ok(allowed, '今天已用 2 次、还剩 2 次额度，应该放行');
  wake.close();
});

test('频率·budget 对象可以覆盖参数（绝对上限）', () => {
  const { wake, home } = makeWake('freq-budget-object', { rows: [makeRow({ id: 1 })] });
  seedWakeEvent(home, { ts: DAY0 + 1 * HOUR_MS, kind: 'episode' });
  seedWakeEvent(home, { ts: DAY0 + 6 * HOUR_MS, kind: 'episode' });
  assert.ok(wake.pick(), '默认上限 3，第 3 次应放行');
  assert.equal(wake.pick({ budget: { dailyLimit: 9 } }), null, '间隔不够，放大上限也不能连提两次');

  // 换一天再验绝对上限：{dailyLimit: 2} 时第 3 次必须被拦。
  const second = makeWake('freq-budget-object-2', {
    rows: [makeRow({ id: 1 })],
    home: makeHome('freq-budget-object-2-home'),
  });
  seedWakeEvent(second.home, { ts: NOW - 9 * HOUR_MS, kind: 'episode' });
  seedWakeEvent(second.home, { ts: NOW - 5 * HOUR_MS, kind: 'episode' });
  assert.equal(second.wake.pick({ budget: { dailyLimit: 2 } }), null);
  second.wake.close();
  wake.close();
});

test('频率·frequencyAt 的返回结构可解释（次数 / 上次时间 / kind 计数 / 下次可用时刻）', () => {
  const history = [
    { ts: DAY0 + 1 * HOUR_MS, memoryId: 1, kind: 'fact' },
    { ts: DAY0 + 6 * HOUR_MS, memoryId: 2, kind: 'fact' },
  ];
  const freq = frequencyAt(history, NOW, WAKE_DEFAULTS);
  assert.equal(freq.allowed, true);
  assert.equal(freq.todayCount, 2);
  assert.equal(freq.dailyLeft, 1);
  assert.deepEqual(freq.kindCounts, { fact: 2 });
  assert.equal(freq.lastWakeAt, DAY0 + 6 * HOUR_MS);
  assert.equal(freq.sinceLastWakeMs, NOW - (DAY0 + 6 * HOUR_MS));
});

/* ================================================================== *
 * 5. pick 端到端：事件、副作用、失败路径
 * ================================================================== */

test('pick·写事件：八字段打头 + 唤醒层额外键 + 假时间戳 + 本地零成本', () => {
  const { wake, home } = makeWake('pick-event', {
    rows: [makeRow({ id: 7, kind: 'preference', importance: 5, lastRecalled: NOW - 9 * DAY_MS })],
  });
  const result = wake.pick();
  assert.ok(result);

  const picked = eventsOf(home).filter((event) => event.action === 'picked');
  assert.equal(picked.length, 1);
  const event = picked[0];
  assert.deepEqual(Object.keys(event).slice(0, EVENT_FIELDS.length), [...EVENT_FIELDS]);
  for (const field of WAKE_EVENT_FIELDS) {
    assert.ok(Object.hasOwn(event, field), `事件缺字段 ${field}`);
  }
  assert.equal(event.ts, new Date(NOW).toISOString(), '事件 ts 必须跟着注入的时间走');
  assert.equal(event.capability, 'wake');
  assert.equal(event.provider, WAKE_PROVIDER);
  assert.equal(event.units, 1);
  assert.equal(event.costEstimate, 0, '唤醒是本地能力，成本恒 0');
  assert.equal(event.ok, true);
  assert.equal(event.memoryId, 7);
  assert.equal(event.kind, 'preference');
  assert.equal(event.reason, '重要（5 分）且 9 天未提');
  assert.ok(event.weight > 0);
  wake.close();
});

test('pick·副作用：选中即刷新 last_recalled / recall_count（按 SPEC 的 24h 与 silence 语义）', () => {
  const store = new FakeStore([makeRow({ id: 1, importance: 5 })]);
  const { wake } = makeWake('pick-side-effect', { store });
  const result = wake.pick();
  assert.equal(result.memory.id, 1);
  assert.equal(store.rows[0].lastRecalled, NOW);
  assert.equal(store.rows[0].recallCount, 1);
  assert.deepEqual(store.bumpCalls, [{ ids: [1], now: NOW }]);
  wake.close();
});

test('pick·24h 静默闭环：刚提过的记忆不会在 24h 内被二次选中，另一条接棒', () => {
  const store = new FakeStore([
    makeRow({ id: 1, importance: 5 }),
    makeRow({ id: 2, importance: 4 }),
  ]);
  const { wake, clock } = makeWake('pick-silence-loop', { store });
  const first = wake.pick();
  assert.equal(first.memory.id, 1);

  clock.t = NOW + 5 * HOUR_MS; // 间隔够了，但 id 1 距上次被提只有 5h
  const second = wake.pick();
  assert.ok(second, '另一条记忆应该接棒');
  assert.equal(second.memory.id, 2, '刚提过的 id 1 必须被 24h 静默挡掉');

  clock.t = NOW + 25 * HOUR_MS; // 次日，id 1 恢复资格
  const third = wake.pick();
  assert.ok(third);
  assert.equal(third.memory.id, 1, '过了 24h 应恢复资格');
  wake.close();
});

test('pick·读库失败不炸：返回 null + blocked(storage-error) + warn', () => {
  const store = new FakeStore([makeRow({ id: 1 })]);
  store.listThrows = true;
  const { wake, home, warns } = makeWake('pick-list-fail', { store });
  assert.equal(wake.pick(), null);
  assert.ok(warns.length >= 1, '读库失败应 warn');
  const blocked = eventsOf(home).filter((event) => event.action === 'blocked').at(-1);
  assert.equal(blocked.blockedBy, 'storage-error');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorCategory, 'storage');
  wake.close();
});

test('pick·计数写入失败只 warn：本次唤醒照常返回', () => {
  const store = new FakeStore([makeRow({ id: 1, importance: 5 })]);
  store.bumpThrows = true;
  const { wake, home, warns } = makeWake('pick-bump-fail', { store });
  const result = wake.pick();
  assert.ok(result, '计数失败不该让她这次说不出话');
  assert.equal(result.memory.id, 1);
  assert.ok(warns.some((message) => message.includes('唤醒计数写入失败')));
  assert.equal(eventsOf(home).filter((event) => event.action === 'picked').length, 1);
  wake.close();
});

test('pick·事件写不进去只 warn：唤醒结果不受影响', () => {
  const home = makeHome('pick-event-fail');
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');
  const { wake, warns } = makeWake('pick-event-fail-wake', {
    rows: [makeRow({ id: 1, importance: 5 })],
    home,
    eventsPath: path.join(blocker, 'events.jsonl'),
  });
  const result = wake.pick();
  assert.ok(result, '记账失败不能影响唤醒结果');
  assert.equal(result.memory.id, 1);
  assert.ok(warns.some((message) => message.includes('唤醒事件写入失败')));
  wake.close();
});

test('pick·参数校验：畸形 now / budget / limits 是编程错误，直接抛', () => {
  const { wake } = makeWake('pick-validate', { rows: [makeRow({ id: 1 })] });
  assert.throws(() => wake.pick({ now: 'now' }), TypeError);
  assert.throws(() => wake.pick({ budget: -1 }), TypeError);
  assert.throws(() => wake.pick({ budget: 'lots' }), TypeError);
  assert.throws(() => createWake({ store: new FakeStore(), limits: { dailyLimit: -1 } }), TypeError);
  assert.throws(() => createWake({ store: new FakeStore(), limits: { dailyLmit: 3 } }), TypeError);
  assert.throws(() => normalizeLimits({ minImportance: 9 }), TypeError);
  wake.close();
});

/* ================================================================== *
 * 6. schedule：纯预排
 * ================================================================== */

test('schedule·当天预排：最多 3 个点、间隔 >= 4h、升序、互不重复', () => {
  const kinds = ['fact', 'preference', 'episode', 'relation'];
  const rows = kinds.map((kind, index) => makeRow({ id: index + 1, kind, importance: 5 }));
  const { wake } = makeWake('schedule-day', { rows });
  const planned = wake.schedule({ from: NOW, until: DAY0 + 23 * HOUR_MS });
  assert.equal(planned.length, 3, '每日上限 3 次');
  assert.deepEqual(planned.map((item) => item.at), [
    NOW,
    NOW + 4 * HOUR_MS,
    NOW + 8 * HOUR_MS,
  ]);
  assert.deepEqual(planned.map((item) => item.memory.id), [1, 2, 3]);
  assert.equal(new Set(planned.map((item) => item.memory.id)).size, 3);
  for (let i = 1; i < planned.length; i += 1) {
    assert.ok(planned[i].at - planned[i - 1].at >= 4 * HOUR_MS, '两次唤醒间隔必须 >= 4h');
  }
  for (const item of planned) {
    assert.ok(item.at >= NOW && item.at < DAY0 + 23 * HOUR_MS);
    assert.match(item.reason, /重要（5 分）/u);
  }
  wake.close();
});

test('schedule·尊重既有历史：今天已提 2 次 → 只再排 1 次，且等过 4h 间隔', () => {
  const rows = [1, 2, 3].map((id) => makeRow({ id, importance: 5 }));
  const { wake, home } = makeWake('schedule-history', { rows });
  seedWakeEvent(home, { ts: NOW - 5 * HOUR_MS, memoryId: 11, kind: 'fact' });
  seedWakeEvent(home, { ts: NOW - 1 * HOUR_MS, memoryId: 12, kind: 'preference' });

  const planned = wake.schedule({ from: NOW, until: DAY0 + 23 * HOUR_MS });
  assert.equal(planned.length, 1, '今天只剩 1 次额度');
  assert.equal(planned[0].at, NOW + 3 * HOUR_MS, '必须等满 4h 间隔（上次在 1h 前）');
  wake.close();
});

test('schedule·纯预排：不写事件、不改记忆（last_recalled 原样）', () => {
  const rows = ['fact', 'preference', 'episode'].map((kind, index) => makeRow({
    id: index + 1, kind, importance: 5,
  }));
  const store = new FakeStore(rows);
  const { wake, home } = makeWake('schedule-pure', { store });
  const planned = wake.schedule({ from: NOW, until: DAY0 + 23 * HOUR_MS });
  assert.equal(planned.length, 3);
  assert.equal(fs.existsSync(path.join(home, 'events.jsonl')), false, '预排不许写事件');
  assert.deepEqual(store.bumpCalls, [], '预排不许改库');
  assert.deepEqual(store.rows.map((row) => row.lastRecalled), [null, null, null, null].slice(0, rows.length));
  wake.close();
});

test('schedule·跨天：空窗跳过（24h 静默），每天仍不超过 3 次', () => {
  const rows = ['fact', 'preference', 'episode'].map((kind, index) => makeRow({
    id: index + 1, kind, importance: 5,
  }));
  const { wake } = makeWake('schedule-multiday', { rows });
  // 从第 0 天 10:00 一直排到第 2 天 23:00
  const planned = wake.schedule({ from: NOW, until: DAY0 + 2 * DAY_MS + 23 * HOUR_MS });
  assert.ok(planned.length >= 6, `跨三天至少应排出 6 次，实际 ${planned.length}`);

  const byDay = new Map();
  for (const item of planned) {
    const day = startOfLocalDay(item.at);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  for (const [day, count] of byDay) {
    assert.ok(count <= 3, `${new Date(day).toISOString()} 排了 ${count} 次，超过每日上限`);
  }
  // 第 1 天的第一次不应早于「第 0 天 10:00 + 24h」——太新时 schedule 应跳过空窗。
  const day1 = planned.filter((item) => startOfLocalDay(item.at) === DAY0 + DAY_MS);
  assert.ok(day1.length >= 1);
  assert.ok(day1[0].at >= NOW + DAY_MS, '第 1 天第一次唤醒必须等记忆恢复 24h 资格');
});

test('schedule·空库 / 全不合格 → 空数组，不抛', () => {
  const empty = makeWake('schedule-empty', { rows: [] });
  assert.deepEqual(empty.wake.schedule({ from: NOW, until: DAY0 + 23 * HOUR_MS }), []);
  empty.wake.close();

  const low = makeWake('schedule-low', { rows: [makeRow({ id: 1, importance: 1 })] });
  assert.deepEqual(low.wake.schedule({ from: NOW, until: DAY0 + 23 * HOUR_MS }), []);
  low.wake.close();
});

test('schedule·参数校验与退化：until <= from / 非法时间', () => {
  const { wake } = makeWake('schedule-validate', { rows: [makeRow({ id: 1 })] });
  assert.throws(() => wake.schedule({ from: NOW, until: NOW - 1 }), TypeError);
  assert.throws(() => wake.schedule({ from: 'from', until: NOW }), TypeError);
  assert.deepEqual(wake.schedule({ from: NOW, until: NOW }), []);
  wake.close();
});

test('schedule·读库失败 → 空数组 + warn + blocked(storage-error) 事件，不炸', () => {
  const store = new FakeStore([makeRow({ id: 1 })]);
  store.listThrows = true;
  const { wake, home, warns } = makeWake('schedule-store-fail', { store });
  assert.deepEqual(wake.schedule({ from: NOW, until: DAY0 + 23 * HOUR_MS }), []);
  assert.ok(warns.length >= 1);
  const blocked = eventsOf(home).filter((event) => event.action === 'blocked').at(-1);
  assert.equal(blocked.blockedBy, 'storage-error');
  assert.equal(blocked.ok, false);
  wake.close();
});

test('schedule·预排里同 kind 上限也生效', () => {
  const rows = [
    makeRow({ id: 1, kind: 'episode', importance: 5 }),
    makeRow({ id: 2, kind: 'episode', importance: 5 }),
    makeRow({ id: 3, kind: 'episode', importance: 5 }),
  ];
  const { wake } = makeWake('schedule-kind', { rows });
  const planned = wake.schedule({ from: NOW, until: DAY0 + 23 * HOUR_MS });
  assert.equal(planned.length, 2, '同一 kind 每日最多 2 次');
  assert.ok(planned.every((item) => item.memory.kind === 'episode'));
  wake.close();
});

/* ================================================================== *
 * 7. 真实 sqlite 集成与降级链
 * ================================================================== */

test('集成·真实 sqlite：pick 读真库、写事件、刷新 last_recalled', () => {
  const home = makeHome('sqlite-integration');
  const memory = createMemory({ env: envFor(home), now: () => NOW, warn: () => {} });
  const first = memory.remember({
    content: '主人住在杭州', kind: 'fact', importance: 5, force: true,
  });
  const second = memory.remember({
    content: '主人讨厌香菜', kind: 'preference', importance: 4, force: true,
  });
  assert.equal(first.recorded, true);
  assert.equal(second.recorded, true);
  memory.close();

  const wake = createWake({
    env: envFor(home),
    now: () => NOW,
    random: () => 0, // 稳定选 id 最小的一条
    warn: () => {},
  });
  try {
    assert.equal(wake.mode, 'sqlite', 'POND_HOME 正常时应走 sqlite');
    const picked = wake.pick();
    assert.ok(picked, '真实库里有候选却没唤醒');
    assert.equal(picked.memory.id, first.id);
    assert.equal(picked.memory.importance, 5);
    assert.match(picked.reason, /重要（5 分）/u);
  } finally {
    wake.close();
  }

  const events = eventsOf(home);
  const pickedEvent = events.filter((event) => event.action === 'picked').at(-1);
  assert.ok(pickedEvent, '真实库场景也必须写 picked 事件');
  assert.equal(pickedEvent.capability, 'wake');

  const reopened = createMemory({ env: envFor(home), warn: () => {} });
  const exported = reopened.export().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const row = exported.find((item) => item.id === first.id);
  assert.equal(row.lastRecalled, NOW, 'last_recalled 没写回真库');
  assert.equal(row.recallCount, 1);
  reopened.close();
});

test('降级·sqlite 打不开 → 易失后端接手：pick 不抛，事件记两条尝试', () => {
  const home = makeHome('degraded-sqlite');
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');
  const eventsPath = path.join(home, 'events.jsonl');
  const warns = [];
  const wake = createWake({
    env: envFor(home),
    dbPath: path.join(blocker, 'memory.db'),
    eventsPath,
    now: () => NOW,
    random: () => 0,
    warn: (message) => warns.push(String(message)),
  });
  try {
    assert.equal(wake.mode, 'memory-volatile', '库打不开时应降级到易失后端');
    assert.equal(wake.pick(), null, '空易失库没有候选，应返回 null 而不是抛');
  } finally {
    wake.close();
  }

  const events = eventsOf(home);
  const degraded = events.filter((event) => event.op === 'open' && event.action === 'degraded');
  assert.equal(degraded.length, 2, '降级链的两个尝试都要记账');
  assert.equal(degraded[0].ok, false);
  assert.equal(degraded[0].attempt, 1);
  assert.equal(degraded[1].ok, true);
  assert.equal(degraded[1].attempt, 2);
  assert.equal(degraded[1].degradedFrom, 'sqlite');
  const blocked = events.filter((event) => event.action === 'blocked').at(-1);
  assert.equal(blocked.blockedBy, 'no-memories');
});

/* ================================================================== *
 * 8. 一次性入口与守卫
 * ================================================================== */

test('便捷入口·pickOnce / scheduleOnce 每次用完即关，结果与实例版一致', () => {
  const home = makeHome('oneshot');
  const rows = [makeRow({ id: 1, importance: 5, lastRecalled: NOW - 9 * DAY_MS })];
  const picked = pickOnce({
    store: new FakeStore(rows),
    env: envFor(home),
    now: NOW,
    random: () => 0,
    warn: () => {},
  });
  assert.equal(picked.memory.id, 1);
  assert.equal(picked.reason, '重要（5 分）且 9 天未提');

  const planned = scheduleOnce({
    store: new FakeStore(rows),
    env: envFor(home),
    now: NOW,
    random: () => 0,
    warn: () => {},
    from: NOW,
    until: DAY0 + 23 * HOUR_MS,
  });
  assert.equal(planned.length, 1);
});

test('守卫·src/wake 只 import 内置 / 同目录 / shared / memory，不碰诊断层、不联网', () => {
  const dir = path.join(ROOT, 'src', 'wake');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length >= 4, `src/wake 至少 4 个模块，实际 ${files.length}`);

  const bannedNetwork = ['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls'];
  const forbiddenDiagnostic = ['../cli', '../discover', '../read', '../evaluate', '../render', '../check'];
  const allowedPrefixes = ['node:', './', '../shared/', '../memory/'];
  const importPattern = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gu;

  for (const name of files) {
    const relative = path.join('src', 'wake', name);
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    // 剥注释：注释里出现的 import 示例不算依赖。
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

    for (const match of code.matchAll(importPattern)) {
      const specifier = match[1];
      assert.ok(
        allowedPrefixes.some((prefix) => specifier.startsWith(prefix)),
        `${relative} import 了白名单之外的 '${specifier}'（只许内置 / 同目录 / shared / memory）`,
      );
      assert.equal(bannedNetwork.includes(specifier), false, `${relative} 不许 import ${specifier}`);
      assert.equal(forbiddenDiagnostic.includes(specifier), false, `${relative} 不许 import 诊断层 ${specifier}`);
    }

    assert.equal(/\bfetch\s*\(/u.test(code), false, `${relative} 自己调用了 fetch()（唤醒是纯本地能力）`);
    assert.equal(/\bnew\s+WebSocket\s*\(/u.test(code), false, `${relative} 创建了 WebSocket`);
  }
});

test('守卫·诊断层不 import 唤醒层（层间只许走 events.jsonl 这个文件接缝）', () => {
  const diagnosticDirs = ['check', 'read', 'evaluate', 'render', 'discover'];
  const files = [path.join(ROOT, 'src', 'cli.mjs')];
  for (const dirName of diagnosticDirs) {
    const dir = path.join(ROOT, 'src', dirName);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.mjs')) files.push(path.join(dir, name));
    }
  }
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:wake|memory|tts|image)[^'"]*['"]/u.test(text)) {
      violations.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(violations, [], `诊断层 import 了能力层：\n${violations.join('\n')}`);
});

test('守卫·唤醒事件仍然是 append-only 的一行一条（不重写历史）', () => {
  const { wake, home } = makeWake('guard-append', {
    rows: [makeRow({ id: 1, importance: 5 }), makeRow({ id: 2, importance: 5 })],
  });
  wake.pick();
  const linesBefore = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').length;
  // 第二次一定被间隔拦住，但 blocked 事件是追加，不是覆盖。
  wake.pick();
  const linesAfter = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(linesAfter, linesBefore + 1, '事件流必须只追加');
  wake.close();
});
