/**
 * pond-check · D3 收口测试：读取层聚合（tests/read.test.mjs）
 *
 * 覆盖任务要求的五种场景：正常读取 / 超大日志 / 空文件 / 无权限(chmod 000) / 凭证跳过，
 * 外加：evidence 定位、degraded 机械映射、readAll 顺序与坏输入、关键词单一来源。
 *
 * 夹具都建在系统临时目录里（会 chmod 000、会造几百 KB 的日志），不往仓库塞大文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readPond, readAll, resolvePondSources } from '../src/read/index.mjs';
import { loadKeywordCategories, DEFAULT_TAIL_BYTES, MAX_TAIL_LINES } from '../src/read/log.mjs';

const ROOTS = [];

/** 建一个临时窝，files: { 相对路径: 内容 } */
async function makePond(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pond-read-'));
  ROOTS.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

test.after(async () => {
  for (const root of ROOTS) {
    // 先把可能被 chmod 000 的目录/文件恢复，再删
    await chmodTree(root).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

async function chmodTree(root) {
  const { readdir, stat } = await import('node:fs/promises');
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    await chmod(abs, 0o755).catch(() => {});
    if (entry.isDirectory()) await chmodTree(abs);
  }
}

/** 一条「健康」的日志：有 ISO 时间戳、有 412、有普通业务行 */
function healthyLog(times = 6) {
  const base = Date.parse('2026-11-07T02:00:00.000Z');
  const lines = [];
  for (let i = 0; i < times; i += 1) {
    lines.push(`${new Date(base + i * 60_000).toISOString()} INFO 已处理 BV1xx${i}`);
  }
  lines.push(`${new Date(base + times * 60_000).toISOString()} ERROR HTTP 412 Precondition Failed`);
  return `${lines.join('\n')}\n`;
}

test('正常读取：日志 / 配置 / 判重表 / 会话目录全部拿到', async () => {
  const now = Date.now();
  const root = await makePond({
    'logs/duty.log': healthyLog(),
    'config.json': JSON.stringify({ schemaVersion: 1, model: 'gpt-x', token: 'SHOULD_NOT_LEAK' }),
    'state/seen.json': JSON.stringify([{ bvid: 'BV1', processedAt: new Date(now).toISOString() }]),
    'sessions/s1.json': '{}',
  });

  const result = await readPond(
    { id: 'dsh-home:normal', kind: 'dsh-home', rootPath: root },
    // home 指到空临时目录：凭证新鲜度只 stat 白名单路径，这样结果与本机 $HOME 无关
    { now, home: await makePond({}) },
  );

  assert.equal(result.ok, true);
  assert.equal(result.id, 'dsh-home:normal');
  assert.equal(result.paths.log, path.join(root, 'logs/duty.log'));
  assert.equal(result.paths.config, path.join(root, 'config.json'));
  assert.equal(result.paths.dedupe, path.join(root, 'state/seen.json'));
  assert.equal(result.paths.sessionDir, path.join(root, 'sessions'));

  assert.deepEqual(result.sources.log.status, 'ok');
  assert.deepEqual(result.sources.config.status, 'ok');
  assert.deepEqual(result.sources.dedupe.status, 'ok');
  assert.deepEqual(result.sources.sessions.status, 'ok');

  // 日志：尾行 + 时间戳 + 关键词
  assert.equal(result.log.ok, true);
  assert.equal(result.log.lines.at(-1).includes('412'), true);
  assert.equal(result.log.lastTimestamp.format, 'iso');
  // D8c 弱断言 #7：`hardHits >= 1` 分不清「命中一次」和「命中无数次」，
  // 也测不出单点回归。夹具只有一行 412，精确锁 1。
  assert.equal(result.log.keywords.hardHits, 1, '夹具只有一行 412，hardHits 必须恰好是 1');

  // 配置：版本号读到了，敏感键的值一个字都不能出现
  assert.equal(result.config.schemaVersion, 1);
  assert.equal(JSON.stringify(result).includes('SHOULD_NOT_LEAK'), false);

  // 判重表：条数与今日新增
  assert.equal(result.dedupe.count, 1);
  assert.equal(result.dedupe.todayNew, 1);

  // 会话目录：至少有文件、有年龄
  assert.equal(result.sessions.fileCount, 1);
  assert.equal(typeof result.sessions.ageSec, 'number');

  // 依赖四件套存在（不判档位，只要求事实字段在）
  assert.equal(typeof result.deps, 'object');
  assert.equal(typeof result.deps.node.version, 'string');
  // D8c 弱断言 #10：`foundCount >= 0` 连「本机没有凭证却谎报有」都能过。
  // 家目录是空临时目录，白名单里的凭证一个都不存在 → 必须如实 0 + 说明原因。
  assert.equal(result.credentials.foundCount, 0, '空家目录里不该凭空找到凭证');
  assert.equal(result.credentials.reason, 'no_credentials_found', '找不到凭证要留机器码，不能沉默');
  assert.equal(result.credentials.newestAgeSec, null, '没有凭证时不该编一个「最近更新」出来');

  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unreadable, []);
  assert.deepEqual(result.degraded, []);
});

// D8c 弱断言 #7 的补充：原夹具一行同时含 412 与 Precondition Failed，
// 删掉任意一个关键词仍会通过。这里把数字边界单独钉死：
//   - 独立 token 412 → 命中（风控）
//   - 4121 / ?aid=412 → 绝不能命中（黏在数字/查询参数里的 412 不是状态码）
test('关键词数字边界：独立 412 命中；4121 与 ?aid=412 不得误报风控', async () => {
  const now = Date.now();
  const root = await makePond({
    'logs/duty.log': [
      `${new Date(now - 180_000).toISOString()} ERROR HTTP 412 只有状态码的一行`,
      `${new Date(now - 120_000).toISOString()} INFO sleep 4121ms 正常轮询`,
      `${new Date(now - 60_000).toISOString()} GET /x/web-interface?aid=412 正常请求`,
    ].join('\n') + '\n',
  });
  const result = await readPond({ rootPath: root, id: 'keyword-boundary' }, { now });

  const risk = result.log.keywords.categories.find((category) => category.id === 'riskControl');
  assert.equal(risk.count, 1, `只有独立 token 412 该命中，实际命中 ${risk.count} 行`);
  assert.deepEqual(risk.matchedKeywords, ['412'], '命中的关键词必须恰好是 412 本身');
  assert.equal(result.log.keywords.hardHits, 1, '误报会让 hardHits 变大，进而把健康判得更差');
});

test('超大日志：只读尾部预算字节，窗口外的旧错误不算进健康', async () => {
  const now = Date.now();
  // 每行约 100 字节，共约 700 KB —— 远大于 budget.tailBytes(262144)
  const lines = [`${new Date(now - 3_600_000).toISOString()} ERROR 429 Too Many Requests`];
  for (let i = 0; i < 7000; i += 1) {
    lines.push(`${new Date(now - 3_500_000 + i * 1000).toISOString()} INFO line ${i} 普通业务日志填充填充`);
  }
  lines.push(`${new Date(now).toISOString()} ERROR HTTP 412 Precondition Failed`);
  const content = `${lines.join('\n')}\n`;
  assert.ok(Buffer.byteLength(content) > DEFAULT_TAIL_BYTES, '夹具必须真的超过预算字节数');

  const root = await makePond({ 'logs/big.log': content });
  const result = await readPond({ rootPath: root }, { now });

  // 默认读取量必须等于 rules.json 的预算（262144），不是早先硬编码的 64 KiB
  assert.equal(DEFAULT_TAIL_BYTES, 262144);
  assert.equal(result.log.ok, true);
  assert.equal(result.log.bytesRead, 262144);
  assert.equal(result.log.truncated, true);
  assert.equal(result.log.fromOffset + result.log.bytesRead, result.log.size);
  assert.ok(result.log.lineCount > 1000, '窗口里应该还有上千行');
  // 契约变更（D4a 反馈）：readPond 必须显式传 tailLines 上限。
  // 只回默认 50 行时，196 行覆盖 7 天的真实日志只能给 rhythm 1.7 天可见度，
  // rhythm 会永远落 unknown —— 这不是保守，是覆盖不足。
  assert.equal(result.log.lines.length, MAX_TAIL_LINES, 'readPond 必须传满行数上限，否则 rhythm 覆盖不足');

  // 窗口外的 429 不算命中；窗口内的 412 必须命中
  const rate = result.log.keywords.categories.find((c) => c.id === 'rateLimited');
  const risk = result.log.keywords.categories.find((c) => c.id === 'riskControl');
  assert.equal(rate.count, 0, '窗口外的 429 不许被算进来');
  assert.equal(risk.count, 1);
});

test('空文件：不崩，日志这一路老实降级为 unknown', async () => {
  const now = Date.now();
  const root = await makePond({ 'logs/empty.log': '' }, {});
  const result = await readPond({ rootPath: root }, { now });

  assert.equal(result.ok, true, '单条鱼不该因为一个空文件整段失败');
  assert.equal(result.log.ok, false);
  assert.equal(result.log.reason, 'empty');
  assert.equal(result.sources.log.status, 'unreadable');
  assert.equal(result.sources.log.reason, 'empty');
  assert.deepEqual(result.unreadable, [{ source: 'log', reason: 'empty' }]);

  const indicators = result.degraded.map((item) => item.indicator);
  assert.ok(indicators.includes('health'));
  assert.ok(indicators.includes('rhythm'));
  assert.equal(result.degraded.find((i) => i.indicator === 'health').reason, 'empty');
});

test('无权限（chmod 000）：读不到就报读不到，不当成正常', async (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    // 环境敏感点 #1：写清为什么跳过、在什么环境会跑（root 下 skip 不是静默）
    const reason = 'chmod 000 只对非 root 的 POSIX 用户生效（root 无视权限位，Windows 没有 POSIX 权限位），'
      + '无法制造「读不到」；权限降级用例在「非 root 的 Linux/macOS」上执行';
    t.diagnostic(reason);
    t.skip(reason);
    return;
  }
  const now = Date.now();
  const root = await makePond({
    'logs/duty.log': healthyLog(),
    'config.json': JSON.stringify({ schemaVersion: 1 }),
  });
  await chmod(path.join(root, 'logs/duty.log'), 0o000);
  await chmod(path.join(root, 'config.json'), 0o000);

  const result = await readPond({ rootPath: root }, { now });
  assert.equal(result.ok, true);
  assert.equal(result.log.ok, false);
  assert.equal(result.log.reason, 'eacces');
  assert.equal(result.sources.log.status, 'unreadable');
  assert.equal(result.sources.log.reason, 'eacces');

  assert.equal(result.config.reason === 'permission_denied' || result.config.reason === 'read_error', true);
  assert.equal(result.sources.config.status, 'unreadable');

  const indicators = result.degraded.map((i) => i.indicator);
  assert.ok(indicators.includes('health'));
  assert.ok(indicators.includes('drift'));
});

test('deps.homeWritable 按每条鱼自己的窝判，不是拿 $HOME 顶替', async (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    const reason = '目录写权限只对非 root 的 POSIX 用户生效（root 无视权限位，Windows 没有 POSIX 权限位），'
      + '无法制造「不可写」；homeWritable 用例在「非 root 的 Linux/macOS」上执行';
    t.diagnostic(reason);
    t.skip(reason);
    return;
  }
  const now = Date.now();
  const writableRoot = await makePond({ 'files/a.txt': 'x' });
  const readonlyRoot = await makePond({ 'files/b.txt': 'x' });
  await chmod(readonlyRoot, 0o555);

  const results = await readAll(
    [{ id: 'rw', rootPath: writableRoot }, { id: 'ro', rootPath: readonlyRoot }],
    { now },
  );
  assert.equal(results[0].deps.homeWritable.writable, true);
  assert.equal(results[1].deps.homeWritable.writable, false, '不可写的窝必须报 false，不能被共用结果糊弄过去');

  await chmod(readonlyRoot, 0o755);
});

test('凭证跳过：不读、不 stat、名字不进任何输出', async () => {
  const now = Date.now();
  const root = await makePond({
    'logs/duty.log': healthyLog(),
    'logs/api_token.log': `${new Date(now).toISOString()} ERROR 412`,
    'bilibili_cookie.json': '{"SESSDATA":"SECRET_COOKIE"}',
    '.env.local': 'API_KEY=SECRET_ENV',
    'id_ed25519': 'PRIVATE_KEY',
  });

  // 1) 显式指定一个凭证类日志路径 → 必须被拒，槽位记为 skipped_sensitive
  const explicit = await readPond(
    { rootPath: root, paths: { log: path.join(root, 'logs/api_token.log') } },
    { now },
  );
  assert.equal(explicit.skippedSensitive.includes('log'), true);
  assert.equal(explicit.paths.log === null || explicit.paths.log === undefined
    || !explicit.paths.log.includes('api_token'), true);

  // 2) 正常情况下，logs/ 里更新的 api_token.log 不许被选成「当前日志」
  const picked = await readPond({ rootPath: root }, { now });
  assert.ok(picked.paths.log.endsWith('duty.log'), `选错了日志：${picked.paths.log}`);

  // 3) 任何输出里都不许出现凭证文件名或内容
  const dump = JSON.stringify([explicit, picked]);
  for (const leak of ['api_token', 'bilibili_cookie', '.env.local', 'id_ed25519',
    'SESSDATA', 'SECRET_COOKIE', 'SECRET_ENV', 'PRIVATE_KEY']) {
    assert.equal(dump.includes(leak), false, `泄漏了：${leak}`);
  }
});

test('evidence 定位优先于浅列举（D2b 给的相对路径说了算）', async () => {
  const now = Date.now();
  const root = await makePond({
    'logs/run-2099.txt': healthyLog(), // 扩展名不是 .log，浅列举认不出
    'conf/my.json': JSON.stringify({ schemaVersion: 3 }),
    'seen/store.data': JSON.stringify([{ bvid: 'BV', processedAt: new Date(now).toISOString() }]),
    'chat-records/c1.json': '{}',
  });

  const pond = {
    id: 'dsh-home:evidence',
    kind: 'dsh-home',
    rootPath: root,
    evidence: {
      logFile: 'logs/run-2099.txt',
      configFile: 'conf/my.json',
      dedupeCandidates: ['seen/store.data'],
      sessionDir: 'chat-records',
    },
  };
  const result = await readPond(pond, { now });

  assert.equal(result.paths.log, path.join(root, 'logs/run-2099.txt'));
  assert.equal(result.paths.config, path.join(root, 'conf/my.json'));
  assert.equal(result.paths.dedupe, path.join(root, 'seen/store.data'));
  assert.equal(result.paths.sessionDir, path.join(root, 'chat-records'));
  assert.equal(result.log.ok, true);
  assert.equal(result.config.schemaVersion, 3);
  assert.equal(result.dedupe.count, 1);
});

test('什么都没有的窝：六项指标全部落 degraded，不许沉默当正常', async () => {
  const now = Date.now();
  const root = await makePond({ 'readme.md': 'nothing here' });
  const result = await readPond({ id: 'unknown:empty', rootPath: root }, { now });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing.sort(), ['config', 'dedupe', 'log', 'sessions']);
  const byIndicator = Object.fromEntries(result.degraded.map((i) => [i.indicator, i]));
  for (const indicator of ['liveness', 'rhythm', 'throughput', 'health', 'drift']) {
    assert.ok(byIndicator[indicator], `${indicator} 必须有降级留痕`);
  }
  assert.deepEqual(byIndicator.liveness.missing, ['log', 'session', 'dedupe']);
});

test('readAll：顺序与入参一致，坏输入不炸', async () => {
  const now = Date.now();
  const rootA = await makePond({ 'logs/a.log': healthyLog() });
  const rootB = await makePond({ 'logs/b.log': healthyLog() });

  const ponds = [
    { id: 'a', kind: 'standalone', rootPath: rootA },
    null,
    { id: 'c', rootPath: 12345 },
    { id: 'b', kind: 'dsh-home', rootPath: rootB },
  ];
  const results = await readAll(ponds, { now });

  assert.equal(results.length, ponds.length);
  assert.equal(results[0].id, 'a');
  assert.equal(results[0].sources.log.status, 'ok');
  assert.equal(results[1].ok, true, 'null 入参也要给出一条降级结果，不是抛异常');
  assert.deepEqual(results[1].missing.sort(), ['config', 'dedupe', 'log', 'sessions']);
  assert.equal(results[2].ok, true);
  assert.equal(results[3].id, 'b');
  assert.equal(results[3].paths.log, path.join(rootB, 'logs/b.log'));

  const empty = await readAll(undefined, { now });
  assert.deepEqual(empty, []);
});

test('关键词单一来源：聚合层不另写表，health 关键词与 rules.json 完全一致', async () => {
  const now = Date.now();
  const root = await makePond({ 'logs/duty.log': healthyLog() });
  const result = await readPond({ rootPath: root }, { now });

  const fromRules = loadKeywordCategories();
  assert.deepEqual(
    result.log.keywords.categories.map((c) => c.id),
    fromRules.map((c) => c.id),
  );
  // 聚合层不得改写计数：三者必须自洽
  const hard = result.log.keywords.categories
    .filter((c) => c.kind === 'hard')
    .reduce((sum, c) => sum + c.count, 0);
  const soft = result.log.keywords.categories
    .filter((c) => c.kind === 'soft')
    .reduce((sum, c) => sum + c.count, 0);
  assert.equal(result.log.keywords.hardHits, hard);
  assert.equal(result.log.keywords.softHits, soft);
});

test('resolvePondSources：已安装的 DSH 插件会补上 profile 目录一起找', async () => {
  const now = Date.now();
  const root = await makePond({
    'profiles/web/node_modules/dsh-whale-widget/package.json': '{"name":"dsh-whale-widget"}',
    'profiles/web/logs/web.log': healthyLog(),
    'profiles/web/config.json': JSON.stringify({ schemaVersion: 2 }),
  });

  const result = await readPond(
    { id: 'dsh-plugin:web/dsh-whale-widget', kind: 'dsh-plugin', rootPath: path.join(root, 'profiles/web/node_modules/dsh-whale-widget') },
    { now },
  );

  assert.equal(result.paths.probeRoots.includes(path.join(root, 'profiles/web')), true);
  assert.equal(result.paths.log, path.join(root, 'profiles/web/logs/web.log'));
  assert.equal(result.paths.config, path.join(root, 'profiles/web/config.json'));

  // 定位器单独调用也要能拿到同样的结论
  const resolved = await resolvePondSources({ rootPath: path.join(root, 'profiles/web') });
  assert.equal(resolved.paths.log, path.join(root, 'profiles/web/logs/web.log'));
});
