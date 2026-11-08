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
 * v0.2.1 的记忆层四处改动（借鉴 Ombre Brain）：
 *
 *   ① 遗忘是淡去，不是删除：`forget(id)` 只置 archived=1（日常召回看不到，
 *      `recall(q, { includeArchived: true })` 还能找到）；真删只有 `purge(id)`，
 *      且它一定在事件流里留一条**不可逆审计记录**（谁 / 何时 / 删了什么摘要）。
 *      `export()` 也把「归档的」与「现存的」分开，绝不混在一起。
 *   ② importance=5 是稀缺资源：硬上限 MAX_TOP_IMPORTANCE_ENTRIES（20），写满后
 *      `remember()` 返回 `importance-quota-full` + 现役 5 分清单，**不静默降成 4 分**。
 *      调用方先用 `setImportance()` 降级或 `purge()` 腾位，再写。
 *   ③ schema 加 valence / arousal（Russell 情感坐标）：**只存不算分**，
 *      绝不进四因子公式；旧库由 store.mjs 自动迁移，旧行两列为 NULL。
 *   ④ 召回降级说细：`recall()` 结果带 `degradation: { channel, reason }`，
 *      通道是 keyword-only（语义通道未启用）/ fts-unavailable（FTS 坏了→扫描）
 *      / scan-fallback（易失后端没有 FTS）。完整召回时 degradation 为 null。
 *
 * 用法：
 *
 *   const memory = createMemory();                  // 默认 <POND_HOME>/memory.db
 *   memory.remember({ content: '主人讨厌香菜', kind: 'preference' });
 *   memory.recall('香菜', { limit: 3 });            // .degradation 说明这次走了哪条通道
 *   memory.forget(7);                               // 归档（淡出，不删）
 *   memory.purge(7, { actor: '主人' });             // 真删，事件流留审计
 *   memory.export();                                // JSONL 字符串（现存记忆）
 *
 * 隐私铁律（§3.6）：记忆默认本地、永不上传——没有同步、没有备份、没有遥测；
 * 所有状态都在 `<POND_HOME>` 下，整目录删掉即回到初始状态（§6.3）。
 *
 * 降级链：sqlite 打不开（POND_HOME 指到文件、磁盘坏……）→ 易失内存存储兜底，
 * 会话内照常工作，降级写进事件流；召回时 FTS 坏了 → 全表扫描兜底（why.retrieval
 * 标 'scan'，degradation.channel 标 'fts-unavailable'）。**任何失败路径都不外发数据**。
 *
 * 硬约束：只写 `<POND_HOME>`；不联网；API 同步（存储是同步的 node:sqlite），
 * 事件写入失败只 warn、不影响记忆结果。
 */

import { createHash } from 'node:crypto';

import { classifyKind, findSimilarRow, normalizeCandidate, scoreImportance } from './gates.mjs';
import { recordMemoryEvent } from './events.mjs';
import { queryTokens, SIMILARITY_THRESHOLD } from './text.mjs';
import {
  SCAN_RELEVANCE_CAP,
  normalizeRelevance,
  scoreRow,
} from './scoring.mjs';
import { openStore, SQLITE_PROVIDER, VOLATILE_PROVIDER } from './store.mjs';
import {
  isKind,
  IMPORTANCE_QUOTA,
  MAX_IMPORTANCE,
  MAX_TOP_IMPORTANCE_ENTRIES,
} from './schema.mjs';

/** recall 的默认参数（CAPABILITIES-SPEC §3.4）。 */
export const RECALL_DEFAULTS = Object.freeze({
  limit: 6,
  minScore: 0.15,
});

/**
 * 召回降级的三种通道（机器可读，进 recall 结果的 `degradation.channel`）：
 *
 *   keyword-only     FTS 正常的纯关键词命中——**语义通道没启用**（v0.2.1 没有向量召回）。
 *                    这是 OB「向量离线 → 退回关键词」的对应状态：能召回，但只靠字面。
 *   fts-unavailable  FTS 索引坏了/被删了，退回全表扫描关键词（相关度封顶 0.5）。
 *   scan-fallback    存储本身没有 FTS（sqlite 打不开 → 易失后端），只能全表扫描。
 *
 * 三种都不是「完整召回」：完整召回 = 语义 + 关键词都在 → `degradation === null`。
 * v0.2.1 还产不出完整召回，所以这里的 `degraded` 恒为 true——这是诚实的：
 * 语义通道确实不存在，不能让调用方以为拿到的是全通道结果。
 */
export const DEGRADATION_CHANNELS = Object.freeze([
  'keyword-only',
  'fts-unavailable',
  'scan-fallback',
]);

/** 算一条记忆内容的摘要（审计与配额清单共用）。 */
function summarizeContent(content, maxLength = 40) {
  const text = String(content ?? '').replace(/\s+/gu, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** 内容指纹：只用于「删了什么」的可核对性，不泄露完整正文。 */
function contentDigest(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex').slice(0, 16);
}

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
 * @param {string} [options.actor] 审计里的「谁」（缺省 'local'；purge 会写进事件流）
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
  const actor = typeof options.actor === 'string' && options.actor !== '' ? options.actor : 'local';

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

  // 旧库（v0.2.0 / schema v1）打开时被自动补列：迁移必须留痕，
  // 否则「库什么时候多了 valence/arousal」无从追溯。
  const migrations = Array.isArray(opened.store.migrations) ? opened.store.migrations : [];
  if (migrations.length > 0) {
    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: 0,
      ok: true,
      op: 'migrate',
      action: 'migrated',
      reason: 'schema-upgrade',
      migrations,
    }, eventOptions);
  }

  /**
   * importance=5 的现役条目（未归档）。配额只算淡出前的：
   * 归档 = 不再参与日常召回，也就不该继续占着稀缺位。
   * @param {object[]} rows 未归档行（store.list() 的结果）
   * @returns {object[]}
   */
  function topImportanceRows(rows) {
    return (rows ?? []).filter((row) => row.importance === MAX_IMPORTANCE);
  }

  /**
   * 配额快照：调用方（尤其 remember 被拒时）能直接看到「谁占满了」。
   * content 是**摘要**（≤40 字），不是整条正文——清单是给人扫一眼的。
   * @param {object[]} rows
   * @returns {{importance: number, limit: number, used: number, remaining: number,
   *            entries: {id: number, kind: string, content: string}[]}}
   */
  function buildQuota(rows) {
    const top = topImportanceRows(rows);
    const entries = top.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: summarizeContent(row.content),
    }));
    return {
      importance: IMPORTANCE_QUOTA.importance,
      limit: IMPORTANCE_QUOTA.limit,
      used: entries.length,
      remaining: Math.max(0, IMPORTANCE_QUOTA.limit - entries.length),
      entries,
    };
  }

  /**
   * 沉淀一条记忆：三闸全过才落库。
   *
   * 三闸之后还有一道**配额闸**（v0.2.1）：importance=5 的现役条目最多
   * MAX_TOP_IMPORTANCE_ENTRIES 条。写满时返回 `recorded:false` +
   * `reason:'importance-quota-full'` + `quota`（现役 5 分清单），
   * **绝不静默把 5 降成 4 落库**——那会让调用方以为自己的「必须记住」生效了。
   *
   * @param {object|string} candidate { content, kind?, entities?, importance?, confidence?,
   *                                   valence?, arousal?, source?, sourceRef?, ttlDays?, force? }
   *                                   或纯字符串
   * @param {{force?: boolean}} [opts] opts.force 与 candidate.force 等效（跳过闸二）
   * @returns {{recorded: boolean, action: 'created'|'merged'|'rejected', reason: string|null,
   *            id: number|null, memory: object|null, similarity: number|null,
   *            gates: object, gatesSkipped: string[], quota: object|null}}
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
      quota: { checked: false, limited: false, limit: MAX_TOP_IMPORTANCE_ENTRIES, used: null },
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

      // 闸四（v0.2.1）· importance=5 配额：只有**新增一个 5 分位**才算占用。
      // 合并到一条已经是 5 分的旧记忆不增加名额；把已是 5 分的合并保持 5 也不增加。
      const effectiveImportance = similar
        ? Math.max(similar.row.importance, importance)
        : importance;
      const occupiesNewTopSlot = effectiveImportance === MAX_IMPORTANCE
        && !(similar && similar.row.importance === MAX_IMPORTANCE);
      gates.quota.checked = true;
      if (occupiesNewTopSlot) {
        const quota = buildQuota(rows);
        gates.quota.used = quota.used;
        if (quota.used >= quota.limit) {
          gates.quota.limited = true;
          gates.importance.rejected = true;
          return finish('rejected', 'importance-quota-full', {
            gates, gatesSkipped, startedAt, units: 0,
            id: null, memory: null, similarity: similar?.similarity ?? null,
            quota,
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
          // 情感坐标：新值优先；候选没给就保留旧值（合并不是「抹掉已知情绪」）。
          valence: normalized.valence ?? similar.row.valence,
          arousal: normalized.arousal ?? similar.row.arousal,
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
        // 情感坐标：**只存不算分**，NULL = 未标注
        valence: normalized.valence,
        arousal: normalized.arousal,
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
        quota: parts.quota ?? null,
      };
    }
  }

  /**
   * 四因子召回。返回按 score 降序的数组，每条带 why 分项；命中的条目会
   * 累加 recall_count / 刷新 last_recalled（重复惩罚因此逐次生效）。
   *
   * **降级要说细（v0.2.1）**：返回的数组上挂着三个只读属性（非枚举，不影响
   * 数组本身的比较/序列化）——
   *
   *   items.degraded     true = 这次不是「完整召回（语义 + 关键词）」
   *   items.degradation  { channel, reason } | null —— channel 见 DEGRADATION_CHANNELS
   *   items.channels     { keyword: 'fts'|'scan'|'none', semantic: false }
   *
   * 想显式拿元信息（或者要展开成对象）用 `{ withMeta: true }`，返回
   * `{ items, degraded, degradation, channels }`。渲染层靠 channel 决定是
   * 照常展示，还是加一句「这次只是关键词命中」。
   *
   * @param {string} query 关键词（空串 = 不按相关度，只看新鲜度/重要性/重复惩罚）
   * @param {{limit?: number, kinds?: string[], minScore?: number, includeArchived?: boolean,
   *          withMeta?: boolean}} [opts]
   *        includeArchived: true → 连归档的一起召回（日常召回默认隐藏归档）
   *        withMeta: true → 返回 { items, degraded, degradation, channels }
   * @returns {object[]|{items: object[], degraded: boolean, degradation: object|null, channels: object}}
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
    if (opts.includeArchived !== undefined && typeof opts.includeArchived !== 'boolean') {
      throw new TypeError('recall 的 includeArchived 必须是布尔值');
    }
    const includeArchived = opts.includeArchived === true;

    const currentNow = now();
    // 归档 = 淡出：日常召回看不到，只有 includeArchived 才捞回来
    const rows = store.list({ kinds, includeArchived });
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
        archived: row.archived,
        // 情感坐标随结果带出（**不参与排序**，只给调用方展示/后续实验用）
        valence: row.valence,
        arousal: row.arousal,
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

    const channels = {
      keyword: search.mode,      // 'fts' | 'scan' | 'none'
      semantic: false,           // v0.2.1 没有语义通道——不许假装有
    };
    const degradation = buildDegradation({ provider: store.provider, mode: search.mode });

    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: items.length,
      ok: true,
      durationMs: Date.now() - startedAt,
      op: 'recall',
      action: 'recalled',
      retrieval: search.mode,
      // 通道跟着事件走：事后能回答「那次召回是完整的还是只有关键词」
      degradationChannel: degradation?.channel ?? null,
    }, eventOptions);

    if (opts.withMeta === true) {
      return { items, degraded: degradation !== null, degradation, channels };
    }
    // 数组上挂只读元信息：不改变返回类型（老调用方 `.length` / `.map` 照旧），
    // 也不进入 deepEqual / JSON 的视野——数组还是数组。
    Object.defineProperties(items, {
      degraded: { value: degradation !== null, enumerable: false, configurable: true },
      degradation: { value: degradation, enumerable: false, configurable: true },
      channels: { value: channels, enumerable: false, configurable: true },
    });
    return items;
  }

  /**
   * 这次召回退化在哪一段？三种通道见 DEGRADATION_CHANNELS。
   * 返回 null = 完整召回（语义 + 关键词都在）；v0.2.1 产不出 null。
   *
   * @param {{provider: string, mode: string}} input
   * @returns {{channel: string, reason: string}|null}
   */
  function buildDegradation(input) {
    if (input.provider === VOLATILE_PROVIDER) {
      return {
        channel: 'scan-fallback',
        reason: '存储降级为易失后端（无 FTS 索引），本次召回是全表扫描的关键词命中',
      };
    }
    if (input.mode === 'scan') {
      return {
        channel: 'fts-unavailable',
        reason: 'FTS 索引不可用，本次召回退化为全表扫描的关键词命中（相关度按命中词占比封顶 0.5）',
      };
    }
    if (input.mode === 'none') {
      return {
        channel: 'keyword-only',
        reason: '本次查询没有关键词（空查询），只按新鲜度 / 重要性 / 重复惩罚排序；语义通道未启用',
      };
    }
    return {
      channel: 'keyword-only',
      reason: '本次是 FTS 关键词命中，语义通道未启用（v0.2.1 没有向量召回）',
    };
  }

  /**
   * 忘掉一条记忆 —— **归档，不是删除**（v0.2.1，借鉴 Ombre Brain：遗忘是淡去）。
   *
   * 效果：`archived = 1`。日常 `recall()` 看不到它，wake 也不会再挑它；
   * 但 `recall(q, { includeArchived: true })` 还能找回来，`export({ includeArchived: true })`
   * 也还导出它——「忘掉」是可撤回的，只有 `purge()` 才真的回不来。
   *
   * 幂等：对已归档的 id 再 forget 一次不报错（action 'already-archived'）。
   *
   * @param {number} id
   * @returns {{forgotten: boolean, archived: boolean, id: number, memory: object|null,
   *            action: 'archived'|'already-archived'|'missing'}}
   */
  function forget(id) {
    const startedAt = Date.now();
    if (!Number.isInteger(id)) {
      throw new TypeError(`forget 的 id 必须是整数，收到 ${JSON.stringify(id)}`);
    }
    let existing = null;
    let updated = null;
    let action = 'missing';
    let storageError = null;
    try {
      existing = store.get(id);
      if (existing) {
        if (existing.archived) {
          action = 'already-archived';
          updated = existing;
        } else {
          // 只动 archived 一个位：归档是「可见性」，不该改写 updated_at
          // （那会让一条三个月前的记忆看起来像刚更新过）
          updated = store.update(id, { archived: true });
          action = updated ? 'archived' : 'missing';
        }
      }
    } catch (error) {
      storageError = error?.message ?? String(error);
      warnMessage(`forget 写入失败（记忆未归档）：${storageError}`);
    }
    const archived = action === 'archived' || action === 'already-archived';
    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: action === 'archived' ? 1 : 0,
      ok: storageError === null,
      error: storageError,
      errorCategory: storageError === null ? null : 'storage',
      durationMs: Date.now() - startedAt,
      op: 'forget',
      action,
      // 归档不是删除：事件里说清语义，免得事后把它当成 purge 的痕迹
      reason: action === 'missing' ? 'not-found' : 'archived-not-deleted',
      actor,
    }, eventOptions);
    return { forgotten: archived, archived, id, memory: updated ?? existing, action };
  }

  /**
   * 真删一条记忆（不可逆）——**只有这个 API 会丢数据**。
   *
   * 借鉴 OB：淡出（forget）与抹除（purge）是两件事。purge 必须在事件流里留下
   * **不可忽略的审计记录**：谁（actor）、什么时候（ts）、删了什么（kind + 内容摘要
   * + sha256 前 16 位 + 原始时间戳）。事件还标 `irreversible: true`，事后翻日志
   * 不会把它误当成一次普通归档。返回值里带着这条审计对象，调用方可以直接展示。
   *
   * @param {number} id
   * @param {{actor?: string}} [opts] 本次操作人（缺省用实例的 actor）
   * @returns {{purged: boolean, id: number, deleted: object|null, audit: object|null}}
   */
  function purge(id, opts = {}) {
    const startedAt = Date.now();
    if (!Number.isInteger(id)) {
      throw new TypeError(`purge 的 id 必须是整数，收到 ${JSON.stringify(id)}`);
    }
    const who = typeof opts.actor === 'string' && opts.actor !== '' ? opts.actor : actor;
    let existing = null;
    let purged = false;
    let storageError = null;
    try {
      existing = store.get(id);
      purged = existing ? store.delete(id) : false;
    } catch (error) {
      purged = false;
      storageError = error?.message ?? String(error);
      warnMessage(`purge 写入失败（记忆未删除）：${storageError}`);
    }

    // 被删内容的摘要：够核对，又不至于把整条正文抄进日志。
    // 只有**真的删掉了**才写摘要——删失败却留一条「删了什么」，审计就撒谎了。
    const deleted = purged && existing
      ? {
        id: existing.id,
        kind: existing.kind,
        contentPreview: summarizeContent(existing.content),
        contentLength: String(existing.content ?? '').length,
        contentDigest: contentDigest(existing.content),
        importance: existing.importance,
        confidence: existing.confidence,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        recallCount: existing.recallCount,
        archived: existing.archived,
      }
      : null;

    const audit = recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: purged ? 1 : 0,
      ok: storageError === null,
      error: storageError,
      errorCategory: storageError === null ? null : 'storage',
      durationMs: Date.now() - startedAt,
      op: 'purge',
      action: purged ? 'purged' : 'missing',
      reason: purged ? 'irreversible-delete' : 'not-found',
      // 审计三件套：谁、何时（ts 由 buildAttemptEntry 写）、删了什么摘要
      actor: who,
      irreversible: true,
      deleted,
    }, eventOptions);

    return { purged, id, deleted, audit: audit.entry ?? null };
  }

  /**
   * 改一条记忆的重要性（v0.2.1 配套 API）。
   *
   * 存在的主要理由：importance=5 写满后，调用方要能把某条**降级**腾位再写。
   * 升到 5 同样受配额约束（不许绕过 remember 的那道闸），但返回的是
   * `reason:'importance-quota-full'` + quota 清单，不静默失败。
   *
   * @param {number} id
   * @param {number} importance 1..5
   * @returns {{updated: boolean, id: number, importance: number|null, reason: string|null,
   *            memory: object|null, quota: object|null}}
   */
  function setImportance(id, importance) {
    const startedAt = Date.now();
    if (!Number.isInteger(id)) {
      throw new TypeError(`setImportance 的 id 必须是整数，收到 ${JSON.stringify(id)}`);
    }
    if (!Number.isInteger(importance) || importance < 1 || importance > MAX_IMPORTANCE) {
      throw new TypeError(`setImportance 的 importance 必须是 1..${MAX_IMPORTANCE} 的整数，收到 ${JSON.stringify(importance)}`);
    }

    let existing = null;
    let updated = null;
    let reason = null;
    let quota = null;
    let storageError = null;
    try {
      existing = store.get(id);
      if (!existing) {
        reason = 'missing';
      } else if (existing.importance === importance) {
        reason = 'unchanged';
        updated = existing;
      } else if (importance === MAX_IMPORTANCE) {
        quota = buildQuota(store.list());
        if (quota.used >= quota.limit) {
          reason = 'importance-quota-full';
        } else {
          updated = store.update(id, { importance, updatedAt: now() });
        }
      } else {
        updated = store.update(id, { importance, updatedAt: now() });
      }
    } catch (error) {
      storageError = error?.message ?? String(error);
      warnMessage(`setImportance 写入失败：${storageError}`);
    }

    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: updated && reason === null ? 1 : 0,
      ok: storageError === null,
      error: storageError,
      errorCategory: storageError === null ? null : 'storage',
      durationMs: Date.now() - startedAt,
      op: 'set-importance',
      action: updated ? 'updated' : 'rejected',
      reason,
      actor,
    }, eventOptions);

    return {
      updated: updated !== null && reason === null,
      id,
      importance: updated ? updated.importance : (existing?.importance ?? null),
      reason,
      memory: updated,
      quota,
    };
  }

  /**
   * 当前 importance=5 的配额快照（谁占满了、还剩几个位置）。
   * @returns {{importance: number, limit: number, used: number, remaining: number,
   *            entries: {id: number, kind: string, content: string}[]}}
   */
  function importanceQuota() {
    return buildQuota(store.list());
  }

  /**
   * 导出记忆为 JSONL。用户自己决定往哪放——这是唯一的数据出口，
   * 没有同步、没有云备份（SPEC §3.6）。
   *
   * **归档的与现存的分开**（v0.2.1）：默认只导出现存（archived=0）；
   * `{ includeArchived: true }` 追加归档块（现存在前、归档在后，各带 archived 标记，
   * 不交错）；`{ split: true }` 直接给 `{ active, archived, counts }` 两段字符串。
   *
   * @param {{includeArchived?: boolean, split?: boolean}} [opts]
   * @returns {string|{active: string, archived: string, counts: {active: number, archived: number}}}
   */
  function exportJsonl(opts = {}) {
    const startedAt = Date.now();
    const includeArchived = opts.includeArchived === true || opts.split === true;
    const activeRows = store.list();
    const archivedRows = includeArchived
      ? store.list({ includeArchived: true }).filter((row) => row.archived)
      : [];

    const serialize = (rows) => rows.map((row) => JSON.stringify({
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
      valence: row.valence,
      arousal: row.arousal,
    })).join('\n');

    const activeText = serialize(activeRows);
    const archivedText = serialize(archivedRows);
    const toLine = (text) => (text === '' ? '' : `${text}\n`);

    recordMemoryEvent({
      capability: 'memory',
      provider: providerInfo,
      units: activeRows.length + archivedRows.length,
      ok: true,
      durationMs: Date.now() - startedAt,
      op: 'export',
      action: 'exported',
    }, eventOptions);

    if (opts.split === true) {
      return {
        active: toLine(activeText),
        archived: toLine(archivedText),
        counts: { active: activeRows.length, archived: archivedRows.length },
      };
    }
    // 两段按「现存 → 归档」顺序拼接：一目了然的分界，不是混在一起的乱序
    const combined = [toLine(activeText), toLine(archivedText)].filter(Boolean).join('');
    return combined;
  }

  return {
    remember,
    recall,
    forget,
    purge,
    setImportance,
    importanceQuota,
    export: exportJsonl,
    close: () => store.close(),
    get mode() { return store.provider; },
    get dbPath() { return store.dbPath ?? null; },
    get actor() { return actor; },
    get migrations() { return Array.isArray(store.migrations) ? store.migrations : []; },
  };
}
