/**
 * pond-check · v0.1.1 探测精度回归（tests/probe-precision.test.mjs）
 *
 * 钉住 D8 审查遗留的三条「探测精度」缺陷：
 *   D8-L6  数字关键词边界不排字母：`BV412` / `?aid=412` 被算成风控（假报警方向）
 *   D8-L3  skipDirPatterns 漏了 *cred* / *cert*（实测 minasCred / minasCert 被 readdir 列名）
 *   D8-L5  windowStale 的 nextStep 是拼接的（「不用动。先看『存活』那栏…」自相矛盾）
 *
 * 每条用例都对应一次变异验证（把修复改回旧逻辑，这里必须红）：
 *   - D8-L6：把 compileCategory 里的边界正则改回裸子串 → 「字母/版本号里的 412」用例红
 *   - D8-L3：从 rules.json 删掉新增的 *cred / *cert 模式 → minasCred 用例红
 *   - D8-L5：把 `nextStep = fillTemplate(...)` 改回 `nextStep += ...` → 替换断言红
 * 变异命令与红/绿输出记录在提交说明与任务 output 里。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { classifyLine, readLogTail } from '../src/read/log.mjs';
import { discoverGeneric, isSensitiveDirName } from '../src/discover/generic.mjs';
import { evaluateHealth, getRules } from '../src/evaluate/system.mjs';

const RULES = getRules();
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0); // 2026-11-07T12:00:00Z
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-probe-precision-'));

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function hitIds(text) {
  return classifyLine(text).map((hit) => hit.id);
}

/* ------------------------------------------------------------------ *
 * D8-L6 · 数字关键词必须是独立 token
 * ------------------------------------------------------------------ */

test('D8-L6 字母/数字/键值对/版本号里的 412 不算风控（假报警方向）', () => {
  const falsePositives = [
    'BV412',            // BVID 形态：412 紧邻字母 V
    '?aid=412',         // URL 查询参数：412 是参数值，不是状态码（'=' 也是黏连符）
    'video412',         // 自增 ID / 标识符后缀
    'item412',          // 同上
    'sleep 4121ms',     // 412 是更长数字的一部分（既有用例，别回退）
    'version 1.412.0',  // 版本号（既有用例，别回退）
    'v1.412.0',         // 版本号的另一写法
  ];

  for (const text of falsePositives) {
    const ids = hitIds(text);
    assert.equal(
      ids.includes('riskControl'),
      false,
      `「${text}」被算成风控 412 —— 这正是 D8-L6 那条假报警`,
    );
  }

  // 另外三个数字关键词同样不能从 identifier 里命中
  assert.equal(hitIds('aid=401').includes('loginExpired'), false, 'aid=401 不该算登录失效');
  assert.equal(hitIds('BV1429').includes('rateLimited'), false, 'BV1429 不该算被限流');
  assert.equal(hitIds('video403').includes('riskControl'), false, 'video403 不该算风控 403');
});

test('D8-L6 真实风控行仍然命中（排字母不能把真报警一起排掉）', () => {
  const positives = [
    ['ERROR HTTP 412 Precondition Failed', 'riskControl'],
    ['429 Too Many Requests', 'rateLimited'],
    ['401 Unauthorized', 'loginExpired'],
    ['403 Forbidden', 'riskControl'],
    ['412', 'riskControl'],                 // 行首行尾也是合法边界
    ['请求返回412，已停止', 'riskControl'],   // 中文是分隔符，不是字母数字
    ['B站返回 -412', 'riskControl'],         // -412 这个关键词也要活
  ];

  for (const [text, expected] of positives) {
    const ids = hitIds(text);
    assert.ok(
      ids.includes(expected),
      `「${text}」没有命中 ${expected}（真实风控被边界规则误杀）`,
    );
  }
});

test('D8-L6 日志集成：20 行 BV412 不再报「风控拦截 ×20」，真 412 仍计 1 次', async () => {
  const noiseLines = [];
  for (let i = 0; i < 20; i += 1) noiseLines.push(`bvid BV412 第 ${i} 条普通业务日志`);

  const noiseFile = path.join(TMP, 'bvid-only.log');
  fs.writeFileSync(noiseFile, `${noiseLines.join('\n')}\n`);
  const noiseTail = await readLogTail(noiseFile);
  assert.equal(noiseTail.ok, true, 'BV412 日志不该读失败');
  const noiseRisk = noiseTail.keywords.categories.find((item) => item.id === 'riskControl');
  assert.equal(
    noiseRisk.count,
    0,
    `20 行 BV412 被数成 ${noiseRisk.count} 次风控拦截 —— 报告会平白多一条假报警`,
  );

  const realFile = path.join(TMP, 'real-risk.log');
  fs.writeFileSync(
    realFile,
    `${['ERROR HTTP 412 Precondition Failed', ...noiseLines].join('\n')}\n`,
  );
  const realTail = await readLogTail(realFile);
  const realRisk = realTail.keywords.categories.find((item) => item.id === 'riskControl');
  assert.equal(realRisk.count, 1, '真实 412 行必须仍然计 1 次（且 BV412 不跟着混进来）');
});

/* ------------------------------------------------------------------ *
 * D8-L3 · 凭证类目录模式（*cred* / *cert* 的保守版本）
 * ------------------------------------------------------------------ */

test('D8-L3 minasCred / minasCert 这类目录被识别，credits / certified 不被误杀', () => {
  const shouldSkip = [
    'minasCred', 'minasCert',   // D8-BOUNDARY 实测到的两个目录
    'cred', 'creds', 'certs',
    'my-cert', 'my_creds', 'cert-store', 'cred_cache',
  ];
  for (const name of shouldSkip) {
    assert.equal(
      isSensitiveDirName(name),
      true,
      `目录「${name}」没命中 skipDirPatterns —— 凭证类目录名会被 readdir 列出来`,
    );
  }

  const shouldKeep = ['credits', 'certified', 'secretary'];
  for (const name of shouldKeep) {
    assert.equal(
      isSensitiveDirName(name),
      false,
      `目录「${name}」被误杀成凭证目录 —— 这是保守补模式的底线`,
    );
  }
});

test('D8-L3 实测：minasCred / minasCert 不产出鱼窝，credits / certified 照常被发现', async () => {
  const home = path.join(TMP, 'home-probe');
  const dshHome = path.join(TMP, 'dsh-home-empty');

  const makeFishDir = (name) => {
    const root = path.join(home, name);
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ schemaVersion: 3 }));
    fs.writeFileSync(path.join(root, 'logs', 'run.log'), 'INFO poll ok\n');
    fs.writeFileSync(path.join(root, 'state', 'seen.json'), '[]');
    return root;
  };

  for (const name of ['minasCred', 'minasCert', 'credits', 'certified']) makeFishDir(name);

  const found = await discoverGeneric({ home, dshHome });
  const names = found.map((fish) => path.basename(fish.rootPath));

  assert.equal(
    names.includes('minasCred'),
    false,
    `minasCred 被当成鱼窝报出来了：${names.join('、')}`,
  );
  assert.equal(
    names.includes('minasCert'),
    false,
    `minasCert 被当成鱼窝报出来了：${names.join('、')}`,
  );
  assert.equal(
    names.includes('credits'),
    true,
    `credits 是正常目录，却被跳过（本次扫到：${names.join('、')}）`,
  );
  assert.equal(
    names.includes('certified'),
    true,
    `certified 是正常目录，却被跳过（本次扫到：${names.join('、')}）`,
  );
});

/* ------------------------------------------------------------------ *
 * D8-L5 · windowStale 的 nextStep 必须是替换
 * ------------------------------------------------------------------ */

/** 构造一条日志尾部早于窗口的 read（其余条件足够判 clean）。 */
function staleHealthRead(offsetMs) {
  const lastMs = NOW - offsetMs;
  return {
    now: NOW,
    sources: { log: { status: 'ok', reason: null } },
    log: {
      ok: true,
      path: '/tmp/probe-precision/app.log',
      size: 1024,
      bytesRead: 1024,
      fromOffset: 0,
      truncated: false,
      firstLinePartial: false,
      hasBinary: false,
      lines: [`${new Date(lastMs).toISOString()} INFO poll ok`],
      lineCount: 5,
      linesTruncated: false,
      lastTimestamp: { ms: lastMs, iso: new Date(lastMs).toISOString() },
      firstTimestamp: null,
      keywords: { categories: [], hardHits: 0, softHits: 0, matched: [] },
      degraded: [],
    },
  };
}

test('D8-L5 windowStale：nextStep 被专用文案替换，不许留下「不用动。先看…」', () => {
  const variant = RULES.indicators.health.variants.windowStale;
  assert.equal(
    typeof variant?.nextStepTemplate,
    'string',
    'rules.json 里缺 health.variants.windowStale.nextStepTemplate —— 替换文案没来源',
  );

  const indicator = evaluateHealth(staleHealthRead(10 * DAY), { now: NOW });
  assert.equal(indicator.level, 'clean', '夹具应落在 clean 档，否则测不到这条拼接缺陷');
  assert.equal(indicator.evidence.windowStale, true);

  const expectedNextStep = variant.nextStepTemplate
    .replace('{ageHuman}', '10 天')
    .replace('{windowHours}', '24');
  assert.equal(
    indicator.nextStep,
    expectedNextStep,
    `windowStale 的 nextStep 应该是替换后的专用文案，实际：${indicator.nextStep}`,
  );
  assert.equal(
    indicator.nextStep.includes('不用动'),
    false,
    `nextStep 里还留着 clean 档的「不用动」。—— 说明又在拼接：${indicator.nextStep}`,
  );

  // 现象侧仍然要把「日志停在窗口之外」说清楚（这句不是矛盾来源，但不能丢）
  const expectedSuffix = variant.phenomenonSuffix
    .replace('{ageHuman}', '10 天')
    .replace('{windowHours}', '24');
  assert.ok(
    indicator.phenomenon.endsWith(expectedSuffix),
    `windowStale 的 phenomenon 没带上窗口过期注脚：${indicator.phenomenon}`,
  );
});

test('D8-L5 非过期窗口仍用档位原话术（替换不能误伤正常路径）', () => {
  const indicator = evaluateHealth(staleHealthRead(HOUR), { now: NOW });
  assert.equal(indicator.evidence.windowStale, false);
  assert.equal(indicator.level, 'clean');
  assert.equal(
    indicator.nextStep,
    RULES.indicators.health.diagnosis.clean.nextStep,
    '窗口没过期时 nextStep 不该被 windowStale 文案替换',
  );
  assert.equal(
    indicator.phenomenon,
    RULES.indicators.health.diagnosis.clean.phenomenon,
    '窗口没过期时 phenomenon 不该被附加注脚',
  );
});
