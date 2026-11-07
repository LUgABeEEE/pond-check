/**
 * pond-check · 能力层 C5：网络请求小工具（src/image/transport.mjs）
 *
 * 两个 adapter 共用同一套「发请求 / 读响应」规则，保证错误分类一致：
 *
 *   - 连不上 / DNS / 拒绝连接 → `LocalUnavailableError`（category=network）→
 *     shared 调用器会重试 1 次，然后**降级到下一个 provider**；
 *   - 超时（自己设的 timeout 或上层 AbortSignal）→ `ImageTimeoutError`
 *     （category=timeout）→ 不重试，直接降级；
 *   - HTTP 非 2xx → `ImageProviderError`，带上 `status`，由 shared 归类
 *     （401/403 = auth 不重试、429 = quota 不重试）；
 *   - 响应不是 JSON / 缺字段 → `ImageProviderError`（category=format，不重试）。
 *
 * **测试绝不允许真发网络请求**：`transport` 是可注入的，adapter 只通过它出网；
 * tests/image.test.mjs 会把 `globalThis.fetch` 换成「一调用就抛」，任何漏网的真
 * 请求都会当场炸出来。
 *
 * 硬约束：只用内置 `fetch`（在 index.mjs 组装），本文件不 import 任何网络模块。
 */

import { ImageProviderError, ImageTimeoutError, LocalUnavailableError } from './errors.mjs';

/** 错误消息里的响应体最多留这么多字符，防止一坨 HTML 把事件流撑爆。 */
const BODY_PREVIEW_CHARS = 300;

function truncate(text, max = BODY_PREVIEW_CHARS) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 把 API key 之类的秘密从错误文本里抹掉（响应体可能回显）。 */
export function redactSecret(text, secret) {
  if (typeof secret !== 'string' || secret === '') return String(text ?? '');
  return String(text ?? '').split(secret).join('[已隐藏]');
}

/**
 * 发一次请求，并把「出网失败」翻译成本层的错误类型。
 *
 * @param {(url: string, init?: object) => Promise<Response>} transport
 * @param {string} url
 * @param {object} [init]
 * @param {{provider?: string, label?: string, signal?: AbortSignal, timeoutMs?: number}} [options]
 * @returns {Promise<Response>}
 */
export async function send(transport, url, init = {}, options = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('image: transport 必须是函数（默认用内置 fetch，测试请注入假 transport）');
  }
  const provider = options.provider ?? 'image';
  const label = options.label ?? provider;
  const { signal } = options;
  const timeoutMs = options.timeoutMs;
  const timeoutSignal = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : null;
  const signals = [signal, timeoutSignal].filter(Boolean);
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  try {
    return await transport(url, combined ? { ...init, signal: combined } : init);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      const reason = signal?.aborted ? '上层取消' : `等待超过 ${timeoutMs}ms`;
      throw new ImageTimeoutError(`${label} 请求超时（${reason}）：${url}`, { provider, cause: error });
    }
    // 连不上本地服务**不是**能力失败：归类为网络错误，交给调用器降级。
    throw new LocalUnavailableError(
      `${label} 不可达（${url}）：${error?.message ?? error}`,
      { provider, cause: error },
    );
  }
}

/**
 * 读 JSON 响应。
 *
 * @param {Response} response
 * @param {{provider?: string, label?: string, redact?: string}} [options]
 * @returns {Promise<unknown>}
 */
export async function readJson(response, options = {}) {
  const provider = options.provider ?? 'image';
  const label = options.label ?? provider;

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new ImageProviderError(`${label} 响应读不出来：${error?.message ?? error}`, {
      provider,
      category: 'format',
      cause: error,
    });
  }
  const safe = redactSecret(text, options.redact);

  if (!response.ok) {
    throw new ImageProviderError(
      `${label} HTTP ${response.status}：${truncate(safe)}`,
      { provider, status: response.status },
    );
  }
  if (text === '') {
    throw new ImageProviderError(`${label} 返回了空响应`, { provider, category: 'format' });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ImageProviderError(
      `${label} 返回的不是合法 JSON：${truncate(safe, 120)}`,
      { provider, category: 'format', cause: error },
    );
  }
}

/**
 * 读二进制响应（下载图片）。
 *
 * @param {Response} response
 * @param {{provider?: string, label?: string}} [options]
 * @returns {Promise<Buffer>}
 */
export async function readBinary(response, options = {}) {
  const provider = options.provider ?? 'image';
  const label = options.label ?? provider;

  if (!response.ok) {
    let preview = '';
    try {
      preview = truncate(redactSecret(await response.text(), options.redact));
    } catch {
      // 读不出错误体就只报状态码。
    }
    throw new ImageProviderError(
      `${label} HTTP ${response.status}${preview ? `：${preview}` : ''}`,
      { provider, status: response.status },
    );
  }

  let data;
  try {
    data = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new ImageProviderError(`${label} 图片数据读取失败：${error?.message ?? error}`, {
      provider,
      category: 'format',
      cause: error,
    });
  }
  if (data.length === 0) {
    throw new ImageProviderError(`${label} 返回了空图片`, { provider, category: 'format' });
  }
  return data;
}
