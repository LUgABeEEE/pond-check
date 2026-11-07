/**
 * pond-check · D5c 稳定 JSON 输出（src/render/json.mjs）
 *
 * 职责：把 D4 的 Report 渲染成**结构稳定**的 JSON 文本（2 空格缩进）。
 *   renderJson(report) -> string
 *   buildJsonReport(report) -> object   （规范化后的对象，供测试看字段序）
 *
 * 硬要求（任务契约）：
 *   1. 字段命名与 D3/D4 中间结构一致，不另起一套 —— report / fishes / indicators
 *      的字段名原样沿用；新增的只有顶层 meta（生成时间、pond-check 版本、扫描条数）。
 *   2. 结构稳定：同输入永远同字段顺序 —— 已知层级**显式构造**固定字段序，
 *      自由袋（evidence）递归按 key 排序，绝不依赖输入对象的属性顺序。
 *   3. 不含凭证文件名或敏感信息 —— 上游五道闸之外，这里再加一道「值级脱敏」：
 *      形似文件路径/文件名且命中 rules.json credentials.skipFilePatterns 的字符串
 *      一律替换成 sensitivePathToken；人话文本（含空格/中文）不在此列，不会误伤
 *      「把新的 cookie/token 存回原处」这种修复建议。
 *   4. 顶层 schemaVersion：取 report.schemaVersion（= rules.schemaVersion），
 *      缺省 1 —— JSON 输出格式与报告结构同版本演进。
 *   5. 顶层 meta：{ generatedAt, pondCheckVersion, scanCount }。
 *      generatedAt 收进 meta（字段名不变），顶层不再重复一份。
 *
 * 只读：只读仓库自己的 package.json / src/rules.json 取常量，不碰任何用户数据，
 * 不联网、零 npm 依赖。永不抛：report 缺失/畸形也返回一份合法 JSON（空报告）。
 */

import { readFileSync } from 'node:fs';

/** JSON 输出契约版本（与 report.schemaVersion 同源，缺省 1）。 */
export const JSON_SCHEMA_VERSION_FALLBACK = 1;

/** 报告六格的固定顺序（与 D4 evaluate 的 indicators 键一致）。 */
const INDICATOR_ORDER = ['liveness', 'rhythm', 'throughput', 'health', 'deps', 'drift'];

/* ------------------------------------------------------------------ *
 * 常量：sensitivePathToken / skipFilePatterns / pond-check 版本
 * ------------------------------------------------------------------ */

const FALLBACK_TOKEN = '[凭证文件已跳过]';
const FALLBACK_SKIP_PATTERNS = [
  '*credential*', '*cred*', '*secret*', '*cookie*', '*token*',
  '*auth*', '*password*', '*.key', '*.pem', 'id_rsa*', 'id_ed25519*',
  'authorized_keys', 'known_hosts', '.netrc',
];

function readJsonAt(url) {
  try {
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null;
  }
}

const RULES = readJsonAt(new URL('../rules.json', import.meta.url));
const SENSITIVE_PATH_TOKEN = typeof RULES?.credentials?.sensitivePathToken === 'string'
  ? RULES.credentials.sensitivePathToken
  : FALLBACK_TOKEN;
const SKIP_FILE_PATTERNS = Array.isArray(RULES?.credentials?.skipFilePatterns)
  ? RULES.credentials.skipFilePatterns.filter((p) => typeof p === 'string')
  : FALLBACK_SKIP_PATTERNS;
const PKG = readJsonAt(new URL('../../package.json', import.meta.url));
const POND_CHECK_VERSION = typeof PKG?.version === 'string' ? PKG.version : null;

/* ------------------------------------------------------------------ *
 * 值级脱敏：形似文件名/路径且命中凭证模式 → sensitivePathToken
 *
 * 「形似」的口径（防误伤）：无空白、无中文、长度 <= 255，且
 *   - 含路径分隔符（/ 或 \），或
 *   - 以 .扩展名 结尾（.json/.key/.env…），或
 *   - 与无通配符的模式整名相等（authorized_keys 这类），或
 *   - 与「前缀*」型模式的前缀整名相等（id_ed25519 这种无扩展名的 SSH 文件）。
 * 'unauthorized' 这类命中 '*auth*' 的普通词不含分隔符/扩展名、也不是整名，
 * 不会被误删；'token expired' 这类带空格的日志关键词同理。
 * ------------------------------------------------------------------ */

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

const SKIP_REGEXES = SKIP_FILE_PATTERNS.map((pattern) => ({ pattern, re: wildcardToRegExp(pattern) }));

function looksLikePathName(value) {
  if (typeof value !== 'string' || value === '' || value.length > 255) return false;
  if (/\s/.test(value)) return false;                       // 空白 = 一句话，不是文件名
  if (/[\u3000-\u9fff\uf900-\ufaff]/.test(value)) return false; // 中文 = 人话
  if (value.includes('/') || value.includes('\\')) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(value)) return true;
  return false;
}

function matchesSkipPattern(value) {
  let anyMatch = false;

  // 模式是**按文件名**定义的（`id_ed25519*`、`.npmrc`），而输入常是**完整路径**。
  // 只拿整串去匹配会永远差一口气：`^id_ed25519.*$` 匹配不上 `/home/u/.ssh/id_ed25519`。
  // 所以整串和 basename 各试一遍。（D8c 变异测试：fixes 长版曾整段漏掉脱敏。）
  const candidates = [value];
  const base = value.split(/[/\\]/u).pop();
  if (base && base !== value) candidates.push(base);

  for (const candidate of candidates) {
    for (const { pattern, re } of SKIP_REGEXES) {
      if (!re.test(candidate)) continue;
      anyMatch = true;
      // 无通配符的整名模式：authorized_keys / known_hosts / .netrc / .npmrc → 无条件脱敏
      const hasWildcards = pattern.includes('*') || pattern.includes('?');
      if (!hasWildcards) return true;
      // 「前缀*」单侧模式的整名：id_ed25519 / id_rsa 这类无扩展名 SSH 文件
      const onlyTrailing = pattern.endsWith('*')
        && !pattern.slice(0, -1).includes('*')
        && !pattern.includes('?');
      if (onlyTrailing && candidate.toLowerCase() === pattern.slice(0, -1).toLowerCase()) return true;
    }
  }
  // 宽模式（*auth* 等）只咬「形似文件名/路径」的字符串 —— 防误伤
  // 'unauthorized'、'token expired' 这类普通词/日志关键词。
  return anyMatch && looksLikePathName(value);
}

/** 单个字符串脱敏（不可疑原样返回）。 */
function scrubString(value) {
  if (typeof value !== 'string') return null;
  return matchesSkipPattern(value) ? SENSITIVE_PATH_TOKEN : value;
}

/** 自由袋：递归脱敏 + key 排序（保证同内容必同文本）。 */
function canonicalBag(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => canonicalBag(item));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      out[key] = canonicalBag(item);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value ?? null;
}

/* ------------------------------------------------------------------ *
 * 小工具：永不抛的取值
 * ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value) {
  return typeof value === 'string' ? (scrubString(value) ?? value) : null;
}

function rawStr(value) {
  return typeof value === 'string' ? value : null;
}

function num(value) {
  return Number.isFinite(value) ? value : null;
}

function bool(value) {
  return typeof value === 'boolean' ? value : null;
}

function strArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item !== '').map((item) => scrubString(item) ?? item);
}

/* ------------------------------------------------------------------ *
 * 显式字段序构造（每一层的键顺序写死，不跟输入走）
 * ------------------------------------------------------------------ */

function buildMeta(report, fishCount) {
  return {
    generatedAt: rawStr(report?.generatedAt) ?? new Date().toISOString(),
    pondCheckVersion: POND_CHECK_VERSION,
    scanCount: fishCount,
  };
}

function buildHost(report) {
  return {
    platform: rawStr(report?.host?.platform),
    node: rawStr(report?.host?.node),
  };
}

function buildDegraded(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(isObject).map((item) => ({
    indicator: rawStr(item.indicator),
    reason: rawStr(item.reason),
    missing: strArray(item.missing),
  }));
}

function buildProcess(items) {
  if (!Array.isArray(items)) return [];
  return items.filter(isObject).map((item) => ({
    pid: num(item.pid),
    alive: bool(item.alive),
    startedAtSec: num(item.startedAtSec),
  }));
}

function buildCell(cell) {
  const source = isObject(cell) ? cell : {};
  // value 可能是数字也可能是短字符串；NaN/Infinity 一律降级成 null
  let value = null;
  if (typeof source.value === 'number' && Number.isFinite(source.value)) value = source.value;
  else if (typeof source.value === 'string') value = scrubString(source.value);
  return {
    id: rawStr(source.id),
    nameZh: rawStr(source.nameZh),
    level: rawStr(source.level),
    severity: rawStr(source.severity),
    value,
    unit: rawStr(source.unit),
    evidence: canonicalBag(isObject(source.evidence) ? source.evidence : {}),
    phenomenon: str(source.phenomenon),
    nextStep: str(source.nextStep),
    degraded: buildDegraded(source.degraded),
  };
}

function buildIndicators(indicators) {
  const source = isObject(indicators) ? indicators : {};
  const out = {};
  for (const id of INDICATOR_ORDER) {
    out[id] = buildCell(source[id]);
  }
  return out;
}

function buildFish(fish) {
  const source = isObject(fish) ? fish : {};
  return {
    id: rawStr(source.id),
    kind: rawStr(source.kind),
    kindNameZh: rawStr(source.kindNameZh),
    name: str(source.name),
    stateRoot: str(source.stateRoot),
    processes: buildProcess(source.processes),
    indicators: buildIndicators(source.indicators),
    severity: rawStr(source.severity),
    // 鱼级分桶（关键格口径），与 severity（最差格）并存：一个决定怎么报，一个决定怎么排
    bucket: rawStr(source.bucket),
    // 有没有运行痕迹：none = 像鱼但什么都没留下；unreadable = 有痕迹读不出；present = 读到了
    trace: rawStr(source.trace),
    traceHint: str(source.traceHint),
    worstIndicator: rawStr(source.worstIndicator),
    headline: str(source.headline),
    // 和 fixesShort 用同一道脱敏：同一个字段的两个版本不该有两套待遇。
    // （D8c 变异测试发现 fixesShort 脱敏、fixes 不脱敏 —— 长版才是默认展示的那个。）
    fixes: Array.isArray(source.fixes)
      ? source.fixes.map((item) => (typeof item === 'string' && item !== '' ? scrubString(item) : null))
      : [],
    // 与 fixes 一一对应的短版（可能含 null），供窄屏/群聊使用
    fixesShort: Array.isArray(source.fixesShort)
      ? source.fixesShort.map((item) => (typeof item === 'string' && item !== '' ? scrubString(item) : null))
      : [],
    degraded: buildDegraded(source.degraded),
    notes: strArray(source.notes),
  };
}

function buildBuckets(buckets) {
  const source = isObject(buckets) ? buckets : {};
  return {
    ok: num(source.ok) ?? 0,
    watch: num(source.watch) ?? 0,
    bad: num(source.bad) ?? 0,
    unknown: num(source.unknown) ?? 0,
  };
}

function buildTraceCounts(counts) {
  const source = isObject(counts) ? counts : {};
  return {
    none: num(source.none) ?? 0,
    unreadable: num(source.unreadable) ?? 0,
    present: num(source.present) ?? 0,
  };
}

function buildSummary(summary, fishCount) {
  const source = isObject(summary) ? summary : {};
  return {
    fish: num(source.fish) ?? fishCount,
    ok: num(source.ok) ?? 0,
    watch: num(source.watch) ?? 0,
    bad: num(source.bad) ?? 0,
    unknown: num(source.unknown) ?? 0,
  };
}

function buildSkippedSensitive(skipped) {
  const source = isObject(skipped) ? skipped : {};
  return {
    count: num(source.count) ?? 0,
    // names 按 D4 契约是常量 token，绝无文件名；万一上游塞了别的，脱敏兜底
    names: str(source.names) ?? SENSITIVE_PATH_TOKEN,
  };
}

/**
 * 把 Report 规范化成字段序稳定的 JSON 对象。
 * 与 D3/D4 中间结构字段名一致；新增仅顶层 meta。
 * @param {object} report D4 evaluate() 的 Report（畸形输入按空报告处理）
 */
export function buildJsonReport(report) {
  const source = isObject(report) ? report : {};
  const fishes = Array.isArray(source.fishes) ? source.fishes.filter(isObject) : [];
  return {
    schemaVersion: num(source.schemaVersion) ?? JSON_SCHEMA_VERSION_FALLBACK,
    meta: buildMeta(source, fishes.length),
    host: buildHost(source),
    fishes: fishes.map(buildFish),
    summary: buildSummary(source.summary, fishes.length),
    // 鱼级分桶（数鱼）与 summary（数格）是两套口径，都给出来，别让人猜
    fishBuckets: buildBuckets(source.fishBuckets),
    traceCounts: buildTraceCounts(source.traceCounts),
    bucketNote: str(source.bucketNote),
    traceNote: str(source.traceNote),
    verdict: str(source.verdict),
    nextAction: str(source.nextAction),
    footnote: str(source.footnote),
    degradedCount: num(source.degradedCount) ?? 0,
    skippedSensitive: buildSkippedSensitive(source.skippedSensitive),
  };
}

/**
 * 渲染稳定 JSON 文本（2 空格缩进）。
 * @param {object} report D4 evaluate() 的 Report
 * @returns {string} 同输入必得同文本；永不抛
 */
export function renderJson(report) {
  try {
    return JSON.stringify(buildJsonReport(report), null, 2);
  } catch {
    // 理论上到不了：buildJsonReport 全程兜底。真到了也给一份合法空报告。
    return JSON.stringify(buildJsonReport({}), null, 2);
  }
}

export default renderJson;
