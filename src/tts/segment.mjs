/**
 * pond-check · 能力层 C4：分段与音频拼接（src/tts/segment.mjs）
 *
 * 三个纯函数组，不联网、不写盘、零依赖：
 *
 *   1. segmentText   长文本按标点分段（单段 ≤ 300 字，规格 §4 关键约束）
 *   2. concatAudio   多段音频拼接（wav 合并 RIFF 头，mp3/ogg 流式拼接）
 *   3. audioDurationMs / wavDurationMs / textDurationMs
 *                    时长尽量准确：wav 从头精确算；拿不到就估算并标 estimated
 *
 * 为什么分段放在统一层而不是每个 adapter 各写一遍：「单段 ≤ 300 字」是规格对
 * **全部** provider 的要求，写在一处，command / edge / 未来的 doubao 都不会漏。
 *
 * 硬不变量（tests/tts.test.mjs 钉死）：
 *   - segmentText(text).join('') === text —— 分段不丢、不改、不重排任何字符；
 *   - 每段长度 ≤ maxChars；
 *   - 空文本返回 []，不返回 ['']。
 */

/** 规格 §4：单段上限（字 / 字符数）。 */
export const SEGMENT_MAX_CHARS = 300;

/** 优先在这些标点后断开（全角 + 半角 + 换行）。 */
const SPLIT_PUNCTUATION = '，。！？；、：…—,.!?;:\n';

/**
 * 长文本按标点分段。
 *
 * 规则：
 *   1. 标点归在**前一段末尾**（说话的自然停顿）；
 *   2. 贪心合并小碎句，直到加上下一段会超限才收段；
 *   3. 单个「无标点长跑」超过 maxChars 时硬切 —— 不允许一段超过上限，
 *      哪怕切在词中间（300 字没有标点本身就是病态输入）。
 *
 * @param {string} text 原文
 * @param {number} [maxChars] 单段上限（缺省 SEGMENT_MAX_CHARS）
 * @returns {string[]} 分段，join('') 还原原文
 */
export function segmentText(text, maxChars = SEGMENT_MAX_CHARS) {
  if (typeof text !== 'string') throw new TypeError('segmentText: text 必须是字符串');
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new TypeError('segmentText: maxChars 必须是正整数');
  }
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  // 先按标点切成小片（标点留在片尾），小片就是「最自然的断句候选」。
  const pieces = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (SPLIT_PUNCTUATION.includes(text[index])) {
      pieces.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) pieces.push(text.slice(start));

  const segments = [];
  let current = '';
  const push = (part) => {
    if (part.length > 0) segments.push(part);
  };

  for (const piece of pieces) {
    let rest = piece;
    // 无标点长跑：先硬切出满段，剩下的再参与贪心合并。
    while (rest.length > maxChars) {
      if (current.length > 0) {
        push(current);
        current = '';
      }
      push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    if (current.length + rest.length > maxChars) {
      push(current);
      current = rest;
    } else {
      current += rest;
    }
  }
  push(current);
  return segments;
}

/* ------------------------------------------------------------------ *
 * WAV 头解析（精确时长 / 拼接合并用）
 * ------------------------------------------------------------------ */

/**
 * 解析 RIFF/WAVE：定位 fmt 与 data 块。
 * @param {Buffer|Uint8Array} buffer
 * @returns {{fmtStart: number, fmtEnd: number, dataStart: number, dataEnd: number}|null}
 */
export function parseWav(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(bytes.length, bodyStart + size);
    if (id === 'fmt ') fmt = [bodyStart, bodyEnd];
    else if (id === 'data') data = [bodyStart, bodyEnd];
    // RIFF 块按偶数字节对齐，奇数长度后有 1 字节填充。
    offset = bodyStart + size + (size % 2);
    if (data && fmt) break;
  }
  if (!fmt || !data) return null;
  return { fmtStart: fmt[0], fmtEnd: fmt[1], dataStart: data[0], dataEnd: data[1] };
}

/**
 * wav 精确时长（毫秒）。头里有 byteRate（每秒字节数），data 长度除一下就是时长。
 * @returns {number|null} 解析不了返回 null
 */
export function wavDurationMs(buffer) {
  const parsed = parseWav(buffer);
  if (!parsed) return null;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (parsed.fmtStart + 12 > bytes.length) return null;
  const byteRate = bytes.readUInt32LE(parsed.fmtStart + 8);
  if (!byteRate) return null;
  return ((parsed.dataEnd - parsed.dataStart) / byteRate) * 1000;
}

/**
 * 多段音频拼接。
 *
 *   - wav：合并 RIFF —— 保留第一段的头，data 逐段接起来，修 RIFF/data 两处长度。
 *           直接字节拼接会让后面的 wav 头被当成音频数据，时长与播放都会坏。
 *   - mp3 / ogg：流式格式，字节拼接即可（MPEG 帧/Ogg 页自同步）。
 *   - 任何一段解析不出 wav 头 → 退回字节拼接（不猜、不炸）。
 *
 * @param {(Buffer|Uint8Array)[]} buffers 各段音频
 * @param {string} [format] 'mp3' | 'wav' | 'ogg'
 * @returns {Buffer}
 */
export function concatAudio(buffers, format = 'mp3') {
  const list = (buffers ?? []).map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item ?? [])));
  if (list.length === 0) return Buffer.alloc(0);
  if (list.length === 1) return list[0];

  if (format === 'wav') {
    const parsed = list.map((item) => parseWav(item));
    if (parsed.every(Boolean)) {
      const first = list[0];
      const head = first.subarray(0, parsed[0].dataStart); // RIFF/WAVE/fmt 及其间的杂项块
      const payloads = list.map((item, index) => item.subarray(parsed[index].dataStart, parsed[index].dataEnd));
      const dataBytes = payloads.reduce((sum, item) => sum + item.length, 0);

      const out = Buffer.alloc(head.length + dataBytes);
      head.copy(out, 0);
      let offset = head.length;
      for (const payload of payloads) {
        payload.copy(out, offset);
        offset += payload.length;
      }
      // 修两处长度：RIFF 块大小（总长 - 8）与 data 块大小。
      out.writeUInt32LE(out.length - 8, 4);
      out.writeUInt32LE(dataBytes, parsed[0].dataStart - 4);
      return out;
    }
    // 解析不了就老实字节拼接 —— 比「聪明地猜」安全。
  }

  return Buffer.concat(list);
}

/* ------------------------------------------------------------------ *
 * 时长估算（拿不到精确值时）
 * ------------------------------------------------------------------ */

/**
 * 无精确值时的码率假设（字节/毫秒）：
 *   mp3 128kbps、ogg 96kbps —— 只影响「估算」标注的数值，不影响精确路径。
 */
export const FORMAT_BYTES_PER_MS = Object.freeze({ mp3: 16, ogg: 12 });

/**
 * 音频时长：wav 从头精确算，其余按码率估算并标 estimated。
 *
 * @param {Buffer|Uint8Array} buffer 一段（或拼接后）音频
 * @param {string} [format]
 * @param {{bytesPerSecond?: number}} [options] 显式码率（如 edge mp3 是 48kbps CBR）
 * @returns {{durationMs: number, estimated: boolean}}
 */
export function audioDurationMs(buffer, format = 'mp3', options = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);

  if (format === 'wav') {
    const exact = wavDurationMs(bytes);
    if (exact !== null) return { durationMs: Math.round(exact), estimated: false };
  }

  const bytesPerMs = options.bytesPerSecond
    ? options.bytesPerSecond / 1000
    : FORMAT_BYTES_PER_MS[format] ?? FORMAT_BYTES_PER_MS.mp3;
  return { durationMs: Math.round(bytes.length / bytesPerMs), estimated: true };
}

/**
 * 按文本估时长（连字节数都没有时的最后兜底）。
 * 经验值：中文约 4 字/秒（250ms/字），西文约 125ms/字 的 0.5 倍速估法（60ms/字）。
 * @param {string} text
 * @returns {number} 毫秒（整数，≥ 0）
 */
export function textDurationMs(text) {
  const value = String(text ?? '');
  let ms = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    const isCjk = (code >= 0x2E80 && code <= 0x9FFF)
      || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0xFF00 && code <= 0xFFEF);
    ms += isCjk ? 250 : 60;
  }
  return Math.round(ms);
}
