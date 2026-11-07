// src/discover/dsh.mjs —— DSH 宿主探测：在 DSH_HOME 里找「鱼」类插件
//
// 职责（P2「已知窝目录」的 DSH 分支，见 docs/SPEC.md §3.2）：
//   扫 $DSH_HOME/profiles/*/package.json 与 $DSH_HOME/plugins，
//   按命名特征（bili / whale / fish / pet / qq / bot / live / dynamic …）识别
//   哪些插件是「鱼」，返回 {id, kind:'dsh-plugin', rootPath, evidence}。
//
// 硬约束：
//   1. 只读：本文件只 stat / readdir / 读 package.json，不写任何字节。
//   2. 不联网：只 import node:fs / node:path / node:os / node:url。
//   3. 不读凭证：只打开固定名字 package.json；目录名命中「rules.json 的
//      credentials.skipDirPatterns ∪ 内置安全底线」就整个跳过，名字不进任何输出。
//   4. 任何异常都不外抛：目录不存在、package.json 损坏、无权限 → 该处当
//      没数据（全部落空就是 []），绝不让一次探测失败掀翻整场体检。
//   5. 阈值/预算常量不硬编码：maxDirEntries 从 src/rules.json 的 budget 读，
//      读不到才用兜底值（见 loadGuard）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 鱼特征关键字表
// ---------------------------------------------------------------------------

/**
 * 「鱼」类插件的命名特征关键字。
 *
 * 匹配口径是【整词命中或词首前缀】（见 matchFishKeywords）：
 * 词按 - _ . / @ 空格 与 camelCase 边界切开后，整词等于关键字、或整词以
 * 关键字开头才算命中。刻意不用子串包含——否则 deliverables 里的 "live"、
 * abilities 里的 "bili" 会把无关插件误报成鱼（实测 324 个真实依赖名里
 * 子串匹配会误伤 dsh-client-ui-deliverables）。
 *
 * 代价是 "jellyfish" 这种把关键字夹在词中间的怪名抓不到；漏报好过误报，
 * evidence 里会写明命中的是哪个关键字，用户一眼能复核。
 */
export const FISH_KEYWORDS = Object.freeze([
  // B 站 / 弹幕 / 动态类
  'bili', 'bilibili', 'bvid', 'danmaku', 'dynamic',
  // 桌宠 / 鱼缸 / 宠物类
  'whale', 'fish', 'pet', 'vpet', 'live2d',
  // QQ / 机器人框架类
  'qq', 'bot', 'robot', 'astrbot', 'napcat', 'onebot', 'llonebot',
  // 直播 / 社媒动态类
  'live', 'weibo', 'douyin', 'xhs',
]);

// ---------------------------------------------------------------------------
// 小工具：分词、通配符、JSON 读取
// ---------------------------------------------------------------------------

/** 把名字切成小写词：按分隔符 + camelCase 边界切。 */
function tokenize(text) {
  if (typeof text !== 'string' || text === '') return [];
  return text
    .split(/[-_./@+,\s]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/**
 * 找出一段命名里命中的鱼特征关键字（返回顺序跟 FISH_KEYWORDS 一致，去重）。
 * @param {...string} texts 任意个待匹配字符串（包名、目录名、keywords 等）
 * @returns {string[]} 命中的关键字；没命中返回 []
 */
export function matchFishKeywords(...texts) {
  const tokens = texts.flatMap(tokenize);
  return FISH_KEYWORDS.filter((keyword) =>
    tokens.some((word) => word === keyword || word.startsWith(keyword)),
  );
}

/** 通配符（* 任意长度、? 单字符）→ 正则，大小写不敏感。SPEC §2.2 的匹配口径。 */
function wildcardToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * 读一个 package.json，永不抛异常。
 * @returns {{status:'ok', data:object}|{status:'missing'}|{status:'broken'}}
 *   missing = 文件不存在/读不到（权限、路径是目录等）；broken = 文件在但解析失败/超大。
 */
function readManifest(manifestPath) {
  try {
    const stat = fs.statSync(manifestPath);
    if (!stat.isFile()) return { status: 'missing' };
    // 防呆上限 1 MiB：manifest 本该是小文件，超大当损坏处理（不是判定阈值）。
    if (stat.size > 1024 * 1024) return { status: 'broken' };
  } catch {
    return { status: 'missing' };
  }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { status: 'broken' };
    }
    return { status: 'ok', data };
  } catch {
    return { status: 'broken' };
  }
}

/** realpath（去重键用），失败就退回原路径。 */
function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** 判断路径是不是已存在的目录，失败当不是。 */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 列一个目录（只要目录项），越界条目截到 maxDirEntries，失败返回 []。 */
function listDirEntries(dir, guard) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.slice(0, guard.maxDirEntries);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 守卫：跳过凭证类目录名 + 预算
// ---------------------------------------------------------------------------

// 凭证类目录跳过的安全底线：永远并入（即使 rules.json 缺这几条也照跳）。
// 注意：SPEC §2.3 的表里有 secrets / .npm，但 rules.json 的 skipDirPatterns
// 目前漏了它们 —— 这是 D1 规格缺口（已上报），这里按「文件名也不进结果」
// 的铁律兜住，等 rules.json 补齐后两边自然一致。
const FALLBACK_SKIP_DIR_PATTERNS = [
  '.ssh', '.gnupg', '.git', '.aws', '.docker', '.password-store',
  '.pki', '.config/gcloud', '.config/gh', 'keyrings',
  '.local/share/keyrings', 'node_modules', '.cache', 'secrets', '.npm',
];
const FALLBACK_MAX_DIR_ENTRIES = 5000;

/**
 * 载入守卫：凭证目录跳过表 + 目录条目预算。
 * 跳过表 = rules.json 的 credentials.skipDirPatterns ∪ 安全底线；
 * 预算优先读 src/rules.json（常量唯一来源），读不到用兜底值继续干活。
 */
function loadGuard() {
  const skipDirPatterns = new Set(FALLBACK_SKIP_DIR_PATTERNS);
  let maxDirEntries = FALLBACK_MAX_DIR_ENTRIES;
  try {
    const rules = JSON.parse(
      fs.readFileSync(new URL('../rules.json', import.meta.url), 'utf8'),
    );
    const patterns = rules?.credentials?.skipDirPatterns;
    if (Array.isArray(patterns)) {
      for (const p of patterns) {
        if (typeof p === 'string') skipDirPatterns.add(p);
      }
    }
    const budget = rules?.budget?.maxDirEntries;
    if (Number.isInteger(budget) && budget > 0) maxDirEntries = budget;
  } catch {
    // rules.json 缺失/损坏：安全底线照常生效，探测照跑。
  }
  return {
    maxDirEntries,
    skipDirRes: [...skipDirPatterns].map(wildcardToRegExp),
  };
}

/**
 * 目录名是否命中凭证类跳过表。命中 → 整项跳过，名字不进任何输出。
 * （我们只打开固定名字 package.json，从不枚举目录里的散文件，
 *   所以文件名根本不进本模块；这里防的是「目录名本身是敏感名」。）
 */
function isSensitiveDirName(name, guard) {
  return guard.skipDirRes.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// 扫描点 1：$DSH_HOME/profiles/*/package.json
// ---------------------------------------------------------------------------

// profile 清单里鱼可能藏身的依赖字段。
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function scanProfiles(dshHome, guard) {
  const hits = [];
  const root = path.join(dshHome, 'profiles');

  for (const entry of listDirEntries(root, guard)) {
    try {
      if (!entry.isDirectory()) continue; // 松散文件不看
      if (isSensitiveDirName(entry.name, guard)) continue;

      const profileDir = path.join(root, entry.name);
      const manifest = readManifest(path.join(profileDir, 'package.json'));
      // 契约：package.json 损坏/缺失/无权限 → 该 profile 不算数，不抛异常。
      if (manifest.status !== 'ok') continue;

      const pkg = manifest.data;

      // 候选名：profile 自己的包名 + 各依赖字段里的包名。
      const candidates = [];
      if (typeof pkg.name === 'string' && pkg.name !== '') {
        candidates.push({ name: pkg.name, matchedOn: 'name', isDep: false });
      }
      for (const field of DEP_FIELDS) {
        const deps = pkg[field];
        if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue;
        for (const dep of Object.keys(deps)) {
          candidates.push({
            name: dep,
            matchedOn: 'dependencies',
            isDep: true,
            // 清单里声明的版本/范围（例如 ^1.2.0），不是安装版本。
            declaredVersion: typeof deps[dep] === 'string' ? deps[dep] : null,
          });
        }
      }

      const seen = new Set(); // 同一 profile 里 dependencies/devDependencies 可能重复
      for (const candidate of candidates) {
        if (seen.has(candidate.name)) continue;
        seen.add(candidate.name);

        const keywords = matchFishKeywords(candidate.name);
        if (keywords.length === 0) continue;

        // rootPath：依赖声明优先指到它的安装目录（profiles/<p>/node_modules/<dep>）；
        // 找不到安装目录就退回 profile 目录，并在 evidence 里注明「只看到声明」。
        let rootPath = profileDir;
        let installed = false;
        if (candidate.isDep) {
          const installDir = path.join(profileDir, 'node_modules', candidate.name);
          if (isDirectory(installDir)) {
            rootPath = installDir;
            installed = true;
          }
        }

        const label = candidate.isDep
          ? `profile「${entry.name}」的依赖清单`
          : `profile「${entry.name}」自己的包名`;
        const tail = candidate.isDep && !installed
          ? '，但没找到安装目录 —— 照样报出来，窝的位置存疑'
          : ' —— 判定它是一条鱼';

        hits.push({
          id: candidate.name,
          kind: 'dsh-plugin',
          rootPath: realPath(rootPath),
          evidence: {
            host: 'dsh',
            scanPoint: 'profiles',
            profileName: entry.name,
            packageName: typeof pkg.name === 'string' ? pkg.name : null,
            // 依赖命中时是清单里声明的版本范围；profile 自身命中时是它的 version。
            version: candidate.isDep
              ? candidate.declaredVersion
              : (typeof pkg.version === 'string' ? pkg.version : null),
            matchedName: candidate.name,
            matchedKeywords: keywords,
            matchedOn: [candidate.matchedOn],
            installed,
            reason: `${label}里有 ${candidate.name}，命中鱼特征关键字 ${keywords.join('、')}${tail}。`,
          },
        });
      }
    } catch {
      // 单个 profile 出岔子：跳过它，继续扫下一个。
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 扫描点 2：$DSH_HOME/plugins
// ---------------------------------------------------------------------------

function scanPlugins(dshHome, guard) {
  const hits = [];
  const root = path.join(dshHome, 'plugins');

  // plugins 下每个目录 = 一个插件；@scope 形态就往下取一层。
  const candidates = [];
  for (const entry of listDirEntries(root, guard)) {
    try {
      if (!entry.isDirectory()) continue; // 散文件不看
      if (isSensitiveDirName(entry.name, guard)) continue;
      if (entry.name.startsWith('@')) {
        for (const sub of listDirEntries(path.join(root, entry.name), guard)) {
          if (!sub.isDirectory()) continue;
          if (isSensitiveDirName(sub.name, guard)) continue;
          candidates.push({
            dir: path.join(root, entry.name, sub.name),
            dirName: `${entry.name}/${sub.name}`,
          });
        }
        continue;
      }
      candidates.push({ dir: path.join(root, entry.name), dirName: entry.name });
    } catch {
      // 单项出岔子：跳过。
    }
  }

  for (const candidate of candidates) {
    try {
      const manifest = readManifest(path.join(candidate.dir, 'package.json'));
      // 契约：package.json 损坏 → 整项不算数（目录名也不再兜底），不抛异常。
      if (manifest.status === 'broken') continue;
      const pkg = manifest.status === 'ok' ? manifest.data : null;

      // 匹配位置：目录名（无清单时也能判）+ 包名 + 插件自报的 keywords。
      const matchedOn = [];
      const keywordSet = new Set();
      const collect = (matchedField, ...texts) => {
        const found = matchFishKeywords(...texts);
        if (found.length > 0) {
          matchedOn.push(matchedField);
          for (const kw of found) keywordSet.add(kw);
        }
      };
      collect('dirName', candidate.dirName);
      if (pkg !== null) {
        collect('name', typeof pkg.name === 'string' ? pkg.name : '');
        const tags = Array.isArray(pkg.keywords)
          ? pkg.keywords.filter((k) => typeof k === 'string')
          : [];
        collect('keywords', ...tags);
      }
      if (matchedOn.length === 0) continue;

      // 输出顺序按 FISH_KEYWORDS 表序，保证可复现。
      const keywords = FISH_KEYWORDS.filter((kw) => keywordSet.has(kw));
      const id = pkg !== null && typeof pkg.name === 'string' && pkg.name !== ''
        ? pkg.name
        : candidate.dirName;

      hits.push({
        id,
        kind: 'dsh-plugin',
        rootPath: realPath(candidate.dir),
        evidence: {
          host: 'dsh',
          scanPoint: 'plugins',
          profileName: null,
          packageName: pkg !== null && typeof pkg.name === 'string' ? pkg.name : null,
          version: pkg !== null && typeof pkg.version === 'string' ? pkg.version : null,
          matchedName: candidate.dirName,
          matchedKeywords: keywords,
          matchedOn,
          installed: true,
          reason: `$DSH_HOME/plugins 下的 ${candidate.dirName} 命中鱼特征关键字 ${keywords.join('、')}（匹配位置：${matchedOn.join('、')}）—— 判定它是一条鱼。`,
        },
      });
    } catch {
      // 单项出岔子：跳过。
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/** 解析 DSH_HOME：显式入参 > $DSH_HOME > ~/.dsh。 */
export function resolveDshHome(options = {}) {
  const env = options.env ?? process.env ?? {};
  if (typeof options.dshHome === 'string' && options.dshHome !== '') return options.dshHome;
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') return env.DSH_HOME;
  return path.join(os.homedir(), '.dsh');
}

/**
 * @typedef {Object} DshPluginHit
 * @property {string} id           插件包名（拿不到就用目录名）；去重看 rootPath，不看 id。
 * @property {'dsh-plugin'} kind   固定值。
 * @property {string} rootPath     插件根目录（realpath 后）；声明未安装时是 profile 目录。
 * @property {object} evidence     凭什么判定这是鱼（给人看的在 evidence.reason）。
 */

/**
 * DSH 宿主探测：返回 DSH_HOME 里的「鱼」类插件列表。
 *
 * 永不抛异常：
 *   - DSH_HOME / profiles / plugins 目录不存在 → [];
 *   - package.json 损坏、无权限 → 该项当没数据，其余照扫；
 *   - 全部落空 → []。
 *
 * @param {{dshHome?: string, env?: object}} [options]
 *   dshHome 显式指定 DSH_HOME（测试用 fixture）；缺省读 $DSH_HOME，再缺省 ~/.dsh。
 * @returns {DshPluginHit[]} 按 id、rootPath 排序；同一 rootPath+id 只报一次。
 */
export function discoverDshPlugins(options = {}) {
  try {
    const dshHome = resolveDshHome(options);
    const guard = loadGuard();

    const merged = new Map(); // 去重键：id + realpath(rootPath)（SPEC 去重精神）
    const addAll = (hits) => {
      for (const hit of hits) {
        const key = `${hit.id}\u0000${hit.rootPath}`;
        const prev = merged.get(key);
        if (prev === undefined) {
          merged.set(key, hit);
          continue;
        }
        // 同一条鱼被两个匹配位置各报一次：合并关键字，理由保留先到的。
        for (const kw of hit.evidence.matchedKeywords) {
          if (!prev.evidence.matchedKeywords.includes(kw)) prev.evidence.matchedKeywords.push(kw);
        }
        prev.evidence.matchedKeywords = FISH_KEYWORDS.filter((kw) =>
          prev.evidence.matchedKeywords.includes(kw),
        );
        for (const on of hit.evidence.matchedOn) {
          if (!prev.evidence.matchedOn.includes(on)) prev.evidence.matchedOn.push(on);
        }
      }
    };

    addAll(scanProfiles(dshHome, guard));
    addAll(scanPlugins(dshHome, guard));

    return [...merged.values()].sort(
      (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0),
    );
  } catch {
    return []; // 兜底：探测绝不掀翻整场体检。
  }
}

export default discoverDshPlugins;
