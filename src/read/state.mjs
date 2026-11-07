/**
 * pond-check · D3b 状态读取（src/read/state.mjs）
 *
 * 职责：读一条鱼的「窝」里能读的状态，产出六项指标判定所需的原始事实：
 *   1. 判重表   readDedupeStore()    —— 已看条目数 / 最后更新 / 今日新增
 *   2. 配置     readConfigState()    —— schema 版本 / 插件版本 / 关键字段有无
 *   3. 依赖     probeDependencies()  —— ffmpeg 在不在 PATH / node 版本 / 窝可写 / 磁盘余量
 *   4. 凭证新鲜度 readCredentialFreshness() —— 只给「存在 + 距今多少秒」，名字固定 'credential'
 *   聚合便捷入口 readState() 一次拿全。
 *
 * 硬约束：
 *   - 只读：stat / read / access(W_OK) / PATH 查找，不写任何字节，不启停进程。
 *     （allowExec 打开时唯一例外是 SPEC §3.6 白名单里的 `node --version`，
 *       默认关闭：不显式允许就一次外部命令都不执行。）
 *   - 不读凭证：文件名命中 rules.json credentials.skipFilePatterns 的**整份不读**，
 *     文件名也不进任何输出；配置里键名命中敏感词的**跳过且不留痕**（连计数都不留）。
 *   - 失败降级：一切异常/读不到 → 对应字段 null + reason（机器码）+ reasonText
 *     （人话，回答「所以我现在该做什么」），绝不抛、绝不假装正常。
 *   - 阈值常量只在 rules.json：本模块只出原始事实（秒数 / 字节数 / 版本号），
 *     30/60 天、1 GiB/200 MiB、node 22 这类判定由指标层去 rules.json 读。
 *
 * 输出形状（四块统一约定）：
 *   { ...事实字段（读不到为 null）, reason: string|null, reasonText: string|null }
 *   reason 为 null 表示一切正常读出；否则是机器码（如 'not_found' / 'unrecognized'）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RULES_URL = new URL('../rules.json', import.meta.url);

/* ------------------------------------------------------------------ *
 * rules.json（唯一真相）+ 兜底
 * ------------------------------------------------------------------ */

const FALLBACK = {
  skipFilePatterns: [
    '*credential*', '*cred*', '*secret*', '*cookie*', '*token*',
    '*session*', '*auth*', '*password*', '*passwd*',
    '.env', '.env.*', '*.env', '*.env.*', '*.key', '*.pem',
  ],
  // 敏感键名：任务口径 token/key/secret/password/cookie/auth ∪ rules.valueRedactionKeys
  sensitiveKeyWords: [
    'token', 'key', 'secret', 'password', 'passwd', 'cookie',
    'auth', 'authorization', 'bearer', 'credential', 'access_key',
  ],
  timeFieldNames: [
    'processedAt', 'processed_at', 'ts', 'time',
    'created_at', 'createdAt', 'date', 'updatedAt',
  ],
  versionFieldOrder: ['schemaVersion', 'schema_version', 'configVersion', 'version'],
  programVersionFieldOrder: ['version'],
  modelLineFields: ['model', 'provider', 'baseUrl', 'apiBase'],
  knownCredentialPaths: [
    '~/.dsh/credentials.json', '~/.dsh/auth.json',
    '~/.config/astrbot/data/cmd_config.json',
    '~/.config/napcat/config/onebot11.json',
    '~/.bilibili-cookie.json',
  ],
  maxEntriesCounted: 100000,
  futureSkewToleranceSec: 120,
  execTimeoutMs: 1000,
};

// 单文件解析的 IO 防呆上限（防 OOM，不是判定阈值）。
const MAX_PARSE_BYTES = 32 * 1024 * 1024;

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_URL, 'utf8'));
  } catch {
    return null;
  }
}

const RULES = loadRules();

function rulesList(...pathParts) {
  let node = RULES;
  for (const part of pathParts) node = node?.[part];
  return Array.isArray(node) ? node.filter((x) => typeof x === 'string') : null;
}

const SKIP_FILE_PATTERNS = rulesList('credentials', 'skipFilePatterns') ?? FALLBACK.skipFilePatterns;
const SENSITIVE_KEY_WORDS = [
  ...new Set([
    ...FALLBACK.sensitiveKeyWords,
    ...(rulesList('credentials', 'valueRedactionKeys') ?? []),
  ]),
];
const TIME_FIELD_NAMES = rulesList('indicators', 'throughput', 'thresholds', 'timeFieldNames') ?? FALLBACK.timeFieldNames;
const VERSION_FIELD_ORDER = rulesList('indicators', 'drift', 'versionFieldOrder') ?? FALLBACK.versionFieldOrder;
const PROGRAM_VERSION_FIELD_ORDER = rulesList('indicators', 'drift', 'programVersionFieldOrder') ?? FALLBACK.programVersionFieldOrder;
const MODEL_LINE_FIELDS = pickModelLineFields();
const KNOWN_CREDENTIAL_PATHS = rulesList('credentials', 'knownCredentialPaths', 'candidates') ?? FALLBACK.knownCredentialPaths;

function pickModelLineFields() {
  try {
    const checks = RULES?.indicators?.deps?.thresholds?.checks;
    const modelLine = checks?.find?.((c) => c?.id === 'modelLine');
    if (Array.isArray(modelLine?.fields)) {
      return modelLine.fields.filter((x) => typeof x === 'string');
    }
  } catch {
    // 取不到就用兜底
  }
  return FALLBACK.modelLineFields;
}

function rulesNumber(pathParts, fallback) {
  let node = RULES;
  for (const part of pathParts) node = node?.[part];
  const value = Number(node);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const MAX_ENTRIES_COUNTED = rulesNumber(['budget', 'maxEntriesCounted'], FALLBACK.maxEntriesCounted);
const FUTURE_SKEW_TOLERANCE_SEC = rulesNumber(['indicators', 'liveness', 'thresholds', 'constants', 'futureSkewToleranceSec'], FALLBACK.futureSkewToleranceSec);
const EXEC_TIMEOUT_MS = rulesNumber(['budget', 'execTimeoutMs'], FALLBACK.execTimeoutMs);

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 通配符（* / ?）→ 正则，大小写不敏感。SPEC §2.2 口径。 */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

/** 文件名是不是凭证类（是 → 整份不读、名字不进输出）。 */
function isSensitiveFileName(name) {
  return SKIP_FILE_PATTERNS.some((pattern) => wildcardToRegExp(pattern).test(name));
}

/** 键名是不是敏感词（是 → 跳过且不留痕）。 */
function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  return SENSITIVE_KEY_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

/** 安全读文件：凭证名不读、超大不读、失败给 reason。 */
function readTextFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { ok: false, reason: 'not_a_file', stat };
    if (stat.size > MAX_PARSE_BYTES) return { ok: false, reason: 'file_too_large', stat };
    return { ok: true, text: fs.readFileSync(filePath, 'utf8'), stat };
  } catch (err) {
    const code = err?.code;
    return {
      ok: false,
      reason: code === 'ENOENT' ? 'not_found' : code === 'EACCES' ? 'permission_denied' : 'read_error',
      stat: null,
    };
  }
}

/** 时间戳归一：epoch 秒/毫秒、ISO 字符串都能认；无效返回 null。 */
function toEpochMs(value, nowMs) {
  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 小于 1e12 当秒，大于当毫秒（1970 年不可能，2286 年后不可能）
    ms = value > 0 && value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && value !== '') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== '') {
      ms = asNumber > 0 && asNumber < 1e12 ? asNumber * 1000 : asNumber;
    } else {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) ms = parsed;
    }
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  // 未来时间戳超出容忍度 = 坏数据（SPEC liveness.unknownWhen 口径）
  if (ms > nowMs + FUTURE_SKEW_TOLERANCE_SEC * 1000) return null;
  return ms;
}

/** 本地自然日 00:00（rhythm.wakeDefinition 口径）。 */
function startOfLocalDay(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function reasonWrap(base, reason, reasonText) {
  return { ...base, reason, reasonText };
}

const REASON_TEXT = {
  not_found: '文件或目录不存在 —— 先确认她把状态存在哪（--root <她的目录>）。',
  not_a_file: '这个路径不是普通文件 —— 检查是不是指错了地方。',
  permission_denied: '没权限读 —— chmod u+r 给一下，或者用能读的那个账号跑体检。',
  read_error: '读取失败 —— 看看文件是不是损坏了，或者被别的进程占着。',
  file_too_large: '文件太大，本次不解析 —— 如果判重表长到这个量级，先归档旧条目再体检。',
  sensitive_file: '[凭证文件已跳过] 这个文件名看着像登录凭证，体检不打开它。',
  unrecognized: '认不出这个文件的格式（不是 json / jsonl / 文本行 / sqlite）—— 用 --dedupe 指定正确文件。',
  no_timestamps: '条目里没有可解析的时间戳，算不出「最后更新」和「今日新增」（不是 0）。',
  no_version_field: '配置里没有版本号字段 —— 加一行 schemaVersion，漂移判定才有的算。',
  unsupported_format: '这个配置不是 JSON，本版本只解析 JSON 配置 —— 要么转成 JSON，要么等后续版本。',
  parse_error: 'JSON 解析失败 —— 配置/判重表可能写坏了，看文件最后改动是不是手改坏的。',
  version_unknown: '取不到 Node 版本号 —— 版本判定只能是 unknown，不能当通过。',
  sqlite_no_driver: '判重表是 sqlite，但本机 Node 没有可用的 sqlite 驱动 —— 工作量只能是 unknown。',
  sqlite_open_failed: 'sqlite 判重表打开失败 —— 文件可能损坏，或者版本太新。',
  no_credentials_found: '没找到已知的登录态文件 —— 要么她不用登录，要么凭证换地方了（用 --root 指她的窝再看）。',
};

function reasonTextFor(reason) {
  return REASON_TEXT[reason] ?? '读不出这项状态，按 unknown 处理，不能当正常。';
}

/* ------------------------------------------------------------------ *
 * 1. 判重表
 * ------------------------------------------------------------------ */

/** 从一个条目里挖时间戳（只看时间字段名，别的键一概不碰）。 */
function entryTimestampMs(entry, nowMs) {
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    for (const field of TIME_FIELD_NAMES) {
      if (field in entry) {
        const ms = toEpochMs(entry[field], nowMs);
        if (ms !== null) return ms;
      }
    }
    return null;
  }
  // 裸字符串 / 裸数字行：本身可能就是时间戳
  return toEpochMs(entry, nowMs);
}

/** 统计一批条目：条目数（封顶）、最后条目时间、今日新增。 */
function summarizeEntries(entries, nowMs, maxEntries) {
  let count = 0;
  let countEstimated = false;
  let lastEntryAt = null;
  let todayNew = 0;
  let hasTimestamp = false;
  const dayStart = startOfLocalDay(nowMs);

  for (const entry of entries) {
    if (count >= maxEntries) {
      countEstimated = true;
      break;
    }
    count += 1;
    const ts = entryTimestampMs(entry, nowMs);
    if (ts === null) continue;
    hasTimestamp = true;
    if (lastEntryAt === null || ts > lastEntryAt) lastEntryAt = ts;
    if (ts >= dayStart) todayNew += 1;
  }

  return {
    count,
    countEstimated,
    lastEntryAt,
    // 空表的「今日新增 0」是事实；有条目却一条时间戳都没有才算不出（null）
    todayNew: (hasTimestamp || count === 0) ? todayNew : null,
  };
}

/** JSON 对象形态：{items:[...]} 这类容器，或 {条目键: 时间戳} 这种 map。 */
function objectItems(parsed) {
  const containerKeys = ['items', 'entries', 'data', 'list', 'records', 'processed', 'seen', 'history'];
  for (const key of containerKeys) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  // map 形态：键是条目名，值常是时间戳
  return Object.entries(parsed).map(([key, value]) => (
    value !== null && typeof value === 'object' ? value : { name: key, ts: value }
  ));
}

/**
 * 读判重表。格式：json_array / json_object_items / jsonl / lines / sqlite。
 * 认不出 → 全 null + reason='unrecognized'（不是 0，不是「挺好」）。
 *
 * @param {string} filePath 判重表路径
 * @param {{now?:number, home?:string, maxEntriesCounted?:number}} [options]
 */
export function readDedupeStore(filePath, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const maxEntries = Number.isInteger(options.maxEntriesCounted) && options.maxEntriesCounted > 0
    ? options.maxEntriesCounted
    : MAX_ENTRIES_COUNTED;
  const empty = {
    format: null, count: null, countEstimated: false,
    lastEntryAt: null, fileMtimeAt: null, todayNew: null,
  };

  try {
    if (typeof filePath !== 'string' || filePath === '') {
      return reasonWrap(empty, 'not_found', reasonTextFor('not_found'));
    }
    // 凭证闸：名字像凭证的整份不读（§2.4 连 open 都不做）
    if (isSensitiveFileName(path.basename(filePath))) {
      return reasonWrap(empty, 'sensitive_file', reasonTextFor('sensitive_file'));
    }

    const loaded = readTextFileSafe(filePath);
    if (!loaded.ok) return reasonWrap(empty, loaded.reason, reasonTextFor(loaded.reason));
    const fileMtimeAt = Math.round(loaded.stat.mtimeMs);
    const withMtime = { ...empty, fileMtimeAt };

    const text = loaded.text;
    const head = text.slice(0, 16);

    // sqlite：魔数认出；能开就 SELECT COUNT(*)，不能开就降级（绝不写一个字节）
    if (head.startsWith('SQLite format 3\u0000')) {
      return readSqliteCount(filePath, withMtime, maxEntries, nowMs);
    }

    // 二进制但不是 sqlite → 认不出
    if (text.slice(0, 4096).includes('\u0000')) {
      return reasonWrap(withMtime, 'unrecognized', reasonTextFor('unrecognized'));
    }

    let entries = null;
    let format = null;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        format = 'json_array';
        entries = parsed;
      } else if (parsed !== null && typeof parsed === 'object') {
        format = 'json_object_items';
        entries = objectItems(parsed);
      }
    } catch {
      format = null; // 走行解析
    }

    if (entries === null) {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
      if (lines.length === 0) {
        // 空文件：0 条是事实（不是「认不出」）
        return { ...withMtime, format: 'lines', count: 0, countEstimated: false, todayNew: 0, reason: null, reasonText: null };
      }
      let jsonl = true;
      const parsedLines = [];
      for (const line of lines) {
        try {
          parsedLines.push(JSON.parse(line));
        } catch {
          jsonl = false;
          break;
        }
      }
      format = jsonl ? 'jsonl' : 'lines';
      entries = jsonl ? parsedLines : lines;
    }

    const summary = summarizeEntries(entries, nowMs, maxEntries);
    // 有条目但一条时间戳都没解析出来 → 留痕（不能装作「今日新增 0」）
    const noTimestamps = summary.count > 0 && summary.lastEntryAt === null;
    return {
      ...withMtime,
      format,
      ...summary,
      lastUpdateAt: Math.max(summary.lastEntryAt ?? 0, fileMtimeAt) || null,
      reason: noTimestamps ? 'no_timestamps' : null,
      reasonText: noTimestamps ? reasonTextFor('no_timestamps') : null,
    };
  } catch {
    return reasonWrap(empty, 'read_error', reasonTextFor('read_error'));
  }
}

/** sqlite 判重表：只读打开 + COUNT(*)；驱动不可用/打开失败 → 降级留 reason。 */
function readSqliteCount(filePath, withMtime, maxEntries, nowMs) {
  const base = { ...withMtime, format: 'sqlite' };
  // node:sqlite 在 Node 22 是实验特性，可能拿不到；拿不到就老实降级。
  const DatabaseSync = loadSqliteSync();
  if (!DatabaseSync) return reasonWrap(base, 'sqlite_no_driver', reasonTextFor('sqlite_no_driver'));
  try {
    // readOnly 是硬要求（只读铁律）；再叠一层 query_only 兜底防误写。
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      try { db.exec('PRAGMA query_only = 1'); } catch { /* 不支持就算了，readOnly 已够 */ }
      const tables = db.prepare(
        'SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'',
      ).all();
      let count = 0;
      for (const table of tables) {
        const result = db.prepare(`SELECT COUNT(*) AS n FROM "${String(table.name).replace(/"/g, '""')}"`).get();
        count += Number(result?.n ?? 0);
        if (count > maxEntries) break;
      }
      const countEstimated = count > maxEntries;
      return {
        ...base,
        count: countEstimated ? maxEntries : count,
        countEstimated,
        // sqlite 条目时间戳要逐行读才有，本次只出条目数与文件时间（其余留 null）
        lastEntryAt: null,
        todayNew: null,
        reason: 'no_timestamps',
        reasonText: reasonTextFor('no_timestamps'),
      };
    } finally {
      try { db.close(); } catch { /* 只读，关不关无所谓 */ }
    }
  } catch {
    return reasonWrap(base, 'sqlite_open_failed', reasonTextFor('sqlite_open_failed'));
  }
}

/** 同步拿 node:sqlite 的 DatabaseSync（拿不到返回 null → 上层降级）。 */
function loadSqliteSync() {
  try {
    const mod = typeof process?.getBuiltinModule === 'function'
      ? process.getBuiltinModule('node:sqlite')
      : null;
    return mod?.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 2. 配置
 * ------------------------------------------------------------------ */

/** 按点号路径取值（credentials.cookieFile 这种），任一段是敏感键 → 不取。 */
function digField(obj, dottedName) {
  const parts = String(dottedName).split('.');
  let node = obj;
  for (const part of parts) {
    if (isSensitiveKey(part)) return { found: false, nonEmpty: false };
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return { found: false, nonEmpty: false };
    if (!(part in node)) return { found: false, nonEmpty: false };
    node = node[part];
  }
  const nonEmpty = !(node === null || node === '' ||
    (typeof node === 'object' && !Array.isArray(node) && Object.keys(node).length === 0) ||
    (Array.isArray(node) && node.length === 0));
  return { found: true, nonEmpty };
}

/**
 * 读配置：schema 版本、插件版本、关键字段有无。
 * 只输出版本号与布尔值；键名命中 token/key/secret/password/cookie/auth 的
 * 字段一律跳过且**不留痕**（输出里连它存不存在都不提）。
 *
 * @param {string} configPath 配置文件（JSON）
 * @param {{packageJsonPath?:string, home?:string}} [options]
 */
export function readConfigState(configPath, options = {}) {
  const empty = { schemaVersion: null, schemaVersionField: null, pluginVersion: null, fieldsPresent: {} };
  try {
    if (typeof configPath !== 'string' || configPath === '') {
      return reasonWrap(empty, 'not_found', reasonTextFor('not_found'));
    }
    if (isSensitiveFileName(path.basename(configPath))) {
      return reasonWrap(empty, 'sensitive_file', reasonTextFor('sensitive_file'));
    }

    const loaded = readTextFileSafe(configPath);
    if (!loaded.ok) return reasonWrap(empty, loaded.reason, reasonTextFor(loaded.reason));

    let config = null;
    try {
      config = JSON.parse(loaded.text);
    } catch {
      return reasonWrap(empty, 'unsupported_format', reasonTextFor('unsupported_format'));
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return reasonWrap(empty, 'unsupported_format', reasonTextFor('unsupported_format'));
    }

    // schema 版本：按 versionFieldOrder 取第一个存在的（跳过敏感键）
    let schemaVersion = null;
    let schemaVersionField = null;
    for (const field of VERSION_FIELD_ORDER) {
      if (isSensitiveKey(field)) continue;
      const { found, nonEmpty } = digField(config, field);
      if (!found || !nonEmpty) continue;
      const raw = digValue(config, field);
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(num)) {
        schemaVersion = num;
        schemaVersionField = field;
        break;
      }
    }

    // 插件版本：程序清单 package.json 的 version（程序版本字段按 programVersionFieldOrder）
    let pluginVersion = null;
    const pkgPath = typeof options.packageJsonPath === 'string' && options.packageJsonPath !== ''
      ? options.packageJsonPath
      : path.join(path.dirname(configPath), 'package.json');
    if (!isSensitiveFileName(path.basename(pkgPath))) {
      const pkgLoaded = readTextFileSafe(pkgPath);
      if (pkgLoaded.ok) {
        try {
          const pkg = JSON.parse(pkgLoaded.text);
          for (const field of PROGRAM_VERSION_FIELD_ORDER) {
            if (isSensitiveKey(field)) continue;
            const value = pkg?.[field];
            if (typeof value === 'string' && value !== '') {
              pluginVersion = value;
              break;
            }
          }
        } catch {
          // 清单坏了 → pluginVersion 留 null，不阻断其他字段
        }
      }
    }

    // 关键字段存在性：只出布尔值，值不落结果；敏感键直接不当存在
    const fieldsPresent = {};
    for (const field of MODEL_LINE_FIELDS) {
      if (isSensitiveKey(field)) continue;
      const { found, nonEmpty } = digField(config, field);
      fieldsPresent[field] = found && nonEmpty;
    }

    return {
      schemaVersion,
      schemaVersionField,
      pluginVersion,
      fieldsPresent,
      reason: schemaVersion === null ? 'no_version_field' : null,
      reasonText: schemaVersion === null ? reasonTextFor('no_version_field') : null,
    };
  } catch {
    return reasonWrap(empty, 'read_error', reasonTextFor('read_error'));
  }
}

/** 取字段原值（仅供版本号数字化；调用方保证字段不是敏感键）。 */
function digValue(obj, dottedName) {
  let node = obj;
  for (const part of String(dottedName).split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * 3. 依赖探测
 * ------------------------------------------------------------------ */

/** ffmpeg 在不在 PATH（只查找，不执行）。 */
function probeFfmpeg() {
  try {
    const raw = process.env.PATH ?? '';
    const dirs = raw.split(path.delimiter).filter((dir) => dir !== '');
    const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg'] : ['ffmpeg'];
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return { found: true, reason: null, reasonText: null };
        } catch {
          // 这个候选不行，看下一个
        }
      }
    }
    return { found: false, reason: null, reasonText: null };
  } catch {
    return { found: null, reason: 'read_error', reasonText: reasonTextFor('read_error') };
  }
}

/**
 * Node 版本。默认零执行：取宿主 runtime 的 process.versions.node（source='runtime'）。
 * allowExec=true 时按 SPEC §3.6 白名单执行 `node --version` 取 PATH 上的 Node
 * （source='exec'），失败再退回 runtime；都取不到 → null + reason='version_unknown'。
 */
function probeNodeVersion({ allowExec = false } = {}) {
  try {
    if (allowExec) {
      try {
        const out = execFileSync('node', ['--version'], {
          timeout: EXEC_TIMEOUT_MS,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const match = out.match(/^v?(\d+)\.(\d+)\.(\d+)/);
        if (match) {
          return {
            version: out.replace(/^v/, ''),
            major: Number(match[1]),
            source: 'exec',
            reason: null,
            reasonText: null,
          };
        }
      } catch {
        // exec 失败 → 退回 runtime
      }
    }
    const version = process.versions?.node ?? null;
    if (typeof version === 'string' && version !== '') {
      const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
      return {
        version,
        major: match ? Number(match[1]) : null,
        source: 'runtime',
        reason: null,
        reasonText: null,
      };
    }
    return { version: null, major: null, source: null, reason: 'version_unknown', reasonText: reasonTextFor('version_unknown') };
  } catch {
    return { version: null, major: null, source: null, reason: 'version_unknown', reasonText: reasonTextFor('version_unknown') };
  }
}

/**
 * 依赖探测四件套：ffmpeg 在 PATH / node 版本 / 窝可写 / 磁盘余量。
 * @param {{home?:string, allowExec?:boolean}} [options] home=鱼的窝（stateRoot）
 */
export function probeDependencies(options = {}) {
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : os.homedir();

  let homeWritable = { writable: null, reason: null, reasonText: null };
  try {
    fs.accessSync(home, fs.constants.W_OK);
    homeWritable = { writable: true, reason: null, reasonText: null };
  } catch (err) {
    const code = err?.code;
    homeWritable = {
      writable: false,
      reason: code === 'ENOENT' ? 'not_found' : code === 'EACCES' ? 'permission_denied' : 'read_error',
      reasonText: reasonTextFor(code === 'ENOENT' ? 'not_found' : code === 'EACCES' ? 'permission_denied' : 'read_error'),
    };
  }

  let disk = { freeBytes: null, totalBytes: null, reason: null, reasonText: null };
  try {
    const stat = fs.statfsSync(home);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    disk = {
      freeBytes: Number.isFinite(freeBytes) ? freeBytes : null,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
      freeHuman: Number.isFinite(freeBytes) ? humanBytes(freeBytes) : null,
      reason: null,
      reasonText: null,
    };
  } catch {
    disk = { freeBytes: null, totalBytes: null, freeHuman: null, reason: 'read_error', reasonText: reasonTextFor('read_error') };
  }

  return {
    ffmpeg: probeFfmpeg(),
    node: probeNodeVersion({ allowExec: options.allowExec === true }),
    homeWritable,
    disk,
  };
}

function humanBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/* ------------------------------------------------------------------ *
 * 4. 凭证新鲜度
 * ------------------------------------------------------------------ */

/**
 * 凭证新鲜度：只回答「有没有、最近更新是多久以前」。
 * **永远不给路径/文件名** —— 名字固定占位 'credential'，只出聚合秒数。
 * （SPEC §2.4 唯一例外条款：knownCredentialPaths 白名单只 stat mtime。）
 *
 * @param {{home?:string, now?:number}} [options]
 */
export function readCredentialFreshness(options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : os.homedir();

  try {
    const items = [];
    let missingCount = 0;
    for (const raw of KNOWN_CREDENTIAL_PATHS) {
      // 只展开 ~ ；真实路径不进任何输出
      const candidate = raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw;
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) {
          missingCount += 1;
          continue;
        }
        items.push({
          name: 'credential', // 固定占位名，绝不带真名
          ageSec: Math.round((nowMs - stat.mtimeMs) / 1000),
        });
      } catch {
        missingCount += 1;
      }
    }

    const ages = items.map((item) => item.ageSec);
    const base = {
      items,
      foundCount: items.length,
      missingCount,
      newestAgeSec: ages.length > 0 ? Math.min(...ages) : null,
      oldestAgeSec: ages.length > 0 ? Math.max(...ages) : null,
    };
    if (items.length === 0) {
      return reasonWrap(base, 'no_credentials_found', reasonTextFor('no_credentials_found'));
    }
    return { ...base, reason: null, reasonText: null };
  } catch {
    return reasonWrap(
      { items: [], foundCount: 0, missingCount: 0, newestAgeSec: null, oldestAgeSec: null },
      'read_error',
      reasonTextFor('read_error'),
    );
  }
}

/* ------------------------------------------------------------------ *
 * 聚合入口
 * ------------------------------------------------------------------ */

/**
 * 一次读全四块状态（各自独立降级，互不拖累）。
 * @param {{dedupePath?:string, configPath?:string, packageJsonPath?:string,
 *          home?:string, allowExec?:boolean, now?:number, maxEntriesCounted?:number}} [options]
 */
export function readState(options = {}) {
  return {
    dedupe: typeof options.dedupePath === 'string' && options.dedupePath !== ''
      ? readDedupeStore(options.dedupePath, options)
      : reasonWrap({ format: null, count: null, countEstimated: false, lastEntryAt: null, fileMtimeAt: null, todayNew: null }, 'not_found', reasonTextFor('not_found')),
    config: typeof options.configPath === 'string' && options.configPath !== ''
      ? readConfigState(options.configPath, options)
      : reasonWrap({ schemaVersion: null, schemaVersionField: null, pluginVersion: null, fieldsPresent: {} }, 'not_found', reasonTextFor('not_found')),
    deps: probeDependencies(options),
    credentials: readCredentialFreshness(options),
  };
}

export default readState;
