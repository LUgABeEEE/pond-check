/**
 * pond-check · 能力层 C1：路径与家目录（src/shared/paths.mjs）
 *
 * 能力层的所有持久状态都放在一个目录里：默认 `~/.pond/`，可用环境变量
 * `POND_HOME` 覆盖。整目录删掉 = 能力层回到初始状态，诊断层完全不受影响
 * （CAPABILITIES-SPEC §6.3）。
 *
 * 本文件是**唯一**计算这个目录的地方：events / budget 以及后续 C2–C5 都从这里
 * 取路径，避免「事件写 A 处、记账读 B 处」这种静默分叉。
 *
 * 硬约束：
 *   - 不联网、不写盘、无状态 —— 纯函数，只做字符串拼装。
 *   - 每次调用**当场**读 env，不在模块加载时缓存：测试可以临时改 process.env，
 *     不会因为先 import 后设置而读到旧值。
 *   - `POND_HOME` 为空串 / 纯空白时视为未设置（避免 `POND_HOME=` 把数据写到 cwd）。
 *   - 相对路径的 `POND_HOME` 按 `path.resolve` 解析（相对当前工作目录），并在
 *     文档里说清楚 —— 不静默当成 `~` 下的相对路径。
 */

import os from 'node:os';
import path from 'node:path';

/** 能力层默认家目录名（位于用户 home 下）。 */
export const POND_DIR_NAME = '.pond';

/** 事件流文件名（两层唯一接缝）。 */
export const EVENTS_FILE_NAME = 'events.jsonl';

/**
 * 解析能力层家目录。
 * @param {Record<string, string|undefined>} [env] 环境变量（缺省 process.env）
 * @returns {string} 绝对路径
 */
export function resolvePondHome(env = process.env) {
  const custom = typeof env?.POND_HOME === 'string' ? env.POND_HOME.trim() : '';
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), POND_DIR_NAME);
}

/**
 * 事件流绝对路径（`<POND_HOME>/events.jsonl`）。
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function eventsFilePath(env = process.env) {
  return path.join(resolvePondHome(env), EVENTS_FILE_NAME);
}
