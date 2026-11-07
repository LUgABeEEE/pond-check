/**
 * pond-check · D2 收口：探测聚合（src/discover/index.mjs）
 *
 * 职责：把两路探测合成一份「鱼清单」：
 *   - d2a  discoverDshPlugins() —— DSH 宿主（profiles/plugins），同步
 *   - d2b  discoverGeneric()    —— 通用目录（DSH_HOME/home 浅扫），异步
 *
 * 为什么有 worker：验收门要求 `discoverPonds()` 同步返回数组，而 d2b 是
 * async，主进程没法同步等 Promise。所以 generic 那一路放进 worker_threads
 * 跑，用 SharedArrayBuffer + Atomics.wait 把结果同步取回来 —— 零 npm 依赖、
 * 零网络、照样只读，预算超了就降级留痕，绝不静默少报。
 *
 * 契约：
 *   discoverPonds(options) -> Array<Fish>（永不抛）
 *     Fish = { id, kind, rootPath, evidence, [reason] }
 *     - id 可读且互不相同（队长口径）：dsh 命中从 rootPath 截 profiles/<名>/
 *       作 scope 重建为 `dsh-plugin:<scope>/<包名>`，截不出来保留 d2a 原 id
 *       （evidence.sourceId 记原值）；generic 命中保留 d2b 的 id。
 *     - rootPath 原样带出（下游拿它读文件），聚合层不改写。
 *     - 去重：kind + rootPath 只留一条；同一 rootPath 跨 kind 撞车（现行两路
 *       探测不可达）也只留更具体的那条，被合并的 id 记 evidence.mergedIds。
 *     - 排序：kind 越具体越靠前（dsh-plugin → dsh-home → standalone → unknown）。
 *     - 降级留痕：generic 一路失败时照常返回 dsh 部分，并在返回数组的
 *       `degraded` 属性记 [{scope, reason}]；「读不到」不许变成「没鱼」。
 *
 *   options：
 *     dshHome / home   两个扫描根（测试指到 tests/fixtures/<场景>/）
 *     env              传给 d2a 的环境表（缺省 process.env）
 *     maxDirEntries / skipFilePatterns / skipDirPatterns   透传给 d2b
 *     timeoutMs        等 generic 的预算（缺省 rules.json budget.scanTimeoutMs）
 */

import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { discoverDshPlugins } from './dsh.mjs';

const RULES_URL = new URL('../rules.json', import.meta.url);
const FALLBACK_SCAN_TIMEOUT_MS = 15000;

/** kind 排序权重：越具体越靠前，unknown 垫底（「判不出来」别压着真发现）。 */
const KIND_ORDER = ['dsh-plugin', 'dsh-home', 'standalone', 'unknown'];

/* ------------------------------------------------------------------ *
 * generic 同步桥：worker 里跑 discoverGeneric，结果写进 SharedArrayBuffer
 *
 * 内存布局：Int32[0]=状态（0 进行中 / 1 成功 / 2 出错 / 3 结果超大），
 * Int32[1]=JSON 字节数，其余字节放 JSON。主线程 Atomics.wait 等状态翻转。
 * ------------------------------------------------------------------ */

const PAYLOAD_OFFSET = 8;
const PAYLOAD_BYTES = 4 * 1024 * 1024;

// worker 源码同时兼容 CJS / ESM 两种 eval 模式（require 可用就用 require）。
const GENERIC_WORKER_SRC = `
(async () => {
  let workerData;
  try {
    const wt = typeof require === 'function'
      ? require('node:worker_threads')
      : await import('node:worker_threads');
    workerData = wt.workerData;
    const flag = new Int32Array(workerData.sab);
    const payload = new Uint8Array(workerData.sab, ${PAYLOAD_OFFSET});
    try {
      const mod = await import(workerData.genericUrl);
      const hits = await mod.discoverGeneric(workerData.options);
      const json = Buffer.from(JSON.stringify(hits), 'utf8');
      if (json.length > payload.length) {
        Atomics.store(flag, 0, 3);
      } else {
        payload.set(json);
        Atomics.store(flag, 1, json.length);
        Atomics.store(flag, 0, 1);
      }
    } catch {
      Atomics.store(flag, 0, 2);
    }
    Atomics.notify(flag, 0);
  } catch {
    // 连 workerData 都拿不到：没得救，主线程那边会按超时降级。
  }
})();
`;

/** 等 generic 的预算：入参优先，否则 rules.json budget.scanTimeoutMs。 */
function scanTimeoutMsOf(options) {
  const raw = Number(options?.timeoutMs);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  try {
    const rules = JSON.parse(readFileSync(RULES_URL, 'utf8'));
    const value = Number(rules?.budget?.scanTimeoutMs);
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    // rules.json 读不到 → 兜底值
  }
  return FALLBACK_SCAN_TIMEOUT_MS;
}

/** 抽出能安全结构化克隆的 d2b 入参（workerData 不收函数/BigInt 等）。 */
function genericOptionsOf(options) {
  const out = {};
  for (const key of ['dshHome', 'home']) {
    if (typeof options?.[key] === 'string' && options[key] !== '') out[key] = options[key];
  }
  if (Number.isInteger(options?.maxDirEntries) && options.maxDirEntries > 0) {
    out.maxDirEntries = options.maxDirEntries;
  }
  for (const key of ['skipFilePatterns', 'skipDirPatterns']) {
    if (Array.isArray(options?.[key])) {
      out[key] = options[key].filter((item) => typeof item === 'string');
    }
  }
  return out;
}

/**
 * 同步跑 d2b：起 worker → 等状态翻转 → 收结果。
 * @returns {{ok:true, hits:Array}|{ok:false, reason:string}}
 */
function runGenericSync(options, timeoutMs) {
  const sab = new SharedArrayBuffer(PAYLOAD_OFFSET + PAYLOAD_BYTES);
  const flag = new Int32Array(sab);

  let worker;
  try {
    worker = new Worker(GENERIC_WORKER_SRC, {
      eval: true,
      workerData: {
        genericUrl: new URL('./generic.mjs', import.meta.url).href,
        options,
        sab,
      },
    });
  } catch {
    return { ok: false, reason: 'worker_start_failed' };
  }
  // worker 崩了会发 'error' 事件；没监听者就会掀翻整个进程，必须挡掉。
  worker.on('error', () => {});

  try {
    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(flag, 0) === 0) {
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      Atomics.wait(flag, 0, 0, Math.min(remain, 250));
    }
    const status = Atomics.load(flag, 0);
    if (status === 1) {
      const length = Atomics.load(flag, 1);
      const json = Buffer.from(sab, PAYLOAD_OFFSET, length).toString('utf8');
      return { ok: true, hits: JSON.parse(json) };
    }
    if (status === 2) return { ok: false, reason: 'generic_error' };
    if (status === 3) return { ok: false, reason: 'result_too_large' };
    return { ok: false, reason: 'timeout' };
  } catch {
    return { ok: false, reason: 'bridge_error' };
  } finally {
    worker.terminate().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * 合并：id 重建 → 去重 → 排序
 * ------------------------------------------------------------------ */

/** rootPath 的去重键：d2a 的 rootPath 已是 realpath；d2b 用 evidence.realPath。 */
function realKeyOf(hit) {
  return hit?.evidence?.realPath ?? hit?.rootPath ?? '';
}

function kindRank(kind) {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

/**
 * scope 重建（队长口径）：rootPath 里的 profiles/<名>/ 一段。
 * d2a 直接给了 evidence.profileName 时优先用它（声明未安装的依赖也拿得到）。
 */
function scopeOf(hit) {
  const declared = hit?.evidence?.profileName;
  if (typeof declared === 'string' && declared !== '') return declared;
  const match = String(hit?.rootPath ?? '').match(/\/profiles\/([^/]+)\//);
  return match ? match[1] : null;
}

/** id 重建：`dsh-plugin:<scope>/<包名>`；截不出 scope 就保留 d2a 原 id。 */
function rebuildId(hit) {
  if (hit?.kind !== 'dsh-plugin') return { id: hit.id, sourceId: null };
  const scope = scopeOf(hit);
  if (scope === null) return { id: hit.id, sourceId: hit.id };
  const suffix = hit.evidence?.matchedName ?? hit.id;
  const id = `dsh-plugin:${scope}/${suffix}`;
  return { id, sourceId: hit.id };
}

/**
 * 合并两路结果：
 *   1) 同 kind 同 rootPath = 同一条鱼被两路各报一次 → 留一条，id 记 mergedIds；
 *   2) 同 rootPath 跨 kind（现行两路探测不可达）→ 留 kind 更具体的那条；
 *   3) 按 kind（具体在前）+ id 排序。
 */
function mergeResults(dshHits, genericHits) {
  const byKindPath = new Map();
  const out = [];

  for (const raw of [...dshHits, ...genericHits]) {
    const { id, sourceId } = rebuildId(raw);
    const hit = { ...raw, id };
    if (sourceId !== null && sourceId !== id) {
      hit.evidence = { ...hit.evidence, sourceId };
    }
    const key = `${hit.kind}\u0000${realKeyOf(hit)}`;
    const prev = byKindPath.get(key);
    if (prev !== undefined) {
      const mergedIds = [...(prev.evidence.mergedIds ?? [])];
      if (!mergedIds.includes(hit.id)) mergedIds.push(hit.id);
      prev.evidence.mergedIds = mergedIds;
      continue;
    }
    byKindPath.set(key, hit);
    out.push(hit);
  }

  // 兜底 2）：同一 rootPath 跨 kind 撞车只留更具体的那条，留痕不吞。
  const byPath = new Map();
  for (const hit of out) {
    const pathKey = realKeyOf(hit);
    const prev = byPath.get(pathKey);
    if (prev === undefined) {
      byPath.set(pathKey, hit);
      continue;
    }
    const [keep, drop] = kindRank(hit.kind) < kindRank(prev.kind) ? [hit, prev] : [prev, hit];
    keep.evidence.mergedIds = [...new Set([
      ...(keep.evidence.mergedIds ?? []),
      drop.id,
      ...(drop.evidence.mergedIds ?? []),
    ])];
    out.splice(out.indexOf(drop), 1);
  }

  out.sort((a, b) => {
    const rankDiff = kindRank(a.kind) - kindRank(b.kind);
    if (rankDiff !== 0) return rankDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 聚合两路探测，同步返回鱼清单（永不抛）。
 * @param {object} [options] 见文件头契约。
 * @returns {Array<{id:string, kind:string, rootPath:string, evidence:object, reason?:string}>}
 *   附加属性 `degraded`：[{scope, reason}]，generic 一路降级时非空。
 */
export function discoverPonds(options = {}) {
  const degraded = [];

  let dshHits = [];
  try {
    dshHits = discoverDshPlugins({ dshHome: options?.dshHome, env: options?.env }) ?? [];
  } catch {
    // d2a 自带「永不抛」，这里只是双保险：塌了也不能掀翻整场体检。
    degraded.push({ scope: 'dsh-plugin', reason: 'probe_error' });
  }

  let genericHits = [];
  const bridge = runGenericSync(genericOptionsOf(options), scanTimeoutMsOf(options));
  if (bridge.ok) {
    genericHits = bridge.hits ?? [];
  } else {
    degraded.push({ scope: 'generic', reason: bridge.reason });
  }

  const merged = mergeResults(dshHits, genericHits);
  merged.degraded = degraded;
  return merged;
}

export default discoverPonds;
