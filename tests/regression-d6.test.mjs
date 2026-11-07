/**
 * pond-check · D6 收口回归（tests/regression-d6.test.mjs）
 *
 * 这里锁的是 docs/FIELD-NOTES.md（D6b 首次使用走查）与 t14（D6a 边界压测）留下的
 * **每一条修好的缺陷**：一条缺陷至少一条用例，标题里写明是哪一项。
 *
 * 两类用例：
 *   1. 行为锁：三处口径（evaluate / 文本统计行 / HTML 四灯）必须一致，unknown 话术
 *      必须分 A/B 两种，指过窝不许再教指窝，--log / --dedupe 真能用；
 *   2. 话术扫：rules.json 里给人看的每一句，都不许教用户敲不存在的参数、不许夹英文
 *      档位词、不许缺句号。这类错误靠人走查抓不全，必须机器挡。
 *
 * 所有夹具都在 mkdtemp 里造（3 条假鱼），跑完删掉，绝不污染仓库、不依赖真机状态。
 * 需要 chmod / mkfifo 的用例在 root 或 Windows 上自动跳过 —— 不假装测过。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readPond, readAll } from '../src/read/index.mjs';
import {
  evaluate, classifyFishBucket, KEY_INDICATORS, INDICATOR_IDS,
} from '../src/evaluate/index.mjs';
import renderText, { displayWidth } from '../src/render/text.mjs';
import { renderHtml } from '../src/render/html.mjs';
import { renderJson } from '../src/render/json.mjs';
import { parseCliArgs, runCli } from '../src/cli.mjs';

/* ------------------------------------------------------------------ *
 * 地基
 * ------------------------------------------------------------------ */

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-check-d6-'));
const NOW = Date.now();
const RULES = JSON.parse(fs.readFileSync(new URL('../src/rules.json', import.meta.url), 'utf8'));
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CAN_CHMOD = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

function makeDir(name) {
  const dir = path.join(TEMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isoAt(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

function agePath(target, msAgo) {
  const seconds = (NOW - msAgo) / 1000;
  fs.utimesSync(target, seconds, seconds);
}

/**
 * ① 健康活跃的鱼：7 天每天都醒、今天有产出、日志干净、配置与程序版本对得上。
 *    （deps 一栏取决于宿主机有没有 ffmpeg / 登录态，不在断言范围内。）
 */
function makeHealthyFish() {
  const root = makeDir('healthy-whale');
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const lines = [];
  for (let day = 7; day >= 1; day -= 1) {
    for (let i = 1; i <= 3; i += 1) {
      lines.push(`${isoAt(day * DAY - i * HOUR)} INFO 处理完成 bvid=BV1${day}${i}`);
    }
  }
  lines.push(`${isoAt(2 * MINUTE)} INFO 处理完成 bvid=BV1today`);
  fs.writeFileSync(path.join(root, 'logs', 'app.log'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    schemaVersion: 3, provider: 'x', baseUrl: 'local', model: 'm',
  }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'healthy-whale', version: '1.0.0' }));
  const entries = [];
  for (let i = 0; i < 8; i += 1) entries.push({ bvid: `BV1T${i}`, processedAt: isoAt((i + 1) * MINUTE) });
  fs.writeFileSync(path.join(root, 'processed.json'), JSON.stringify(entries));
  return root;
}

/** ② 疲软失效的鱼：三天没动过，日志尾部一串 429（被限流）。 */
function makeTiredFish() {
  const root = makeDir('tired-whale');
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const lines = [];
  for (let i = 0; i < 20; i += 1) lines.push(`${isoAt(3 * DAY + (20 - i) * MINUTE)} INFO 处理完成 bvid=BV2${i}`);
  for (let i = 0; i < 6; i += 1) {
    lines.push(`${isoAt(3 * DAY + (6 - i) * 1000)} ERROR 429 Too Many Requests 请求过于频繁`);
  }
  const logPath = path.join(root, 'logs', 'app.log');
  fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
  agePath(logPath, 3 * DAY);
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 3 }));
  agePath(configPath, 3 * DAY);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'tired-whale', version: '1.0.0' }));
  const entries = [];
  for (let i = 0; i < 5; i += 1) entries.push({ bvid: `BV2${i}`, processedAt: isoAt(3 * DAY + i * MINUTE) });
  const dedupePath = path.join(root, 'processed.json');
  fs.writeFileSync(dedupePath, JSON.stringify(entries));
  agePath(dedupePath, 3 * DAY);
  return root;
}

/** ③ 认不出的鱼：目录在，但四类产物一个都没有。 */
function makeMysteryFish() {
  return makeDir('mystery-box');
}

async function inspect(rootPath, options = {}) {
  const read = await readPond({ id: path.basename(rootPath), kind: 'generic', rootPath }, {
    now: NOW,
    home: TEMP_ROOT,
    ...options.read,
  });
  const report = evaluate({ ponds: [read] }, { now: NOW, ...options.evaluate });
  return { read, report, fish: report.fishes[0] };
}

const levelOf = (fish, id) => fish?.indicators?.[id]?.level ?? null;

/** 从文本摘要里读统计行四桶（也就是「渲染层认为几条鱼在哪个桶里」）。 */
function statBucketsFromText(text) {
  const line = text.split('\n').find((row) => row.startsWith('共 '));
  assert.ok(line, '文本摘要里没有统计行');
  const match = line.match(
    // D8-M4：bad 档统一「坏了」；D8-M5：行尾可带「多格判不出的鱼 N 条」（可选）
    /^共 (\d+) 条，活跃 (\d+) \/ 疲软 (\d+) \/ 坏了 (\d+) \/ 认不出 (\d+)。(多格判不出的鱼 \d+ 条（活跃不代表六格全绿）。)?$/u,
  );
  assert.ok(match, `统计行格式变了：${line}`);
  return { total: Number(match[1]), ok: Number(match[2]), watch: Number(match[3]), bad: Number(match[4]), unknown: Number(match[5]) };
}

/** 从 HTML 四灯里读同样的四桶。 */
function statBucketsFromHtml(html) {
  const counts = {};
  const re = /<div class="ov ov-(ok|watch|bad|unknown)">\s*<span class="ov-count">(\d+)<\/span>/gu;
  for (const match of html.matchAll(re)) counts[match[1]] = Number(match[2]);
  for (const key of ['ok', 'watch', 'bad', 'unknown']) assert.ok(Number.isFinite(counts[key]), `HTML 缺 ${key} 灯`);
  return counts;
}

after(() => {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // 清不掉也不影响结论（临时目录在系统 tmp 里）
  }
});

/* ------------------------------------------------------------------ *
 * 1. 三条假鱼：六指标必须分得开
 * ------------------------------------------------------------------ */

test('【必修】三条假鱼：健康 / 疲软失效 / 认不出，六指标各判各的，不糊成一团', async () => {
  const healthy = await inspect(makeHealthyFish());
  const tired = await inspect(makeTiredFish());
  const mystery = await inspect(makeMysteryFish());

  // ① 健康鱼：生活三格 + 系统两格都要有明确结论（deps 依赖宿主机，不断言具体档）
  assert.equal(levelOf(healthy.fish, 'liveness'), 'active', '刚写过日志的鱼必须判「活跃」');
  assert.equal(levelOf(healthy.fish, 'rhythm'), 'steady', '7 天每天都醒，节律必须判「规律」');
  assert.equal(levelOf(healthy.fish, 'throughput'), 'productive', '今天有新增，工作量必须判「在干活」');
  assert.equal(levelOf(healthy.fish, 'health'), 'clean', '日志里没有报错关键词，健康才是「干净」');
  assert.equal(levelOf(healthy.fish, 'drift'), 'aligned', '配置 v3 + 程序在场，漂移判「对齐」');

  // ② 疲软失效鱼：3 天没动 + 尾部 429 → 坏了
  assert.equal(levelOf(tired.fish, 'health'), 'critical', '日志尾部一串 429，健康必须是「已经挂了」');
  assert.ok(['dormant', 'slack', 'dead'].includes(levelOf(tired.fish, 'liveness')),
    `3 天没动的鱼不该判「活跃」，实际 ${levelOf(tired.fish, 'liveness')}`);
  assert.equal(tired.fish.severity, 'bad');

  // ③ 认不出的鱼：六格全 unknown，一格都不许冒充正常
  for (const id of INDICATOR_IDS) {
    assert.equal(levelOf(mystery.fish, id), 'unknown', `空目录的 ${id} 只能是 unknown`);
  }

  // 三条鱼的六格组合必须两两不同 —— 否则「分得开」这句话就是空的
  const signatureOf = (fish) => INDICATOR_IDS.map((id) => levelOf(fish, id)).join('|');
  const signatures = new Set([signatureOf(healthy.fish), signatureOf(tired.fish), signatureOf(mystery.fish)]);
  assert.equal(signatures.size, 3, '三条鱼的六格组合撞车了，说明判定没把不同状况分开');
});

/* ------------------------------------------------------------------ *
 * 2. 分桶口径（D6 必修缺陷二）：按关键格，不按最差格
 * ------------------------------------------------------------------ */

test('【必修】分桶：liveness+throughput 能判、只有 rhythm/deps 判不出 → 算「活跃」', async () => {
  const { fish } = await inspect(makeHealthyFish());
  const clone = structuredClone(fish);
  // 复刻队长实测的那条鱼：四格有结论，rhythm / deps 两格判不出
  for (const id of ['rhythm', 'deps']) {
    clone.indicators[id] = {
      ...clone.indicators[id],
      level: 'unknown',
      severity: 'unknown',
      evidence: { ...clone.indicators[id].evidence, missing: ['log'] },
    };
  }
  assert.equal(levelOf(clone, 'liveness'), 'active');
  assert.equal(levelOf(clone, 'throughput'), 'productive');
  assert.equal(classifyFishBucket(clone), 'ok', '四格有结论的鱼不该被整条划进「认不出」');

  // 关键两格都判不出时，才轮到「认不出」
  const blind = structuredClone(clone);
  for (const id of KEY_INDICATORS) {
    blind.indicators[id] = { ...blind.indicators[id], level: 'unknown', severity: 'unknown' };
  }
  assert.equal(classifyFishBucket(blind), 'unknown');

  // 任一格坏了 → 坏了（优先于「活跃」；D8-M4 后分桶词统一「坏了」）
  const dead = structuredClone(clone);
  dead.indicators.deps = { ...dead.indicators.deps, level: 'broken', severity: 'bad' };
  assert.equal(classifyFishBucket(dead), 'bad');
  // 任一格要注意 → 疲软
  const wobbly = structuredClone(clone);
  wobbly.indicators.drift = { ...wobbly.indicators.drift, level: 'drifted', severity: 'watch' };
  assert.equal(classifyFishBucket(wobbly), 'watch');
});

test('【必修】三处口径一致：evaluate.fishBuckets ＝ 文本统计行 ＝ HTML 四灯', async () => {
  const healthy = await inspect(makeHealthyFish());
  const tired = await inspect(makeTiredFish());
  const mystery = await inspect(makeMysteryFish());

  const reads = await readAll([
    { id: 'healthy', kind: 'generic', rootPath: healthy.read.rootPath },
    { id: 'tired', kind: 'generic', rootPath: tired.read.rootPath },
    { id: 'mystery', kind: 'generic', rootPath: mystery.read.rootPath },
  ], { now: NOW, home: TEMP_ROOT });

  const report = evaluate({ ponds: reads }, { now: NOW });
  const textBuckets = statBucketsFromText(renderText(report));
  const htmlBuckets = statBucketsFromHtml(renderHtml(report));

  assert.deepEqual(textBuckets, { total: report.fishes.length, ...report.fishBuckets },
    '文本统计行与 evaluate.fishBuckets 不一致');
  for (const key of ['ok', 'watch', 'bad', 'unknown']) {
    assert.equal(htmlBuckets[key], report.fishBuckets[key], `HTML 四灯的 ${key} 与 evaluate 不一致`);
  }
  // 关键格口径：三条鱼里「认不出」的那条，必须正是六格全 unknown 的那条
  assert.equal(report.fishBuckets.unknown, 1, '只有 mystery-box 该进「认不出」');
  assert.equal(report.fishBuckets.bad, 1, 'tired-whale 该进「坏了」桶');
});

/* ------------------------------------------------------------------ *
 * 3. unknown 话术区分 A / B（D6 必修缺陷一）
 * ------------------------------------------------------------------ */

test('【必修】unknown A：像鱼但没有任何运行痕迹 → 说「可能只是界面组件」', async () => {
  const pluginRead = {
    id: 'dsh-plugin:web/dsh-whale-widget',
    kind: 'dsh-plugin',
    rootPath: path.join(TEMP_ROOT, 'empty-plugin-root'),
    ok: true,
    paths: { log: null, config: null, dedupe: null, sessionDir: null, packageJson: null, probeRoots: [] },
    sources: {
      log: { status: 'missing' }, config: { status: 'missing' },
      dedupe: { status: 'missing' }, sessions: { status: 'missing' },
    },
    missing: ['log', 'config', 'dedupe', 'sessions'],
    unreadable: [], skippedSensitive: [], sensitiveSkippedCount: 0,
    log: null, dedupe: null, config: null, sessions: null, deps: null, credentials: null,
    degraded: [], notes: [], now: NOW,
  };
  const report = evaluate({ ponds: [pluginRead] }, { now: NOW });

  assert.equal(report.fishes[0].trace, 'none', '四类产物全 missing 就是「没有运行痕迹」');
  assert.match(report.verdict, /名字像鱼的插件/, 'A 版话术必须出现（插件）');
  assert.match(report.verdict, /没有任何运行痕迹/);
  assert.match(report.traceNote ?? '', /可能只是界面组件/);
  assert.ok(!report.verdict.includes('可能只是目录占位'), '插件的鱼不该用泛型那句');
});

test('【必修】unknown A（泛型）：普通目录但没有运行痕迹 → 说「可能只是目录占位」', async () => {
  const { report } = await inspect(makeMysteryFish());
  assert.equal(report.fishes[0].trace, 'none');
  assert.match(report.traceNote ?? '', /名字像鱼的候选/);
  assert.match(report.traceNote ?? '', /目录占位/);
  // 文本摘要也要把这句话印出来（否则新用户只看文本，永远不知道 A 的存在）
  assert.ok(renderText(report).includes('没有任何运行痕迹'), '文本摘要漏了 A 版话术');
});

test('【必修】unknown B：有痕迹但读不到 → 说「试试 --root」，与 A 不共用一句', { skip: CAN_CHMOD ? false : 'chmod 需要非 root 的 POSIX 环境' }, async () => {
  // 场景要挑准：定位到了产物、但内容读不出来，而且**关键两格都判不出**才算「认不出」。
  // 所以这里只留一个读不到的 config.json：日志/判重表都不存在（liveness、throughput 无从判），
  // 而 config 在却 chmod 000（有痕迹、读不出）。
  const root = makeDir('unreadable-whale');
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 3 }));
  fs.chmodSync(configPath, 0o000);

  const { fish, report } = await inspect(root);
  assert.equal(fish.trace, 'unreadable', '定位到了但读不出来 = 有痕迹');
  assert.equal(classifyFishBucket(fish), 'unknown', '前提：这条鱼确实算「认不出」');
  assert.match(fish.traceHint ?? '', /找到了运行痕迹但读不到内容/);
  assert.match(fish.traceHint ?? '', /--root/);
  assert.match(fish.fixes[0] ?? '', /找到了运行痕迹但读不到内容/, 'B 版话术要是第一条可执行建议');
  // A 版那句不该出现在这条鱼的报告里
  assert.doesNotMatch(report.verdict, /没有任何运行痕迹/);

  fs.chmodSync(configPath, 0o600);
});

/* ------------------------------------------------------------------ *
 * 4. 死循环（D6b P4）：指过窝就不许再教指窝
 * ------------------------------------------------------------------ */

test('【裁定 2】指过窝仍读不到：话术换成「查路径/权限/日志」，不再复读 --root', async () => {
  const rootPath = makeMysteryFish();

  const withoutRoot = await inspect(rootPath);
  assert.match(withoutRoot.fish.fixes[0] ?? '', /--root/, '没指过窝时，第一条建议应当是指路');

  const withRoot = await inspect(rootPath, { evaluate: { rootHinted: true } });
  const first = withRoot.fish.fixes[0] ?? '';
  assert.match(first, /窝已指定但里面真的读不到/, '指过窝之后必须换一句');
  assert.doesNotMatch(first, /指明她的窝/, '指过窝还说「指明她的窝」就是死循环');
  assert.match(first, /权限/, '新话术要给出真正可查的三件事（路径 / 权限 / 日志是不是真写在这）');
});

test('【裁定 2】用户自己指的窝不算「名字像鱼的候选」：不套 A 版话术', async () => {
  const rootPath = makeMysteryFish();
  const auto = await inspect(rootPath);
  assert.ok(auto.report.traceNote, '自动扫到的空目录应当有 A 版说明');

  const pinned = await inspect(rootPath, { evaluate: { rootHinted: true } });
  assert.equal(pinned.report.traceNote, null, '用户亲手指的窝不该被说成「名字像鱼的候选」');
  assert.doesNotMatch(pinned.report.verdict, /名字像鱼的候选|可能是目录占位/);
  assert.match(pinned.fish.fixes[0] ?? '', /窝已指定但里面真的读不到/);
});

test('【必修】行图标跟鱼级分桶：四格有结论的鱼穿 ✅，不许顶着 ❓ 却在统计里算「活跃」', async () => {
  const { fish } = await inspect(makeHealthyFish());
  const clone = structuredClone(fish);
  // 复刻「六格里 rhythm / deps 判不出、其余四格有结论」：severity 仍是最差格 unknown
  for (const id of ['rhythm', 'deps']) {
    clone.indicators[id] = { ...clone.indicators[id], level: 'unknown', severity: 'unknown' };
  }
  clone.severity = 'unknown';
  clone.bucket = classifyFishBucket(clone);
  assert.equal(clone.bucket, 'ok');

  const report = {
    generatedAt: new Date(NOW).toISOString(),
    host: { platform: 'linux', node: '22' },
    fishes: [clone],
    summary: { fish: 1, ok: 1, watch: 0, bad: 0, unknown: 2 },
    fishBuckets: { ok: 1, watch: 0, bad: 0, unknown: 0 },
    traceCounts: { none: 0, unreadable: 0, present: 1 },
    verdict: '1 条鱼 · 六格口径：1 正常 · 0 要注意 · 0 坏了 · 2 判不出',
    nextAction: 'x',
    footnote: '2 项数据读不到（节律、依赖），不能当正常。',
    degradedCount: 2,
    skippedSensitive: { count: 0, names: '[凭证文件已跳过]' },
  };

  const text = renderText(report);
  const row = text.split('\n').find((line) => line.startsWith('✅'));
  assert.ok(row, `行图标应当是 ✅（分桶 ok），实际：${text.split('\n')[1]}`);
  assert.ok(!row.startsWith('❓'), '行图标还跟着最差格走，报告自相矛盾');
  assert.match(text, /共 1 条，活跃 1 \//, '统计行也必须算「活跃」');

  const html = renderHtml(report);
  assert.ok(html.includes('card card-ok'), 'HTML 卡片类名没跟分桶');
  assert.ok(/<div class="ov ov-ok">\s*<span class="ov-count">1<\/span>/u.test(html), '四灯没把这条鱼算进「活跃」');
});

/* ------------------------------------------------------------------ *
 * 5. CLI 参数（裁定 1）：--log 真能用，话术里提到的参数必须都存在
 * ------------------------------------------------------------------ */

/** 跑一次 CLI，用假管线把「这次要体检哪些窝」抓下来（不扫真机）。 */
async function runCliCapturing(argv) {
  const captured = [];
  const stdout = [];
  const stderr = [];
  const code = await runCli(argv, {
    discover: () => [],
    readAll: async (ponds) => {
      captured.push(...ponds);
      return [];
    },
    evaluate: (data, options) => evaluate(data, { ...options, now: NOW }),
    stdout: (text) => stdout.push(String(text)),
    stderr: (text) => stderr.push(String(text)),
    writeFile: () => {},
    cwd: TEMP_ROOT,
    now: NOW,
  });
  return { code, captured, out: stdout.join(''), err: stderr.join('') };
}

test('【裁定 1】--log <路径>：只体检这一个窝，并把日志钉死在指定文件上', async () => {
  const root = makeHealthyFish();
  const logPath = path.join(root, 'logs', 'app.log');

  const { code, captured, err } = await runCliCapturing(['--text', '--log', logPath]);
  assert.equal(code, 0);
  assert.equal(captured.length, 1, '--log 是替换语义：只体检指到的这一条');
  assert.equal(captured[0].paths?.log, logPath, '日志路径没有被钉死');
  assert.ok(!err.includes('不存在'), '存在的日志不该报「不存在」');

  // 缺值 → 用法错误（退出码 2），不许静默当成无参数
  const bad = parseCliArgs(['--log']);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /--log 缺少参数值/);
});

test('【裁定 1】--dedupe <路径>：判重表也能直接指（规格 P0 的第三条逃生口）', async () => {
  const root = makeHealthyFish();
  const dedupePath = path.join(root, 'processed.json');
  const { code, captured } = await runCliCapturing(['--text', '--dedupe', dedupePath]);
  assert.equal(code, 0);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].paths?.dedupe, dedupePath);
});

test('【裁定 1】话术里出现的每一个 --xxx，CLI 都必须真支持（文档与实现的一致性闸）', () => {
  const flags = new Set();
  // 别人家的参数：`systemctl --user list-timers`、`node --version` 这类不是让用户敲 pond-check 的
  const FOREIGN_COMMANDS = new Set([
    'systemctl', 'journalctl', 'launchctl', 'node', 'npm', 'npx', 'pnpm', 'yarn',
    'git', 'docker', 'apt', 'apt-get', 'brew', 'ps', 'grep', 'rg', 'chmod', 'chown',
    'sudo', 'nvm', 'curl', 'wget', 'ffmpeg', 'pm2', 'supervisorctl',
  ]);
  const collect = (text) => {
    if (typeof text !== 'string') return;
    const tokens = text.split(/\s+/u);
    tokens.forEach((token, index) => {
      const match = token.match(/^(?<![\w-])(--[a-z][a-z0-9-]*)$/u);
      if (!match) return;
      // 往前看三个 token：命令是以外部程序起头的，这个参数就不归我们管。
      // 注意 token 常带标点（`-l、systemctl`），要按非词字符再切一遍才认得出命令名。
      const headWords = tokens
        .slice(Math.max(0, index - 3), index)
        .flatMap((item) => item.split(/[^\w-]+/u))
        .filter(Boolean);
      if (headWords.some((word) => FOREIGN_COMMANDS.has(word))) return;
      flags.add(match[1]);
    });
  };

  // 只扫**用户话术**：diagnosis / variants / categories[].fix / checks[].fix / rollup 模板。
  // discovery 里的 --version、--no-exec 是探测协议里的其它命令行（`node --version`），
  // 不是让用户敲的参数，故意不在这张网里。
  for (const indicator of Object.values(RULES.indicators)) {
    for (const entry of Object.values(indicator.diagnosis ?? {})) {
      collect(entry.phenomenon);
      collect(entry.nextStep);
      collect(entry.fixShort);
    }
    for (const entry of Object.values(indicator.variants ?? {})) {
      collect(entry.phenomenon);
      collect(entry.phenomenonSuffix);
      collect(entry.nextStep);
      collect(entry.nextStepTemplate);
      collect(entry.fixShort);
    }
    for (const category of indicator.thresholds?.categories ?? []) collect(category.fix);
    for (const check of indicator.thresholds?.checks ?? []) collect(check.fix);
  }
  for (const [key, value] of Object.entries(RULES.rollup ?? {})) {
    if (key.endsWith('Template') || key.endsWith('Short')) collect(value);
  }

  assert.ok(flags.size > 0, '一个参数都没扫到，说明扫描逻辑坏了');
  for (const flag of flags) {
    // 带一个值的写法：值参数会被吃掉，开关参数会忽略它，两种情况都该「认这个参数」
    const parsed = parseCliArgs([flag, 'whatever']);
    assert.equal(parsed.ok, true, `话术让用户敲 ${flag}，但 CLI 不认识它：${parsed.errors.join('；')}`);
    assert.ok(!parsed.errors.join(' ').includes('不认识的参数'), `${flag} 被当成未知参数`);
  }
});

test('【裁定 1】--expect-schema 已从话术里彻底删除（内部测试参数不该教用户）', () => {
  const text = JSON.stringify(RULES);
  assert.equal(text.includes('--expect-schema'), false, 'rules.json 里还留着 --expect-schema');
  const parsed = parseCliArgs(['--expect-schema', '3']);
  assert.equal(parsed.ok, false, 'CLI 不该支持这个内部参数');
  assert.match(parsed.errors.join(' '), /不认识的参数/);
});

/* ------------------------------------------------------------------ *
 * 6. 总评 / 脚注 / 短话术（P5 / P6 / P9 / P10 / P13 / P14 / P20 / P21）
 * ------------------------------------------------------------------ */

test('【P9】总评把「几条鱼」和「几个格子」分开说', async () => {
  const { report } = await inspect(makeHealthyFish());
  assert.match(report.verdict, /^1 条鱼 · 六格口径：/, '总评必须标出「六格口径」，别再让 6 和 1 混着读');
  assert.match(renderText(report), /共 1 条，活跃 1 \//, '文本统计仍然按鱼数分桶');
});

test('【P6】脚注用中文格名，不再把 liveness / rhythm 这些机器 id 印给人看', async () => {
  const { report } = await inspect(makeMysteryFish());
  assert.ok(report.footnote, '六格全判不出时必须有脚注');
  assert.ok(!/liveness|rhythm|throughput|health|deps|drift/u.test(report.footnote),
    `脚注里还有英文指标 id：${report.footnote}`);
  assert.match(report.footnote, /存活/);
  assert.match(report.footnote, /不能当正常/);
});

test('【P5】每条会进「最该做」的话术都有 fixShort，且拼出来的行 ≤ 60 显示列', () => {
  // 预算：前缀「→ 最该做：」11 列 + 名字 20 列 + 「：」2 列 = 33 列，短句最多 27 列
  const NAME_AND_PREFIX = 33;
  const missing = [];
  for (const [id, indicator] of Object.entries(RULES.indicators)) {
    for (const [level, entry] of Object.entries(indicator.diagnosis ?? {})) {
      if (!entry.severity) continue;
      if (typeof entry.fixShort !== 'string' || entry.fixShort.trim() === '') {
        missing.push(`${id}.${level}`);
        continue;
      }
      assert.ok(
        displayWidth(entry.fixShort) <= 60 - NAME_AND_PREFIX,
        `${id}.${level} 的 fixShort 太宽（${displayWidth(entry.fixShort)} 列）：${entry.fixShort}`,
      );
    }
  }
  assert.deepEqual(missing, [], `这些档位缺 fixShort：${missing.join('、')}`);

  for (const [key, value] of Object.entries(RULES.rollup)) {
    if (!key.endsWith('Short')) continue;
    assert.ok(displayWidth(value) <= 60 - NAME_AND_PREFIX, `rollup.${key} 太宽：${value}`);
  }
});

test('【P5】真跑三条假鱼：文本摘要里「→ 最该做」一行都不许超过 60 列', async () => {
  for (const rootPath of [makeHealthyFish(), makeTiredFish(), makeMysteryFish()]) {
    const { report } = await inspect(rootPath, { evaluate: { rootHinted: true } });
    const line = renderText(report).split('\n').find((row) => row.startsWith('→ 最该做：'));
    assert.ok(line, '缺「最该做」这一行');
    assert.ok(displayWidth(line) <= 60, `「最该做」行 ${displayWidth(line)} 列超预算：${line}`);
  }
});

test('【P10/P13/P14/P20/P21】话术体检：不夹英文档位词、句末有句号、模板不留多余空格', () => {
  const problems = [];
  const check = (where, text) => {
    if (typeof text !== 'string') return;
    if (/\bunknown\b/u.test(text)) problems.push(`${where} 夹了英文 unknown：${text}`);
    // 「{fixHint} 修完」这种填充后会多一个空格的写法
    if (/\{fixHint\}\s+\S/u.test(text)) problems.push(`${where} 的 {fixHint} 后面多一个空格：${text}`);
    // phenomenon 是给人读的整句，必须以句号/问号/感叹号收尾
    if (where.endsWith('.phenomenon') && !/[。？！]$/u.test(text)) problems.push(`${where} 句末缺句号：${text}`);
  };

  for (const [id, indicator] of Object.entries(RULES.indicators)) {
    for (const [level, entry] of Object.entries(indicator.diagnosis ?? {})) {
      check(`${id}.${level}.phenomenon`, entry.phenomenon);
      check(`${id}.${level}.nextStep`, entry.nextStep);
    }
    for (const [key, variant] of Object.entries(indicator.variants ?? {})) {
      check(`${id}.variants.${key}.phenomenon`, variant.phenomenon);
      check(`${id}.variants.${key}.nextStep`, variant.nextStep);
    }
  }
  assert.deepEqual(problems, [], `话术里还有这些毛病：\n${problems.join('\n')}`);
  // 这两句是被点名改过的，顺手钉死
  assert.match(RULES.indicators.rhythm.diagnosis.sparse.phenomenon, /只是偶尔挣扎一下/);
  assert.match(RULES.indicators.throughput.diagnosis.stalled.nextStep, /源站没更新就不用管/);
});

/* ------------------------------------------------------------------ *
 * 7. 渲染层小修（P8 / P11 / P12 / P15 / P16 / P18 / P19）
 * ------------------------------------------------------------------ */

test('【P8】0 条鱼：只留总评一句话，不再重复「最该做」', () => {
  const report = evaluate({ ponds: [] }, { now: NOW });
  const text = renderText(report);
  assert.ok(!text.includes('→ 最该做'), '0 条鱼时「最该做」与总评重复');
  assert.match(text, /没扫到鱼/);
  assert.match(text, /共 0 条/);
});

test('【P7】--fish 没匹配到：说「过滤没命中」，不许说「没扫到任何在跑的鱼」', async () => {
  const stdout = [];
  const stderr = [];
  const code = await runCli(['--text', '--fish', 'no-such-fish'], {
    discover: () => ([
      { id: 'dsh-plugin:web/alpha', kind: 'dsh-plugin', rootPath: '/ponds/alpha', evidence: {} },
      { id: 'dsh-plugin:web/beta', kind: 'dsh-plugin', rootPath: '/ponds/beta', evidence: {} },
    ]),
    readAll: async () => [],
    evaluate,
    stdout: (text) => stdout.push(String(text)),
    stderr: (text) => stderr.push(String(text)),
    writeFile: () => {},
    cwd: TEMP_ROOT,
    now: NOW,
  });
  const out = stdout.join('');
  assert.equal(code, 0);
  assert.match(out, /过滤条件「no-such-fish」没匹配到鱼/, '没区分「过滤没命中」和「真的没鱼」');
  assert.match(out, /本次扫到 2 条/);
  assert.ok(!out.includes('没扫到鱼'), '不能把过滤失败说成没鱼');
  assert.match(stderr.join(''), /没找到叫「no-such-fish」的鱼/, 'stderr 仍要列出真名');
});

test('【P11】HTML 生成时间用本地时区（文本摘要也是本地），ISO 留在 title 里', async () => {
  const { report } = await inspect(makeHealthyFish());
  const html = renderHtml(report);
  assert.ok(html.includes(`datetime="${report.generatedAt}"`), 'ISO 原值要留在 time 的 datetime 属性里');
  const visible = html.match(/<time[^>]*>([^<]+)<\/time>/u)?.[1];
  assert.ok(visible, 'HTML 里没有可读的生成时间');
  const local = new Date(report.generatedAt);
  const pad = (value) => String(value).padStart(2, '0');
  const expected = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} `
    + `${pad(local.getHours())}:${pad(local.getMinutes())}`;
  assert.equal(visible, expected, 'HTML 显示的时间不是本地时区（会差几个小时，像旧报告）');
});

test('【P12/P18】HTML 小卡单位中文 + 状态灯有符号（不只靠颜色）', async () => {
  const { report } = await inspect(makeHealthyFish());
  const html = renderHtml(report);
  assert.ok(!/\d+\s+(checks|sec|days|count|hits|version)\b/u.test(html), 'HTML 里还有英文单位');
  assert.ok(html.includes('项</span>'), 'deps 的 0 checks 应显示成「0 项」');

  // 灯符号用四档合成鱼来验（真机上 deps 可能是 unknown，severity 不一定四档齐全）
  const makeCell = (severity) => ({
    id: 'liveness', nameZh: '存活', level: 'active', severity, value: 1, unit: 'sec',
    evidence: {}, phenomenon: 'x', nextStep: 'y', degraded: [],
  });
  const makeFish = (severity) => ({
    id: `f-${severity}`, kind: 'dsh', kindNameZh: 'DSH 插件', name: severity, stateRoot: '/x',
    processes: [], severity,
    indicators: { liveness: makeCell(severity), rhythm: makeCell(severity), throughput: makeCell(severity), health: makeCell(severity), deps: makeCell(severity), drift: makeCell(severity) },
    fixes: [], fixesShort: [], degraded: [], notes: [], headline: '',
  });
  const synthetic = renderHtml({
    generatedAt: new Date(NOW).toISOString(),
    host: { platform: 'linux', node: '22' },
    fishes: ['ok', 'watch', 'bad', 'unknown'].map(makeFish),
    summary: { fish: 4, ok: 0, watch: 0, bad: 0, unknown: 0 },
    verdict: 'x', nextAction: 'y', footnote: null, degradedCount: 0,
    skippedSensitive: { count: 0, names: '[凭证文件已跳过]' },
  });
  assert.ok(/light light-ok"[^>]*>✓</u.test(synthetic), 'ok 灯缺 ✓');
  assert.ok(/light light-watch"[^>]*>!</u.test(synthetic), 'watch 灯缺 !');
  assert.ok(/light light-bad"[^>]*>×</u.test(synthetic), 'bad 灯缺 ×');
  assert.ok(/light light-unknown"[^>]*>\?</u.test(synthetic), 'unknown 灯缺 ?');
});

test('【P15】长名字的鱼行不超宽：名字列 20 列、备注列 22 列', async () => {
  const { report } = await inspect(makeHealthyFish());
  const clone = structuredClone(report);
  clone.fishes[0].name = 'DSH 插件 · 一个特别特别长的鱼名字用来把整行推爆看看会不会超宽';
  const lines = renderText(clone).split('\n');
  const row = lines.find((line) => line.includes('…') && line.startsWith('✅'))
    ?? lines.find((line) => line.includes('…'));
  assert.ok(row, '长名字的鱼行不见了（不许丢鱼）');
  assert.ok(displayWidth(row) <= 60, `长名字把鱼行撑到 ${displayWidth(row)} 列：${row}`);
});

test('【P16】歧义宽度字符按 2 列算（中文终端里才不会整表错位）', () => {
  for (const char of ['…', '·', '→']) {
    assert.equal(displayWidth(char), 2, `${char} 应算 2 列`);
  }
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
});

test('【P22】「最该做」在指路时，把她的真实窝路径单独印出来（可复制）', async () => {
  const rootPath = makeMysteryFish();
  const { report } = await inspect(rootPath);
  const lines = renderText(report).split('\n');
  const rootLine = lines.find((line) => line.trimStart().startsWith('窝：'));
  assert.ok(rootLine, '指路却没有印出窝路径，用户不知道 <她的目录> 该敲什么');
  assert.ok(rootLine.includes(rootPath), '印出来的不是真实路径');
});

/* ------------------------------------------------------------------ *
 * 8. JSON 结构（新字段要能被机器消费）
 * ------------------------------------------------------------------ */

test('JSON：鱼级分桶 / trace / fixShort 都进 --json，且同输入同输出', async () => {
  const { report } = await inspect(makeHealthyFish());
  const parsed = JSON.parse(renderJson(report));

  assert.deepEqual(Object.keys(parsed.fishBuckets), ['ok', 'watch', 'bad', 'unknown']);
  assert.deepEqual(Object.keys(parsed.traceCounts), ['none', 'unreadable', 'present']);
  const fish = parsed.fishes[0];
  assert.ok(['ok', 'watch', 'bad', 'unknown'].includes(fish.bucket), 'fish.bucket 缺失');
  assert.ok(['none', 'unreadable', 'present'].includes(fish.trace), 'fish.trace 缺失');
  assert.equal(fish.fixesShort.length, fish.fixes.length, 'fixesShort 要与 fixes 一一对应');
  // 同输入必同文本（JSON 是给机器读的，飘一次就是一次回归）
  assert.equal(renderJson(report), renderJson(structuredClone(report)));
});
