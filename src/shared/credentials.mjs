/**
 * pond-check · 能力层 C6：云凭据解析（src/shared/credentials.mjs）
 *
 * 云 adapter（doubao / seedream / mimo，以及 openai-compat 之类的后来者）都面临
 * 同一个问题：**key 没配的时候怎么办**。答案必须统一且只有两条：
 *
 *   1. 描述层：provider 标 `available: false` + `unavailableReason` 点名缺哪个 key，
 *      resolve 时被可用性过滤**跳过** —— 不 throw、不崩、不让没配云 key 的用户
 *      连本地 provider 都用不上；
 *   2. 调用层：万一 run() 还是被叫到了（防御纵深），抛 `MissingKeyError`
 *      （code = POND_MISSING_KEY），错误信息点名环境变量 —— 与「配了但调用失败」
 *      （HTTP 500 / 网络不可达 / 响应不合格式）在错误类别与文案上都分得开。
 *
 * 为什么单独一层：四个云 adapter 若各写各的 key 判断，早晚有一个把「没 key」
 * 写成 throw —— 那种 bug 不会在开发时暴露（开发时都配了 key），只会在用户机器上
 * 炸。这里只有一处判断、一处错误类型，变异验证也只需要切一刀。
 *
 * 硬约束：纯函数 + 不联网 + 不写盘；密钥只在返回值与闭包里流动，
 * 绝不进事件、日志、providers() 输出（那里的 apiKey 一律 '[已隐藏]'）。
 */

/** 「没配 key」错误的稳定 code，测试与调用方都按它判别（不猜文案）。 */
export const MISSING_KEY_CODE = 'POND_MISSING_KEY';

/**
 * 没配 key（不是调用失败）。category = auth：不重试、直接降级 —— 重试也不会
 * 把 key 从空气里变出来。
 */
export class MissingKeyError extends Error {
  /**
   * @param {string} message
   * @param {{keyEnvs?: string[], provider?: string}} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MissingKeyError';
    this.code = MISSING_KEY_CODE;
    this.category = 'auth';
    if (Array.isArray(detail.keyEnvs)) this.keyEnvs = [...detail.keyEnvs];
    if (detail.provider) this.provider = detail.provider;
  }
}

function pick(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 解析一组凭据：显式配置值优先，其次环境变量。
 *
 * @param {Array<{name: string, envVar: string, value?: string|null}>} spec
 *        每项一个凭据：`name` 是返回值里的键，`envVar` 是环境变量名（也是
 *        「具体 key 名」——注册表的 requires 只能写 network/apiKey/binary 三个
 *        标签，具体 key 名由这里的 envVar 与 provider 的 keyEnvs 声明）。
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ok: boolean, values: Record<string, string|null>, missing: string[], reason: string|null}}
 *          `ok=false` 时 `reason` 点名缺哪些 key、到哪里配（给 unavailableReason 用）。
 */
export function resolveCredentials(spec, env = process.env) {
  const values = {};
  const missing = [];
  for (const item of spec) {
    const resolved = pick(item.value) ?? pick(env?.[item.envVar]);
    values[item.name] = resolved;
    if (resolved === null) missing.push(item.envVar);
  }
  if (missing.length === 0) return { ok: true, values, missing: [], reason: null };
  return {
    ok: false,
    values,
    missing,
    reason: `缺少 API key（环境变量 ${missing.join(' / ')}，或在配置里直接给）`,
  };
}

/**
 * 防御纵深：run() 被叫到但 key 不全时抛这个（正常路径里 resolve 已把
 * 不可用的 provider 跳过了，这里只是最后一道闸）。
 *
 * @param {{ok: boolean, missing: string[]}} credentials
 * @param {string} providerId
 */
export function assertCredentials(credentials, providerId) {
  if (credentials?.ok === true) return;
  throw new MissingKeyError(
    `${providerId} 缺少 API key（环境变量 ${(credentials?.missing ?? []).join(' / ')}），`
    + '这不是调用失败：先配 key 再试',
    { keyEnvs: credentials?.missing ?? [], provider: providerId },
  );
}
