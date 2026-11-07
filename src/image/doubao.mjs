/**
 * pond-check · 能力层 C6：doubao 图 adapter（src/image/doubao.mjs）
 *
 * 「豆包 Seedream」（规格 §5）—— 火山方舟 images/generations 上的豆包模型线
 * （doubao-seedream-3.0-t2i / 4.0，文生图）。与 seedream 同一个协议（现实里
 * 「豆包 Seedream」就是方舟接口上的 doubao-seedream-* 模型），拆开是为了 key /
 * 模型线 / 计价 / 默认参数独立配置；这条线**支持 seed 与 guidance_scale**
 * （豆包 Seedream 3.0 文生图的文档参数）。
 *
 *   端点  https://ark.cn-beijing.volces.com/api/v3/images/generations
 *   key   环境变量 POND_DOUBAO_API_KEY（方舟 API Key），或配置 doubao.apiKey
 *   模型  doubao-seedream-3-0-t2i（配置 doubao.model 可换 4.0 等）
 *   计费  按张（perImage），单价以方舟控制台为准
 *
 * 硬约束：同 generations.mjs（key 不出闭包、transport 注入、没 key 不 throw）。
 */

import { createGenerationsProvider } from './generations.mjs';

/** provider id（配置 chain 里用它）。 */
export const DOUBAO_IMAGE_PROVIDER_ID = 'doubao';

/** 默认端点与模型（豆包 Seedream 3.0 文生图）。 */
export const DOUBAO_IMAGE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const DOUBAO_IMAGE_DEFAULT_MODEL = 'doubao-seedream-3-0-t2i';

/** 默认凭据环境变量名（「具体 key 名」）。 */
export const DOUBAO_IMAGE_API_KEY_ENV = 'POND_DOUBAO_API_KEY';

/** 默认优先级（链尾兜底，规格 §5 的链序）。 */
export const DOUBAO_IMAGE_PRIORITY = 10;

/** 常用画布。 */
export const DOUBAO_IMAGE_SIZES = Object.freeze([
  '1024x1024', '2048x2048', '2560x1440', '1440x2560', '1280x720', '720x1280',
]);

/** 豆包 3.0-t2i 线支持 guidance_scale（规格外的模型线多收多忽略，服务端定）。 */
const PROFILE = Object.freeze({
  id: DOUBAO_IMAGE_PROVIDER_ID,
  name: '豆包 Seedream',
  baseUrl: DOUBAO_IMAGE_BASE_URL,
  model: DOUBAO_IMAGE_DEFAULT_MODEL,
  apiKeyEnv: DOUBAO_IMAGE_API_KEY_ENV,
  priority: DOUBAO_IMAGE_PRIORITY,
  usesGuidanceScale: true,
});

/**
 * 造 doubao 图 provider。
 *
 * @param {object} [config] 规范化配置（同 seedream，另加 guidanceScale）
 * @param {{transport: Function, env?: Record<string,string|undefined>}} ctx
 * @returns {object} provider 描述（含 run）
 */
export function createDoubaoImageProvider(config = {}, ctx) {
  return createGenerationsProvider(PROFILE, { sizes: [...DOUBAO_IMAGE_SIZES], ...config }, ctx);
}
