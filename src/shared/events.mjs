/**
 * pond-check · 能力层 C1：事件流（src/shared/events.mjs）
 *
 * 每次调用（更准确地说：每次**尝试**）向 `~/.pond/events.jsonl` 追加一行 JSON：
 *
 *   { ts, capability, provider, units, costEstimate, durationMs, ok, error }
 *
 * 这是能力层与诊断层之间的**唯一接缝**（CAPABILITIES-SPEC §6.1）：
 *   - 能力层只写这个文件，不 import 诊断层任何代码；
 *   - 诊断层只读这个文件，不 import 能力层任何代码。
 *
 * 规则：
 *   1. **append-only**：只追加，不轮转、不重写、不删除。文件坏了/太大了是运维
 *      的事，不是实现偷偷改历史的事。
 *   2. **写入失败只 warn**：磁盘满、目录不可写、POND_HOME 指到文件上……
 *      一律吞掉并 `console.warn`，绝不改变调用结果。能力层不能因为记账失败
 *      就让用户听不到语音 / 拿不到图。
 *   3. **一次尝试一行**：降级链里有几个 provider 尝试过就写几行，失败尝试的
 *      `units`/`costEstimate` 恒为 0。只记赢家会让「降级」在诊断层上变成黑盒。
 *   4. `ts` 用 ISO-8601 字符串（人可读、时区明确、Diagnostics 直接能排）。
 *
 * 硬约束：不联网、零依赖、不抛（连 JSON 循环引用这种编程错误也只 warn）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { eventsFilePath } from './paths.mjs';
import { estimateCost, roundCost } from './registry.mjs';

/** 事件必备字段及顺序（测试与诊断层都按这个顺序读）。 */
export const EVENT_FIELDS = Object.freeze([
  'ts', 'capability', 'provider', 'units', 'costEstimate', 'durationMs', 'ok', 'error',
]);

/** 默认告警出口；测试传 `warn` 捕获，不污染输出。 */
export function defaultWarn(message) {
  console.warn(`[pond/events] ${message}`);
}

function safeNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function providerId(provider) {
  if (typeof provider === 'string') return provider;
  if (provider && typeof provider.id === 'string') return provider.id;
  return 'unknown';
}

/**
 * 组装一条事件（纯函数，不写盘）。
 * @param {object} input
 * @param {string} input.capability
 * @param {object|string} input.provider provider 描述（用来算成本与取 id）或纯 id
 * @param {number} [input.units]
 * @param {number} [input.costEstimate] 显式成本（缺省按 provider 描述估算）
 * @param {number} [input.durationMs]
 * @param {boolean} [input.ok]
 * @param {string|null} [input.error]
 * @param {string|null} [input.errorCategory]
 * @param {number} [input.attempt]
 * @param {string|null} [input.degradedFrom]
 * @param {{now?: () => number}} [options]
 * @returns {object} 事件对象
 */
export function buildAttemptEntry(input = {}, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const capability = typeof input.capability === 'string' ? input.capability : 'unknown';
  const units = Math.max(0, safeNumber(input.units, 0));
  const ok = input.ok === true;
  const explicitCost = input.costEstimate;
  const costEstimate = Number.isFinite(explicitCost)
    ? roundCost(explicitCost)
    : estimateCost(input.provider, units);

  const entry = {
    ts: new Date(safeNumber(now(), Date.now())).toISOString(),
    capability,
    provider: providerId(input.provider),
    // 失败尝试没有产出任何东西：units 与 costEstimate 一律归零。
    // （这条是硬不变量：否则降级链会把「试了三个 provider」记成三倍用量。）
    units: ok ? units : 0,
    costEstimate: ok ? costEstimate : 0,
    durationMs: Math.max(0, safeNumber(input.durationMs, 0)),
    ok,
    error: typeof input.error === 'string' ? input.error : (input.error ? String(input.error.message ?? input.error) : null),
    // 以下为诊断层友好的附加字段（规格要求的八个字段是前缀，顺序不变）。
    attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
    errorCategory: ok ? null : (input.errorCategory ?? null),
    degradedFrom: typeof input.degradedFrom === 'string' ? input.degradedFrom : null,
  };
  return entry;
}

/**
 * 追加一条尝试事件。**永不抛**。
 *
 * @param {object} input 见 buildAttemptEntry
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] 环境变量（缺省 process.env）
 * @param {string} [options.eventsPath] 显式事件文件路径（优先于 env）
 * @param {() => number} [options.now] 时间基准（测试注入）
 * @param {(message: string) => void} [options.warn] 告警出口
 * @returns {Promise<{written: boolean, path: string|null, entry: object|null, error: Error|null}>}
 */
export async function appendAttempt(input = {}, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;

  let entry;
  try {
    entry = buildAttemptEntry(input, options);
  } catch (error) {
    warn(`事件组装失败（不影响调用结果）：${error?.message ?? error}`);
    return { written: false, path: null, entry: null, error };
  }

  let filePath;
  try {
    filePath = options.eventsPath ?? eventsFilePath(options.env ?? process.env);
  } catch (error) {
    warn(`事件路径解析失败（不影响调用结果）：${error?.message ?? error}`);
    return { written: false, path: null, entry, error };
  }

  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return { written: true, path: filePath, entry, error: null };
  } catch (error) {
    warn(`事件写入失败（不影响调用结果）：${filePath} —— ${error?.message ?? error}`);
    return { written: false, path: filePath, entry, error };
  }
}

/**
 * 读事件流（同步，供 budget 与诊断侧测试用）。**永不抛**。
 *
 * 坏行（半行写入 / 手工破坏）跳过并计入 `skippedLines`，不让一行脏数据把
 * 整个账本废掉。
 *
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.eventsPath]
 * @returns {{path: string, entries: object[], skippedLines: number, missing: boolean, error: Error|null}}
 */
export function readEvents(options = {}) {
  const filePath = options.eventsPath ?? eventsFilePath(options.env ?? process.env);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      path: filePath,
      entries: [],
      skippedLines: 0,
      missing: error?.code === 'ENOENT',
      error,
    };
  }

  const entries = [];
  let skippedLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skippedLines += 1;
      continue;
    }
    entries.push(parsed);
  }
  return { path: filePath, entries, skippedLines, missing: false, error: null };
}
