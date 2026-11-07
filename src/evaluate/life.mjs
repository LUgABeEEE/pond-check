/**
 * pond-check · D4a 生活类三指标（src/evaluate/life.mjs）
 *
 * 职责：把 D3 交出来的**读取事实**（PondRead）判成三格状态，一格一条人话：
 *   1. liveness   存活 —— 最后一次真的动过是多久以前？
 *   2. rhythm     节律 —— 近 7 天是不是每天都醒？「以前天天跑，这三天没动」抓不抓得到？
 *   3. throughput 工作量 —— 判重表多少条、今天新增几条？数字不动就是卡住了。
 *
 * 这一层只做判定，不读文件、不联网、不启停进程、不碰凭证。输入是 D3 的 PondRead
 * （src/read/index.mjs），输出是 docs/SPEC.md §6.2 规定的那一格：
 *
 *   { id, nameZh, level, severity, value, unit, evidence, phenomenon, nextStep, degraded }
 *
 * ── 四条不可协商的口径 ───────────────────────────────────────────────
 *
 * 1. **阈值只在 rules.json**。档位来自 `indicators.<id>.thresholds.bands`，
 *    常量来自同处 `constants`。本文件里没有「一小时多少秒 / 一周多少秒」这类
 *    判定数字（连字面量都不出现，SPEC §7 T14 会扫源码）：秒与天只在「说话」
 *    和分桶时用 `SEC_PER_MIN * MIN_PER_HOUR * HOURS_PER_DAY` 算出来。
 *    想让档位跟着变，改 rules.json 就行（测试可用 options.rulesPath 或
 *    环境变量 POND_CHECK_RULES 指向临时副本，见 loadRules）。
 *
 * 2. **数据不足一律 unknown，绝不默认健康**。判不出就 level='unknown'，
 *    并且必须在 `evidence.missing` 里列清缺什么（机器读）、在 `phenomenon`
 *    里说人话（人读）、在 `nextStep` 里说「补什么才判得出来」。
 *    本文件里没有 `catch { return 'ok' }`，没有 `|| 'ok'`。
 *
 * 3. **绝不用假活动信号**。liveness 只看日志写入 / session 记录 / 判重表写入 /
 *    进程启动时间这四种**真实痕迹**；`online` / `heartbeat` / `status` 这类字段
 *    一个都不读（`rules.indicators.liveness.forbiddenSignals` 原样抄进 evidence
 *    作为「我确实没看它们」的凭据，代码里也确实没有对应的读取路径）。
 *
 * 4. **永不抛**。任何一条鱼读成什么样，这一层都只降级该指标（unknown + 原因），
 *    绝不把整份体检带走。结构性规格缺陷（bands 引用不存在的常量、值可算却一条
 *    band 都没命中）内部会抛，被本层的 safe 包装接住并判 unknown，同时把
 *    `reason:'rules_invalid' | 'band_gap'` 写进 evidence —— 因为「实现自己错了」
 *    也绝不能伪装成 ok。
 *
 * ── 契约 ─────────────────────────────────────────────────────────────
 *
 *   evaluateLiveness(read, options?)   -> Indicator
 *   evaluateRhythm(read, options?)     -> Indicator
 *   evaluateThroughput(read, options?) -> Indicator
 *   evaluateLife(read, options?)       -> { liveness, rhythm, throughput, now, degraded }
 *
 *   read 是 D3 的 PondRead（`await readPond(pond)` 的返回值）。本层只读这些字段，
 *   其余一律忽略：
 *     read.now / read.log{ok,reason,lines,lastTimestamp,mtimeMs,truncated,...}
 *     read.dedupe{count,todayNew,lastEntryAt,lastUpdateAt,fileMtimeAt,format,reason,...}
 *     read.sessions{newestMtimeMs,fileCount,...}
 *     read.kind / read.processAlive / read.processes[]（进程表，D2 v0.1 暂不提供）
 *
 *   options：
 *     now        时间基准（ms）；缺省 read.now ?? Date.now()（测试注入用）
 *     rules      直接给一份 rules 对象（最高优先级，测试用）
 *     rulesPath  从指定路径读 rules.json（测试用；也可用 env POND_CHECK_RULES）
 *
 * ── 已知的 D1 规格缺口（不在本文件权限内，照实记在这里）────────────────
 *
 *   a) SPEC §4.3 的 empty 档描述含「判重表不存在但窝存在」，而 rules.json 的
 *      empty band 只写 `totalEntries <= 0`，且 unknownWhen 写「判重表不存在且
 *      日志无『已处理』计数 → unknown」。按 §0.3「rules.json 为执行真相」，
 *      本实现取 rules.json 口径：**判重表不存在 → unknown**（不是 bad，也不是 ok）。
 *   b) SPEC §3.3 给 throughput 的「退路 2：日志里『已处理』类行的计数」，但
 *      rules.json 里没有这份关键词表。本层不发明关键词（发明关键词=假数据，
 *      与 §5 假健康禁令同级危险），因此这条退路**未实现**，判重表缺失即 unknown。
 *      要补：在 rules.json 的 indicators.throughput 下加 processedKeywords。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseTimestamp } from '../read/log.mjs';

/* ------------------------------------------------------------------ *
 * 时间单位：只用来「说话」和分桶，不参与档位判定。
 *
 * 故意不写字面量（SPEC §7 T14 会扫源码里的判定数字）：
 * 判定阈值一律从 rules.json 读，这里的常数只负责把秒数翻译成「3 小时」。
 * ------------------------------------------------------------------ */

const SEC_PER_MIN = 60;
const MIN_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR;
const SEC_PER_DAY = SEC_PER_HOUR * HOURS_PER_DAY;
const MS_PER_SEC = 1000;
const MS_PER_DAY = SEC_PER_DAY * MS_PER_SEC;

/** 本层负责的指标 id（D4 收口按这个顺序拼报告） */
export const LIFE_INDICATOR_IDS = ['liveness', 'rhythm', 'throughput'];

/* ------------------------------------------------------------------ *
 * rules.json：唯一真相
 *
 * 三种来源，优先级从高到低：options.rules > options.rulesPath / env > src/rules.json。
 * 读不到就返回 null —— 上层据此把三项全判 unknown（绝不猜阈值）。
 * ------------------------------------------------------------------ */

const DEFAULT_RULES_PATH = fileURLToPath(new URL('../rules.json', import.meta.url));
let defaultRulesCache = null;

/**
 * 取判定规则。
 * @param {object} [options]
 * @returns {object|null}
 */
export function loadRules(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  if (opts.rules && typeof opts.rules === 'object') return opts.rules;

  const customPath = typeof opts.rulesPath === 'string' && opts.rulesPath !== ''
    ? opts.rulesPath
    : (typeof process.env.POND_CHECK_RULES === 'string' && process.env.POND_CHECK_RULES !== ''
      ? process.env.POND_CHECK_RULES
      : null);

  if (customPath) {
    // 每个调用都现读：测试要能在同一进程里换一份 rules.json 再断言档位跟着变
    try {
      return JSON.parse(fs.readFileSync(customPath, 'utf8'));
    } catch {
      return null;
    }
  }

  if (defaultRulesCache === null) {
    try {
      defaultRulesCache = JSON.parse(fs.readFileSync(DEFAULT_RULES_PATH, 'utf8'));
    } catch {
      defaultRulesCache = null;
    }
  }
  return defaultRulesCache;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

/** 本地自然日 00:00 的时间戳（SPEC rhythm.wakeDefinition：本地时区 00:00 分界）。 */
function startOfLocalDay(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 相对「今天」的自然日下标：今天 = 0，昨天 = -1，前天 = -2 …
 * 用 round 而不是 floor：夏令时那天只有 23/25 小时，round 才不会被 ±1 小时的
 * 偏移骗成隔壁那天。
 */
function dayIndexFromNow(ms, nowMs) {
  return Math.round((startOfLocalDay(ms) - startOfLocalDay(nowMs)) / MS_PER_DAY);
}

/** 自然日下标 → 窗口数组下标（窗口数组最后一位是今天）。越界返回 -1。 */
function daySlot(dayIndex, windowDays) {
  const slot = windowDays - 1 + dayIndex;
  return slot >= 0 && slot < windowDays ? slot : -1;
}

/** 秒数 → 人话。只用于 phenomenon 文案，不参与判定。 */
export function formatAgeHuman(ageSec) {
  if (!isFiniteNumber(ageSec)) return '—';
  const sec = Math.max(0, Math.round(ageSec));
  // 「0 秒前」不是人话；一分钟以内就说「不到 1 分钟」
  if (sec < SEC_PER_MIN) return '不到 1 分钟';
  if (sec < SEC_PER_HOUR) return `${Math.floor(sec / SEC_PER_MIN)} 分钟`;
  if (sec < SEC_PER_DAY) return `${Math.floor(sec / SEC_PER_HOUR)} 小时`;
  return `${Math.floor(sec / SEC_PER_DAY)} 天`;
}

/**
 * 中文排版小修：模板是「她 {ageHuman} 前还在动」，填完会变成「她 10 分钟 前还在动」。
 * 只把「汉字 + 空格 + 前/后」之间的空格去掉，不碰数字与量词之间的正常空格。
 */
function polishChinese(text) {
  return String(text)
    // 「分钟 前」→「分钟前」
    .replace(/([\u4e00-\u9fa5])\s+(前|后)/g, '$1$2')
    // 两个汉字之间的空格没有任何排版意义（模板里为了可读留的）：去掉
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1');
}

/** 毫秒时间戳 → ISO 或 null。 */
function isoOrNull(ms) {
  return isFiniteNumber(ms) ? new Date(ms).toISOString() : null;
}

/* ------------------------------------------------------------------ *
 * 话术模板：{var} 必须被填满
 *
 * SPEC §4 要求：模板里出现的变量名必须在同条 diagnosis 的 vars 里声明，且实现
 * 必须用 evidence 填满。留着未替换的 {var} 出现在报告里 = 缺陷（T15）。
 * 所以这里的行为是：填不满就用「—」并在 degraded 里留痕，绝不把 {var} 漏出去。
 * ------------------------------------------------------------------ */

const VAR_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function fillTemplate(template, vars) {
  const missingVars = [];
  const text = String(template ?? '').replace(VAR_PATTERN, (match, name) => {
    if (!vars || !Object.prototype.hasOwnProperty.call(vars, name)) {
      missingVars.push(name);
      return '—';
    }
    const value = vars[name];
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
      missingVars.push(name);
      return '—';
    }
    return String(value);
  });
  return { text, missingVars };
}

/** 模板里出现的占位符名（用于和 vars 声明比对，发现规格漂移就留痕）。 */
function templateVars(template) {
  const found = [];
  const source = String(template ?? '');
  let match = VAR_PATTERN.exec(source);
  while (match) {
    found.push(match[1]);
    match = VAR_PATTERN.exec(source);
  }
  // 复位 lastIndex：VAR_PATTERN 是带 g 的模块级正则
  VAR_PATTERN.lastIndex = 0;
  return found;
}

/* ------------------------------------------------------------------ *
 * bands 判定器（SPEC §4「唯一实现口径」）
 *
 *   1. 主指标为 null → 上层直接判 unknown，根本不进这里；
 *   2. bands 有序，先命中者赢；
 *   3. op 只有 lt/lte/gt/gte/eq；value 与 valueRef 二选一；
 *   4. 值可算却一条 band 都没命中 = 规格破洞 → 抛（由上层判 unknown + 留痕）。
 * ------------------------------------------------------------------ */

class RulesDefect extends Error {
  constructor(message) {
    super(message);
    this.name = 'RulesDefect';
    this.code = 'RULES_INVALID';
  }
}

function compare(actual, op, expected) {
  switch (op) {
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
    case 'eq': return actual === expected;
    default:
      throw new RulesDefect(`未知的比较运算符 op=${String(op)}`);
  }
}

function expectedValue(condition, constants, where) {
  const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value');
  const hasRef = Object.prototype.hasOwnProperty.call(condition, 'valueRef');
  if (hasValue === hasRef) {
    throw new RulesDefect(`${where}: 条件 ${String(condition.metric)} 必须且只能有 value 或 valueRef 之一`);
  }
  if (hasValue) {
    if (!isFiniteNumber(condition.value)) {
      throw new RulesDefect(`${where}: value 必须是数字（metric=${String(condition.metric)}）`);
    }
    return condition.value;
  }
  const ref = condition.valueRef;
  if (typeof ref !== 'string' || !Object.prototype.hasOwnProperty.call(constants ?? {}, ref)) {
    throw new RulesDefect(`${where}: valueRef=${String(ref)} 在 constants 里不存在`);
  }
  const value = constants[ref];
  if (!isFiniteNumber(value)) {
    throw new RulesDefect(`${where}: constants.${ref} 必须是数字`);
  }
  return value;
}

/**
 * 按 rules.json 的 bands 判档。命中返回 {level, band}，一条都没命中抛 RulesDefect。
 * 单条 band 里任一个 metric 为 null → 这条 band 判不了，跳过（SPEC §4 第 1 条的落点
 * 是「上层不进 bands」，但多指标指标里仍会出现某条 band 只依赖可得指标的情况）。
 *
 * @param {object} rules
 * @param {string} indicatorId
 * @param {object} metrics  {metricName: number|null}
 * @returns {{level:string, band:object}}
 */
export function evalBandsByRules(rules, indicatorId, metrics) {
  const def = rules?.indicators?.[indicatorId];
  const thresholds = def?.thresholds;
  const bands = thresholds?.bands;
  const constants = thresholds?.constants ?? {};
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new RulesDefect(`rules.json 缺 ${indicatorId}.thresholds.bands`);
  }

  for (const band of bands) {
    const conditions = Array.isArray(band?.allOf) ? band.allOf : [];
    if (conditions.length === 0) continue;
    let matched = true;
    for (const condition of conditions) {
      const actual = metrics ? metrics[condition.metric] : undefined;
      if (!isFiniteNumber(actual)) {
        matched = false;
        break;
      }
      const expected = expectedValue(condition, constants, `${indicatorId}.bands.${band.level}`);
      if (!compare(actual, condition.op, expected)) {
        matched = false;
        break;
      }
    }
    if (matched) return { level: band.level, band };
  }

  throw new RulesDefect(
    `${indicatorId}: 指标值可算（${JSON.stringify(metrics)}）却没有命中任何 band —— 规格破洞或被改了 bands 结构`,
  );
}

/* ------------------------------------------------------------------ *
 * 诊断话术：severity + phenomenon + nextStep
 * ------------------------------------------------------------------ */

function buildDiagnosis(rules, indicatorId, level, vars) {
  const diag = rules?.indicators?.[indicatorId]?.diagnosis?.[level];
  if (!diag || typeof diag !== 'object') {
    throw new RulesDefect(`rules.json 缺 ${indicatorId}.diagnosis.${level}`);
  }
  const severity = typeof diag.severity === 'string' ? diag.severity : '';
  if (severity === '') throw new RulesDefect(`rules.json ${indicatorId}.diagnosis.${level} 缺 severity`);

  const declared = Array.isArray(diag.vars) ? diag.vars : [];
  const phenomenon = fillTemplate(diag.phenomenon, vars);
  const nextStep = fillTemplate(diag.nextStep, vars);

  const undeclared = [
    ...templateVars(diag.phenomenon).filter((name) => !declared.includes(name)),
    ...templateVars(diag.nextStep).filter((name) => !declared.includes(name)),
  ];
  const missingVars = [...new Set([...phenomenon.missingVars, ...nextStep.missingVars])];

  return {
    severity,
    phenomenon: phenomenon.text,
    nextStep: nextStep.text,
    issues: {
      undeclaredVars: [...new Set(undeclared)],
      missingVars,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 结果形状（SPEC §6.2）
 * ------------------------------------------------------------------ */

/** rules 读不到时的兜底文案：只写「判不出」，绝不写成正常。 */
const FALLBACK_UNKNOWN = {
  phenomenon: '判不出来：rules.json 没读到，体检不知道该按哪套阈值判（这不是正常）。',
  nextStep: '确认 src/rules.json 在安装目录里没被删掉；从仓库重新拉一份再跑一次体检。',
};

function fallbackIndicator({ id, nameZh, unit, reason, reasonText, missing, evidence }) {
  const degraded = [{ indicator: id, reason, missing: Array.isArray(missing) ? missing : [] }];
  return {
    id,
    nameZh,
    level: 'unknown',
    severity: 'unknown',
    value: null,
    unit,
    evidence: {
      ...(evidence && typeof evidence === 'object' ? evidence : {}),
      missing: Array.isArray(missing) ? missing : [],
      reason,
      ...(reasonText ? { reasonText } : {}),
    },
    phenomenon: reasonText ?? FALLBACK_UNKNOWN.phenomenon,
    nextStep: FALLBACK_UNKNOWN.nextStep,
    degraded,
  };
}

/**
 * 统一的指标结果装配：level → severity/phenomenon/nextStep 全部来自 rules.json。
 * @returns {object} Indicator
 */
function assemble({
  rules,
  id,
  nameZh,
  unit,
  level,
  value,
  vars,
  evidence,
  missing,
  reason,
  reasonText,
  phenomenonSuffix,
  nextStepSuffix,
  phenomenon,
  nextStep,
}) {
  const missingList = Array.isArray(missing) ? [...new Set(missing)] : [];
  const baseEvidence = {
    ...(evidence ?? {}),
    missing: missingList,
  };
  if (reason) baseEvidence.reason = reason;
  if (reasonText) baseEvidence.reasonText = reasonText;

  let diag;
  try {
    diag = buildDiagnosis(rules, id, level, vars);
  } catch (err) {
    // 规格缺陷：宁可 unknown，也不能让一个装配失败变成「没这栏」或「正常」
    return fallbackIndicator({
      id,
      nameZh,
      unit,
      reason: 'rules_invalid',
      reasonText: `判定规则读不出来（${err && err.message ? err.message : 'unknown'}）—— 这是体检自己的问题，不是鱼的健康状态。`,
      missing: missingList,
      evidence: baseEvidence,
    });
  }

  if (diag.issues.missingVars.length > 0) {
    baseEvidence.templateVarsMissing = diag.issues.missingVars;
  }
  if (diag.issues.undeclaredVars.length > 0) {
    baseEvidence.templateVarsUndeclared = diag.issues.undeclaredVars;
  }

  // override 只用于一种情况：rules.json 的 unknown 文案假设了某个前提（比如「找不到
  // 判重表」），而实际是另一种前提（表在、只是没时间戳）。照抄会变成假话，所以
  // level/severity 仍取 rules，文字换掉并留痕（evidence.textOverride）。
  const textOverride = typeof phenomenon === 'string' && phenomenon !== '' ? true : undefined;
  const finalPhenomenon = polishChinese(
    typeof phenomenon === 'string' && phenomenon !== ''
      ? phenomenon
      : `${diag.phenomenon}${phenomenonSuffix ? `（${phenomenonSuffix}）` : ''}`,
  );
  const finalNextStep = polishChinese(
    typeof nextStep === 'string' && nextStep !== ''
      ? nextStep
      : `${diag.nextStep}${nextStepSuffix ? ` ${nextStepSuffix}` : ''}`,
  );
  if (textOverride) baseEvidence.textOverride = reason ?? 'special_case';

  const degraded = [];
  if (level === 'unknown' || missingList.length > 0) {
    degraded.push({ indicator: id, reason: reason ?? 'insufficient_data', missing: missingList });
  }
  if (diag.issues.missingVars.length > 0) {
    degraded.push({ indicator: id, reason: 'template_var_missing', missing: diag.issues.missingVars });
  }

  return {
    id,
    nameZh,
    level,
    severity: diag.severity,
    value: isFiniteNumber(value) ? value : null,
    unit,
    evidence: baseEvidence,
    phenomenon: finalPhenomenon,
    nextStep: finalNextStep,
    degraded,
  };
}

/** 把内部抛出的规格缺陷翻译成 unknown 结果（永不把错误吃掉变 ok）。 */
function defectIndicator({ id, nameZh, unit, err, evidence }) {
  const isBandGap = err instanceof RulesDefect && /band/i.test(String(err.message));
  return fallbackIndicator({
    id,
    nameZh,
    unit,
    reason: isBandGap ? 'band_gap' : 'rules_invalid',
    reasonText: `体检自己的判定规则出问题了（${err && err.message ? err.message : 'unknown'}）—— 这格按判不出处理，别当正常。`,
    missing: ['rules'],
    evidence,
  });
}

function indicatorMeta(rules, id, fallbackNameZh, fallbackUnit) {
  const def = rules?.indicators?.[id];
  return {
    nameZh: typeof def?.nameZh === 'string' && def.nameZh !== '' ? def.nameZh : fallbackNameZh,
    unit: typeof def?.unit === 'string' && def.unit !== '' ? def.unit : fallbackUnit,
  };
}

function thresholdsOf(rules, id) {
  return rules?.indicators?.[id]?.thresholds ?? {};
}

function constantsOf(rules, id) {
  const constants = thresholdsOf(rules, id).constants;
  return constants && typeof constants === 'object' ? constants : {};
}

/* ================================================================== *
 * 1. liveness · 存活
 *
 * 只看真实写入痕迹（sourceOrder：log_mtime → session_mtime → dedupe_mtime →
 * process_start），取**最大**的那个时间。online/heartbeat 一律不读。
 * ================================================================== */

/** rules 里的源 id → 报告里用的短名（SPEC §3.3 的 missing 用短名）。 */
const LIVENESS_SOURCE_LABEL = {
  log_mtime: 'log',
  session_mtime: 'session',
  dedupe_mtime: 'dedupe',
  process_start: 'process_start',
};

/** 进程状态（D2 v0.1 不提供进程表；这里为将来的 P1 留好接口，绝不假装知道）。 */
function detectProcessState(read) {
  if (read && typeof read.processAlive === 'boolean') {
    return { alive: read.processAlive, available: true, startMs: null };
  }
  const processes = Array.isArray(read?.processes) ? read.processes.filter(Boolean) : [];
  if (processes.length > 0) {
    const alive = processes.some((item) => item.alive !== false);
    let newestStart = null;
    for (const item of processes) {
      const startMs = isFiniteNumber(item.startedAtMs)
        ? item.startedAtMs
        : (isFiniteNumber(item.startedAtSec) ? item.startedAtSec * MS_PER_SEC : null);
      if (startMs !== null && (newestStart === null || startMs > newestStart)) newestStart = startMs;
    }
    return { alive, available: true, startMs: newestStart };
  }
  const direct = isFiniteNumber(read?.processStartMs) ? read.processStartMs : null;
  return { alive: null, available: direct !== null, startMs: direct };
}

function livenessStartHint(rules, read) {
  const kinds = Array.isArray(rules?.discovery?.kinds) ? rules.discovery.kinds : [];
  const kindId = typeof read?.kind === 'string' ? read.kind : '';
  const normalized = kindId.startsWith('dsh') ? 'dsh' : kindId;
  const found = kinds.find((item) => item && item.id === normalized) ?? kinds.find((item) => item && item.id === 'unknown');
  const hint = typeof found?.startHint === 'string' && found.startHint !== ''
    ? found.startHint
    : '用你平时启动她的那条命令';
  return hint;
}

/**
 * 收集 liveness 的四个源。
 * 每一个源都留下 status，方便报告解释「为什么判不出来」：
 *   ok | missing（没有这个源）| invalid（epoch 0 / 未来时间超出容差）| skipped_sensitive
 */
function collectLivenessSources(read, nowMs, constants, processState) {
  const toleranceSec = isFiniteNumber(constants.futureSkewToleranceSec) ? constants.futureSkewToleranceSec : 0;
  const skewMs = Math.max(0, toleranceSec) * MS_PER_SEC;
  const sources = [];
  const accepted = [];

  const consider = (sourceId, rawMs, extra = {}) => {
    const entry = {
      id: sourceId,
      source: LIVENESS_SOURCE_LABEL[sourceId] ?? sourceId,
      status: 'missing',
      ageSec: null,
      at: null,
      ...extra,
    };

    if (extra.skippedSensitive === true) {
      entry.status = 'skipped_sensitive';
      sources.push(entry);
      return;
    }
    if (!isFiniteNumber(rawMs)) {
      sources.push(entry);
      return;
    }
    if (rawMs <= 0) {
      // epoch 0 / 1970：无效时间戳，跳过（SPEC §4.1）
      entry.status = 'invalid';
      entry.invalidReason = 'epoch_zero';
      sources.push(entry);
      return;
    }
    if (rawMs > nowMs + skewMs) {
      // 未来时间：超过 futureSkewToleranceSec 视为时钟异常，该源作废并留痕 clockSkew
      entry.status = 'invalid';
      entry.invalidReason = 'clock_skew';
      entry.clockSkew = true;
      sources.push(entry);
      return;
    }
    // 容差以内的未来时间按「刚刚」计（ageSec = 0）
    const effectiveMs = Math.min(rawMs, nowMs);
    entry.status = 'ok';
    entry.at = isoOrNull(effectiveMs);
    entry.ageSec = Math.max(0, Math.round((nowMs - effectiveMs) / MS_PER_SEC));
    sources.push(entry);
    accepted.push({ ...entry });
  };

  // ── 源 1：日志文件写入时间 ────────────────────────────────────────
  // 注意：日志内容读不出来（eacces）但文件确实被写过，mtime 仍是真实的文件系统事实。
  //
  // 但 0 字节日志例外（队长裁定 B2）：文件被 touch / 被轮转截断，也会让 mtime 变新，
  // 这证明「文件被动过」，不证明「她刚干了活」。仅凭一个空日志就宣布
  // 「她不到 1 分钟前还在动」是假健康 —— 这种场景必须落到 unknown。
  // 若 session / 判重表另有新鲜痕迹，第 2、3 源仍然会把 liveness 抬起来，不受影响。
  // 另一例外：凭证类文件被凭证闸挡下时，连 mtime 都不许用（不能借 mtime 泄露存在性）。
  const log = read?.log && typeof read.log === 'object' ? read.log : null;
  const logHasContent = !!log && log.reason !== 'empty' && !(isFiniteNumber(log.size) && log.size === 0);
  consider('log_mtime', logHasContent ? log.mtimeMs : null, {
    skippedSensitive: log?.reason === 'sensitive_skipped',
    note: !log ? 'no_log_located' : (logHasContent ? undefined : 'log_empty_no_content'),
  });

  // ── 源 2：session 记录最近一次写入 ───────────────────────────────
  const sessions = read?.sessions && typeof read.sessions === 'object' ? read.sessions : null;
  consider('session_mtime', sessions ? sessions.newestMtimeMs : null);

  // ── 源 3：判重表最后更新 ─────────────────────────────────────────
  const dedupe = read?.dedupe && typeof read.dedupe === 'object' ? read.dedupe : null;
  const dedupeMs = dedupe
    ? (isFiniteNumber(dedupe.lastUpdateAt)
      ? dedupe.lastUpdateAt
      : (isFiniteNumber(dedupe.lastEntryAt)
        ? dedupe.lastEntryAt
        : finiteOrNull(dedupe.fileMtimeAt)))
    : null;
  consider('dedupe_mtime', dedupeMs, {
    skippedSensitive: dedupe?.reason === 'sensitive_file',
  });

  // ── 源 4：进程启动时间（D2 v0.1 不提供；有就用，没有就老实说没有）──
  consider('process_start', processState.startMs, {
    processAvailable: processState.available,
  });

  return { sources, accepted };
}

/**
 * liveness 判定。
 * @param {object} read D3 的 PondRead
 * @param {object} [options]
 * @returns {object} Indicator
 */
export function evaluateLiveness(read, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rules = loadRules(opts);
  const meta = indicatorMeta(rules, 'liveness', '存活', 'sec');
  const nowMs = resolveNow(read, opts);
  const constants = constantsOf(rules, 'liveness');
  const forbiddenSignals = Array.isArray(rules?.indicators?.liveness?.forbiddenSignals)
    ? rules.indicators.liveness.forbiddenSignals
    : [];

  if (!rules) {
    return fallbackIndicator({
      id: 'liveness',
      nameZh: meta.nameZh,
      unit: meta.unit,
      reason: 'rules_unavailable',
      missing: ['rules'],
      evidence: { note: '读不到 rules.json，liveness 的阈值无从取起。' },
    });
  }

  const processState = detectProcessState(read);
  const { sources, accepted } = collectLivenessSources(read, nowMs, constants, processState);

  const baseEvidence = {
    ageSec: null,
    lastActivityAt: null,
    chosenSource: null,
    sources,
    aggregation: 'max',
    processAlive: processState.alive,
    processStartAvailable: processState.available,
    futureSkewToleranceSec: isFiniteNumber(constants.futureSkewToleranceSec)
      ? constants.futureSkewToleranceSec
      : null,
    forbiddenSignalsIgnored: forbiddenSignals,
    ignoredFieldsNote: 'online / heartbeat / status 这类字段一个都没读：僵尸进程和断线 bot 都能把它们报成正常。',
    missing: [],
  };

  // ── 一个有效源都没有 → unknown（不是「还好」）───────────────────
  if (accepted.length === 0) {
    const invalid = sources.filter((item) => item.status === 'invalid');
    const skipped = sources.filter((item) => item.status === 'skipped_sensitive');
    let reason = 'all_sources_missing';
    let phenomenon;
    let nextStep;
    if (invalid.length > 0 && invalid.every((item) => item.invalidReason === 'clock_skew')) {
      reason = 'clock_skew';
      phenomenon = '她所有活动记录的时间都在未来 —— 系统时钟多半不对，现在判不出死活（这不是「刚动过」）。';
      nextStep = '先把系统时间校准（sudo timedatectl set-ntp true；没有 systemd 就用 sudo date -s 手动对时），再跑一次体检。时钟没对上之前，「存活」这栏只能判不出。';
    } else if (invalid.length > 0) {
      reason = 'invalid_timestamps';
      phenomenon = '活动记录的时间戳全是无效值（epoch 0 / 明显越界）—— 判不出她最后一次动是什么时候。';
      nextStep = '看一眼她日志里的时间格式（需要一个能认出来的日期时间，ISO 或本地「YYYY-MM-DD HH:MM:SS」都行），或用 --log 指一份正常日志再体检。';
    } else if (skipped.length > 0) {
      reason = 'sensitive_skipped';
      phenomenon = '能定位到的活动痕迹只有凭证类文件 —— 体检按规矩不读它们，所以判不出死活。';
      nextStep = '用 --log <她的普通日志文件> 指一份非凭证的日志；别把日志和 cookie/token 放同一个文件里。';
    }

    return assemble({
      rules,
      id: 'liveness',
      nameZh: meta.nameZh,
      unit: meta.unit,
      level: 'unknown',
      value: null,
      vars: {},
      evidence: baseEvidence,
      missing: ['log', 'session', 'dedupe'],
      reason,
      reasonText: phenomenon,
      phenomenon,
      nextStep,
    });
  }

  // ── 聚合：取最新（最小 ageSec）的那个源 ──────────────────────────
  const chosen = accepted.reduce((best, item) => (best === null || item.ageSec < best.ageSec ? item : best), null);
  const ageSec = chosen.ageSec;
  baseEvidence.ageSec = ageSec;
  baseEvidence.lastActivityAt = chosen.at;
  baseEvidence.chosenSource = chosen.id;
  baseEvidence.sourceLabel = chosen.source;
  baseEvidence.sourcesSummary = summarizeLivenessSources(sources);

  let bandResult;
  try {
    bandResult = evalBandsByRules(rules, 'liveness', { ageSec });
  } catch (err) {
    return defectIndicator({
      id: 'liveness',
      nameZh: meta.nameZh,
      unit: meta.unit,
      err,
      evidence: baseEvidence,
    });
  }

  const level = bandResult.level;
  const ageDays = Math.floor(ageSec / SEC_PER_DAY);
  const vars = { ageHuman: formatAgeHuman(ageSec), ageDays };

  // processCold 变体（窝在、进程不在）：文案追加一句 + nextStep 换成「怎么拉起来」。
  // D2 v0.1 不做进程表，所以这条分支现在走不到；接口留着，D6 补上 P1 后自动生效。
  const processCold = processState.alive === false;
  if (processCold) {
    const coldVariant = rules?.indicators?.liveness?.variants?.processCold;
    const startHint = livenessStartHint(rules, read);
    const suffix = fillTemplate(
      coldVariant?.phenomenonSuffix ?? ' 而且进程不在 —— 现在没有任何进程在跑她。',
      {},
    );
    const step = fillTemplate(
      coldVariant?.nextStepTemplate ?? '按启动命令拉起来：{startHint}，起来后等 10 分钟再体检一次。',
      { startHint },
    );
    const result = assemble({
      rules,
      id: 'liveness',
      nameZh: meta.nameZh,
      unit: meta.unit,
      level,
      value: ageSec,
      vars,
      evidence: { ...baseEvidence, processCold: true, startHint },
      missing: [],
    });
    if (result.level !== 'unknown') {
      result.phenomenon = `${result.phenomenon}${suffix.text}`;
      result.nextStep = step.text;
    }
    return result;
  }

  return assemble({
    rules,
    id: 'liveness',
    nameZh: meta.nameZh,
    unit: meta.unit,
    level,
    value: ageSec,
    vars,
    evidence: baseEvidence,
    missing: [],
  });
}

/** 源清单的紧凑视图（报告脚注用得上，但不塞整份 sources）。 */
function summarizeLivenessSources(sources) {
  const summary = {};
  for (const item of sources) {
    summary[item.id] = item.status;
  }
  return summary;
}

/* ================================================================== *
 * 2. rhythm · 节律
 *
 * 近 windowDays 天，每天几条带时间戳的活动记录；activeDaysInWindow = 有记录的天数。
 *
 * 难点不是数天数，是**诚实**：D3a 只读日志尾部（默认 256 KiB / 最多 500 行，
 * 聚合层实际只取最后 50 行），所以「近 7 天」这条时间轴经常只被覆盖了一部分。
 * 本实现因此额外算一个「盲区」：
 *
 *   - 日志尾部是一条**连续**的字节区间，它最早那条时间戳之前的日子，我们没看见；
 *   - 盲区里的日子既可能是「她休息」也可能是「日志轮转/太短」，分不清；
 *   - 于是给出下界（看得见的天数 = activeDays）与上界（activeDays + 盲区天数），
 *     两个下界落在同一档 → 判定成立；落在不同档 → **unknown**，并把「只看到几天、
 *     其中几天醒过」写进人话。
 *
 * 这样「近 7 天只醒了 1 天」这种 bad 结论绝不会建立在「只看到 2 天」的数据上。
 * 反过来，只要证据够，steady（>=5 天有活动）这类 ok 结论也站得稳。
 * ================================================================== */

function skewToleranceMs(rules, indicatorId) {
  const constants = constantsOf(rules, indicatorId);
  const sec = isFiniteNumber(constants.futureSkewToleranceSec) ? constants.futureSkewToleranceSec : 0;
  return Math.max(0, sec) * MS_PER_SEC;
}

/**
 * rhythm 判定。
 * @param {object} read D3 的 PondRead
 * @param {object} [options]
 * @returns {object} Indicator
 */
export function evaluateRhythm(read, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rules = loadRules(opts);
  const meta = indicatorMeta(rules, 'rhythm', '节律', 'days');
  const nowMs = resolveNow(read, opts);

  if (!rules) {
    return fallbackIndicator({
      id: 'rhythm',
      nameZh: meta.nameZh,
      unit: meta.unit,
      reason: 'rules_unavailable',
      missing: ['rules'],
      evidence: { note: '读不到 rules.json，节律的窗口与档位无从取起。' },
    });
  }

  const constants = constantsOf(rules, 'rhythm');
  const windowDays = Math.floor(isFiniteNumber(constants.windowDays) ? constants.windowDays : 0);
  if (!(windowDays > 0)) {
    return fallbackIndicator({
      id: 'rhythm',
      nameZh: meta.nameZh,
      unit: meta.unit,
      reason: 'rules_invalid',
      reasonText: 'rules.json 里 rhythm.thresholds.constants.windowDays 缺失或不是正数 —— 判不出节律（不是规律）。',
      missing: ['windowDays'],
      evidence: { windowDays: constants.windowDays ?? null },
    });
  }

  const skewMs = skewToleranceMs(rules, 'rhythm') || skewToleranceMs(rules, 'liveness');
  const dailyCounts = new Array(windowDays).fill(0);
  const sourceStats = {
    log_timestamps: { status: 'missing', parsedLines: 0, unparsedLines: 0, clockSkewLines: 0 },
    session_timestamps: { status: 'missing', markedDays: 0 },
    dedupe_entry_dates: { status: 'missing', todayNew: null, markedDays: 0 },
  };

  const log = read?.log && typeof read.log === 'object' ? read.log : null;
  const lines = log && log.ok === true && Array.isArray(log.lines) ? log.lines : null;

  let earliestLogMs = null;
  let latestLogMs = null;
  let logEntriesInWindow = 0;

  if (lines && lines.length > 0) {
    sourceStats.log_timestamps.status = 'ok';
    for (const line of lines) {
      // D3a 已把时间戳解析（十几条正则）做好了，这里只复用它的纯函数，绝不重写。
      const parsed = typeof line === 'string' ? parseTimestamp(line) : null;
      if (!parsed || !isFiniteNumber(parsed.ms)) {
        sourceStats.log_timestamps.unparsedLines += 1;
        continue;
      }
      if (parsed.ms > nowMs + skewMs) {
        // 未来时间：作废这一条（可能是时钟错乱，也不能让它冒充「未来醒过」）
        sourceStats.log_timestamps.clockSkewLines += 1;
        continue;
      }
      if (parsed.ms <= 0) {
        sourceStats.log_timestamps.unparsedLines += 1;
        continue;
      }
      sourceStats.log_timestamps.parsedLines += 1;
      const ms = Math.min(parsed.ms, nowMs);
      if (earliestLogMs === null || ms < earliestLogMs) earliestLogMs = ms;
      if (latestLogMs === null || ms > latestLogMs) latestLogMs = ms;
      const slot = daySlot(dayIndexFromNow(ms, nowMs), windowDays);
      if (slot >= 0) {
        dailyCounts[slot] += 1;
        logEntriesInWindow += 1;
      }
    }
  } else if (log && log.ok !== true) {
    sourceStats.log_timestamps.status = 'unreadable';
    sourceStats.log_timestamps.reason = log.reason ?? 'read_error';
  }

  /** 把一个「孤立时间点」记到某一天：只在该天还没有任何记录时记 1，避免重复计数。 */
  const markIsolatedDay = (ms, bucket) => {
    if (!isFiniteNumber(ms) || ms <= 0 || ms > nowMs + skewMs) return false;
    const slot = daySlot(dayIndexFromNow(Math.min(ms, nowMs), nowMs), windowDays);
    if (slot < 0) return false;
    if (dailyCounts[slot] === 0) {
      dailyCounts[slot] = 1;
      bucket.markedDays += 1;
      return true;
    }
    return false;
  };

  // 退路 1：session 记录（D3 只给「最新一次写入」，够用来把某一天标成醒过）
  const sessions = read?.sessions && typeof read.sessions === 'object' ? read.sessions : null;
  if (sessions) {
    if (isFiniteNumber(sessions.newestMtimeMs) && sessions.newestMtimeMs > 0) {
      sourceStats.session_timestamps.status = 'ok';
      markIsolatedDay(sessions.newestMtimeMs, sourceStats.session_timestamps);
    } else if (sessions.reason) {
      sourceStats.session_timestamps.status = 'missing';
      sourceStats.session_timestamps.reason = sessions.reason;
    }
  }

  // 退路 2：判重表条目日期（D3 只给「今日新增」和「最近一条时间」）
  const dedupe = read?.dedupe && typeof read.dedupe === 'object' ? read.dedupe : null;
  if (dedupe) {
    if (isFiniteNumber(dedupe.todayNew)) {
      sourceStats.dedupe_entry_dates.status = 'ok';
      sourceStats.dedupe_entry_dates.todayNew = dedupe.todayNew;
      if (dedupe.todayNew > 0) {
        const todaySlot = windowDays - 1;
        // 今日新增是「今天的记录条数」：与日志时间戳同时存在时取较大者，不叠加
        dailyCounts[todaySlot] = Math.max(dailyCounts[todaySlot], dedupe.todayNew);
      }
    }
    if (isFiniteNumber(dedupe.lastEntryAt)) {
      sourceStats.dedupe_entry_dates.status = 'ok';
      markIsolatedDay(dedupe.lastEntryAt, sourceStats.dedupe_entry_dates);
    }
    if (dedupe.reason) sourceStats.dedupe_entry_dates.reason = dedupe.reason;
  }

  // ── 覆盖率：日志尾部是一条连续区间，它最早的时间戳之前都是「盲区」──────
  const logStartDayIndex = earliestLogMs === null ? null : dayIndexFromNow(earliestLogMs, nowMs);
  const coveredFromDayIndex = logStartDayIndex === null
    ? null
    : Math.min(0, logStartDayIndex);
  const isCoveredDay = (dayIndex) => coveredFromDayIndex !== null && dayIndex >= coveredFromDayIndex;

  const activeDaysInWindow = dailyCounts.filter((count) => count > 0).length;
  const totalEvents = dailyCounts.reduce((sum, count) => sum + count, 0);

  let blindDays = 0;
  for (let dayIndex = -(windowDays - 1); dayIndex <= 0; dayIndex += 1) {
    const slot = daySlot(dayIndex, windowDays);
    if (slot < 0) continue;
    if (dailyCounts[slot] > 0) continue;
    if (isCoveredDay(dayIndex)) continue;
    blindDays += 1;
  }

  const hasAnyTimestamp = sourceStats.log_timestamps.parsedLines > 0
    || sourceStats.session_timestamps.markedDays > 0
    || sourceStats.dedupe_entry_dates.markedDays > 0
    || (isFiniteNumber(dedupe?.todayNew) && dedupe.todayNew > 0);

  const maxPerDay = dailyCounts.reduce((max, count) => (count > max ? count : max), 0);
  const avgPerDay = activeDaysInWindow > 0
    ? Math.round((totalEvents / activeDaysInWindow) * 10) / 10
    : 0;
  const todayCount = dailyCounts[windowDays - 1];

  const baseEvidence = {
    windowDays,
    dailyCounts,
    activeDaysInWindow,
    totalEvents,
    avgPerDay,
    maxPerDay,
    todayCount,
    blindDays,
    coveredDays: windowDays - blindDays,
    coverageStartAt: isoOrNull(earliestLogMs),
    lastTimestampAt: isoOrNull(latestLogMs),
    logEntriesInWindow,
    logLinesExamined: lines ? lines.length : 0,
    logTruncated: log ? log.truncated === true : null,
    logLineCount: isFiniteNumber(log?.lineCount) ? log.lineCount : null,
    sources: sourceStats,
    wakeDefinition: '本地自然日里出现 >= 1 条带时间戳的活动记录，算这一天醒过。',
    missing: [],
  };

  // ── 一个可用时间戳都没有 → unknown ──────────────────────────────
  if (!hasAnyTimestamp) {
    const logReason = log ? (log.ok === true ? 'no_timestamps' : (log.reason ?? 'read_error')) : 'no_log';
    const missing = log ? ['timestamps'] : ['log'];
    let reasonText;
    if (log?.ok === true) {
      reasonText = `日志里 ${sourceStats.log_timestamps.unparsedLines} 行没有一行带可解析的时间戳 —— 数不出「哪天醒过」。`;
    } else if (log) {
      reasonText = `日志读不出来（reason=${logReason}）—— 节律只能判不出。`;
    } else {
      reasonText = '一个日志文件都没定位到 —— 节律只能判不出。';
    }
    return assemble({
      rules,
      id: 'rhythm',
      nameZh: meta.nameZh,
      unit: meta.unit,
      level: 'unknown',
      value: null,
      vars: {},
      evidence: baseEvidence,
      missing,
      reason: logReason,
      reasonText,
    });
  }

  // ── 分档：下界 / 上界同档才敢下结论 ─────────────────────────────
  let lowerBand;
  let upperBand;
  try {
    lowerBand = evalBandsByRules(rules, 'rhythm', { activeDaysInWindow }).level;
    upperBand = evalBandsByRules(rules, 'rhythm', { activeDaysInWindow: activeDaysInWindow + blindDays }).level;
  } catch (err) {
    return defectIndicator({
      id: 'rhythm',
      nameZh: meta.nameZh,
      unit: meta.unit,
      err,
      evidence: baseEvidence,
    });
  }

  const decided = upperBand === lowerBand;
  const level = decided ? lowerBand : 'unknown';

  // 「以前天天跑，这三天没动」：只统计**完整自然日**（今天可能才刚开始，不算数），
  // 而且只统计日志覆盖得到的日子（盲区里没醒不是事实，是没看见）。
  let silentFullDays = 0;
  for (let dayIndex = -1; dayIndex >= -(windowDays - 1); dayIndex -= 1) {
    const slot = daySlot(dayIndex, windowDays);
    if (slot < 0) break;
    if (!isCoveredDay(dayIndex)) break;
    if (dailyCounts[slot] > 0) break;
    silentFullDays += 1;
  }
  const activeDaysBeforeSilence = dailyCounts
    .slice(0, Math.max(0, windowDays - 1 - silentFullDays))
    .filter((count) => count > 0)
    .length;
  const recentSilence = silentFullDays > 0 && activeDaysBeforeSilence > 0;
  baseEvidence.silentFullDays = silentFullDays;
  baseEvidence.activeDaysBeforeSilence = activeDaysBeforeSilence;
  baseEvidence.pattern = recentSilence
    ? 'recent_silence'
    : (activeDaysInWindow > 0 ? 'steady_activity' : 'no_activity_in_view');
  baseEvidence.lowerBand = lowerBand;
  baseEvidence.upperBand = upperBand;
  baseEvidence.coverageAmbiguous = !decided;

  const vars = {
    activeDays: activeDaysInWindow,
    avgPerDay,
    windowDays,
  };

  // ── 覆盖不足：不下结论，但把「看到了什么」讲清楚 ──────────────────
  if (!decided) {
    // 两种「看不全」要分开说：日志时间戳一条都没有 vs 有但只覆盖了最近几天
    const logHasNoTimestamp = earliestLogMs === null;
    const coveragePhenomenon = logHasNoTimestamp
      ? `日志里没有一条能定位到某天的时间戳，只能靠 session / 判重表确认最近 ${activeDaysInWindow} 天有活动`
        + `（${windowDays} 天里的另外 ${windowDays - activeDaysInWindow} 天完全没证据）—— 整周节律判不出来。`
      : `这次只看到最近 ${windowDays - blindDays} 天的记录：其中 ${activeDaysInWindow} 天醒过`
        + `${silentFullDays > 0 ? `，最后 ${silentFullDays} 个完整自然日一次都没醒` : ''}；`
        + `再往前 ${blindDays} 天没看见，所以整周的节律判不出来（不是「规律」，也不是「停了」）。`;

    return assemble({
      rules,
      id: 'rhythm',
      nameZh: meta.nameZh,
      unit: meta.unit,
      level: 'unknown',
      value: null,
      vars,
      evidence: {
        ...baseEvidence,
        missing: ['window_coverage'],
        observedActiveDays: activeDaysInWindow,
      },
      missing: ['window_coverage'],
      reason: 'insufficient_coverage',
      reasonText: `日志只能看到最近 ${windowDays - blindDays} 天里的记录，前面 ${blindDays} 天没看见 —— 整周的节律判不出来（这不是「规律」）。`,
      phenomenon: coveragePhenomenon,
      nextStep: `别清 logs/ 里的历史日志（或让框架按天切割、多留几天），然后重跑一次体检；`
        + `只想看「这几天有没有动」的话，先看「存活」那栏——那栏不依赖 ${windowDays} 天窗口。`,
    });
  }

  // 走到这里说明上下界同档：结论成立。若「最后 N 天没醒」而档位仍是 steady/drifting，
  // 必须在人话里点出来 —— 否则「作息是稳的」会变成假安心。
  const levelIsReassuring = level === 'steady' || level === 'drifting';
  const phenomenonSuffix = levelIsReassuring && recentSilence
    ? `但最后 ${silentFullDays} 个完整自然日一次都没醒，前面 ${activeDaysBeforeSilence} 天是醒着的`
    : undefined;
  const nextStepSuffix = levelIsReassuring && recentSilence
    ? `另外：最后 ${silentFullDays} 天没醒，先确认是它自己停了还是你手动关了；要去看看「存活」那栏。`
    : undefined;

  return assemble({
    rules,
    id: 'rhythm',
    nameZh: meta.nameZh,
    unit: meta.unit,
    level,
    value: activeDaysInWindow,
    vars,
    evidence: baseEvidence,
    missing: [],
    phenomenonSuffix,
    nextStepSuffix,
  });
}

/* ================================================================== *
 * 3. throughput · 工作量
 *
 * 主数据是判重表（D3b 已把五种格式都归一到 count / todayNew / lastEntryAt）。
 * 数字不动 = 卡住了：todayNew 决定今天有没有出货，daysSinceLastNew 决定停摆多久。
 *
 * 严格按 SPEC §4「先算得出来，再分档」：主指标 todayNew 为 null → unknown，
 * **不**去命中 quiet（否则会把「算不出今日新增」说成「今天还没新增」）。
 * ================================================================== */

/**
 * throughput 判定。
 * @param {object} read D3 的 PondRead
 * @param {object} [options]
 * @returns {object} Indicator
 */
export function evaluateThroughput(read, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rules = loadRules(opts);
  const meta = indicatorMeta(rules, 'throughput', '工作量', 'count');
  const nowMs = resolveNow(read, opts);

  if (!rules) {
    return fallbackIndicator({
      id: 'throughput',
      nameZh: meta.nameZh,
      unit: meta.unit,
      reason: 'rules_unavailable',
      missing: ['rules'],
      evidence: { note: '读不到 rules.json，工作量的档位无从取起。' },
    });
  }

  const constants = constantsOf(rules, 'throughput');
  const dedupe = read?.dedupe && typeof read.dedupe === 'object' ? read.dedupe : null;
  const skewMs = skewToleranceMs(rules, 'throughput') || skewToleranceMs(rules, 'liveness');
  const primaryMetric = thresholdsOf(rules, 'throughput').metric ?? 'todayNew';

  const totalEntries = finiteOrNull(dedupe?.count);
  const todayNew = finiteOrNull(dedupe?.todayNew);
  const countEstimated = dedupe?.countEstimated === true;
  const format = typeof dedupe?.format === 'string' ? dedupe.format : null;

  // 最近一次新增：条目时间与文件写入时间取新（D3b 的 lastUpdateAt 就是干这个的）
  const rawLastNew = dedupe
    ? (isFiniteNumber(dedupe.lastUpdateAt)
      ? dedupe.lastUpdateAt
      : (isFiniteNumber(dedupe.lastEntryAt)
        ? dedupe.lastEntryAt
        : finiteOrNull(dedupe.fileMtimeAt)))
    : null;
  const lastNewMs = isFiniteNumber(rawLastNew) && rawLastNew > 0 && rawLastNew <= nowMs + skewMs
    ? Math.min(rawLastNew, nowMs)
    : null;
  const daysSinceLastNew = lastNewMs === null
    ? null
    : Math.max(0, Math.floor((nowMs - lastNewMs) / MS_PER_DAY));

  const baseEvidence = {
    totalEntries,
    totalEntriesEstimated: countEstimated,
    todayNew,
    daysSinceLastNew,
    lastNewAt: isoOrNull(lastNewMs),
    format,
    primaryMetric,
    sampleWindowDays: isFiniteNumber(constants.sampleWindowDays) ? constants.sampleWindowDays : null,
    maxEntriesCounted: isFiniteNumber(constants.maxEntriesCounted) ? constants.maxEntriesCounted : null,
    dedupeReason: dedupe?.reason ?? null,
    dedupeReasonText: dedupe?.reasonText ?? null,
    sourceUsed: null,
    missing: [],
  };

  // ── 连条目数都拿不到 → unknown（missing:['dedupe']）─────────────────
  if (totalEntries === null) {
    const reason = dedupe?.reason ?? 'not_found';
    const reasonText = dedupe?.reasonText
      ?? '没找到判重表 —— 她干了多少活这件事，这次是「没看到」，不是「干得挺好」。';
    return assemble({
      rules,
      id: 'throughput',
      nameZh: meta.nameZh,
      unit: meta.unit,
      level: 'unknown',
      value: null,
      vars: {},
      evidence: baseEvidence,
      missing: ['dedupe'],
      reason,
      reasonText,
    });
  }

  baseEvidence.sourceUsed = format ? `dedupe_store:${format}` : 'dedupe_store';

  // ── 主指标为 null → unknown（绝不命中 quiet）───────────────────────
  if (todayNew === null) {
    const reason = dedupe?.reason ?? 'no_timestamps';
    const reasonText = dedupe?.reasonText
      ?? '判重表里没有可解析的时间戳 —— 「今天新增几条」算不出来（不是 0）。';
    return assemble({
      rules,
      id: 'throughput',
      nameZh: meta.nameZh,
      unit: meta.unit,
      level: 'unknown',
      value: null,
      vars: {},
      evidence: baseEvidence,
      missing: [primaryMetric],
      reason,
      reasonText,
      phenomenon: `判重表找到了（${format ?? '未知格式'}，${totalEntries} 条${countEstimated ? '，已封顶' : ''}），`
        + '但条目里没有可解析的时间戳 —— 「今天新增几条」算不出来（不是 0）。',
      nextStep: '让判重表每条带上处理时间（processedAt / ts / time 之一，ISO 或 epoch 都行），'
        + 'sqlite 表就确认时间列的名字在上面那几个里；改完再体检，工作量才数得出今天。',
    });
  }

  let bandResult;
  try {
    bandResult = evalBandsByRules(rules, 'throughput', {
      totalEntries,
      todayNew,
      daysSinceLastNew,
    });
  } catch (err) {
    return defectIndicator({
      id: 'throughput',
      nameZh: meta.nameZh,
      unit: meta.unit,
      err,
      evidence: baseEvidence,
    });
  }

  const level = bandResult.level;
  const vars = {
    todayNew,
    totalEntries,
    daysSinceLastNew,
  };

  // 「计数被封顶」不是坏消息也不是好消息，但报告里得让人知道自己看到的是下限
  const suffixParts = [];
  if (countEstimated && isFiniteNumber(constants.maxEntriesCounted)) {
    suffixParts.push(`条目数已按 ${constants.maxEntriesCounted} 条封顶，实际只会更多`);
  }
  const phenomenonSuffix = suffixParts.length > 0 ? suffixParts.join('；') : undefined;

  return assemble({
    rules,
    id: 'throughput',
    nameZh: meta.nameZh,
    unit: meta.unit,
    level,
    value: todayNew,
    vars,
    evidence: baseEvidence,
    missing: [],
    phenomenonSuffix,
  });
}

/* ================================================================== *
 * 4. 三指标一次拿全（D4 收口直接用）
 * ================================================================== */

/** 时间基准：options.now > read.now > 现在。 */
function resolveNow(read, options) {
  if (isFiniteNumber(options?.now)) return options.now;
  if (isFiniteNumber(read?.now)) return read.now;
  return Date.now();
}

/**
 * 判出生活类三指标。永不抛：单个指标崩了只降级那一格。
 *
 * @param {object} read D3 的 PondRead
 * @param {object} [options]
 * @returns {{liveness:object, rhythm:object, throughput:object, now:number, degraded:Array}}
 */
export function evaluateLife(read, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const input = read && typeof read === 'object' ? read : {};
  const nowMs = resolveNow(input, opts);
  const rules = loadRules(opts);

  const runSafely = (id, nameZh, unit, fn) => {
    try {
      return fn();
    } catch (err) {
      // 兜底：任何意外都只是这一格 unknown，绝不把整份体检带走，也绝不写成 ok
      return fallbackIndicator({
        id,
        nameZh,
        unit,
        reason: err?.code === 'RULES_INVALID' ? 'rules_invalid' : 'evaluate_failed',
        reasonText: `这一格判定时自己崩了（${err?.message ?? 'unknown'}）—— 按判不出处理，别当正常。`,
        missing: ['internal'],
        evidence: { errorName: err?.name ?? null },
      });
    }
  };

  const shared = { ...opts, rules, now: nowMs };
  const liveness = runSafely('liveness', '存活', 'sec', () => evaluateLiveness(input, shared));
  const rhythm = runSafely('rhythm', '节律', 'days', () => evaluateRhythm(input, shared));
  const throughput = runSafely('throughput', '工作量', 'count', () => evaluateThroughput(input, shared));

  const indicators = { liveness, rhythm, throughput };
  const degraded = [];
  for (const id of LIFE_INDICATOR_IDS) {
    const item = indicators[id];
    if (item && Array.isArray(item.degraded)) degraded.push(...item.degraded);
  }

  return { ...indicators, now: nowMs, degraded };
}

export default evaluateLife;
