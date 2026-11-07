/**
 * pond-check · 能力层 C1：共享基座总入口（src/shared/index.mjs）
 *
 * 五个能力都建在这四件事上：
 *
 *   registry  每个能力有若干 provider，按 priority 排成降级链
 *   events    每次尝试追加一行到 `~/.pond/events.jsonl`（唯一的层间接缝）
 *   budget    从事件流按时间窗口累计 units / costEstimate
 *   call      统一调用器：超时 / 重试 / 降级 / 记账 / CapabilityError
 *
 * 典型用法（C2–C6 的适配器照着写）：
 *
 *   import { createRegistry, invoke, spentToday } from '../shared/index.mjs';
 *
 *   const registry = createRegistry();
 *   registry.register('tts', {
 *     id: 'edge', name: 'Edge TTS', local: true,
 *     requires: ['network'], cost: { unit: 'perKChar', value: 0 },
 *     caps: ['mp3'], priority: 50,
 *     run: async (args, { signal }) => callEdgeTts(args.text, { signal }),
 *   });
 *
 *   const result = await invoke({
 *     capability: 'tts',
 *     args: { text: '你好' },
 *     providers: registry.resolve('tts'),
 *     units: ({ value }) => value.chars,
 *   });
 *   // result = { ok, provider, value, degradedFrom, attempts, units, costEstimate, durationMs }
 *   // 全失败会抛 CapabilityError，err.failures 里是每个 provider 的原因。
 *
 * 硬约束（与诊断层隔离）：
 *   - 这里不 import `../read`、`../evaluate`、`../render`、`../discover`、`../check`；
 *   - 这里也不 import 任何网络模块，`fetch` 只出现在 C4/C5 的 adapter 里；
 *   - 所有状态都在 `<POND_HOME>`（默认 `~/.pond`），删掉即回到初始状态。
 */

export * from './paths.mjs';
export * from './registry.mjs';
export * from './events.mjs';
export * from './budget.mjs';
export * from './call.mjs';
