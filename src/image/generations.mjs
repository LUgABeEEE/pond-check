/**
 * pond-check · 能力层 C6：images/generations 协议核心（src/image/generations.mjs）
 *
 * 火山方舟的图片生成走 OpenAI 风格的 generations 协议（规格 §5 的 seedream 与
 * doubao 两个云 provider 共用；现实里「火山 Seedream」与「豆包 Seedream」就是
 * 同一个方舟接口的两条模型线，拆成两个 adapter 是为了让 key / 模型线 / 计价 /
 * 默认参数各自独立配置）：
 *
 *   POST {baseUrl}/images/generations
 *   Authorization: Bearer ${ARK_API_KEY}
 *   {
 *     "model": "doubao-seedream-…", "prompt", "size": "1024x1024",
 *     "response_format": "b64_json" | "url",
 *     "seed": 123, "watermark": false, "output_format": "png",
 *     "guidance_scale": 2.5                      ← 仅部分模型线支持（doubao 3.0-t2i）
 *   }
 *   响应：{ data: [{ url | b64_json }], usage }
 *
 * 协议出处（离线对照，测试零联网）：火山方舟「图片生成 API」文档
 * （docs.volcengine.com/docs/ark/image-generation-api）与豆包 Seedream 3.0
 * Generations 的请求 schema（seed / guidance_scale / watermark / response_format）。
 *
 * 与 C5 openai-compat 相同的诚实约定：
 *   - seed 支持与否由配置 `supportsSeed` 声明（默认 true：协议请求里有 seed 字段）；
 *     发出去什么 seed 就回传什么 seed，**能不能真复现由服务端决定**；
 *     supportsSeed=false 时回 seed:null 并给 seedNote，不假装可复现；
 *   - 负向提示词协议没有字段，按 Stable Diffusion 惯例追加在 prompt 后（不丢弃）；
 *   - API key 只进请求头与闭包，错误文本脱敏，providers()/config 副本不含明文。
 *
 * 硬约束：不 import 任何网络模块；出网只走注入的 transport（默认 fetch，
 * 且 fetch 装配也不在本文件 —— 全部经 transport 注入缝）。
 */

import { randomInt } from 'node:crypto';

import { resolveCredentials, assertCredentials } from '../shared/credentials.mjs';
import { ImageProviderError } from './errors.mjs';
import { detectImageFormat } from './output.mjs';
import { readBinary, readJson, send } from './transport.mjs';

// crypto.randomInt 的上界必须 < 2^48。
const MAX_SEED = 2 ** 48 - 1;

/**
 * 造一个 generations 协议的出图 provider。
 *
 * @param {object} profile adapter 侧的固定身份与默认值：
 *   { id, name, model, baseUrl, apiKeyEnv, usesGuidanceScale }
 * @param {object} config 规范化后的配置（可覆盖 profile 默认值）
 * @param {{transport: Function, env: Record<string,string|undefined>}} ctx
 * @returns {object} provider 描述（含 run）
 */
export function createGenerationsProvider(profile, config = {}, ctx) {
  const transport = ctx.transport;
  const env = ctx.env ?? process.env;
  const apiKeyEnv = config.apiKeyEnv ?? profile.apiKeyEnv;
  const baseUrl = String(config.baseUrl ?? profile.baseUrl).replace(/\/+$/u, '');
  const model = config.model ?? profile.model;

  const credentials = resolveCredentials([
    { name: 'apiKey', envVar: apiKeyEnv, value: config.apiKey },
  ], env);
  const available = credentials.ok; // ← 变异点 M1：把这行换成「无 key 就 throw」必红
  const keyEnvs = [apiKeyEnv];
  const label = profile.id;
  const costValue = Number.isFinite(config.cost?.value) ? config.cost.value : 0;

  async function run(args, runCtx = {}) {
    // 防御纵深：正常路径 generate() 已经把不可用的 provider 过滤掉了。
    assertCredentials(credentials, profile.id);
    const apiKey = credentials.values.apiKey;
    const { signal } = runCtx;

    const supportsSeed = config.supportsSeed !== false;
    const seed = supportsSeed ? (args.seed ?? randomInt(0, MAX_SEED)) : null;

    // 负向提示词：协议没有独立字段，按通用惯例追加在提示词后（不静默丢弃）。
    const promptText = args.negative
      ? `${args.prompt}\n\nNegative prompt: ${args.negative}`
      : args.prompt;

    const body = {
      model,
      prompt: promptText,
      size: args.size,
      response_format: config.responseFormat ?? 'b64_json',
      watermark: config.watermark === true,
      output_format: config.outputFormat ?? 'png',
    };
    if (supportsSeed && seed !== null) body.seed = seed;
    if (profile.usesGuidanceScale && Number.isFinite(config.guidanceScale)) {
      body.guidance_scale = config.guidanceScale;
    }
    if (config.extraBody) Object.assign(body, config.extraBody);

    const response = await send(
      transport,
      `${baseUrl}/images/generations`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { provider: profile.id, label, signal, timeoutMs: config.requestTimeoutMs ?? 170_000 },
    );

    const payload = await readJson(response, { provider: profile.id, label, redact: apiKey });

    const item = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (!item || typeof item !== 'object') {
      throw new ImageProviderError(`${label} 响应里没有 data[0]`, {
        provider: profile.id,
        category: 'format',
      });
    }

    let data;
    if (typeof item.b64_json === 'string' && item.b64_json !== '') {
      data = Buffer.from(item.b64_json, 'base64');
      if (data.length === 0) {
        throw new ImageProviderError(`${label} 返回的 b64_json 解出来是空图片`, {
          provider: profile.id,
          category: 'format',
        });
      }
    } else if (typeof item.url === 'string' && item.url !== '') {
      const download = await send(
        transport,
        item.url,
        { method: 'GET' },
        { provider: profile.id, label, signal, timeoutMs: config.requestTimeoutMs ?? 170_000 },
      );
      data = await readBinary(download, { provider: profile.id, label, redact: apiKey });
    } else {
      throw new ImageProviderError(`${label} 响应里既没有 b64_json 也没有 url`, {
        provider: profile.id,
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
        : `${label} 按配置不发送 seed（服务端不保证复现），本次 seed 为 null`,
      format: detected?.format ?? 'png',
    };
  }

  return {
    id: profile.id,
    name: profile.name,
    local: false,
    requires: ['network', 'apiKey'],
    cost: { unit: 'perImage', value: costValue },
    caps: ['png', 'jpeg', 'webp', 'url'],
    priority: config.priority ?? profile.priority ?? 20,
    sizes: [...(config.sizes ?? [])],
    /** 「具体 key 名」：requires 只能写 network/apiKey/binary 标签，key 名声明在这。 */
    keyEnvs,
    available,
    unavailableReason: available ? null : credentials.reason,
    supportsSeed: config.supportsSeed !== false,
    run,
  };
}
