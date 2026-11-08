/**
 * pond-check · 能力层 C2：四因子召回打分（src/memory/scoring.mjs）
 *
 * CAPABILITIES-SPEC §3.4：召回不是单一排序，是四因子加权融合——
 *
 *   score = 0.40 × 相关度 + 0.25 × 新鲜度 + 0.25 × 重要性 − 0.10 × 重复惩罚
 *
 *   相关度   FTS5 BM25 归一化到 0..1；无关键词命中时为 0
 *   新鲜度   exp(-days / halfLife)，半衰期按 kind（fact 365 / preference 180 /
 *            episode 45，ttl_days 可覆盖）。days 距**上次更新**（updated_at）算：
 *            去重合并会刷新 updated_at，「同一件事的新版本」视作最新得知——
 *            这正是「合并而不是新增」的意义所在
 *   重要性   importance / 5
 *   重复惩罚 min(1, recall_count / 10)，被召回越多次权重越低
 *
 * 每条召回结果必须带 why 分项（scoring 的 buildWhy）——召回不能是黑盒，
 * 否则用户永远不知道她为什么突然提起三个月前的事。
 *
 * 降级口径（FTS 不可用 / 易失后端走扫描时）：没有 BM25 就不伪造 BM25——
 * 命中者给固定中性值 0.5 × 命中词占比，未命中为 0，why.retrieval 标 'scan'。
 *
 * **valence / arousal 不进这个文件（v0.2.1 明令）**：memories 表里确实存了这两个
 * 情感坐标（Russell 二维），但它们是**预留字段，只存不算分**——FACTOR_WEIGHTS 里
 * 没有、scoreRow 不读、why 里也不出现。要改这条规矩必须同时改 SPEC 与这里的公式，
 * 不许在打分函数里偷偷加一项。
 *
 * 硬约束：纯函数、不联网、不写盘、零依赖。
 */

import { halfLifeDaysFor } from './schema.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 四因子权重（任务书口径）。 */
export const FACTOR_WEIGHTS = Object.freeze({
  relevance: 0.40,
  freshness: 0.25,
  importance: 0.25,
  penalty: 0.10,
});

/** 公式原文（进 why，调试的人不用翻文档）。 */
export const SCORE_FORMULA = '0.40×相关度 + 0.25×新鲜度 + 0.25×重要性 − 0.10×重复惩罚';

/** 降级扫描命中时的相关度上限（中性值，永远低于完整 BM25 归一化）。 */
export const SCAN_RELEVANCE_CAP = 0.5;

/**
 * 新鲜度：0.5 ** (days / halfLife)。未来时间按 0 天算（时钟漂移不许把新鲜度算成负天数）。
 *
 * **用 0.5 的幂而不是 e 的幂**（C2 上报、队长裁定改的）：
 * 「半衰期 365 天」必须真的意味着「365 天后权重减半」。
 * exp(-days/halfLife) 在 days=halfLife 时是 1/e ≈ 0.368 —— 那叫「e 折时间」，
 * 不叫半衰期；按它算，365 天的半衰期实际 253 天就减半了，文档与行为不符。
 *
 * @param {number} days
 * @param {number} halfLifeDays
 * @returns {number} 0..1
 */
export function freshnessFactor(days, halfLifeDays) {
  const halfLife = Number(halfLifeDays);
  if (!Number.isFinite(halfLife) || halfLife <= 0) return 0;
  const elapsed = Math.max(0, Number(days) || 0);
  return Math.pow(0.5, elapsed / halfLife);
}

/**
 * 重要性因子：importance / 5。
 * @param {number} importance
 * @returns {number} 0..1
 */
export function importanceFactor(importance) {
  const value = Math.min(5, Math.max(1, Number(importance) || 1));
  return value / 5;
}

/**
 * 重复惩罚强度：min(1, recall_count / 10)。
 * @param {number} recallCount
 * @returns {number} 0..1
 */
export function penaltyFactor(recallCount) {
  const count = Math.max(0, Number(recallCount) || 0);
  return Math.min(1, count / 10);
}

/**
 * 合成最终得分。
 * @param {{relevance: number, freshness: number, importance: number, penalty: number}} factors
 * @returns {number}
 */
export function combineScore(factors) {
  return FACTOR_WEIGHTS.relevance * factors.relevance
    + FACTOR_WEIGHTS.freshness * factors.freshness
    + FACTOR_WEIGHTS.importance * factors.importance
    - FACTOR_WEIGHTS.penalty * factors.penalty;
}

/**
 * 归一化 BM25：raw（-bm25，越大越相关）按命中集合最大值归一到 0..1；
 * 没有命中或最大值非正 → 全部为 0（SPEC：无关键词命中时相关度为 0）。
 * @param {Map<number, number>} rawById 行 id → raw
 * @returns {Map<number, number>} 行 id → 0..1
 */
export function normalizeRelevance(rawById) {
  let maxRaw = 0;
  for (const raw of rawById.values()) {
    if (Number.isFinite(raw) && raw > maxRaw) maxRaw = raw;
  }
  const normalized = new Map();
  if (maxRaw <= 0) return normalized;
  for (const [id, raw] of rawById) {
    const value = Number.isFinite(raw) && raw > 0 ? raw / maxRaw : 0;
    normalized.set(id, Math.min(1, Math.max(0, value)));
  }
  return normalized;
}

/**
 * 一行记忆的四因子 + why 对象。召回结果的 score 与 why.score 同源同值。
 *
 * @param {object} row 记忆行（camelCase）
 * @param {object} input
 * @param {number} input.now epoch ms
 * @param {number} input.relevance 0..1
 * @param {'fts'|'scan'|'none'} input.retrieval 相关度来源
 * @param {string[]} [input.matchedTokens] 降级扫描命中词
 * @param {number|null} [input.bm25Raw] FTS 原始分（-bm25）
 * @returns {{score: number, why: object, factors: object}}
 */
export function scoreRow(row, input) {
  const halfLife = halfLifeDaysFor(row);
  const days = Math.max(0, (Number(input.now) - Number(row.updatedAt)) / DAY_MS);
  const factors = {
    relevance: Math.min(1, Math.max(0, Number(input.relevance) || 0)),
    freshness: freshnessFactor(days, halfLife),
    importance: importanceFactor(row.importance),
    penalty: penaltyFactor(row.recallCount),
  };
  const score = combineScore(factors);
  return {
    score,
    factors,
    why: {
      // 四因子分项（每个 0..1；penalty 是惩罚强度，越小越好）
      relevance: factors.relevance,
      freshness: factors.freshness,
      importance: factors.importance,
      penalty: factors.penalty,
      score,
      weights: { ...FACTOR_WEIGHTS },
      formula: SCORE_FORMULA,
      // 解释性数据：让 why 真的能回答「为什么」
      retrieval: input.retrieval,
      bm25Raw: input.bm25Raw ?? null,
      matchedTokens: input.matchedTokens ?? [],
      daysSinceUpdate: days,
      halfLifeDays: halfLife,
      recallCount: row.recallCount,
    },
  };
}
