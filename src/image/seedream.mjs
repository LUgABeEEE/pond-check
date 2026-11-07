/**
 * pond-check · 能力层 C6：seedream 图 adapter（src/image/seedream.mjs）
 *
 * 「火山 Seedream」（规格 §5）—— 火山方舟 images/generations 上的 Seedream 模型线
 * （4.5 / 5.0，文生图）。协议核心在 generations.mjs，这里只定身份与默认值：
 *
 *   端点  https://ark.cn-beijing.volces.com/api/v3/images/generations
 *   key   环境变量 POND_SEEDREAM_API_KEY（方舟 API Key），或配置 seedream.apiKey
 *   模型  doubao-seedream-4-5-251128（官方推荐线；配置 seedream.model 可换 5.0 等）
 *   计费  按张（perImage），单价以方舟控制台为准（2K 参考价约 0.25 元/张）
 *
 * 硬约束：同 generations.mjs（key 不出闭包、transport 注入、没 key 不 throw）。
 */

import { createGenerationsProvider } from './generations.mjs';

/** provider id（配置 chain 里用它）。 */
export const SEEDREAM_PROVIDER_ID = 'seedream';

/** 默认端点与模型（火山方舟 · Seedream 4.5）。 */
export const SEEDREAM_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const SEEDREAM_DEFAULT_MODEL = 'doubao-seedream-4-5-251128';

/** 默认凭据环境变量名（「具体 key 名」）。 */
export const SEEDREAM_API_KEY_ENV = 'POND_SEEDREAM_API_KEY';

/** 默认优先级（跟在 openai-compat 之后，规格 §5 的链序）。 */
export const SEEDREAM_PRIORITY = 20;

/** 常用画布（方舟按 WxH 或档位收 size；这里列常用值，解析在 prompt.mjs）。 */
export const SEEDREAM_SIZES = Object.freeze([
  '1024x1024', '2048x2048', '2560x1440', '1440x2560', '1280x720', '720x1280',
]);

/** Seedream 模型线不收 guidance_scale（那是 doubao 3.0-t2i 线的参数）。 */
const PROFILE = Object.freeze({
  id: SEEDREAM_PROVIDER_ID,
  name: '火山 Seedream（方舟）',
  baseUrl: SEEDREAM_BASE_URL,
  model: SEEDREAM_DEFAULT_MODEL,
  apiKeyEnv: SEEDREAM_API_KEY_ENV,
  priority: SEEDREAM_PRIORITY,
  usesGuidanceScale: false,
});

/**
 * 造 seedream provider。
 *
 * @param {object} [config] 规范化配置（baseUrl / model / apiKey / apiKeyEnv /
 *   cost / sizes / responseFormat / watermark / outputFormat / supportsSeed /
 *   requestTimeoutMs / extraBody）
 * @param {{transport: Function, env?: Record<string,string|undefined>}} ctx
 * @returns {object} provider 描述（含 run）
 */
export function createSeedreamProvider(config = {}, ctx) {
  return createGenerationsProvider(PROFILE, { sizes: [...SEEDREAM_SIZES], ...config }, ctx);
}
