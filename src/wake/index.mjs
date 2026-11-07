/**
 * pond-check · 能力层 C3：加权唤醒总入口（src/wake/index.mjs）
 *
 *   import { createWake, pick } from 'pond-check/wake';
 *
 * 两种用法（与 C2 记忆层一致）：
 *   createWake()   长驻实例（进程里只开一次记忆库，pick/schedule 反复调用）
 *   pick(...)      一次性便捷函数：每次开一次库、用完即关
 *
 * 导出面（任务书口径）：pick({ now, budget }) → { memory, reason } | null
 *                        schedule({ from, until }) → [{ at, memory }]
 * 顺带导出纯函数与常量（weights / frequency），让上层与测试能解释「为什么提这条」：
 *   computeWeight / candidatePool / weightedPick / buildReason / normalizeLimits
 *   frequencyAt / readWakeHistory / WAKE_DEFAULTS / WEIGHT_FORMULA
 *
 * 隐私与边界（SPEC §3.6 / §6.1）：
 *   - 只读 <POND_HOME>/memory.db、只写 <POND_HOME>/events.jsonl；
 *   - 不 import 诊断层（check / read / evaluate / render / discover / cli）；
 *   - 不联网、零依赖；没有同步、没有遥测。
 */

import { createWake } from './wake.mjs';

export { createWake } from './wake.mjs';
export {
  HOUR_MS,
  DAY_MS,
  WEIGHT_FORMULA,
  RECENCY_FORMULA,
  SILENCE_FORMULA,
  WAKE_DEFAULTS,
  WAKE_LIMIT_KEYS,
  normalizeLimits,
  mergeLimits,
  computeWeight,
  buildReason,
  classifyRow,
  candidatePool,
  nextEligibleAt,
  blockedReasonFor,
  weightedPick,
} from './weights.mjs';
export {
  WAKE_CAPABILITY,
  wakeHistoryFromEntries,
  readWakeHistory,
  nextLocalDayStart,
  frequencyAt,
  kindAtCap,
  blockedReasonText,
} from './frequency.mjs';
export {
  WAKE_PROVIDER,
  WAKE_PROVIDER_INFO,
  WAKE_EVENT_FIELDS,
  recordWakeEvent,
} from './events.mjs';

/**
 * 一次性唤醒决策（便捷入口；不保留实例）。
 * @param {{now?: number, budget?: number|object, env?: object, dbPath?: string,
 *          eventsPath?: string, store?: object, random?: () => number, limits?: object,
 *          warn?: (message: string) => void}} [options]
 * @returns {{memory: object, reason: string, weight: number, why: object}|null}
 */
export function pick(options = {}) {
  const wake = createWake(options);
  try {
    return wake.pick({ now: options.now, budget: options.budget });
  } finally {
    wake.close();
  }
}

/**
 * 一次性预排（便捷入口；不保留实例，也不落任何状态）。
 * @param {{from?: number, until?: number, env?: object, dbPath?: string,
 *          eventsPath?: string, store?: object, random?: () => number,
 *          limits?: object, warn?: (message: string) => void}} [options]
 * @returns {{at: number, memory: object, reason: string, weight: number}[]}
 */
export function schedule(options = {}) {
  const wake = createWake(options);
  try {
    return wake.schedule({ from: options.from, until: options.until });
  } finally {
    wake.close();
  }
}
