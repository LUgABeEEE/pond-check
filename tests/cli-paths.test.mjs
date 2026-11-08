/**
 * pond-check · v0.1.1 回归：三个逃生口指到不存在的路径（D8-M9）
 *
 * 契约（真 CLI 子进程，不走 deps 注入）：
 *   pond-check --root   <不存在>  → stderr 提醒 + exit 0 + 报告照出，那条鱼是 unknown
 *   pond-check --log    <不存在>  → stderr 提醒 + exit 0 + 报告照出，那条鱼是 unknown
 *   pond-check --dedupe <不存在>  → stderr 提醒 + exit 0 + 报告照出，那条鱼是 unknown
 *
 * 为什么值得锁：用户打错字不该让工具崩，也不该静默失败。当前实现是对的
 * （src/cli.mjs 里 warn 之后照常走 readAll/evaluate），但此前没有用例守着。
 * 这里跑的是**真进程**，所以 exit code / stderr / stdout 都是真边界，
 * 而不是 runCli 注入假管线后的「内部行为」。
 *
 * 环境：子进程的 HOME / DSH_HOME 都指向空临时目录，自动扫描不会碰真机，
 * 报告里只会有逃生口那条鱼 —— 断言才不会被本机的真实鱼窝干扰。
 * Windows：v0.1 的 CLI 会明确拒绝（platform=win32），这组用例只在 Linux/macOS 跑。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INDICATOR_IDS } from '../src/evaluate/index.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-cli-paths-'));
const FAKE_HOME = path.join(TEMP_ROOT, 'home');
const FAKE_DSH_HOME = path.join(TEMP_ROOT, 'dsh-home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
fs.mkdirSync(FAKE_DSH_HOME, { recursive: true });

// deps 那一格是**宿主机事实**：PATH 上没有 ffmpeg 的机器（CI runner 就是）会判成
// warn，而档位规则里 warn 优先于 unknown —— 整格翻档，下面「六格都判不出」的断言
// 跟着挂。这里给子进程一个只放 ffmpeg 桩的 PATH 前缀，把「这台机器装没装 ffmpeg」
// 从被测变量里摘掉，断言才和宿主机软件清单无关。
const PATH_SHIM = path.join(TEMP_ROOT, 'bin');
fs.mkdirSync(PATH_SHIM, { recursive: true });
fs.writeFileSync(path.join(PATH_SHIM, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

const SKIP_WIN = process.platform === 'win32'
  ? 'v0.1 的 CLI 在 Windows 上明确拒绝运行（platform=win32）；这组逃生口用例在 Linux/macOS 上执行'
  : false;

/** 用干净的家目录跑一次真 CLI，拿 stdout/stderr/exit code。 */
function runCli(args, { json = true } = {}) {
  const argv = json ? [CLI, '--json', ...args] : [CLI, ...args];
  return spawnSync(process.execPath, argv, {
    cwd: TEMP_ROOT,
    env: {
      ...process.env,
      HOME: FAKE_HOME,
      DSH_HOME: FAKE_DSH_HOME,
      XDG_CONFIG_HOME: path.join(FAKE_HOME, '.config'),
      PATH: [PATH_SHIM, process.env.PATH].filter(Boolean).join(path.delimiter),
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const CASES = [
  {
    flag: '--root',
    target: path.join(TEMP_ROOT, 'no-such-pond'),
    stderrRe: /窝不存在（或不是目录）/u,
    expectedId: (target) => `root:${target}`,
  },
  {
    flag: '--log',
    target: path.join(TEMP_ROOT, 'no-such-log.log'),
    stderrRe: /日志文件不存在（或不是普通文件）/u,
    expectedId: (target) => `pinned:${target}`,
  },
  {
    flag: '--dedupe',
    target: path.join(TEMP_ROOT, 'no-such-dedupe.json'),
    stderrRe: /判重表文件不存在（或不是普通文件）/u,
    expectedId: (target) => `pinned:${target}`,
  },
];

for (const { flag, target, stderrRe, expectedId } of CASES) {
  test(`${flag} 指到不存在路径：stderr 提醒 + exit 0 + 报告仍出（该鱼 unknown）`, { skip: SKIP_WIN }, () => {
    const result = runCli([flag, target]);

    assert.equal(result.error, undefined, `子进程启动失败：${result.error?.message}`);
    assert.equal(result.status, 0, `${flag} 指到不存在路径不该崩，实际 exit=${result.status}；stderr=${result.stderr}`);

    // 1) stderr 必须说人话，而且带上用户指的那个绝对路径（否则用户不知道自己打错了什么）
    assert.match(result.stderr, stderrRe, `stderr 没提醒 ${flag} 指错了：${result.stderr}`);
    assert.ok(result.stderr.includes(target), `stderr 没带上指错的路径 ${target}：${result.stderr}`);

    // 2) 报告照出：--json 是一份完整报告，必须能被解析回读
    const report = JSON.parse(result.stdout);
    assert.equal(report.fishes.length, 1, '逃生口只该体检用户指的那一条鱼，实际多出或少了一条');

    const [fish] = report.fishes;
    assert.equal(fish.id, expectedId(target), '鱼的 id 说明这次走的是哪条逃生口');
    assert.equal(fish.kind, 'unknown', `那条鱼必须标 unknown，不能冒充正常：${fish.kind}`);
    assert.equal(fish.severity, 'unknown', `那条鱼的总体结论必须是 unknown：${fish.severity}`);

    // 3) 六格逐格都不许是正常：只断言 kind/severity 可能被「一格正常」蒙混过去
    for (const id of INDICATOR_IDS) {
      assert.equal(fish.indicators[id].level, 'unknown', `${id} 读不到输入却判出了 ${fish.indicators[id].level}`);
      assert.equal(fish.indicators[id].severity, 'unknown', `${id} 的 severity 必须是 unknown`);
    }
    assert.match(fish.headline, /判不出/u, `headline 没把判不出说清：${fish.headline}`);
    assert.doesNotMatch(fish.headline, /活跃|干净|齐了|对齐/u, `headline 把读不到说成了正常：${fish.headline}`);

    // 4) 总评也要承认「这些不是正常」，不能只靠六格
    assert.match(report.verdict, /6 判不出/u, `总评没数到 6 格判不出：${report.verdict}`);
    assert.match(report.verdict, /不是正常/u, `总评把 unknown 说成了正常：${report.verdict}`);
  });
}

test('--root 指到不存在路径：默认模式也照常写出 HTML 报告', { skip: SKIP_WIN }, () => {
  const target = path.join(TEMP_ROOT, 'no-such-pond-html');
  const result = runCli([`--root`, target], { json: false });

  assert.equal(result.status, 0, `默认模式不该崩，实际 exit=${result.status}；stderr=${result.stderr}`);
  assert.match(result.stderr, /窝不存在/u);

  // stdout 只打印报告路径：文件必须真的在，而且是一页完整报告而不是空壳
  const reportedPath = result.stdout.trim();
  assert.ok(path.isAbsolute(reportedPath), `stdout 应是绝对报告路径：${result.stdout}`);
  assert.equal(fs.existsSync(reportedPath), true, `报告文件没写出来：${reportedPath}`);
  const html = fs.readFileSync(reportedPath, 'utf8');
  assert.ok(html.includes('鱼况体检报告'), 'HTML 缺标题');
  assert.equal(html.split('<article class="card').length - 1, 1, 'HTML 里必须正好有一张鱼卡');
  assert.ok(html.includes('本报告只读、不联网、无遥测。'), 'HTML 缺底部只读声明');
});
