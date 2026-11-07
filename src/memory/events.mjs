/**
 * pond-check · 能力层 C2：记忆事件记账（src/memory/events.mjs）
 *
 * 记忆的每次调用向 `<POND_HOME>/events.jsonl` 追加一行事件（CAPABILITIES-SPEC
 * §2.3：units = 记忆条数）。事件仍是那八个必备字段打头，诊断层读法不变。
 *
 * 为什么这里不直接用 shared/events.mjs 的 appendAttempt：
 * §3.3 要求「force 跳过闸二必须被记进事件日志」，而 appendAttempt 的字段集是
 * 固定的。这里复用它的 buildAttemptEntry（字段顺序、成本口径、失败归零全部同源），
 * 在**必备八字段与三个诊断附加字段之后**再补记忆层自己的键：
 *
 *   op            remember | recall | forget | export | open
 *   action        created | merged | rejected | recalled | forgotten | missing | exported | degraded
 *   reason        被拒原因（no-kind / low-importance 等），无则缺省
 *   gatesSkipped  force 跳过了哪些闸（[] 表示全闸通过）
 *   retrieval     recall 的相关度来源：fts | scan | none
 *
 * C1 协调事项第 3 条明确说诊断层读者要容忍必备八字段之后的额外键，这里就是
 * 那个「额外键」的正当用法。
 *
 * 事件写入失败只 warn，绝不改变记忆操作的结果（与 shared/events.mjs 同一纪律）。
 * 硬约束：只写 `<POND_HOME>/events.jsonl`；不联网、零依赖、同步写（记忆 API 是同步的）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildAttemptEntry, defaultWarn } from '../shared/events.mjs';
import { eventsFilePath } from '../shared/paths.mjs';

/** 记忆层事件的额外键（放在必备字段之后）。 */
export const MEMORY_EVENT_FIELDS = Object.freeze(['op', 'action', 'reason', 'gatesSkipped', 'retrieval']);

/**
 * 追加一条记忆事件。**永不抛**。
 *
 * @param {object} input
 * @param {string} input.capability 固定 'memory'
 * @param {object|string} input.provider provider 描述或 id
 * @param {number} [input.units]
 * @param {number} [input.durationMs]
 * @param {boolean} [input.ok]
 * @param {string|null} [input.error]
 * @param {number} [input.attempt]
 * @param {string|null} [input.degradedFrom]
 * @param {string} input.op
 * @param {string} input.action
 * @param {string|null} [input.reason]
 * @param {string[]} [input.gatesSkipped]
 * @param {string|null} [input.retrieval]
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.eventsPath] 显式事件文件路径（优先于 env）
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.warn]
 * @returns {{written: boolean, path: string|null, entry: object|null, error: Error|null}}
 */
export function recordMemoryEvent(input = {}, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;

  let entry;
  try {
    entry = buildAttemptEntry(input, options);
    entry.op = typeof input.op === 'string' ? input.op : 'unknown';
    entry.action = typeof input.action === 'string' ? input.action : 'unknown';
    entry.reason = typeof input.reason === 'string' ? input.reason : null;
    entry.gatesSkipped = Array.isArray(input.gatesSkipped) ? [...input.gatesSkipped] : [];
    entry.retrieval = typeof input.retrieval === 'string' ? input.retrieval : null;
  } catch (error) {
    warn(`记忆事件组装失败（不影响记忆结果）：${error?.message ?? error}`);
    return { written: false, path: null, entry: null, error };
  }

  let filePath;
  try {
    filePath = options.eventsPath ?? eventsFilePath(options.env ?? process.env);
  } catch (error) {
    warn(`记忆事件路径解析失败（不影响记忆结果）：${error?.message ?? error}`);
    return { written: false, path: null, entry, error };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return { written: true, path: filePath, entry, error: null };
  } catch (error) {
    warn(`记忆事件写入失败（不影响记忆结果）：${filePath} —— ${error?.message ?? error}`);
    return { written: false, path: filePath, entry, error };
  }
}
