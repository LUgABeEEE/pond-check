/**
 * pond-check · 能力层 C1：成本记账（src/shared/budget.mjs）
 *
 * 账本**不另存一份**：直接从 `events.jsonl` 按时间窗口累加。理由：
 *   - 事件流已经是能力层唯一的写点，再维护一个计数器就会有两份真相；
 *   - 进程随时可以死，计数器会丢，append-only 日志不会；
 *   - 诊断层读同一个文件，用户看到的和实现算的必然是同一份数据。
 *
 * 口径：
 *   - `units` 按能力语义不同（字符数 / 图张数 / 记忆条数），同一能力内可比；
 *   - `costEstimate` 是元，事件里已经写好（本地 provider 恒为 0，见 registry.estimateCost）；
 *   - `spentToday` 按**本地时区**的 00:00:00 起算（用户说「今天花了多少」用的是本地日历）；
 *   - 坏行 / 缺失字段跳过，不让一行脏数据把整本账算崩。
 *
 * 硬约束：只读、不联网、零依赖、永不抛。文件不存在 = 花了 0。
 */

import { readEvents } from './events.mjs';
import { roundCost } from './registry.mjs';

/**
 * 本地时区当天零点（epoch ms）。
 * @param {number} [nowMs]
 * @returns {number}
 */
export function startOfLocalDay(nowMs = Date.now()) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function normalizeCapability(capability) {
  if (capability === undefined || capability === null) return null;
  if (Array.isArray(capability)) {
    const list = capability.filter((item) => typeof item === 'string' && item !== '');
    return list.length === 0 ? null : list;
  }
  return typeof capability === 'string' && capability !== '' ? capability : null;
}

function inCapability(entryCapability, wanted) {
  if (wanted === null) return true;
  if (Array.isArray(wanted)) return wanted.includes(entryCapability);
  return entryCapability === wanted;
}

function emptyResult(capability, since, until) {
  return {
    capability: capability ?? 'all',
    units: 0,
    costEstimate: 0,
    calls: 0,
    okCalls: 0,
    failedCalls: 0,
    since: Number.isFinite(since) ? since : null,
    until: Number.isFinite(until) ? until : null,
  };
}

/**
 * 在 [since, until) 窗口里按能力累加。
 *
 * @param {string|string[]|undefined} capability 能力名（省略 = 全部；数组 = 多种）
 * @param {{since?: number, until?: number, env?: Record<string,string|undefined>, eventsPath?: string}} [options]
 * @returns {{capability: string|string[], units: number, costEstimate: number, calls: number, okCalls: number, failedCalls: number, since: number, until: number}}
 */
export function spentSince(capability, options = {}) {
  const since = Number.isFinite(options.since) ? options.since : -Infinity;
  const until = Number.isFinite(options.until) ? options.until : Infinity;
  const wanted = normalizeCapability(capability);
  const result = emptyResult(wanted, since, until);

  const { entries } = readEvents(options);
  for (const entry of entries) {
    if (!inCapability(entry?.capability, wanted)) continue;
    // 没有合法 ts 的条目无法落进任何时间窗口 —— 跳过（readEvents 已保证是对象）。
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts)) continue;
    if (ts < since || ts >= until) continue;

    const units = typeof entry.units === 'number' && Number.isFinite(entry.units) && entry.units > 0
      ? entry.units
      : 0;
    const cost = typeof entry.costEstimate === 'number' && Number.isFinite(entry.costEstimate) && entry.costEstimate > 0
      ? entry.costEstimate
      : 0;

    result.units += units;
    result.costEstimate += cost;
    result.calls += 1;
    if (entry.ok === true) result.okCalls += 1;
    else result.failedCalls += 1;
  }

  result.costEstimate = roundCost(result.costEstimate);
  return result;
}

/**
 * 今天（本地时区）花了多少。
 * @param {string|string[]|undefined} capability
 * @param {{now?: number, env?: Record<string,string|undefined>, eventsPath?: string}} [options]
 */
export function spentToday(capability, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const dayStart = startOfLocalDay(nowMs);
  return spentSince(capability, {
    since: dayStart,
    until: dayStart + 24 * 60 * 60 * 1000,
    env: options.env,
    eventsPath: options.eventsPath,
  });
}

/**
 * 从有账本以来总共花了多少。
 * @param {string|string[]|undefined} capability
 * @param {{env?: Record<string,string|undefined>, eventsPath?: string}} [options]
 */
export function spentTotal(capability, options = {}) {
  return spentSince(capability, {
    since: -Infinity,
    until: Infinity,
    env: options.env,
    eventsPath: options.eventsPath,
  });
}
