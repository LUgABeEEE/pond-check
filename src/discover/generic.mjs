/**
 * pond-check · D2b 通用目录探测（P2/P3 兜底）
 *
 * 职责：不依赖进程表，光靠「目录长什么样」找出机器上的鱼窝。
 *   - $DSH_HOME 下一层子目录 → 家目录型鱼（kind = 'dsh-home'）
 *   - 用户 home 下一层子目录 → 独立进程型鱼（kind = 'standalone'）
 *   - 认不出但特征像鱼的 → kind = 'unknown' + reason（不猜、不硬塞进某个 kind）
 *
 * 硬约束（来自 docs/SPEC.md §2 / §3）：
 *   1. 只扫一层：发现层绝不递归。对候选目录只做「一次浅列举」拿特征，不进入孙目录
 *      （唯一例外：state/data/store 这类状态子目录里再看一层文件名找判重表）。
 *   2. 不读文件内容：本模块只 readdir，从不 open/stat 任何文件。
 *      —— 因此也不会拿到 mtime，不会因为「跳过」与否产生时间侧信道。
 *   3. 凭证类文件名连「进返回值」都不允许：命中 rules.json 的 skipFilePatterns /
 *      skipDirPatterns 之后，名字立刻丢弃，只在 evidence.sensitiveSkipped 里留一个聚合计数。
 *   4. 目录不存在 / 没权限 / 任何异常 → 返回空数组，绝不抛。
 *
 * 导出：
 *   discoverGeneric(options) -> Promise<Fish[]>
 *     options.dshHome       string|null  默认 process.env.DSH_HOME，否则 ~/.dsh
 *     options.home          string|null  默认 os.homedir()
 *     options.maxDirEntries number       默认取 rules.json budget.maxDirEntries（5000）
 *     options.skipFilePatterns / skipDirPatterns   覆盖 rules.json 里的模式（测试用）
 *
 * 判定阈值（为什么有的目录报、有的不报）：
 *   - $DSH_HOME 下：目录名命中鱼种命名（bili-* / *-duty / *-whale / *-pond / *-fish /
 *     *-keeper）→ kind='dsh-home'，名字就是证据，里面空着也照报。
 *   - 用户 home 下：配置文件 + 日志 + 判重表 三件套齐全 → kind='standalone'。
 *   - 名字不认识的目录：必须「≥2 类特征 + 有账本（判重表或会话记录）」才报 unknown。
 *     只有配置 + 日志的目录多半是插件缓存，报出来只会把报告里的「判不出来」变成噪音。
 *     名字带鱼种指纹的目录不受这条限制 —— 名字本身就是认出来的证据。
 *   - 凭证类目录（credentials/ token-cache/ …）连 stateRoot 都不当，直接跳过。
 *     文件按 skipFilePatterns 判、目录按 skipDirPatterns 判：目录不套文件模式，
 *     否则 agents 自己的 sessions/ 会被当成凭证目录误杀。
 *
 * 返回项形状（严格四键 + unknown 时的 reason）：
 *   {
 *     id:       'dsh-home:bili-duty' | 'standalone:astrbot' | 'unknown:weird-dir',
 *     kind:     'dsh-home' | 'standalone' | 'unknown',
 *     rootPath: '/abs/path/to/窝',
 *     reason:   string,            // 仅 kind==='unknown'
 *     evidence: {
 *       rootKind, signals[], strength, configFile, logDir, logFile, logFileCount,
 *       sessionDir, dedupeCandidates[], dedupeSqlite[], nameMatch, reasonText,
 *       realPath, sensitiveSkipped, truncated, entries
 *     }
 *   }
 *   路径字段一律是「相对 rootPath 的短路径」，不把绝对家目录结构写进报告。
 */

import { readdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ------------------------------------------------------------------ *
 * 规则来源：src/rules.json（唯一真相），读不到时用内置兜底清单
 * ------------------------------------------------------------------ */

const RULES_URL = new URL('../rules.json', import.meta.url);

/** rules.json 读不到时的兜底（只覆盖「必须挡住」的凭证类别，宁可多挡） */
const FALLBACK_FILE_PATTERNS = [
  '*credential*', '*cred*', '*secret*', '*cookie*', '*token*',
  '*session*', '*auth*', '*oauth*', '*password*', '*passwd*',
  '.env', '.env.*', '*.env', '*.env.*',
  '*.pem', '*.key', '*.p8', '*.p12', '*.pfx', '*.ppk',
  'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*',
  'authorized_keys', 'known_hosts', '.netrc', '.npmrc', '.pypirc',
  '*.kdbx', '*keychain*', '*keyring*', '*onebot11*',
  '*account*.json', '*login*.json', '*service-account*.json',
];

const FALLBACK_DIR_PATTERNS = [
  '.ssh', '.gnupg', '.git', '.aws', '.docker', '.password-store',
  '.pki', 'keyrings', 'node_modules', '.cache',
];

function loadRules() {
  try {
    return JSON.parse(readFileSync(RULES_URL, 'utf8'));
  } catch {
    return null;
  }
}

const RULES = loadRules();

/** 命中凭证判定后，路径在进入任何数据结构之前就被替换成这个常量（SPEC §2.4 第一道闸） */
export const SENSITIVE_PATH_TOKEN =
  RULES?.credentials?.sensitivePathToken ?? '[凭证文件已跳过]';

const RULE_FILE_PATTERNS = pickPatterns(RULES?.credentials?.skipFilePatterns, FALLBACK_FILE_PATTERNS);
const RULE_DIR_PATTERNS = pickPatterns(RULES?.credentials?.skipDirPatterns, FALLBACK_DIR_PATTERNS);
const RULE_MAX_DIR_ENTRIES = Number(RULES?.budget?.maxDirEntries) > 0
  ? Number(RULES.budget.maxDirEntries)
  : 5000;

function pickPatterns(fromRules, fallback) {
  if (!Array.isArray(fromRules) || fromRules.length === 0) return fallback.slice();
  const seen = new Set();
  const out = [];
  for (const p of [...fromRules, ...fallback]) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 通配符匹配（大小写不敏感，* = 任意长度，? = 单字符）
 * —— SPEC §2.2 的匹配口径，逐字对齐，不引入 minimatch 之类的依赖
 * ------------------------------------------------------------------ */

const REGEX_CACHE = new Map();

function wildcardToRegExp(pattern) {
  let re = REGEX_CACHE.get(pattern);
  if (re) return re;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  re = new RegExp(`^${body}$`, 'i');
  REGEX_CACHE.set(pattern, re);
  return re;
}

function matchesAnyPattern(candidates, patterns) {
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const name = raw.toLowerCase();
    for (const pattern of patterns) {
      if (wildcardToRegExp(pattern).test(name)) return true;
    }
  }
  return false;
}

/**
 * 文件名是否属于「不读、也不许出现名字」的凭证类。
 * 只看名字，不看内容，不 stat。
 * @param {string} name 纯文件名（不含目录）
 */
export function isSensitiveFileName(name, patterns = RULE_FILE_PATTERNS) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return matchesAnyPattern([name], patterns);
}

/**
 * 目录名是否属于不向下遍历的敏感目录。
 * @param {string} name 目录名
 * @param {string} [parentName] 父目录名，用于匹配 '.config/gcloud' 这类两段式模式
 */
export function isSensitiveDirName(name, parentName, patterns = RULE_DIR_PATTERNS) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const candidates = [name];
  if (typeof parentName === 'string' && parentName.length > 0) {
    candidates.push(`${parentName}/${name}`);
  }
  return matchesAnyPattern(candidates, patterns);
}

/**
 * 目录名的「凭证味」判定：只挡那些一眼就是装凭证的目录（credentials/、token-cache/），
 * 不套 §2.2 的整张文件模式表 —— 否则 agents 自己的 sessions/ 目录会被误杀。
 * @param {string} name
 */
export function isCredentialishDirName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const lower = name.toLowerCase();
  if (lower.includes('credential') || lower.includes('apikey') ||
      lower.includes('api-key') || lower.includes('private-key')) {
    return true;
  }
  const parts = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const words = new Set([
    'secret', 'secrets', 'token', 'tokens', 'cookie', 'cookies',
    'password', 'passwd', 'auth', 'oauth', 'oauth2', 'bearer',
    'keychain', 'keyring', 'keystore',
  ]);
  return parts.some((part) => words.has(part));
}

/* ------------------------------------------------------------------ *
 * 特征词典：鱼窝长什么样
 * ------------------------------------------------------------------ */

/** 家目录型鱼的命名规则（SPEC：bili-duty / bili-whale / bili-pond …） */
const FISH_NAME_SUFFIXES = ['-duty', '-whale', '-pond', '-fish', '-keeper'];
const FISH_NAME_PREFIXES = ['bili-', 'bilibili-', 'pond-', 'fish-'];
const FISH_NAME_EXACT = ['bili-duty', 'bili-whale', 'bili-pond'];

/** 配置文件（组合特征之一） */
const CONFIG_FILE_NAMES = new Set([
  'config.json', 'config.yaml', 'config.yml', 'config.toml', 'config.ini',
  'settings.json', 'settings.yaml', 'settings.yml', 'settings.toml',
  'bot.json', 'app.json',
]);

/** 日志目录（组合特征之二） */
const LOG_DIR_NAMES = new Set(['logs', 'log', 'logfiles', 'logdir']);

/** 会话/记录目录（加分项，不是必需项） */
const SESSION_DIR_NAMES = new Set(['sessions', 'session', 'records', 'chats', 'history']);

/** 状态子目录：允许在它里面再看一层文件名，用来找判重表 */
const STATE_DIR_NAMES = new Set(['state', 'data', 'store', 'db']);

/** 判重表命名 token（组合特征之三）——SPEC §1：记录「我已经处理过什么」的本地文件 */
const DEDUPE_TOKENS = [
  'dedupe', 'processed', 'seen', 'sent', 'posted', 'pushed',
  'handled', 'history', 'bvid',
];
const DEDUPE_EXTENSIONS = /\.(json|jsonl|ndjson|txt|db|sqlite|sqlite3)$/i;
const SQLITE_EXTENSIONS = /\.(db|sqlite|sqlite3)$/i;

/**
 * 目录名是否长得像家目录型鱼。
 * @returns {{rule:'exact'|'suffix'|'prefix', pattern:string}|null}
 */
export function matchFishName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const normalized = name.toLowerCase().replace(/_/g, '-');
  if (FISH_NAME_EXACT.includes(normalized)) {
    return { rule: 'exact', pattern: normalized };
  }
  for (const suffix of FISH_NAME_SUFFIXES) {
    if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
      return { rule: 'suffix', pattern: suffix };
    }
  }
  for (const prefix of FISH_NAME_PREFIXES) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) {
      return { rule: 'prefix', pattern: prefix };
    }
  }
  return null;
}

function isConfigFileName(name) {
  return CONFIG_FILE_NAMES.has(name.toLowerCase());
}

function isLogFileName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.log') || /\.log\.\d+$/.test(lower);
}

function isDedupeFileName(name) {
  const lower = name.toLowerCase();
  if (!DEDUPE_EXTENSIONS.test(lower)) return false;
  return DEDUPE_TOKENS.some((token) => lower.includes(token));
}

function isSqliteFileName(name) {
  return SQLITE_EXTENSIONS.test(name.toLowerCase());
}

/* ------------------------------------------------------------------ *
 * 浅列举：对单个候选目录取一次特征
 * ------------------------------------------------------------------ */

/**
 * 只 readdir，不 open 任何文件。
 * 失败（不存在 / 无权限 / 不是目录）返回 null，由上层当成「没有证据」处理。
 */
async function listDirSafe(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // 排序只为让结果稳定（同一台机器多次扫描得到同样的顺序）
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  } catch {
    return null;
  }
}

async function realpathSafe(dir) {
  try {
    return await realpath(dir);
  } catch {
    return null;
  }
}

function countSignals(signals) {
  const required = ['config', 'log', 'dedupe'];
  return required.filter((key) => signals.includes(key)).length;
}

/**
 * 「账本」证据：判重表或会话记录。
 * 一条鱼必然有个「我干过什么」的账本；只有配置 + 日志的目录更像插件缓存，
 * 把它报成「判不出来」只会让报告里的 W 变成噪音。
 */
function hasLedger(evidence) {
  return evidence.signals.includes('dedupe') || evidence.signals.includes('session');
}

/**
 * 对一个候选窝做「一次浅列举」，抽出组合特征。
 * @param {string} dir 候选目录绝对路径
 * @param {{maxDirEntries:number, skipFilePatterns:string[], skipDirPatterns:string[]}} ctx
 */
async function inspectCandidate(dir, ctx) {
  const entries = await listDirSafe(dir);
  if (!entries) return null;

  const evidence = {
    signals: [],
    strength: 0,
    configFile: null,
    logDir: null,
    logFile: null,
    logFileCount: 0,
    sessionDir: null,
    dedupeCandidates: [],
    dedupeSqlite: [],
    sensitiveSkipped: 0,
    truncated: false,
    entries: entries.length,
  };

  let inspected = 0;
  for (const entry of entries) {
    if (inspected >= ctx.maxDirEntries) {
      evidence.truncated = true;
      evidence.entries = inspected;
      break;
    }
    inspected += 1;
    const name = entry.name;

    // 第一道闸：凭证类名字在这里就被丢掉，绝不进入 evidence 的任何字段。
    // 文件看 skipFilePatterns（SPEC §2.2），目录看 skipDirPatterns（§2.3）——
    // 目录不套文件模式，否则 agents 自己的 sessions/ 目录会被误判成凭证目录。
    if (entry.isDirectory()) {
      if (isSensitiveDirName(name, path.basename(dir), ctx.skipDirPatterns) ||
          isCredentialishDirName(name)) {
        evidence.sensitiveSkipped += 1;
        continue;
      }
    } else if (isSensitiveFileName(name, ctx.skipFilePatterns)) {
      evidence.sensitiveSkipped += 1;
      continue;
    }

    const lower = name.toLowerCase();

    if (entry.isDirectory()) {
      if (LOG_DIR_NAMES.has(lower)) {
        if (!evidence.logDir) evidence.logDir = name;
        if (!evidence.signals.includes('log')) evidence.signals.push('log');
        continue;
      }
      if (SESSION_DIR_NAMES.has(lower)) {
        if (!evidence.sessionDir) evidence.sessionDir = name;
        if (!evidence.signals.includes('session')) evidence.signals.push('session');
        continue;
      }
      if (STATE_DIR_NAMES.has(lower)) {
        // 唯一一处「多看一层」：判重表常被塞在 state/ 或 data/ 里
        const stateAbs = path.join(dir, name);
        const stateEntries = await listDirSafe(stateAbs);
        if (stateEntries) {
          let stateInspected = 0;
          for (const inner of stateEntries) {
            if (stateInspected >= ctx.maxDirEntries) {
              evidence.truncated = true;
              break;
            }
            stateInspected += 1;
            if (inner.isDirectory()) continue;
            const innerName = inner.name;
            if (isSensitiveFileName(innerName, ctx.skipFilePatterns)) {
              evidence.sensitiveSkipped += 1;
              continue;
            }
            if (isDedupeFileName(innerName)) {
              const rel = `${name}/${innerName}`;
              if (isSqliteFileName(innerName)) evidence.dedupeSqlite.push(rel);
              else evidence.dedupeCandidates.push(rel);
              if (!evidence.signals.includes('dedupe')) evidence.signals.push('dedupe');
            }
          }
        }
        continue;
      }
      continue;
    }

    if (!entry.isFile()) continue;

    if (isConfigFileName(name)) {
      if (!evidence.configFile) evidence.configFile = name;
      if (!evidence.signals.includes('config')) evidence.signals.push('config');
      continue;
    }
    if (isDedupeFileName(name)) {
      if (isSqliteFileName(name)) evidence.dedupeSqlite.push(name);
      else evidence.dedupeCandidates.push(name);
      if (!evidence.signals.includes('dedupe')) evidence.signals.push('dedupe');
      continue;
    }
    if (isLogFileName(name)) {
      evidence.logFileCount += 1;
      if (!evidence.logFile) evidence.logFile = name;
      if (!evidence.signals.includes('log')) evidence.signals.push('log');
      continue;
    }
    if (lower === 'package.json') {
      if (!evidence.signals.includes('manifest')) evidence.signals.push('manifest');
    }
  }

  // 日志目录里有没有真的 .log 文件 —— 有日志目录但空着，不能当「有日志」
  if (evidence.logDir && evidence.logFileCount === 0) {
    const logAns = await listDirSafe(path.join(dir, evidence.logDir));
    if (logAns) {
      let logInspected = 0;
      for (const inner of logAns) {
        if (logInspected >= ctx.maxDirEntries) {
          evidence.truncated = true;
          break;
        }
        logInspected += 1;
        if (inner.isDirectory()) continue;
        if (isSensitiveFileName(inner.name, ctx.skipFilePatterns)) {
          evidence.sensitiveSkipped += 1;
          continue;
        }
        if (isLogFileName(inner.name)) {
          evidence.logFileCount += 1;
          if (!evidence.logFile) evidence.logFile = `${evidence.logDir}/${inner.name}`;
        }
      }
    }
    if (evidence.logFileCount === 0) {
      // 空日志目录不算「有日志」，但保留目录名供下游参考
      evidence.signals = evidence.signals.filter((s) => s !== 'log');
    }
  }

  evidence.strength = countSignals(evidence.signals);
  return evidence;
}

/* ------------------------------------------------------------------ *
 * 缺陷描述：为什么判不出（人话 + 机器可读 reason）
 * ------------------------------------------------------------------ */

const REASON_TEXT = {
  dsh_home_child_unrecognised:
    '这个目录在 $DSH_HOME 下、里面也凑得出两样以上特征，但目录名不在已知鱼种里，不敢替你认。',
  missing_dedupe:
    '找到了配置和日志，但没找到判重表 —— 没法判断她到底干了多少活。',
  missing_log:
    '找到了配置和判重表，但没有日志 —— 出错时看不到任何线索。',
  missing_config:
    '找到了日志和判重表，但没有配置文件 —— 不知道她按什么参数在跑。',
  name_only_no_evidence:
    '目录名看起来像鱼窝，但里面没有配置、日志、判重表 —— 也可能只是个空壳。',
  no_evidence:
    '目录里没找到任何能证明「这里有鱼在跑」的痕迹。',
};

function missingList(evidence) {
  const missing = [];
  if (!evidence.configFile) missing.push('config');
  if (!evidence.logDir && !evidence.logFile) missing.push('log');
  if (evidence.dedupeCandidates.length === 0 && evidence.dedupeSqlite.length === 0) {
    missing.push('dedupe');
  }
  return missing;
}

function pickReason(evidence) {
  const missing = missingList(evidence);
  if (missing.length === 1) return `missing_${missing[0]}`;
  if (missing.length === 2) return `missing_${missing[0]}_${missing[1]}`;
  return 'no_evidence';
}

const MISSING_LABELS = { config: '配置文件', log: '日志', dedupe: '判重表' };

/** reason 的「人话」版本：固定文案优先，组合缺失时按缺的项拼一句 */
function reasonTextFor(reason, evidence) {
  const fixed = REASON_TEXT[reason];
  if (fixed) return fixed;
  const missing = missingList(evidence).map((key) => MISSING_LABELS[key] ?? key);
  if (missing.length === 0) return '特征没凑齐，不敢替你认这条鱼。';
  return `缺 ${missing.join('、')} —— 这几样不齐，六项指标判不全，不敢说她正常。`;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function normalizeOptions(options) {
  const raw = options && typeof options === 'object' ? options : {};
  const home = typeof raw.home === 'string' && raw.home.length > 0
    ? path.resolve(raw.home)
    : os.homedir();

  let dshHome = null;
  if (typeof raw.dshHome === 'string' && raw.dshHome.length > 0) {
    dshHome = path.resolve(raw.dshHome);
  } else if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    dshHome = path.resolve(process.env.DSH_HOME);
  } else {
    dshHome = path.join(home, '.dsh');
  }

  const maxDirEntries = Number(raw.maxDirEntries) > 0
    ? Math.floor(Number(raw.maxDirEntries))
    : RULE_MAX_DIR_ENTRIES;

  return {
    home,
    dshHome,
    maxDirEntries,
    skipFilePatterns: Array.isArray(raw.skipFilePatterns)
      ? pickPatterns(raw.skipFilePatterns, [])
      : RULE_FILE_PATTERNS,
    skipDirPatterns: Array.isArray(raw.skipDirPatterns)
      ? pickPatterns(raw.skipDirPatterns, [])
      : RULE_DIR_PATTERNS,
  };
}

function makeFish({ kind, name, rootPath, evidence, reason }) {
  const idName = String(name ?? path.basename(rootPath)).toLowerCase().replace(/\s+/g, '-');
  const fish = {
    id: `${kind}:${idName}`,
    kind,
    rootPath,
    evidence,
  };
  if (reason) {
    fish.reason = reason;
    fish.evidence.reason = reason;
    fish.evidence.reasonText = reasonTextFor(reason, fish.evidence);
  }
  return fish;
}

function pushUnique(out, seenRoots, fish) {
  const key = fish.evidence?.realPath ?? fish.rootPath;
  if (seenRoots.has(key)) return false;
  seenRoots.add(key);
  out.push(fish);
  return true;
}

async function scanDshHome(ctx, out, seenRoots) {
  if (!ctx.dshHome) return;
  const entries = await listDirSafe(ctx.dshHome);
  if (!entries) return; // 目录不存在 → 什么也不报（自动降级到 home 扫描 / P4）

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;

    // 凭证类目录：连名字都不进结果（这里是要被当成 stateRoot 打印出去的，闸门比内部条目更紧）
    if (isSensitiveDirName(name, path.basename(ctx.dshHome), ctx.skipDirPatterns) ||
        isCredentialishDirName(name)) {
      continue;
    }

    const rootPath = path.join(ctx.dshHome, name);
    const evidence = await inspectCandidate(rootPath, ctx);
    if (!evidence) continue;

    evidence.rootKind = 'dsh-home';
    evidence.realPath = await realpathSafe(rootPath);
    evidence.nameMatch = matchFishName(name);

    if (evidence.nameMatch) {
      pushUnique(out, seenRoots, makeFish({
        kind: 'dsh-home',
        name,
        rootPath,
        evidence,
      }));
      continue;
    }

    // 名字不认识，但凑得出 2 类以上特征、而且有账本 → 老实报 unknown，不猜成某条鱼
    if (evidence.strength >= 2 && hasLedger(evidence)) {
      pushUnique(out, seenRoots, makeFish({
        kind: 'unknown',
        name,
        rootPath,
        evidence,
        reason: 'dsh_home_child_unrecognised',
      }));
    }
  }
}

async function scanHome(ctx, out, seenRoots) {
  const entries = await listDirSafe(ctx.home);
  if (!entries) return;

  const dshHomeReal = await realpathSafe(ctx.dshHome);
  const parentName = path.basename(ctx.home);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const rootPath = path.join(ctx.home, name);

    // $DSH_HOME 本身归 D2a 管，这里不重复报
    if (path.resolve(rootPath) === path.resolve(ctx.dshHome)) continue;
    if (dshHomeReal && (await realpathSafe(rootPath)) === dshHomeReal) continue;

    if (isSensitiveDirName(name, parentName, ctx.skipDirPatterns) ||
        isCredentialishDirName(name)) {
      continue;
    }

    const evidence = await inspectCandidate(rootPath, ctx);
    if (!evidence) continue;

    evidence.rootKind = 'home';
    evidence.realPath = await realpathSafe(rootPath);
    evidence.nameMatch = matchFishName(name);

    // 组合特征齐全（config.json + 日志目录 + 判重表）→ 独立进程型
    if (evidence.strength >= 3) {
      pushUnique(out, seenRoots, makeFish({
        kind: 'standalone',
        name,
        rootPath,
        evidence,
      }));
      continue;
    }

    // 名字带鱼种指纹：即便凑不齐也报出来（名字本身就是认出来的证据）
    if (evidence.nameMatch) {
      pushUnique(out, seenRoots, makeFish({
        kind: 'unknown',
        name,
        rootPath,
        evidence,
        reason: evidence.strength === 0 ? 'name_only_no_evidence' : pickReason(evidence),
      }));
      continue;
    }

    // 名字不认识：只有「两样以上特征 + 有账本」才值得占报告一行，其余是噪音
    if (evidence.strength >= 2 && hasLedger(evidence)) {
      pushUnique(out, seenRoots, makeFish({
        kind: 'unknown',
        name,
        rootPath,
        evidence,
        reason: pickReason(evidence),
      }));
    }
    // 其余（0 特征、名字也不像）静默跳过 —— 家目录里那种目录有几百个，报出来只是噪音
  }
}

/**
 * 通用目录探测入口。
 * @param {object} [options]
 * @returns {Promise<Array>} 找不到就返回 []；任何异常都退化成 []，绝不抛。
 */
export async function discoverGeneric(options = {}) {
  const out = [];
  const seenRoots = new Set();
  try {
    const ctx = normalizeOptions(options);
    await scanDshHome(ctx, out, seenRoots);
    await scanHome(ctx, out, seenRoots);
    return out;
  } catch {
    // 只看目录、不读内容，任何意外都不值得让整次体检失败
    return out;
  }
}

export default discoverGeneric;
