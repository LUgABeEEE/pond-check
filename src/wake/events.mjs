/**
 * pond-check · 能力层 C3：唤醒事件记账（src/wake/events.mjs）
 *
 * 每次 pick 尝试都向 `<POND_HOME>/events.jsonl` 追加一行：真正唤醒（picked）
 * 记录「提了哪条、为什么提、权重多少」，被频率控制拦住（blocked）也记一笔——
 * 否则「她今天为什么一句话都没说」在诊断层上永远是黑盒。
 *
 * 事件是 C1 定义的八个必备字段打头，后面跟 attempt / errorCategory / degradedFrom，
 * 最后是本层自己的键（C1 协调事项第 3 条允许诊断层读者容忍额外键）：
 *
 *   op        固定 'wake'（open 是存储降级时的开库记录）
 *   action    picked | blocked | degraded
 *   reason    人话原因（「重要（5 分）且 9 天未提」/「今日唤醒已达上限（3/3 次）」）
 *   blockedBy 机器可读的拦截原因：daily-limit | min-interval | kind-limit |
 *             no-memories | no-candidates | empty-pool | storage-error
 *   memoryId  被唤醒的记忆 id（blocked 时可能缺省）
 *   kind      记忆类别（用于「同一 kind 每日上限」的重放）
 *   weight    加权随机的权重（可复算：重放事件就能验证选择是否合理）
 *
 * 唤醒是纯本地能力：provider 恒 'wake-local'、成本恒 0（SPEC §2.2）。
 *
 * 事件写入失败只 warn，绝不改变 pick 的结果（与 shared/events、memory/events 同一纪律）。
 * 硬约束：只写 `<POND_HOME>/events.jsonl`；不联网、零依赖、同步写（pick 是同步 API）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildAttemptEntry, defaultWarn } from '../shared/events.mjs';
import { eventsFilePath } from '../shared/paths.mjs';

/** 唤醒 provider id（本地、免费）。 */
export const WAKE_PROVIDER = 'wake-local';

/** 本层事件的额外键（放在必备八字段与三个诊断字段之后）。 */
export const WAKE_EVENT_FIELDS = Object.freeze([
  'op', 'action', 'reason', 'blockedBy', 'memoryId', 'kind', 'weight',
]);

/**
 * 唤醒事件的 provider 描述：本地 → estimateCost 恒 0。
 * 只用于记账，不参与 provider 注册表（唤醒没有降级链：她要么记得，要么不记得）。
 */
export const WAKE_PROVIDER_INFO = Object.freeze({
  id: WAKE_PROVIDER,
  local: true,
  cost: Object.freeze({ unit: 'perCall', value: 0 }),
});

/**
 * 追加一条唤醒事件。**永不抛**。
 *
 * @param {object} input 见文件头（capability 固定由本函数补齐）
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.eventsPath] 显式事件文件路径（优先于 env）
 * @param {() => number} [options.now] 时间基准（测试注入；**事件 ts 跟着它走**）
 * @param {(message: string) => void} [options.warn]
 * @returns {{written: boolean, path: string|null, entry: object|null, error: Error|null}}
 */
export function recordWakeEvent(input = {}, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;

  let entry;
  try {
    entry = buildAttemptEntry({
      ...input,
      capability: 'wake',
      provider: input.provider ?? WAKE_PROVIDER_INFO,
    }, options);
    entry.op = typeof input.op === 'string' ? input.op : 'wake';
    entry.action = typeof input.action === 'string' ? input.action : 'unknown';
    entry.reason = typeof input.reason === 'string' ? input.reason : null;
    entry.blockedBy = typeof input.blockedBy === 'string' ? input.blockedBy : null;
    entry.memoryId = Number.isInteger(input.memoryId) ? input.memoryId : null;
    entry.kind = typeof input.kind === 'string' ? input.kind : null;
    entry.weight = typeof input.weight === 'number' && Number.isFinite(input.weight)
      ? input.weight
      : null;
  } catch (error) {
    warn(`唤醒事件组装失败（不影响唤醒结果）：${error?.message ?? error}`);
    return { written: false, path: null, entry: null, error };
  }

  let filePath;
  try {
    filePath = options.eventsPath ?? eventsFilePath(options.env ?? process.env);
  } catch (error) {
    warn(`唤醒事件路径解析失败（不影响唤醒结果）：${error?.message ?? error}`);
    return { written: false, path: null, entry, error };
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return { written: true, path: filePath, entry, error: null };
  } catch (error) {
    warn(`唤醒事件写入失败（不影响唤醒结果）：${filePath} —— ${error?.message ?? error}`);
    return { written: false, path: filePath, entry, error };
  }
}
