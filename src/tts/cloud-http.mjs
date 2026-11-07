/**
 * pond-check · 能力层 C6：TTS 云 adapter 的出网小工具（src/tts/cloud-http.mjs）
 *
 * doubao / mimo 两个云 adapter 共用同一套「发请求 / 读响应 / 归类错误」规则，
 * 保证降级行为一致（与 src/image/transport.mjs 同构，但错误类型是 TTS 侧的：
 * 带 `category` 的普通 Error，由 shared/call.mjs 归类重试/降级）：
 *
 *   - 连不上 / DNS / 拒绝连接 → category=network（重试 1 次后降级）
 *   - 超时（自设 timeout 或上层 AbortSignal）→ category=timeout（不重试）
 *   - HTTP 非 2xx → 带 `status` 的错误（401/403=auth、429=quota 由 call.mjs 判）
 *   - 响应不是 JSON / 缺字段 → category=format（不重试）
 *
 * **测试绝不允许真发网络请求**：transport 是注入的（默认内置 fetch），
 * tests/cloud-adapters.test.mjs 全程用假 transport 并把 globalThis.fetch 换成
 * 会抛的桩，任何漏网的真请求都会当场炸出来。
 *
 * 硬约束：不 import 任何网络模块（fetch 只在 index.mjs 的默认 transport 里）；
 * 错误文本一律先脱敏（API key / token 可能被服务端回显在响应体里）。
 */

/** 错误消息里的响应体最多留这么多字符（防一坨 HTML 撑爆事件流）。 */
const BODY_PREVIEW_CHARS = 300;

function truncate(text, max = BODY_PREVIEW_CHARS) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 把密钥从错误文本里抹掉（响应体可能回显）。 */
export function redactSecret(text, secret) {
  if (typeof secret !== 'string' || secret === '') return String(text ?? '');
  return String(text ?? '').split(secret).join('[已隐藏]');
}

/**
 * 造一个带 category 的错误（category 直接决定重试还是降级）。
 *
 * @param {string} message
 * @param {{category?: string, status?: number|null, provider?: string, cause?: unknown}} [detail]
 * @returns {Error & {category?: string, status?: number, provider?: string}}
 */
export function cloudError(message, detail = {}) {
  const error = new Error(message);
  if (detail.category) error.category = detail.category;
  if (typeof detail.status === 'number' && Number.isFinite(detail.status)) error.status = detail.status;
  if (detail.provider) error.provider = detail.provider;
  if (detail.cause !== undefined) error.cause = detail.cause;
  return error;
}

/**
 * 发一次 JSON 请求并解析响应。
 *
 * @param {(url: string, init?: object) => Promise<Response>} transport
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: string}} init
 * @param {{provider: string, label?: string, redact?: string, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<unknown>} 解析后的 JSON
 */
export async function requestJson(transport, url, init = {}, options = {}) {
  if (typeof transport !== 'function') {
    throw new TypeError('cloud-http: transport 必须是函数（默认用内置 fetch，测试请注入假 transport）');
  }
  const provider = options.provider ?? 'tts';
  const label = options.label ?? provider;
  const { signal } = options;
  const timeoutMs = options.timeoutMs;
  const timeoutSignal = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : null;
  const signals = [signal, timeoutSignal].filter(Boolean);
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let response;
  try {
    response = await transport(url, combined ? { ...init, signal: combined } : init);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      const reason = signal?.aborted ? '上层取消' : `等待超过 ${timeoutMs}ms`;
      throw cloudError(`${label} 请求超时（${reason}）：${url}`, {
        category: 'timeout', provider, cause: error,
      });
    }
    // 连不上云服务归网络类：重试 1 次后降级到下一个 provider。
    throw cloudError(`${label} 不可达（${url}）：${error?.message ?? error}`, {
      category: 'network', provider, cause: error,
    });
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw cloudError(`${label} 响应读不出来：${error?.message ?? error}`, {
      category: 'format', provider, cause: error,
    });
  }
  const safe = redactSecret(text, options.redact);

  if (!response.ok) {
    // 状态码放在 message 里也挂在 err.status 上：call.mjs 靠 status 判 auth/quota。
    throw cloudError(`${label} HTTP ${response.status}：${truncate(safe)}`, {
      provider, status: response.status,
    });
  }
  if (text === '') {
    throw cloudError(`${label} 返回了空响应`, { category: 'format', provider });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw cloudError(`${label} 返回的不是合法 JSON：${truncate(safe, 120)}`, {
      category: 'format', provider, cause: error,
    });
  }
}

/** 默认 HTTP transport：内置 fetch（测试注入假实现，永远不走到这里）。 */
export function defaultCloudTransport(url, init) {
  return fetch(url, init);
}
