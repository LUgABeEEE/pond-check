/**
 * pond-check · C2 长期记忆测试（tests/memory.test.mjs）
 *
 * 这个文件钉的是**五个能力里最重要的那一个**（CAPABILITIES-SPEC §3）：
 *   1. 存储：node:sqlite 落 <POND_HOME>，schema 齐，删目录即初始状态
 *   2. 三闸沉淀：候选抽取（抽不出不记）→ 去重合并（不重复记）→ 重要性评分
 *   3. 四因子召回：相关度 / 新鲜度 / 重要性 / 重复惩罚**各自都能主导排序**，
 *      每条结果带 why 分项（召回不是黑盒）
 *   4. forget / export（JSONL 可回读）
 *   5. 降级链与失败路径：sqlite→易失、FTS→扫描、事件写不进去只 warn、
 *      存储坏了返回 storage-error 不炸调用方
 *   6. 红线：src/memory 不 import 任何网络模块、不 fetch（守卫自带金丝雀）
 *
 * v0.2.1 记忆层四处改动（借鉴 Ombre Brain）各自的回归测试在 §7（①归档/purge、
 * ③valence/arousal）、§11（②importance=5 配额）、§12（④召回降级细分）：
 *   ① forget=归档（可 includeArchived 找回），purge 才真删且留不可忽略审计，
 *      export 把归档与现存分开
 *   ② importance=5 硬上限 20：超了返回 importance-quota-full + 清单，不静默降级；
 *      降级 / purge 之后能再写
 *   ③ memories 加 valence/arousal：只存不算分（四因子公式不受影响）；
 *      旧库迁移在 tests/memory-migration.test.mjs
 *   ④ degradation.channel 说明这次召回退化在哪一段（keyword-only /
 *      fts-unavailable / scan-fallback），完整召回才是 null
 *
 * 验收门（任务书原话）：
 *   node --test tests/memory.test.mjs 全绿；覆盖三类各写各读、相似候选不重复记、
 *   四因子各自能主导排序、recall_count 增加后权重下降、export 可回读。
 *   变异验证：去掉去重闸测试必须红（见任务 commandsRun 的 M1–M8）。
 *
 * 测试纪律：
 *   - 所有写入都指向 mkdtemp 的临时 POND_HOME，绝不碰真实 `~/.pond`；
 *   - 时间用注入的 `now`（makeMemory 返回可拨的 clock），不靠真时钟；
 *   - 浮点比较一律走 closeTo，不用裸 ===。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  createMemory,
  remember,
  recall,
  forget,
  purge,
  setImportance,
  importanceQuota,
  exportMemories,
  KINDS,
  KIND_HALF_LIFE_DAYS,
  FACTOR_WEIGHTS,
  SCORE_FORMULA,
  SCAN_RELEVANCE_CAP,
  SIMILARITY_THRESHOLD,
  MAX_TOP_IMPORTANCE_ENTRIES,
  IMPORTANCE_QUOTA,
  DEGRADATION_CHANNELS,
  freshnessFactor,
  importanceFactor,
  penaltyFactor,
  combineScore,
  normalizeRelevance,
  halfLifeDaysFor,
  classifyKind,
  scoreImportance,
  trigramJaccard,
  queryTokens,
  segmentText,
} from '../src/memory/index.mjs';
import { EVENT_FIELDS } from '../src/shared/events.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-memory-'));
const NOW_BASE = Date.parse('2026-11-01T10:00:00+08:00');
const DAY_MS = 24 * 60 * 60 * 1000;

let counter = 0;

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 夹具地基
 * ------------------------------------------------------------------ */

function makeHome(label) {
  counter += 1;
  const home = path.join(TEMP_ROOT, `${String(counter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function envFor(home) {
  return { POND_HOME: home };
}

/** 造一个记忆实例：独立 POND_HOME + 可拨时钟 + 捕获 warn。 */
function makeMemory(label, overrides = {}) {
  const home = makeHome(label);
  const clock = { t: NOW_BASE };
  const warns = [];
  const memory = createMemory({
    env: envFor(home),
    now: overrides.now ?? (() => clock.t),
    warn: (message) => warns.push(String(message)),
  });
  return { memory, home, clock, warns };
}

function eventsOf(home) {
  const file = path.join(home, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** 直接改库里的 recall_count（模拟「被提过很多次」）。 */
function setRecallCount(home, id, count) {
  const db = new DatabaseSync(path.join(home, 'memory.db'));
  db.function('segment', { deterministic: true }, (text) => segmentText(text));
  db.prepare('UPDATE memories SET recall_count = ? WHERE id = ?').run(count, id);
  db.close();
}

/** 破坏 FTS 索引（只删索引不动主表，模拟外力损坏）。 */
function dropFts(home) {
  const db = new DatabaseSync(path.join(home, 'memory.db'));
  db.exec('DROP TABLE IF EXISTS memories_fts');
  db.close();
}

/** 取事件流里最后一条指定 op 的事件（export 等操作也会写事件，别用 at(-1) 瞎猜）。 */
function lastEventOf(home, op) {
  return eventsOf(home).filter((event) => event.op === op).at(-1);
}

function closeTo(actual, expected, epsilon = 1e-9, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label} 期望 ${expected}，实际 ${actual}（容差 ${epsilon}）`,
  );
}

/* ------------------------------------------------------------------ *
 * 1. 存储
 * ------------------------------------------------------------------ */

test('存储：库落在 <POND_HOME>/memory.db，POND_HOME 覆盖生效', () => {
  const { memory, home } = makeMemory('store-path');
  assert.equal(memory.mode, 'sqlite');
  assert.equal(memory.dbPath, path.join(home, 'memory.db'));
  memory.remember('主人住在杭州');
  assert.ok(fs.existsSync(path.join(home, 'memory.db')), 'memory.db 没有落在 POND_HOME 里');
  memory.close();
});

test('存储：删掉 POND_HOME 就回到初始状态（SPEC §6.3）', () => {
  const { memory, home } = makeMemory('store-reset');
  memory.remember('主人住在杭州');
  memory.close();

  fs.rmSync(home, { recursive: true, force: true });
  const fresh = createMemory({ env: envFor(home), warn: () => {} });
  assert.equal(fresh.export(), '', '删掉目录后还能导出东西，状态没有真正归零');
  fresh.close();
});

test('存储：schema 有 memories 主表、FTS 虚拟表、四个索引、三个触发器', () => {
  const { memory, home } = makeMemory('store-schema');
  memory.remember('主人住在杭州');
  memory.close();

  const db = new DatabaseSync(path.join(home, 'memory.db'));
  const names = db.prepare('SELECT name FROM sqlite_master').all().map((row) => row.name);
  db.close();
  for (const expected of [
    'memories', 'memories_fts',
    'idx_memories_kind', 'idx_memories_importance', 'idx_memories_last_recalled', 'idx_memories_archived',
    'memories_fts_ai', 'memories_fts_ad', 'memories_fts_au',
  ]) {
    assert.ok(names.includes(expected), `schema 缺 ${expected}`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. 三类记忆各写各读
 * ------------------------------------------------------------------ */

test('三类各写各读：fact / preference / episode 都能记住并按关键词召回', () => {
  const { memory } = makeMemory('three-kinds');
  const specs = [
    { kind: 'fact', content: '主人住在杭州', entities: ['杭州'] },
    { kind: 'preference', content: '主人讨厌香菜', entities: ['香菜'] },
    { kind: 'episode', content: '昨天一起看了芙莉莲第 12 集', entities: ['芙莉莲'] },
  ];
  for (const spec of specs) {
    const result = memory.remember(spec);
    assert.equal(result.recorded, true, `${spec.kind} 没写进去`);
    assert.equal(result.action, 'created');
  }

  for (const spec of specs) {
    const keyword = { fact: '杭州', preference: '香菜', episode: '芙莉莲' }[spec.kind];
    const items = memory.recall(keyword);
    const hit = items.find((item) => item.kind === spec.kind);
    assert.ok(hit, `${spec.kind} 没被召回`);
    assert.equal(hit.content, spec.content);
    assert.deepEqual(hit.entities, spec.entities);
    assert.ok(hit.score > 0, `${spec.kind} 的得分应大于 0`);
    // why 必须是分项对象，不是黑盒
    for (const key of ['relevance', 'freshness', 'importance', 'penalty', 'score']) {
      assert.equal(typeof hit.why[key], 'number', `why.${key} 不是数字`);
    }
  }
  memory.close();
});

/* ------------------------------------------------------------------ *
 * 3. 闸一 · 候选抽取
 * ------------------------------------------------------------------ */

test('闸一·候选抽取：显式 kind 直接收编，抽不出类别就不记', () => {
  assert.equal(classifyKind('主人讨厌香菜', 'fact'), 'fact', '显式 kind 必须优先于启发式');
  assert.equal(classifyKind('主人讨厌香菜'), 'preference', '明确好恶应抽成 preference');
  assert.equal(classifyKind('昨天一起看了芙莉莲第 12 集'), 'episode', '带时间的经历应抽成 episode');
  assert.equal(classifyKind('10/28 一起看了芙莉莲'), 'episode', '日期 + 一起 应抽成 episode');
  assert.equal(classifyKind('主人住在杭州'), 'fact', '稳定陈述应抽成 fact');
  assert.equal(classifyKind('嗯嗯'), null, '语气词抽不出类别');
  assert.equal(classifyKind('哈哈哈'), null, '纯笑声抽不出类别');
  assert.equal(classifyKind('随便'), null, '两字碎片抽不出类别');
  assert.equal(classifyKind(''), null, '空串抽不出类别');
});

test('闸一·候选抽取：抽不出就不记（rejected + no-kind，且不落库）', () => {
  const { memory, home } = makeMemory('gate1-reject');
  const result = memory.remember('嗯嗯');
  assert.equal(result.recorded, false);
  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'no-kind');
  assert.equal(memory.export(), '', '被闸一拒掉的内容不许落库');
  const last = lastEventOf(home, 'remember');
  assert.equal(last.op, 'remember');
  assert.equal(last.action, 'rejected');
  assert.equal(last.reason, 'no-kind');
  assert.equal(last.units, 0);
  memory.close();
});

test('闸一·候选抽取：非法 kind 抛 TypeError（编程错误不伪装成能力不可用）', () => {
  const { memory } = makeMemory('gate1-type');
  assert.throws(() => memory.remember({ content: '好内容', kind: 'banana' }), TypeError);
  assert.throws(() => memory.remember({ content: '' }), TypeError);
  assert.throws(() => memory.remember(42), TypeError);
  memory.close();
});

/* ------------------------------------------------------------------ *
 * 4. 闸二 · 去重合并
 * ------------------------------------------------------------------ */

test('闸二·去重合并：相似候选不重复记（保 id、更新 content/updated_at、importance 取 max）', () => {
  const { memory, clock } = makeMemory('gate2-merge');
  const first = memory.remember({ content: '主人住在杭州', kind: 'fact', entities: ['杭州'] });
  const createdAt = first.memory.createdAt;

  clock.t += 3 * DAY_MS;
  const second = memory.remember({
    content: '主人住在杭州市',
    kind: 'fact',
    entities: ['杭州市'],
    importance: 4,
  });

  assert.equal(second.action, 'merged', '相似候选必须走合并而不是新增');
  assert.equal(second.id, first.id, '合并必须保 id');
  closeTo(second.similarity, 0.8, 1e-9, 'trigram 相似度');
  assert.ok(second.similarity >= SIMILARITY_THRESHOLD);

  assert.equal(second.memory.content, '主人住在杭州市', '合并要更新 content');
  assert.equal(second.memory.updatedAt, NOW_BASE + 3 * DAY_MS, '合并要刷新 updated_at');
  assert.equal(second.memory.createdAt, createdAt, 'created_at 不许被改写');
  assert.equal(second.memory.importance, 4, 'importance 必须取 max(3, 4)');

  const lines = memory.export().trim().split('\n');
  assert.equal(lines.length, 1, '相似候选不许让库内条数变多');
  memory.close();
});

test('闸二·去重合并：不同 kind 不合并，不相似的正常新增', () => {
  const { memory } = makeMemory('gate2-scope');
  memory.remember({ content: '讨厌香菜', kind: 'preference' });
  const crossKind = memory.remember({ content: '讨厌香菜', kind: 'fact' });
  assert.equal(crossKind.action, 'created', 'kind 不同不算同一件事');

  const different = memory.remember({ content: '主人住在广州市', kind: 'fact' });
  assert.equal(different.action, 'created');
  closeTo(different.similarity ?? 0, 0, 1e-9, '无关内容相似度');

  // 差一点过阈值的不算相似：主人住在杭州 vs 主人住在广州市 = 2/7
  const nearMiss = memory.remember({ content: '主人住在杭州', kind: 'fact' });
  assert.equal(nearMiss.action, 'created', '相似度 0.29 不该触发合并');
  assert.equal(memory.export().trim().split('\n').length, 4);
  memory.close();
});

test('闸二·force 跳过去重会新增，并把 gatesSkipped 记进事件流', () => {
  const { memory, home } = makeMemory('gate2-force');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });
  const forced = memory.remember({ content: '主人住在杭州', kind: 'fact', force: true });

  assert.equal(forced.action, 'created', 'force 必须跳过闸二');
  assert.deepEqual(forced.gatesSkipped, ['dedupe']);
  assert.equal(memory.export().trim().split('\n').length, 2, 'force 之后确实有两条');

  const last = lastEventOf(home, 'remember');
  assert.equal(last.op, 'remember');
  assert.deepEqual(last.gatesSkipped, ['dedupe'], '跳闸必须在事件流里留痕（SPEC §3.3）');
  memory.close();
});

test('trigram Jaccard：同串 1.0、无关 0.0、近似串过 0.75、标点不影响', () => {
  closeTo(trigramJaccard('主人住在杭州', '主人住在杭州'), 1, 1e-9, '同串');
  closeTo(trigramJaccard('主人住在杭州', '讨厌香菜和芹菜'), 0, 1e-9, '无关');
  closeTo(trigramJaccard('主人住在杭州', '主人住在杭州市'), 0.8, 1e-9, '近似');
  closeTo(trigramJaccard('主人住在杭州。', '主人住在杭州'), 1, 1e-9, '标点归一化');
  assert.ok(trigramJaccard('主人住在杭州', '主人住在杭州市') >= SIMILARITY_THRESHOLD);
  assert.ok(trigramJaccard('主人住在杭州', '主人住在广州市') < SIMILARITY_THRESHOLD);
  closeTo(trigramJaccard('', '杭州'), 0, 1e-9, '空串不许和任何东西算相似');
});

/* ------------------------------------------------------------------ *
 * 5. 闸三 · 重要性评分
 * ------------------------------------------------------------------ */

test('闸三·重要性启发式：记住→5、好恶→4、一般事实→3、episode→2、猜测→1', () => {
  assert.equal(scoreImportance({ content: '请记住我的生日是 3 月 5 日', kind: 'fact' }), 5);
  assert.equal(scoreImportance({ content: '主人的健康状况要留意过敏史', kind: 'fact' }), 5);
  assert.equal(scoreImportance({ content: '讨厌香菜', kind: 'preference' }), 4);
  assert.equal(scoreImportance({ content: '一般事实陈述', kind: 'fact' }), 3);
  assert.equal(scoreImportance({ content: '看了剧', kind: 'episode' }), 2);
  assert.equal(scoreImportance({ content: '可能大概是随便猜的', kind: 'fact' }), 1);
});

test('闸三·显式 importance 直接采用（用户说了算）', () => {
  const { memory } = makeMemory('gate3-explicit');
  const result = memory.remember({ content: '一般内容样本', kind: 'fact', importance: 5 });
  assert.equal(result.memory.importance, 5);
  assert.equal(result.gates.importance.explicit, true);
  memory.close();
});

test('闸三·猜测性内容默认不记，force 才收（跳闸进事件流）', () => {
  const { memory, home } = makeMemory('gate3-speculative');
  const rejected = memory.remember('可能大概是随便猜的');
  assert.equal(rejected.recorded, false);
  assert.equal(rejected.reason, 'low-importance');
  assert.equal(memory.export(), '', '1 分内容默认不许落库');

  const forced = memory.remember({ content: '可能大概是随便猜的', kind: 'fact', force: true });
  assert.equal(forced.recorded, true);
  assert.equal(forced.memory.importance, 1);
  assert.deepEqual(forced.gatesSkipped, ['dedupe', 'low-importance-drop'],
    'force 会同时跳过闸二与闸三的「默认不记」，两处都要留痕');

  const last = lastEventOf(home, 'remember');
  assert.deepEqual(last.gatesSkipped, ['dedupe', 'low-importance-drop']);
  memory.close();
});

test('闸三·importance / confidence / entities / ttlDays 越界抛 TypeError', () => {
  const { memory } = makeMemory('gate3-type');
  assert.throws(() => memory.remember({ content: '好内容', kind: 'fact', importance: 0 }), TypeError);
  assert.throws(() => memory.remember({ content: '好内容', kind: 'fact', importance: 6 }), TypeError);
  assert.throws(() => memory.remember({ content: '好内容', kind: 'fact', importance: 1.5 }), TypeError);
  assert.throws(() => memory.remember({ content: '好内容', kind: 'fact', confidence: 2 }), TypeError);
  assert.throws(() => memory.remember({ content: '好内容', kind: 'fact', entities: '杭州' }), TypeError);
  assert.throws(() => memory.remember({ content: '好内容', kind: 'fact', ttlDays: 0 }), TypeError);
  memory.close();
});

/* ------------------------------------------------------------------ *
 * 6. 四因子召回
 * ------------------------------------------------------------------ */

test('四因子·相关度能主导排序：命中压倒更高的重要性', () => {
  const { memory } = makeMemory('factor-relevance');
  const weak = memory.remember({ content: '主人的生日是 3 月 5 日', kind: 'fact', importance: 5 });
  const strong = memory.remember({ content: '昨天在西湖边散步', kind: 'episode', importance: 2 });

  const items = memory.recall('西湖');
  assert.equal(items[0].id, strong.id, '相关度必须压过重要性（0.40 权重）');
  assert.equal(items[1].id, weak.id);
  closeTo(items[0].why.relevance, 1, 1e-9, '命中者的相关度');
  closeTo(items[1].why.relevance, 0, 1e-9, '未命中者的相关度');
  assert.ok(items[0].importance < items[1].importance, '前提：落选者的 importance 更高');
  memory.close();
});

test('四因子·新鲜度能主导排序：新的压倒旧的（其它因子全相等）', () => {
  const { memory, clock } = makeMemory('factor-freshness');
  const older = memory.remember({ content: '老事实甲', kind: 'fact' });
  clock.t += 60 * DAY_MS;
  const newer = memory.remember({ content: '新事实乙', kind: 'fact' });

  const items = memory.recall('', { minScore: 0 });
  assert.equal(items[0].id, newer.id, '新鲜度必须决定顺序（否则 id 小的老记忆会赢）');
  assert.equal(items[1].id, older.id);
  assert.ok(items[0].why.freshness > items[1].why.freshness);
  closeTo(items[1].why.freshness, Math.pow(0.5, 60 / 365), 1e-9, '真半衰 0.5^(days/halfLife)');
  memory.close();
});

test('四因子·重要性能主导排序：重要的压倒一般的（其它因子全相等）', () => {
  const { memory } = makeMemory('factor-importance');
  const plain = memory.remember({ content: '一般事实甲', kind: 'fact' });
  const vital = memory.remember({ content: '头等大事乙', kind: 'fact', importance: 5 });

  const items = memory.recall('', { minScore: 0 });
  assert.equal(items[0].id, vital.id, '重要性必须决定顺序（否则 id 小的一般事实会赢）');
  assert.equal(items[1].id, plain.id);
  closeTo(items[0].why.importance, 1, 1e-9);
  closeTo(items[1].why.importance, 0.6, 1e-9);
  memory.close();
});

test('四因子·重复惩罚：recall_count 增加后权重（得分）逐次下降', () => {
  const { memory } = makeMemory('factor-penalty');
  memory.remember({ content: '重复惩罚样本', kind: 'fact' });

  const scores = [];
  const penalties = [];
  for (let i = 0; i < 11; i += 1) {
    const [item] = memory.recall('样本', { limit: 1 });
    scores.push(item.score);
    penalties.push(item.why.penalty);
    closeTo(item.why.recallCount, i, 1e-9, `第 ${i + 1} 次召回时的 recall_count`);
    closeTo(item.why.penalty, Math.min(1, i / 10), 1e-9, `第 ${i + 1} 次召回时的重复惩罚`);
    if (i > 0) {
      assert.ok(scores[i] < scores[i - 1], `第 ${i + 1} 次召回的得分必须比上次低`);
      closeTo(scores[i - 1] - scores[i], 0.01, 1e-9, '每次被提过一次惩罚 0.10×0.01');
    }
  }
  closeTo(penalties.at(-1), 1, 1e-9, '第 11 次时惩罚强度必须封顶 1');
  closeTo(scores[0] - scores.at(-1), 0.10, 1e-9, '封顶后相对初始总共降 0.10');
  memory.close();
});

test('四因子·重复惩罚能主导排序：被提过十次的沉下去（分差恰 0.10）', () => {
  const { memory, home } = makeMemory('factor-penalty-sort');
  const twinA = memory.remember({ content: '同一件事的孪生样本', kind: 'fact', importance: 4, force: true });
  const twinB = memory.remember({ content: '同一件事的孪生样本', kind: 'fact', importance: 4, force: true });

  // 基线：全相等 → 平局按 id 升序，先记的在前
  const baseline = memory.recall('', { minScore: 0, limit: 1 });
  assert.equal(baseline[0].id, twinA.id);

  setRecallCount(home, twinA.id, 10);
  const items = memory.recall('', { minScore: 0 });
  assert.equal(items[0].id, twinB.id, '被提过 10 次的必须沉到后面');
  assert.equal(items[1].id, twinA.id);
  closeTo(items[1].why.penalty, 1, 1e-9);
  closeTo(items[1].score, items[0].score - 0.10, 1e-9, '惩罚封顶时分差应恰为 0.10');
  memory.close();
});

test('召回·why 必须带四因子分项、权重与公式（不是黑盒）', () => {
  const { memory } = makeMemory('why-shape');
  memory.remember({ content: '主人住在杭州', kind: 'fact', entities: ['杭州'] });
  const [item] = memory.recall('杭州');

  for (const key of ['relevance', 'freshness', 'importance', 'penalty', 'score', 'weights', 'formula',
    'retrieval', 'daysSinceUpdate', 'halfLifeDays', 'recallCount']) {
    assert.ok(key in item.why, `why 缺 ${key}`);
  }
  assert.deepEqual(item.why.weights, { ...FACTOR_WEIGHTS });
  assert.equal(item.why.formula, SCORE_FORMULA);
  assert.equal(item.why.retrieval, 'fts');
  closeTo(item.why.score, item.score, 1e-9, 'why.score 必须与 score 同值');
  closeTo(
    item.score,
    0.40 * item.why.relevance + 0.25 * item.why.freshness + 0.25 * item.why.importance
      - 0.10 * item.why.penalty,
    1e-9,
    '公式手工复算',
  );
  memory.close();
});

test('召回·minScore / limit / kinds 过滤生效', () => {
  const { memory } = makeMemory('recall-filters');
  memory.remember({ content: '事实甲是杭州的事', kind: 'fact' });
  memory.remember({ content: '偏好乙是香菜的事', kind: 'preference' });
  memory.remember({ content: '经历丙是昨天的事', kind: 'episode' });

  assert.equal(memory.recall('', { minScore: 0, limit: 2 }).length, 2, 'limit 必须封顶');
  const onlyFact = memory.recall('', { minScore: 0, kinds: ['fact'] });
  assert.equal(onlyFact.length, 1);
  assert.equal(onlyFact[0].kind, 'fact');
  assert.equal(memory.recall('', { minScore: 0.99 }).length, 0, 'minScore 必须拦住低分');
  assert.throws(() => memory.recall('', { limit: 0 }), TypeError);
  assert.throws(() => memory.recall('', { minScore: 2 }), TypeError);
  assert.throws(() => memory.recall('', { kinds: ['banana'] }), TypeError);
  assert.throws(() => memory.recall(42), TypeError);
  memory.close();
});

test('召回·无关键词命中时相关度为 0，但仍按新鲜度/重要性返回', () => {
  const { memory } = makeMemory('recall-nohit');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });

  const items = memory.recall('潜水艇香蕉', { minScore: 0 });
  assert.ok(items.length >= 1);
  for (const item of items) {
    closeTo(item.why.relevance, 0, 1e-9, '无命中必须是 0');
    assert.equal(item.why.retrieval, 'fts');
  }
  memory.close();
});

test('召回·FTS 查询词里的运算符只当字面量，不许被注入成语法', () => {
  const { memory } = makeMemory('recall-injection');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });
  assert.doesNotThrow(() => memory.recall('NEAR AND OR * : ^'));
  assert.doesNotThrow(() => memory.recall('"'));
  assert.doesNotThrow(() => memory.recall('杭州 AND (NEAR/3 某某)'));
  memory.close();
});

/* ------------------------------------------------------------------ *
 * 7. forget / export
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 7. ① 归档语义 / ③ 情感坐标 / export
 * ------------------------------------------------------------------ */

test('① forget 是归档不是删除：日常召回看不到，includeArchived 还能找到，幂等', () => {
  const { memory } = makeMemory('forget-archive');
  const result = memory.remember({ content: '主人讨厌香菜', kind: 'preference' });
  assert.throws(() => memory.forget('x'), TypeError);

  const missing = memory.forget(999);
  assert.equal(missing.forgotten, false);
  assert.equal(missing.archived, false);
  assert.equal(missing.action, 'missing');

  const gone = memory.forget(result.id);
  assert.equal(gone.forgotten, true);
  assert.equal(gone.archived, true, 'forget 必须是归档（archived=1），不是删除');
  assert.equal(gone.action, 'archived');
  assert.equal(gone.memory.archived, true, '返回的行要反映归档状态');
  assert.equal(gone.memory.content, '主人讨厌香菜', '归档不许改内容');

  // 日常召回隐藏，includeArchived 找回——「淡出」的全部含义就在这里
  assert.equal(memory.recall('香菜', { minScore: 0 }).length, 0, '归档的记忆不许再出现在日常召回里');
  const archived = memory.recall('香菜', { minScore: 0, includeArchived: true });
  assert.equal(archived.length, 1, 'recall(includeArchived:true) 必须还能找回归档的记忆');
  assert.equal(archived[0].id, result.id);
  assert.equal(archived[0].archived, true, '召回结果要带 archived 标记');

  // 幂等：再忘一次不报错、不重复计数
  const again = memory.forget(result.id);
  assert.equal(again.forgotten, true);
  assert.equal(again.action, 'already-archived');
  assert.throws(() => memory.forget(1.5), TypeError);
  memory.close();
});

test('① purge 才真删：删除不可逆，事件流留下「谁/何时/删了什么摘要」的审计', () => {
  const { memory, home } = makeMemory('purge-audit');
  const kept = memory.remember({ content: '主人住在杭州', kind: 'fact' });
  const doomed = memory.remember({ content: '主人讨厌香菜', kind: 'preference', importance: 4 });

  // 归档之后 purge 仍然必须真的删掉（归档不是删除的保护伞）
  memory.forget(doomed.id);
  const archivedHits = () => memory.recall('香菜', { minScore: 0, includeArchived: true })
    .filter((item) => item.id === doomed.id);
  assert.equal(archivedHits().length, 1, '归档之后 includeArchived 还能找到');

  const result = memory.purge(doomed.id, { actor: '主人' });
  assert.equal(result.purged, true);
  assert.equal(result.deleted.id, doomed.id);
  assert.equal(result.deleted.kind, 'preference');
  assert.match(result.deleted.contentPreview, /香菜/u, '审计里要有内容摘要');
  assert.equal(result.deleted.contentDigest.length, 16, '摘要指纹是 sha256 前 16 位');
  assert.equal(typeof result.deleted.createdAt, 'number');

  assert.equal(archivedHits().length, 0, 'purge 之后连归档里都不该再有');
  assert.equal(memory.export({ includeArchived: true }).trim().split('\n').length, 1,
    'purge 之后导出里不该再有它');

  // 审计事件：不可忽略 = 谁、何时、删了什么摘要、且显式标不可逆
  const audit = lastEventOf(home, 'purge');
  assert.ok(audit, 'purge 必须在事件流里留一条记录');
  assert.equal(audit.action, 'purged');
  assert.equal(audit.actor, '主人', '审计必须记下是谁删的');
  assert.ok(Number.isFinite(Date.parse(audit.ts)), '审计必须有可解析的时间');
  assert.equal(audit.irreversible, true, 'purge 必须在事件里标成不可逆');
  assert.equal(audit.deleted.id, doomed.id);
  assert.equal(audit.deleted.contentDigest, result.deleted.contentDigest);
  assert.equal(audit.units, 1);
  assert.equal(result.audit.deleted.contentDigest, result.deleted.contentDigest,
    '返回值里要带回审计条目，调用方可以直接展示');

  // 不存在的 id：不炸、不写 purged
  const missing = memory.purge(9999);
  assert.equal(missing.purged, false);
  assert.equal(missing.deleted, null);
  assert.equal(lastEventOf(home, 'purge').action, 'missing');
  assert.throws(() => memory.purge('x'), TypeError);

  assert.equal(memory.export().trim().split('\n').length, 1, '留下的那条不受影响');
  assert.equal(kept.recorded, true);
  memory.close();
});

test('① export 区分现存与归档：默认只出现存，includeArchived 追加归档块，split 给两段', () => {
  const { memory } = makeMemory('export-archived');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });
  const archived = memory.remember({ content: '昨天一起看了芙莉莲', kind: 'episode' });
  memory.forget(archived.id);

  const activeOnly = memory.export().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(activeOnly.map((row) => row.content), ['主人住在杭州'], '默认导出不许混进归档的');

  const all = memory.export({ includeArchived: true }).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(all.length, 2);
  assert.equal(all[0].archived, false, '现存的排前面');
  assert.equal(all[1].archived, true, '归档的单独跟在后面，不交错');

  const split = memory.export({ split: true });
  assert.deepEqual(split.counts, { active: 1, archived: 1 });
  assert.equal(split.active.trim().split('\n').length, 1);
  assert.equal(split.archived.trim().split('\n').length, 1);
  assert.equal(JSON.parse(split.archived.trim()).content, '昨天一起看了芙莉莲');

  // 全归档：默认导出为空串，但仍能在 includeArchived 里找到
  memory.forget(activeOnly[0].id);
  assert.equal(memory.export(), '', '现存为零时默认导出为空');
  assert.equal(memory.export({ split: true }).counts.active, 0);
  assert.equal(memory.export({ split: true }).counts.archived, 2);
  memory.close();
});

test('③ valence / arousal：存得进、召回带得出、导得出，默认 NULL', () => {
  const { memory, home } = makeMemory('affect');
  const scored = memory.remember({
    content: '主人讨厌香菜',
    kind: 'preference',
    valence: -0.8,
    arousal: 0.4,
  });
  assert.equal(scored.recorded, true);
  assert.equal(scored.memory.valence, -0.8);
  assert.equal(scored.memory.arousal, 0.4);

  const plain = memory.remember({ content: '主人住在杭州', kind: 'fact' });
  assert.equal(plain.memory.valence, null, '没给就是 NULL，不拿 0 冒充中性');
  assert.equal(plain.memory.arousal, null);

  const [hit] = memory.recall('香菜', { minScore: 0 });
  assert.equal(hit.valence, -0.8);
  assert.equal(hit.arousal, 0.4);
  const [plainHit] = memory.recall('杭州', { minScore: 0 });
  assert.equal(plainHit.valence, null);
  assert.equal(plainHit.arousal, null);

  // 走库再读一次（不是内存里的对象残留）
  assert.equal(memory.recall('香菜', { minScore: 0, includeArchived: true })[0].valence, -0.8);

  const exported = memory.export().trim().split('\n').map((line) => JSON.parse(line));
  const exportedScored = exported.find((row) => row.content === '主人讨厌香菜');
  assert.equal(exportedScored.valence, -0.8);
  assert.equal(exportedScored.arousal, 0.4);
  assert.equal(exported.find((row) => row.content === '主人住在杭州').valence, null);

  // 合并时：新值优先，没给就保留旧值（不抹掉已知情绪）
  const merged = memory.remember({ content: '主人讨厌香菜。', kind: 'preference' });
  assert.equal(merged.action, 'merged');
  assert.equal(merged.memory.valence, -0.8, '合并没给 valence 时必须保留旧值');
  const overridden = memory.remember({
    content: '主人讨厌香菜！', kind: 'preference', valence: -0.2, arousal: 0.1,
  });
  assert.equal(overridden.memory.valence, -0.2, '合并给了新值就用新值');

  assert.ok(fs.existsSync(path.join(home, 'memory.db')));
  memory.close();
});

test('③ valence / arousal 越界抛 TypeError（编程错误不伪装成能力不可用）', () => {
  const { memory } = makeMemory('affect-type');
  const base = { content: '好内容样本', kind: 'fact' };
  for (const valence of [-1.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    assert.throws(() => memory.remember({ ...base, valence }), TypeError, `valence=${String(valence)} 应被拒`);
  }
  for (const arousal of [-0.01, 1.01, Number.NaN, '0.5']) {
    assert.throws(() => memory.remember({ ...base, arousal }), TypeError, `arousal=${String(arousal)} 应被拒`);
  }
  // 边界值是合法的
  assert.equal(memory.remember({ ...base, valence: -1, arousal: 0 }).recorded, true);
  assert.equal(memory.remember({ ...base, content: '另一个内容样本', valence: 1, arousal: 1 }).recorded, true);
  memory.close();
});

test('③ 只存不算分：valence / arousal 绝不进四因子公式与 why', () => {
  assert.deepEqual(Object.keys(FACTOR_WEIGHTS), ['relevance', 'freshness', 'importance', 'penalty'],
    '四因子权重表里不许出现 valence / arousal');
  assert.equal(SCORE_FORMULA.includes('valence'), false);
  assert.equal(SCORE_FORMULA.includes('arousal'), false);

  const { memory } = makeMemory('affect-not-scored');
  // 两条除了情感坐标之外完全一样的记忆（force 避免被合并）
  const negative = memory.remember({
    content: '孪生样本甲', kind: 'fact', force: true, valence: -1, arousal: 1,
  });
  const positive = memory.remember({
    content: '孪生样本甲', kind: 'fact', force: true, valence: 1, arousal: 0,
  });
  const items = memory.recall('', { minScore: 0 });
  assert.equal(items.length, 2);
  const byId = new Map(items.map((item) => [item.id, item]));
  closeTo(byId.get(negative.id).score, byId.get(positive.id).score, 1e-12,
    '情感坐标相反的两条记忆，得分必须完全一致——它们不参与打分');
  for (const item of items) {
    assert.equal('valence' in item.why, false, 'why 里不许出现 valence（否则等于进了公式）');
    assert.equal('arousal' in item.why, false);
    closeTo(
      item.score,
      0.40 * item.why.relevance + 0.25 * item.why.freshness + 0.25 * item.why.importance
        - 0.10 * item.why.penalty,
      1e-12,
      '四因子手工复算仍成立',
    );
  }
  memory.close();
});

test('export：JSONL 可回读（字段对齐，重新沉淀后能召回）', () => {
  const source = makeMemory('export-source');
  const originals = [
    source.memory.remember({ content: '主人住在杭州', kind: 'fact', entities: ['杭州'] }).memory,
    source.memory.remember({ content: '主人讨厌香菜', kind: 'preference', importance: 4 }).memory,
    source.memory.remember({ content: '昨天一起看了芙莉莲', kind: 'episode' }).memory,
  ];

  const text = source.memory.export();
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(text.endsWith('\n'), 'JSONL 应以换行收尾');
  const parsed = lines.map((line) => JSON.parse(line));
  for (const key of ['id', 'kind', 'content', 'entities', 'importance', 'confidence',
    'createdAt', 'updatedAt', 'recallCount', 'archived']) {
    assert.ok(key in parsed[0], `导出行缺 ${key}`);
  }
  assert.deepEqual(parsed.map((row) => row.content), originals.map((row) => row.content));
  source.memory.close();

  // 回读：另一套 POND_HOME 里逐行重新沉淀，再按内容前两字召回
  const target = makeMemory('export-target');
  for (const row of parsed) {
    const result = target.memory.remember({
      content: row.content,
      kind: row.kind,
      entities: row.entities,
      importance: row.importance,
      confidence: row.confidence,
      source: row.source,
      sourceRef: row.sourceRef,
      ttlDays: row.ttlDays,
      force: true,
    });
    assert.equal(result.recorded, true, `${row.content} 回读失败`);
  }
  for (const row of parsed) {
    const hits = target.memory.recall(row.content.slice(0, 2), { minScore: 0 });
    assert.ok(hits.some((item) => item.content === row.content && item.kind === row.kind),
      `${row.content} 回读后召不回来`);
  }
  target.memory.close();
});

test('export：空库返回空串', () => {
  const { memory } = makeMemory('export-empty');
  assert.equal(memory.export(), '');
  memory.close();
});

/* ------------------------------------------------------------------ *
 * 8. 降级链与失败路径
 * ------------------------------------------------------------------ */

test('降级链：sqlite 打不开 → 易失后端顶上，降级写进事件流（degradedFrom=sqlite）', () => {
  const home = makeHome('degrade-open');
  fs.mkdirSync(path.join(home, 'memory.db')); // 用目录占住库路径 → sqlite 必打不开

  const warns = [];
  const memory = createMemory({ env: envFor(home), warn: (m) => warns.push(String(m)) });
  assert.equal(memory.mode, 'memory-volatile', 'sqlite 打不开必须降级到易失后端');

  const result = memory.remember({ content: '主人讨厌香菜', kind: 'preference' });
  assert.equal(result.recorded, true, '降级后沉淀必须照常工作');
  const hits = memory.recall('香菜', { minScore: 0 });
  assert.equal(hits.length, 1, '降级后召回必须照常工作');

  const events = eventsOf(home);
  const openEvents = events.filter((event) => event.op === 'open');
  assert.equal(openEvents.length, 2, '降级要记两条尝试：失败的 sqlite + 接手的 volatile');
  assert.equal(openEvents[0].provider, 'sqlite');
  assert.equal(openEvents[0].ok, false);
  assert.equal(openEvents[0].errorCategory, 'storage');
  assert.equal(openEvents[1].provider, 'memory-volatile');
  assert.equal(openEvents[1].ok, true);
  assert.equal(openEvents[1].degradedFrom, 'sqlite');
  assert.equal(events.at(-1).provider, 'memory-volatile', '降级后的能力事件也要记账');
  memory.close();
});

test('降级链：POND_HOME 指到文件上 → 不炸，易失后端照常工作（事件失败只 warn）', () => {
  const homeFile = path.join(TEMP_ROOT, 'home-is-a-file');
  fs.writeFileSync(homeFile, 'not a directory');

  const warns = [];
  const memory = createMemory({ env: envFor(homeFile), warn: (m) => warns.push(String(m)) });
  assert.equal(memory.mode, 'memory-volatile');

  const result = memory.remember({ content: '主人住在杭州', kind: 'fact' });
  assert.equal(result.recorded, true);
  assert.equal(memory.recall('杭州', { minScore: 0 }).length, 1);
  assert.ok(warns.some((message) => message.includes('事件写入失败') || message.includes('事件')),
    '事件写失败必须 warn 但不影响结果');
  memory.close();
});

test('失败路径：事件写不进去也不影响记忆结果（只 warn）', () => {
  const home = makeHome('events-broken');
  fs.mkdirSync(path.join(home, 'events.jsonl')); // 用目录占住事件文件 → append 必失败

  const warns = [];
  const memory = createMemory({ env: envFor(home), warn: (m) => warns.push(String(m)) });
  const result = memory.remember({ content: '主人讨厌香菜', kind: 'preference' });
  assert.equal(result.recorded, true, '记账失败不许影响沉淀');
  assert.equal(memory.recall('香菜', { minScore: 0 }).length, 1);
  assert.ok(warns.some((message) => message.includes('事件写入失败')), '事件失败必须有 warn');
  memory.close();
});

test('失败路径：存储不可用时 remember 不炸，返回 storage-error 并记 ok:false 事件', () => {
  const { memory, home } = makeMemory('storage-error');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });
  dropFts(home); // 自愈能救 FTS——先证明它救不了主表
  const db = new DatabaseSync(path.join(home, 'memory.db'));
  db.exec('DROP TABLE memories');
  db.exec('DROP TRIGGER IF EXISTS memories_fts_ai');
  db.exec('DROP TRIGGER IF EXISTS memories_fts_ad');
  db.exec('DROP TRIGGER IF EXISTS memories_fts_au');
  db.exec('DROP TABLE IF EXISTS memories_fts');
  db.close();

  const result = memory.remember({ content: '新事实', kind: 'fact' });
  assert.equal(result.recorded, false);
  assert.equal(result.action, 'rejected');
  assert.equal(result.reason, 'storage-error');

  const last = eventsOf(home).at(-1);
  assert.equal(last.op, 'remember');
  assert.equal(last.ok, false, '存储坏了必须在事件流里是失败尝试');
  assert.equal(last.errorCategory, 'storage');
  memory.close();
});

test('降级链·FTS 索引坏了：召回退化成扫描（retrieval=scan，相关度封顶 0.5），写入自愈', () => {
  const { memory, home } = makeMemory('fts-degrade');
  memory.remember({ content: '主人讨厌香菜', kind: 'preference', importance: 4 });
  memory.remember({ content: '主人住在杭州', kind: 'fact' });
  dropFts(home);

  const scanned = memory.recall('香菜', { minScore: 0 });
  assert.equal(scanned[0].why.retrieval, 'scan', 'FTS 坏了必须退化成扫描而不是抛错');
  closeTo(scanned[0].why.relevance, SCAN_RELEVANCE_CAP, 1e-9, '扫描命中给固定中性相关度');
  assert.ok(scanned[0].why.relevance <= SCAN_RELEVANCE_CAP);

  // 自愈：一次写入把索引重建回来，召回恢复 BM25
  const healed = memory.remember({ content: '主人养了一条鱼', kind: 'fact' });
  assert.equal(healed.recorded, true, 'FTS 坏掉不许挡住沉淀（写路径自愈）');
  const after = memory.recall('鱼', { minScore: 0 });
  assert.equal(after[0].why.retrieval, 'fts', '自愈后必须恢复 FTS 召回');
  assert.ok(after[0].why.relevance > 0);
  memory.close();
});

test('失败路径：编程错误抛 TypeError，不伪装成能力不可用', () => {
  const { memory } = makeMemory('type-errors');
  assert.throws(() => memory.remember({ kind: 'fact' }), TypeError);
  assert.throws(() => memory.recall(['杭州']), TypeError);
  assert.throws(() => memory.forget(1.5), TypeError);
  memory.close();
});

/* ------------------------------------------------------------------ *
 * 9. 事件流（层间接缝）
 * ------------------------------------------------------------------ */

test('事件流：每次操作一行，八字段为前缀，units=记忆条数', () => {
  const { memory, home } = makeMemory('events-units');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });          // created → 1
  memory.remember({ content: '主人住在杭州市', kind: 'fact' });          // merged → 1
  memory.remember('嗯嗯');                                              // rejected → 0
  memory.recall('杭州');                                                // 命中 1 条 → 1
  memory.forget(1);                                                     // archived → 1
  memory.forget(12345);                                                 // missing → 0
  memory.export();                                                      // 0 条 → 0

  const events = eventsOf(home).filter((event) => event.capability === 'memory');
  for (const event of events) {
    assert.deepEqual(Object.keys(event).slice(0, EVENT_FIELDS.length), [...EVENT_FIELDS],
      '必备八字段必须是前缀且顺序不变');
    assert.equal(typeof event.op, 'string');
    assert.equal(typeof event.action, 'string');
    assert.ok(Array.isArray(event.gatesSkipped));
    assert.equal(event.costEstimate, 0, '本地记忆成本恒 0');
    assert.equal(event.provider, 'sqlite');
  }

  const byOp = (op, action) => events.find((event) => event.op === op && event.action === action);
  assert.equal(byOp('remember', 'created').units, 1);
  assert.equal(byOp('remember', 'merged').units, 1);
  assert.equal(byOp('remember', 'rejected').units, 0);
  assert.equal(byOp('recall', 'recalled').units, 1);
  assert.equal(byOp('forget', 'archived').units, 1);
  assert.equal(byOp('forget', 'missing').units, 0);
  assert.equal(byOp('export', 'exported').units, 0);
  memory.close();
});

test('事件流：能力层写盘不越 POND_HOME（目录里只有库和事件两个文件）', () => {
  const { memory, home } = makeMemory('events-containment');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });
  memory.recall('杭州');
  memory.export();
  memory.close();

  assert.deepEqual(fs.readdirSync(home).sort(), ['events.jsonl', 'memory.db']);
});

/* ------------------------------------------------------------------ *
 * 10. 红线守卫：src/memory 不许碰网络
 * ------------------------------------------------------------------ */

/** 扫一份源码文本：网络模块 import / fetch 调用 / WebSocket 创建。 */
function networkViolations(text) {
  const violations = [];
  for (const spec of ['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls']) {
    const pattern = new RegExp(`['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'u');
    if (pattern.test(text)) violations.push(`import 了 ${spec}`);
  }
  if (/\bfetch\s*\(/u.test(text)) violations.push('调用了 fetch()');
  if (/\bnew\s+WebSocket\s*\(/u.test(text)) violations.push('创建了 WebSocket');
  return violations;
}

test('红线·src/memory 不 import 任何网络模块、不 fetch（守卫自带金丝雀）', () => {
  // 金丝雀：守卫必须真的有牙——这些样本必须被查出来
  assert.ok(networkViolations(`import x from 'node:http';`).length > 0, '守卫查不出 node:http');
  assert.ok(networkViolations(`const y = await fetch('https://x');`).length > 0, '守卫查不出 fetch');
  assert.ok(networkViolations(`new WebSocket('ws://x')`).length > 0, '守卫查不出 WebSocket');

  const dir = path.join(ROOT, 'src', 'memory');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length >= 5, 'src/memory 的源码文件数不对，守卫可能没扫到东西');

  const violations = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const violation of networkViolations(text)) violations.push(`${name}: ${violation}`);
    assert.ok(!text.includes('fetch('), `${name} 含 fetch( 调用形态`);
  }
  assert.deepEqual(violations, [], `src/memory 出现网络能力：\n${violations.join('\n')}`);

  // 反向金丝雀：store.mjs 确实引用了 node:sqlite，证明扫描读的是真文件
  const store = fs.readFileSync(path.join(dir, 'store.mjs'), 'utf8');
  assert.ok(store.includes('node:sqlite'), 'store.mjs 没引用 node:sqlite——守卫读的可能不是真文件');
});

/* ------------------------------------------------------------------ *
 * 11. 便捷入口与纯函数
 * ------------------------------------------------------------------ */

test('便捷入口：remember / recall / forget / purge / setImportance / quota / exportMemories 一次性函数可用', () => {
  const home = makeHome('wrappers');
  const options = { env: envFor(home) };

  const result = remember({ content: '主人讨厌香菜', kind: 'preference' }, options);
  assert.equal(result.recorded, true);

  const hits = recall('香菜', { ...options, minScore: 0 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'preference');
  assert.equal(recall('香菜', { ...options, minScore: 0, withMeta: true }).degraded,
    false, '一次性入口也要如实说「这次没降级」');

  const text = exportMemories(options);
  assert.equal(text.trim().split('\n').length, 1);

  // 配额：preference 默认 4 分；升到 5 分后占一个名额，purge 后释放
  assert.equal(importanceQuota(options).used, 0);
  const promoted = setImportance(result.id, 5, options);
  assert.equal(promoted.updated, true);
  assert.equal(importanceQuota(options).used, 1);

  const gone = forget(result.id, options);
  assert.equal(gone.forgotten, true);
  assert.equal(gone.archived, true);
  assert.equal(exportMemories(options), '');

  const purged = purge(result.id, options);
  assert.equal(purged.purged, true);
  assert.equal(purged.deleted.id, result.id);
  assert.equal(importanceQuota(options).used, 0);
  assert.equal(exportMemories(options), '');
});

test('纯函数：新鲜度按真半衰 0.5^(days/halfLife)（days=halfLife 时恰好减半）', () => {
  // 队长裁定：半衰期必须真的是「减半」。
  // 原实现照抄 SPEC 的 exp(-days/halfLife)，一个 halfLife 处是 1/e ≈ 0.368，
  // 按它算「365 天半衰期」实际 253 天就减半了 —— 名字与行为不符。
  // 改成 0.5^(days/halfLife)：一个 halfLife 恰好 0.5。
  closeTo(freshnessFactor(365, 365), 0.5, 1e-9, '一个 halfLife 恰好减半');
  closeTo(freshnessFactor(730, 365), 0.25, 1e-9, '两个 halfLife 剩四分之一');
  closeTo(freshnessFactor(0, 365), 1, 1e-9, '当天');
  closeTo(freshnessFactor(-5, 365), 1, 1e-9, '未来时间按 0 天算');
  closeTo(freshnessFactor(45, 45), 0.5, 1e-9, 'episode 的 halfLife 45 天');
  closeTo(importanceFactor(5), 1, 1e-9);
  closeTo(importanceFactor(1), 0.2, 1e-9);
  closeTo(penaltyFactor(5), 0.5, 1e-9);
  closeTo(penaltyFactor(20), 1, 1e-9, '惩罚封顶');
  closeTo(combineScore({ relevance: 1, freshness: 1, importance: 1, penalty: 0 }), 0.9, 1e-9);
});

test('纯函数：半衰期按 kind，ttl_days 覆盖优先', () => {
  assert.equal(halfLifeDaysFor({ kind: 'fact' }), 365);
  assert.equal(halfLifeDaysFor({ kind: 'preference' }), 180);
  assert.equal(halfLifeDaysFor({ kind: 'episode' }), 45);
  assert.equal(halfLifeDaysFor({ kind: 'fact', ttlDays: 7 }), 7);
  assert.deepEqual([...KINDS], ['fact', 'preference', 'episode', 'relation']);
  assert.deepEqual({ ...KIND_HALF_LIFE_DAYS }, {
    fact: 365, preference: 180, episode: 45, relation: 365,
  });
});

test('纯函数：CJK 二元切分——索引带 unigram，查询只给 bigram（单字除外）', () => {
  assert.deepEqual(queryTokens('主人住在杭州'), ['主人', '人住', '住在', '在杭', '杭州']);
  assert.deepEqual(queryTokens('杭'), ['杭']);
  assert.deepEqual(queryTokens('Edge TTS'), ['edge', 'tts']);
  assert.deepEqual(queryTokens('杭州 Edge'), ['杭州', 'edge']);
  assert.deepEqual(
    [...segmentText('主人').split(' ')].sort(),
    ['主', '人', '主人'].sort(),
    '索引侧必须 unigram + bigram 都有',
  );
  assert.ok(segmentText('主人住在杭州').includes('杭州'), '索引侧必须有 bigram');
  assert.ok(segmentText('主人住在杭州').includes('主 '), '索引侧必须有 unigram');
});

test('纯函数：BM25 归一化到 0..1，无命中为 0', () => {
  const normalized = normalizeRelevance(new Map([[1, 2], [2, 1], [3, 0]]));
  closeTo(normalized.get(1), 1, 1e-9);
  closeTo(normalized.get(2), 0.5, 1e-9);
  closeTo(normalized.get(3), 0, 1e-9);
  assert.equal(normalizeRelevance(new Map()).size, 0, '没有命中就没有相关度');
  assert.equal(normalizeRelevance(new Map([[1, -3]])).get(1) ?? 0, 0, '非正原始分归一化后是 0');
});

/* ------------------------------------------------------------------ *
 * 12. ② importance=5 配额（重要的东西必须稀缺）
 * ------------------------------------------------------------------ */

/** 填满 importance=5 的配额，返回写入的 id 列表。 */
function fillTopQuota(memory, label = '顶格事项') {
  const ids = [];
  for (let i = 0; i < MAX_TOP_IMPORTANCE_ENTRIES; i += 1) {
    const result = memory.remember({
      content: `${label}${i}`,
      kind: 'fact',
      importance: 5,
      force: true, // 内容近似，force 避免被闸二合并掉
    });
    assert.equal(result.recorded, true, `第 ${i + 1} 条 5 分记忆应当能写进去`);
    ids.push(result.id);
  }
  return ids;
}

test('② importance=5 配额：写满 20 条后第 21 条被拒，带清单且不静默降级成 4 分', () => {
  const { memory, home } = makeMemory('quota-full');
  const ids = fillTopQuota(memory);

  const quota = memory.importanceQuota();
  assert.equal(quota.importance, 5);
  assert.equal(quota.limit, MAX_TOP_IMPORTANCE_ENTRIES);
  assert.equal(quota.used, MAX_TOP_IMPORTANCE_ENTRIES);
  assert.equal(quota.remaining, 0);
  assert.equal(quota.entries.length, MAX_TOP_IMPORTANCE_ENTRIES);
  for (const entry of quota.entries) {
    assert.equal(typeof entry.id, 'number');
    assert.equal(typeof entry.content, 'string', '清单要带 id + content 摘要');
    assert.ok(entry.content.length <= 41, '清单里的 content 是摘要，不是整条正文');
  }

  const rejected = memory.remember({
    content: '再来一条顶格事项', kind: 'fact', importance: 5, force: true,
  });
  assert.equal(rejected.recorded, false);
  assert.equal(rejected.action, 'rejected');
  assert.equal(rejected.reason, 'importance-quota-full', '理由必须明确是配额满');
  assert.equal(rejected.id, null);
  assert.equal(rejected.quota.used, MAX_TOP_IMPORTANCE_ENTRIES);
  assert.equal(rejected.quota.limit, MAX_TOP_IMPORTANCE_ENTRIES);
  assert.deepEqual(rejected.quota.entries.map((entry) => entry.id), ids,
    '被拒时要告诉调用方是谁占满了配额');
  assert.equal(rejected.gates.quota.limited, true);
  assert.equal(rejected.gates.importance.rejected, true);

  // 不静默降级：库里绝对不能多出一条 importance=4 的「再来一条顶格事项」
  const rows = memory.export().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, MAX_TOP_IMPORTANCE_ENTRIES, '被拒的候选不许偷偷落库');
  assert.equal(rows.some((row) => row.content === '再来一条顶格事项'), false);
  assert.equal(rows.every((row) => row.importance === 5), true, '也不许降成 4 分落库');

  const last = lastEventOf(home, 'remember');
  assert.equal(last.action, 'rejected');
  assert.equal(last.reason, 'importance-quota-full');
  assert.equal(last.units, 0);
  memory.close();
});

test('② 配额只针对 5 分：4 分与 5 分可以随便写，合并进已有的 5 分不占新名额', () => {
  const { memory } = makeMemory('quota-scope');
  const ids = fillTopQuota(memory);

  const four = memory.remember({ content: '一般重要性的事项', kind: 'fact', importance: 4 });
  assert.equal(four.recorded, true, '配额满不许影响 4 分条目');
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES);

  // 合并到一条已经是 5 分的记忆：不新增名额，因此不受配额限制
  const merged = memory.remember({ content: '顶格事项0呀', kind: 'fact', importance: 5, force: false });
  assert.equal(merged.action, 'merged', '近似内容应当合并到已有的 5 分条目');
  assert.equal(merged.recorded, true, '合并保持 5 分不占新名额，不该被配额挡住');
  assert.equal(merged.id, ids[0]);
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES);
  memory.close();
});

test('② 腾位之后能再写：setImportance 降级 / purge 均释放名额，归档的也不占名额', () => {
  const { memory } = makeMemory('quota-release');
  const ids = fillTopQuota(memory);
  const candidate = () => memory.remember({
    content: '腾位后的顶格事项', kind: 'fact', importance: 5, force: true,
  });

  assert.equal(candidate().reason, 'importance-quota-full');

  // ① 降级：5 → 3，腾出一个名额
  const demoted = memory.setImportance(ids[0], 3);
  assert.equal(demoted.updated, true);
  assert.equal(demoted.importance, 3);
  assert.equal(demoted.reason, null);
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES - 1);
  const afterDemote = candidate();
  assert.equal(afterDemote.recorded, true, '降级之后必须能再写 5 分条目');
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES);

  // ② purge：真删也腾位
  const purged = memory.purge(ids[1]);
  assert.equal(purged.purged, true);
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES - 1);
  assert.equal(memory.remember({
    content: '再次腾位后的顶格事项', kind: 'fact', importance: 5, force: true,
  }).recorded, true);
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES);

  // ③ 归档不占名额：淡出的东西不该继续占着稀缺位
  memory.forget(ids[2]);
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES - 1);
  assert.equal(memory.remember({
    content: '归档腾位后的顶格事项', kind: 'fact', importance: 5, force: true,
  }).recorded, true);

  // 升回 5 也受同一道闸：名额满了就拒绝，不静默成功
  assert.equal(memory.importanceQuota().used, MAX_TOP_IMPORTANCE_ENTRIES);
  const promote = memory.setImportance(ids[0], 5);
  assert.equal(promote.updated, false);
  assert.equal(promote.reason, 'importance-quota-full');
  assert.equal(promote.quota.used, MAX_TOP_IMPORTANCE_ENTRIES);

  // 非法入参是编程错误
  assert.throws(() => memory.setImportance(ids[4], 6), TypeError);
  assert.throws(() => memory.setImportance(ids[4], 0), TypeError);
  assert.throws(() => memory.setImportance(ids[4], '5'), TypeError);
  assert.equal(memory.setImportance(99999, 3).reason, 'missing');
  memory.close();
});

test('② 配额常量与实现同源：IMPORTANCE_QUOTA 与实测行为一致', () => {
  assert.deepEqual({ ...IMPORTANCE_QUOTA }, { importance: 5, limit: MAX_TOP_IMPORTANCE_ENTRIES });
  assert.equal(MAX_TOP_IMPORTANCE_ENTRIES, 20, '建议值 20：太多就不稀缺了');
});

/* ------------------------------------------------------------------ *
 * 13. ④ 召回降级说细（这次到底缺了哪一段通道）
 * ------------------------------------------------------------------ */

test('④ 降级细分·FTS 正常 = 当前能力的完整召回（不报降级，但 channels 如实声明）', () => {
  const { memory, home } = makeMemory('degrade-detail-fts');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });

  const items = memory.recall('杭州', { minScore: 0 });
  assert.ok(Array.isArray(items), '返回类型仍是数组（老调用方不受影响）');

  // 队长裁定：v0.2.1 压根没有向量通道，keyword 就是它的全部能力，
  // 不是「退而求其次」。降级必须意味着「本来能更好但有东西坏了」。
  assert.equal(items.degraded, false, 'FTS 正常工作时不许报降级');
  assert.equal(items.degradation, null, '完整召回时 degradation 必须是 null');

  // 但「我用了哪个通道」要如实说 —— 这是能力声明，不是降级判断
  assert.deepEqual({ ...items.channels }, { keyword: 'fts', semantic: false });

  // 元信息挂在数组上但不污染数组本身
  assert.equal(Object.keys(items).includes('degradation'), false, '元信息必须是非枚举的');
  assert.equal('degradation' in items, true, '但调用方要能读到');

  const meta = memory.recall('杭州', { minScore: 0, withMeta: true });
  assert.ok(Array.isArray(meta.items));
  assert.equal(meta.degraded, false);
  assert.equal(meta.degradation, null);
  assert.deepEqual({ ...meta.channels }, { keyword: 'fts', semantic: false });

  const event = lastEventOf(home, 'recall');
  assert.equal(event.retrieval, 'fts');
  // 事件流的 degradationChannel 只在真降级时有值；正常路径是 null
  // 「那次用了哪个通道」由 retrieval 字段回答
  assert.equal(event.degradationChannel, null, 'FTS 正常时不该记降级通道');
  memory.close();
});

test('④ 降级细分·FTS 坏了：channel=fts-unavailable；易失后端：channel=scan-fallback', () => {
  // FTS 索引坏掉（主表还在）
  const broken = makeMemory('degrade-detail-fts-broken');
  broken.memory.remember({ content: '主人讨厌香菜', kind: 'preference' });
  dropFts(broken.home);
  const scanned = broken.memory.recall('香菜', { minScore: 0 });
  assert.equal(scanned[0].why.retrieval, 'scan');
  assert.equal(scanned.degradation.channel, 'fts-unavailable');
  assert.match(scanned.degradation.reason, /FTS/u);
  assert.deepEqual({ ...scanned.channels }, { keyword: 'scan', semantic: false });
  assert.equal(lastEventOf(broken.home, 'recall').degradationChannel, 'fts-unavailable');
  broken.memory.close();

  // sqlite 都打不开 → 易失后端（它没有 FTS，只能扫描）
  const home = makeHome('degrade-detail-volatile');
  fs.mkdirSync(path.join(home, 'memory.db'));
  const volatile = createMemory({ env: envFor(home), warn: () => {} });
  assert.equal(volatile.mode, 'memory-volatile');
  volatile.remember({ content: '主人住在杭州', kind: 'fact' });
  const items = volatile.recall('杭州', { minScore: 0 });
  assert.equal(items.degradation.channel, 'scan-fallback');
  assert.deepEqual({ ...items.channels }, { keyword: 'scan', semantic: false });
  assert.equal(lastEventOf(home, 'recall').degradationChannel, 'scan-fallback');
  volatile.close();
});

test('④ 空查询也是正常路径（degradation=null），只有真坏了才算降级', () => {
  const { memory } = makeMemory('degrade-detail-empty');
  memory.remember({ content: '主人住在杭州', kind: 'fact' });

  const emptyQuery = memory.recall('', { minScore: 0 });
  assert.equal(emptyQuery.length, 1, '空查询仍按新鲜度/重要性返回');
  // 空查询是设计内的正常路径：按时间/重要性排序，不涉及检索通道
  assert.equal(emptyQuery.degraded, false);
  assert.equal(emptyQuery.degradation, null);
  assert.deepEqual({ ...emptyQuery.channels }, { keyword: 'none', semantic: false });

  // 三种通道都在枚举里；null（完整召回）只留给将来的「语义 + 关键词」双通道
  for (const channel of DEGRADATION_CHANNELS) {
    assert.equal(typeof channel, 'string');
  }
  assert.deepEqual([...DEGRADATION_CHANNELS], ['keyword-only', 'fts-unavailable', 'scan-fallback']);
  memory.close();
});
