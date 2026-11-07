/**
 * pond-check · 能力层 C3：加权唤醒（src/wake/wake.mjs）
 *
 * SPEC §3.5 的唯一入口。两个动作：
 *
 *   pick({ now, budget })           现在要不要提一件事？提哪件？→ { memory, reason } | null
 *   schedule({ from, until })       预排一段时间里的唤醒点 → [{ at, memory, reason }]
 *
 * **不是随机，是加权随机**（权重与候选池见 weights.mjs）：
 * 纯随机会让她今天提三次猫、明天一次不提；加权随机会让重要的事和很久没提的事
 * 自己浮上来，同时下面的频率控制兜住「一天喋喋不休」。
 *
 * pick 是**有副作用**的决策：选中即视为「提了这一次」——
 *   - 追加一条 action='picked' 的唤醒事件（频率控制的唯一历史来源）；
 *   - 刷新记忆行的 last_recalled / recall_count（下次的 24h 静默与 silence 因子）。
 * 被频率控制拦住时返回 null，并记一条 blocked 事件（「今天为什么没说话」可追溯）。
 *
 * schedule 是**纯预排**：不写事件、不改库。它在内部沿虚拟时间线模拟 pick ——
 * 每预排一次就把虚拟记忆的 last_recalled 推后，因此同一条记忆不会在同一天
 * 被排两次，频率控制（3 次/天、4 小时间隔、同 kind 2 次/天）也照样生效。
 *
 * 降级链：
 *   - node:sqlite 打不开 → 记忆层的易失后端接手（会话内仍可唤醒），事件记两条尝试；
 *   - 存储列表失败 → 本次返回 null + blocked(storage-error) 事件，不炸调用方；
 *   - 计数写入失败 / 事件写不进去 → 只 warn，唤醒结果不变。
 *
 * 硬约束：只读记忆库、只写 <POND_HOME>/events.jsonl；不联网、零依赖。
 */

import { SQLITE_PROVIDER, openStore } from '../memory/index.mjs';
import { blockedReasonText, frequencyAt, readWakeHistory } from './frequency.mjs';
import { recordWakeEvent, WAKE_PROVIDER, WAKE_PROVIDER_INFO } from './events.mjs';
import {
  blockedReasonFor,
  candidatePool,
  mergeLimits,
  nextEligibleAt,
  normalizeLimits,
  WEIGHT_FORMULA,
  RECENCY_FORMULA,
  SILENCE_FORMULA,
  weightedPick,
  DAY_MS,
  HOUR_MS,
} from './weights.mjs';
import { startOfLocalDay } from '../shared/budget.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveNow(now) {
  if (typeof now === 'function') {
    return () => {
      const value = now();
      if (!Number.isFinite(value)) {
        throw new TypeError(`now() 必须返回有限的 epoch ms，收到 ${JSON.stringify(value)}`);
      }
      return value;
    };
  }
  if (Number.isFinite(now)) return () => now;
  return () => Date.now();
}

function assertEpochMs(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} 必须是有限的 epoch ms，收到 ${JSON.stringify(value)}`);
  }
}

/**
 * 创建一个唤醒实例。
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] 环境变量（缺省 process.env）
 * @param {string} [options.dbPath] 记忆库路径（缺省 <POND_HOME>/memory.db）
 * @param {string} [options.eventsPath] 事件文件路径（缺省 <POND_HOME>/events.jsonl）
 * @param {object} [options.store] 注入存储（用于测试 / 复用已有连接）
 * @param {number|() => number} [options.now] 时间基准（测试注入）
 * @param {() => number} [options.random] 加权随机源（测试注入）
 * @param {object} [options.limits] 覆盖 WAKE_DEFAULTS 的频率/候选参数
 * @param {(message: string) => void} [options.warn] 告警出口
 */
export function createWake(options = {}) {
  const env = options.env ?? process.env;
  const now = resolveNow(options.now);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const warn = typeof options.warn === 'function'
    ? (message) => options.warn(String(message))
    : (message) => console.warn(`[pond/wake] ${message}`);
  const limits = normalizeLimits(options.limits ?? {});
  const eventBase = { env, warn };
  if (options.eventsPath) eventBase.eventsPath = options.eventsPath;

  let openedHere = false;
  let store;
  if (options.store) {
    store = options.store;
  } else {
    const opened = openStore({ env, dbPath: options.dbPath });
    store = opened.store;
    openedHere = true;
    if (opened.degraded) {
      // 降级链的两个尝试都记账：失败的 sqlite + 接手的易失后端（带 degradedFrom）。
      recordWakeEvent({
        op: 'open',
        action: 'degraded',
        provider: { id: SQLITE_PROVIDER, local: true, cost: { unit: 'perCall', value: 0 } },
        units: 0,
        ok: false,
        error: opened.degraded.error?.message ?? String(opened.degraded.error),
        errorCategory: 'storage',
        attempt: 1,
        reason: 'storage-open-failed',
      }, { ...eventBase, now });
      recordWakeEvent({
        op: 'open',
        action: 'degraded',
        provider: WAKE_PROVIDER_INFO,
        units: 0,
        ok: true,
        attempt: 2,
        degradedFrom: SQLITE_PROVIDER,
        reason: 'storage-open-failed',
      }, { ...eventBase, now });
    }
  }

  function eventOptions(currentNow) {
    return { ...eventBase, now: () => currentNow };
  }

  /**
   * 记录一条「没有唤醒」的事件。永不抛。
   * @param {object} input
   * @param {number} currentNow
   */
  function recordBlocked(input, currentNow) {
    recordWakeEvent({
      op: 'wake',
      action: 'blocked',
      units: 0,
      ok: input.ok !== false,
      error: input.error ?? null,
      errorCategory: input.errorCategory ?? null,
      durationMs: input.durationMs ?? 0,
      reason: input.reason,
      blockedBy: input.blockedBy,
      memoryId: input.memoryId,
      kind: input.kind,
      weight: input.weight,
    }, eventOptions(currentNow));
  }

  /**
   * 应用调用方传入的预算。两种写法：
   *   pick({ budget: 2 })                     → 今天**还剩 2 次**（含本次）
   *   pick({ budget: { dailyLimit: 5 } })     → 参数覆盖（绝对上限）
   *
   * @param {object} base 实例参数
   * @param {number|object|undefined|null} budget
   * @param {number} todayCount 今天已唤醒次数
   * @returns {object} 有效参数
   */
  function applyBudget(base, budget, todayCount) {
    if (budget === undefined || budget === null) return base;
    if (typeof budget === 'number') {
      if (!Number.isFinite(budget) || budget < 0) {
        throw new TypeError(`pick 的 budget 必须是非负数字，收到 ${JSON.stringify(budget)}`);
      }
      return { ...base, dailyLimit: todayCount + Math.floor(budget) };
    }
    if (isPlainObject(budget)) return mergeLimits(base, budget);
    throw new TypeError(`pick 的 budget 必须是数字或对象，收到 ${JSON.stringify(budget)}`);
  }

  /**
   * 现在要不要唤醒。
   *
   * @param {{now?: number, budget?: number|object}} [input]
   * @returns {{memory: object, reason: string, weight: number, why: object}|null}
   */
  function pick(input = {}) {
    const startedAt = Date.now();
    const currentNow = input.now === undefined ? now() : input.now;
    assertEpochMs(currentNow, 'pick 的 now');
    const history = readWakeHistory(eventBase);

    // 先用实例参数看今天用了多少，再把 budget 叠上去（数字 budget 需要 todayCount）。
    const baseFreq = frequencyAt(history, currentNow, limits);
    const effective = applyBudget(limits, input.budget, baseFreq.todayCount);
    const freq = frequencyAt(history, currentNow, effective);

    if (!freq.allowed) {
      recordBlocked({
        blockedBy: freq.blockedBy,
        reason: blockedReasonText(freq.blockedBy, freq, currentNow),
        durationMs: Date.now() - startedAt,
      }, currentNow);
      return null;
    }

    let rows;
    try {
      rows = store.list({ includeArchived: true });
    } catch (error) {
      const message = error?.message ?? String(error);
      warn(`读取记忆失败（本次不唤醒）：${message}`);
      recordBlocked({
        blockedBy: 'storage-error',
        reason: `读取记忆失败：${message}`,
        ok: false,
        error: message,
        errorCategory: 'storage',
        durationMs: Date.now() - startedAt,
      }, currentNow);
      return null;
    }

    const { candidates, filtered } = candidatePool(rows, currentNow, effective, {
      kindCounts: freq.kindCounts,
    });

    if (candidates.length === 0) {
      const blockedBy = blockedReasonFor(filtered);
      recordBlocked({
        blockedBy,
        reason: blockedBy === 'kind-limit'
          ? `今天这些类别都提过了（每类上限 ${effective.perKindDailyLimit} 次）`
          : '当前没有可唤醒的记忆（太新 / 太久 / 不重要 / 已归档）',
        durationMs: Date.now() - startedAt,
      }, currentNow);
      return null;
    }

    const chosen = weightedPick(candidates, random);
    if (chosen === null) {
      recordBlocked({
        blockedBy: 'empty-pool',
        reason: '候选权重全为 0，无法加权选择',
        durationMs: Date.now() - startedAt,
      }, currentNow);
      return null;
    }

    // 选中即「提过这一次」：刷新 last_recalled 让 24h 静默与 silence 生效。
    // 计数失败只影响下一次的权重，不该让她这次说不出话。
    try {
      store.bumpRecall([chosen.id], currentNow);
    } catch (error) {
      warn(`唤醒计数写入失败（不影响本次唤醒）：${error?.message ?? error}`);
    }

    recordWakeEvent({
      op: 'wake',
      action: 'picked',
      provider: WAKE_PROVIDER_INFO,
      units: 1,
      ok: true,
      durationMs: Date.now() - startedAt,
      reason: chosen.reason,
      memoryId: chosen.id,
      kind: chosen.kind,
      weight: chosen.weight,
    }, eventOptions(currentNow));

    return {
      memory: chosen.row,
      reason: chosen.reason,
      weight: chosen.weight,
      why: {
        formula: WEIGHT_FORMULA,
        recencyFormula: RECENCY_FORMULA,
        silenceFormula: SILENCE_FORMULA,
        importance: chosen.importance,
        recency: chosen.recency,
        silence: chosen.silence,
        weight: chosen.weight,
        daysSinceCreated: chosen.daysSinceCreated,
        daysSinceRecalled: chosen.daysSinceRecalled,
        halfLifeDays: chosen.halfLifeDays,
        candidateCount: candidates.length,
        todayCount: freq.todayCount,
        dailyLimit: effective.dailyLimit,
      },
    };
  }

  /**
   * 预排 [from, until) 里的唤醒点。**不写事件、不改库**。
   *
   * 时间线语义：第一个唤醒点最早是 `from`；之后每次至少间隔
   * `minIntervalHours`；每天（本地时区）最多 `dailyLimit` 次；同一 kind
   * 每天最多 `perKindDailyLimit` 次。预排时同步推进虚拟的 last_recalled，
   * 所以同一条记忆不会在 24h 内被排两次。
   *
   * @param {{from?: number, until?: number}} [input]
   * @returns {{at: number, memory: object, reason: string, weight: number}[]}
   */
  function schedule(input = {}) {
    const from = input.from === undefined ? now() : input.from;
    assertEpochMs(from, 'schedule 的 from');
    const until = input.until === undefined ? startOfLocalDay(from) + DAY_MS : input.until;
    assertEpochMs(until, 'schedule 的 until');
    if (until < from) {
      throw new TypeError(`schedule 的 until（${until}）不能早于 from（${from}）`);
    }
    if (until === from) return [];

    const history = readWakeHistory(eventBase);

    let rows;
    try {
      rows = store.list({ includeArchived: true });
    } catch (error) {
      const message = error?.message ?? String(error);
      warn(`读取记忆失败（无法预排唤醒）：${message}`);
      recordBlocked({
        blockedBy: 'storage-error',
        reason: `读取记忆失败：${message}`,
        ok: false,
        error: message,
        errorCategory: 'storage',
      }, from);
      return [];
    }

    // 虚拟记忆状态：预排中刷新 last_recalled，但不落库。
    const virtual = new Map();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      virtual.set(row.id, { ...row });
    }

    const intervalMs = effectiveIntervalMs(limits);
    const stepMs = limits.scheduleStepMinutes * 60 * 1000;
    const planned = [];
    let cursor = from;
    let iterations = 0;

    while (cursor < until) {
      if (iterations >= 100000) {
        warn('预排唤醒达到迭代上限，提前停止（检查 from/until 跨度是否异常）');
        break;
      }
      iterations += 1;

      const freq = frequencyAt(history, cursor, limits);
      if (!freq.allowed) {
        let next = freq.blockedBy === 'daily-limit'
          ? startOfLocalDay(cursor) + DAY_MS
          : freq.nextAllowedAt;
        if (!Number.isFinite(next) || next <= cursor) next = cursor + stepMs;
        cursor = next;
        continue;
      }

      const { candidates, filtered } = candidatePool([...virtual.values()], cursor, limits, {
        kindCounts: freq.kindCounts,
      });

      if (candidates.length === 0) {
        if (filtered.kindLimit > 0) {
          // 所有能提的 kind 今天都到顶了：跳到下一个本地零点，别再空转。
          cursor = startOfLocalDay(cursor) + DAY_MS;
          continue;
        }
        if (filtered.recentlyRecalled > 0) {
          // 「只是太新」不是永久出局：跳到最早恢复够格的时刻（last_recalled + 静默期），
          // 否则跨天预排会在第一个 24h 空窗上提前收工。
          const readyAt = nextEligibleAt([...virtual.values()], cursor, limits, {
            kindCounts: freq.kindCounts,
          });
          if (readyAt !== null && readyAt > cursor) {
            cursor = readyAt;
            continue;
          }
        }
        break; // 记忆池本身空了 / 都过期了：后面也不会再有变化
      }

      const chosen = weightedPick(candidates, random);
      if (chosen === null) break;

      planned.push({
        at: cursor,
        memory: chosen.row,
        reason: chosen.reason,
        weight: chosen.weight,
      });
      history.push({ ts: cursor, memoryId: chosen.id, kind: chosen.kind });
      const previous = virtual.get(chosen.id);
      virtual.set(chosen.id, {
        ...previous,
        lastRecalled: cursor,
        recallCount: (Number(previous.recallCount) || 0) + 1,
      });

      cursor += intervalMs > 0 ? intervalMs : stepMs;
    }

    return planned;
  }

  return {
    pick,
    schedule,
    close: () => {
      // 注入的 store 归调用方所有；自己开的才自己关。
      if (openedHere) store.close();
    },
    get mode() { return store.provider; },
    get provider() { return store.provider; },
    get limits() { return { ...limits }; },
    get wakeProvider() { return WAKE_PROVIDER; },
    get store() { return store; },
  };
}

function effectiveIntervalMs(limits) {
  return limits.minIntervalHours * HOUR_MS;
}
