/**
 * pond-check · D3 收口：读取层聚合（src/read/index.mjs）
 *
 * 职责：把 D3a（日志尾部）与 D3b（状态：判重表 / 配置 / 依赖 / 凭证新鲜度）
 * 拼成 D4 判定器直接能吃的**统一读取结果**。一条鱼一个对象。
 *
 * 这个模块只做三件事，**不做任何档位判定**（那是 D4 的事）：
 *   1. 定位：从 D2 给的窝（rootPath + evidence）里找到「日志 / 配置 / 判重表 /
 *      会话目录 / package.json」这几个具体文件。定位顺序见下。
 *   2. 读：按各自的读取器读（日志异步、状态同步），每路独立降级，互不拖累。
 *   3. 汇总：给出「哪些源没拿到 / 拿到了但读不出来 / 凭证被跳过几个」以及
 *      SPEC §3.1 形状的 degraded（{indicator, reason, missing[]}）。
 *
 * 定位顺序（每一类独立判定，先到先得）：
 *   P0  调用方显式指定 pond.paths.{log,config,dedupe,sessionDir,packageJson}
 *       （= SPEC 探测链 P0 的 --log / --dedupe / --root）
 *   P1  D2b 的 evidence（evidence.logFile / logDir / configFile /
 *       dedupeCandidates[0] / dedupeSqlite[0] / sessionDir），相对 rootPath 解释
 *   P2  在 rootPath 里做**一次**浅列举找惯例名（logs/、config.json、含 dedupe 词的表）
 *   P3  已安装的 DSH 插件（rootPath 形如 profiles/<p>/node_modules/<dep>）：
 *       再把 <p> 那个 profile 目录当第二个探测根 —— 但它的**优先级低于** rootPath，
 *       只是补齐，绝不覆盖 P0/P1 的结论。
 *
 * 为什么可以在这里「再找一次」而不是复用 D2：D2 回答「这里有没有鱼」，D3 回答
 * 「这条鱼的日志/配置/判重表到底是哪个文件」。两者输入相同、目的不同；D2 的
 * evidence 已经有答案时本模块直接用，没有（dsh-plugin 一路）才补一次浅列举。
 *
 * 硬约束：
 *   - 只读：这里只 stat / readdir / 读文件，绝不写、绝不启停进程。
 *   - 凭证零泄漏：任何候选路径在 stat 之前先过名字闸；命中就跳过并只计数，
 *     该名字不进 paths、不进 reason、不进 degraded。日志读取器内部还有第二道闸。
 *   - 永不抛：单条鱼读崩只降级这一条（ok:false + reason），不影响 readAll 其它鱼。
 *   - 关键词单一来源：本层**不定义任何关键词表**，health 关键词一律用 D3a 从
 *     rules.json 读出来的那一份（log.keywords 原样透传），避免两处漂移。
 *   - 预算：单鱼日志读取超时取 rules.json budget.indicatorTimeoutMs（3s）；
 *     文件读取量由 D3a 按 budget.tailBytes 控制（默认即 262144，不在此处改小）。
 *
 * 契约：
 *   await readPond(pond, options?) -> PondRead
 *   await readAll(ponds, options?) -> PondRead[]（顺序与入参一致，永不抛）
 *
 *   pond 来自 D2：{ id, kind, rootPath, evidence, reason? }，可选 paths 覆盖。
 *   options：
 *     now              时间基准（ms），测试注入用
 *     home             凭证新鲜度的家目录（缺省 os.homedir()）
 *     allowExec        是否允许 SPEC §3.6 白名单执行（缺省 false）
 *     logTimeoutMs     单鱼日志读取超时（缺省 rules budget.indicatorTimeoutMs）
 *     maxEntriesCounted / maxDirEntries   透传给判重表 / 浅列举
 *     deps             预计算好的依赖结果（只给**单条鱼**用：其中 homeWritable 是按窝判的，
 *                      不要跨鱼共用，否则「$HOME 可写」会被当成「这条鱼的窝可写」）
 *     credentials      预计算好的凭证新鲜度（整机事实，readAll 内部就是共用这一份）
 *
 *   PondRead = {
 *     id, kind, rootPath, ok,
 *     now,
 *     paths: { log, config, packageJson, dedupe, sessionDir, probeRoots[] },
 *     sources: { log|config|dedupe|sessions: { status, reason, path? } },
 *       status ∈ 'ok' | 'missing' | 'unreadable' | 'skipped_sensitive'
 *     missing: string[],            // 没定位到的源
 *     unreadable: [{source, reason}],
 *     skippedSensitive: string[],   // 被凭证闸挡下的源名（只有 'log'/'config'… 这种槽位名）
 *     sensitiveSkippedCount: number,
 *     log: { ...D3a 结果, mtimeMs, mtimeAt, ageSec },
 *     dedupe: { ...D3b readDedupeStore },
 *     config: { ...D3b readConfigState },
 *     sessions: { dir, fileCount, newestMtimeMs, newestMtimeAt, ageSec, reason, reasonText },
 *     deps: { ...D3b probeDependencies },
 *     credentials: { ...D3b readCredentialFreshness },
 *     degraded: [{indicator, reason, missing[]}],   // SPEC §3.1 形状，仅「源缺失/读不出」的机械映射
 *     notes: string[],              // 定位阶段的人话备注（不含任何凭证名）
 *   }
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readLogTail } from './log.mjs';
import {
  readDedupeStore,
  readConfigState,
  probeDependencies,
  readCredentialFreshness,
} from './state.mjs';
import {
  isSensitiveFileName,
  isSensitiveDirName,
  isCredentialishDirName,
} from '../discover/generic.mjs';

const RULES_URL = new URL('../rules.json', import.meta.url);

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_URL, 'utf8'));
  } catch {
    return null;
  }
}

const RULES = loadRules();

const BUDGET = {
  maxDirEntries: Number(RULES?.budget?.maxDirEntries) > 0 ? Number(RULES.budget.maxDirEntries) : 5000,
  maxEntriesCounted: Number(RULES?.budget?.maxEntriesCounted) > 0
    ? Number(RULES.budget.maxEntriesCounted)
    : 100000,
  indicatorTimeoutMs: Number(RULES?.budget?.indicatorTimeoutMs) > 0
    ? Number(RULES.budget.indicatorTimeoutMs)
    : 3000,
};

/* ------------------------------------------------------------------ *
 * 惯例名：定位层自己的「窝长什么样」
 *
 * 注意：这里出现的是**文件名惯例**，不是 health 关键词表 —— 后者只允许来自
 * rules.json（见文件头「关键词单一来源」）。两者不要混。
 * ------------------------------------------------------------------ */

const CONFIG_FILE_NAMES = new Set([
  'config.json', 'config.yaml', 'config.yml', 'config.toml', 'config.ini',
  'settings.json', 'settings.yaml', 'settings.yml', 'settings.toml',
  'bot.json', 'app.json',
]);
const LOG_DIR_NAMES = new Set(['logs', 'log', 'logfiles', 'logdir']);
const SESSION_DIR_NAMES = new Set(['sessions', 'session', 'records', 'chats']);
const STATE_DIR_NAMES = new Set(['state', 'data', 'store', 'db']);
const DEDUPE_TOKENS = [
  'dedupe', 'processed', 'seen', 'sent', 'posted', 'pushed', 'handled', 'history', 'bvid',
];
const DEDUPE_EXTENSIONS = /\.(json|jsonl|ndjson|txt|db|sqlite|sqlite3)$/i;
const LOG_FILE_EXTENSION = /\.log(\.\d+)?$/i;

/** 一次定位最多 stat 多少个日志候选（防 logs/ 里有几千个历史日志） */
const MAX_LOG_CANDIDATES = 64;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 名字闸：像凭证的就不 stat、不返回。
 *
 * 文件与目录**分开判**（与 SPEC §2.2 / §2.3 的分工一致）：
 *   - 文件走 skipFilePatterns（`*session*`、`*cookie*`…）
 *   - 目录走 skipDirPatterns（`.ssh`、`node_modules`…）
 * 目录不套文件模式，否则 agents 自己的 sessions/ 目录会被 `*session*` 误杀，
 * 存活判定就少了一条退路。
 */
function isSensitiveFileEntry(name) {
  if (typeof name !== 'string' || name === '') return true;
  return isSensitiveFileName(name) || isCredentialishDirName(name);
}

function isSensitiveDirEntry(name, parentName) {
  if (typeof name !== 'string' || name === '') return true;
  return isSensitiveDirName(name, parentName) || isCredentialishDirName(name);
}

/** 整条路径的凭证味（只看名字，不看内容、不 stat）。kind: 'file' | 'dir' */
function isSensitivePath(absPath, kind = 'file') {
  if (typeof absPath !== 'string' || absPath === '') return true;
  const base = path.basename(absPath);
  const parent = path.basename(path.dirname(absPath));
  return kind === 'dir' ? isSensitiveDirEntry(base, parent) : isSensitiveFileEntry(base);
}

function isDedupeName(name) {
  const lower = String(name).toLowerCase();
  if (!DEDUPE_EXTENSIONS.test(lower)) return false;
  return DEDUPE_TOKENS.some((token) => lower.includes(token));
}

async function safeList(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  } catch {
    return null;
  }
}

async function statSafe(target) {
  try {
    const st = await fsp.stat(target);
    return {
      exists: true,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
    };
  } catch {
    return { exists: false, isFile: false, isDirectory: false, size: null, mtimeMs: null };
  }
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function ageSecOrNull(ms, nowMs) {
  return Number.isFinite(ms) ? Math.round((nowMs - ms) / 1000) : null;
}

/* ------------------------------------------------------------------ *
 * 定位：窝 → 具体文件
 * ------------------------------------------------------------------ */

function normalizeOverrides(pond) {
  const out = {};
  const paths = pond && typeof pond.paths === 'object' && pond.paths !== null ? pond.paths : {};
  const pairs = [
    ['log', paths.log ?? pond?.logPath],
    ['config', paths.config ?? pond?.configPath],
    ['dedupe', paths.dedupe ?? pond?.dedupePath],
    ['sessionDir', paths.sessionDir ?? pond?.sessionDir],
    ['packageJson', paths.packageJson ?? pond?.packageJsonPath],
  ];
  for (const [key, value] of pairs) {
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/** 候选根：rootPath 自己，外加「已安装 DSH 插件」推导出的 profile 目录（仅补齐用）。 */
function candidateRoots(rootPath) {
  const roots = [];
  if (typeof rootPath === 'string' && rootPath !== '') roots.push(path.resolve(rootPath));
  const marker = `${path.sep}node_modules${path.sep}`;
  if (typeof rootPath === 'string' && rootPath !== '') {
    const resolved = path.resolve(rootPath);
    const index = resolved.lastIndexOf(marker);
    if (index > 0) {
      const profileDir = resolved.slice(0, index);
      if (!roots.includes(profileDir)) roots.push(profileDir);
    }
  }
  return roots;
}

/** 一次浅列举一个根：把配置 / 日志 / 判重表 / 会话目录的候选都收集起来。 */
async function probeRoot(root, limit) {
  const out = {
    config: [],
    logDirs: [],
    logFiles: [],
    dedupe: [],
    sessionDirs: [],
    packageJson: [],
  };
  const entries = await safeList(root);
  if (!entries) return out;

  let seen = 0;
  for (const entry of entries) {
    if (seen >= limit) break;
    seen += 1;
    const name = entry.name;
    const parentName = path.basename(root);
    if (entry.isDirectory() ? isSensitiveDirEntry(name, parentName) : isSensitiveFileEntry(name)) {
      continue;
    }
    const abs = path.join(root, name);
    const lower = name.toLowerCase();

    if (entry.isDirectory()) {
      if (LOG_DIR_NAMES.has(lower)) {
        out.logDirs.push(abs);
      } else if (SESSION_DIR_NAMES.has(lower)) {
        out.sessionDirs.push(abs);
      } else if (STATE_DIR_NAMES.has(lower)) {
        // 判重表常被塞在 state/ 或 data/ 里：这一层再看一次文件名（不看内容）
        const inner = await safeList(abs);
        if (inner) {
          for (const child of inner) {
            if (!child.isFile()) continue;
            if (isSensitiveFileEntry(child.name)) continue;
            if (isDedupeName(child.name)) out.dedupe.push(path.join(abs, child.name));
          }
        }
      }
      continue;
    }

    if (!entry.isFile()) continue;
    if (lower === 'package.json') {
      out.packageJson.push(abs);
    } else if (CONFIG_FILE_NAMES.has(lower)) {
      out.config.push(abs);
    } else if (isDedupeName(name)) {
      out.dedupe.push(abs);
    } else if (LOG_FILE_EXTENSION.test(lower)) {
      out.logFiles.push(abs);
    }
  }
  return out;
}

/** 从一批日志候选里挑「最近写过的那个」——体检关心的是当前那条日志。 */
async function pickNewestFile(candidates) {
  const picked = [];
  for (const candidate of candidates.slice(0, MAX_LOG_CANDIDATES)) {
    if (isSensitivePath(candidate, 'file')) continue;
    const st = await statSafe(candidate);
    if (!st.isFile) continue;
    picked.push({ path: candidate, mtimeMs: st.mtimeMs });
  }
  if (picked.length === 0) return null;
  picked.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return picked[0];
}

/** 目录里挑最近的日志文件（logs/ 下一层，不递归） */
async function pickNewestLogInDir(dir, limit) {
  const entries = await safeList(dir);
  if (!entries) return null;
  const files = [];
  let seen = 0;
  for (const entry of entries) {
    if (seen >= limit) break;
    seen += 1;
    if (!entry.isFile()) continue;
    if (!LOG_FILE_EXTENSION.test(entry.name.toLowerCase())) continue;
    if (isSensitiveFileEntry(entry.name)) continue;
    files.push(path.join(dir, entry.name));
  }
  return pickNewestFile(files);
}

/**
 * 定位一条鱼的各个源。
 * @returns {Promise<{paths:object, skippedSensitive:string[], notes:string[], probeRoots:string[]}>}
 */
export async function resolvePondSources(pond, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const limit = Number(options.maxDirEntries) > 0 ? Math.floor(options.maxDirEntries) : BUDGET.maxDirEntries;
  const source = pond && typeof pond === 'object' ? pond : {};
  const rootPath = typeof source.rootPath === 'string' && source.rootPath !== ''
    ? path.resolve(source.rootPath)
    : null;

  const paths = {
    log: null,
    config: null,
    packageJson: null,
    dedupe: null,
    sessionDir: null,
    probeRoots: [],
  };
  const skippedSensitive = [];
  const notes = [];

  /** 候选：带来源标记，便于出「为什么是它」的备注（不打印路径本身，只打槽位） */
  const buckets = { log: [], config: [], dedupe: [], sessionDir: [], packageJson: [] };

  // ---- P0 显式指定 ------------------------------------------------------
  const overrides = normalizeOverrides(source);
  for (const key of Object.keys(overrides)) {
    const raw = overrides[key];
    const abs = path.resolve(raw);
    if (isSensitivePath(abs, key === 'sessionDir' ? 'dir' : 'file')) {
      skippedSensitive.push(key);
      notes.push(`${key}：调用方给的路径命中凭证模式，已跳过（不读取、不显示名字）`);
      continue;
    }
    buckets[key].push({ path: abs, from: 'explicit' });
  }

  // ---- P1 D2 的 evidence ------------------------------------------------
  const evidence = source.evidence && typeof source.evidence === 'object' ? source.evidence : {};
  if (rootPath) {
    if (typeof evidence.configFile === 'string' && evidence.configFile !== '') {
      buckets.config.push({ path: path.join(rootPath, evidence.configFile), from: 'evidence' });
    }
    if (typeof evidence.logFile === 'string' && evidence.logFile !== '') {
      buckets.log.push({ path: path.join(rootPath, evidence.logFile), from: 'evidence' });
    }
    if (typeof evidence.logDir === 'string' && evidence.logDir !== '') {
      buckets.log.push({ path: path.join(rootPath, evidence.logDir), from: 'evidence_dir', isDir: true });
    }
    const dedupeRel = Array.isArray(evidence.dedupeCandidates) && evidence.dedupeCandidates.length > 0
      ? evidence.dedupeCandidates[0]
      : (Array.isArray(evidence.dedupeSqlite) && evidence.dedupeSqlite.length > 0 ? evidence.dedupeSqlite[0] : null);
    if (typeof dedupeRel === 'string' && dedupeRel !== '') {
      buckets.dedupe.push({ path: path.join(rootPath, dedupeRel), from: 'evidence' });
    }
    if (typeof evidence.sessionDir === 'string' && evidence.sessionDir !== '') {
      buckets.sessionDir.push({ path: path.join(rootPath, evidence.sessionDir), from: 'evidence' });
    }
  }

  // ---- P2/P3 浅列举补齐 -------------------------------------------------
  const roots = candidateRoots(rootPath);
  paths.probeRoots = roots;
  for (const root of roots) {
    const probed = await probeRoot(root, limit);
    for (const item of probed.config) buckets.config.push({ path: item, from: 'probe' });
    for (const item of probed.logFiles) buckets.log.push({ path: item, from: 'probe' });
    for (const item of probed.logDirs) buckets.log.push({ path: item, from: 'probe_dir', isDir: true });
    for (const item of probed.dedupe) buckets.dedupe.push({ path: item, from: 'probe' });
    for (const item of probed.sessionDirs) buckets.sessionDir.push({ path: item, from: 'probe' });
    for (const item of probed.packageJson) buckets.packageJson.push({ path: item, from: 'probe' });
  }

  // ---- 落地：每一类按顺序验证存在性 -------------------------------------
  // 日志：文件优先，其次目录里挑最新的
  const logFiles = [];
  const logDirs = [];
  for (const candidate of buckets.log) {
    if (isSensitivePath(candidate.path, candidate.isDir ? 'dir' : 'file')) {
      if (!skippedSensitive.includes('log')) skippedSensitive.push('log');
      continue;
    }
    if (candidate.isDir) logDirs.push(candidate.path);
    else logFiles.push(candidate.path);
  }
  let newest = await pickNewestFile(logFiles);
  if (!newest) {
    for (const dir of logDirs) {
      newest = await pickNewestLogInDir(dir, limit);
      if (newest) break;
    }
  }
  if (newest) paths.log = newest.path;

  for (const key of ['config', 'dedupe']) {
    for (const candidate of buckets[key]) {
      if (isSensitivePath(candidate.path, 'file')) {
        if (!skippedSensitive.includes(key)) skippedSensitive.push(key);
        continue;
      }
      const st = await statSafe(candidate.path);
      if (st.isFile) {
        paths[key] = candidate.path;
        break;
      }
    }
  }

  for (const candidate of buckets.sessionDir) {
    if (isSensitivePath(candidate.path, 'dir')) {
      if (!skippedSensitive.includes('sessionDir')) skippedSensitive.push('sessionDir');
      continue;
    }
    const st = await statSafe(candidate.path);
    if (st.isDirectory) {
      paths.sessionDir = candidate.path;
      break;
    }
  }

  for (const candidate of buckets.packageJson) {
    if (isSensitivePath(candidate.path, 'file')) continue;
    const st = await statSafe(candidate.path);
    if (st.isFile) {
      paths.packageJson = candidate.path;
      break;
    }
  }

  // 配置旁边没有 package.json 时，让 readConfigState 走它自己的默认（同目录）
  if (!paths.packageJson && paths.config) {
    const sibling = path.join(path.dirname(paths.config), 'package.json');
    if (!isSensitivePath(sibling, 'file')) {
      const st = await statSafe(sibling);
      if (st.isFile) paths.packageJson = sibling;
    }
  }

  if (!paths.log) {
    notes.push('没定位到日志文件 —— liveness / rhythm / health 只能走退路或判 unknown');
  }

  return { paths, skippedSensitive, notes, nowMs };
}

/* ------------------------------------------------------------------ *
 * 会话目录：只取「最近一次写入」的时间（SPEC liveness 退路 1）
 * ------------------------------------------------------------------ */

async function scanSessions(dir, nowMs, limit) {
  const base = {
    dir,
    fileCount: 0,
    newestMtimeMs: null,
    newestMtimeAt: null,
    ageSec: null,
    reason: null,
    reasonText: null,
  };
  const entries = await safeList(dir);
  if (!entries) {
    return {
      ...base,
      reason: 'not_found',
      reasonText: '会话目录读不到 —— 存活时间只能靠日志或判重表，两样都没有就是 unknown。',
    };
  }

  let newest = null;
  let count = 0;
  let seen = 0;
  for (const entry of entries) {
    if (seen >= limit) break;
    seen += 1;
    if (isSensitiveFileEntry(entry.name)) continue;
    const st = await statSafe(path.join(dir, entry.name));
    if (!st.exists) continue;
    count += 1;
    if (Number.isFinite(st.mtimeMs) && (newest === null || st.mtimeMs > newest)) newest = st.mtimeMs;
  }

  if (count === 0) {
    return {
      ...base,
      reason: 'empty',
      reasonText: '会话目录是空的 —— 她还没写过会话记录，别拿「空」当「最近活动」。',
    };
  }

  return {
    ...base,
    fileCount: count,
    newestMtimeMs: newest,
    newestMtimeAt: isoOrNull(newest),
    ageSec: ageSecOrNull(newest, nowMs),
    reason: newest === null ? 'no_mtime' : null,
    reasonText: newest === null ? '会话文件的时间读不到 —— 这条退路作废。' : null,
  };
}

/* ------------------------------------------------------------------ *
 * degraded：只做「源缺失 → unknown」的机械映射，不判档位
 * ------------------------------------------------------------------ */

function buildDegraded({ log, dedupe, config, sessions, deps }) {
  const degraded = [];

  const logMtime = log && Number.isFinite(log.mtimeMs) ? log.mtimeMs : null;
  const sessionMtime = sessions && Number.isFinite(sessions.newestMtimeMs) ? sessions.newestMtimeMs : null;
  const dedupeMtime = dedupe
    ? (Number.isFinite(dedupe.lastUpdateAt) ? dedupe.lastUpdateAt
      : (Number.isFinite(dedupe.fileMtimeAt) ? dedupe.fileMtimeAt : null))
    : null;

  // liveness：三条退路全没了才彻底 unknown
  if (logMtime === null && sessionMtime === null && dedupeMtime === null) {
    degraded.push({ indicator: 'liveness', reason: 'all_sources_missing', missing: ['log', 'session', 'dedupe'] });
  } else if (logMtime === null) {
    degraded.push({ indicator: 'liveness', reason: 'log_missing', missing: ['log'] });
  }

  // rhythm：要日志里的时间戳
  if (!log || log.ok !== true) {
    degraded.push({ indicator: 'rhythm', reason: log ? (log.reason ?? 'log_unreadable') : 'no_log', missing: ['log'] });
  } else if (!log.lastTimestamp) {
    degraded.push({ indicator: 'rhythm', reason: 'no_timestamps', missing: ['timestamps'] });
  }

  // throughput：要判重表的条目数
  if (!dedupe || dedupe.count === null || dedupe.count === undefined) {
    degraded.push({
      indicator: 'throughput',
      reason: dedupe ? (dedupe.reason ?? 'no_count') : 'no_dedupe',
      missing: ['dedupe'],
    });
  }

  // health：要能读的日志窗口
  if (!log || log.ok !== true) {
    degraded.push({ indicator: 'health', reason: log ? (log.reason ?? 'log_unreadable') : 'no_log', missing: ['log'] });
  } else if (log.hasBinary) {
    // 二进制日志：文本判读不可信，健康只能 unknown
    degraded.push({ indicator: 'health', reason: 'binary_content', missing: [] });
  }
  // 「窗口被截断」不算降级：log.truncated / bytesRead / size 已经如实写了，
  // 再往 degraded 里塞一条只会虚增报告里的「N 项读不到」。

  // deps：只有「探测不出来」才算 unknown；「找不到 ffmpeg」是结论不是降级
  if (deps) {
    const ffmpegUnknown = !deps.ffmpeg || deps.ffmpeg.found === null || deps.ffmpeg.found === undefined;
    const nodeUnknown = !deps.node || deps.node.version === null;
    const diskUnknown = !deps.disk || deps.disk.freeBytes === null;
    const writableUnknown = !deps.homeWritable || deps.homeWritable.writable === null;
    const missing = [];
    if (ffmpegUnknown) missing.push('ffmpeg');
    if (nodeUnknown) missing.push('nodeRuntime');
    if (diskUnknown) missing.push('disk');
    if (writableUnknown) missing.push('homeWritable');
    if (missing.length > 0) {
      degraded.push({ indicator: 'deps', reason: 'probe_unavailable', missing });
    }
  }

  // drift：没有 schemaVersion 就没得比
  if (!config || config.schemaVersion === null || config.schemaVersion === undefined) {
    degraded.push({
      indicator: 'drift',
      reason: config ? (config.reason ?? 'no_version_field') : 'no_config',
      missing: ['schemaVersion'],
    });
  }

  return degraded;
}

/* ------------------------------------------------------------------ *
 * 单鱼读取
 * ------------------------------------------------------------------ */

/** 这些 reason 表示「文件读出来了，只是里面没有这项数据」—— 不算读不出来 */
const NON_FATAL_REASONS = new Set(['no_version_field', 'no_timestamps']);

/**
 * 一个源的状态。
 * @param {string|null} pathValue 定位到的路径（null = 没定位到）
 * @param {string|null} reason    读取器给的失败原因（null = 一切正常）
 */
function sourceStatus(pathValue, reason) {
  if (!pathValue) return { status: 'missing', reason: null };
  if (!reason) return { status: 'ok', reason: null, path: pathValue };
  // 凭证闸挡下的文件：连路径都不给（读取器已把路径换成常量）
  if (reason === 'sensitive_skipped' || reason === 'sensitive_file') {
    return { status: 'skipped_sensitive', reason };
  }
  if (NON_FATAL_REASONS.has(reason)) return { status: 'ok', reason };
  return { status: 'unreadable', reason };
}

async function readPondInternal(pond, options, ctx) {
  const identity = pond && typeof pond === 'object' ? pond : {};
  const id = typeof identity.id === 'string' ? identity.id : null;
  const kind = typeof identity.kind === 'string' ? identity.kind : 'unknown';
  const rootPath = typeof identity.rootPath === 'string' ? identity.rootPath : null;

  const resolved = await resolvePondSources(identity, options);
  const { paths } = resolved;

  // ---- 日志（D3a，异步）------------------------------------------------
  let log = null;
  if (paths.log) {
    const raw = await readLogTail(paths.log, { timeoutMs: ctx.logTimeoutMs });
    const st = await statSafe(paths.log);
    log = {
      ...raw,
      path: raw.path ?? paths.log,
      mtimeMs: st.mtimeMs,
      mtimeAt: isoOrNull(st.mtimeMs),
      ageSec: ageSecOrNull(st.mtimeMs, ctx.nowMs),
    };
  }

  // ---- 判重表 / 配置（D3b，同步、自带降级）------------------------------
  const dedupe = readDedupeStore(paths.dedupe ?? '', {
    now: ctx.nowMs,
    maxEntriesCounted: ctx.maxEntriesCounted,
  });
  const config = readConfigState(paths.config ?? '', {
    packageJsonPath: paths.packageJson ?? undefined,
  });

  // ---- 会话目录 --------------------------------------------------------
  const sessions = paths.sessionDir
    ? await scanSessions(paths.sessionDir, ctx.nowMs, ctx.maxDirEntries)
    : {
      dir: null,
      fileCount: 0,
      newestMtimeMs: null,
      newestMtimeAt: null,
      ageSec: null,
      reason: 'not_found',
      reasonText: '没找到会话目录 —— 存活时间只能靠日志或判重表。',
    };

  // ---- 依赖（按这条鱼的窝算）/ 凭证（整机共用一份）-----------------------
  const deps = ctx.deps ?? probeDependencies({ home: rootPath ?? undefined, allowExec: ctx.allowExec });
  const credentials = ctx.credentials ?? readCredentialFreshness({ home: ctx.home, now: ctx.nowMs });

  const sources = {
    log: sourceStatus(paths.log, log ? (log.ok === true ? null : (log.reason ?? 'read_error')) : null),
    config: sourceStatus(paths.config, config.reason ?? null),
    dedupe: sourceStatus(paths.dedupe, dedupe.reason ?? null),
    sessions: sourceStatus(paths.sessionDir, sessions.reason ?? null),
  };

  const missing = Object.entries(sources)
    .filter(([, value]) => value.status === 'missing')
    .map(([key]) => key);
  const unreadable = Object.entries(sources)
    .filter(([, value]) => value.status === 'unreadable')
    .map(([key, value]) => ({ source: key, reason: value.reason }));

  // 定位阶段被凭证闸挡下的槽位 + 各源内部跳过的凭证文件数（只有计数，没有名字）
  const skippedSensitive = [...new Set(resolved.skippedSensitive ?? [])];
  const sensitiveSkippedCount =
    (typeof identity.evidence?.sensitiveSkipped === 'number' ? identity.evidence.sensitiveSkipped : 0) +
    (log && typeof log.sensitiveSkipped === 'number' ? log.sensitiveSkipped : 0);

  const degraded = buildDegraded({ log, dedupe, config, sessions, deps });

  return {
    id,
    kind,
    rootPath,
    ok: true,
    now: ctx.nowMs,
    paths: {
      log: paths.log,
      config: paths.config,
      packageJson: paths.packageJson,
      dedupe: paths.dedupe,
      sessionDir: paths.sessionDir,
      probeRoots: paths.probeRoots ?? [],
    },
    sources,
    missing,
    unreadable,
    skippedSensitive,
    sensitiveSkippedCount,
    log,
    dedupe,
    config,
    sessions,
    deps,
    credentials,
    degraded,
    notes: resolved.notes ?? [],
  };
}

/**
 * 读一条鱼。
 * @param {object} pond D2 的 pond 描述（{id, kind, rootPath, evidence, paths?}）
 * @param {object} [options]
 * @returns {Promise<object>} PondRead；永不抛
 */
export async function readPond(pond, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const ctx = {
    nowMs: Number.isFinite(opts.now) ? opts.now : Date.now(),
    home: typeof opts.home === 'string' && opts.home !== '' ? opts.home : os.homedir(),
    allowExec: opts.allowExec === true,
    logTimeoutMs: Number(opts.logTimeoutMs) > 0 ? Number(opts.logTimeoutMs) : BUDGET.indicatorTimeoutMs,
    maxDirEntries: Number(opts.maxDirEntries) > 0 ? Math.floor(opts.maxDirEntries) : BUDGET.maxDirEntries,
    maxEntriesCounted: Number(opts.maxEntriesCounted) > 0
      ? Math.floor(opts.maxEntriesCounted)
      : BUDGET.maxEntriesCounted,
    deps: opts.deps && typeof opts.deps === 'object' ? opts.deps : null,
    credentials: opts.credentials && typeof opts.credentials === 'object' ? opts.credentials : null,
  };

  try {
    return await readPondInternal(pond, opts, ctx);
  } catch {
    // 单条鱼读崩：降级这一条，绝不把整份体检带走
    return {
      id: typeof pond?.id === 'string' ? pond.id : null,
      kind: typeof pond?.kind === 'string' ? pond.kind : 'unknown',
      rootPath: typeof pond?.rootPath === 'string' ? pond.rootPath : null,
      ok: false,
      reason: 'read_failed',
      reasonText: '这条鱼的读取整段失败了 —— 其它鱼照常体检，它按 unknown 处理，别当正常。',
      now: ctx.nowMs,
      paths: { log: null, config: null, packageJson: null, dedupe: null, sessionDir: null, probeRoots: [] },
      sources: {
        log: { status: 'missing', reason: null },
        config: { status: 'missing', reason: null },
        dedupe: { status: 'missing', reason: null },
        sessions: { status: 'missing', reason: null },
      },
      missing: ['log', 'config', 'dedupe', 'sessions'],
      unreadable: [],
      skippedSensitive: [],
      sensitiveSkippedCount: 0,
      log: null,
      dedupe: null,
      config: null,
      sessions: null,
      deps: null,
      credentials: null,
      degraded: [
        { indicator: 'liveness', reason: 'all_sources_missing', missing: ['log', 'session', 'dedupe'] },
        { indicator: 'health', reason: 'no_log', missing: ['log'] },
      ],
      notes: [],
    };
  }
}

/**
 * 读一批鱼。顺序与入参一致；单条失败不影响其它。
 * @param {Array<object>} ponds
 * @param {object} [options]
 * @returns {Promise<Array<object>>} 与 ponds 等长的 PondRead 数组
 */
export async function readAll(ponds, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const list = Array.isArray(ponds) ? ponds : [];
  const nowMs = Number.isFinite(opts.now) ? opts.now : Date.now();
  const home = typeof opts.home === 'string' && opts.home !== '' ? opts.home : os.homedir();

  // 凭证新鲜度是「整机事实」（knownCredentialPaths 都相对 $HOME），一批共用一份。
  // 依赖四件套**不能共用**：其中 homeWritable 的检查对象是每条鱼自己的窝（stateRoot），
  // 共用会把「$HOME 可写」当成「这条鱼的窝可写」—— 那是假通过。
  let credentials = null;
  if (!(opts.credentials && typeof opts.credentials === 'object')) {
    try {
      credentials = readCredentialFreshness({ home, now: nowMs });
    } catch {
      credentials = null;
    }
  }

  const out = [];
  for (const pond of list) {
    // 顺序读取：鱼数量是个位数，省下并发控制与不确定性
    const result = await readPond(pond, { ...opts, now: nowMs, home, credentials });
    out.push(result);
  }
  return out;
}

export default readPond;
