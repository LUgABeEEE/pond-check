/**
 * pond-check · 能力层 C2：长期记忆总入口（src/memory/index.mjs）
 *
 *   import { createMemory, remember, recall } from 'pond-check/memory';
 *
 * 两种用法：
 *   createMemory()          长驻实例（C3 wake 这类持有者用它，省一次开库）
 *   remember/recall/…       一次性便捷函数：每次调用开一次库、用完即关
 *
 * 导出面（任务书口径 + v0.2.1 增量）：remember(candidate) / recall(query, opts) /
 * forget(id)（归档，不是删除）/ purge(id)（真删，事件流留审计）/
 * setImportance(id, n)（降级腾配额）/ importanceQuota() / export() ——
 * `export` 是保留字，模块级函数叫 exportMemories，实例方法仍叫 memory.export()。
 *
 * 顺带导出常量与纯函数（KIND_HALF_LIFE_DAYS 给 wake 算权重用；
 * trigramJaccard / classifyKind / scoreImportance 给测试与上层解释用）。
 *
 * 硬约束：不联网、零依赖；记忆默认本地、永不上传（CAPABILITIES-SPEC §3.6）。
 */

import { createMemory } from './memory.mjs';

export { createMemory, DEGRADATION_CHANNELS, RECALL_DEFAULTS } from './memory.mjs';
export {
  KINDS,
  KIND_HALF_LIFE_DAYS,
  FALLBACK_HALF_LIFE_DAYS,
  DEFAULT_IMPORTANCE,
  DEFAULT_CONFIDENCE,
  MEMORY_DB_FILE_NAME,
  SCHEMA_VERSION,
  MIGRATION_COLUMNS,
  MAX_IMPORTANCE,
  MAX_TOP_IMPORTANCE_ENTRIES,
  IMPORTANCE_QUOTA,
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
export { SQLITE_PROVIDER, VOLATILE_PROVIDER, openStore, migrateSchema } from './store.mjs';
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
 * @param {object} [options] createMemory 的选项 + { limit, kinds, minScore, includeArchived, withMeta }
 */
export function recall(query, options = {}) {
  const memory = createMemory(options);
  try {
    return memory.recall(query, {
      limit: options.limit,
      kinds: options.kinds,
      minScore: options.minScore,
      includeArchived: options.includeArchived,
      withMeta: options.withMeta,
    });
  } finally {
    memory.close();
  }
}

/**
 * 忘掉一条记忆（一次性便捷入口）—— 归档，不是删除。
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
 * 真删一条记忆（一次性便捷入口）—— 不可逆，事件流留审计。
 * @param {number} id
 * @param {object} [options] createMemory 的选项 + { actor }
 */
export function purge(id, options = {}) {
  const memory = createMemory(options);
  try {
    return memory.purge(id, { actor: options.actor });
  } finally {
    memory.close();
  }
}

/**
 * 改一条记忆的重要性（一次性便捷入口）。
 * @param {number} id
 * @param {number} importance 1..5
 * @param {object} [options] createMemory 的选项
 */
export function setImportance(id, importance, options = {}) {
  const memory = createMemory(options);
  try {
    return memory.setImportance(id, importance);
  } finally {
    memory.close();
  }
}

/**
 * importance=5 的配额快照（一次性便捷入口）。
 * @param {object} [options] createMemory 的选项
 */
export function importanceQuota(options = {}) {
  const memory = createMemory(options);
  try {
    return memory.importanceQuota();
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
