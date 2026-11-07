/**
 * pond-check · 源码守卫（tests/source-guards.test.mjs）
 *
 * 这个文件钉的是**项目的红线**，不是功能：
 *   1. 不联网        —— rules.json policy.noNetworkModules 必须被真的执行，不能只是声明
 *   2. 不执行黑名单  —— policy.forbiddenExec 同理
 *   3. unknown 不许冒充绿 —— D8-H4：把 unknown 灯改绿，114 个用例全绿，一条都没红
 *   4. JSON 脱敏不许失效 —— 同上，改了也没人发现
 *   5. 写文件边界    —— 诊断层只读；能力层只写 ~/.pond，不许写进仓库
 *
 * v0.2 C1 起能力层（src/shared 起）出现，第 1、5 条按**层**拆开：
 *   - 诊断层（cli / discover / read / evaluate / render）：不联网、不写盘，一条不让；
 *   - 能力层（shared / memory / wake / tts / image）：允许写状态、允许用内置 fetch；
 *     但网络模块（node:http 等）仍然**全域**禁止（规格要求「网络用内置 fetch」，
 *     第 1 条守卫照旧覆盖能力层），且写盘不许越过 POND_HOME 落进仓库（行为快照断言）。
 * 拆层不是放宽：任一侧的断言都比「一刀切」更准确，而且新目录默认落进诊断层
 * （fail-closed），想当能力层必须显式进 CAPABILITY_DIRS 白名单并同时接受能力层约束。
 *
 * 为什么单独一个文件：D8c 审查用变异测试证明，判定层的红线有测试守，渲染层的红线
 * **一条守卫都没有**。这类缺口不会自己暴露，只能靠源码扫描 + 行为断言提前钉死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendAttempt } from '../src/shared/events.mjs';
import { renderHtml } from '../src/render/html.mjs';
import { renderJson } from '../src/render/json.mjs';
import { renderText } from '../src/render/text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const RULES = JSON.parse(fs.readFileSync(path.join(SRC, 'rules.json'), 'utf8'));

/** 递归收集 src 下所有 .mjs。 */
function collectSources(dir = SRC) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSources(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const SOURCES = collectSources().map((file) => ({
  relative: path.relative(ROOT, file),
  text: fs.readFileSync(file, 'utf8'),
}));

/**
 * 能力层目录白名单（CAPABILITIES-SPEC §1 的包结构）。
 * 不在这张表里的 src 目录一律按**诊断层**对待 —— fail-closed：
 * 新加一个目录不会自动获得写盘/联网许可，必须在两处显式登记。
 */
const CAPABILITY_DIRS = Object.freeze(['shared', 'memory', 'wake', 'tts', 'image']);

/** @param {string} relative 形如 'src/shared/events.mjs' */
function isCapabilitySource(relative) {
  const segments = path.relative(SRC, path.resolve(ROOT, relative)).split(path.sep);
  return segments.length > 1 && CAPABILITY_DIRS.includes(segments[0]);
}

/* ------------------------------------------------------------------ *
 * 1. 不联网（policy.noNetworkModules 必须真的被执行）
 * ------------------------------------------------------------------ */

test('红线·不联网：src 里不许 import 任何网络模块', () => {
  const banned = RULES.policy?.noNetworkModules ?? [];
  assert.ok(banned.length > 0, 'rules.json 的 policy.noNetworkModules 是空的，守卫失去意义');

  const violations = [];
  for (const { relative, text } of SOURCES) {
    for (const spec of banned) {
      // 匹配 `from 'node:http'` / `import('node:http')` / `require('node:http')`
      const pattern = new RegExp(`['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'u');
      if (pattern.test(text)) violations.push(`${relative} import 了 ${spec}`);
    }
  }
  assert.deepEqual(violations, [], `发现网络模块引用：\n${violations.join('\n')}`);
});

test('红线·诊断层不联网：check 侧不许出现 fetch / WebSocket 这类运行时出网入口', () => {
  const violations = [];
  for (const { relative, text } of SOURCES) {
    if (isCapabilitySource(relative)) continue;
    // 允许出现在注释里，所以只查「调用形态」
    if (/\bfetch\s*\(/u.test(text)) violations.push(`${relative} 调用了 fetch()`);
    if (/\bnew\s+WebSocket\s*\(/u.test(text)) violations.push(`${relative} 创建了 WebSocket`);
  }
  assert.deepEqual(violations, [], `诊断层出现了出网调用（能力层之外必须离线）：\n${violations.join('\n')}`);
});

/* ------------------------------------------------------------------ *
 * 2. 不执行黑名单命令
 * ------------------------------------------------------------------ */

test('红线·不外执行：src 里不许出现 policy.forbiddenExec 里的 shell', () => {
  const banned = RULES.policy?.forbiddenExec ?? [];
  assert.ok(banned.length > 0, 'rules.json 的 policy.forbiddenExec 是空的，守卫失去意义');

  const violations = [];
  for (const { relative, text } of SOURCES) {
    // 只查被当作可执行文件名的写法：'sh' / "bash" / spawn('cmd')
    for (const cmd of banned) {
      const pattern = new RegExp(`(spawn|exec|execFile|execSync)\\s*\\(\\s*['"]${cmd}['"]`, 'u');
      if (pattern.test(text)) violations.push(`${relative} 试图执行 ${cmd}`);
      // 数组形态：spawn(cmd, [...]) 里的第一项
      const arrayPattern = new RegExp(`[\\[{,]\\s*['"]${cmd}['"]\\s*[,\\]]`, 'u');
      if (arrayPattern.test(text)) violations.push(`${relative} 的 exec 参数里出现 ${cmd}`);
    }
  }
  assert.deepEqual(violations, [], `发现黑名单命令：\n${violations.join('\n')}`);
});

/* ------------------------------------------------------------------ *
 * 3. unknown 不许冒充绿（D8-H4）
 * ------------------------------------------------------------------ */

/** 造一条六格全 unknown 的鱼。 */
function unknownFishReport() {
  const cell = {
    level: 'unknown',
    severity: 'unknown',
    value: null,
    unit: null,
    evidence: { reason: 'not_found', missing: ['log'] },
    phenomenon: '读不到日志。',
    nextStep: '用 --root 指明她的窝。',
    degraded: [],
  };
  return {
    schemaVersion: 1,
    meta: { generatedAt: new Date().toISOString(), pondCheckVersion: '0.1.0', scanCount: 1 },
    host: { platform: 'linux', node: process.versions.node },
    fishes: [{
      id: 'shadow-fish',
      kind: 'unknown',
      kindNameZh: '未识别',
      name: 'shadow-fish',
      stateRoot: '/tmp/shadow-fish',
      processes: [],
      indicators: {
        liveness: { ...cell }, rhythm: { ...cell }, throughput: { ...cell },
        health: { ...cell }, deps: { ...cell }, drift: { ...cell },
      },
      severity: 'unknown',
      bucket: 'unknown',
      worstIndicator: 'liveness',
      headline: '存活 判不出',
      fixes: [],
      fixesShort: [],
      degraded: [],
      notes: [],
    }],
    summary: { fish: 1, ok: 0, watch: 0, bad: 0, unknown: 6 },
    fishBuckets: { ok: 0, watch: 0, bad: 0, unknown: 1 },
    traceCounts: { none: 1, unreadable: 0, present: 0 },
    bucketNote: null,
    traceNote: null,
    verdict: '1 条鱼 · 0 正常 · 0 要注意 · 0 坏了 · 6 判不出',
    nextAction: '用 --root 指明她的窝。',
    footnote: '6 项数据读不到。',
    degradedCount: 6,
    skippedSensitive: { count: 0, names: [] },
  };
}

test('红线·unknown 不许冒充绿：HTML 里 unknown 的卡片必须是 unknown 样式', () => {
  const html = renderHtml(unknownFishReport());

  // 卡片类名必须是 card-unknown
  assert.ok(html.includes('card-unknown'), 'unknown 的鱼没有用 card-unknown 类名');

  // 状态灯必须是 light-unknown，且不许同时出现 light-ok
  assert.ok(html.includes('light-unknown'), 'unknown 没有用 light-unknown 状态灯');
  assert.equal(
    /card-unknown[\s\S]{0,400}?light-ok/u.test(html),
    false,
    'unknown 的卡片里出现了 light-ok —— 灰的冒充成绿的了（D8-H4 那个变异）',
  );

  // 六格小卡也不许有一个是 ok
  assert.equal(
    /chip-unknown[\s\S]{0,200}?chip-ok/u.test(html),
    false,
    'unknown 的指标小卡里出现了 chip-ok',
  );
});

test('红线·unknown 不许冒充绿：文本摘要里 unknown 不能穿 ✅', () => {
  const text = renderText(unknownFishReport());
  assert.equal(text.includes('✅'), false, 'unknown 的鱼在文本里穿了绿勾');
  assert.ok(text.includes('❓'), 'unknown 的鱼没有穿 ❓');
});

/* ------------------------------------------------------------------ *
 * 4. JSON 脱敏不许失效
 * ------------------------------------------------------------------ */

test('红线·JSON 脱敏：凭证路径必须被替换，修复话术必须保留', () => {
  const report = unknownFishReport();
  // 两种输入要得到两种结果：纯路径必须脱敏，纯话术必须保留。
  // 注意：**含中文的整句按设计不脱敏**（避免把人话吃掉），所以这里用纯路径形态。
  report.fishes[0].fixes = [
    '把新的 cookie/token 存回原处',   // 话术：必须保留
    '/home/u/.ssh/id_ed25519',        // 纯路径：必须脱敏
    '~/.npmrc',                       // 纯路径：必须脱敏
  ];

  const rendered = renderJson(report);

  assert.ok(
    rendered.includes('把新的 cookie/token 存回原处'),
    '脱敏把修复话术也吃掉了 —— 用户会失去「怎么修」的提示',
  );
  assert.equal(
    rendered.includes('id_ed25519'),
    false,
    'fixes 里的凭证路径没被脱敏 —— 这是零泄漏红线（长版曾漏，短版没漏）',
  );
  assert.equal(
    rendered.includes('.npmrc'),
    false,
    'fixes 里的 .npmrc 没被脱敏',
  );
});

/* ------------------------------------------------------------------ *
 * 5. 写文件边界（诊断层只读 / 能力层不许写进仓库）
 * ------------------------------------------------------------------ */

test('红线·诊断层只读：cli / discover / read / evaluate / render 不许写文件', () => {
  const writePattern = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|unlink|unlinkSync|rmSync|rename|renameSync)\s*\(/u;
  const violations = [];
  for (const { relative, text } of SOURCES) {
    if (relative.endsWith(path.join('src', 'cli.mjs'))) continue; // 报告输出，唯一例外
    if (isCapabilitySource(relative)) continue;                    // 能力层另有约束（见下一条）
    if (writePattern.test(text)) violations.push(relative);
  }
  assert.deepEqual(
    violations,
    [],
    `诊断层在写磁盘 —— 只读铁律只允许 cli.mjs 写报告：\n${violations.join('\n')}`,
  );
});

test('红线·能力层写盘不许越过 POND_HOME 落进仓库', () => {
  // 静态扫描抓不到「路径算错了」这种错，所以这里跑一次真实写入，比对仓库快照。
  // 变异验证：把 events.mjs 的目标路径改成写进仓库，本用例必红。
  const snapshot = () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const info = fs.statSync(full);
          files.push(`${path.relative(ROOT, full)}:${info.size}:${info.mtimeMs}`);
        }
      }
    };
    walk(ROOT);
    return files.sort();
  };

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-guard-home-'));
  const before = snapshot();
  return appendAttempt(
    { capability: 'tts', provider: 'guard-probe', units: 1, ok: true },
    { env: { POND_HOME: tempHome } },
  ).then((result) => {
    const after = snapshot();
    fs.rmSync(tempHome, { recursive: true, force: true });
    assert.equal(result.written, true, '守卫探针自己的写入失败了，快照断言无意义');
    assert.deepEqual(after, before, '能力层写盘越过了 POND_HOME，落进了仓库');
  });
});

/* ------------------------------------------------------------------ *
 * 6. unknown 灯色不许偏绿（D8-H4 假闭环修复）
 *
 * 上面那条查的是 class 名 —— 复审指出这是假闭环：把 `--unknown` 的色值
 * 从灰改成绿，121 个用例照样全绿，而 `.light-unknown { background: var(--unknown) }`
 * 说明这个变量就是灯的颜色。所以必须直接查色值。
 * ------------------------------------------------------------------ */

/** 把 #rgb / #rrggbb 解析成 [r,g,b]。 */
function parseHexColor(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (/^#[0-9a-fA-F]{3}$/u.test(value)) {
    return [1, 2, 3].map((i) => Number.parseInt(value[i] + value[i], 16));
  }
  if (/^#[0-9a-fA-F]{6}$/u.test(value)) {
    return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
  }
  return null;
}

test('红线·unknown 灯色不许偏绿（颜色层，不是 class 名）', () => {
  const htmlSource = fs.readFileSync(path.join(SRC, 'render', 'html.mjs'), 'utf8');

  const grab = (name) => {
    const matched = htmlSource.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'u'));
    return matched ? matched[1] : null;
  };

  const unknownColor = grab('unknown');
  const okColor = grab('ok');
  assert.ok(unknownColor, '找不到 --unknown 颜色变量，守卫无从判断');
  assert.ok(okColor, '找不到 --ok 颜色变量');

  // 1) unknown 与 ok 不能是同一个颜色
  assert.notEqual(
    unknownColor.toLowerCase(),
    okColor.toLowerCase(),
    'unknown 和 ok 用了同一个色值 —— 灰的会冒充成绿的',
  );

  // 2) unknown 不能落在绿色系（g 明显压过 r 与 b）
  const rgb = parseHexColor(unknownColor);
  assert.ok(rgb, `--unknown 的色值 ${unknownColor} 解析不了`);
  const [r, g, b] = rgb;
  assert.equal(
    g > r + 20 && g > b + 20,
    false,
    `--unknown 色值 ${unknownColor} 偏绿（rgb ${r},${g},${b}）—— 变异测试里那个「灰改绿」会重新骗过所有用例`,
  );
});

test('红线·ok 灯色必须真是绿系（反过来也要成立）', () => {
  const htmlSource = fs.readFileSync(path.join(SRC, 'render', 'html.mjs'), 'utf8');
  const okColor = htmlSource.match(/--ok:\s*(#[0-9a-fA-F]{3,8})/u)?.[1];
  assert.ok(okColor, '找不到 --ok 颜色变量');
  const rgb = parseHexColor(okColor);
  assert.ok(rgb, `--ok 的色值 ${okColor} 解析不了`);
  const [r, g, b] = rgb;
  assert.ok(
    g > r + 20 && g > b + 20,
    `--ok 色值 ${okColor} 竟然不是绿系（rgb ${r},${g},${b}）—— 两条红线一起失灵了`,
  );
});
