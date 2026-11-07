/**
 * pond-check · 能力层 C1：统一调用器（src/shared/call.mjs）
 *
 * 五个能力共用同一条调用链（CAPABILITIES-SPEC §2.2 / §2.4）：
 *
 *   调用 → 候选链（registry.resolve 已按 priority 排好）→ 逐个尝试
 *        → 成功：返回结果 + 记账 + `degradedFrom`
 *        → 失败：记账，按错误类别决定「同一 provider 重试」还是「直接降级」
 *        → 全部失败：抛 CapabilityError，**带每个 provider 的失败原因**
 *
 * 超时（单次尝试）：
 *   tts 30s / image 180s / memory 2s，其它能力缺省 30s（CAPABILITY_TIMEOUTS）。
 *
 * 重试：
 *   - 仅**网络类**错误重试，最多 1 次，指数退避 500ms（第 1 次失败等 500ms）；
 *   - 鉴权类（401/403）**不重试**，直接降级到下一个 provider；
 *   - 超时、额度（429）、格式错误都不重试：它们再试一次只会把同样的等待翻倍，
 *     正确反应是「换下一个 provider」而不是「再等一遍」。
 *
 * 为什么超时不重试要说清楚：30s 的 TTS 超时已经吃掉一次完整预算，再重试就是
 * 60s；用户等不起，而降级到本地命令 1s 就出结果了。
 *
 * 硬约束：
 *   - 本文件不联网、不 import 任何网络模块（`fetch` 由 C4/C5 的 adapter 自己调，
 *     这样共享层保持离线可测）。
 *   - 事件写入失败**不影响返回值**（appendAttempt 永不抛，这里再兜一层，
 *     防止调用方传入的 warn 自己炸）。
 *   - 编程错误（provider 没给 run、capability 为空）抛 TypeError，不伪装成
 *     「能力不可用」——那会把实现 bug 藏进降级链里。
 */

import { estimateCost } from './registry.mjs';
import { appendAttempt, defaultWarn } from './events.mjs';

/** 单次调用超时（毫秒）。规格 §2.4 的三个数字，改这里就是改全局。 */
export const CAPABILITY_TIMEOUTS = Object.freeze({
  tts: 30_000,
  image: 180_000,
  memory: 2_000,
});

/** 未列出的能力沿用 tts 一档（30s）—— 宁可慢，也不无声挂死。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** 网络类错误的重试退避基数（毫秒）。 */
export const RETRY_BACKOFF_MS = 500;

/** 每个 provider 最多重试次数（规格：1 次）。 */
export const MAX_RETRIES = 1;

/** 可重试/不可重试判定用到的错误类别。 */
export const ERROR_CATEGORIES = Object.freeze(['auth', 'timeout', 'network', 'quota', 'format', 'unknown']);

/** 401/403 —— 鉴权类，不重试，直接降级。 */
export const AUTH_STATUSES = Object.freeze([401, 403]);

/** Node / undici 里代表「网络抖动」的错误码。 */
export const NETWORK_ERROR_CODES = Object.freeze([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** 超时错误（每次尝试一个实例，带上是哪个 provider）。 */
export class TimeoutError extends Error {
  constructor(timeoutMs, providerId = null) {
    super(`provider ${providerId ?? '?'} 超时（${timeoutMs}ms）`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.timeoutMs = timeoutMs;
    if (providerId) this.provider = providerId;
  }
}

/**
 * 全部 provider 都失败时抛这个。**必须**能回答「每个 provider 分别为什么失败」，
 * 否则用户只看到「语音失败」，无从修起。
 */
export class CapabilityError extends Error {
  /**
   * @param {string} capability
   * @param {{provider: string, attempts: number, category: string, reason: string, durationMs: number, retryable: boolean}[]} failures
   * @param {object[]} [attempts]
   */
  constructor(capability, failures = [], attempts = []) {
    const detail = failures.length > 0
      ? failures.map((failure) => {
        const times = failure.attempts > 1 ? `，试了 ${failure.attempts} 次` : '';
        return `${failure.provider}（${failure.category}${times}：${failure.reason}）`;
      }).join('；')
      : '没有任何可用的 provider';
    super(`能力 ${capability} 全部失败（${failures.length} 个 provider）：${detail}`);
    this.name = 'CapabilityError';
    this.code = 'CAPABILITY_FAILED';
    this.capability = capability;
    this.failures = failures;
    this.attempts = attempts;
  }
}

function messageOf(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}

function statusOf(error) {
  if (!error || typeof error !== 'object') return null;
  const raw = error.status ?? error.statusCode ?? error.response?.status ?? error.cause?.status;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function truncate(text, max = 300) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * 把任意异常归类成六类之一。分类决定了「要不要重试」。
 *
 * 优先级：显式 `err.category` > 鉴权（401/403）> 超时 > 额度（429）> 网络
 *        > 格式 > unknown。
 *
 * @param {unknown} error
 * @returns {{category: 'auth'|'timeout'|'network'|'quota'|'format'|'unknown', retryable: boolean, message: string, status: number|null}}
 */
export function classifyError(error) {
  const message = messageOf(error);
  const status = statusOf(error);
  const code = typeof error?.code === 'string' ? error.code : '';
  const name = typeof error?.name === 'string' ? error.name : '';

  const result = (category) => ({
    category,
    // 只有网络类错误重试（规格 §2.4）。
    retryable: category === 'network',
    message,
    status,
  });

  if (typeof error?.category === 'string' && ERROR_CATEGORIES.includes(error.category)) {
    return result(error.category);
  }
  if (AUTH_STATUSES.includes(status)
    || /unauthori[sz]ed|invalid[_ ]api[_ ]key|forbidden/i.test(message)
    || /\b(401|403)\b/.test(message)) {
    return result('auth');
  }
  if (name === 'TimeoutError' || code === 'ETIMEDOUT' || error?.timeout === true
    || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return result('timeout');
  }
  if (status === 429 || /quota|rate.?limit|insufficient.?quota|额度|限流/i.test(message)) {
    return result('quota');
  }
  if (NETWORK_ERROR_CODES.includes(code)
    || /fetch failed|network|socket hang up|getaddrinfo|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(message)) {
    return result('network');
  }
  if (code === 'FORMAT' || code === 'INVALID_FORMAT' || /invalid (format|response)|格式/.test(message)) {
    return result('format');
  }
  return result('unknown');
}

/**
 * 取某能力的单次超时（毫秒）。
 * @param {string} capability
 * @param {number} [override]
 * @returns {number}
 */
export function timeoutFor(capability, override) {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) return override;
  if (typeof capability === 'string' && Object.prototype.hasOwnProperty.call(CAPABILITY_TIMEOUTS, capability)) {
    return CAPABILITY_TIMEOUTS[capability];
  }
  return DEFAULT_TIMEOUT_MS;
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 给一次尝试套上超时。
 * runner 会收到 `{ signal }`（AbortSignal），守规矩的 adapter 借此取消底层请求；
 * 不守规矩也不会挂死调用方 —— 计时器到点就返回 TimeoutError。
 *
 * @template T
 * @param {(ctx: {signal: AbortSignal}) => Promise<T>} runner
 * @param {number} timeoutMs <= 0 表示不设超时
 * @param {string} providerId
 * @returns {Promise<T>}
 */
async function withTimeout(runner, timeoutMs, providerId) {
  const controller = new AbortController();
  const { signal } = controller;

  if (!(timeoutMs > 0)) return runner({ signal });

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(timeoutMs, providerId));
    }, timeoutMs);
    // 刻意**不** unref：unref 的计时器在事件循环只剩它时会直接让进程退出，
    // 调用方就永远等不到 TimeoutError 了。这里靠 finally 里的 clearTimeout 收尾。
  });

  // 先把 runner 启起来再 race；超时后 runner 可能还会 reject，提前挂一个
  // 空 catch，避免变成 unhandledRejection。
  const runPromise = Promise.resolve().then(() => runner({ signal }));
  runPromise.catch(() => {});

  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function measureUnits(units, value, provider, args) {
  let raw;
  try {
    raw = typeof units === 'function' ? units({ value, provider, args }) : units;
  } catch {
    return 0;
  }
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * 取执行入口。
 *   - `invoke({ run })`：全局执行器，签名 `(provider, args, ctx)`，适合统一分发；
 *   - `provider.run`：适配器自带方法，签名 `(args, ctx)`。
 * 两者都没有属于**编程错误**，直接抛 TypeError（不伪装成能力失败）。
 */
function resolveRunner(provider, run) {
  if (run) return run;
  if (typeof provider.run === 'function') return provider.run;
  throw new TypeError(`provider '${provider.id}' 没有可执行入口：请传 invoke({ run }) 或给 provider 加 run()`);
}

async function recordSafely(input, options) {
  try {
    await appendAttempt(input, options);
  } catch (error) {
    try {
      (options.warn ?? defaultWarn)(`事件记录异常（不影响调用结果）：${error?.message ?? error}`);
    } catch {
      // 告警口自己炸了也不能影响调用结果。
    }
  }
}

/**
 * 统一调用器。
 *
 * @param {object} options
 * @param {string} options.capability 能力名（tts / image / memory / wake / …）
 * @param {object[]} [options.providers] 候选链（通常来自 registry.resolve，已排序）
 * @param {unknown} [options.args] 透传给 runner 的入参
 * @param {(provider: object, args: unknown, ctx: {signal: AbortSignal}) => Promise<unknown>} [options.run]
 *        全局执行器；不传则用 provider.run
 * @param {number|((ctx: {value: unknown, provider: object, args: unknown}) => number)} [options.units]
 *        计量单位数（字符数 / 张数 / 次数…），缺省 1
 * @param {number} [options.timeoutMs] 覆盖单次超时
 * @param {number} [options.maxRetries] 覆盖重试次数（缺省 1）
 * @param {number} [options.backoffMs] 覆盖退避基数（缺省 500）
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试注入
 * @param {() => number} [options.now] 时间基准（测试注入）
 * @param {Record<string,string|undefined>} [options.env] 事件文件所在环境（缺省 process.env）
 * @param {string} [options.eventsPath] 显式事件文件路径
 * @param {(message: string) => void} [options.warn] 告警出口
 * @param {boolean} [options.recordEvents] 是否记账（缺省 true；仅测试/离线预演可关）
 * @returns {Promise<object>} 成功信封
 * @throws {CapabilityError} 全部 provider 失败
 */
export async function invoke(options = {}) {
  const capability = options.capability;
  if (typeof capability !== 'string' || capability.trim() === '') {
    throw new TypeError('invoke: capability 必填（非空字符串）');
  }

  const chain = Array.isArray(options.providers)
    ? options.providers.filter((provider) => provider && typeof provider.id === 'string' && provider.id !== '')
    : [];
  const args = options.args;
  const run = typeof options.run === 'function' ? options.run : null;
  const unitsOption = options.units ?? 1;
  const timeoutMs = timeoutFor(capability, options.timeoutMs);
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : MAX_RETRIES;
  const backoffMs = typeof options.backoffMs === 'number' && Number.isFinite(options.backoffMs) && options.backoffMs >= 0
    ? options.backoffMs
    : RETRY_BACKOFF_MS;
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const env = options.env ?? process.env;
  const eventsPath = options.eventsPath;
  const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;
  const record = options.recordEvents !== false;

  const startedAt = now();
  const attempts = [];
  const failures = [];

  /** 写一条事件（永不抛）。 */
  const recordAttempt = async (input) => {
    if (!record) return;
    await recordSafely({ capability, ...input }, { env, eventsPath, now, warn });
  };

  for (let index = 0; index < chain.length; index += 1) {
    const provider = chain[index];
    const runner = resolveRunner(provider, run);
    // degradedFrom 语义：赢家不是链首时，说明链首（及其之后、赢家之前）都不可用。
    const degradedFrom = index > 0 ? chain[0].id : null;
    let lastFailure = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const attemptStartedAt = now();
      try {
        const value = await withTimeout(
          (ctx) => (run ? run(provider, args, ctx) : runner(args, ctx)),
          timeoutMs,
          provider.id,
        );
        const durationMs = Math.max(0, now() - attemptStartedAt);
        const units = measureUnits(unitsOption, value, provider, args);
        const costEstimate = estimateCost(provider, units);

        attempts.push({
          provider: provider.id,
          attempt,
          ok: true,
          category: null,
          reason: null,
          durationMs,
        });
        await recordAttempt({
          provider,
          units,
          costEstimate,
          durationMs,
          ok: true,
          error: null,
          errorCategory: null,
          attempt,
          degradedFrom,
        });

        return {
          ok: true,
          capability,
          provider: provider.id,
          value,
          units,
          costEstimate,
          degradedFrom,
          attempts,
          durationMs: Math.max(0, now() - startedAt),
        };
      } catch (error) {
        const info = classifyError(error);
        const durationMs = Math.max(0, now() - attemptStartedAt);
        const reason = truncate(info.message);
        lastFailure = {
          provider: provider.id,
          attempts: attempt,
          category: info.category,
          reason,
          durationMs,
          retryable: info.retryable,
        };

        attempts.push({
          provider: provider.id,
          attempt,
          ok: false,
          category: info.category,
          reason,
          durationMs,
        });
        await recordAttempt({
          provider,
          units: 0,
          costEstimate: 0,
          durationMs,
          ok: false,
          error: reason,
          errorCategory: info.category,
          attempt,
        });

        const willRetry = info.retryable && attempt <= maxRetries;
        if (!willRetry) break;
        // 指数退避：第 n 次重试等 backoffMs × 2^(n-1)。
        await sleep(backoffMs * 2 ** (attempt - 1));
      }
    }

    if (lastFailure) failures.push(lastFailure);
  }

  throw new CapabilityError(capability, failures, attempts);
}

/** 别名：`call` 读起来更像「调一次能力」，实现只有 invoke 一份。 */
export const call = invoke;
