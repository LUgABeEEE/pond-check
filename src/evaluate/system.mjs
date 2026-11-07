/**
 * pond-check · D4b 系统类三指标（src/evaluate/system.mjs）
 *
 * 负责 SPEC §4.4 health / §4.5 deps / §4.6 drift 三条指标。数据全部来自 D3 的
 * PondRead 对象，本模块**不自己读日志、不自己探 PATH**（唯一例外见 drift：为了核对
 * 字段改名表，需要再读一次配置的**键名存在性**，且只看布尔值、绝不取值）。
 *
 * 输入（PondRead，见 src/read/index.mjs）：
 *   health ← pondData.log（D3a readLogTail 结果）+ pondData.sources.log
 *   deps   ← pondData.deps / pondData.credentials / pondData.config / pondData.sources.config
 *   drift  ← pondData.config（schemaVersion/pluginVersion）+ pondData.paths.config
 *
 * 输出（SPEC §6.2 的 indicator 形状）：
 *   { id, nameZh, level, severity, value, unit, evidence, phenomenon, nextStep, degraded[] }
 *     level    ∈ rules.indicators.<id> 的 bands[].level ∪ {'unknown'}（不自己发明档位）
 *     severity = rules.indicators.<id>.diagnosis[level].severity（不自己编）
 *     value    = rules.indicators.<id>.thresholds.metric 的值；判不出时为 null
 *     evidence = 给人排障用的结构化事实；**不含凭证路径 / 文件名 / 字段值**
 *
 * 三条不可协商的实现口径：
 *   1. **阈值只从 src/rules.json 读**。本文件不出现任何判定数字（秒数窗口、
 *      Node 主版本下限、凭证天数、磁盘字节阈值…）；出现即缺陷。分档一律走
 *      rules.indicators.<id>.thresholds.bands，有序、先命中者赢。
 *   2. **关键词表只有一份**，就是 D3a 从 rules.json 读出来的那份。health 直接消费
 *      log.keywords.{hardHits,softHits,matched,categories}，本文件不定义任何关键词；
 *      类别的中文名与修法（fix）按 id 回查 rules.json 的同一张表。
 *   3. **数据不足一律 unknown**，绝不默认正常；unknown 必须带 reason + missing[]，
 *      并且 phenomenon / nextStep 要说人话（照着就能做）。
 *
 * 契约（供 D4 收口 / CLI 调用）：
 *   evaluateHealth(pondData, options?) -> Indicator
 *   evaluateDeps(pondData, options?)   -> Indicator
 *   evaluateDrift(pondData, options?)  -> Indicator
 *   evaluateSystem(pondData, options?) -> { health, deps, drift, degraded[], notes[] }
 *   另有可复用件：getRules / setRules / getSpec / bandLevel / diagnose /
 *   fillTemplate / SEVERITY_RANK
 *
 *   options：
 *     now             时间基准（ms）；缺省用 pondData.now，再缺省 Date.now()
 *     configPath      覆盖配置路径（缺省 pondData.paths.config）
 *     fieldPresence   drift 用的「键名存在性」注入（dotted path → boolean）。
 *                     构造测试时用它，免得为了两三个布尔值去造配置文件；
 *                     不传就自己读一次配置（生产路径）。
 *     tolerant        true 时把「规格破洞」降级成 unknown 而不是抛错（CLI 用）
 *     ffmpegOptional  显式声明「这条鱼不产视频」，ffmpeg 缺失降为 warn
 *     read            直接把 PondRead 传进来（等价于 pondData 本身）
 *
 * 关于抛错：本项目读取层「永不抛」，但判定层不同 —— SPEC §4 明确要求
 * 「bands 一条都没命中 / valueRef 指向不存在的键 / 诊断模板缺变量」属于**规格破洞，
 * 实现必须抛错，不许悄悄返回 ok**。这些异常全部带 `spec_defect:` / `spec_hole:`
 * 前缀，方便测试直接断言；生产路径可用 tolerant:true 兜成 unknown + evidence.specHole。
 *
 * 只读：本文件只 fs.statSync / fs.readFileSync（配置的键名存在性），不写、不联网、
 * 不启停进程、不执行任何外部命令。
 */

import fs from 'node:fs';
import path from 'node:path';

import { isSensitiveFileName, isSensitiveDirName } from '../discover/generic.mjs';

/* ------------------------------------------------------------------ *
 * 0. 常量（注意：这里只有「单位换算」和「读取预算」，没有判定阈值）
 * ------------------------------------------------------------------ */

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

/** 配置文件大小上限：与 D3b 的解析上限一致。这是读取预算，不是判定阈值。 */
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/**
 * 日志「窗口过期」的附注（当日志最后一条早于 windowHours 时追加到 healthy 话术后面）。
 *
 * 为什么需要它：health 的 bands 只数 hardHits / softHits（SPEC §4.4），而读取窗口是
 * 日志尾部若干字节 —— 如果这条鱼五天前就停了，尾部里的 0 次报错会被判成 clean，
 * 而 clean 的话术是「最近 24 小时日志里没看到报错」，这句话在没有 24h 内日志时是假的。
 * 这里不改档位（不发明新 level），只在话术后面把话说全，并留 evidence.windowStale。
 */
const STALE_WINDOW_CAVEAT = Object.freeze({
  phenomenon: '（注意：日志最后一条是 {ageHuman}前写的，最近 {windowHours} 小时她根本没写日志 —— '
    + '上面的结论只反映更早的那段日志，不等于「最近没出事」。）',
  nextStep: '先看「存活」那栏确认她还在跑；等她重新写日志、日志有了新内容，再体检一次健康。',
});

/* ------------------------------------------------------------------ *
 * 1. rules.json：唯一阈值来源
 * ------------------------------------------------------------------ */

const RULES_URL = new URL('../rules.json', import.meta.url);

function readRulesFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(RULES_URL, 'utf8'));
  } catch {
    return null;
  }
}

let RULES = readRulesFromDisk();

/** 取当前生效的 rules 对象（只读使用；测试可先 setRules 注入副本）。 */
export function getRules() {
  return RULES;
}

/**
 * 注入一份 rules 对象（测试用：临时改常量，断言档位跟着变）。
 * 传 null 表示重新从磁盘读。
 */
export function setRules(rules) {
  RULES = rules && typeof rules === 'object' ? rules : readRulesFromDisk();
  return RULES;
}

/** 取某个指标的规格；不存在就是规格破洞，直接抛。 */
export function getSpec(indicatorId) {
  const spec = RULES?.indicators?.[indicatorId];
  if (!spec) throw new Error(`spec_defect:unknown_indicator:${indicatorId}`);
  return spec;
}

/** severity 排序表（来自 rules.severity.rank；坏的排上面用）。 */
export const SEVERITY_RANK = Object.freeze({ ...(RULES?.severity?.rank ?? {}) });

/* ------------------------------------------------------------------ *
 * 2. 分档引擎（SPEC §4「唯一实现口径」）
 * ------------------------------------------------------------------ */

const OPS = Object.freeze({
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  eq: (a, b) => a === b,
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 解析条件里的比较值：value 是字面量，valueRef 指向同指标 constants 的键。 */
function resolveThresholdValue(spec, cond) {
  if (Object.prototype.hasOwnProperty.call(cond, 'value')) return cond.value;
  if (typeof cond.valueRef === 'string') {
    const constants = spec?.thresholds?.constants ?? {};
    if (Object.prototype.hasOwnProperty.call(constants, cond.valueRef)) {
      return constants[cond.valueRef];
    }
    // 指向不存在的键 = 规格缺陷（SPEC §4 第 3 条），必须炸出来
    throw new Error(`spec_defect:unknown_valueRef:${spec.id}:${cond.valueRef}`);
  }
  throw new Error(`spec_defect:band_without_value:${spec.id}`);
}

/** bands 与主指标里引用到的所有 metric 名。 */
function referencedMetrics(spec) {
  const names = new Set();
  if (typeof spec?.thresholds?.metric === 'string') names.add(spec.thresholds.metric);
  for (const band of spec?.thresholds?.bands ?? []) {
    for (const cond of band?.allOf ?? []) {
      if (typeof cond?.metric === 'string') names.add(cond.metric);
    }
  }
  return [...names];
}

/**
 * 按 bands 分档。
 *
 * 口径（SPEC §4）：
 *   1. 主指标或 bands 里任一 metric 不是有限数字 → unknown（不进 bands）。
 *      —— 这条决定了「读不到」永远不会被误判成某个正常档。
 *   2. bands 有序，先命中者赢。
 *   3. 一条都没命中 = 规格破洞，抛错（不是返回 ok）。
 *
 * @returns {{level:string, reason:string|null, missing:string[]}}
 */
export function bandLevel(spec, metrics = {}) {
  for (const name of referencedMetrics(spec)) {
    if (!isFiniteNumber(metrics[name])) {
      return { level: 'unknown', reason: 'metric_unavailable', missing: [name] };
    }
  }

  for (const band of spec.thresholds?.bands ?? []) {
    const hit = (band.allOf ?? []).every((cond) => {
      const op = OPS[cond.op];
      if (typeof op !== 'function') {
        throw new Error(`spec_defect:unknown_op:${spec.id}:${cond.op}`);
      }
      return op(metrics[cond.metric], resolveThresholdValue(spec, cond));
    });
    if (hit) return { level: band.level, reason: null, missing: [] };
  }

  throw new Error(`spec_hole:${spec.id}:no_band_matched`);
}

/** 带兜底的分档：tolerant 模式下规格破洞降级成 unknown 并留痕。 */
function safeBands(spec, metrics, options) {
  try {
    return bandLevel(spec, metrics);
  } catch (err) {
    if (options?.tolerant !== true) throw err;
    return {
      level: 'unknown',
      reason: 'spec_hole',
      missing: [],
      specHole: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------------------------------------------ *
 * 3. 话术模板（rules.diagnosis）—— 占位必须填满
 * ------------------------------------------------------------------ */

/** 把 {var} 换成实参；缺变量 = 规格破洞（报告里留着 {var} 就是缺陷）。 */
export function fillTemplate(text, vars = {}, context = '') {
  if (typeof text !== 'string' || text === '') {
    throw new Error(`spec_defect:empty_template${context ? `:${context}` : ''}`);
  }
  const filled = text.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`spec_defect:diagnosis_var_missing:${name}${context ? `:${context}` : ''}`);
    }
    return String(value);
  });
  if (/\{[A-Za-z0-9_]+\}/.test(filled)) {
    throw new Error(`spec_defect:unfilled_var${context ? `:${context}` : ''}`);
  }
  return filled;
}

/**
 * 取 rules 里某个 level 的诊断话术，并把变量填满。
 * @returns {{severity:string, phenomenon:string, nextStep:string}}
 */
export function diagnose(spec, level, vars = {}, options = {}) {
  const tpl = spec?.diagnosis?.[level];
  if (!tpl) throw new Error(`spec_defect:missing_diagnosis:${spec.id}:${level}`);

  const allowed = new Set(RULES?.severity?.values ?? []);
  if (allowed.size > 0 && !allowed.has(tpl.severity)) {
    throw new Error(`spec_defect:bad_severity:${spec.id}:${level}:${tpl.severity}`);
  }

  const context = `${spec.id}:${level}`;
  return {
    severity: tpl.severity,
    phenomenon: fillTemplate(tpl.phenomenon, vars, context),
    nextStep: fillTemplate(tpl.nextStep, vars, context),
  };
}

/* ------------------------------------------------------------------ *
 * 4. 通用小工具
 * ------------------------------------------------------------------ */

/** 兼容两种入参：PondRead 本身，或 { read: PondRead } 包装。 */
function pickRead(pondData, options) {
  if (options?.read && typeof options.read === 'object') return options.read;
  if (!pondData || typeof pondData !== 'object') return {};
  const hasAny = 'log' in pondData || 'deps' in pondData || 'config' in pondData;
  if (!hasAny && pondData.read && typeof pondData.read === 'object') return pondData.read;
  return pondData;
}

function resolveNow(read, options) {
  if (isFiniteNumber(options?.now)) return options.now;
  if (isFiniteNumber(read?.now)) return read.now;
  return Date.now();
}

/** 源的结论摘要：只保留 status / reason，路径一律不带（凭证闸）。 */
function sourceSummary(source) {
  if (!source || typeof source !== 'object') return null;
  return {
    status: typeof source.status === 'string' ? source.status : null,
    reason: typeof source.reason === 'string' ? source.reason : null,
  };
}

function humanBytes(bytes) {
  if (!isFiniteNumber(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 秒 → 人话（「3 天」「5 小时」「12 分钟」）。 */
function humanAge(ageSec) {
  if (!isFiniteNumber(ageSec)) return '未知时间';
  const sec = Math.max(0, Math.round(ageSec));
  if (sec < SECONDS_PER_MINUTE) return `${sec} 秒`;
  if (sec < SECONDS_PER_HOUR) return `${Math.floor(sec / SECONDS_PER_MINUTE)} 分钟`;
  if (sec < SECONDS_PER_DAY) return `${Math.floor(sec / SECONDS_PER_HOUR)} 小时`;
  return `${Math.floor(sec / SECONDS_PER_DAY)} 天`;
}

function maxFixesPerFish() {
  const value = RULES?.rollup?.maxFixesPerFish;
  return isFiniteNumber(value) && value > 0 ? value : 3;
}

/** 统一的 unknown 出口：档位 + 原因 + 缺什么 + 降级留痕，一处收口。 */
function unknownIndicator(spec, { reason, evidence = {}, missing = [], notes = [] }) {
  const diag = diagnose(spec, 'unknown', {});
  return {
    id: spec.id,
    nameZh: spec.nameZh,
    level: 'unknown',
    severity: diag.severity,
    value: null,
    unit: spec.unit,
    evidence: { ...evidence, reason, missing: missing.slice(), ...(notes.length > 0 ? { notes } : {}) },
    phenomenon: diag.phenomenon,
    nextStep: diag.nextStep,
    degraded: [{ indicator: spec.id, reason, missing: missing.slice() }],
  };
}

/* ------------------------------------------------------------------ *
 * 5. health · 健康（SPEC §4.4）
 * ------------------------------------------------------------------ */

/**
 * 健康：日志尾部窗口里命中了几次 hard / soft 类别。
 *
 * 关键词与计数**全部来自 D3a**（log.keywords），本函数不做任何文本匹配 ——
 * 两处关键词表必然漂移，这是本项目最忌讳的缺陷类型（任务书硬要求）。
 * 这里只做三件事：挑档位、选「主角类别」、把对应类别的 fix 拼成一句建议。
 */
export function evaluateHealth(pondData = {}, options = {}) {
  const spec = getSpec('health');
  const constants = spec.thresholds.constants ?? {};
  const read = pickRead(pondData, options);
  const nowMs = resolveNow(read, options);
  const logSource = read.sources?.log ?? null;
  const log = read.log && typeof read.log === 'object' ? read.log : null;

  // 5.1 没有日志对象 / 日志读失败 → unknown（SPEC §4.4 unknownWhen 前三条）
  if (!log) {
    const reason = logSource?.status === 'skipped_sensitive'
      ? 'sensitive_skipped'
      : (logSource?.reason ?? 'not_found');
    return unknownIndicator(spec, {
      reason,
      evidence: { source: sourceSummary(logSource), windowHours: constants.windowHours ?? null },
      missing: ['log'],
    });
  }
  if (log.ok !== true) {
    return unknownIndicator(spec, {
      reason: typeof log.reason === 'string' && log.reason !== '' ? log.reason : 'read_error',
      evidence: {
        source: sourceSummary(logSource),
        windowHours: constants.windowHours ?? null,
        bytesRead: isFiniteNumber(log.bytesRead) ? log.bytesRead : null,
      },
      missing: ['log'],
    });
  }

  // 5.1b 二进制内容 → unknown（假健康禁令，队长裁定 B1）
  //
  // 二进制日志里不可能有可解析的关键词，「0 命中」绝不等于「干净」。
  // D3 已经在 degraded 里标了 (health, binary_content)；如果这里按关键词 0 命中
  // 判 clean，报告会写「健康 干净」并把它算进「正常」—— 这是本项目最不能犯的错。
  if (log.hasBinary === true) {
    return unknownIndicator(spec, {
      reason: 'binary_content',
      evidence: {
        source: sourceSummary(logSource),
        windowHours: constants.windowHours ?? null,
        bytesRead: isFiniteNumber(log.bytesRead) ? log.bytesRead : null,
        hasBinary: true,
      },
      missing: ['log'],
    });
  }

  // 5.2 日志尾部没有可用行 → unknown（「日志尾部无可读行」）
  const lineCount = isFiniteNumber(log.lineCount)
    ? log.lineCount
    : (Array.isArray(log.lines) ? log.lines.length : 0);
  const keywords = log.keywords && typeof log.keywords === 'object' ? log.keywords : null;

  if (lineCount === 0) {
    return unknownIndicator(spec, {
      reason: 'no_lines',
      evidence: { source: sourceSummary(logSource), lineCount, windowHours: constants.windowHours ?? null },
      missing: ['log'],
    });
  }
  if (!keywords || !isFiniteNumber(keywords.hardHits) || !isFiniteNumber(keywords.softHits)) {
    // D3a 没给出计数 = 关键词表没接上（规格/接线问题），不是「没问题」
    return unknownIndicator(spec, {
      reason: 'keywords_unavailable',
      evidence: { source: sourceSummary(logSource), lineCount },
      missing: ['log'],
    });
  }

  const hardHits = keywords.hardHits;
  const softHits = keywords.softHits;

  // 5.3 窗口事实：能不能用「24 小时」这个说法
  const windowHours = isFiniteNumber(constants.windowHours) ? constants.windowHours : null;
  const lastMs = isFiniteNumber(log.lastTimestamp?.ms) ? log.lastTimestamp.ms : null;
  const logAgeSec = lastMs === null ? null : Math.max(0, Math.round((nowMs - lastMs) / 1000));
  const windowApproximated = lastMs === null;
  const windowStale = !windowApproximated
    && windowHours !== null
    && logAgeSec !== null
    && logAgeSec > windowHours * SECONDS_PER_HOUR;

  // 5.4 分档（阈值全在 rules.json）
  const levelInfo = safeBands(spec, { hardHits, softHits }, options);
  if (levelInfo.level === 'unknown') {
    return unknownIndicator(spec, {
      reason: levelInfo.reason ?? 'metric_unavailable',
      evidence: { source: sourceSummary(logSource), hardHits, softHits, missingMetrics: levelInfo.missing },
      missing: levelInfo.missing ?? [],
      notes: levelInfo.specHole ? [levelInfo.message] : [],
    });
  }
  const level = levelInfo.level;

  // 5.5 命中的类别（中文名与 fix 按 id 回查 rules.json 的同一张表）
  const ruleCategories = new Map(
    (spec.thresholds.categories ?? []).map((item) => [item.id, item]),
  );
  const categories = [];
  for (const stat of Array.isArray(keywords.categories) ? keywords.categories : []) {
    const count = isFiniteNumber(stat?.count) ? stat.count : 0;
    if (count <= 0) continue;
    const rule = ruleCategories.get(stat.id) ?? null;
    categories.push({
      id: stat.id,
      nameZh: typeof stat.nameZh === 'string' && stat.nameZh !== ''
        ? stat.nameZh
        : (rule?.nameZh ?? stat.id),
      kind: stat.kind === 'hard' || stat.kind === 'soft' ? stat.kind : (rule?.kind ?? 'soft'),
      count,
      lastAt: stat.lastAt ?? null,
      lastLinesAgo: isFiniteNumber(stat.lastLinesAgo) ? stat.lastLinesAgo : null,
      matchedKeywords: Array.isArray(stat.matchedKeywords) ? stat.matchedKeywords.slice() : [],
      fix: typeof rule?.fix === 'string' && rule.fix !== '' ? rule.fix : null,
    });
  }

  // 5.6 主角类别：有 hard 就以 hard 为主（hard 才是「发不出去」），否则看 soft
  const relevantKind = hardHits > 0 ? 'hard' : 'soft';
  const pool = categories
    .filter((item) => item.kind === relevantKind)
    .sort((a, b) => b.count - a.count);
  const top = pool[0] ?? categories.slice().sort((a, b) => b.count - a.count)[0] ?? null;

  const fixes = [...new Set(pool.map((item) => item.fix).filter((fix) => typeof fix === 'string'))];
  const fixHint = fixes.slice(0, maxFixesPerFish()).join(' ')
    || '按下面命中的类别逐条处理：先把那条报错下面几行原样贴出来再查。';

  // 5.7 填话术（模板与变量名都来自 rules.json）
  const vars = {};
  if (level === 'noisy') {
    vars.softHits = softHits;
    vars.topCategoryZh = top?.nameZh ?? '小报错';
  } else if (level === 'sick' || level === 'critical') {
    vars.topCategoryZh = top?.nameZh ?? '这类报错';
    vars.hardHits = hardHits;
    vars.fixHint = fixHint;
  }
  const diag = diagnose(spec, level, vars, options);

  // 5.8 窗口退化与窗口过期：不改档位，但把话说全
  let phenomenon = diag.phenomenon;
  let nextStep = diag.nextStep;

  // 无时间戳 → 按尾部行数估算。SPEC §4.4 要求报告里必须写出来，
  // 文案模板同样取自 rules.json，不在这里另编一句。
  if (windowApproximated) {
    const noteTemplate = spec.approximation?.noteTemplate;
    if (typeof noteTemplate === 'string' && noteTemplate !== '') {
      phenomenon += ` ${fillTemplate(noteTemplate, { tailLines: lineCount }, `${spec.id}:approx`)}`;
    }
  }

  // 日志停在窗口之外（见文件头 STALE_WINDOW_CAVEAT 的说明）
  if (windowStale) {
    phenomenon += fillTemplate(STALE_WINDOW_CAVEAT.phenomenon, {
      ageHuman: humanAge(logAgeSec),
      windowHours,
    }, `${spec.id}:stale`);
    nextStep += STALE_WINDOW_CAVEAT.nextStep;
  }

  return {
    id: spec.id,
    nameZh: spec.nameZh,
    level,
    severity: diag.severity,
    value: hardHits,
    unit: spec.unit,
    evidence: {
      windowHours: windowHours ?? null,
      tailBytes: constants.tailBytes ?? null,
      tailLines: constants.tailLines ?? null,
      lineCount,
      linesTruncated: log.linesTruncated === true,
      bytesRead: isFiniteNumber(log.bytesRead) ? log.bytesRead : null,
      truncated: log.truncated === true,
      hasBinary: log.hasBinary === true,
      windowApproximated,
      windowStale,
      lastLogAt: log.lastTimestamp?.iso ?? null,
      logAgeSec,
      lastLogYearAssumed: log.lastTimestamp?.yearAssumed === true,
      hardHits,
      softHits,
      matched: Array.isArray(keywords.matched) ? keywords.matched.slice() : [],
      topCategory: top
        ? { id: top.id, nameZh: top.nameZh, kind: top.kind, count: top.count, lastAt: top.lastAt }
        : null,
      categories,
      source: sourceSummary(logSource),
      // 故意不带日志原文：日志行里可能印着 token，报告是可以公开的，日志内容不是。
    },
    phenomenon,
    nextStep,
    degraded: [],
  };
}

/* ------------------------------------------------------------------ *
 * 6. deps · 依赖（SPEC §4.5）
 * ------------------------------------------------------------------ */

/**
 * 依赖六项。每项独立出结论（pass / warn / fail / unknown），最后按 bands 取最差。
 *
 * 注意「unknown 不等于 pass」：六项里只要有一项查不出、且没有 fail/warn，
 * 整条指标就是 unknown —— 这是 rules.json deps bands 的第三条，也是
 * 「装完不跑」最容易骗过体检的地方。
 */
export function evaluateDeps(pondData = {}, options = {}) {
  const spec = getSpec('deps');
  const constants = spec.thresholds.constants ?? {};
  const read = pickRead(pondData, options);

  const deps = read.deps && typeof read.deps === 'object' ? read.deps : null;
  const credentials = (options.credentials && typeof options.credentials === 'object')
    ? options.credentials
    : (read.credentials && typeof read.credentials === 'object' ? read.credentials : null);
  const config = read.config && typeof read.config === 'object' ? read.config : null;
  const configSource = read.sources?.config ?? null;
  const ffmpegOptional = resolveFfmpegOptional(read, pondData, options);

  const ctx = {
    deps,
    credentials,
    config,
    configSource,
    ffmpegOptional,
    constants,
    tolerant: options.tolerant === true,
  };

  const ruleChecks = Array.isArray(spec.thresholds.checks) ? spec.thresholds.checks : [];
  if (ruleChecks.length === 0) throw new Error(`spec_defect:deps_no_checks:${spec.id}`);

  const checks = ruleChecks.map((check) => buildCheck(check, ctx));

  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const check of checks) counts[check.status] += 1;

  const metrics = {
    failCount: counts.fail,
    warnCount: counts.warn,
    unknownCount: counts.unknown,
  };

  const levelInfo = safeBands(spec, metrics, options);
  if (levelInfo.level === 'unknown' && levelInfo.reason === 'metric_unavailable') {
    return unknownIndicator(spec, {
      reason: 'metric_unavailable',
      evidence: { checks, counts, missingMetrics: levelInfo.missing },
      missing: levelInfo.missing ?? [],
    });
  }
  const level = levelInfo.level;

  // 逐项 fix 汇总成一句「照着补」
  const fixPool = checks
    .filter((check) => check.status === 'fail' || check.status === 'warn')
    .map((check) => check.fix)
    .filter((fix) => typeof fix === 'string' && fix !== '');
  const fixHint = [...new Set(fixPool)].slice(0, maxFixesPerFish()).join(' ')
    || '按下面逐项的处理办法补，补完再体检一次。';

  const failedChecksZh = checks
    .filter((check) => check.status === (level === 'broken' ? 'fail' : 'warn'))
    .map((check) => check.nameZh)
    .join('、');

  const vars = {};
  if (level === 'warn') {
    vars.warnCount = counts.warn;
    vars.failedChecksZh = failedChecksZh || '（无）';
    vars.fixHint = fixHint;
  } else if (level === 'broken') {
    vars.failCount = counts.fail;
    vars.failedChecksZh = failedChecksZh || '（无）';
    vars.fixHint = fixHint;
  } else if (level === 'unknown') {
    vars.unknownCount = counts.unknown;
  }
  const diag = diagnose(spec, level, vars, options);

  const notes = [];
  if (isFiniteNumber(constants.checksRequired) && constants.checksRequired !== checks.length) {
    notes.push(`rules 声明 ${constants.checksRequired} 项检查，实现算出了 ${checks.length} 项 —— 检查表可能改过，请核对。`);
  }
  if (ffmpegOptional) {
    notes.push('这条鱼被判定为「不产视频」，ffmpeg 缺失只记 warn。');
  }

  return {
    id: spec.id,
    nameZh: spec.nameZh,
    level,
    severity: diag.severity,
    value: counts.fail,
    unit: spec.unit,
    evidence: {
      checksRequired: constants.checksRequired ?? null,
      checks,
      counts,
      // 原始探针事实（只出事实，不出路径；凭证只出数量与天数）
      probes: {
        ffmpeg: { found: deps?.ffmpeg?.found ?? null, ffmpegOptional },
        node: {
          version: deps?.node?.version ?? null,
          major: deps?.node?.major ?? null,
          source: deps?.node?.source ?? null,
        },
        credentials: {
          foundCount: isFiniteNumber(credentials?.foundCount) ? credentials.foundCount : null,
          missingCount: isFiniteNumber(credentials?.missingCount) ? credentials.missingCount : null,
          newestAgeDays: isFiniteNumber(credentials?.newestAgeSec)
            ? Math.floor(credentials.newestAgeSec / SECONDS_PER_DAY)
            : null,
          oldestAgeDays: isFiniteNumber(credentials?.oldestAgeSec)
            ? Math.floor(credentials.oldestAgeSec / SECONDS_PER_DAY)
            : null,
        },
        homeWritable: deps?.homeWritable?.writable ?? null,
        disk: {
          freeBytes: deps?.disk?.freeBytes ?? null,
          freeHuman: deps?.disk?.freeHuman ?? (isFiniteNumber(deps?.disk?.freeBytes)
            ? humanBytes(deps.disk.freeBytes)
            : null),
          totalBytes: deps?.disk?.totalBytes ?? null,
        },
        modelLine: config?.fieldsPresent ?? null,
      },
      notes,
    },
    phenomenon: diag.phenomenon,
    nextStep: diag.nextStep,
    degraded: [],
  };
}

/**
 * 逐项判定。每项返回 {id, nameZh, status, detail, fix, probe}。
 * detail 与 fix 全部来自 rules.json 的 checks[]，本函数只负责把事实填进去。
 */
function buildCheck(check, ctx) {
  const base = {
    id: check.id,
    nameZh: check.nameZh ?? check.id,
    status: 'unknown',
    detail: '',
    fix: typeof check.fix === 'string' ? check.fix : '',
    probe: check.probe ?? null,
  };
  const render = (vars) => fillTemplate(check.detailTemplate, vars, `deps:${check.id}`);

  switch (check.id) {
    /* ---- ffmpeg：PATH 上有没有、能不能执行 ---- */
    case 'ffmpeg': {
      const raw = ctx.deps?.ffmpeg ?? null;
      const found = typeof raw?.found === 'boolean' ? raw.found : null;
      if (found === true) {
        return {
          ...base,
          status: 'pass',
          detail: render({ status: '找到且可执行', version: '未知（只查了 PATH，不执行）' }),
        };
      }
      if (found === false) {
        return {
          ...base,
          status: ctx.ffmpegOptional ? 'warn' : 'fail',
          detail: render({ status: ctx.ffmpegOptional ? '没找到（这鱼不产视频，只记提醒）' : '没找到', version: '未知' }),
        };
      }
      return { ...base, status: 'unknown', detail: render({ status: '查不出（没有依赖探测结果）', version: '未知' }) };
    }

    /* ---- Node 主版本 ---- */
    case 'nodeRuntime': {
      const node = ctx.deps?.node ?? null;
      const major = isFiniteNumber(node?.major) ? node.major : null;
      const version = typeof node?.version === 'string' && node.version !== '' ? node.version : null;
      const minMajor = ctx.constants.nodeMinMajor;

      if (!node) {
        return { ...base, status: 'unknown', detail: render({ version: '查不出（没有依赖探测结果）' }) };
      }
      if (major === null) {
        // rules：版本取不到（没开启外部命令或无法执行）→ warn，不是 unknown
        return { ...base, status: 'warn', detail: render({ version: version ?? '版本取不到（没开启外部命令或无法执行）' }) };
      }
      const ok = isFiniteNumber(minMajor) ? major >= minMajor : true;
      return {
        ...base,
        status: ok ? 'pass' : 'fail',
        detail: ok
          ? render({ version })
          : `${render({ version })}（主版本 ${major} < 需要 ${minMajor}）`,
      };
    }

    /* ---- 登录态新鲜度：只出天数，绝不出路径/文件名 ---- */
    case 'credentialFreshness': {
      const cred = ctx.credentials;
      if (!cred) {
        return { ...base, status: 'unknown', detail: render({ staleDays: '未知（这次没查家目录或没权限）' }) };
      }
      if (cred.reason === 'read_error') {
        return { ...base, status: 'unknown', detail: render({ staleDays: '未知（读 mtime 失败）' }) };
      }
      const foundCount = isFiniteNumber(cred.foundCount) ? cred.foundCount : 0;
      const newest = isFiniteNumber(cred.newestAgeSec) ? cred.newestAgeSec : null;
      if (foundCount === 0 || newest === null) {
        // rules（队长裁定）：文件不存在 → unknown，不是 fail。
        // 「没找到白名单文件」是事实，「登录一定坏了」是推断。实机 2 条 DSH 插件型鱼
        // 都因为这条被判成 deps=broken，而它们根本不需要 B 站登录态。
        // 工具只报事实；「可能不需要登录态」这句也由 rules 的 unknown 文案给出。
        return {
          ...base,
          status: 'unknown',
          detail: '登录态：已知的凭据文件一个都不存在 —— 这条鱼可能不需要登录态，或登录态存在别处',
        };
      }
      const staleDays = Math.floor(newest / SECONDS_PER_DAY);
      const warnDays = ctx.constants.credentialStaleWarnDays;
      const failDays = ctx.constants.credentialStaleFailDays;
      let status = 'pass';
      if (isFiniteNumber(failDays) && staleDays >= failDays) status = 'fail';
      else if (isFiniteNumber(warnDays) && staleDays >= warnDays) status = 'warn';
      return { ...base, status, detail: render({ staleDays }) };
    }

    /* ---- 窝可写：只 access(W_OK)，不写任何字节 ---- */
    case 'homeWritable': {
      const hw = ctx.deps?.homeWritable ?? null;
      if (!hw || typeof hw.writable !== 'boolean') {
        return { ...base, status: 'unknown', detail: render({ status: '查不出（没定位到窝）' }) };
      }
      if (hw.writable === true) {
        return { ...base, status: 'pass', detail: render({ status: '可写' }) };
      }
      // 目录不存在 ≠ 不可写：那是「没定位到窝」，按 unknown 处理（rules deps unknownWhen）
      if (hw.reason === 'not_found' || hw.reason === 'read_error') {
        return { ...base, status: 'unknown', detail: render({ status: '查不出（窝目录不存在或读不了）' }) };
      }
      return { ...base, status: 'fail', detail: render({ status: '不可写' }) };
    }

    /* ---- 模型线路：只看字段存在与否，值一律不落结果 ---- */
    case 'modelLine': {
      const fieldsPresent = ctx.config?.fieldsPresent;
      const configUsable = isConfigUsable(ctx);
      if (!fieldsPresent || typeof fieldsPresent !== 'object' || !configUsable) {
        return { ...base, status: 'unknown', detail: render({ status: '判断不了（配置没读到）' }) };
      }
      const configured = Object.values(fieldsPresent).some((value) => value === true);
      return {
        ...base,
        status: configured ? 'pass' : 'fail',
        detail: render({ status: configured ? '已配' : '没配' }),
      };
    }

    /* ---- 磁盘余量 ---- */
    case 'diskSpace': {
      const disk = ctx.deps?.disk ?? null;
      const freeBytes = isFiniteNumber(disk?.freeBytes) ? disk.freeBytes : null;
      if (freeBytes === null) {
        return { ...base, status: 'unknown', detail: render({ freeHuman: '查不出（没定位到窝或 statfs 失败）' }) };
      }
      const warnBytes = ctx.constants.diskWarnFreeBytes;
      const failBytes = ctx.constants.diskFailFreeBytes;
      let status = 'pass';
      if (isFiniteNumber(failBytes) && freeBytes < failBytes) status = 'fail';
      else if (isFiniteNumber(warnBytes) && freeBytes < warnBytes) status = 'warn';
      const freeHuman = disk?.freeHuman ?? humanBytes(freeBytes);
      return { ...base, status, detail: render({ freeHuman }) };
    }

    default:
      // rules 加了检查项但实现没跟上 = 规格/实现不同步。
      // 默认炸出来别糊过去；tolerant（CLI 生产路径）降成 unknown 并写清原因。
      if (ctx.tolerant) {
        return {
          ...base,
          status: 'unknown',
          detail: `这个检查项（${check.id}）当前版本还没实现，先记 unknown（不是通过）`,
          fix: '把 pond-check 升到实现了这个检查项的版本，或到仓库提 issue。',
        };
      }
      throw new Error(`spec_defect:deps_unknown_check:${check.id}`);
  }
}

/** 配置到底读没读到（决定 modelLine 是 fail 还是 unknown）。 */
function isConfigUsable(ctx) {
  const status = ctx.configSource?.status ?? null;
  if (status === 'missing' || status === 'skipped_sensitive') return false;
  const reason = ctx.config?.reason ?? ctx.configSource?.reason ?? null;
  if (reason === null) return true;
  // 有版本字段缺失但文件读到了（fieldsPresent 有效）→ 仍然算「配置读到了」
  return reason === 'no_version_field';
}

/**
 * 「这条鱼产不产视频」——决定 ffmpeg 缺失是 fail 还是 warn。
 *
 * 现状：rules.json 还没有这个机器字段（已上报队长）。这里支持三种来源，
 * 优先用调用方显式声明，其次看 rules 里未来可能加的字段，最后默认按 fail（SPEC §4.5 表）。
 */
function resolveFfmpegOptional(read, pondData, options) {
  if (typeof options?.ffmpegOptional === 'boolean') return options.ffmpegOptional;
  if (typeof read?.ffmpegOptional === 'boolean') return read.ffmpegOptional;

  const kind = typeof read?.kind === 'string' ? read.kind : (pondData?.kind ?? null);
  if (!kind) return false;

  const optionalKinds = RULES?.indicators?.deps?.thresholds?.ffmpegOptionalKinds;
  if (Array.isArray(optionalKinds) && optionalKinds.includes(kind)) return true;

  const kindSpec = (RULES?.discovery?.kinds ?? []).find((item) => item.id === kind);
  if (kindSpec && kindSpec.producesVideo === false) return true;

  return false;
}

/* ------------------------------------------------------------------ *
 * 7. drift · 漂移（SPEC §4.6）
 * ------------------------------------------------------------------ */

/**
 * 漂移：配置的 schema 版本 vs 程序要求，外加字段改名表的残留检查。
 *
 * **只报告，不修改**：本函数对配置只做「键名存在与否」的读取，
 * 不写回、不迁移、不打印任何字段值。
 */
export function evaluateDrift(pondData = {}, options = {}) {
  const spec = getSpec('drift');
  const constants = spec.thresholds.constants ?? {};
  const read = pickRead(pondData, options);
  const config = read.config && typeof read.config === 'object' ? read.config : null;
  const configSource = read.sources?.config ?? null;

  const schemaVersion = isFiniteNumber(config?.schemaVersion) ? config.schemaVersion : null;
  const pluginVersion = typeof config?.pluginVersion === 'string' && config.pluginVersion !== ''
    ? config.pluginVersion
    : null;

  // 7.1 版本字段一个都没有 → unknown（不是「没漂」）
  if (schemaVersion === null) {
    return unknownIndicator(spec, {
      reason: typeof config?.reason === 'string' && config.reason !== '' ? config.reason : 'no_version_field',
      evidence: {
        source: sourceSummary(configSource),
        versionFieldOrder: spec.versionFieldOrder ?? [],
        programVersionFieldOrder: spec.programVersionFieldOrder ?? [],
        pluginVersion,
        configReadReason: config?.reason ?? null,
      },
      missing: ['schemaVersion'],
    });
  }

  // 7.2 字段改名表：旧字段在、新字段不在 → 计一次 staleFieldHits
  const renames = Array.isArray(spec.renames) ? spec.renames : [];
  const probe = probeConfigPresence(read, options, renames);
  const staleFields = [];
  if (probe.ok) {
    for (const rename of renames) {
      const oldFound = probe.has(rename.from);
      const newFound = probe.has(rename.to);
      if (oldFound === true && newFound === false) {
        staleFields.push({ from: rename.from, to: rename.to, since: rename.since ?? null });
      }
    }
  }

  // 7.3 改名表核对不了 → unknown
  //
  // 为什么不「当作 0 个旧字段」继续判 aligned：aligned 的话术是「也没有残留的旧字段」，
  // 没核对就写这句 = 假健康。这段临时话术是因为 rules.json 目前没有
  // 「改名表未核对」这条 diagnosis（已上报队长补），变量与档位仍按 rules 走。
  if (!probe.ok) {
    const diagUnknown = diagnose(spec, 'unknown', {});
    return {
      id: spec.id,
      nameZh: spec.nameZh,
      level: 'unknown',
      severity: diagUnknown.severity,
      value: schemaVersion,
      unit: spec.unit,
      evidence: {
        configSchemaVersion: schemaVersion,
        schemaVersionField: config?.schemaVersionField ?? null,
        pluginVersion,
        expectedSchemaVersion: constants.expectedSchemaVersion ?? null,
        minSupportedSchemaVersion: constants.minSupportedSchemaVersion ?? null,
        renamesChecked: false,
        probeReason: probe.reason ?? 'renames_unchecked',
        source: sourceSummary(configSource),
        reason: probe.reason ?? 'renames_unchecked',
        missing: ['configFields'],
      },
      phenomenon: `配置版本读到了 v${schemaVersion}，但这次拿不到她的配置文件，`
        + '没法核对「有没有残留的旧字段」—— 漂移只判到一半，不能算「没漂」。',
      nextStep: '用 --root <她的目录> 指着她的窝再体检一次；配置文件能被完整读到，改名表才核对得出来。',
      degraded: [{ indicator: spec.id, reason: probe.reason ?? 'renames_unchecked', missing: ['configFields'] }],
    };
  }

  // 7.4 分档（staleFieldHits 已核出；阈值全在 rules.json）
  const levelInfo = safeBands(spec, {
    configSchemaVersion: schemaVersion,
    staleFieldHits: staleFields.length,
  }, options);
  if (levelInfo.level === 'unknown') {
    return unknownIndicator(spec, {
      reason: levelInfo.reason ?? 'metric_unavailable',
      evidence: {
        source: sourceSummary(configSource),
        configSchemaVersion: schemaVersion,
        schemaVersionField: config?.schemaVersionField ?? null,
        pluginVersion,
        renamesChecked: true,
        missingMetrics: levelInfo.missing ?? [],
      },
      missing: levelInfo.missing ?? [],
      notes: levelInfo.specHole ? [levelInfo.message] : [],
    });
  }
  const level = levelInfo.level;

  // 7.5 填话术
  const vars = {};
  if (level === 'aligned') {
    vars.configSchemaVersion = schemaVersion;
  } else if (level === 'drifted') {
    vars.configSchemaVersion = schemaVersion;
    vars.expectedSchemaVersion = constants.expectedSchemaVersion;
    vars.staleFieldHits = staleFields.length;
    vars.firstStaleField = staleFields[0]?.from ?? renames[0]?.from ?? '（本版没有残留旧字段）';
  } else if (level === 'mismatch') {
    vars.configSchemaVersion = schemaVersion;
    vars.expectedSchemaVersion = constants.expectedSchemaVersion;
  }
  const diag = diagnose(spec, level, vars, options);

  const notes = [];
  if (pluginVersion === null) {
    notes.push('程序版本（package.json 的 version）没读到 —— 不阻断判定，但「配置 vs 程序」只能比 schema 版本。');
  }

  return {
    id: spec.id,
    nameZh: spec.nameZh,
    level,
    severity: diag.severity,
    value: schemaVersion,
    unit: spec.unit,
    evidence: {
      configSchemaVersion: schemaVersion,
      schemaVersionField: config?.schemaVersionField ?? null,
      pluginVersion,
      programVersion: pluginVersion,
      expectedSchemaVersion: constants.expectedSchemaVersion ?? null,
      minSupportedSchemaVersion: constants.minSupportedSchemaVersion ?? null,
      staleFieldHits: staleFields.length,
      staleFields,
      renames: renames.map((rename) => ({
        from: rename.from,
        to: rename.to,
        since: rename.since ?? null,
        stale: staleFields.some((item) => item.from === rename.from),
      })),
      renamesChecked: probe.ok,
      configReadReason: config?.reason ?? null,
      source: sourceSummary(configSource),
      notes,
      // 只报告不修改：这里没有任何写配置的路径。
    },
    phenomenon: diag.phenomenon,
    nextStep: diag.nextStep,
    degraded: [],
  };
}

/**
 * 为「字段改名表」准备一个键名存在性探针。
 *
 * 三种来源，依次尝试：
 *   1. 调用方注入的 fieldPresence（dotted path → boolean）：
 *      options.fieldPresence 或 read.config.fieldPresence。
 *      构造测试、或上游已经自己读过配置时用这个，避免重复 IO。
 *   2. read.config.presentFields —— **注意**：这是 D3b 的「模型线路字段」布尔表
 *      （model/provider/baseUrl/apiBase），只有它恰好含改名表字段时才拿来用，
 *      否则会把「表里没这个键」误读成「配置里没有这个字段」。
 *   3. 真去读一次配置 JSON，只保留布尔存在性（生产路径走这条）。
 *
 * 任何情况下都只产出布尔值：字段值从不进结果，敏感键按「不存在」处理，
 * 凭证名文件整份不读（SPEC §2）。
 *
 * @returns {{ok:boolean, source?:string, reason?:string, has?:(name:string)=>boolean}}
 */
function probeConfigPresence(read, options, renames = []) {
  const config = read?.config && typeof read.config === 'object' ? read.config : null;

  const injected = options?.fieldPresence && typeof options.fieldPresence === 'object'
    ? options.fieldPresence
    : (config?.fieldPresence && typeof config.fieldPresence === 'object' ? config.fieldPresence : null);
  if (injected) {
    return {
      ok: true,
      source: 'injected',
      has: (name) => injected[name] === true,
    };
  }

  // D3b 的 presentFields 只覆盖模型线路字段；只有它确实含改名表字段时才可信
  if (config?.presentFields && typeof config.presentFields === 'object') {
    const map = config.presentFields;
    const relevant = renames.some((rename) => rename.from in map || rename.to in map);
    if (relevant) {
      return {
        ok: true,
        source: 'injected_presentFields',
        has: (name) => map[name] === true,
      };
    }
  }

  const configPath = typeof options?.configPath === 'string' && options.configPath !== ''
    ? options.configPath
    : (typeof read?.paths?.config === 'string' ? read.paths.config : null);

  if (!configPath) return { ok: false, reason: 'no_config_path' };

  const gate = configGateReason(configPath);
  if (gate) return { ok: false, reason: gate };

  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile()) return { ok: false, reason: 'not_a_file' };
    if (stat.size > MAX_CONFIG_BYTES) return { ok: false, reason: 'file_too_large' };
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'unsupported_format' };
    }
    return {
      ok: true,
      source: 'file',
      has: (name) => fieldPresence(parsed, name).found === true,
    };
  } catch (err) {
    const code = err?.code;
    if (code === 'ENOENT') return { ok: false, reason: 'not_found' };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'permission_denied' };
    if (err instanceof SyntaxError) return { ok: false, reason: 'unsupported_format' };
    return { ok: false, reason: 'read_error' };
  }
}

/** 配置路径的凭证闸（SPEC §2）：命中就整份不读，名字也不回显。 */
function configGateReason(configPath) {
  try {
    const base = path.basename(configPath);
    const parent = path.basename(path.dirname(configPath));
    if (isSensitiveFileName(base)) return 'sensitive_file';
    if (isSensitiveDirName(parent)) return 'sensitive_parent_dir';
    return null;
  } catch {
    return 'bad_path';
  }
}

/** 敏感键集合：只用于「连存不存在都不提」，值本来就从不落结果。 */
function sensitiveKeySet() {
  const fromRules = RULES?.credentials?.valueRedactionKeys;
  const base = [
    'apikey', 'api_key', 'secret', 'token', 'password', 'passwd',
    'cookie', 'authorization', 'bearer', 'credential', 'private_key', 'access_key',
  ];
  const merged = new Set(base);
  if (Array.isArray(fromRules)) {
    for (const key of fromRules) {
      if (typeof key === 'string' && key !== '') merged.add(key.toLowerCase());
    }
  }
  return merged;
}

/** 沿点号路径查字段是否存在（存在即 found:true；敏感键按不存在处理）。 */
function fieldPresence(obj, dottedName) {
  const parts = String(dottedName).split('.');
  const sensitive = sensitiveKeySet();
  let node = obj;
  for (const part of parts) {
    if (sensitive.has(part.toLowerCase())) return { found: false };
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return { found: false };
    if (!(part in node)) return { found: false };
    node = node[part];
  }
  return { found: true };
}

/* ------------------------------------------------------------------ *
 * 8. 聚合入口（供 D4 收口调用）
 * ------------------------------------------------------------------ */

/**
 * 一次算完系统类三指标。
 * @returns {{health:object, deps:object, drift:object, degraded:object[], notes:string[]}}
 */
export function evaluateSystem(pondData = {}, options = {}) {
  const health = evaluateHealth(pondData, options);
  const deps = evaluateDeps(pondData, options);
  const drift = evaluateDrift(pondData, options);

  const degraded = [
    ...(Array.isArray(health.degraded) ? health.degraded : []),
    ...(Array.isArray(deps.degraded) ? deps.degraded : []),
    ...(Array.isArray(drift.degraded) ? drift.degraded : []),
  ];

  const notes = [];
  if (health.evidence?.windowStale) {
    notes.push('健康：日志最后一条早于 24 小时窗口，结论只反映更早的日志。');
  }
  if (health.evidence?.windowApproximated) {
    notes.push('健康：日志没有可解析时间戳，按尾部行数估算。');
  }
  if (deps.evidence?.notes?.length > 0) notes.push(...deps.evidence.notes);
  if (drift.evidence?.notes?.length > 0) notes.push(...drift.evidence.notes);

  return { health, deps, drift, degraded, notes };
}

/** 本模块负责的三个指标 id（收口/测试用）。 */
export const INDICATOR_IDS = Object.freeze(['health', 'deps', 'drift']);

export default evaluateSystem;
