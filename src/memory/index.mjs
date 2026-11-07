/**
 * pond-check · 能力层 C2：长期记忆总入口（src/memory/index.mjs）
 *
 *   import { createMemory, remember, recall } from 'pond-check/memory';
 *
 * 两种用法：
 *   createMemory()          长驻实例（C3 wake 这类持有者用它，省一次开库）
 *   remember/recall/…       一次性便捷函数：每次调用开一次库、用完即关
 *
 * 导出面（任务书口径）：remember(candidate) / recall(query, opts) /
 * forget(id) / export() —— `export` 是保留字，模块级函数叫 exportMemories，
 * 实例方法仍叫 memory.export()。
 *
 * 顺带导出常量与纯函数（KIND_HALF_LIFE_DAYS 给 wake 算权重用；
 * trigramJaccard / classifyKind / scoreImportance 给测试与上层解释用）。
 *
 * 硬约束：不联网、零依赖；记忆默认本地、永不上传（CAPABILITIES-SPEC §3.6）。
 */

import { createMemory } from './memory.mjs';

export { createMemory } from './memory.mjs';
export { RECALL_DEFAULTS } from './memory.mjs';
export {
  KINDS,
  KIND_HALF_LIFE_DAYS,
  FALLBACK_HALF_LIFE_DAYS,
  DEFAULT_IMPORTANCE,
  DEFAULT_CONFIDENCE,
  MEMORY_DB_FILE_NAME,
  isKind,
  halfLifeDaysFor,
} from './schema.mjs';
export {
  SIMILARITY_THRESHOLD,
  MAX_QUERY_TOKENS,
  normalizeForSimilarity,
  trigramJaccard,
  segmentText,
  queryTokens,
  buildMatchExpr,
} from './text.mjs';
export {
  classifyKind,
  scoreImportance,
  findSimilarRow,
  normalizeCandidate,
} from './gates.mjs';
export {
  FACTOR_WEIGHTS,
  SCORE_FORMULA,
  SCAN_RELEVANCE_CAP,
  freshnessFactor,
  importanceFactor,
  penaltyFactor,
  combineScore,
  normalizeRelevance,
  scoreRow,
} from './scoring.mjs';
export { SQLITE_PROVIDER, VOLATILE_PROVIDER, openStore } from './store.mjs';
export { recordMemoryEvent, MEMORY_EVENT_FIELDS } from './events.mjs';

/**
 * 沉淀一条记忆（一次性便捷入口）。
 * @param {object|string} candidate
 * @param {object} [options] createMemory 的选项 + { force }
 */
export function remember(candidate, options = {}) {
  const memory = createMemory(options);
  try {
    return memory.remember(candidate, { force: options.force === true });
  } finally {
    memory.close();
  }
}

/**
 * 四因子召回（一次性便捷入口）。
 * @param {string} query
 * @param {object} [options] createMemory 的选项 + { limit, kinds, minScore }
 */
export function recall(query, options = {}) {
  const memory = createMemory(options);
  try {
    return memory.recall(query, {
      limit: options.limit,
      kinds: options.kinds,
      minScore: options.minScore,
    });
  } finally {
    memory.close();
  }
}

/**
 * 忘掉一条记忆（一次性便捷入口）。
 * @param {number} id
 * @param {object} [options] createMemory 的选项
 */
export function forget(id, options = {}) {
  const memory = createMemory(options);
  try {
    return memory.forget(id);
  } finally {
    memory.close();
  }
}

/**
 * 导出 JSONL（一次性便捷入口）。
 * @param {object} [options] createMemory 的选项
 * @returns {string}
 */
export function exportMemories(options = {}) {
  const memory = createMemory(options);
  try {
    return memory.export();
  } finally {
    memory.close();
  }
}
