/**
 * pond-check · D5 收口测试（tests/render.test.mjs）
 *
 * 覆盖三件事（任务契约）：
 *   1. 三种渲染的结构断言（HTML / 文本 / JSON）；
 *   2. HTML 无外部资源引用断言（/(src|href)="https?:/ 一个都不许有）+
 *      文本摘要长度上限断言（一屏，不许把 50 条鱼全糊脸上）；
 *   3. CLI 参数解析断言（--root / --fish / --out / --json / --text / 用法错误）
 *      + runCli 行为断言（deps 注入假管线，不扫真机）。
 *
 * 口径：CLI 各环节可注入（src/cli.mjs 的 runCli 第二参数），这里用假的
 * discover/readAll + 真的 evaluate/渲染器做集成断言，快且不受真机状态影响。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import renderHtml from '../src/render/html.mjs';
import renderText from '../src/render/text.mjs';
import renderJson, { buildJsonReport } from '../src/render/json.mjs';
import evaluate from '../src/evaluate/index.mjs';
import { parseCliArgs, runCli, USAGE } from '../src/cli.mjs';

/* ------------------------------------------------------------------ *
 * 夹具：按 D4 契约拼 Report（六格键恰好是那六个）
 * ------------------------------------------------------------------ */

const CELL_META = {
  liveness: { nameZh: '存活', unit: 'sec' },
  rhythm: { nameZh: '节律', unit: 'days' },
  throughput: { nameZh: '工作量', unit: 'count' },
  health: { nameZh: '健康', unit: 'count' },
  deps: { nameZh: '依赖', unit: 'count' },
  drift: { nameZh: '漂移', unit: 'version' },
};

const SEVERITY_LEVEL = { ok: 'active', watch: 'slack', bad: 'dead', unknown: 'unknown' };

function makeCell(id, severity) {
  const meta = CELL_META[id];
  return {
    id,
    nameZh: meta.nameZh,
    level: SEVERITY_LEVEL[severity],
    severity,
    value: severity === 'unknown' ? null : 1,
    unit: meta.unit,
    evidence: { missing: severity === 'unknown' ? ['log'] : [] },
    phenomenon: `${meta.nameZh}这一格的诊断原话。`,
    nextStep: severity === 'ok' ? '不用动。' : `先修 ${meta.nameZh}。`,
    degraded: severity === 'unknown' ? [{ indicator: id, reason: 'no_log', missing: ['log'] }] : [],
  };
}

function makeFish(index, severity, overrides = {}) {
  const indicators = {};
  for (const id of Object.keys(CELL_META)) indicators[id] = makeCell(id, severity);
  return {
    id: `fish-${index}`,
    kind: 'dsh',
    kindNameZh: 'DSH 插件',
    name: `DSH · fish-${index}`,
    stateRoot: `/home/u/pond/fish-${index}`,
    processes: [],
    indicators,
    severity,
    worstIndicator: severity === 'ok' ? 'liveness' : 'deps',
    headline: '存活 活跃 · 节律 规律 · 工作量 在干活 · 健康 干净 · 依赖 齐了 · 漂移 对齐',
    fixes: severity === 'ok' ? [] : [`先修 fish-${index} 的依赖。`],
    degraded: severity === 'unknown'
      ? Object.keys(CELL_META).map((id) => ({ indicator: id, reason: 'no_log', missing: ['log'] }))
      : [],
    notes: [],
    ...overrides,
  };
}

function makeReport(severities) {
  const fishes = severities.map((severity, index) => makeFish(index, severity));
  const counts = { ok: 0, watch: 0, bad: 0, unknown: 0 };
  for (const fish of fishes) counts[fish.severity] += 1;
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-07T12:00:00.000Z',
    host: { platform: 'linux', node: '22.23.4' },
    fishes,
    summary: {
      fish: fishes.length,
      ok: counts.ok * 6,
      watch: counts.watch * 6,
      bad: counts.bad * 6,
      unknown: counts.unknown * 6,
    },
    verdict: `${fishes.length} 条鱼 · ${counts.ok * 6} 正常 · ${counts.watch * 6} 要注意 · `
      + `${counts.bad * 6} 坏了 · ${counts.unknown * 6} 判不出`,
    nextAction: fishes.find((fish) => fish.fixes.length > 0)?.fixes[0] ?? '不用管，继续养。',
    footnote: null,
    degradedCount: 0,
    skippedSensitive: { count: 0, names: '[凭证文件已跳过]' },
  };
}

/** 假 PondRead：字段形状对齐 D3 契约，内容全缺 —— evaluate 会诚实判 unknown。 */
function fakeRead(id, rootPath) {
  const missingSource = { status: 'missing', reason: 'missing' };
  return {
    id,
    kind: 'dsh-plugin',
    rootPath,
    ok: true,
    now: Date.now(),
    paths: { log: null, config: null, packageJson: null, dedupe: null, sessionDir: null, probeRoots: [] },
    sources: { log: missingSource, config: missingSource, dedupe: missingSource, sessions: missingSource },
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
    degraded: [],
    notes: [],
  };
}

/** 一套可断言的假管线：stdout/stderr/写盘全部收集，discover/readAll 可观察。 */
function makeHarness(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const files = new Map();
  const seenPonds = [];
  const deps = {
    discover: () => [
      { id: 'dsh-plugin:web/alpha', kind: 'dsh-plugin', rootPath: '/ponds/alpha', evidence: {} },
      { id: 'dsh-plugin:web/beta', kind: 'dsh-plugin', rootPath: '/ponds/beta', evidence: {} },
    ],
    readAll: async (ponds) => {
      seenPonds.push(...ponds);
      return ponds.map((pond) => fakeRead(pond.id ?? 'root', pond.rootPath));
    },
    // 默认用真的 evaluate —— 假读取 × 真判定 × 真渲染，结构断言才有意义
    evaluate,
    renderHtml,
    renderText,
    renderJson,
    writeFile: (file, data) => files.set(file, String(data)),
    stdout: (text) => stdout.push(String(text)),
    stderr: (text) => stderr.push(String(text)),
    cwd: '/virtual/cwd',
    now: Date.parse('2026-11-07T20:30:00+08:00'),
    ...overrides,
  };
  return { deps, stdout, stderr, files, seenPonds };
}

/* ------------------------------------------------------------------ *
 * 1. HTML 渲染结构
 * ------------------------------------------------------------------ */

test('HTML：结构完整（doctype/viewport/卡片/六指标/底部声明）', () => {
  const report = makeReport(['ok', 'bad']);
  const html = renderHtml(report);
  assert.ok(html.startsWith('<!doctype html>'), '缺 doctype');
  assert.ok(html.includes('name="viewport"'), '缺 viewport meta');
  assert.ok(html.includes('鱼况体检报告'), '缺标题');
  // D8c 弱断言 #8：光断言「标签/字符串出现过」证明不了渲染对得上报告。
  // 数量一律从 report 推，且每条鱼的名字都必须真的出现在 HTML 里。
  assert.equal(
    html.split('<span class="chip-name">').length - 1,
    report.fishes.length * 6,
    '六指标小卡数量必须等于 鱼数 × 6',
  );
  assert.equal(
    html.split('<article class="card').length - 1,
    report.fishes.length,
    '鱼卡数量必须等于报告里的鱼数',
  );
  for (const fish of report.fishes) {
    assert.ok(html.includes(fish.name), `HTML 漏了这条鱼的名字：${fish.name}`);
  }
  assert.ok(html.includes('本报告只读、不联网、无遥测。'), '缺底部声明');
});

test('HTML：零外部资源引用（验收门正则 + 更严的全量扫）', () => {
  for (const report of [makeReport(['ok', 'bad', 'unknown']), makeReport([])]) {
    const html = renderHtml(report);
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), '出现外链 src/href');
    assert.ok(!/<(script|link|img)\b/i.test(html), '出现 script/link/img 标签');
    assert.ok(!/https?:\/\//i.test(html), '出现 http(s) 字面量');
    assert.ok(!/@import\b/i.test(html), '出现 CSS @import');
  }
  // 兜底页（乱参数）同样零外链、带声明
  for (const bad of [null, undefined, '垃圾{', [], { fishes: 'x' }]) {
    const html = renderHtml(bad);
    assert.ok(!/https?:\/\//i.test(html), '兜底页出现 http 字面量');
    assert.ok(html.includes('本报告只读、不联网、无遥测。'), '兜底页缺声明');
  }
});

test('HTML：注入文本被转义，不许变成标签', () => {
  const report = makeReport(['bad']);
  report.fishes[0].indicators.deps.phenomenon = '看看 <script>alert(1)</script> 和 <b>x</b>';
  const html = renderHtml(report);
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), '注入没转义');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '转义后应可见');
});

/* ------------------------------------------------------------------ *
 * 2. 文本摘要结构
 * ------------------------------------------------------------------ */

test('文本：统计行口径固定（共 N 条，活跃/疲软/死了/认不出）', () => {
  const text = renderText(makeReport(['ok', 'bad']));
  assert.ok(text.includes('共 2 条，活跃 1 / 疲软 0 / 死了 1 / 认不出 0。'), '统计行不对');
  assert.ok(text.includes('→ 最该做：'), '缺最该做一行');
  assert.ok(text.startsWith('🐟 pond-check'), '缺首行');
});

test('文本：长度上限 —— 50 条鱼也只出一屏（行数与字符数双上限）', () => {
  const severities = Array.from({ length: 50 }, (_, i) => ['ok', 'watch', 'bad', 'unknown'][i % 4]);
  const text = renderText(makeReport(severities));
  const lines = text.split('\n');
  assert.ok(lines.length <= 26, `行数超一屏：${lines.length}`);
  assert.ok(text.length <= 6000, `字符数超上限：${text.length}`);
  // 截断提示必须在，且统计仍然按全部 50 条计（ok 13 / watch 13 / bad 12 / unknown 12）
  assert.ok(text.includes('… 还有 30 条没展开'), '缺截断提示');
  assert.ok(text.includes('共 50 条，活跃 13 / 疲软 13 / 死了 12 / 认不出 12。'), '统计没按全部鱼计');
  // 不许把终端撕裂：无 ANSI 转义
  assert.ok(!/\x1b\[/.test(text), '出现 ANSI 转义');
});

/* ------------------------------------------------------------------ *
 * 3. JSON 渲染结构
 * ------------------------------------------------------------------ */

test('JSON：顶层字段序固定、可回读、meta 齐全', () => {
  const report = makeReport(['ok', 'watch']);
  const json = renderJson(report);
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(buildJsonReport(report)), [
    'schemaVersion', 'meta', 'host', 'fishes', 'summary',
    'fishBuckets', 'traceCounts', 'bucketNote', 'traceNote',
    'verdict', 'nextAction', 'footnote', 'degradedCount', 'skippedSensitive',
  ]);
  assert.equal(parsed.meta.scanCount, 2);
  assert.equal(typeof parsed.meta.pondCheckVersion, 'string');
  assert.equal(parsed.meta.generatedAt, report.generatedAt);
  assert.equal(parsed.fishes[0].indicators.liveness.nameZh, '存活');
});

test('JSON：同内容不同属性顺序 → 逐字节一致（结构稳定）', () => {
  // 深度倒序所有 key：内容一个字节没变，只动属性顺序
  const reorder = (value) => {
    if (Array.isArray(value)) return value.map(reorder);
    if (value !== null && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).reverse()) out[key] = reorder(value[key]);
      return out;
    }
    return value;
  };
  const report = makeReport(['bad']);
  assert.equal(renderJson(reorder(report)), renderJson(report));
});

/* ------------------------------------------------------------------ *
 * 4. CLI 参数解析
 * ------------------------------------------------------------------ */

test('CLI 解析：--root / --fish / --out / --json 各归其位', () => {
  const parsed = parseCliArgs(['--root', '/ponds/alpha', '--fish', 'alpha', '--out', 'r.html']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, 'html');
  assert.equal(parsed.root, '/ponds/alpha');
  assert.equal(parsed.fish, 'alpha');
  assert.equal(parsed.out, 'r.html');

  assert.equal(parseCliArgs(['--json']).mode, 'json');
  assert.equal(parseCliArgs(['--text']).mode, 'text');
  assert.equal(parseCliArgs(['--help']).mode, 'help');
  assert.equal(parseCliArgs([]).mode, 'html');
});

test('CLI 解析：缺值 / 未知项 / --json 与 --text 并用都是用法错误', () => {
  for (const argv of [['--out'], ['--root'], ['--fish'], ['--root', '--fish', 'x']]) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.ok, false, `应报错：${argv.join(' ')}`);
    assert.ok(parsed.errors.length > 0);
  }
  const both = parseCliArgs(['--json', '--text']);
  assert.equal(both.ok, false);
  assert.ok(both.errors.some((message) => message.includes('二选一')));

  const unknown = parseCliArgs(['--wat']);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors[0].includes('不认识的参数'));

  // --help 永远好使
  assert.equal(parseCliArgs(['--help', '--wat']).mode, 'help');
});

test('CLI 用法：USAGE 含 --root（验收门）', () => {
  assert.ok(USAGE.includes('--root'));
  assert.ok(USAGE.includes('--fish'));
});

/* ------------------------------------------------------------------ *
 * 5. runCli 行为（假管线注入，不扫真机）
 * ------------------------------------------------------------------ */

test('runCli 默认：写 HTML 到 cwd、stdout 只打印文件路径、退出码 0', async () => {
  const { deps, stdout, files } = makeHarness();
  const code = await runCli([], deps);
  assert.equal(code, 0);
  assert.equal(files.size, 1);
  const [target, html] = [...files.entries()][0];
  assert.ok(target.startsWith('/virtual/cwd/pond-check-'), `默认路径不对：${target}`);
  assert.equal(stdout.join(''), `${target}\n`);
  assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), '生成的 HTML 出现外链');
});

test('runCli --out：HTML 写到指定路径（相对路径按 cwd 解析）', async () => {
  const { deps, stdout, files } = makeHarness();
  const code = await runCli(['--out', 'reports/my.html'], deps);
  assert.equal(code, 0);
  assert.equal(files.size, 1);
  const [target, html] = [...files.entries()][0];
  assert.equal(target, '/virtual/cwd/reports/my.html');
  assert.equal(stdout.join(''), `${target}\n`);
  assert.ok(html.startsWith('<!doctype html>'), '写出去的应是 HTML');
});

test('runCli --json：stdout 只有 JSON（可回读），--out 被忽略并留话', async () => {
  const { deps, stdout, stderr, files } = makeHarness();
  const code = await runCli(['--json', '--out', 'x.html'], deps);
  assert.equal(code, 0);
  assert.equal(files.size, 0, '--json 不该写文件');
  const out = stdout.join('');
  const parsed = JSON.parse(out);
  assert.equal(parsed.meta.scanCount, 2);
  assert.ok(out.endsWith('}\n'), 'JSON 应以一个换行收尾');
  assert.ok(stderr.join('').includes('--out 已忽略'), '没提示 --out 被忽略');
});

test('runCli --text：stdout 只有文本摘要，结尾恰好一个换行', async () => {
  const { deps, stdout } = makeHarness();
  const code = await runCli(['--text'], deps);
  assert.equal(code, 0);
  const out = stdout.join('');
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'), '结尾换行数量不对');
  assert.ok(out.includes('共 2 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 2。'), '统计行不对');
});

test('runCli --root：只体检这个窝（替换语义，不带自动扫的别的鱼）', async () => {
  const { deps, seenPonds, files } = makeHarness();
  const code = await runCli(['--root', '/ponds/gamma'], deps);
  assert.equal(code, 0);
  assert.equal(seenPonds.length, 1, '应只体检 1 条鱼');
  assert.equal(seenPonds[0].rootPath, '/ponds/gamma');
  assert.ok(String(seenPonds[0].id).startsWith('root:'), 'id 应是 root: 前缀');
  assert.equal(files.size, 1);
});

test('runCli --root 与自动扫撞窝：复用自动扫那条（带 evidence，不造重复卡）', async () => {
  const seen = [];
  const { deps } = makeHarness({
    readAll: async (ponds) => {
      seen.push(...ponds);
      return ponds.map((pond) => fakeRead(pond.id, pond.rootPath));
    },
  });
  await runCli(['--root', '/ponds/alpha'], deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 'dsh-plugin:web/alpha', '应复用自动扫的鱼（带 evidence）');
});

test('runCli --fish：按名字过滤（id / 窝路径 / 目录名，不区分大小写）', async () => {
  for (const needle of ['alpha', 'BETA', 'ponds/beta']) {
    const { deps, seenPonds } = makeHarness();
    const code = await runCli(['--fish', needle], deps);
    assert.equal(code, 0);
    assert.equal(seenPonds.length, 1, `--fish ${needle} 应过滤到 1 条`);
  }
  const { deps, seenPonds } = makeHarness();
  await runCli(['--fish', 'alpha', '--root', '/ponds/alpha'], deps);
  assert.equal(seenPonds.length, 1, '--root + --fish 连用');
});

test('runCli --fish 没匹配到：退出码 0 + stderr 说清扫到了什么', async () => {
  const { deps, stderr, files } = makeHarness();
  const code = await runCli(['--fish', '不存在的鱼'], deps);
  assert.equal(code, 0);
  assert.ok(stderr.join('').includes('没找到叫「不存在的鱼」的鱼'), '没提示没找到');
  assert.ok(stderr.join('').includes('dsh-plugin:web/alpha'), '没列出扫到的鱼');
  assert.equal(files.size, 1, '空结果也要出报告（HTML 空态）');
});

test('runCli 扫到 0 条鱼：退出码照旧 0，HTML 照出（空态）', async () => {
  const { deps, files } = makeHarness({ discover: () => [] });
  const code = await runCli([], deps);
  assert.equal(code, 0);
  assert.equal(files.size, 1);
});

test('runCli 真异常（管线整段崩）：退出码 1 + stderr 说人话', async () => {
  const { deps, stderr } = makeHarness({
    evaluate: () => {
      throw new Error('聚合炸了');
    },
  });
  const code = await runCli(['--text'], deps);
  assert.equal(code, 1);
  assert.ok(stderr.join('').includes('真异常'), '没说清是真异常');
});

test('runCli --help：退出码 0 且用法含 --root（验收门）', async () => {
  const { deps, stdout } = makeHarness();
  const code = await runCli(['--help'], deps);
  assert.equal(code, 0);
  assert.ok(stdout.join('').includes('--root'), '用法里没有 --root');
});

test('runCli 用法错误：退出码 2，stdout 干净', async () => {
  for (const argv of [['--json', '--text'], ['--out'], ['--nope']]) {
    const { deps, stdout } = makeHarness();
    const code = await runCli(argv, deps);
    assert.equal(code, 2, `应退出 2：${argv.join(' ')}`);
    assert.equal(stdout.join(''), '', '用法错误不该往 stdout 打东西');
  }
});
