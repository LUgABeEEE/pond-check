/**
 * pond-check · 能力层 C5：ComfyUI 工作流模板（src/image/workflow.mjs）
 *
 * 工作流**由配置指定**（规格 §5：`comfyui` 的工作流不硬编码）。这里支持两种形态：
 *
 *   A. **对象模板**（推荐，`comfyui.workflow: { ... }` 或 `workflowPath` 指向的 JSON）
 *      我们把模板 JSON 解析成对象，然后**在对象上**替换占位符，最后交给
 *      `JSON.stringify` 序列化。提示词永远只是某个字符串字段的值，**结构上不可能**
 *      变成工作流节点 —— 这是最安全的形态。
 *
 *   B. **字符串模板**（`comfyui.workflow` 直接给一段 JSON 文本）
 *      在原始 JSON 文本上做替换，所以必须自己负责转义：文本类占位符用
 *      `escapeJsonStringContent()`（JSON.stringify 的转义规则）替换，数字类
 *      （seed/width/height）用十进制数字替换。替换是**单趟**的：替换结果不会被
 *      再扫描，用户提示词里就算写了 `{{seed}}` 也不会被二次注入。
 *
 * 占位符：
 *   {{prompt}} {{negative}} {{seed}} {{width}} {{height}}
 *
 * 另外支持 `comfyui.inject` 显式指定节点路径（真实工作流往往不含占位符）：
 *
 *   "inject": {
 *     "prompt":   "6.inputs.text",
 *     "negative": "7.inputs.text",
 *     "seed":     "3.inputs.seed",
 *     "width":    "5.inputs.width",
 *     "height":   "5.inputs.height"
 *   }
 *
 * 关键失败路径（都不静默）：
 *   - 模板里既没有 `{{prompt}}` 也没有 `inject.prompt` → 提示词会被丢掉 → ImageConfigError；
 *   - `inject` 路径指向不存在的节点 → ImageConfigError（**不**悄悄新建节点）；
 *   - 字符串模板替换后不是合法 JSON → ImageConfigError（占位符多半写在字符串外面）。
 *
 * 硬约束：纯函数、不联网、不读盘。
 */

import { ImageConfigError } from './errors.mjs';
import { escapeJsonStringContent } from './prompt.mjs';

/** 可注入的字段。数值类字段会被还原成 number（ComfyUI 的 seed/width/height 要整数）。 */
export const PLACEHOLDER_KEYS = Object.freeze([
  'prompt', 'negative', 'seed', 'width', 'height',
]);

/** 数值型占位符：替换成 number，不是字符串。 */
const NUMERIC_KEYS = new Set(['seed', 'width', 'height']);

const TOKEN_PATTERN = /\{\{(prompt|negative|seed|width|height)\}\}/gu;
const EXACT_TOKEN_PATTERN = /^\{\{(prompt|negative|seed|width|height)\}\}$/u;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typedValue(key, fields) {
  const raw = fields[key];
  if (raw === undefined || raw === null) return '';
  if (NUMERIC_KEYS.has(key)) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : raw;
  }
  return String(raw);
}

/**
 * 模板里是否出现某个占位符（对象或字符串模板都支持）。
 * @param {object|string|null|undefined} template
 * @param {string} key
 * @returns {boolean}
 */
export function hasPlaceholder(template, key) {
  if (template === null || template === undefined) return false;
  if (typeof template === 'string') return template.includes(`{{${key}}}`);
  if (Array.isArray(template)) return template.some((item) => hasPlaceholder(item, key));
  if (isPlainObject(template)) return Object.values(template).some((item) => hasPlaceholder(item, key));
  return false;
}

/** 单趟替换字符串里的所有占位符（替换结果不会再被扫描）。 */
function substituteTokens(text, fields) {
  return text.replace(TOKEN_PATTERN, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return match;
    return String(typedValue(key, fields));
  });
}

function walkTemplate(value, fields) {
  if (typeof value === 'string') {
    const exact = value.match(EXACT_TOKEN_PATTERN);
    if (exact) return typedValue(exact[1], fields);
    return substituteTokens(value, fields);
  }
  if (Array.isArray(value)) return value.map((item) => walkTemplate(item, fields));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = walkTemplate(item, fields);
    return out;
  }
  return value;
}

/**
 * 按 `a.b.c` 路径写值。路径不存在直接报错 —— 配置写错了要立刻知道，
 * 不能悄悄新建节点（那会生成一张"看起来成功但没听提示词"的图）。
 *
 * @param {object} target
 * @param {string} fieldPath
 * @param {unknown} value
 * @returns {object} target
 */
export function applyFieldPath(target, fieldPath, value) {
  if (typeof fieldPath !== 'string' || fieldPath.trim() === '') {
    throw new ImageConfigError('comfyui.inject 的路径必须是非空字符串');
  }
  if (!isPlainObject(target)) {
    throw new ImageConfigError('comfyui.inject 需要工作流是一个 JSON 对象');
  }
  const segments = fieldPath.trim().split('.');
  let cursor = target;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return target;
    }
    if (cursor === null || typeof cursor !== 'object' || !(segment in cursor)) {
      throw new ImageConfigError(
        `comfyui.inject 路径 '${fieldPath}' 不存在：第 ${index + 1} 段 '${segment}' 找不到`,
      );
    }
    cursor = cursor[segment];
  }
  return target;
}

function validateInject(inject) {
  if (inject === undefined || inject === null) return {};
  if (!isPlainObject(inject)) throw new ImageConfigError('comfyui.inject 必须是对象');
  const out = {};
  for (const [key, value] of Object.entries(inject)) {
    if (!PLACEHOLDER_KEYS.includes(key)) {
      throw new ImageConfigError(
        `comfyui.inject 里的 '${key}' 不是可注入字段（可用：${PLACEHOLDER_KEYS.join(' / ')}）`,
      );
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ImageConfigError(`comfyui.inject.${key} 必须是非空路径字符串`);
    }
    out[key] = value;
  }
  return out;
}

function applyInject(workflow, inject, fields) {
  for (const [key, fieldPath] of Object.entries(inject)) {
    applyFieldPath(workflow, fieldPath, typedValue(key, fields));
  }
  return workflow;
}

function assertPromptReachable(template, inject) {
  const reachable = hasPlaceholder(template, 'prompt') || Boolean(inject.prompt);
  if (!reachable) {
    throw new ImageConfigError(
      '工作流模板里没有 {{prompt}} 占位符，也没有配置 comfyui.inject.prompt —— '
      + '提示词会被丢掉，拒绝生成一张"没听提示词"的图',
    );
  }
}

/**
 * 对象模板 → 具体工作流对象。
 *
 * @param {object} template 模板对象（不会被修改）
 * @param {object} fields 字段值（prompt/negative/seed/width/height/style/model）
 * @param {{inject?: object}} [options]
 * @returns {object}
 * @throws {ImageConfigError}
 */
export function instantiateWorkflow(template, fields, options = {}) {
  if (!isPlainObject(template)) {
    throw new ImageConfigError('comfyui.workflow 必须是 JSON 对象（字符串模板请直接用字符串）');
  }
  const inject = validateInject(options.inject);
  assertPromptReachable(template, inject);

  // 深拷贝：模板是配置的一部分，多次生成之间不能被污染。
  const workflow = walkTemplate(JSON.parse(JSON.stringify(template)), fields);
  return applyInject(workflow, inject, fields);
}

/**
 * 字符串模板（一段 JSON 文本）→ 具体工作流对象。
 *
 * @param {string} rawTemplate
 * @param {object} fields
 * @param {{inject?: object}} [options]
 * @returns {object}
 * @throws {ImageConfigError}
 */
export function instantiateWorkflowString(rawTemplate, fields, options = {}) {
  if (typeof rawTemplate !== 'string' || rawTemplate.trim() === '') {
    throw new ImageConfigError('comfyui.workflow 字符串模板不能为空');
  }
  const inject = validateInject(options.inject);
  assertPromptReachable(rawTemplate, inject);

  const replaced = rawTemplate.replace(TOKEN_PATTERN, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return match;
    const value = fields[key];
    if (NUMERIC_KEYS.has(key)) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        throw new ImageConfigError(`工作流模板的 {{${key}}} 需要数字，收到 ${JSON.stringify(value)}`);
      }
      return String(numeric);
    }
    // 文本类：按 JSON 字符串转义规则放进去，提示词里的引号/反斜杠/换行都不会破坏 JSON。
    return escapeJsonStringContent(value ?? '');
  });

  let workflow;
  try {
    workflow = JSON.parse(replaced);
  } catch (error) {
    throw new ImageConfigError(
      '工作流字符串模板替换后不是合法 JSON —— 占位符多半写在了字符串外面'
      + `（${error?.message ?? error}）`,
      { cause: error },
    );
  }
  if (!isPlainObject(workflow)) {
    throw new ImageConfigError('工作流字符串模板必须解析成 JSON 对象');
  }
  return applyInject(workflow, inject, fields);
}

/**
 * 客户端创建时的**预检**：用占位字段试跑一遍模板。
 * 把「配置写坏了」挡在第一次调用之前（而不是生成时静默降级到云、把配置错误藏起来）。
 *
 * @param {object|string|null} template
 * @param {{inject?: object}} [options]
 */
export function validateWorkflowTemplate(template, options = {}) {
  if (template === null || template === undefined) return;
  const fields = {
    prompt: '预检提示词',
    negative: '',
    seed: 1,
    width: 1024,
    height: 1024,
  };
  if (typeof template === 'string') instantiateWorkflowString(template, fields, options);
  else instantiateWorkflow(template, fields, options);
}
