/**
 * pond-check · 能力层 C5：图生成配置（src/image/config.mjs）
 *
 * 配置文件：`<POND_HOME>/image.json`（默认 `~/.pond/image.json`），可用
 * `POND_IMAGE_CONFIG` 或调用方传 `configPath` 覆盖。**文件不存在 = 全默认**
 * （此时两个 provider 都不可用，generate 会给出「没有可用 provider」的明确失败）。
 *
 * 形态：
 *
 *   {
 *     "chain": ["comfyui", "openai-compat"],        // 降级顺序（写进配置，不由实现猜）
 *     "outDir": "out",                              // 相对 POND_HOME；默认 POND_HOME/out
 *     "comfyui": {
 *       "baseUrl": "http://127.0.0.1:8188",
 *       "workflow": { ... }                         // 对象模板；给字符串则按 JSON 文本模板
 *       "workflowPath": "comfy/workflow.json",      // 相对配置文件目录；与 workflow 二选一
 *       "inject": { "prompt": "6.inputs.text", ... },
 *       "pollIntervalMs": 1000,
 *       "timeoutMs": 170000,
 *       "connectTimeoutMs": 8000,
 *       "sizes": ["1024x1024", ...]
 *     },
 *     "openai-compat": {
 *       "baseUrl": "https://api.openai.com/v1",
 *       "model": "gpt-image-1",
 *       "apiKeyEnv": "POND_IMAGE_API_KEY",           // 从环境变量读 key
 *       "apiKey": "...",                            // 或直接写（不推荐，文件权限自担）
 *       "supportsSeed": false,
 *       "cost": { "unit": "perImage", "value": 0 },
 *       "sizes": ["1024x1024", ...],
 *       "extraBody": { }
 *     },
 *     "defaults": { "size": null, "aspect": null, "style": null, "negative": null }
 *   }
 *
 * 硬约束：
 *   - 不联网；只读配置文件（能力层允许读自己的状态目录）；
 *   - 配置写坏了**立刻抛 ImageConfigError** —— 静默兜底会让用户以为功能坏了却查不到原因；
 *   - API key 只进闭包，绝不写进 provider 描述 / 事件 / `providers()` 输出。
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolvePondHome } from '../shared/paths.mjs';
import { ImageConfigError } from './errors.mjs';
import { STYLES, parseSize } from './prompt.mjs';
import { PLACEHOLDER_KEYS } from './workflow.mjs';

/** 配置文件名（位于 POND_HOME 下）。 */
export const IMAGE_CONFIG_FILE = 'image.json';

/** 默认降级链（规格 §5：本地算力优先）。 */
export const DEFAULT_CHAIN = Object.freeze(['comfyui', 'openai-compat']);

/** ComfyUI 默认地址：本机 5060 上的服务。 */
export const DEFAULT_COMFY_BASE_URL = 'http://127.0.0.1:8188';

/** openai-compat 默认地址与模型。 */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-image-1';

/** 默认 API key 环境变量名。 */
export const DEFAULT_API_KEY_ENV = 'POND_IMAGE_API_KEY';

/** ComfyUI 能出的常用画布（与 prompt.ASPECTS 对齐，另加正方形）。 */
export const COMFY_SIZES = Object.freeze([
  '1024x1024', '1152x864', '864x1152', '1280x720', '720x1280', '1216x832', '832x1216',
]);

/** openai-compat 常见画布（DALL·E / gpt-image 兼容）。 */
export const OPENAI_SIZES = Object.freeze(['1024x1024', '1792x1024', '1024x1792']);

/** ComfyUI 默认等待参数。单次调用总超时由 shared 的 image 180s 兜底，这里的 170s 要小一点。 */
export const DEFAULT_COMFY_TIMING = Object.freeze({
  pollIntervalMs: 1000,
  timeoutMs: 170_000,
  connectTimeoutMs: 8000,
});

/** openai-compat 默认等待参数（一次 POST 同步出图，留 170s）。 */
export const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 170_000;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message, detail) {
  throw new ImageConfigError(message, detail);
}

function positiveNumber(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${field} 必须是 > 0 的有限数字，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 校验并规范化一个 http(s) baseUrl（去掉尾部斜杠）。 */
function normalizeBaseUrl(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${field} 必须是非空 URL 字符串`);
  }
  const trimmed = value.trim().replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail(`${field} 不是合法 URL：${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`${field} 只支持 http / https，收到 ${parsed.protocol}`);
  }
  return trimmed;
}

function normalizeSizeList(value, field, fallback) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} 必须是非空数组`);
  }
  return value.map((item) => {
    try {
      return parseSize({ size: item }).label;
    } catch (error) {
      return fail(`${field} 里有非法尺寸 ${JSON.stringify(item)}：${error?.message ?? error}`);
    }
  });
}

function normalizeWorkflow(comfyRaw, baseDir, filePath) {
  let workflow = comfyRaw.workflow ?? null;
  const workflowPath = comfyRaw.workflowPath ?? null;

  if (workflowPath !== null) {
    if (typeof workflowPath !== 'string' || workflowPath.trim() === '') {
      fail('comfyui.workflowPath 必须是非空字符串');
    }
    // workflow 显式给了就用它；否则从文件读（相对配置文件所在目录）。
    if (workflow === null) {
      const absolute = path.resolve(baseDir, workflowPath.trim());
      let text;
      try {
        text = fs.readFileSync(absolute, 'utf8');
      } catch (error) {
        fail(`comfyui.workflowPath 读不到：${absolute}（${error?.message ?? error}）`, { cause: error });
      }
      try {
        workflow = JSON.parse(text);
      } catch (error) {
        fail(`comfyui.workflowPath 不是合法 JSON：${absolute}（${error?.message ?? error}）`, { cause: error });
      }
    }
  }

  if (workflow !== null && typeof workflow !== 'string' && !isPlainObject(workflow)) {
    fail('comfyui.workflow 必须是 JSON 对象或 JSON 文本字符串');
  }

  if (typeof workflow === 'string' && workflow.trim() === '') {
    fail('comfyui.workflow 字符串模板不能为空');
  }

  return { workflow, workflowPath: workflowPath ?? null, filePath };
}

function normalizeInject(inject) {
  if (inject === undefined || inject === null) return {};
  if (!isPlainObject(inject)) fail('comfyui.inject 必须是对象');
  const out = {};
  for (const [key, value] of Object.entries(inject)) {
    if (!PLACEHOLDER_KEYS.includes(key)) {
      fail(`comfyui.inject 里的 '${key}' 不是可注入字段（可用：${PLACEHOLDER_KEYS.join(' / ')}）`);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`comfyui.inject.${key} 必须是非空路径字符串`);
    }
    out[key] = value.trim();
  }
  return out;
}

function normalizeComfyConfig(raw, ctx) {
  if (raw !== undefined && !isPlainObject(raw)) fail('comfyui 配置必须是对象');
  const value = raw ?? {};
  const { workflow, workflowPath } = normalizeWorkflow(value, ctx.baseDir, ctx.filePath);
  return {
    baseUrl: normalizeBaseUrl(value.baseUrl, 'comfyui.baseUrl', DEFAULT_COMFY_BASE_URL),
    workflow,
    workflowPath,
    inject: normalizeInject(value.inject),
    clientId: typeof value.clientId === 'string' && value.clientId.trim() !== ''
      ? value.clientId.trim()
      : 'pond-check',
    pollIntervalMs: positiveNumber(value.pollIntervalMs, 'comfyui.pollIntervalMs', DEFAULT_COMFY_TIMING.pollIntervalMs),
    timeoutMs: positiveNumber(value.timeoutMs, 'comfyui.timeoutMs', DEFAULT_COMFY_TIMING.timeoutMs),
    connectTimeoutMs: positiveNumber(value.connectTimeoutMs, 'comfyui.connectTimeoutMs', DEFAULT_COMFY_TIMING.connectTimeoutMs),
    sizes: normalizeSizeList(value.sizes, 'comfyui.sizes', COMFY_SIZES),
  };
}

function normalizeOpenAIConfig(raw) {
  if (raw !== undefined && !isPlainObject(raw)) fail('openai-compat 配置必须是对象');
  const value = raw ?? {};

  const costRaw = value.cost ?? {};
  if (!isPlainObject(costRaw)) fail('openai-compat.cost 必须是对象');
  if (costRaw.unit !== undefined && costRaw.unit !== 'perImage') {
    fail(`openai-compat.cost.unit 只接受 perImage（收到 ${JSON.stringify(costRaw.unit)}）`);
  }
  const costValue = costRaw.value === undefined ? 0 : costRaw.value;
  if (typeof costValue !== 'number' || !Number.isFinite(costValue) || costValue < 0) {
    fail('openai-compat.cost.value 必须是 >= 0 的有限数字');
  }

  const supportsSeed = value.supportsSeed === undefined ? false : value.supportsSeed;
  if (typeof supportsSeed !== 'boolean') fail('openai-compat.supportsSeed 必须是布尔值');

  let extraBody = null;
  if (value.extraBody !== undefined && value.extraBody !== null) {
    if (!isPlainObject(value.extraBody)) fail('openai-compat.extraBody 必须是对象');
    extraBody = { ...value.extraBody };
  }

  const responseFormat = value.responseFormat === undefined ? 'b64_json' : value.responseFormat;
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') {
    fail(`openai-compat.responseFormat 只支持 b64_json / url（收到 ${JSON.stringify(responseFormat)}）`);
  }

  const model = value.model === undefined ? DEFAULT_OPENAI_MODEL : value.model;
  if (typeof model !== 'string' || model.trim() === '') fail('openai-compat.model 必须是非空字符串');

  const apiKeyEnv = value.apiKeyEnv === undefined ? DEFAULT_API_KEY_ENV : value.apiKeyEnv;
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv.trim() === '') {
    fail('openai-compat.apiKeyEnv 必须是非空环境变量名');
  }

  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.trim() === '')) {
    fail('openai-compat.apiKey 必须是非空字符串（建议改用 apiKeyEnv）');
  }

  return {
    baseUrl: normalizeBaseUrl(value.baseUrl, 'openai-compat.baseUrl', DEFAULT_OPENAI_BASE_URL),
    model: model.trim(),
    apiKeyEnv: apiKeyEnv.trim(),
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : null,
    supportsSeed,
    cost: { unit: 'perImage', value: costValue },
    sizes: normalizeSizeList(value.sizes, 'openai-compat.sizes', OPENAI_SIZES),
    responseFormat,
    extraBody,
    requestTimeoutMs: positiveNumber(
      value.requestTimeoutMs,
      'openai-compat.requestTimeoutMs',
      DEFAULT_OPENAI_REQUEST_TIMEOUT_MS,
    ),
  };
}

function normalizeChain(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_CHAIN];
  if (!Array.isArray(raw)) fail('chain 必须是 provider id 数组');
  const chain = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail('chain 里的每一项都必须是非空字符串');
    }
    const id = item.trim();
    if (!chain.includes(id)) chain.push(id);
  }
  return chain;
}

function normalizeDefaults(raw) {
  if (raw === undefined || raw === null) return { size: null, aspect: null, style: null, negative: null };
  if (!isPlainObject(raw)) fail('defaults 必须是对象');

  const size = raw.size ?? null;
  const aspect = raw.aspect ?? null;
  if (size !== null && aspect !== null) {
    fail('defaults.size 与 defaults.aspect 只能给一个（size 已足够表达画布）');
  }

  const style = raw.style ?? null;
  if (style !== null && !Object.prototype.hasOwnProperty.call(STYLES, style)) {
    fail(`defaults.style '${style}' 不认识（可用：${Object.keys(STYLES).join(' / ')}）`);
  }
  if (raw.negative !== null && raw.negative !== undefined && typeof raw.negative !== 'string') {
    fail('defaults.negative 必须是字符串');
  }

  return {
    size,
    aspect,
    style,
    negative: typeof raw.negative === 'string' ? raw.negative : null,
  };
}

/**
 * 规范化一份配置对象（不做文件 IO）。
 * @param {object} raw
 * @param {{filePath?: string|null, env?: Record<string,string|undefined>}} [options]
 * @returns {object}
 */
export function normalizeImageConfig(raw, options = {}) {
  if (!isPlainObject(raw)) fail('图生成配置必须是一个 JSON 对象');

  const env = options.env ?? process.env;
  const filePath = options.filePath ?? null;
  const baseDir = filePath ? path.dirname(filePath) : process.cwd();

  // 未知顶层键不致命（向后兼容，留给 C6/C7 扩字段），也不覆盖已知字段。
  const comfyRaw = raw.comfyui ?? {};
  const openaiRaw = raw.openaiCompat ?? raw['openai-compat'] ?? {};

  const outDirRaw = raw.outDir ?? null;
  let outDir = null;
  if (outDirRaw !== null) {
    if (typeof outDirRaw !== 'string' || outDirRaw.trim() === '') fail('outDir 必须是非空字符串');
    outDir = path.isAbsolute(outDirRaw.trim())
      ? path.resolve(outDirRaw.trim())
      : path.resolve(resolvePondHome(env), outDirRaw.trim());
  }

  const config = {
    filePath,
    chain: normalizeChain(raw.chain),
    outDir,
    comfyui: normalizeComfyConfig(comfyRaw, { baseDir, filePath }),
    openaiCompat: normalizeOpenAIConfig(openaiRaw),
    defaults: normalizeDefaults(raw.defaults),
  };

  // 未知顶层键原样带上（不参与行为，但调用方可能想读；不覆盖已知字段）。
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in config)) config[key] = value;
  }
  return config;
}

/** 默认配置（不读盘）。 */
export function defaultImageConfig(options = {}) {
  return normalizeImageConfig({}, options);
}

/**
 * 读配置：显式 configPath > `POND_IMAGE_CONFIG` > `<POND_HOME>/image.json` > 默认。
 *
 * @param {{env?: Record<string,string|undefined>, configPath?: string|null}} [options]
 * @returns {object}
 */
export function loadImageConfig(options = {}) {
  const env = options.env ?? process.env;
  const envPath = typeof env.POND_IMAGE_CONFIG === 'string' && env.POND_IMAGE_CONFIG.trim() !== ''
    ? path.resolve(env.POND_IMAGE_CONFIG.trim())
    : null;
  const explicit = options.configPath ?? envPath;
  const filePath = explicit ?? path.join(resolvePondHome(env), IMAGE_CONFIG_FILE);

  let text = null;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (explicit !== null) {
      fail(`图生成配置读不到：${filePath}（${error?.message ?? error}）`, { cause: error });
    }
    // 默认路径不存在 = 全默认，不是错误。
    return defaultImageConfig({ filePath: null, env });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(`图生成配置不是合法 JSON：${filePath}（${error?.message ?? error}）`, { cause: error });
  }
  return normalizeImageConfig(raw, { filePath, env });
}
