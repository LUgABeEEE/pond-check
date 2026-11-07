/**
 * pond-check · D4 收口：六指标聚合与报告总评（src/evaluate/index.mjs）
 *
 * 这一层把 D4a（生活类三指标：liveness / rhythm / throughput）与
 * D4b（系统类三指标：health / deps / drift）拼成**一条鱼一份体检结论**，
 * 再把若干条鱼拢成**一页报告**：总评一句 + 最该做的事一句 + 脚注一句。
 *
 * 职责边界（很重要，越界就会变成第二个 D4）：
 *   - 本文件**不做任何档位判定**。六格的 level / severity / phenomenon / nextStep
 *     全部由 life.mjs 与 system.mjs 产出，这里只做：排序、计数、合并、取名、拼句子。
 *   - 本文件**不读文件系统**（唯一的例外是从 rules.json 读展示用的名字与总评模板），
 *     不联网、不起进程、不写任何东西。
 *   - 因此它可以是同步纯函数：`evaluate(pondData)` 进来，报告对象出去。
 *
 * 契约：
 *   evaluate(pondData, options?)      -> Report
 *   evaluateFish(pondRead, options?)  -> Fish（单条鱼，CLI 的 --fish 场景直接用）
 *   INDICATOR_IDS                     -> ['liveness','rhythm','throughput','health','deps','drift']
 *   BAND_LABELS                       -> 档位中文短名（只用于渲染，不参与判定）
 *
 *   pondData 接受四种形状（都容错，永不抛）：
 *     1. { ponds: [PondRead, ...] }        ← CLI 主路径
 *     2. { fishes|reads|items: [...] }     ← 同上，别名
 *     3. [PondRead, ...]                   ← 直接给数组
 *     4. 单个 PondRead（或 { read: PondRead }）
 *   每个元素是 D3 的 PondRead（`await readPond(pond)` 的结果）；缺字段一律按「读不到」
 *   处理，交给六格自己判 unknown，本层绝不替它补一个「正常」。
 *
 *   options：
 *     now            时间基准（ms）；缺省 pondData.now，再缺省 Date.now()
 *     rules          注入一份 rules 对象（测试用；会同时生效于 life 与 system）
 *     rulesPath      life 用的 rules 路径（system 不认，见 system.mjs 的 setRules）
 *     tolerant       传给 system.mjs；缺省 true（CLI 生产路径：规格破洞降 unknown 不崩）
 *     fieldPresence  drift 的键名存在性注入（构造测试用）
 *     credentials    deps.credentialFreshness 的预计算结果（整机事实）
 *     maxFixesPerFish 覆盖 rules.rollup.maxFixesPerFish（缺省从 rules 读）
 *
 * Report = {
 *   schemaVersion, generatedAt, host{platform,node},
 *   fishes: [Fish],
 *   summary: { fish, ok, watch, bad, unknown },   // ok/watch/bad/unknown 数的是**指标格**（SPEC §6.2 示例口径）
 *   verdict:  一句总评（"N 条鱼 · X 正常 · Y 要注意 · Z 坏了 · W 判不出" + unknown 提示）
 *   nextAction: 一句最该做的事（最差那条鱼的第一条 fix）
 *   footnote: null | "N 项数据读不到（...），这些项目不能当作正常。"
 *   skippedSensitive: { count, names }            // 只有聚合数量 + 常量 token，绝无文件名
 * }
 *
 * Fish = {
 *   id, kind, kindNameZh, name, stateRoot, processes[],
 *   indicators: { liveness, rhythm, throughput, health, deps, drift },
 *   severity: 'bad'|'unknown'|'watch'|'ok',   // 按 rules.rollup.fishOrder 取最差的那档
 *   worstIndicator: string|null,
 *   headline: "存活 活跃 · 节律 规律 · …",     // 一页报告里的那一行
 *   fixes: string[],                          // 最多 rules.rollup.maxFixesPerFish 条，按严重度排
 *   degraded: [{indicator, reason, missing}], // 只收「确实判不出」的那些，不虚增脚注
 *   notes: string[]
 * }
 *
 * 三条不可协商的口径：
 *   1. **不默认正常**：本层没有任何 `|| 'ok'`；六格给什么就报什么。没有鱼的时候
 *      报告也不空转 —— 总评走 rules.rollup.missingFishTemplate，并给一句下一步。
 *   2. **不改档位**：fishOrder 只决定「排哪条鱼在前面」，severity 只决定「先说哪句」，
 *      绝不把 unknown 折叠成 bad/watch，也绝不把 bad 降成 watch。
 *   3. **凭证零泄漏**：显示用路径逐段过名字闸，命中即替换成 SENSITIVE_PATH_TOKEN；
 *      报告里只允许出现聚合数量与该常量（SPEC §2.4）。
 */

import fs from 'node:fs';
import os from 'node:os';

import { evaluateLife } from './life.mjs';
import {
  evaluateSystem,
  getRules as getSystemRules,
  setRules as setSystemRules,
} from './system.mjs';
import { isCredentialishDirName, SENSITIVE_PATH_TOKEN } from '../discover/generic.mjs';

/* ------------------------------------------------------------------ *
 * 0. 六格与展示标签
 * ------------------------------------------------------------------ */

/** 报告里 `indicators` 的键顺序（SPEC §6.2：必须恰好这六个）。 */
export const INDICATOR_IDS = Object.freeze([
  'liveness', 'rhythm', 'throughput', 'health', 'deps', 'drift',
]);

/**
 * 档位中文短名：**只用于渲染，不参与判定**。
 *
 * rules.json 每个 level 只有 id 和整句 phenomenon，没有短名；一页报告要写成
 * 「存活 活跃 · 节律 规律 · …」这种一行，必须有个短名。这里逐字对应 SPEC §4
 * 六张表里的中文档位名，不多造一个档（rules 没声明的 level 原样回显 id）。
 */
export const BAND_LABELS = Object.freeze({
  liveness: Object.freeze({
    active: '活跃', slack: '疲软', dormant: '疑似休眠', dead: '死了', unknown: '判不出',
  }),
  rhythm: Object.freeze({
    steady: '规律', drifting: '散架', sparse: '偶尔回魂', stopped: '全停', unknown: '判不出',
  }),
  throughput: Object.freeze({
    productive: '在干活', quiet: '今天歇着', stalled: '停摆', empty: '空账本', unknown: '判不出',
  }),
  health: Object.freeze({
    critical: '已经挂了', sick: '有病', noisy: '有点吵', clean: '干净', unknown: '判不出',
  }),
  deps: Object.freeze({
    broken: '坏了', warn: '有隐患', ready: '齐了', unknown: '判不出',
  }),
  drift: Object.freeze({
    drifted: '落后', mismatch: '对不上', aligned: '对齐', unknown: '判不出',
  }),
});

/** rules.discovery.kinds 的 id → 报告里用的 kind 名（D2 的 kind 与 rules 的 id 不同名）。 */
const DISCOVERY_KIND_BY_ID = Object.freeze({
  'dsh-plugin': 'dsh',
  'dsh-home': 'dsh',
  standalone: 'unknown',
  unknown: 'unknown',
});

const RULES_URL = new URL('../rules.json', import.meta.url);

function readRulesFromDisk() {
  try {
    // 只读 rules.json 取展示名与总评模板；判定阈值各行其道，本层不碰。
    return JSON.parse(fs.readFileSync(RULES_URL, 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 1. 小工具
 * ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 极简模板填充：{var} 用 vars 替换，取不到就留「—」（绝不把 {var} 漏进报告）。 */
function fill(template, vars = {}) {
  return String(template ?? '').replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return '—';
    const value = vars[name];
    if (value === null || value === undefined) return '—';
    return String(value);
  });
}

/** 当前生效的 rules：注入的 > system.mjs 里那份 > 磁盘。 */
function resolveRules(options) {
  if (isObject(options?.rules)) return options.rules;
  const injected = getSystemRules();
  if (isObject(injected)) return injected;
  return readRulesFromDisk();
}

function indicatorSpec(rules, id) {
  const spec = rules?.indicators?.[id];
  return isObject(spec) ? spec : null;
}

function levelLabel(id, level) {
  const table = BAND_LABELS[id];
  const label = table && typeof level === 'string' ? table[level] : null;
  // 未知档位原样回显 id —— 不猜、不美化（猜错了就是假报告）
  return typeof label === 'string' && label !== '' ? label : String(level ?? '判不出');
}

/* ------------------------------------------------------------------ *
 * 2. 显示名与路径（凭证零泄漏）
 * ------------------------------------------------------------------ */

/**
 * 目录模式里哪几条是「别去扫」（性能 / 无关），不是「藏着凭证」。
 *
 * rules.credentials.skipDirPatterns 混装了两类：`.ssh`/`.aws`/`secrets` 是凭证，
 * `node_modules`/`.cache`/`.git` 只是扫描时别往里钻。显示用的名字闸只能挡凭证那一类 ——
 * 否则每个 DSH 插件（住在 node_modules 里）的窝都会显示成「[凭证文件已跳过]」，
 * 报告立刻变成一堆看不懂的常量。
 */
const NON_SECRET_DIR_PATTERNS = new Set(['node_modules', '.cache', '.git']);

function segmentRegex(part) {
  const escaped = String(part).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 'i');
}

/** 路径段序列里是否出现凭证目录（支持 `.config/gcloud` 这种多段模式）。 */
function hasCredentialDir(segments, patterns) {
  if (!Array.isArray(patterns)) return false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern === '') continue;
    if (NON_SECRET_DIR_PATTERNS.has(pattern)) continue;
    const parts = pattern.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.length === 1) {
      const re = segmentRegex(parts[0]);
      if (segments.some((segment) => re.test(segment))) return true;
      continue;
    }
    const regexes = parts.map(segmentRegex);
    for (let start = 0; start + regexes.length <= segments.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < regexes.length; offset += 1) {
        if (!regexes[offset].test(segments[start + offset])) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }
  return false;
}

function pathSegments(rootPath) {
  return String(rootPath).split(/[\\/]+/).filter((segment) => segment !== '');
}

/**
 * 显示用的窝路径：逐段过凭证闸（目录模式，不含 node_modules 那类扫描跳过项），
 * 命中即整条替换成常量。$HOME 前缀缩成 `~`，报告里短一点。
 */
export function displayStateRoot(rootPath, rules) {
  if (typeof rootPath !== 'string' || rootPath === '') return null;
  const segments = pathSegments(rootPath);
  const patterns = rules?.credentials?.skipDirPatterns;
  if (hasCredentialDir(segments, patterns) || segments.some((segment) => isCredentialishDirName(segment))) {
    return SENSITIVE_PATH_TOKEN;
  }
  let home = '';
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (home && (rootPath === home || rootPath.startsWith(`${home}/`))) {
    return `~${rootPath.slice(home.length)}`;
  }
  return rootPath;
}

/** 显示名的最后一段（package 名 / 目录名）。整条路径已被凭证闸挡下时不给名字。 */
function shortName(rootPath, stateRoot) {
  if (typeof rootPath !== 'string' || rootPath === '') return null;
  if (stateRoot === SENSITIVE_PATH_TOKEN) return null;
  const parts = pathSegments(rootPath);
  const last = parts.length > 0 ? parts[parts.length - 1] : null;
  return last || null;
}

/** 从 D2 的 id 里取 profile scope（`dsh-plugin:web/pkg` → `web`）。只为显示，不参与判定。 */
function idScope(id, rules) {
  if (typeof id !== 'string') return null;
  const colon = id.indexOf(':');
  if (colon === -1) return null;
  const rest = id.slice(colon + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const scope = rest.slice(0, slash);
  if (scope === '') return null;
  if (hasCredentialDir([scope], rules?.credentials?.skipDirPatterns) || isCredentialishDirName(scope)) return null;
  return scope;
}

/** 独立进程类鱼种：从 id / 目录名猜是哪一种（只影响显示名，不参与判定）。 */
function inferStandaloneKind(rules, read) {
  const haystack = [
    typeof read?.id === 'string' ? read.id : '',
    typeof read?.rootPath === 'string' ? read.rootPath : '',
  ].join(' ').toLowerCase();
  const guesses = [
    { pattern: /astrbot/, id: 'astrbot' },
    { pattern: /napcat|onebot|llonebot/, id: 'napcat' },
    { pattern: /vpet|live2d|desktop-pet|desktoppet/, id: 'desktop-pet' },
  ];
  for (const guess of guesses) {
    if (guess.pattern.test(haystack)) return guess.id;
  }
  const kinds = Array.isArray(rules?.discovery?.kinds) ? rules.discovery.kinds : [];
  return kinds.some((item) => item?.id === 'unknown') ? 'unknown' : null;
}

function kindDisplayName(rules, read) {
  const kind = typeof read?.kind === 'string' && read.kind !== '' ? read.kind : 'unknown';
  const mapped = DISCOVERY_KIND_BY_ID[kind] ?? (kind === 'standalone' ? inferStandaloneKind(rules, read) : kind);
  const kinds = Array.isArray(rules?.discovery?.kinds) ? rules.discovery.kinds : [];
  const spec = kinds.find((item) => item && item.id === mapped) ?? null;
  const nameZh = typeof spec?.nameZh === 'string' && spec.nameZh !== '' ? spec.nameZh : '未识别的鱼';
  return { kind, kindNameZh: nameZh };
}

/* ------------------------------------------------------------------ *
 * 3. 严重度、修复清单、那一行摘要
 * ------------------------------------------------------------------ */

/** rules.rollup.fishOrder：坏的排最上面（unknown 第二，绝不折叠成 bad）。 */
function fishOrder(rules) {
  const order = Array.isArray(rules?.rollup?.fishOrder) ? rules.rollup.fishOrder : null;
  return order && order.length > 0 ? order : ['bad', 'unknown', 'watch', 'ok'];
}

function orderIndex(rules, severity) {
  const index = fishOrder(rules).indexOf(severity);
  return index === -1 ? fishOrder(rules).length : index;
}

/**
 * 一条鱼的严重度 = 六格里按 fishOrder 最靠前的那一档。
 *
 * 为什么不用 rules.severity.rank：rank 里 unknown(3) 比 bad(2) 高，那是为了在
 * 「不许把 unknown 折叠成正常」时有个排序位；而报告的排序契约是
 * rules.rollup.fishOrder（bad → unknown → watch → ok）。两处口径不同，这里按后者。
 */
function worstOf(rules, indicators) {
  const order = fishOrder(rules);
  let worst = 'ok';
  let worstId = null;
  for (const id of INDICATOR_IDS) {
    const indicator = indicators[id];
    const severity = typeof indicator?.severity === 'string' ? indicator.severity : 'unknown';
    if (orderIndex(rules, severity) < orderIndex(rules, worst)) {
      worst = severity;
      worstId = id;
    } else if (severity === worst && worstId === null && severity !== 'ok') {
      worstId = id;
    }
  }
  return { severity: worst, indicator: worstId };
}

/** maxFixesPerFish：rules.rollup.maxFixesPerFish（读不到就 3，与 SPEC §6.1 一致）。 */
function maxFixes(rules, options) {
  if (isFiniteNumber(options?.maxFixesPerFish) && options.maxFixesPerFish > 0) {
    return Math.floor(options.maxFixesPerFish);
  }
  const fromRules = Number(rules?.rollup?.maxFixesPerFish);
  return Number.isFinite(fromRules) && fromRules > 0 ? Math.floor(fromRules) : 3;
}

/**
 * 一条鱼的可执行清单：只收「不是 ok」的那几格的 nextStep，按严重度排、去重、封顶。
 * 六格全 ok 就是空数组 —— 报告里就不该出现「不用动」三行占位。
 */
function collectFixes(rules, indicators, options) {
  const order = fishOrder(rules);
  const entries = [];
  for (const id of INDICATOR_IDS) {
    const indicator = indicators[id];
    if (!isObject(indicator)) continue;
    const severity = typeof indicator.severity === 'string' ? indicator.severity : 'unknown';
    if (severity === 'ok') continue;
    const step = typeof indicator.nextStep === 'string' ? indicator.nextStep.trim() : '';
    if (step === '') continue;
    entries.push({ id, severity, index: order.indexOf(severity), step });
  }
  entries.sort((a, b) => (a.index - b.index) || (INDICATOR_IDS.indexOf(a.id) - INDICATOR_IDS.indexOf(b.id)));
  const out = [];
  for (const entry of entries) {
    if (out.includes(entry.step)) continue;
    out.push(entry.step);
    if (out.length >= maxFixes(rules, options)) break;
  }
  return out;
}

/** 一页报告里的那一行：「存活 活跃 · 节律 规律 · …」。 */
function buildHeadline(rules, indicators) {
  const parts = [];
  for (const id of INDICATOR_IDS) {
    const indicator = isObject(indicators[id]) ? indicators[id] : null;
    const spec = indicatorSpec(rules, id);
    const nameZh = typeof spec?.nameZh === 'string' && spec.nameZh !== ''
      ? spec.nameZh
      : (typeof indicator?.nameZh === 'string' ? indicator.nameZh : id);
    const level = typeof indicator?.level === 'string' ? indicator.level : 'unknown';
    let label = levelLabel(id, level);
    // 工作量这一格把数字带上，报告才有信息量（SPEC §6.1 的示例写法）
    if (id === 'throughput' && level === 'productive' && isFiniteNumber(indicator?.value)) {
      label = `今天 ${indicator.value} 条`;
    }
    parts.push(`${nameZh} ${label}`);
  }
  return parts.join(' · ');
}

/* ------------------------------------------------------------------ *
 * 4. 降级合并
 *
 * 只收「确实判不出」的降级项。D3 的 degraded 是「源缺失」的机械映射，可能写着
 * 「liveness 缺 log」，而 life 层靠判重表 mtime 把 liveness 判成了 active ——
 * 这种条目再算进脚注，就会凭空多出「N 项读不到」，把真问题淹掉。
 * ------------------------------------------------------------------ */

function degradedKey(item) {
  const missing = Array.isArray(item?.missing) ? [...item.missing].sort().join('|') : '';
  return `${item?.indicator ?? '?'}|${item?.reason ?? '?'}|${missing}`;
}

function mergeDegraded(lists) {
  const out = [];
  const seen = new Set();
  const seenIndicator = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObject(item)) continue;
      const key = degradedKey(item);
      if (seen.has(key)) continue;
      // 同一个指标只留第一条（评估器自己的 reason 最贴近「为什么判不出」，
      // D3 的源级映射只是补位）。否则脚注会把同一格数成两项。
      const indicator = typeof item.indicator === 'string' ? item.indicator : null;
      if (indicator && INDICATOR_IDS.includes(indicator)) {
        if (seenIndicator.has(indicator)) continue;
        seenIndicator.add(indicator);
      }
      seen.add(key);
      out.push({
        indicator: typeof item.indicator === 'string' ? item.indicator : 'unknown',
        reason: typeof item.reason === 'string' ? item.reason : 'unknown',
        missing: Array.isArray(item.missing) ? [...item.missing] : [],
      });
    }
  }
  return out;
}

/** 从 D3 的 degraded 里挑出「该指标最终确实判不出」的那些。 */
function readDegradedForUnknown(read, indicators) {
  const list = Array.isArray(read?.degraded) ? read.degraded : [];
  return list.filter((item) => {
    const id = item?.indicator;
    if (typeof id !== 'string' || !INDICATOR_IDS.includes(id)) return false;
    return indicators[id]?.level === 'unknown';
  });
}

/* ------------------------------------------------------------------ *
 * 5. 单条鱼
 * ------------------------------------------------------------------ */

/**
 * 统一六格的结构契约：`evidence.missing` 永远是数组。
 *
 * life.mjs 的 ok 档也会给 missing: []，system.mjs 的 ok 档不带这个字段。做收口就得
 * 把两种写法收成一种 —— 否则 D5 渲染要在六个格子上写两套判空逻辑，迟早漏一个。
 */
function normalizeIndicator(indicator, id, rules) {
  if (!isObject(indicator)) return unknownIndicator(rules, id, 'missing indicator');
  const evidence = isObject(indicator.evidence) ? indicator.evidence : {};
  const missing = Array.isArray(evidence.missing) && evidence.missing.length > 0
    ? evidence.missing
    : (indicator.level === 'unknown'
      // 「判不出」必须能说清缺什么：拿不到现成的就按 evidence 里的证据反推
      // （deps 的逐项 checks、bands 的 missingMetrics），再不行就老实写 unspecified。
      ? (deriveMissing(evidence).length > 0 ? deriveMissing(evidence) : ['unspecified'])
      : (Array.isArray(evidence.missing) ? evidence.missing : []));
  return { ...indicator, evidence: { ...evidence, missing } };
}

/** 从 evidence 里反推「缺的是哪几项」（只认结构化字段，不猜）。 */
function deriveMissing(evidence) {
  const out = [];
  if (Array.isArray(evidence?.missingMetrics)) {
    for (const item of evidence.missingMetrics) {
      if (typeof item === 'string' && item !== '') out.push(item);
    }
  }
  if (Array.isArray(evidence?.checks)) {
    for (const check of evidence.checks) {
      if (check && check.status === 'unknown' && typeof check.id === 'string') out.push(check.id);
    }
  }
  return [...new Set(out)];
}

function unknownIndicator(rules, id, message, reason = 'evaluate_failed') {
  const spec = indicatorSpec(rules, id);
  return {
    id,
    nameZh: typeof spec?.nameZh === 'string' ? spec.nameZh : id,
    level: 'unknown',
    severity: 'unknown',
    value: null,
    unit: typeof spec?.unit === 'string' ? spec.unit : 'count',
    evidence: { reason, missing: ['evaluator'], note: String(message ?? '') },
    phenomenon: `这一格判定时自己崩了（${String(message ?? 'unknown')}）—— 按判不出处理，别当正常。`,
    nextStep: '这是体检自己的 bug：把这条鱼的 --json 输出贴到仓库 issue；在修好之前，这一格不能当正常看。',
    degraded: [{ indicator: id, reason, missing: ['evaluator'] }],
  };
}

/**
 * 兜底鱼：连聚合本身都炸了，也要给出一条「六格全 unknown」的完整鱼，
 * 而不是从报告里消失（消失 = 用户以为没这条鱼）。
 */
function failedFish(rules, pondData, error) {
  const message = String(error?.message ?? 'unknown');
  const indicators = {};
  for (const id of INDICATOR_IDS) indicators[id] = unknownIndicator(rules, id, message, 'aggregate_failed');

  // 连「读一下这条鱼的 id/路径」都可能炸（比如传进来的是个会抛异常的 Proxy）：
  // 那就一个字段都不读，用默认值把鱼凑出来 —— 报告可以难看，不能塌。
  let id = null;
  let kind = 'unknown';
  let kindNameZh = '未识别的鱼';
  let stateRoot = null;
  try {
    const read = isObject(pondData) ? pondData : {};
    id = typeof read.id === 'string' && read.id !== '' ? read.id : null;
    const display = kindDisplayName(rules, read);
    kind = display.kind;
    kindNameZh = display.kindNameZh;
    stateRoot = displayStateRoot(read.rootPath, rules);
  } catch {
    // 用默认值
  }

  return {
    id,
    kind,
    kindNameZh,
    name: kindNameZh,
    stateRoot,
    processes: [],
    indicators,
    severity: 'unknown',
    worstIndicator: INDICATOR_IDS[0],
    headline: buildHeadline(rules, indicators),
    fixes: [indicators[INDICATOR_IDS[0]].nextStep],
    degraded: INDICATOR_IDS.map((id) => ({
      indicator: id,
      reason: 'aggregate_failed',
      missing: ['evaluator'],
    })),
    notes: ['这一条鱼的聚合整段失败了 —— 六格按判不出处理，别当正常。'],
  };
}

/**
 * 判一条鱼。永不抛：任何一格崩了只降级那一格，连聚合本身崩了也会返回一条
 * 六格全 unknown 的鱼（绝不让这条鱼从报告里消失）。
 * @param {object} pondData D3 的 PondRead（或 {read: PondRead}）
 * @param {object} [options]
 * @returns {object} Fish
 */
export function evaluateFish(pondData, options = {}) {
  try {
    return evaluateFishCore(pondData, options);
  } catch (err) {
    return failedFish(resolveRules(isObject(options) ? options : {}), pondData, err);
  }
}

function evaluateFishCore(pondData, options = {}) {
  const opts = isObject(options) ? options : {};
  const read = isObject(pondData) ? (isObject(pondData.read) && !pondData.log ? pondData.read : pondData) : {};
  const rules = resolveRules(opts);
  const now = isFiniteNumber(opts.now) ? opts.now : (isFiniteNumber(read.now) ? read.now : Date.now());

  // system.mjs 用模块级 rules（它自己的 setRules 接口）。这里注入一次、用完还原，
  // 免得一个测试的自定义阈值悄悄影响同一进程里后面的调用。
  const previousRules = getSystemRules();
  let restoreSystemRules = false;
  if (isObject(opts.rules) && previousRules !== opts.rules) {
    try {
      setSystemRules(opts.rules);
      restoreSystemRules = true;
    } catch {
      restoreSystemRules = false;
    }
  }

  let life;
  let system;
  try {
    try {
      life = evaluateLife(read, { ...opts, now });
    } catch (err) {
      life = {
        liveness: unknownIndicator(rules, 'liveness', err?.message),
        rhythm: unknownIndicator(rules, 'rhythm', err?.message),
        throughput: unknownIndicator(rules, 'throughput', err?.message),
        degraded: [],
        notes: [],
      };
    }
    try {
      system = evaluateSystem(read, { tolerant: true, ...opts, now });
    } catch (err) {
      system = {
        health: unknownIndicator(rules, 'health', err?.message),
        deps: unknownIndicator(rules, 'deps', err?.message),
        drift: unknownIndicator(rules, 'drift', err?.message),
        degraded: [],
        notes: [],
      };
    }
  } finally {
    if (restoreSystemRules) {
      try {
        setSystemRules(previousRules);
      } catch {
        // 还原失败也不能把整份报告带走：下一轮 loadRules 还会重新读磁盘
      }
    }
  }

  const indicators = {
    liveness: normalizeIndicator(life.liveness, 'liveness', rules),
    rhythm: normalizeIndicator(life.rhythm, 'rhythm', rules),
    throughput: normalizeIndicator(life.throughput, 'throughput', rules),
    health: normalizeIndicator(system.health, 'health', rules),
    deps: normalizeIndicator(system.deps, 'deps', rules),
    drift: normalizeIndicator(system.drift, 'drift', rules),
  };

  const worst = worstOf(rules, indicators);
  const { kind, kindNameZh } = kindDisplayName(rules, read);
  const stateRoot = displayStateRoot(read.rootPath, rules);
  const short = shortName(read.rootPath, stateRoot);
  // 同一个包可能装在多个 profile 里（例如 web / web-021-…），只报包名会分不清；
  // id 形如 `dsh-plugin:<scope>/<包名>` 时把 scope 挂进显示名。
  const scope = idScope(read.id, rules);
  const name = short ? `${kindNameZh} · ${short}${scope ? `（${scope}）` : ''}` : kindNameZh;

  const degraded = mergeDegraded([
    life.degraded,
    system.degraded,
    readDegradedForUnknown(read, indicators),
  ]);

  // 一致性：只要某格是 unknown，脚注里就必须有它。
  // system.mjs 的 deps 可能因为「有检查项查不出」命中 unknown band，而 bands 给的
  // 档位不会自带 degraded —— 这里补齐，否则总评说「N 项判不出」、脚注却少数一项。
  for (const id of INDICATOR_IDS) {
    const indicator = indicators[id];
    if (indicator.level !== 'unknown') continue;
    if (degraded.some((item) => item.indicator === id)) continue;
    degraded.push({
      indicator: id,
      reason: typeof indicator.evidence?.reason === 'string' ? indicator.evidence.reason : 'unknown',
      missing: Array.isArray(indicator.evidence?.missing) ? [...indicator.evidence.missing] : [],
    });
  }

  const notes = [];
  for (const list of [read.notes, life.notes, system.notes]) {
    if (!Array.isArray(list)) continue;
    for (const note of list) {
      if (typeof note === 'string' && note !== '' && !notes.includes(note)) notes.push(note);
    }
  }

  return {
    id: typeof read.id === 'string' && read.id !== '' ? read.id : null,
    kind,
    kindNameZh,
    name,
    stateRoot,
    processes: Array.isArray(read.processes)
      ? read.processes.filter(isObject).map((item) => ({
        pid: isFiniteNumber(item.pid) ? item.pid : null,
        alive: typeof item.alive === 'boolean' ? item.alive : null,
        startedAtSec: isFiniteNumber(item.startedAtSec) ? item.startedAtSec : null,
      }))
      : [],
    indicators,
    severity: worst.severity,
    worstIndicator: worst.indicator,
    headline: buildHeadline(rules, indicators),
    fixes: collectFixes(rules, indicators, opts),
    degraded,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * 6. 报告
 * ------------------------------------------------------------------ */

/** 输入归一化：四种形状都认，认不出就当「没有鱼」。 */
function normalizePonds(pondData) {
  if (Array.isArray(pondData)) return pondData.filter(isObject);
  if (!isObject(pondData)) return [];
  for (const key of ['ponds', 'fishes', 'reads', 'items', 'pondReads']) {
    if (Array.isArray(pondData[key])) return pondData[key].filter(isObject);
  }
  if (isObject(pondData.read)) return [pondData.read];
  const looksLikeRead = ['id', 'kind', 'rootPath', 'paths', 'sources', 'log', 'dedupe', 'config', 'deps']
    .some((key) => key in pondData);
  return looksLikeRead ? [pondData] : [];
}

function emptySummary() {
  return { fish: 0, ok: 0, watch: 0, bad: 0, unknown: 0 };
}

function countIndicators(rules, fishes) {
  const summary = emptySummary();
  summary.fish = fishes.length;
  const allowed = new Set(Array.isArray(rules?.severity?.values) ? rules.severity.values : ['ok', 'watch', 'bad', 'unknown']);
  for (const fish of fishes) {
    for (const id of INDICATOR_IDS) {
      const severity = fish?.indicators?.[id]?.severity;
      // 未声明的 severity 一律按 unknown 计：宁可多报「判不出」，也不许少报
      if (typeof severity === 'string' && allowed.has(severity)) summary[severity] += 1;
      else summary.unknown += 1;
    }
  }
  return summary;
}

function buildVerdict(rules, summary) {
  const order = fishOrder(rules);
  // SPEC §6.1 的写法：N 条鱼 · X 正常 · Y 要注意 · Z 坏了 · W 判不出
  const base = `${summary.fish} 条鱼 · ${summary.ok} 正常 · ${summary.watch} 要注意 · `
    + `${summary.bad} 坏了 · ${summary.unknown} 判不出`;
  if (summary.fish === 0) {
    const template = rules?.rollup?.missingFishTemplate
      ?? '没扫到任何在跑的鱼。先确认她真的在跑（ps aux | grep -i <她的名字>），再用 --root <她的目录> 指定她的窝。';
    return { verdict: template, note: null, order };
  }
  if (summary.unknown > 0) {
    const template = rules?.rollup?.unknownNoteTemplate ?? '{unknown} 项判不出来 —— 这些不是正常，是没看到。';
    return { verdict: base, note: fill(template, { unknown: summary.unknown }), order };
  }
  return { verdict: base, note: null, order };
}

function buildNextAction(rules, fishes, summary) {
  if (summary.fish === 0) {
    return '先跑 ps aux | grep -i <她的名字> 确认她还在跑；确认在跑，再用 --root <她的目录> 指定她的窝。';
  }
  const target = fishes.find((fish) => Array.isArray(fish.fixes) && fish.fixes.length > 0) ?? null;
  if (!target) {
    // 六格全 ok 的鱼才会有走到这里的可能；这不是「默认健康」，是六格真的都判出了 ok。
    return '六格都判出来了、也没有要修的 —— 继续养，下一次体检再看。';
  }
  const label = target.name || target.id || '这条鱼';
  return `${label}：${target.fixes[0]}`;
}

function buildFootnote(rules, fishes) {
  const all = [];
  for (const fish of fishes) {
    if (!Array.isArray(fish.degraded)) continue;
    for (const item of fish.degraded) all.push(item);
  }
  if (all.length === 0) return { footnote: null, degradedCount: 0 };
  const indicators = [...new Set(all.map((item) => item.indicator))];
  const template = rules?.rollup?.degradedFootnoteTemplate
    ?? '{count} 项数据读不到（{indicators}），这些项目不能当作正常。';
  return {
    footnote: fill(template, { count: all.length, indicators: indicators.join('、') }),
    degradedCount: all.length,
  };
}

function sumSkippedSensitive(ponds) {
  let count = 0;
  for (const item of ponds) {
    // 每一项都单独兜底：传进来的可能是会抛异常的 Proxy，不能让一个坏对象
    // 把「已跳过几个凭证文件」这种小事变成整份报告的崩溃。
    try {
      if (isFiniteNumber(item?.sensitiveSkippedCount) && item.sensitiveSkippedCount > 0) {
        count += item.sensitiveSkippedCount;
      } else if (Array.isArray(item?.skippedSensitive)) {
        count += item.skippedSensitive.length;
      }
    } catch {
      // 读不到就不计
    }
  }
  return count;
}

/**
 * 判一批鱼，出一页报告。
 * @param {object|Array} pondData {ponds:[PondRead]} / 数组 / 单个 PondRead
 * @param {object} [options]
 * @returns {object} Report
 */
export function evaluate(pondData, options = {}) {
  const opts = isObject(options) ? options : {};
  const rules = resolveRules(opts);
  const now = isFiniteNumber(opts.now)
    ? opts.now
    : (isFiniteNumber(pondData?.now) ? pondData.now : Date.now());

  let fishes = [];
  let ponds = [];
  try {
    ponds = normalizePonds(pondData);
  } catch {
    ponds = [];
  }
  for (const pond of ponds) {
    // 逐条兜底：一条鱼出意外不许把整页报告带走（evaluateFish 自己也不会抛，
    // 这里是第二道闸：万一它以后被改坏了，报告仍然完整）
    try {
      fishes.push(evaluateFish(pond, { ...opts, now, rules }));
    } catch (err) {
      fishes.push(failedFish(rules, pond, err));
    }
  }

  // 排序：bad → unknown → watch → ok（rules.rollup.fishOrder），同档按 id 稳定
  const order = fishOrder(rules);
  const sorted = [...fishes].sort((a, b) => {
    const diff = orderIndex(rules, a.severity) - orderIndex(rules, b.severity);
    if (diff !== 0) return diff;
    const left = a.id ?? a.name ?? '';
    const right = b.id ?? b.name ?? '';
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const summary = countIndicators(rules, sorted);
  const { verdict, note } = buildVerdict(rules, summary);
  const { footnote, degradedCount } = buildFootnote(rules, sorted);

  return {
    schemaVersion: isFiniteNumber(rules?.schemaVersion) ? rules.schemaVersion : 1,
    generatedAt: new Date(now).toISOString(),
    host: { platform: process.platform, node: process.versions.node },
    fishes: sorted,
    summary,
    verdict: note ? `${verdict}。${note}` : verdict,
    nextAction: buildNextAction(rules, sorted, summary),
    footnote,
    degradedCount,
    skippedSensitive: { count: sumSkippedSensitive(ponds), names: SENSITIVE_PATH_TOKEN },
  };
}

export default evaluate;
