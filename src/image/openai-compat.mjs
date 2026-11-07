/**
 * pond-check · 能力层 C5：openai-compat adapter（src/image/openai-compat.mjs）
 *
 * 通用「OpenAI 兼容」出图接口：`POST {baseUrl}/images/generations`。
 * 云侧、要 API key、按张计费。默认是降级链的第二档（本地不可用时兜底）。
 *
 * 支持两种响应：
 *   - `{ data: [{ b64_json }] }` —— 默认（`responseFormat: 'b64_json'`）；
 *   - `{ data: [{ url }] }`     —— 有些兼容服务只回 URL，再用同一 transport 下载。
 *
 * seed 语义（规格 §5「能复现就回传同一个；不能复现回传 null 并说明」）：
 *   - 默认 `supportsSeed: false`：**不接受也不回传** seed，返回 `seed: null` 并给
 *     `seedNote` 说明「服务端不保证复现」。这是诚实做法 —— OpenAI 官方
 *     images/generations 没有 seed 参数。
 *   - 配置显式 `supportsSeed: true`（自建/第三方向后兼容服务）：把 seed 写进请求体
 *     并原样回传。**能不能真复现由服务端决定**，我们只承诺"同一个 seed 发出去了"。
 *
 * 注意：本地不可达降级到这里时，如果调用方原本给了 seed，返回的 `seed` 是 null
 * —— 因为云这条链路不保证复现，不能让调用方以为拿到了可复现的结果。
 *
 * 硬约束：API key 只在请求头里用一次，绝不写进事件 / 错误消息 / providers() 输出。
 */

import { randomInt } from 'node:crypto';

import { ImageProviderError } from './errors.mjs';
import { detectImageFormat } from './output.mjs';
import { readBinary, readJson, send } from './transport.mjs';

/** provider id（配置 chain 里用它）。 */
export const OPENAI_COMPAT_PROVIDER_ID = 'openai-compat';

/** 默认优先级（排在本地之后）。 */
export const OPENAI_COMPAT_PRIORITY = 20;

// crypto.randomInt 的上界必须 < 2^48（写 2**48 会抛 RangeError）。
const MAX_SEED = 2 ** 48 - 1;

/**
 * 造 openai-compat provider。
 *
 * @param {object} config 规范化后的 openai-compat 配置
 * @param {{transport: Function, env: Record<string,string|undefined>}} ctx
 * @returns {object} provider 描述（含 run）
 */
export function createOpenAICompatProvider(config, ctx) {
  const apiKey = config.apiKey
    ?? (typeof ctx.env?.[config.apiKeyEnv] === 'string' ? ctx.env[config.apiKeyEnv].trim() : '');
  const available = typeof apiKey === 'string' && apiKey !== '';
  const label = 'openai-compat';

  async function run(args, runCtx = {}) {
    const { transport } = ctx;
    const { signal } = runCtx;

    if (!available) {
      throw new ImageProviderError(
        `openai-compat 缺少 API key（环境变量 ${config.apiKeyEnv} 或 openai-compat.apiKey）`,
        { provider: OPENAI_COMPAT_PROVIDER_ID, category: 'auth' },
      );
    }

    const supportsSeed = config.supportsSeed === true;
    const seed = supportsSeed ? (args.seed ?? randomInt(0, MAX_SEED)) : null;

    // 负向提示词：OpenAI 接口没有这个字段，按 Stable Diffusion 的通用惯例追加在
    // 提示词后面（不静默丢弃 —— 用户给了就得让模型看见）。
    const promptText = args.negative
      ? `${args.prompt}\n\nNegative prompt: ${args.negative}`
      : args.prompt;

    const body = {
      model: config.model,
      prompt: promptText,
      size: args.size,
      n: 1,
      response_format: config.responseFormat,
      ...(config.extraBody ?? {}),
    };
    if (supportsSeed) body.seed = seed;

    const response = await send(
      transport,
      `${config.baseUrl}/images/generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { provider: OPENAI_COMPAT_PROVIDER_ID, label, signal, timeoutMs: config.requestTimeoutMs },
    );

    const payload = await readJson(response, {
      provider: OPENAI_COMPAT_PROVIDER_ID,
      label,
      redact: apiKey,
    });

    const item = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (!item || typeof item !== 'object') {
      throw new ImageProviderError('openai-compat 响应里没有 data[0]', {
        provider: OPENAI_COMPAT_PROVIDER_ID,
        category: 'format',
      });
    }

    let data;
    if (typeof item.b64_json === 'string' && item.b64_json !== '') {
      data = Buffer.from(item.b64_json, 'base64');
      if (data.length === 0) {
        throw new ImageProviderError('openai-compat 返回的 b64_json 解出来是空图片', {
          provider: OPENAI_COMPAT_PROVIDER_ID,
          category: 'format',
        });
      }
    } else if (typeof item.url === 'string' && item.url !== '') {
      const download = await send(
        transport,
        item.url,
        { method: 'GET' },
        { provider: OPENAI_COMPAT_PROVIDER_ID, label, signal, timeoutMs: config.requestTimeoutMs },
      );
      data = await readBinary(download, { provider: OPENAI_COMPAT_PROVIDER_ID, label, redact: apiKey });
    } else {
      throw new ImageProviderError('openai-compat 响应里既没有 b64_json 也没有 url', {
        provider: OPENAI_COMPAT_PROVIDER_ID,
        category: 'format',
      });
    }

    const detected = detectImageFormat(data);

    return {
      data,
      width: detected?.width ?? args.width,
      height: detected?.height ?? args.height,
      seed: supportsSeed ? seed : null,
      seedReproducible: supportsSeed,
      seedNote: supportsSeed
        ? null
        : 'openai-compat 默认不接受 seed（服务端不保证复现），本次 seed 为 null',
      format: detected?.format ?? 'png',
    };
  }

  return {
    id: OPENAI_COMPAT_PROVIDER_ID,
    name: 'OpenAI 兼容出图接口',
    local: false,
    requires: ['network', 'apiKey'],
    cost: { unit: 'perImage', value: config.cost.value },
    caps: ['png', 'jpeg', 'webp', 'url'],
    priority: OPENAI_COMPAT_PRIORITY,
    sizes: [...config.sizes],
    available,
    unavailableReason: available
      ? null
      : `缺少 API key（环境变量 ${config.apiKeyEnv} 或 openai-compat.apiKey）`,
    supportsSeed: config.supportsSeed === true,
    run,
  };
}
