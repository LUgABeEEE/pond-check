/**
 * pond-check · 能力层 C3：频率控制（src/wake/frequency.mjs）
 *
 * SPEC §3.5 的三条频率约束：
 *   - 每日上限：默认 3 次
 *   - 两次唤醒最少间隔：默认 4 小时
 *   - 同一 kind 每日上限：默认 2 次
 *
 * 历史从哪来？**从事件流来，不另存计数器**——与 C1 budget 同一条纪律：
 *   - events.jsonl 已经是能力层唯一的写点，再维护一份计数器就是两份真相；
 *   - 进程随时会死，计数器会丢，append-only 日志不会；
 *   - 诊断层读同一个文件，用户看到的和实现算的必然是同一份数据。
 *
 * 只认 `capability === 'wake' && action === 'picked' && ok !== false` 的事件：
 * memory 的 recall 事件、唤醒被拦截（blocked）的记录都不占唤醒预算。
 *
 * 「今天」按**本地时区**零点切（和 budget.spentToday 一致）——用户说「今天提了几次」
 * 用的是本地日历，不是 UTC。坏行 / 缺字段的事件跳过，不让一行脏数据把频率算崩。
 *
 * 硬约束：只读事件流、不联网、零依赖、永不抛。
 */

import { readEvents } from '../shared/events.mjs';
import { startOfLocalDay } from '../shared/budget.mjs';
import { DAY_MS, HOUR_MS, WAKE_DEFAULTS } from './weights.mjs';

/** 本层在事件流里的能力名。 */
export const WAKE_CAPABILITY = 'wake';

function finiteTimestamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 从任意事件数组里筛出「真正发生过的唤醒」，按时间升序。
 *
 * @param {object[]} entries readEvents().entries 或测试手写的事件
 * @returns {{ts:number, memoryId:number, kind:string|null}[]}
 */
export function wakeHistoryFromEntries(entries) {
  const history = [];
  if (!Array.isArray(entries)) return history;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.capability !== WAKE_CAPABILITY) continue;
    if (entry.action !== 'picked') continue;
    if (entry.ok === false) continue;
    const ts = finiteTimestamp(entry.ts);
    if (ts === null) continue;
    const memoryId = Number(entry.memoryId);
    if (!Number.isFinite(memoryId)) continue;
    history.push({
      ts,
      memoryId,
      kind: typeof entry.kind === 'string' && entry.kind !== '' ? entry.kind : null,
    });
  }
  return history.sort((a, b) => a.ts - b.ts);
}

/**
 * 读 <POND_HOME>/events.jsonl 里的唤醒历史。文件缺失 / 坏行都只是「没有历史」。
 *
 * @param {{env?: Record<string,string|undefined>, eventsPath?: string}} [options]
 * @returns {{ts:number, memoryId:number, kind:string|null}[]}
 */
export function readWakeHistory(options = {}) {
  let entries = [];
  try {
    entries = readEvents(options).entries;
  } catch {
    entries = [];
  }
  return wakeHistoryFromEntries(entries);
}

/**
 * 下一次本地零点（每日上限触顶后的最早可唤醒时刻）。
 * @param {number} nowMs
 * @returns {number}
 */
export function nextLocalDayStart(nowMs) {
  return startOfLocalDay(nowMs) + DAY_MS;
}

/**
 * 在某个时刻的唤醒预算状态。
 *
 * @param {{ts:number, memoryId:number, kind:string|null}[]} history
 * @param {number} now epoch ms
 * @param {object} [limits] normalizeLimits 的结果
 * @returns {{allowed:boolean, blockedBy:'daily-limit'|'min-interval'|null,
 *            nextAllowedAt:number|null, todayCount:number, dailyLeft:number,
 *            lastWakeAt:number|null, kindCounts:Record<string,number>,
 *            sinceLastWakeMs:number|null, minIntervalMs:number,
 *            dayStart:number, dayEnd:number, dailyLimit:number,
 *            perKindDailyLimit:number}}
 */
export function frequencyAt(history, now, limits = WAKE_DEFAULTS) {
  const nowMs = Number(now);
  const dayStart = startOfLocalDay(nowMs);
  const dayEnd = dayStart + DAY_MS;
  const minIntervalMs = limits.minIntervalHours * HOUR_MS;

  // 只看「已经发生」的唤醒：未来时间戳（时钟漂移 / 手写事件）不占当前预算。
  const past = (Array.isArray(history) ? history : []).filter((entry) => entry && entry.ts <= nowMs);
  const today = past.filter((entry) => entry.ts >= dayStart && entry.ts < dayEnd);

  const kindCounts = {};
  for (const entry of today) {
    if (typeof entry.kind !== 'string') continue;
    kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;
  }

  let lastWakeAt = null;
  for (const entry of past) {
    if (lastWakeAt === null || entry.ts > lastWakeAt) lastWakeAt = entry.ts;
  }
  const sinceLastWakeMs = lastWakeAt === null ? null : nowMs - lastWakeAt;
  const dailyLeft = Math.max(0, limits.dailyLimit - today.length);

  let blockedBy = null;
  let nextAllowedAt = null;
  if (dailyLeft <= 0) {
    blockedBy = 'daily-limit';
    nextAllowedAt = nextLocalDayStart(nowMs);
  } else if (lastWakeAt !== null && nowMs - lastWakeAt < minIntervalMs) {
    blockedBy = 'min-interval';
    nextAllowedAt = lastWakeAt + minIntervalMs;
  }

  return {
    allowed: blockedBy === null,
    blockedBy,
    nextAllowedAt,
    todayCount: today.length,
    dailyLeft,
    lastWakeAt,
    kindCounts,
    sinceLastWakeMs,
    minIntervalMs,
    dayStart,
    dayEnd,
    dailyLimit: limits.dailyLimit,
    perKindDailyLimit: limits.perKindDailyLimit,
  };
}

/**
 * 某个 kind 今天是否已经触顶。
 * @param {Record<string, number>} kindCounts
 * @param {string} kind
 * @param {number} perKindDailyLimit
 * @returns {boolean}
 */
export function kindAtCap(kindCounts, kind, perKindDailyLimit) {
  return (kindCounts?.[kind] ?? 0) >= perKindDailyLimit;
}

/**
 * 把拦截原因翻译成人话（进事件与返回值，用户能看懂为什么今天不说话）。
 *
 * @param {'daily-limit'|'min-interval'} blockedBy
 * @param {object} freq frequencyAt 的结果
 * @param {number} now epoch ms
 * @returns {string}
 */
export function blockedReasonText(blockedBy, freq, now) {
  if (blockedBy === 'daily-limit') {
    return `今日唤醒已达上限（${freq.todayCount}/${freq.dailyLimit} 次）`;
  }
  if (blockedBy === 'min-interval') {
    const waitMs = Math.max(0, (freq.nextAllowedAt ?? now) - now);
    return `距上次唤醒不足 ${Math.round((freq.minIntervalMs / HOUR_MS) * 100) / 100} 小时（还需 ${Math.ceil(waitMs / 60000)} 分钟）`;
  }
  return '唤醒被拦截';
}
