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
 *   op            remember | recall | forget | purge | export | open | migrate | set-importance
 *   action        created | merged | rejected | recalled | archived | already-archived | missing
 *                 | purged | exported | degraded | migrated | updated
 *   reason        被拒原因（no-kind / low-importance / importance-quota-full 等），无则缺省
 *   gatesSkipped  force 跳过了哪些闸（[] 表示全闸通过）
 *   retrieval     recall 的相关度来源：fts | scan | none
 *   degradationChannel recall 的降级通道：keyword-only | fts-unavailable | scan-fallback
 *   actor         谁做的（本地能力恒 'local'，purge 可由调用方覆盖）——审计用
 *   irreversible  purge 专用：true 表示这一步删掉的东西回不来
 *   deleted       purge 专用：被删内容的摘要（id / kind / 摘要 / sha256 前 16 位 / 时间）
 *   migrations    open/migrate 专用：本次执行的 schema 迁移列表
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
export const MEMORY_EVENT_FIELDS = Object.freeze([
  'op', 'action', 'reason', 'gatesSkipped', 'retrieval',
  'degradationChannel', 'actor', 'irreversible', 'deleted', 'migrations',
]);

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
 * @param {string|null} [input.degradationChannel]
 * @param {string|null} [input.actor]
 * @param {boolean} [input.irreversible]
 * @param {object|null} [input.deleted] 被删内容的摘要（purge 审计）
 * @param {object[]|null} [input.migrations]
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
    entry.degradationChannel = typeof input.degradationChannel === 'string' ? input.degradationChannel : null;
    // 审计字段：purge 是**不可逆**操作，必须记下「谁、什么时候、删了什么摘要」。
    // 事件本身仍是 append-only，写失败只 warn（不改变删除结果），但字段一定齐全。
    entry.actor = typeof input.actor === 'string' ? input.actor : null;
    entry.irreversible = input.irreversible === true;
    entry.deleted = input.deleted && typeof input.deleted === 'object' ? { ...input.deleted } : null;
    entry.migrations = Array.isArray(input.migrations) ? input.migrations.map((item) => ({ ...item })) : [];
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
