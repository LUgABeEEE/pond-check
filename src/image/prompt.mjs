/**
 * pond-check · 能力层 C5：提示词与尺寸（src/image/prompt.mjs）
 *
 * 图生成的第一道闸。用户把提示词、风格、尺寸交给这里，这里只做三件事：
 *
 *   1. **清洗与限长** —— 控制字符、行分隔符、双向覆盖字符（U+202A…）全部清掉；
 *      换行折成空格；长度硬上限（提示词 2000 字 / 负向提示词 800 字）。
 *      超长不是错误，是**截断并标记**（`truncated: true`）——直接拒绝会让用户
 *      的长创意白丢，静默截断又会让人以为全进去了，所以两者都要有痕迹。
 *
 *   2. **拆掉占位符序列** —— 提示词里出现 `{{seed}}` / `{{prompt}}` 这类 token
 *      时拆成 `{ {seed} }`。注入工作流时我们用的是**单趟替换**（替换结果不会被
 *      再扫描），所以这本来就是安全的；这一步是防御纵深：防止用户提示词里的
 *      token 在"以后有人改成多趟替换"时变成注入点。
 *
 *   3. **风格 / 尺寸归一化** —— `style` 只接受白名单里的语义值（anime/photo/
 *      pixel/illustration），映射成一句英文风格补语；`size` 或 `aspect` 二选一，
 *      解析成确定的像素宽高。未知值一律**抛 ImageInputError**，不猜、不静默忽略。
 *
 * 关于「文件名 / 路径 / URL 的转义」：
 *   这些内容本身是用户想让模型看见的文本，会**原样保留**；真正需要转义的是
 *   "它们作为 JSON 字符串内容"这件事 —— 由 `escapeJsonStringContent()` 负责
 *   （`workflow.mjs` 的字符串模板模式用它），对象模板模式则由 JSON.stringify
 *   在序列化时统一转义。两条路都不会把提示词变成工作流结构。
 *
 * 硬约束：纯函数、不联网、不读盘、零依赖。
 */

import { ImageInputError } from './errors.mjs';

/** 单条提示词硬上限（字符数）。超长截断并打标记。 */
export const MAX_PROMPT_CHARS = 2000;

/** 负向提示词硬上限（字符数）。 */
export const MAX_NEGATIVE_CHARS = 800;

/** 尺寸的合理区间：太小没意义，太大是配置写错（防止一次生成把显存吃光）。 */
export const SIZE_RANGE = Object.freeze({ min: 64, max: 4096 });

/**
 * 风格白名单：语义名 → 英文补语。
 * 没有列出的值一律拒绝 —— 悄悄忽略一个拼错的 `style: 'anme'` 等于骗人。
 */
export const STYLES = Object.freeze({
  anime: 'anime style',
  photo: 'photorealistic photograph',
  pixel: 'pixel art',
  illustration: 'digital illustration',
});

/**
 * 常用画幅 → 像素尺寸。
 * 只负责把「比例」翻译成一个确定的画布，不承诺 provider 一定按这个尺寸出图
 * （最终宽高以**实际图片**为准，见 output.mjs 的 detectImageFormat）。
 */
export const ASPECTS = Object.freeze({
  '1:1': Object.freeze({ width: 1024, height: 1024 }),
  '4:3': Object.freeze({ width: 1152, height: 864 }),
  '3:4': Object.freeze({ width: 864, height: 1152 }),
  '16:9': Object.freeze({ width: 1280, height: 720 }),
  '9:16': Object.freeze({ width: 720, height: 1280 }),
  '3:2': Object.freeze({ width: 1216, height: 832 }),
  '2:3': Object.freeze({ width: 832, height: 1216 }),
});

/** 默认画布。 */
export const DEFAULT_SIZE = Object.freeze({ width: 1024, height: 1024 });

/**
 * 会被清掉的控制 / 格式字符：
 * C0（保留 \t \n \r，稍后统一折成空格）、DEL、C1、双向覆盖（Trojan Source 类）、BOM。
 * 这些字符进 JSON 是合法的，但会污染工作流文本、日志与终端显示。
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/** 需要从 JSON 字符串内容里转义的字符（JSON.stringify 的统一实现，别自己写一套）。 */
export function escapeJsonStringContent(text) {
  const json = JSON.stringify(String(text));
  // JSON.stringify 保证结果是带引号的字符串；去掉首尾引号即得「可安全放进 JSON 字符串」的内容。
  return json.slice(1, -1);
}

/**
 * 清洗一段文本。
 *
 * @param {unknown} raw 原始文本
 * @param {{maxLength?: number, field?: string}} [options]
 * @returns {{text: string, truncated: boolean, originalLength: number, length: number}}
 * @throws {ImageInputError} 非字符串 / 清洗后为空
 */
export function sanitizeText(raw, options = {}) {
  const maxLength = Number.isSafeInteger(options.maxLength) && options.maxLength > 0
    ? options.maxLength
    : MAX_PROMPT_CHARS;
  const field = options.field ?? 'prompt';

  if (typeof raw !== 'string') {
    throw new ImageInputError(`${field} 必须是字符串（收到 ${raw === null ? 'null' : typeof raw}）`);
  }

  const originalLength = raw.length;
  let text = raw
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_CHARS, ' ');

  // 换行 / 制表 / 连续空白统一折成一个空格：工作流文本节点只接受单行文本，
  // 多行会在某些工作流里被当成额外输入。
  text = text.replace(/\s+/gu, ' ').trim();

  if (text === '') {
    throw new ImageInputError(`${field} 不能为空（清洗后没有可用的文字）`);
  }

  // 占位符序列拆开：`{{seed}}` → `{ {seed} }`（见文件头「防御纵深」）。
  text = text.replace(/\{\{/gu, '{ {').replace(/\}\}/gu, '} }');

  const truncated = text.length > maxLength;
  if (truncated) {
    // 保留 maxLength 个字符，最后一个用省略号，让调用方看得出被截断了。
    text = `${text.slice(0, maxLength - 1).trimEnd()}…`;
  }

  return { text, truncated, originalLength, length: text.length };
}

/**
 * 解析画布尺寸。`size`（显式像素）优先于 `aspect`（比例）。
 *
 * @param {{size?: string|{width:number,height:number}|null, aspect?: string|null}} [input]
 * @returns {{width: number, height: number, label: string, source: 'size'|'aspect'|'default'}}
 * @throws {ImageInputError} 形态不认识 / 超出范围
 */
export function parseSize(input = {}) {
  const { size, aspect } = input;

  if (size !== undefined && size !== null) {
    let width;
    let height;

    if (typeof size === 'string') {
      const matched = size.trim().match(/^(\d{2,5})\s*[x×X]\s*(\d{2,5})$/u);
      if (!matched) {
        throw new ImageInputError(`size 必须形如 1024x1024，收到 ${JSON.stringify(size)}`);
      }
      width = Number(matched[1]);
      height = Number(matched[2]);
    } else if (typeof size === 'object' && !Array.isArray(size)) {
      width = size.width;
      height = size.height;
    } else {
      throw new ImageInputError(`size 必须是 '宽x高' 字符串或 { width, height }，收到 ${typeof size}`);
    }

    assertDimension(width, 'width');
    assertDimension(height, 'height');
    return { width, height, label: `${width}x${height}`, source: 'size' };
  }

  if (aspect !== undefined && aspect !== null) {
    const key = String(aspect).trim();
    const spec = ASPECTS[key];
    if (!spec) {
      throw new ImageInputError(
        `aspect '${key}' 不认识（可用：${Object.keys(ASPECTS).join(' / ')}）`,
      );
    }
    return { width: spec.width, height: spec.height, label: `${spec.width}x${spec.height}`, source: 'aspect' };
  }

  return { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, label: `${DEFAULT_SIZE.width}x${DEFAULT_SIZE.height}`, source: 'default' };
}

function assertDimension(value, field) {
  if (!Number.isSafeInteger(value) || value < SIZE_RANGE.min || value > SIZE_RANGE.max) {
    throw new ImageInputError(
      `${field} 必须是 ${SIZE_RANGE.min}..${SIZE_RANGE.max} 之间的整数，收到 ${JSON.stringify(value)}`,
    );
  }
}

/**
 * 校验并归一化 seed。
 * @param {unknown} seed
 * @returns {number|null} 未提供返回 null
 * @throws {ImageInputError} 非法 seed
 */
export function normalizeSeed(seed) {
  if (seed === undefined || seed === null) return null;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new ImageInputError(`seed 必须是 >= 0 的安全整数，收到 ${JSON.stringify(seed)}`);
  }
  return seed;
}

/**
 * 合成最终提示词：清洗 + 风格补语 + 负向提示词。
 *
 * @param {{prompt: unknown, style?: string|null, negative?: unknown, maxPrompt?: number, maxNegative?: number}} input
 * @returns {{
 *   prompt: string, negative: string, style: string|null, styleHint: string,
 *   truncated: boolean, promptTruncated: boolean, negativeTruncated: boolean,
 * }}
 * @throws {ImageInputError}
 */
export function composePrompt(input = {}) {
  const maxPrompt = input.maxPrompt ?? MAX_PROMPT_CHARS;
  const maxNegative = input.maxNegative ?? MAX_NEGATIVE_CHARS;

  const style = input.style === undefined || input.style === null ? null : String(input.style).trim();
  let styleHint = '';
  if (style !== null) {
    if (!Object.prototype.hasOwnProperty.call(STYLES, style)) {
      throw new ImageInputError(`style '${style}' 不认识（可用：${Object.keys(STYLES).join(' / ')}）`);
    }
    styleHint = STYLES[style];
  }

  const base = sanitizeText(input.prompt, { maxLength: maxPrompt, field: 'prompt' });
  let prompt = styleHint ? `${base.text}, ${styleHint}` : base.text;
  let truncated = base.truncated;
  if (prompt.length > maxPrompt) {
    prompt = `${prompt.slice(0, maxPrompt - 1).trimEnd()}…`;
    truncated = true;
  }

  const rawNegative = input.negative;
  let negative = '';
  let negativeTruncated = false;
  if (rawNegative !== undefined && rawNegative !== null && String(rawNegative).trim() !== '') {
    const cleaned = sanitizeText(rawNegative, { maxLength: maxNegative, field: 'negative' });
    negative = cleaned.text;
    negativeTruncated = cleaned.truncated;
  }

  return {
    prompt,
    negative,
    style,
    styleHint,
    truncated: truncated || negativeTruncated,
    promptTruncated: base.truncated,
    negativeTruncated,
  };
}
