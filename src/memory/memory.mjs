/**
 * pond-check · 能力层 C2：长期记忆（src/memory/memory.mjs）
 *
 * 五个能力里最重要的一个：沉淀（remember）+ 召回（recall）+ 遗忘（forget）
 * + 导出（export），全部走 CAPABILITIES-SPEC §3 的口径——
 *
 *   沉淀三闸（§3.3）：候选抽取 → 去重合并 → 重要性评分，缺一不可
 *   四因子召回（§3.4）：score = 0.40 相关度 + 0.25 新鲜度 + 0.25 重要性 − 0.10 重复惩罚
 *   每条召回带 why 分项 —— 召回不是黑盒
 *
 * 用法：
 *
 *   const memory = createMemory();                  // 默认 <POND_HOME>/memory.db
 *   memory.remember({ content: '主人讨厌香菜', kind: 'preference' });
 *   memory.recall('香菜', { limit: 3 });
 *   memory.forget(7);
 *   memory.export();                                // JSONL 字符串，用户自己决定往哪放
 *
 * 隐私铁律（§3.6）：记忆默认本地、永不上传——没有同步、没有备份、没有遥测；
 * 所有状态都在 `<POND_HOME>` 下，整目录删掉即回到初始状态（§6.3）。
 *
 * 降级链：sqlite 打不开（POND_HOME 指到文件、磁盘坏……）→ 易失内存存储兜底，
 * 会话内照常工作，降级写进事件流；召回时 FTS 坏了 → 全表扫描兜底（why.retrieval
 * 标 'scan'）。**任何失败路径都不外发数据**。
 *
 * 硬约束：只写 `<POND_HOME>`；不联网；API 同步（存储是同步的 node:sqlite），
 * 事件写入失败只 warn、不影响记忆结果。
 */

import { classifyKind, findSimilarRow, normalizeCandidate, scoreImportance } from './gates.mjs';
import { recordMemoryEvent } from './events.mjs';
import { queryTokens, SIMILARITY_THRESHOLD } from './text.mjs';
import {
  SCAN_RELEVANCE_CAP,
  normalizeRelevance,
  scoreRow,
} from './scoring.mjs';
import { openStore, SQLITE_PROVIDER } from './store.mjs';
import { isKind } from './schema.mjs';

/** recall 的默认参数（CAPABILITIES-SPEC §3.4）。 */
export const RECALL_DEFAULTS = Object.freeze({
  limit: 6,
  minScore: 0.15,
});

function resolveNow(now) {
  if (typeof now === 'function') return now;
  if (Number.isFinite(now)) return () => now;
  return () => Date.now();
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} 必须是正整数，收到 ${JSON.stringify(value)}`);
  }
}

function assertUnitInterval(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} 必须是 0..1 的数，收到 ${JSON.stringify(value)}`);
  }
}

/**
 * 创建一个记忆实例。
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] 环境变量（缺省 process.env）
 * @param {string} [options.dbPath] 显式库路径（优先于 env 解析）
 * @param {number|() => number} [options.now] 时间基准（测试注入）
 * @param {(message: string) => void} [options.warn] 告警出口
 * @param {string} [options.eventsPath] 显式事件文件路径
 */
export function createMemory(options = {}) {
  const env = options.env ?? process.env;
  const now = resolveNow(options.now);
  const warn = typeof options.warn === 'function' ? options.warn : undefined;
  const warnMessage = typeof warn === 'function'
    ? warn
    : (message) => console.warn(`[pond/memory] ${message}`);
  const eventOptions = { env, warn };
  if (options.eventsPath) eventOptions.eventsPath = options.eventsPath;

  const opened = openStore({ env, dbPath: options.dbPath });
  const store = opened.store;
  // 记忆是纯本地能力：事件里的 provider 恒标 local，成本口径恒 0（SPEC §2.2）
  const providerInfo = { id: store.provider, local: true };

  // 降级发生时把两个 provider 的尝试都记进事件流：失败的 sqlite + 接手的 volatile。
  if (opened.degraded) {
    const provider = { id: SQLITE_PROVIDER, local: true };
    recordMemoryEvent({
      capability: 'memory',
      provider,
      units: 0,
      ok: false,
      error: opened.degraded.error?.message ?? String(opened.degraded.error),
      errorCategory: 'storage',
      attempt: 1,
      op: 'open',
      action: 'degraded',
      reason: 'storage-open-failed',
    }, eventOptions);
    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: 0,
      ok: true,
      attempt: 2,
      degradedFrom: SQLITE_PROVIDER,
      op: 'open',
      action: 'degraded',
      reason: 'storage-open-failed',
    }, eventOptions);
  }

  /**
   * 沉淀一条记忆：三闸全过才落库。
   *
   * @param {object|string} candidate { content, kind?, entities?, importance?, confidence?,
   *                                   source?, sourceRef?, ttlDays?, force? } 或纯字符串
   * @param {{force?: boolean}} [opts] opts.force 与 candidate.force 等效（跳过闸二）
   * @returns {{recorded: boolean, action: 'created'|'merged'|'rejected', reason: string|null,
   *            id: number|null, memory: object|null, similarity: number|null,
   *            gates: object, gatesSkipped: string[]}}
   */
  function remember(candidate, opts = {}) {
    const startedAt = Date.now();
    const normalized = normalizeCandidate(candidate);
    const force = normalized.force || opts.force === true;
    const currentNow = now();

    // 闸一 · 候选抽取：只接受三类之一，抽不出就不记
    const explicitKind = normalized.kind;
    const kind = classifyKind(normalized.content, explicitKind);
    const gates = {
      extract: { kind, explicit: explicitKind !== null },
      dedupe: {
        checked: false,
        skipped: false,
        matchedId: null,
        similarity: null,
        threshold: SIMILARITY_THRESHOLD,
      },
      importance: { value: null, explicit: normalized.importance !== null, rejected: false },
    };
    const gatesSkipped = [];

    if (kind === null) {
      return finish('rejected', 'no-kind', { gates, gatesSkipped, startedAt, units: 0, id: null, memory: null, similarity: null });
    }

    // 从这里开始触碰存储（闸二查库 + 落库）。存储真坏了（磁盘满、主表被外力
    // 删了、连接被关……）不炸调用方：转成 recorded:false + reason 'storage-error'，
    // 事件记 ok:false + errorCategory 'storage'，诊断层看得见。
    let memory;
    let action;
    try {
      // 闸二 · 去重合并：相似（trigram Jaccard ≥ 0.75）→ 替换而不是新增
      const rows = store.list();
      gates.dedupe.checked = true;
      if (force) {
        gates.dedupe.skipped = true;
        gatesSkipped.push('dedupe');
      }
      const similar = force ? null : findSimilarRow(rows, normalized.content, kind);
      if (similar) {
        gates.dedupe.matchedId = similar.row.id;
        gates.dedupe.similarity = similar.similarity;
      }

      // 闸三 · 重要性评分：1 分（猜测性）默认不记，除非 force
      const importance = scoreImportance({ content: normalized.content, kind, importance: normalized.importance });
      gates.importance.value = importance;
      if (importance === 1) {
        if (force) {
          gatesSkipped.push('low-importance-drop');
        } else {
          gates.importance.rejected = true;
          return finish('rejected', 'low-importance', {
            gates, gatesSkipped, startedAt, units: 0, id: null, memory: null, similarity: null,
          });
        }
      }

      // 落库：合并（保 id、更新 content/updated_at、importance 取 max）或新增
      if (similar) {
        const mergedEntities = [...new Set([...(similar.row.entities ?? []), ...normalized.entities])];
        memory = store.update(similar.row.id, {
          content: normalized.content,
          updatedAt: currentNow,
          // SPEC §3.3 闸二：importance 取 max；实体取并集、confidence 取 max——
          // 「合并」的语义是同一件事的最新版本，不是把旧的确信度冲掉
          importance: Math.max(similar.row.importance, importance),
          entities: mergedEntities,
          confidence: Math.max(similar.row.confidence, normalized.confidence),
        });
        action = 'merged';
        return finish('merged', null, {
          gates, gatesSkipped, startedAt, units: 1,
          id: memory.id, memory, similarity: similar.similarity,
        });
      }
      memory = store.insert({
        kind,
        content: normalized.content,
        entities: normalized.entities,
        importance,
        confidence: normalized.confidence,
        source: normalized.source,
        sourceRef: normalized.sourceRef,
        createdAt: currentNow,
        updatedAt: currentNow,
        lastRecalled: null,
        recallCount: 0,
        ttlDays: normalized.ttlDays,
        archived: false,
      });
      action = 'created';
      return finish('created', null, {
        gates, gatesSkipped, startedAt, units: 1,
        id: memory.id, memory, similarity: null,
      });
    } catch (error) {
      return finish('rejected', 'storage-error', {
        gates, gatesSkipped, startedAt, units: 0,
        id: null, memory: null, similarity: null,
        ok: false, error: error?.message ?? String(error),
      });
    }

    function finish(act, reason, parts) {
      const recorded = act !== 'rejected';
      recordMemoryEvent({
        capability: 'memory',
        provider: providerInfo,
        units: parts.units,
        ok: parts.ok !== false,
        error: parts.error ?? null,
        errorCategory: parts.ok === false ? 'storage' : null,
        durationMs: Date.now() - startedAt,
        op: 'remember',
        action: act,
        reason,
        gatesSkipped: parts.gatesSkipped,
      }, eventOptions);
      return {
        recorded,
        action: act,
        reason,
        id: parts.id,
        memory: parts.memory,
        similarity: parts.similarity,
        gates: parts.gates,
        gatesSkipped: parts.gatesSkipped,
      };
    }
  }

  /**
   * 四因子召回。返回按 score 降序的数组，每条带 why 分项；命中的条目会
   * 累加 recall_count / 刷新 last_recalled（重复惩罚因此逐次生效）。
   *
   * @param {string} query 关键词（空串 = 不按相关度，只看新鲜度/重要性/重复惩罚）
   * @param {{limit?: number, kinds?: string[], minScore?: number}} [opts]
   * @returns {object[]} [{ id, kind, content, score, why, entities, importance, ... }]
   */
  function recall(query, opts = {}) {
    const startedAt = Date.now();
    if (typeof query !== 'string') {
      throw new TypeError(`recall 的 query 必须是字符串，收到 ${JSON.stringify(query)}`);
    }
    const limit = opts.limit ?? RECALL_DEFAULTS.limit;
    const minScore = opts.minScore ?? RECALL_DEFAULTS.minScore;
    assertPositiveInteger(limit, 'recall 的 limit');
    assertUnitInterval(minScore, 'recall 的 minScore');
    const kinds = opts.kinds;
    if (kinds !== undefined) {
      if (!Array.isArray(kinds) || kinds.some((kind) => !isKind(kind))) {
        throw new TypeError('recall 的 kinds 必须是 fact / preference / episode 的数组');
      }
    }

    const currentNow = now();
    const rows = store.list({ kinds });
    const tokens = queryTokens(query);
    const search = tokens.length > 0 ? store.search(tokens) : { mode: 'none', hits: [] };

    // 相关度：FTS 模式按 BM25 归一化（限定在候选集内），扫描模式给中性值
    const candidateIds = new Set(rows.map((row) => row.id));
    const rawById = new Map();
    const matchedById = new Map();
    for (const hit of search.hits) {
      if (!candidateIds.has(hit.id)) continue;
      if (search.mode === 'fts') rawById.set(hit.id, hit.raw);
      else matchedById.set(hit.id, hit.matched ?? []);
    }
    const relevanceById = search.mode === 'fts'
      ? normalizeRelevance(rawById)
      : new Map();

    const scored = rows.map((row) => {
      let relevance = 0;
      let matchedTokens = [];
      if (search.mode === 'fts') {
        relevance = relevanceById.get(row.id) ?? 0;
      } else if (search.mode === 'scan') {
        matchedTokens = matchedById.get(row.id) ?? [];
        relevance = tokens.length > 0
          ? SCAN_RELEVANCE_CAP * (matchedTokens.length / tokens.length)
          : 0;
      }
      const { score, why } = scoreRow(row, {
        now: currentNow,
        relevance,
        retrieval: search.mode,
        matchedTokens,
        bm25Raw: search.mode === 'fts' ? (rawById.get(row.id) ?? null) : null,
      });
      return {
        id: row.id,
        kind: row.kind,
        content: row.content,
        score,
        why,
        entities: row.entities,
        importance: row.importance,
        confidence: row.confidence,
        source: row.source,
        sourceRef: row.sourceRef,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastRecalled: row.lastRecalled,
        recallCount: row.recallCount,
        ttlDays: row.ttlDays,
      };
    });

    const items = scored
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id - b.id)
      .slice(0, limit);

    // 只有被真正返回的条目才「被提过」一次 —— 重复惩罚按此累计。
    // 计数失败（存储坏了）绝不影响召回结果本身：宁可少算一次惩罚，不丢召回。
    try {
      store.bumpRecall(items.map((item) => item.id), currentNow);
    } catch (error) {
      warnMessage(`recall 计数写入失败（不影响召回结果）：${error?.message ?? error}`);
    }

    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: items.length,
      ok: true,
      durationMs: Date.now() - startedAt,
      op: 'recall',
      action: 'recalled',
      retrieval: search.mode,
    }, eventOptions);

    return items;
  }

  /**
   * 忘掉一条记忆（硬删除：行与索引一起走）。
   * @param {number} id
   * @returns {{forgotten: boolean, id: number}}
   */
  function forget(id) {
    const startedAt = Date.now();
    if (!Number.isInteger(id)) {
      throw new TypeError(`forget 的 id 必须是整数，收到 ${JSON.stringify(id)}`);
    }
    let existing = null;
    let forgotten;
    let storageError = null;
    try {
      existing = store.get(id);
      forgotten = store.delete(id);
    } catch (error) {
      forgotten = false;
      storageError = error?.message ?? String(error);
      warnMessage(`forget 写入失败（记忆未删除）：${storageError}`);
    }
    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: forgotten ? 1 : 0,
      ok: storageError === null,
      error: storageError,
      errorCategory: storageError === null ? null : 'storage',
      durationMs: Date.now() - startedAt,
      op: 'forget',
      action: forgotten ? 'forgotten' : 'missing',
    }, eventOptions);
    return { forgotten, id, memory: existing };
  }

  /**
   * 导出全部记忆（含归档）为 JSONL 字符串。用户自己决定往哪放——
   * 这是唯一的数据出口，没有同步、没有云备份（SPEC §3.6）。
   * @returns {string} 每行一个 JSON 对象；空库返回 ''
   */
  function exportJsonl() {
    const startedAt = Date.now();
    const rows = store.list({ includeArchived: true });
    const text = rows.map((row) => JSON.stringify({
      id: row.id,
      kind: row.kind,
      content: row.content,
      entities: row.entities,
      importance: row.importance,
      confidence: row.confidence,
      source: row.source,
      sourceRef: row.sourceRef,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastRecalled: row.lastRecalled,
      recallCount: row.recallCount,
      ttlDays: row.ttlDays,
      archived: row.archived,
    })).join('\n');
    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: rows.length,
      ok: true,
      durationMs: Date.now() - startedAt,
      op: 'export',
      action: 'exported',
    }, eventOptions);
    return text === '' ? '' : `${text}\n`;
  }

  return {
    remember,
    recall,
    forget,
    export: exportJsonl,
    close: () => store.close(),
    get mode() { return store.provider; },
    get dbPath() { return store.dbPath ?? null; },
  };
}
