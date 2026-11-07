/**
 * pond-check · 能力层 C3：加权唤醒的候选池、权重与解释（src/wake/weights.mjs）
 *
 * CAPABILITIES-SPEC §3.5 —— **不是随机，是加权随机**。纯随机会让她今天提三次猫、
 * 明天一次不提；加权随机让「重要的事」和「很久没提的事」自然浮上来。
 *
 * 候选池（四条同时满足）：
 *   - importance >= 3
 *   - archived = 0
 *   - 距 last_recalled 至少 24h（从没提过 = 满足）
 *   - 半衰期内：now − created_at < halfLife × 2（ttl_days 可覆盖 halfLife）
 *
 * 权重：
 *   weight   = importance² × recency × silence
 *   recency  = 0.5^(daysSinceCreated / halfLife)   // 与记忆层 freshnessFactor 同源
 *   silence  = min(1, daysSinceRecalled / 7)
 *
 * importance² 是这一层最关键的形状：5 分记忆的权重是 3 分的 25:9 ≈ 2.78 倍，
 * 而不是线性版本的 5:3 ≈ 1.67 倍。把这个平方改成一次方，排序会明显变钝，
 * tests/wake.test.mjs 里有一条**卡在 0.70 阈值上的确定性用例**专门抓它。
 *
 * reason 必须能说人话（SPEC：「重要且 9 天未提」）——权重不是黑盒，
 * 用户得知道她为什么突然提起这件事。
 *
 * 硬约束：纯函数、不联网、不写盘、零依赖（halfLifeDaysFor 来自记忆层常量，
 * 半衰期只有一套口径，不在唤醒层另抄一遍）。
 */

import { freshnessFactor, halfLifeDaysFor } from '../memory/index.mjs';

/** 一小时的毫秒数。 */
export const HOUR_MS = 60 * 60 * 1000;

/** 一天的毫秒数。 */
export const DAY_MS = 24 * HOUR_MS;

/** 公式原文（进返回值 / 事件 / 测试，调试的人不用翻文档）。 */
export const WEIGHT_FORMULA = 'weight = importance² × recency × silence';
export const RECENCY_FORMULA = 'recency = 0.5^(daysSinceCreated / halfLife)';
export const SILENCE_FORMULA = 'silence = min(1, daysSinceRecalled / 7)';

/**
 * 唤醒默认参数（SPEC §3.5）。每一项都可以被 `limits` 覆盖（测试与上层调参用），
 * 但**默认值就是规格值**，不在别处另写一套数字。
 */
export const WAKE_DEFAULTS = Object.freeze({
  /** 每日唤醒上限（次）。 */
  dailyLimit: 3,
  /** 两次唤醒的最小间隔（小时）。 */
  minIntervalHours: 4,
  /** 同一 kind 每日上限（次）。 */
  perKindDailyLimit: 2,
  /** 候选池的重要性下限（含）。 */
  minImportance: 3,
  /** 距上次被提至少多少小时（含）。 */
  minSilenceHours: 24,
  /** 候选池年龄上限 = 半衰期 × 这个倍数（不含）。 */
  maxAgeHalfLives: 2,
  /** silence 达到 1 所需的天数。 */
  silenceDaysForFull: 7,
  /** schedule 扫描时间槽的步长（分钟）。 */
  scheduleStepMinutes: 15,
});

/** 所有可调参数名（拼错参数名直接抛，不静默忽略）。 */
export const WAKE_LIMIT_KEYS = Object.freeze(Object.keys(WAKE_DEFAULTS));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertFiniteNumber(value, label, { min = -Infinity, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} 必须是有限数字，收到 ${JSON.stringify(value)}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new TypeError(`${label} 必须是整数，收到 ${JSON.stringify(value)}`);
  }
  if (value < min) {
    throw new TypeError(`${label} 必须 >= ${min}，收到 ${JSON.stringify(value)}`);
  }
}

/**
 * 合并 / 校验唤醒参数。未知键与畸形值都是**编程错误**，直接抛 TypeError
 * （不把「参数拼错了」伪装成「今天不适合唤醒」这种能力级失败）。
 *
 * @param {object|null|undefined} overrides
 * @returns {{dailyLimit:number,minIntervalHours:number,perKindDailyLimit:number,
 *            minImportance:number,minSilenceHours:number,maxAgeHalfLives:number,
 *            silenceDaysForFull:number,scheduleStepMinutes:number}}
 */
export function normalizeLimits(overrides = {}) {
  if (overrides === undefined || overrides === null) overrides = {};
  if (!isPlainObject(overrides)) {
    throw new TypeError(`唤醒参数必须是对象，收到 ${JSON.stringify(overrides)}`);
  }
  const unknown = Object.keys(overrides).filter((key) => !WAKE_LIMIT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`未知的唤醒参数：${unknown.join(', ')}（可用：${WAKE_LIMIT_KEYS.join(', ')}）`);
  }
  const merged = { ...WAKE_DEFAULTS, ...overrides };
  assertFiniteNumber(merged.dailyLimit, 'dailyLimit', { min: 0, integer: true });
  assertFiniteNumber(merged.perKindDailyLimit, 'perKindDailyLimit', { min: 0, integer: true });
  assertFiniteNumber(merged.minIntervalHours, 'minIntervalHours', { min: 0 });
  assertFiniteNumber(merged.minImportance, 'minImportance', { min: 1, integer: true });
  if (merged.minImportance > 5) {
    throw new TypeError(`minImportance 必须 <= 5，收到 ${merged.minImportance}`);
  }
  assertFiniteNumber(merged.minSilenceHours, 'minSilenceHours', { min: 0 });
  assertFiniteNumber(merged.maxAgeHalfLives, 'maxAgeHalfLives', { min: 0 });
  assertFiniteNumber(merged.silenceDaysForFull, 'silenceDaysForFull', { min: 1 });
  assertFiniteNumber(merged.scheduleStepMinutes, 'scheduleStepMinutes', { min: 1 });
  return merged;
}

/**
 * 在已有参数上叠加覆盖项。
 * @param {object} base 已 normalize 的参数
 * @param {object} overrides
 */
export function mergeLimits(base, overrides = {}) {
  return normalizeLimits({ ...base, ...(overrides ?? {}) });
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * 一条记忆的权重分项。未来时间戳按 0 天算（时钟漂移不许算出负天数或 >1 的分数）。
 *
 * @param {object} row 记忆行（camelCase，见 src/memory/store.mjs）
 * @param {number} now epoch ms
 * @param {object} [limits] normalizeLimits 的结果（只用 silenceDaysForFull）
 * @returns {{weight:number, importance:number, halfLifeDays:number,
 *            daysSinceCreated:number, daysSinceRecalled:number|null,
 *            recency:number, silence:number}}
 */
export function computeWeight(row, now, limits = WAKE_DEFAULTS) {
  const nowMs = Number(now);
  const importanceRaw = Number(row?.importance);
  const importance = Number.isFinite(importanceRaw) ? Math.max(0, importanceRaw) : 0;
  const halfLifeDays = halfLifeDaysFor(row ?? {});

  const createdAt = finiteOrNull(row?.createdAt);
  const daysSinceCreated = createdAt === null
    ? Infinity
    : Math.max(0, (nowMs - createdAt) / DAY_MS);
  // 新鲜度直接复用记忆层的 freshnessFactor（C2 已把它修成真半衰：0.5^(days/halfLife)）。
  // 唤醒层不自己抄一份衰减公式——半衰期只有一套口径，改一处就够。
  const recency = Number.isFinite(daysSinceCreated)
    ? freshnessFactor(daysSinceCreated, halfLifeDays)
    : 0;

  const lastRecalled = finiteOrNull(row?.lastRecalled);
  const daysSinceRecalled = lastRecalled === null
    ? null
    : Math.max(0, (nowMs - lastRecalled) / DAY_MS);
  const silenceDays = Number(limits?.silenceDaysForFull) > 0
    ? Number(limits.silenceDaysForFull)
    : WAKE_DEFAULTS.silenceDaysForFull;
  // 从没提过 = 沉默到顶（1），不是 0 —— 否则最该被提起的事反而永远选不上。
  const silence = daysSinceRecalled === null ? 1 : Math.min(1, daysSinceRecalled / silenceDays);

  // importance² —— 见文件头：这不是笔误，也不是可以「优化」成 importance 的地方。
  const weight = importance ** 2 * recency * silence;

  return { weight, importance, halfLifeDays, daysSinceCreated, daysSinceRecalled, recency, silence };
}

/**
 * 把分数翻译成人话：「重要（5 分）且 9 天未提」。
 * @param {{importance:number, daysSinceRecalled:number|null}} candidate
 * @returns {string}
 */
export function buildReason(candidate) {
  const importance = Number(candidate?.importance);
  const importanceText = Number.isFinite(importance) ? importance : 0;
  const days = candidate?.daysSinceRecalled;
  if (days === null || days === undefined) {
    return `重要（${importanceText} 分）且从未提过`;
  }
  // 候选池已保证 >= 24h；floor 后至少 1 天，不会出现「0 天未提」。
  return `重要（${importanceText} 分）且 ${Math.floor(days)} 天未提`;
}

/**
 * 单条记忆在某个时刻的池子状态。候选池过滤只在这里实现一次 ——
 * candidatePool 与 nextEligibleAt（schedule 用）共用同一套判定，避免两处漂移。
 *
 * @param {object} row
 * @param {number} now
 * @param {object} [limits]
 * @param {Record<string, number>} [kindCounts]
 * @returns {{status:'candidate'|'archived'|'low-importance'|'recently-recalled'|'expired'|'kind-limit'|'invalid',
 *            halfLifeDays?: number}}
 */
export function classifyRow(row, now, limits = WAKE_DEFAULTS, kindCounts = {}) {
  if (!row || typeof row !== 'object') return { status: 'invalid' };
  // 真值判断（不是 === true）：sqlite 原始行是 1/0，自定义 store 可能给 1 ——
  // 归档是「不许再提」的强约束，必须 fail-closed。
  if (row.archived) return { status: 'archived' };
  const importance = Number(row.importance);
  if (!Number.isFinite(importance) || importance < limits.minImportance) {
    return { status: 'low-importance' };
  }
  const nowMs = Number(now);
  const lastRecalled = finiteOrNull(row.lastRecalled);
  // 「距 last_recalled 至少 24h」：刚被提过的不许马上再提；从没提过的直接放行。
  if (lastRecalled !== null && nowMs - lastRecalled < limits.minSilenceHours * HOUR_MS) {
    return { status: 'recently-recalled' };
  }
  const createdAt = finiteOrNull(row.createdAt);
  const halfLifeDays = halfLifeDaysFor(row);
  // SPEC §3.5：now − created_at < halfLife × 2。相等就出池（半衰期外）。
  if (createdAt === null || !(nowMs - createdAt < halfLifeDays * limits.maxAgeHalfLives * DAY_MS)) {
    return { status: 'expired' };
  }
  if ((kindCounts[row.kind] ?? 0) >= limits.perKindDailyLimit) {
    return { status: 'kind-limit' };
  }
  return { status: 'candidate', halfLifeDays };
}

/**
 * 候选池过滤 + 权重计算。**唯一**决定「谁能被唤醒」的地方。
 *
 * @param {object[]} rows 记忆行（必须包含 archived 行，函数自己过滤）
 * @param {number} now epoch ms
 * @param {object} [limits] normalizeLimits 的结果
 * @param {{kindCounts?: Record<string, number>}} [options] 当天各 kind 已唤醒次数
 * @returns {{candidates: object[], filtered: {total:number,archived:number,lowImportance:number,
 *            recentlyRecalled:number,expired:number,kindLimit:number}}}
 */
export function candidatePool(rows, now, limits = WAKE_DEFAULTS, options = {}) {
  const kindCounts = isPlainObject(options.kindCounts) ? options.kindCounts : {};
  const filtered = {
    total: Array.isArray(rows) ? rows.length : 0,
    archived: 0,
    lowImportance: 0,
    recentlyRecalled: 0,
    expired: 0,
    kindLimit: 0,
  };
  const candidates = [];
  if (!Array.isArray(rows)) return { candidates, filtered };

  const nowMs = Number(now);
  for (const row of rows) {
    const verdict = classifyRow(row, nowMs, limits, kindCounts);
    if (verdict.status === 'archived') {
      filtered.archived += 1;
      continue;
    }
    if (verdict.status === 'low-importance' || verdict.status === 'invalid') {
      filtered.lowImportance += 1;
      continue;
    }
    if (verdict.status === 'recently-recalled') {
      filtered.recentlyRecalled += 1;
      continue;
    }
    if (verdict.status === 'expired') {
      filtered.expired += 1;
      continue;
    }
    if (verdict.status === 'kind-limit') {
      filtered.kindLimit += 1;
      continue;
    }

    const metrics = computeWeight(row, nowMs, limits);
    candidates.push({
      row,
      id: row.id,
      kind: row.kind,
      content: row.content,
      importance: metrics.importance,
      weight: metrics.weight,
      recency: metrics.recency,
      silence: metrics.silence,
      daysSinceCreated: metrics.daysSinceCreated,
      daysSinceRecalled: metrics.daysSinceRecalled,
      halfLifeDays: metrics.halfLifeDays,
      reason: buildReason(metrics),
    });
  }

  // 稳定顺序：同权时按 id 升序，random=0 的测试与「同分先提老记忆」都可预期。
  candidates.sort((a, b) => a.id - b.id);
  return { candidates, filtered };
}

/**
 * 所有「只是暂时太新」的记忆里，最早哪一刻会重新够格（last_recalled + 静默期）。
 * schedule 用它跳过空窗，而不是在每个空槽上空转或提前结束预排。
 *
 * @param {object[]} rows
 * @param {number} now
 * @param {object} [limits]
 * @param {{kindCounts?: Record<string, number>}} [options]
 * @returns {number|null} epoch ms；没有可等的记忆时返回 null
 */
export function nextEligibleAt(rows, now, limits = WAKE_DEFAULTS, options = {}) {
  if (!Array.isArray(rows)) return null;
  const kindCounts = isPlainObject(options.kindCounts) ? options.kindCounts : {};
  const nowMs = Number(now);
  const minSilenceMs = limits.minSilenceHours * HOUR_MS;
  let earliest = null;
  for (const row of rows) {
    if (classifyRow(row, nowMs, limits, kindCounts).status !== 'recently-recalled') continue;
    const readyAt = Number(row.lastRecalled) + minSilenceMs;
    if (!Number.isFinite(readyAt) || readyAt <= nowMs) continue;
    if (earliest === null || readyAt < earliest) earliest = readyAt;
  }
  return earliest;
}

/**
 * 候选池为空时给诊断层一个机器可读的原因。
 * @param {{total:number, archived:number, lowImportance:number, recentlyRecalled:number,
 *          expired:number, kindLimit:number}} filtered
 * @returns {'no-memories'|'kind-limit'|'no-candidates'}
 */
export function blockedReasonFor(filtered) {
  if (!filtered || filtered.total === 0) return 'no-memories';
  if (filtered.kindLimit > 0) return 'kind-limit';
  return 'no-candidates';
}

/**
 * 加权随机：权重越大的候选被选中的概率越高（不是均匀随机）。
 *
 * 用注入的 random 保证测试可确定：random()=0 取第一个、接近 1 取最后一个。
 * 不是「按权重排序取第一」——那样每天都是同一条，正是 SPEC 反对的伪随机。
 *
 * @param {object[]} candidates candidatePool 的输出
 * @param {() => number} [random] 0..1 的随机源
 * @returns {object|null}
 */
export function weightedPick(candidates, random = Math.random) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (typeof random !== 'function') {
    throw new TypeError('weightedPick 的 random 必须是函数');
  }
  let total = 0;
  for (const candidate of candidates) {
    const weight = Number(candidate?.weight);
    if (Number.isFinite(weight) && weight > 0) total += weight;
  }
  // 候选池里的 recency 恒 > 0（半衰期内），走不到这里；防御性兜底：
  // 权重全坏时返回 null（上层记为 empty-pool），不假装选中了谁。
  if (!(total > 0)) return null;

  const draw = random();
  if (typeof draw !== 'number' || !Number.isFinite(draw)) {
    throw new TypeError(`weightedPick 的 random 必须返回有限数字，收到 ${JSON.stringify(draw)}`);
  }
  // 容忍 random 返回 1（协议上 [0,1)）：钳到 [0,1)。
  const clamped = Math.min(1 - Number.EPSILON, Math.max(0, draw));
  let threshold = clamped * total;
  for (const candidate of candidates) {
    const weight = Number(candidate?.weight);
    if (!(Number.isFinite(weight) && weight > 0)) continue;
    threshold -= weight;
    if (threshold < 0) return candidate;
  }
  return candidates[candidates.length - 1];
}
