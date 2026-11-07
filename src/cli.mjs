#!/usr/bin/env node
/**
 * pond-check · D5 收口：CLI 入口（src/cli.mjs）
 *
 * 职责：把 D2（探测）→ D3（读取）→ D4（判定）→ D5a/b/c（渲染）串成一条命令：
 *   无参数        扫描 + 生成 HTML 到当前目录，打印文件路径
 *   --json        stdout 只输出 JSON
 *   --text        stdout 只输出可贴群文本摘要
 *   --out <路径>  指定 HTML 输出路径
 *   --root <路径> 指定鱼的窝（stateRoot）—— 逃生口：自动扫找不到她的
 *                 日志/配置/判重表时，人来指路，只体检这一个窝
 *   --log <路径>  单独指定日志文件 —— 日志不在窝里（或被起了别名）时的
 *                 更高精度逃生口；等价于 --root <她的目录> + 指定日志
 *   --dedupe <路径> 单独指定判重表 —— 名字不叫 processed/seen 之类的判重表被
 *                 自动扫漏掉时用；与 --root / --log 可任意组合
 *   --fish <名字> 只体检指定的一条鱼（按 id / 窝路径 / 目录名做不区分
 *                 大小写的子串匹配；常与 --root 连用）
 *   --help        用法
 *
 * 退出码：0 = 正常（**扫到 0 条鱼也是 0**）；2 = 参数用错；1 = 真异常
 * （读取/渲染整段崩了、HTML 写不出去）。
 *
 * 只读承诺：扫描只 stat/读文件；本工具唯一写的文件就是它自己的报告输出。
 * 不装插件、不改配置、不启停进程、不联网、无遥测。
 *
 * 测试口径：parseCliArgs / runCli 都是显式导出，runCli 的管线各环节可用
 * deps 注入假实现 —— tests/render.test.mjs 不扫真机也能断言 CLI 行为。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import discoverPonds from './discover/index.mjs';
import { readAll } from './read/index.mjs';
import evaluate from './evaluate/index.mjs';
import renderHtml from './render/html.mjs';
import renderText from './render/text.mjs';
import renderJson from './render/json.mjs';

/* ------------------------------------------------------------------ *
 * 0. 用法
 * ------------------------------------------------------------------ */

/** --help 文案。必须含 --root（验收门要求），也顺手说清退出码与只读承诺。 */
export const USAGE = `pond-check · 鱼况体检 —— 只读扫描机器上在跑的 AI Agent（「鱼」），出一页体检报告

用法：
  pond-check                  扫描 + 生成 HTML 报告到当前目录，打印文件路径
  pond-check --out <路径>     指定 HTML 报告的输出路径（只作用于 HTML）
  pond-check --json           stdout 只输出 JSON（完整报告，机器读）
  pond-check --text           stdout 只输出可贴群的文本摘要（人读）
  pond-check --root <路径>    指定鱼的窝（stateRoot）：只体检这个窝。
                              自动扫找不到她的日志/配置/判重表时的逃生口：
                              把她的目录指给体检，六格才有机会判出来。
  pond-check --log <路径>     直接指定她的日志文件：日志不在窝里、或名字不叫
                              *.log 时用这个。可与 --root 连用（窝 + 日志各指各的）。
  pond-check --dedupe <路径>  直接指定她的判重表（记录「干过哪些活」的那个文件）：
                              名字不叫 processed / seen / history 时用这个。
  pond-check --fish <名字>    只体检指定的一条鱼。按 鱼 id / 窝路径 / 目录名
                              做不区分大小写的子串匹配；常与 --root 连用。
  pond-check --help           显示本用法

退出码：0 = 正常（扫到 0 条鱼也是 0）；2 = 参数用错；1 = 真异常。

只读承诺：只读扫描、不装插件、不改配置、不启停进程、不联网、无遥测。
HTML 报告是单文件、零外链，可以直接发给别人打开。
`;

/* ------------------------------------------------------------------ *
 * 1. 参数解析（纯函数，单测直接打）
 * ------------------------------------------------------------------ */

/**
 * 解析命令行参数。
 * @param {string[]} argv 不含 node 与脚本路径的参数表
 * @returns {{ok:boolean, mode:'html'|'json'|'text'|'help', out:string|null,
 *            root:string|null, fish:string|null, errors:string[]}}
 */
export function parseCliArgs(argv) {
  const out = {
    ok: true,
    mode: 'html',
    out: null,
    root: null,
    log: null,
    dedupe: null,
    fish: null,
    errors: [],
  };
  const args = Array.isArray(argv) ? argv.filter((item) => typeof item === 'string') : [];

  let wantJson = false;
  let wantText = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.mode = 'help';
    } else if (arg === '--json') {
      wantJson = true;
    } else if (arg === '--text') {
      wantText = true;
    } else if (arg === '--out' || arg === '--root' || arg === '--log'
      || arg === '--dedupe' || arg === '--fish') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        out.errors.push(`${arg} 缺少参数值（后面要跟一个非空的值）`);
      } else {
        if (arg === '--out') out.out = value;
        else if (arg === '--root') out.root = value;
        else if (arg === '--log') out.log = value;
        else if (arg === '--dedupe') out.dedupe = value;
        else out.fish = value;
        i += 1;
      }
    } else {
      out.errors.push(`不认识的参数：${arg}（看用法：pond-check --help）`);
    }
  }

  if (wantJson && wantText) out.errors.push('--json 与 --text 只能二选一');
  if (wantJson) out.mode = 'json';
  if (wantText) out.mode = 'text';

  // --help 永远好使：就算别的参数乱七八糟，也先把用法给人看（退出码 0）
  if (out.mode === 'help') {
    out.errors = [];
    out.ok = true;
    return out;
  }
  out.ok = out.errors.length === 0;
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. 鱼清单：真扫 + --root 逃生口 + --fish 过滤
 * ------------------------------------------------------------------ */

/** 路径归一比较（只做 resolve，不跟文件系统打交道）。 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return path.resolve(left) === path.resolve(right);
}

/** --fish 匹配：鱼 id / 窝路径 / 目录名，不区分大小写子串。 */
function fishMatches(pond, name) {
  const needle = String(name).trim().toLowerCase();
  if (needle === '') return true;
  const haystacks = [pond?.id, pond?.rootPath];
  if (typeof pond?.rootPath === 'string' && pond.rootPath !== '') {
    haystacks.push(path.basename(pond.rootPath));
  }
  return haystacks.some((item) => typeof item === 'string' && item.toLowerCase().includes(needle));
}

/**
 * 组出本次要体检的鱼清单。
 *
 * --root 的语义是**替换**不是追加：逃生口场景里自动扫已经给出全 unknown 的
 * 结论，人指了窝就只体检这个窝，免得同一窝出两张卡（自动扫一张 + 手动一张）。
 * 若 --root 指的窝正好在自动扫结果里，复用那条（带 evidence，定位更准）。
 */
function buildPonds(parsed, deps, warn) {
  let discovered = [];
  try {
    const result = deps.discover({});
    if (Array.isArray(result)) discovered = result;
  } catch (err) {
    // 自动扫整段失败 ≠ 没鱼：留痕后照常走（--root 还能救）
    warn(`自动扫描失败（${String(err?.message ?? err)}）；继续走 --root / 过滤流程。`);
  }

  let ponds;
  if (typeof parsed.root === 'string' && parsed.root !== '') {
    const rootAbs = path.resolve(deps.cwd, parsed.root);
    let existed = false;
    try {
      existed = fs.statSync(rootAbs).isDirectory();
    } catch {
      existed = false;
    }
    if (!existed) {
      warn(`窝不存在（或不是目录）：${rootAbs} —— 照常体检，大概率六格都判不出。`);
    }
    const match = discovered.find((pond) => samePath(pond?.rootPath, rootAbs));
    ponds = [match ?? {
      id: `root:${rootAbs}`,
      kind: 'unknown',
      rootPath: rootAbs,
      // evidence 留空：D3 的 P2 浅列举会在窝里找日志/配置/判重表
      evidence: {},
      reason: 'manual_root',
    }];
  } else {
    ponds = discovered;
  }

  // --log / --dedupe：粒度高一级的逃生口。产物不在窝里、或名字不符合惯例时直接指文件。
  // 语义与 --root 一致是**替换**：指了就只体检这一条，免得同一个窝出两张卡。
  const pinned = {};
  for (const [key, raw] of [['log', parsed.log], ['dedupe', parsed.dedupe]]) {
    if (typeof raw !== 'string' || raw === '') continue;
    const abs = path.resolve(deps.cwd, raw);
    let isFile = false;
    try {
      isFile = fs.statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      warn(`${key === 'log' ? '日志' : '判重表'}文件不存在（或不是普通文件）：${abs} —— 照常体检，相关几格大概率判不出。`);
    }
    pinned[key] = abs;
  }

  const pinnedKeys = Object.keys(pinned);
  if (pinnedKeys.length > 0) {
    if (typeof parsed.root === 'string' && parsed.root !== '') {
      // 窝 + 产物各指各的：保留 --root 选的窝，只把指到的文件钉死
      for (const pond of ponds) {
        pond.paths = { ...(pond.paths ?? {}), ...pinned };
      }
    } else {
      const anchor = pinned.log ?? pinned.dedupe;
      const rootAbs = path.dirname(anchor);
      const match = discovered.find((pond) => samePath(pond?.rootPath, rootAbs));
      ponds = [match
        ? { ...match, paths: { ...(match.paths ?? {}), ...pinned } }
        : {
          id: `pinned:${anchor}`,
          kind: 'unknown',
          rootPath: rootAbs,
          evidence: {},
          paths: { ...pinned },
          reason: 'manual_path',
        }];
    }
  }

  let filterMiss = null;
  if (typeof parsed.fish === 'string' && parsed.fish !== '') {
    const before = ponds;
    ponds = ponds.filter((pond) => fishMatches(pond, parsed.fish));
    if (ponds.length === 0) {
      const seen = before
        .map((pond) => pond?.id ?? pond?.rootPath ?? '(无名)')
        .slice(0, 8)
        .join('、');
      warn(`没找到叫「${parsed.fish}」的鱼。本次扫到的是：${seen || '（一条都没有）'}`);
      // 过滤没命中 ≠ 没鱼：报告要说清是哪一种（D6b P7）
      filterMiss = { name: parsed.fish, scanned: before.length };
    }
  }
  return { ponds, filterMiss };
}

/* ------------------------------------------------------------------ *
 * 3. 输出
 * ------------------------------------------------------------------ */

/** 默认 HTML 文件名：pond-check-YYYYMMDD-HHMMSS.html（时间来自 deps.now）。 */
function defaultReportName(nowMs) {
  const d = new Date(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `pond-check-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.html`;
}

/* ------------------------------------------------------------------ *
 * 4. 主流程
 * ------------------------------------------------------------------ */

/**
 * 跑一次 CLI。**永不抛**：任何真异常都变成非 0 退出码 + stderr 一句话。
 *
 * @param {string[]} argv 参数表（不含 node 与脚本路径）
 * @param {object} [deps] 管线注入点（测试用；缺省走真实现）
 * @returns {Promise<number>} 进程退出码
 */
export async function runCli(argv, deps = {}) {
  const d = {
    discover: deps.discover ?? discoverPonds,
    readAll: deps.readAll ?? readAll,
    evaluate: deps.evaluate ?? evaluate,
    renderHtml: deps.renderHtml ?? renderHtml,
    renderText: deps.renderText ?? renderText,
    renderJson: deps.renderJson ?? renderJson,
    // 唯一写的文件就是自己的报告；--out 带了不存在的父目录就顺手建（只建报告自己的目录）
    writeFile: deps.writeFile ?? ((file, data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }),
    stdout: deps.stdout ?? ((text) => process.stdout.write(text)),
    stderr: deps.stderr ?? ((text) => process.stderr.write(text)),
    cwd: typeof deps.cwd === 'string' && deps.cwd !== '' ? deps.cwd : process.cwd(),
    now: Number.isFinite(deps.now) ? deps.now : Date.now(),
  };
  const say = (text) => d.stdout(String(text));
  const warn = (text) => d.stderr(`pond-check：${String(text)}\n`);

  try {
    const parsed = parseCliArgs(argv);
    if (parsed.mode === 'help') {
      say(USAGE);
      return 0;
    }
    if (!parsed.ok) {
      for (const message of parsed.errors) warn(message);
      warn('用法看这里：pond-check --help');
      return 2;
    }

    const { ponds, filterMiss } = buildPonds(parsed, d, warn);
    const reads = await d.readAll(ponds);
    const report = d.evaluate({ ponds: Array.isArray(reads) ? reads : [] }, {
      // 人已经指过路（--root / --log / --dedupe）：话术就不许再教他指一次（D6b P4 死循环）
      rootHinted: typeof parsed.root === 'string' || typeof parsed.log === 'string'
        || typeof parsed.dedupe === 'string',
      filterMiss,
    });

    if (parsed.mode === 'json') {
      if (parsed.out !== null) warn('--out 只作用于 HTML，本次 --json 输出走 stdout，--out 已忽略。');
      say(`${d.renderJson(report)}\n`);
      return 0;
    }
    if (parsed.mode === 'text') {
      if (parsed.out !== null) warn('--out 只作用于 HTML，本次 --text 输出走 stdout，--out 已忽略。');
      // renderText 不带结尾换行：这里补且只补一个（别两个都加，会多空行）
      say(`${d.renderText(report)}\n`);
      return 0;
    }

    // 默认：HTML 报告写盘 + 打印文件路径
    const target = parsed.out !== null
      ? path.resolve(d.cwd, parsed.out)
      : path.join(d.cwd, defaultReportName(d.now));
    d.writeFile(target, d.renderHtml(report));
    say(`${target}\n`);
    return 0;
  } catch (err) {
    // 真异常才走到这里（解析/管线/写盘整段崩）：退出码 1，话说清楚
    warn(`真异常，体检没跑完：${String(err?.message ?? err)}`);
    return 1;
  }
}

/* ------------------------------------------------------------------ *
 * 5. 入口守卫：被 import 时不跑，被 node 执行时才跑
 * ------------------------------------------------------------------ */

/**
 * 被 `node src/cli.mjs` 直接执行了吗？
 *
 * 注意 `npm install -g` 装出来的 `bin/pond-check` 是**符号链接**，指向
 * `node_modules/pond-check/src/cli.mjs`。这时 `process.argv[1]` 是链接本身，
 * 而 `import.meta.url` 是 Node 解析后的**真实文件**，字符串直接比会不相等 ——
 * 命令会静默退出 0、一个字都不输出（D9 集成验收实测到的坑）。
 * 所以两边都过一遍 realpath 再比。
 */
const isMainModule = (() => {
  if (typeof process.argv[1] !== 'string' || process.argv[1] === '') return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // realpath 失败（路径不存在等）→ 退回原始的字符串比较
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
})();

if (isMainModule) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

export default runCli;
