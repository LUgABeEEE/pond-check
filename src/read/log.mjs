/**
 * pond-check · D3a 日志尾部读取（src/read/log.mjs）
 *
 * 职责：把一个日志文件的**最后一段**读进内存，并抽出六指标需要的三样东西：
 *   1. 最后一条能解析的时间戳（多格式尝试，解析不出来就 null，绝不猜）
 *   2. 最后 N 行原文（默认 50 行，给「健康」栏和报告正文展示）
 *   3. 命中关键词的分类计数（登录失效 / 风控 412 / 限流 429 / 验证码 / 熔断 / 报错…）
 *
 * 为什么只读尾部（docs/SPEC.md §3.4 预算与超时）：
 *   日志可能是几百 MB。用 fd + position 直接定位到文件末尾往前 maxBytes 处读一次，
 *   绝不 readFileSync 整份文件 —— 体检不能把用户的机器拖慢，也不能因为日志大就先 OOM。
 *
 * 硬约束：
 *   - 只读：open 只给 'r'，不写、不 stat 之外的任何副作用，不启停进程。
 *   - 预算：DEFAULT_TAIL_BYTES = 64 KiB（本模块默认口径），物理读取的硬上限是
 *     rules.json budget.tailBytes（256 KiB），调用方传更大也只读到这个数。
 *     「最多读 tailBytes」是上限不是指标，读更少只会更省，不会越界。
 *   - 不崩：非 UTF-8 / 二进制 / 半行截断 / 权限不足 / 文件不存在 / 是目录 / 是管道
 *     —— 全部走返回值，绝不抛异常。
 *   - 凭证闸（第二道防线）：文件名或所在目录命中 rules.json 的凭证模式时直接拒绝读，
 *     返回 {ok:false, reason:'sensitive_skipped'}，真实路径替换成 SENSITIVE_PATH_TOKEN。
 *     D2b 已经在发现层挡过一次，这里再挡一次：本模块是唯一会 open 文件的地方。
 *
 * 契约：
 *   readLogTail(filePath | { path, ...options }, options?) -> Promise<LogTail>
 *     options.maxBytes     读取字节上限，缺省 64 KiB，上限 rules.budget.tailBytes
 *     options.tailLines    返回最后多少行，缺省 50，上限 rules.budget.tailLines(500)
 *     options.maxSamples   每个关键词分类最多留几条样例，缺省 5
 *     options.maxLineChars 单行最多保留多少字符，缺省 2000（防「一行 64KB」撑爆报告）
 *     options.categories   覆盖关键词分类表（缺省取 rules.indicators.health.thresholds.categories）
 *     options.timeoutMs    读取超时，缺省 0 = 不设（聚合层有自己的 indicatorTimeoutMs）
 *
 *   LogTail（ok:true）：
 *     { ok, path, size, bytesRead, fromOffset, truncated, firstLinePartial,
 *       encoding:'utf8-loose', hasBinary, lines[], lineCount, linesTruncated,
 *       lastTimestamp, keywords:{categories[], hardHits, softHits, matched[]}, degraded[] }
 *   LogTail（ok:false）：
 *     { ok:false, reason, ...少量上下文 }   reason ∈ sensitive_skipped | enoent | eacces |
 *     not_a_file | empty | read_error | timeout
 *
 *   另外导出纯函数给下游复用（D4 的 rhythm 要按行取时间戳）：
 *     parseTimestamp(text) / findLastTimestamp(lines) / classifyLine(text, categories) /
 *     loadKeywordCategories() / DEFAULT_TAIL_BYTES / MAX_TAIL_BYTES / DEFAULT_TAIL_LINES
 */

import { open, stat, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isSensitiveFileName,
  isSensitiveDirName,
  isCredentialishDirName,
  SENSITIVE_PATH_TOKEN,
} from '../discover/generic.mjs';

/* ------------------------------------------------------------------ *
 * 预算常量（来自 rules.json，读不到就用 SPEC §3.4 的值兜底）
 * ------------------------------------------------------------------ */

const RULES_URL = new URL('../rules.json', import.meta.url);

function loadRules() {
  try {
    return JSON.parse(readFileSync(RULES_URL, 'utf8'));
  } catch {
    return null;
  }
}

const RULES = loadRules();

/** 默认读多少字节：与 SPEC §3.4 / rules.json budget.tailBytes 对齐（256 KiB）。
 *
 * 早期实现这里的默认值是 64 KiB，而 SPEC 与 rules.json 都写 262144 —— 那是
 * 任务描述写错了。默认值必须等于预算上限，否则调用方不显式传参就会把
 * health 的 24h 窗口静默缩到 64 KiB，日志一大就漏掉真正的 429。
 * 调用方仍可显式传更小的 maxBytes 来省内存。 */
export const DEFAULT_TAIL_BYTES = Number(RULES?.budget?.tailBytes) > 0
  ? Number(RULES.budget.tailBytes)
  : 262144;

/** 物理读取硬上限：与 SPEC §3.4 / rules.json budget.tailBytes 对齐（256 KiB） */
export const MAX_TAIL_BYTES = Number(RULES?.budget?.tailBytes) > 0
  ? Number(RULES.budget.tailBytes)
  : 262144;

/** 默认返回最后 50 行 */
export const DEFAULT_TAIL_LINES = 50;

/** 行数上限：rules.json budget.tailLines（500） */
export const MAX_TAIL_LINES = Number(RULES?.budget?.tailLines) > 0
  ? Number(RULES.budget.tailLines)
  : 500;

const DEFAULT_MAX_SAMPLES = 5;
const DEFAULT_MAX_LINE_CHARS = 2000;

/* ------------------------------------------------------------------ *
 * 关键词分类：直接从 rules.json 的 health 阈值表搬过来
 *
 * 本模块**不判定**健康等级（那是 D4 的事），只负责把「哪类关键词出现了几次、
 * 最近一次是什么时候」数清楚。hard/soft 也照 rules.json 标注，下游算
 * hardHits / softHits 时不用再猜。
 * ------------------------------------------------------------------ */

/** rules.json 读不到时的兜底（覆盖任务点名的 error/412/429/登录失效/验证码/熔断/captcha/rate limit） */
const FALLBACK_CATEGORIES = [
  {
    id: 'loginExpired', nameZh: '登录失效', kind: 'hard',
    keywords: ['登录失效', '未登录', '登录过期', '请重新登录', '登录状态失效',
      'cookie 失效', 'cookie过期', 'token expired', '401', 'unauthorized', 'invalid csrf'],
  },
  {
    id: 'riskControl', nameZh: '风控拦截', kind: 'hard',
    keywords: ['412', 'Precondition Failed', '请求被拦截', '风控', '-412', '403', 'Forbidden', 'access denied'],
  },
  {
    id: 'rateLimited', nameZh: '被限流', kind: 'hard',
    keywords: ['429', 'Too Many Requests', 'rate limit', '请求过于频繁', '操作频繁'],
  },
  {
    id: 'captcha', nameZh: '验证码', kind: 'hard',
    keywords: ['验证码', 'captcha', 'geetest', '滑块', '极验', '人机验证'],
  },
  {
    id: 'breaker', nameZh: '熔断', kind: 'hard',
    keywords: ['熔断', 'circuit breaker', 'circuit open', '已冷却', 'cooldown', '暂停发送', 'too many failures'],
  },
  {
    id: 'runtimeError', nameZh: '运行报错', kind: 'soft',
    keywords: ['error', 'Traceback', 'Exception', 'Unhandled', 'panic', 'FATAL', '致命'],
  },
  {
    id: 'ioError', nameZh: '系统报错', kind: 'soft',
    keywords: ['ENOENT', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ETIMEDOUT', 'No such file', 'permission denied', '磁盘', 'disk full'],
  },
];

function normalizeCategories(raw) {
  const list = Array.isArray(raw) && raw.length > 0 ? raw : FALLBACK_CATEGORIES;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const keywords = Array.isArray(item.keywords)
      ? item.keywords.filter((k) => typeof k === 'string' && k.length > 0)
      : [];
    if (keywords.length === 0) continue;
    out.push({
      id: typeof item.id === 'string' && item.id ? item.id : 'unknown',
      nameZh: typeof item.nameZh === 'string' && item.nameZh ? item.nameZh : item.id,
      kind: item.kind === 'soft' ? 'soft' : 'hard',
      keywords,
      fix: typeof item.fix === 'string' ? item.fix : '',
    });
  }
  return out.length > 0 ? out : normalizeCategories(FALLBACK_CATEGORIES);
}

/** 关键词分类表（下游也能拿去给 stderr 之类的内容分类） */
export function loadKeywordCategories() {
  const fromRules = RULES?.indicators?.health?.thresholds?.categories;
  return normalizeCategories(fromRules);
}

const CATEGORY_CACHE = loadKeywordCategories();

/* ------------------------------------------------------------------ *
 * 关键词匹配
 *
 * 纯数字关键词（401 / 412 / 429 / -412）用「前后不是数字或点」的边界匹配：
 * 否则 `sleep 4121ms`、`build 1.412.0` 都会被算成风控命中，把「健康」栏
 * 直接推到 critical —— 这种假报警比漏报更伤信任。其余关键词按大小写不敏感子串。
 * ------------------------------------------------------------------ */

const NUMERIC_KEYWORD_RE = /^-?\d+$/;
const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(text) {
  return text.replace(REGEX_ESCAPE_RE, '\\$&');
}

function compileCategory(category) {
  const matchers = category.keywords.map((keyword) => {
    const lower = keyword.toLowerCase();
    if (NUMERIC_KEYWORD_RE.test(lower)) {
      return { keyword, lower, re: new RegExp(`(?<![\\d.])${escapeRegExp(lower)}(?![\\d.])`) };
    }
    return { keyword, lower, re: null };
  });
  return { ...category, matchers };
}

const COMPILED_CATEGORY_CACHE = new Map();

function compiledCategories(categories) {
  const key = categories === CATEGORY_CACHE ? 'default' : null;
  if (key && COMPILED_CATEGORY_CACHE.has(key)) return COMPILED_CATEGORY_CACHE.get(key);
  const compiled = categories.map(compileCategory);
  if (key) COMPILED_CATEGORY_CACHE.set(key, compiled);
  return compiled;
}

/**
 * 一行文本命中了哪些分类。
 * @param {string} text
 * @param {Array} [categories] 缺省用 rules.json 的分类表
 * @returns {Array<{id:string, kind:'hard'|'soft', matched:string[]}>}
 */
export function classifyLine(text, categories = CATEGORY_CACHE) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lowerAll = text.toLowerCase();
  const hits = [];
  for (const category of compiledCategories(categories)) {
    const matched = [];
    for (const matcher of category.matchers) {
      if (matcher.re) {
        if (matcher.re.test(lowerAll)) matched.push(matcher.keyword);
      } else if (lowerAll.includes(matcher.lower)) {
        matched.push(matcher.keyword);
      }
    }
    if (matched.length > 0) {
      hits.push({ id: category.id, kind: category.kind, nameZh: category.nameZh, matched });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * 时间戳解析（多格式尝试）
 *
 * 只认「明确长得像时间」的字符串，并且做范围校验：月份 1-12、日 1-31、
 * 时 0-23…… 避免把 412、版本号、毫秒数误当成时间。
 * 返回 null 表示「没认出来」，调用方据此报 unknown，绝不拿当前时间顶替。
 * ------------------------------------------------------------------ */

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

function inRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function toMillis(parts) {
  const ms = new Date(
    parts.year, parts.month - 1, parts.day,
    parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, parts.millis ?? 0,
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function plausible(ms) {
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_MS && ms <= MAX_PLAUSIBLE_MS;
}

/** 无年份格式（MM-DD / Syslog）按「最近的过去」补年份，并标记 yearAssumed */
function assumeYear(month, day, hour, minute, second) {
  const now = new Date();
  let year = now.getFullYear();
  let ms = toMillis({ year, month, day, hour, minute, second });
  if (ms === null) return null;
  // 日志不会来自未来；比现在晚一天以上就说明是去年的（跨年那一周）
  if (ms - now.getTime() > 24 * 60 * 60 * 1000) {
    year -= 1;
    ms = toMillis({ year, month, day, hour, minute, second });
  }
  return { ms, yearAssumed: true };
}

/**
 * 从一段文本里找第一条可解析的时间戳。
 * @param {string} text 通常是一行日志
 * @returns {{raw:string, ms:number, iso:string, format:string, tz:string,
 *            yearAssumed:boolean, timeAssumed:boolean}|null}
 */
export function parseTimestamp(text) {
  if (typeof text !== 'string' || text.length < 8) return null;

  // 1) ISO 8601（带 T 和时区）：直接交给 Date.parse，时区语义最可靠
  const isoMatch = text.match(
    /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})\b/,
  );
  if (isoMatch) {
    const ms = Date.parse(`${isoMatch[0].replace(/\s+/, 'T')}`);
    if (plausible(ms)) {
      return buildResult(isoMatch[0], ms, 'iso', 'utc', false, false);
    }
  }

  // 2) 本地时区 naive 时间：2026-11-07 10:00:00 / 2026/11/07 10:00:00,123
  const naive = text.match(
    /\b(\d{4})[-/](\d{2})[-/](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?/,
  );
  if (naive) {
    const parts = {
      year: Number(naive[1]), month: Number(naive[2]), day: Number(naive[3]),
      hour: Number(naive[4]), minute: Number(naive[5]),
      second: naive[6] === undefined ? 0 : Number(naive[6]),
      millis: naive[7] === undefined ? 0 : Number(naive[7].padEnd(3, '0').slice(0, 3)),
    };
    if (inRange(parts.month, 1, 12) && inRange(parts.day, 1, 31) &&
        inRange(parts.hour, 0, 23) && inRange(parts.minute, 0, 59) &&
        inRange(parts.second, 0, 60)) {
      const ms = toMillis(parts);
      if (plausible(ms)) {
        return buildResult(naive[0], ms, 'datetime', 'local', false, naive[6] === undefined);
      }
    }
  }

  // 3) 中文：2026年11月7日 10:00:00
  const zh = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (zh) {
    const parts = {
      year: Number(zh[1]), month: Number(zh[2]), day: Number(zh[3]),
      hour: Number(zh[4]), minute: Number(zh[5]),
      second: zh[6] === undefined ? 0 : Number(zh[6]),
    };
    if (inRange(parts.month, 1, 12) && inRange(parts.day, 1, 31) &&
        inRange(parts.hour, 0, 23) && inRange(parts.minute, 0, 59)) {
      const ms = toMillis(parts);
      if (plausible(ms)) return buildResult(zh[0], ms, 'datetime-zh', 'local', false, zh[6] === undefined);
    }
  }

  // 4) epoch：[1699300000] / 1699300000000 开头（10 位秒 / 13 位毫秒）
  const epoch = text.match(/^\s*\[?(\d{10}|\d{13})(?!\d)/);
  if (epoch) {
    const raw = Number(epoch[1]);
    const ms = epoch[1].length === 13 ? raw : raw * 1000;
    if (plausible(ms)) return buildResult(epoch[0].trim(), ms, 'epoch', 'utc', false, false);
  }

  // 5) 只有日期：2026-11-07（当作当天 00:00，标记 timeAssumed）
  const dateOnly = text.match(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (dateOnly) {
    const parts = { year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3]) };
    if (inRange(parts.month, 1, 12) && inRange(parts.day, 1, 31)) {
      const ms = toMillis(parts);
      if (plausible(ms)) return buildResult(dateOnly[0], ms, 'date', 'local', false, true);
    }
  }

  // 6) 无年份：11-07 10:00:00 / 11/07 10:00:00（行首）
  const monthDay = text.match(/^\s*\[?(\d{2})[-/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    const hour = Number(monthDay[3]);
    const minute = Number(monthDay[4]);
    const second = Number(monthDay[5]);
    if (inRange(month, 1, 12) && inRange(day, 1, 31) &&
        inRange(hour, 0, 23) && inRange(minute, 0, 59) && inRange(second, 0, 60)) {
      const assumed = assumeYear(month, day, hour, minute, second);
      if (assumed && plausible(assumed.ms)) {
        return buildResult(monthDay[0].trim(), assumed.ms, 'monthday', 'local', true, false);
      }
    }
  }

  // 7) Syslog：Nov  7 10:00:00
  const syslog = text.match(/^\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (syslog) {
    const month = MONTH_NAMES[syslog[1].toLowerCase()];
    const day = Number(syslog[2]);
    const hour = Number(syslog[3]);
    const minute = Number(syslog[4]);
    const second = Number(syslog[5]);
    if (month && inRange(day, 1, 31) && inRange(hour, 0, 23) &&
        inRange(minute, 0, 59) && inRange(second, 0, 60)) {
      const assumed = assumeYear(month, day, hour, minute, second);
      if (assumed && plausible(assumed.ms)) {
        return buildResult(syslog[0].trim(), assumed.ms, 'syslog', 'local', true, false);
      }
    }
  }

  return null;
}

function buildResult(raw, ms, format, tz, yearAssumed, timeAssumed) {
  return {
    raw: raw.trim(),
    ms,
    iso: new Date(ms).toISOString(),
    format,
    tz,
    yearAssumed,
    timeAssumed,
  };
}

/**
 * 从行数组里从后往前找最后一条能解析的时间戳。
 * 解析不出来就返回 null —— 下游据此把「节律」判成 unknown，不许拿当前时间顶替。
 * @param {string[]} lines
 * @returns {(object & {linesAgo:number})|null}
 */
export function findLastTimestamp(lines) {
  if (!Array.isArray(lines)) return null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (typeof line !== 'string' || line.length === 0) continue;
    if (!/\d{2}/.test(line)) continue; // 纯文字行不值得跑正则
    const parsed = parseTimestamp(line);
    if (parsed) return { ...parsed, linesAgo: lines.length - 1 - i };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 只读尾部：fd + position 定位，绝不整份读
 * ------------------------------------------------------------------ */

const BYTE_LF = 0x0a;

/**
 * @returns {Promise<{size:number, start:number, buffer:Buffer, bytesRead:number,
 *                    firstLinePartial:boolean}|{reason:string}>}
 */
async function readTailBuffer(absPath, maxBytes) {
  let handle;
  try {
    handle = await open(absPath, 'r');
  } catch (err) {
    return { reason: mapErrorReason(err) };
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { reason: 'not_a_file' };
    const size = stat.size;
    if (size === 0) return { reason: 'empty', size: 0 };

    const span = Math.min(maxBytes, size);
    const start = size - span;
    const buffer = Buffer.allocUnsafe(span);
    let filled = 0;
    while (filled < span) {
      const { bytesRead } = await handle.read(buffer, filled, span - filled, start + filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }

    // 起始位置落在行中间时，首行是半截的：标出来，由上层丢弃
    let firstLinePartial = false;
    if (start > 0 && filled > 0) {
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(probe, 0, 1, start - 1);
      firstLinePartial = bytesRead === 1 ? probe[0] !== BYTE_LF : true;
    }

    return { size, start, buffer: buffer.subarray(0, filled), bytesRead: filled, firstLinePartial };
  } catch (err) {
    return { reason: mapErrorReason(err) };
  } finally {
    await handle.close().catch(() => {});
  }
}

function mapErrorReason(err) {
  const code = err && err.code;
  if (code === 'ENOENT') return 'enoent';
  if (code === 'EACCES' || code === 'EPERM') return 'eacces';
  if (code === 'EISDIR') return 'not_a_file';
  return 'read_error';
}

/* ------------------------------------------------------------------ *
 * 解码与切行
 * ------------------------------------------------------------------ */

/** 二进制/坏字节判定：NUL 或高比例替换字符都算「这份日志不是给人读的文本」 */
function detectBinary(buffer, text) {
  let nul = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      nul += 1;
      if (nul > 4) return true;
    }
  }
  if (buffer.length > 0) {
    const replacements = text.split('\uFFFD').length - 1;
    if (replacements / Math.max(1, text.length) > 0.1) return true;
  }
  return false;
}

function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  // 文件以换行结尾时，split 会多出一个空尾巴 —— 它不是「最后一行」
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function clampLine(line, maxChars) {
  if (line.length <= maxChars) return { text: line, truncated: false };
  return { text: `${line.slice(0, maxChars)}…`, truncated: true };
}

/* ------------------------------------------------------------------ *
 * 关键词统计
 * ------------------------------------------------------------------ */

function emptyCategoryStat(category) {
  return {
    id: category.id,
    nameZh: category.nameZh,
    kind: category.kind,
    count: 0,
    samples: [],
    samplesTruncated: false,
    lastAt: null,
    lastLinesAgo: null,
    matchedKeywords: [],
  };
}

function tallyLines(lines, categories, maxSamples, maxLineChars) {
  const compiled = compiledCategories(categories);
  const stats = new Map();
  for (const category of compiled) stats.set(category.id, emptyCategoryStat(category));

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const lower = line.toLowerCase();
    for (const category of compiled) {
      let matchedKeywords = null;
      for (const matcher of category.matchers) {
        const hit = matcher.re ? matcher.re.test(lower) : lower.includes(matcher.lower);
        if (!hit) continue;
        if (!matchedKeywords) matchedKeywords = [];
        matchedKeywords.push(matcher.keyword);
      }
      if (!matchedKeywords) continue;

      const stat = stats.get(category.id);
      stat.count += 1;
      stat.lastLinesAgo = lines.length - 1 - i;
      const parsed = parseTimestamp(line);
      if (parsed) stat.lastAt = parsed.iso;
      for (const keyword of matchedKeywords) {
        if (!stat.matchedKeywords.includes(keyword)) stat.matchedKeywords.push(keyword);
      }

      const sample = clampLine(line, maxLineChars);
      stat.samples.push({
        text: sample.text,
        at: parsed ? parsed.iso : null,
        linesAgo: stat.lastLinesAgo,
      });
      // 只留最近 maxSamples 条：报告要的是「最近怎么了」，不是全量证据
      if (stat.samples.length > maxSamples) {
        stat.samples.shift();
        stat.samplesTruncated = true;
      }
    }
  }

  const categoriesOut = [];
  let hardHits = 0;
  let softHits = 0;
  const matched = [];
  for (const category of compiled) {
    const stat = stats.get(category.id);
    categoriesOut.push(stat);
    if (stat.count > 0) matched.push(category.id);
    if (category.kind === 'hard') hardHits += stat.count;
    else softHits += stat.count;
  }
  return { categories: categoriesOut, hardHits, softHits, matched };
}

/* ------------------------------------------------------------------ *
 * 凭证闸（第二道防线）
 * ------------------------------------------------------------------ */

function sensitiveReason(absPath) {
  const base = path.basename(absPath);
  const parent = path.basename(path.dirname(absPath));
  if (isSensitiveFileName(base)) return 'file_name';
  if (isSensitiveDirName(parent)) return 'parent_dir';
  if (isCredentialishDirName(base) || isCredentialishDirName(parent)) return 'credentialish_dir';
  return null;
}

/* ------------------------------------------------------------------ *
 * 参数归一
 * ------------------------------------------------------------------ */

function normalizeOptions(args) {
  let target = args;
  let options = {};
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    if (typeof args.path === 'string') {
      target = args.path;
      options = args;
    } else if (typeof args.file === 'string') {
      target = args.file;
      options = args;
    } else {
      target = null;
    }
  }
  return { target, options: options && typeof options === 'object' ? options : {} };
}

function normalizeBudget(options) {
  const requestedBytes = Number(options.maxBytes);
  const maxBytes = Number.isFinite(requestedBytes) && requestedBytes > 0
    ? Math.min(Math.floor(requestedBytes), MAX_TAIL_BYTES)
    : DEFAULT_TAIL_BYTES;

  const requestedLines = Number(options.tailLines);
  const tailLines = Number.isFinite(requestedLines) && requestedLines > 0
    ? Math.min(Math.floor(requestedLines), MAX_TAIL_LINES)
    : DEFAULT_TAIL_LINES;

  const requestedSamples = Number(options.maxSamples);
  const maxSamples = Number.isFinite(requestedSamples) && requestedSamples > 0
    ? Math.floor(requestedSamples)
    : DEFAULT_MAX_SAMPLES;

  const requestedChars = Number(options.maxLineChars);
  const maxLineChars = Number.isFinite(requestedChars) && requestedChars > 0
    ? Math.floor(requestedChars)
    : DEFAULT_MAX_LINE_CHARS;

  const categories = Array.isArray(options.categories) && options.categories.length > 0
    ? normalizeCategories(options.categories)
    : CATEGORY_CACHE;

  return { maxBytes, tailLines, maxSamples, maxLineChars, categories };
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 读日志尾部。永不抛异常 —— 出错一律走 {ok:false, reason}。
 * @param {string|{path:string}} filePath 日志路径
 * @param {object} [options]
 * @returns {Promise<object>} LogTail
 */
export async function readLogTail(filePath, options = {}) {
  const args = normalizeOptions(filePath);
  const target = args.target;
  const opts = { ...args.options, ...(options && typeof options === 'object' ? options : {}) };

  if (typeof target !== 'string' || target.length === 0) {
    return { ok: false, reason: 'bad_path' };
  }

  let absPath;
  try {
    absPath = path.resolve(target);
  } catch {
    return { ok: false, reason: 'bad_path' };
  }

  // 凭证闸：命中就不 open，真实路径也不进返回值（SPEC §2.4 第一道闸）
  const sensitive = sensitiveReason(absPath);
  if (sensitive) {
    return { ok: false, reason: 'sensitive_skipped', path: SENSITIVE_PATH_TOKEN, detail: sensitive };
  }

  // 预检：先 stat（不 open）挡掉目录 / 管道 / 设备文件 —— 对 FIFO 做 open('r') 会直接挂住，
  // 体检工具绝不能在用户机器上卡死。再用 realpath 复查一次凭证闸，堵掉「软链接改个名绕过」。
  let pre;
  try {
    pre = await stat(absPath);
  } catch (err) {
    return { ok: false, reason: mapErrorReason(err) };
  }
  if (!pre.isFile()) return { ok: false, reason: 'not_a_file' };

  let realPath = absPath;
  try {
    realPath = await realpath(absPath);
  } catch {
    realPath = absPath;
  }
  const realSensitive = realPath === absPath ? null : sensitiveReason(realPath);
  if (realSensitive) {
    return { ok: false, reason: 'sensitive_skipped', path: SENSITIVE_PATH_TOKEN, detail: realSensitive };
  }

  const budget = normalizeBudget(opts);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;

  try {
    const work = readAndAnalyze(realPath, budget);
    if (timeoutMs > 0) {
      const result = await withTimeout(work, timeoutMs);
      return result;
    }
    return await work;
  } catch {
    // 兜底：只读操作不值得让整次体检失败，但也不许把「读崩了」说成「没事」
    return { ok: false, reason: 'read_error' };
  }
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'timeout', timeoutMs });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'read_error' });
      },
    );
  });
}

async function readAndAnalyze(absPath, budget) {
  const tail = await readTailBuffer(absPath, budget.maxBytes);
  if (tail.reason) {
    const out = { ok: false, reason: tail.reason };
    if (typeof tail.size === 'number') out.size = tail.size;
    return out;
  }

  const { size, start, buffer, bytesRead, firstLinePartial } = tail;

  // 宽松解码：坏字节一律落成 U+FFFD，不抛、不中断（Buffer 截断处也可能是半个字符）
  const text = buffer.toString('utf8');
  const hasBinary = detectBinary(buffer, text);
  const degraded = [];
  if (firstLinePartial) degraded.push({ indicator: 'log', reason: 'first_line_partial' });
  if (hasBinary) degraded.push({ indicator: 'log', reason: 'binary_content' });

  let allLines = splitLines(text);
  if (firstLinePartial && allLines.length > 1) {
    // 首行是半截的，丢掉它（它前面的字节不在窗口里，拼不回来）
    allLines = allLines.slice(1);
  }
  // 极端情况：整份窗口只有一「行」（日志从没换过行）。丢掉就什么都不剩了，
  // 这时保留这段半截内容 —— 它是尾部（最新）的那一截，比空结果更有用。

  const lineStats = allLines.map((line) => clampLine(line, budget.maxLineChars));
  const lineTruncated = lineStats.some((item) => item.truncated);
  if (lineTruncated) degraded.push({ indicator: 'log', reason: 'long_line_clipped' });

  const linesTruncated = lineStats.length > budget.tailLines;
  const lines = linesTruncated
    ? lineStats.slice(lineStats.length - budget.tailLines).map((item) => item.text)
    : lineStats.map((item) => item.text);

  // 关键词在**整个读取窗口**里数，不在最后 50 行里数：
  // 健康栏关心「这段窗口里出过几次 412」，截到 50 行会把证据吃掉。
  const keywords = tallyLines(allLines, budget.categories, budget.maxSamples, budget.maxLineChars);

  const lastTimestamp = findLastTimestamp(allLines);
  if (!lastTimestamp) degraded.push({ indicator: 'log', reason: 'no_timestamp' });
  else if (lastTimestamp.yearAssumed) degraded.push({ indicator: 'log', reason: 'timestamp_year_assumed' });
  else if (lastTimestamp.timeAssumed) degraded.push({ indicator: 'log', reason: 'timestamp_time_assumed' });

  return {
    ok: true,
    path: absPath,
    size,
    bytesRead,
    fromOffset: start,
    truncated: start > 0,
    firstLinePartial,
    encoding: 'utf8-loose',
    hasBinary,
    lines,
    lineCount: allLines.length,
    linesTruncated,
    lastTimestamp: lastTimestamp
      ? {
        raw: lastTimestamp.raw,
        iso: lastTimestamp.iso,
        ms: lastTimestamp.ms,
        format: lastTimestamp.format,
        tz: lastTimestamp.tz,
        yearAssumed: lastTimestamp.yearAssumed,
        timeAssumed: lastTimestamp.timeAssumed,
        linesAgo: lastTimestamp.linesAgo,
      }
      : null,
    keywords,
    degraded,
  };
}

export default readLogTail;
