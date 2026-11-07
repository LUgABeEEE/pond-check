/**
 * pond-check · C1 能力基座测试（tests/shared.test.mjs）
 *
 * 这个文件钉的是**五个能力共用的地基**，不是任何一个能力的功能：
 *   1. provider 注册表：登记 / 校验 / 排序 / 过滤 / 副本隔离
 *   2. 事件流：字段形状、append-only、POND_HOME 覆盖、写入失败只 warn
 *   3. 成本记账：today / total、窗口边界、本地 provider 恒 0、脏行跳过
 *   4. 统一调用器：超时表、网络重试 500ms、鉴权不重试、降级链、
 *      全失败时 CapabilityError 带每个 provider 的原因、事件写坏不影响返回值
 *   5. 隔离守卫：src/shared 不 import 诊断层、不 import 网络模块
 *
 * 验收门（任务书原话）：
 *   node --test tests/shared.test.mjs 全绿；覆盖注册/排序、鉴权错不重试、
 *   降级链走通、全失败报错含每个原因、事件写入失败不影响返回值。
 *   变异验证：断开降级链测试必须红（见任务 commandsRun 的 M1–M4）。
 *
 * 测试纪律：
 *   - 所有事件写入都指向 mkdtemp 的临时 POND_HOME，绝不碰真实 `~/.pond`；
 *   - 时间用注入的 `now`，只有「memory 2s 真实超时」一条用真时钟；
 *   - 重试退避用注入的 `sleep` 记录延迟，不真的等 500ms（语义仍是 spec 的 500ms）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as shared from '../src/shared/index.mjs';
import {
  ProviderRegistry,
  createRegistry,
  estimateCost,
  normalizeProvider,
  roundCost,
  RegistryError,
  COST_UNITS,
  REQUIREMENTS,
  buildAttemptEntry,
  appendAttempt,
  readEvents,
  EVENT_FIELDS,
  spentToday,
  spentTotal,
  spentSince,
  startOfLocalDay,
  invoke,
  call,
  classifyError,
  CapabilityError,
  TimeoutError,
  CAPABILITY_TIMEOUTS,
  DEFAULT_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  MAX_RETRIES,
  resolvePondHome,
  eventsFilePath,
} from '../src/shared/index.mjs';

/* ------------------------------------------------------------------ *
 * 夹具地基
 * ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-shared-'));
let counter = 0;

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

/** 造一个独立的 POND_HOME（每个用例一个，互不串账）。 */
function makeHome(label) {
  counter += 1;
  const home = path.join(TEMP_ROOT, `${String(counter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function envFor(home) {
  return { POND_HOME: home };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function readHomeEvents(home) {
  return readJsonl(path.join(home, 'events.jsonl'));
}

/** 最小合法 provider 描述。 */
function provider(id, overrides = {}) {
  return {
    id,
    name: id,
    local: false,
    requires: [],
    cost: { unit: 'perCall', value: 0 },
    caps: [],
    priority: 0,
    ...overrides,
  };
}

/** 网络抖动类错误（Node / undici 常见形状）。 */
function networkError(message = 'socket hang up') {
  const error = new Error(message);
  error.code = 'ECONNRESET';
  return error;
}

/** HTTP 状态错误。 */
function statusError(status, message = `HTTP ${status}`) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** 可注入的 sleep：记录延迟，不真的等。 */
function makeSleep() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => { delays.push(ms); },
  };
}

/* ================================================================== *
 * 1. Provider 注册表
 * ================================================================== */

test('注册表·规范化：缺省字段补全，未知字段保留', () => {
  const registry = createRegistry();
  const returned = registry.register('tts', {
    id: 'edge',
    name: 'Edge TTS',
    requires: ['network'],
    caps: ['mp3', 'ssml'],
    priority: 50,
    cost: { unit: 'perKChar', value: 0.5 },
  });
  assert.equal(returned.id, 'edge');
  assert.equal(returned.name, 'Edge TTS');
  assert.equal(returned.local, false, 'local 缺省必须是 false');
  assert.deepEqual(returned.requires, ['network']);
  assert.deepEqual(returned.caps, ['mp3', 'ssml']);
  assert.deepEqual(returned.cost, { unit: 'perKChar', value: 0.5 });
  assert.equal(returned.priority, 50);

  const minimal = registry.register('tts', { id: 'plain' });
  assert.equal(minimal.name, 'plain', 'name 缺省取 id');
  assert.deepEqual(minimal.requires, []);
  assert.deepEqual(minimal.caps, []);
  assert.deepEqual(minimal.cost, { unit: 'perCall', value: 0 });
  assert.equal(minimal.priority, 0);

  const withExtras = registry.register('tts', { id: 'custom', voiceMap: { xiaoyi: 'zh-CN-XiaoyiNeural' } });
  assert.deepEqual(withExtras.voiceMap, { xiaoyi: 'zh-CN-XiaoyiNeural' }, 'adapter 自定义字段必须保留');
});

test('注册表·拒绝畸形描述（不许静默吃下）', () => {
  const registry = createRegistry();
  const cases = [
    ['缺 id', () => registry.register('tts', { name: 'x' })],
    ['id 非字符串', () => registry.register('tts', { id: 123 })],
    ['requires 非数组', () => registry.register('tts', { id: 'a', requires: 'network' })],
    ['requires 未知依赖', () => registry.register('tts', { id: 'a', requires: ['gpu'] })],
    ['caps 含非字符串', () => registry.register('tts', { id: 'a', caps: [1] })],
    ['负成本', () => registry.register('tts', { id: 'a', cost: { unit: 'perCall', value: -1 } })],
    ['成本 NaN', () => registry.register('tts', { id: 'a', cost: { unit: 'perCall', value: Number.NaN } })],
    ['未知成本口径', () => registry.register('tts', { id: 'a', cost: { unit: 'perKchars', value: 1 } })],
    ['priority 非数字', () => registry.register('tts', { id: 'a', priority: 'high' })],
    ['local 非布尔', () => registry.register('tts', { id: 'a', local: 'yes' })],
    ['capability 为空', () => registry.register('', { id: 'a' })],
  ];
  for (const [label, fn] of cases) {
    assert.throws(fn, (error) => error instanceof RegistryError
      && error.code === 'REGISTRY_INVALID'
      && typeof error.message === 'string'
      && error.message.length > 0, `${label} 必须抛 RegistryError`);
  }
  assert.equal(registry.count('tts'), 0, '校验失败不能留下半截登记');
});

test('注册表·同 id 默认拒绝覆盖，显式 replace 才生效', () => {
  const registry = createRegistry();
  registry.register('tts', provider('edge', { priority: 10 }));
  assert.throws(
    () => registry.register('tts', provider('edge', { priority: 90 })),
    (error) => error instanceof RegistryError && /已存在/.test(error.message),
  );
  assert.equal(registry.list('tts')[0].priority, 10, '被拒绝的覆盖不能生效');

  registry.register('tts', provider('edge', { priority: 90 }), { replace: true });
  assert.equal(registry.list('tts')[0].priority, 90);
});

test('注册表·registerAll 原子性：一条坏则整批不写', () => {
  const registry = createRegistry();
  assert.throws(
    () => registry.registerAll('tts', [
      provider('good'),
      provider('bad', { requires: ['gpu'] }),
    ]),
    RegistryError,
  );
  assert.equal(registry.count('tts'), 0, '半批写入会让降级链出现幽灵 provider');
});

test('注册表·registerAll 拒绝批内重复 id', () => {
  const registry = createRegistry();
  assert.throws(
    () => registry.registerAll('tts', [provider('dup'), provider('dup')]),
    (error) => error instanceof RegistryError && /重复 id/.test(error.message),
  );
  assert.equal(registry.count('tts'), 0);
});

test('注册表·排序：priority 降序，同优先级按注册先后', () => {
  const registry = createRegistry();
  registry.register('tts', provider('a', { priority: 10 }));
  registry.register('tts', provider('b', { priority: 30 }));
  registry.register('tts', provider('c', { priority: 50 }));
  registry.register('tts', provider('d', { priority: 30 }));

  assert.deepEqual(registry.resolve('tts').map((item) => item.id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(registry.list('tts').map((item) => item.id), ['c', 'b', 'd', 'a']);
});

test('注册表·过滤：caps / require / exclude / predicate', () => {
  const registry = createRegistry();
  registry.registerAll('tts', [
    provider('edge', { priority: 50, local: true, requires: ['network'], caps: ['mp3', 'ssml'] }),
    provider('doubao', { priority: 40, requires: ['network', 'apiKey'], caps: ['mp3'] }),
    provider('command', { priority: 30, local: true, requires: ['binary'], caps: ['wav'] }),
  ]);

  assert.deepEqual(
    registry.resolve('tts', { caps: ['mp3'] }).map((item) => item.id),
    ['edge', 'doubao'],
  );
  assert.deepEqual(
    registry.resolve('tts', { caps: ['mp3', 'ssml'] }).map((item) => item.id),
    ['edge'],
  );
  assert.deepEqual(
    registry.resolve('tts', { require: ['apiKey'] }).map((item) => item.id),
    ['doubao'],
  );
  assert.deepEqual(
    registry.resolve('tts', { exclude: ['edge'] }).map((item) => item.id),
    ['doubao', 'command'],
  );
  assert.deepEqual(
    registry.resolve('tts', { predicate: (item) => item.local === true }).map((item) => item.id),
    ['edge', 'command'],
  );
  assert.deepEqual(registry.resolve('tts', { caps: ['flac'] }), []);
  assert.deepEqual(registry.resolve('不存在的能力'), []);
});

test('注册表·get / has / unregister / clear / capabilities / count', () => {
  const registry = createRegistry();
  registry.register('tts', provider('edge'));
  registry.register('image', provider('comfyui'));

  assert.equal(registry.get('tts', 'edge').id, 'edge');
  assert.equal(registry.get('tts', 'nope'), null);
  assert.equal(registry.has('tts', 'edge'), true);
  assert.equal(registry.has('tts', 'nope'), false);
  assert.deepEqual(registry.capabilities().sort(), ['image', 'tts']);
  assert.equal(registry.count('tts'), 1);
  assert.equal(registry.count('nope'), 0);

  assert.equal(registry.unregister('tts', 'edge'), true);
  assert.equal(registry.unregister('tts', 'edge'), false);
  assert.deepEqual(registry.list('tts'), []);

  registry.clear('image');
  assert.deepEqual(registry.capabilities(), ['tts']);
});

test('注册表·副本隔离：改返回值不会污染注册表', () => {
  const registry = createRegistry();
  registry.register('tts', provider('edge', { caps: ['mp3'] }));

  const first = registry.list('tts')[0];
  first.caps.push('flac');
  first.priority = 999;
  const second = registry.list('tts')[0];
  assert.deepEqual(second.caps, ['mp3']);
  assert.equal(second.priority, 0);

  const returned = registry.register('tts', provider('other', { caps: ['wav'] }));
  returned.caps.push('ogg');
  assert.deepEqual(registry.get('tts', 'other').caps, ['wav']);
});

test('注册表·实例隔离：createRegistry 与默认 registry 互不影响', () => {
  const local = createRegistry();
  local.register('tts', provider('local-only'));
  assert.deepEqual(shared.registry.list('tts'), [], '默认注册表不能被测试实例污染');
  assert.ok(shared.registry instanceof ProviderRegistry);
});

test('成本估算·口径与本地恒 0', () => {
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perKChar', value: 0.5 } }), 1200), 0.6);
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perChar', value: 0.001 } }), 1000), 1);
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perImage', value: 0.2 } }), 3), 0.6);
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perMinute', value: 1 } }), 120), 2);
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perSecond', value: 2 } }), 3), 6);
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perCall', value: 0.01 } }), 3), 0.03);

  // 本地 provider：就算填了单价也必须为 0。
  assert.equal(estimateCost(provider('x', { local: true, cost: { unit: 'perImage', value: 9 } }), 100), 0);
  // 畸形输入：不抛、不返回 NaN。
  assert.equal(estimateCost(null, 10), 0);
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perCall', value: 1 } }), Number.NaN), 0);
  assert.equal(estimateCost(provider('x', { cost: { unit: 'perCall', value: 1 } }), -5), 0);
  assert.equal(roundCost(0.1 + 0.2), 0.3);
  assert.deepEqual([...REQUIREMENTS], ['network', 'apiKey', 'binary']);
  assert.ok(COST_UNITS.includes('perKChar'));
});

/* ================================================================== *
 * 2. 事件流
 * ================================================================== */

test('事件·字段形状与顺序（前八个字段是与诊断层的契约）', () => {
  const nowMs = Date.parse('2026-11-07T12:34:56.789Z');
  const entry = buildAttemptEntry({
    capability: 'tts',
    provider: provider('edge', { cost: { unit: 'perKChar', value: 0.5 } }),
    units: 1200,
    durationMs: 830,
    ok: true,
    error: null,
  }, { now: () => nowMs });

  assert.deepEqual(Object.keys(entry).slice(0, EVENT_FIELDS.length), [...EVENT_FIELDS]);
  assert.equal(entry.ts, '2026-11-07T12:34:56.789Z');
  assert.equal(entry.capability, 'tts');
  assert.equal(entry.provider, 'edge');
  assert.equal(entry.units, 1200);
  assert.equal(entry.costEstimate, 0.6);
  assert.equal(entry.durationMs, 830);
  assert.equal(entry.ok, true);
  assert.equal(entry.error, null);
  assert.equal(entry.attempt, 1);
  assert.equal(entry.errorCategory, null);
  assert.equal(entry.degradedFrom, null);
});

test('事件·失败尝试 units 与 costEstimate 恒为 0', () => {
  const entry = buildAttemptEntry({
    capability: 'image',
    provider: provider('seedream', { cost: { unit: 'perImage', value: 1 } }),
    units: 4,
    costEstimate: 4,
    durationMs: 10,
    ok: false,
    error: 'HTTP 500',
    errorCategory: 'unknown',
    attempt: 2,
  }, { now: () => 0 });
  assert.equal(entry.units, 0);
  assert.equal(entry.costEstimate, 0, '失败也计费会让降级链把用量记成三倍');
  assert.equal(entry.error, 'HTTP 500');
  assert.equal(entry.errorCategory, 'unknown');
  assert.equal(entry.attempt, 2);
});

test('事件·append-only：连续追加不覆盖，POND_HOME 生效', async () => {
  const home = makeHome('events-append');
  const options = { env: envFor(home), now: () => Date.parse('2026-11-07T00:00:00Z') };

  const first = await appendAttempt({ capability: 'tts', provider: 'edge', units: 10, ok: true }, options);
  const second = await appendAttempt({ capability: 'image', provider: 'comfyui', units: 1, ok: true }, options);
  assert.equal(first.written, true);
  assert.equal(second.written, true);
  assert.equal(first.path, path.join(home, 'events.jsonl'));
  assert.equal(eventsFilePath(envFor(home)), path.join(home, 'events.jsonl'));
  assert.equal(resolvePondHome(envFor(home)), home);

  const lines = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, '事件流只追加，不轮转不重写');
  assert.equal(readHomeEvents(home).length, 2);
});

test('事件·本地 provider 的 costEstimate 端到端为 0', async () => {
  const home = makeHome('events-local-cost');
  await appendAttempt({
    capability: 'image',
    provider: provider('sd-command', { local: true, cost: { unit: 'perImage', value: 9 } }),
    units: 5,
    ok: true,
  }, { env: envFor(home), now: () => Date.now() });

  const [entry] = readHomeEvents(home);
  assert.equal(entry.units, 5);
  assert.equal(entry.costEstimate, 0, '本地执行不算钱（规格 §2.3）');
});

test('事件·写入失败只 warn，不抛，不改返回值', async () => {
  const home = makeHome('events-fail');
  const blocker = path.join(home, 'not-a-dir');
  fs.writeFileSync(blocker, '我是文件，不是目录');
  const warns = [];

  const result = await appendAttempt(
    { capability: 'tts', provider: 'edge', units: 1, ok: true },
    { env: envFor(blocker), warn: (message) => warns.push(message) },
  );

  assert.equal(result.written, false);
  assert.ok(result.error instanceof Error);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /事件写入失败/);
});

test('事件·读取：缺失文件、坏行、非对象行都不崩', () => {
  const home = makeHome('events-read');
  const missing = readEvents({ env: envFor(home) });
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.entries, []);

  const file = path.join(home, 'events.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ ts: new Date().toISOString(), capability: 'tts', provider: 'edge', units: 1, costEstimate: 0, durationMs: 1, ok: true, error: null }),
    '{ 这不是 JSON',
    '42',
    'null',
    '',
    JSON.stringify({ ts: new Date().toISOString(), capability: 'image', provider: 'comfyui', units: 2, costEstimate: 0, durationMs: 2, ok: true, error: null }),
  ].join('\n'));

  const read = readEvents({ env: envFor(home) });
  assert.equal(read.entries.length, 2);
  assert.equal(read.skippedLines, 3, '坏行 + 数字 + null 各算一条跳过');
  assert.equal(read.missing, false);
});

/* ================================================================== *
 * 3. 成本记账
 * ================================================================== */

test('记账·spentToday / spentTotal 按能力与本地日窗口累加', async () => {
  const home = makeHome('budget');
  const nowMs = Date.parse('2026-11-07T12:00:00+08:00');
  const dayStart = startOfLocalDay(nowMs);
  const options = { env: envFor(home) };

  const at = (offset, input) => appendAttempt(input, {
    ...options,
    now: () => dayStart + offset,
  });

  await at(1000, {
    capability: 'tts',
    provider: provider('edge', { cost: { unit: 'perKChar', value: 0.5 } }),
    units: 1200,
    ok: true,
  });
  await at(2000, {
    capability: 'tts',
    provider: provider('command', { local: true, cost: { unit: 'perKChar', value: 0.5 } }),
    units: 500,
    ok: true,
  });
  await at(3000, {
    capability: 'image',
    provider: provider('comfyui', { local: true, cost: { unit: 'perImage', value: 1 } }),
    units: 2,
    ok: true,
  });
  // 失败尝试：计入 calls，但 units / cost 为 0。
  await at(4000, { capability: 'tts', provider: 'edge', units: 999, ok: false, error: 'HTTP 500' });
  // 昨天与明天：只进 total，不进 today。
  await appendAttempt({ capability: 'tts', provider: provider('edge', { cost: { unit: 'perKChar', value: 0.5 } }), units: 1000, ok: true }, {
    ...options,
    now: () => dayStart - 1,
  });
  await appendAttempt({ capability: 'tts', provider: provider('edge', { cost: { unit: 'perKChar', value: 0.5 } }), units: 7, ok: true }, {
    ...options,
    now: () => dayStart + 24 * 60 * 60 * 1000,
  });

  const todayTts = spentToday('tts', { ...options, now: nowMs });
  assert.equal(todayTts.units, 1700, '1200 + 500（本地 500 单位仍计入用量）');
  assert.equal(todayTts.costEstimate, 0.6, '本地 provider 不计成本；失败尝试不计成本');
  assert.equal(todayTts.calls, 3);
  assert.equal(todayTts.okCalls, 2);
  assert.equal(todayTts.failedCalls, 1);

  const todayImage = spentToday('image', { ...options, now: nowMs });
  assert.equal(todayImage.units, 2);
  assert.equal(todayImage.costEstimate, 0);

  const todayAll = spentToday(undefined, { ...options, now: nowMs });
  assert.equal(todayAll.units, 1702);
  assert.equal(todayAll.capability, 'all');

  const totalTts = spentTotal('tts', options);
  assert.equal(totalTts.units, 2707, '1200 + 500 + 999(失败清零) + 1000 + 7');
  assert.equal(totalTts.costEstimate, 1.1035, '0.6 + 0.5 + 7/1000*0.5');
  assert.equal(totalTts.calls, 5);

  const multi = spentToday(['tts', 'image'], { ...options, now: nowMs });
  assert.equal(multi.units, 1702);
});

test('记账·窗口是左闭右开，零点是本地时区', async () => {
  const home = makeHome('budget-window');
  const nowMs = Date.parse('2026-11-07T12:00:00+08:00');
  const dayStart = startOfLocalDay(nowMs);
  assert.equal(new Date(dayStart).getHours(), 0);
  assert.equal(new Date(dayStart).getMinutes(), 0);

  await appendAttempt({ capability: 'tts', provider: 'edge', units: 10, ok: true }, {
    env: envFor(home),
    now: () => dayStart - 1,
  });
  await appendAttempt({ capability: 'tts', provider: 'edge', units: 20, ok: true }, {
    env: envFor(home),
    now: () => dayStart,
  });

  const window = spentSince('tts', { env: envFor(home), since: dayStart, until: dayStart + 1000 });
  assert.equal(window.units, 20, '左闭：dayStart 整点算今天；右开：昨天 23:59:59.999 不算');

  const today = spentToday('tts', { env: envFor(home), now: nowMs });
  assert.equal(today.units, 20);
});

test('记账·文件不存在 / 全是坏行时返回 0，不抛', () => {
  const home = makeHome('budget-empty');
  const empty = spentToday('tts', { env: envFor(home) });
  assert.equal(empty.units, 0);
  assert.equal(empty.costEstimate, 0);
  assert.equal(empty.calls, 0);
  assert.ok(Number.isFinite(empty.since));
  assert.ok(Number.isFinite(empty.until));

  // 时间戳必须是**动态当天**（C4 上报的日期炸弹）：
  // 原来写死 2026-11-07T00:00:00Z，过了本地零点 spentToday 的窗口就滑走了，
  // 这条断言会在 2026-11-08 00:00 CST 之后必然变红 —— 与任何代码改动无关。
  const todayIso = new Date().toISOString();
  fs.writeFileSync(
    path.join(home, 'events.jsonl'),
    `坏行\n{"capability":"tts","units":"不是数字","ts":"${todayIso}"}\n`,
  );
  const dirty = spentToday('tts', { env: envFor(home) });
  assert.equal(dirty.units, 0);
  assert.equal(dirty.calls, 1, '合法 JSON 但 units 畸形：计一次调用、0 用量');

  const total = spentTotal(undefined, { env: envFor(home) });
  assert.equal(total.since, null);
  assert.equal(total.until, null);
});

/* ================================================================== *
 * 4. 统一调用器
 * ================================================================== */

test('调用·超时表就是规格里的三个数字', () => {
  assert.deepEqual({ ...CAPABILITY_TIMEOUTS }, { tts: 30_000, image: 180_000, memory: 2_000 });
  assert.equal(shared.timeoutFor('tts'), 30_000);
  assert.equal(shared.timeoutFor('image'), 180_000);
  assert.equal(shared.timeoutFor('memory'), 2_000);
  assert.equal(shared.timeoutFor('wake'), DEFAULT_TIMEOUT_MS);
  assert.equal(shared.timeoutFor('tts', 5), 5, '显式覆盖优先');
  assert.equal(RETRY_BACKOFF_MS, 500);
  assert.equal(MAX_RETRIES, 1);
});

test('调用·错误分类决定重试资格', () => {
  const cases = [
    ['401', statusError(401), 'auth', false],
    ['403', statusError(403), 'auth', false],
    ['Unauthorized 文本', new Error('Unauthorized'), 'auth', false],
    ['TimeoutError', new TimeoutError(2000, 'edge'), 'timeout', false],
    ['ETIMEDOUT', Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }), 'timeout', false],
    ['429', statusError(429), 'quota', false],
    ['ECONNRESET', networkError(), 'network', true],
    ['fetch failed', new TypeError('fetch failed'), 'network', true],
    ['FORMAT', Object.assign(new Error('bad body'), { code: 'FORMAT' }), 'format', false],
    ['普通异常', new Error('boom'), 'unknown', false],
    ['显式类别优先', Object.assign(new Error('boom'), { category: 'network' }), 'network', true],
  ];
  for (const [label, error, category, retryable] of cases) {
    const info = classifyError(error);
    assert.equal(info.category, category, `${label} 的类别`);
    assert.equal(info.retryable, retryable, `${label} 的重试资格`);
  }
});

test('调用·单 provider 成功：结果信封 + 一条成功事件', async () => {
  const home = makeHome('call-ok');
  const result = await invoke({
    capability: 'tts',
    args: { text: '你好' },
    providers: [provider('edge', {
      local: true,
      cost: { unit: 'perKChar', value: 0.5 },
      run: async () => ({ path: '/tmp/a.mp3', chars: 1200 }),
    })],
    units: ({ value }) => value.chars,
    env: envFor(home),
    now: () => Date.parse('2026-11-07T01:02:03Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.capability, 'tts');
  assert.equal(result.provider, 'edge');
  assert.deepEqual(result.value, { path: '/tmp/a.mp3', chars: 1200 });
  assert.equal(result.units, 1200);
  assert.equal(result.costEstimate, 0, '本地 provider 成本 0');
  assert.equal(result.degradedFrom, null);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].ok, true);
  assert.equal(typeof result.durationMs, 'number');

  const events = readHomeEvents(home);
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].provider, 'edge');
  assert.equal(events[0].units, 1200);
  assert.equal(events[0].error, null);
  assert.equal(call, invoke);
});

test('调用·降级链走通：priority 高的挂了，低的接住并标 degradedFrom', async () => {
  const home = makeHome('call-degrade');
  const registry = createRegistry();
  registry.register('image', provider('comfyui', {
    priority: 100,
    local: true,
    run: async () => {
      const error = new Error('连不上本机 ComfyUI');
      error.code = 'ECONNREFUSED';
      throw error;
    },
  }));
  registry.register('image', provider('comfyui-offline-2', {
    priority: 90,
    run: async () => { throw statusError(401, 'bad api key'); },
  }));
  registry.register('image', provider('seedream', {
    priority: 10,
    local: false,
    requires: ['network', 'apiKey'],
    cost: { unit: 'perImage', value: 0.3 },
    run: async () => ({ path: '/tmp/a.png', width: 1024, height: 1024 }),
  }));

  const { sleep, delays } = makeSleep();
  const result = await invoke({
    capability: 'image',
    providers: registry.resolve('image'),
    units: 1,
    env: envFor(home),
    sleep,
  });

  assert.equal(result.provider, 'seedream');
  assert.equal(result.degradedFrom, 'comfyui', '降级时必须告诉调用方「最好的那个不可用」');
  assert.equal(result.costEstimate, 0.3);
  // comfyui 网络错重试 1 次；comfyui-offline-2 鉴权错不重试。
  assert.deepEqual(result.attempts.map((item) => `${item.provider}:${item.attempt}:${item.category ?? 'ok'}`), [
    'comfyui:1:network',
    'comfyui:2:network',
    'comfyui-offline-2:1:auth',
    'seedream:1:ok',
  ]);
  assert.deepEqual(delays, [500], '只有网络错退避 500ms，鉴权错不退避');

  const events = readHomeEvents(home);
  assert.equal(events.length, 4, '每次尝试一条事件（降级不能是黑盒）');
  assert.deepEqual(events.map((item) => item.ok), [false, false, false, true]);
  assert.deepEqual(events.map((item) => item.units), [0, 0, 0, 1]);
  assert.deepEqual(events.map((item) => item.errorCategory), ['network', 'network', 'auth', null]);
});

test('调用·鉴权错（401/403）不重试，直接降级', async () => {
  for (const status of [401, 403]) {
    const home = makeHome(`call-auth-${status}`);
    let authCalls = 0;
    const { sleep, delays } = makeSleep();

    const result = await invoke({
      capability: 'tts',
      providers: [
        provider('cloud', {
          priority: 50,
          run: async () => { authCalls += 1; throw statusError(status); },
        }),
        provider('local', { priority: 10, run: async () => 'ok-local' }),
      ],
      env: envFor(home),
      sleep,
    });

    assert.equal(result.provider, 'local');
    assert.equal(result.degradedFrom, 'cloud');
    assert.equal(authCalls, 1, `${status} 不许重试`);
    assert.deepEqual(delays, [], `${status} 不许退避等待`);
    const events = readHomeEvents(home);
    assert.equal(events[0].errorCategory, 'auth');
    assert.equal(events.length, 2);
  }
});

test('调用·网络错重试 1 次、退避 500ms；重试仍失败才降级', async () => {
  const home = makeHome('call-retry');
  let networkCalls = 0;
  const { sleep, delays } = makeSleep();

  const result = await invoke({
    capability: 'tts',
    providers: [
      provider('edge', {
        priority: 50,
        run: async () => {
          networkCalls += 1;
          if (networkCalls === 1) throw networkError();
          return 'edge-second-try';
        },
      }),
    ],
    env: envFor(home),
    sleep,
  });

  assert.equal(result.provider, 'edge');
  assert.equal(result.value, 'edge-second-try');
  assert.equal(networkCalls, 2);
  assert.equal(result.degradedFrom, null, '链首最终成功不算降级');
  assert.deepEqual(delays, [500]);
  assert.deepEqual(readHomeEvents(home).map((item) => item.ok), [false, true]);
  assert.equal(readHomeEvents(home)[0].units, 0, '失败尝试不计用量');
});

test('调用·重试上限 1 次：一直网络错就试两次，然后 CapabilityError', async () => {
  const home = makeHome('call-retry-limit');
  let calls = 0;
  const { sleep, delays } = makeSleep();

  await assert.rejects(
    invoke({
      capability: 'memory',
      providers: [provider('db', { run: async () => { calls += 1; throw networkError(); } })],
      env: envFor(home),
      sleep,
    }),
    CapabilityError,
  );

  assert.equal(calls, 2, '1 次原始 + 1 次重试，不许无限重试');
  assert.deepEqual(delays, [500]);
});

test('调用·超时不重试，直接降级到下个 provider', async () => {
  const home = makeHome('call-timeout');
  const { sleep, delays } = makeSleep();

  const result = await invoke({
    capability: 'image',
    providers: [
      provider('hang', { priority: 50, run: () => new Promise(() => {}) }),
      provider('backup', { priority: 10, run: async () => 'fallback' }),
    ],
    timeoutMs: 20,
    env: envFor(home),
    sleep,
  });

  assert.equal(result.provider, 'backup');
  assert.equal(result.degradedFrom, 'hang');
  assert.deepEqual(delays, [], '超时已经吃掉一次预算，再重试只会让用户多等一倍');
  const [firstAttempt] = result.attempts;
  assert.equal(firstAttempt.category, 'timeout');
  assert.equal(firstAttempt.attempt, 1);
  assert.equal(readHomeEvents(home)[0].errorCategory, 'timeout');
});

test('调用·memory 能力默认超时就是 2s（真时钟，唯一慢用例）', async () => {
  const home = makeHome('call-memory-timeout');
  const startedAt = Date.now();
  const result = await invoke({
    capability: 'memory',
    providers: [
      provider('hang', { priority: 50, run: () => new Promise(() => {}) }),
      provider('sqlite', { priority: 10, run: async () => 'ok' }),
    ],
    env: envFor(home),
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.provider, 'sqlite');
  assert.equal(result.degradedFrom, 'hang');
  assert.equal(result.attempts[0].category, 'timeout');
  assert.ok(elapsed >= 1_900, `memory 必须按 2s 超时（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 15_000, `memory 超时远大于 2s（实际 ${elapsed}ms）`);
});

test('调用·全部失败：CapabilityError 带每个 provider 的原因', async () => {
  const home = makeHome('call-all-fail');
  const { sleep } = makeSleep();

  const error = await invoke({
    capability: 'tts',
    providers: [
      provider('cloud-a', { run: async () => { throw statusError(401, 'invalid api key'); } }),
      provider('cloud-b', { run: async () => { throw networkError('socket hang up'); } }),
      provider('local-c', {
        run: async () => {
          throw Object.assign(new Error('unsupported audio format'), { category: 'format' });
        },
      }),
    ],
    env: envFor(home),
    sleep,
  }).then(() => null, (thrown) => thrown);

  assert.ok(error instanceof CapabilityError, '必须抛 CapabilityError');
  assert.equal(error.name, 'CapabilityError');
  assert.equal(error.code, 'CAPABILITY_FAILED');
  assert.equal(error.capability, 'tts');
  assert.equal(error.failures.length, 3, '每个 provider 一条失败记录');
  assert.deepEqual(error.failures.map((item) => item.provider), ['cloud-a', 'cloud-b', 'local-c']);
  assert.deepEqual(error.failures.map((item) => item.category), ['auth', 'network', 'format']);
  assert.equal(error.failures[0].attempts, 1, '鉴权不重试');
  assert.equal(error.failures[1].attempts, 2, '网络重试一次');
  assert.equal(error.failures[2].attempts, 1);

  // 消息里必须有每个 provider 与各自原因 —— 「只抛一个笼统失败」不算通过。
  for (const fragment of ['cloud-a', 'cloud-b', 'local-c', 'auth', 'network', 'format', 'invalid api key', 'socket hang up', 'unsupported audio format']) {
    assert.ok(error.message.includes(fragment), `CapabilityError 消息缺少 ${fragment}`);
  }
  assert.equal(error.attempts.length, 4);
  assert.equal(readHomeEvents(home).length, 4);
});

test('调用·零 provider 也抛 CapabilityError，不静默成功', async () => {
  const home = makeHome('call-no-provider');
  await assert.rejects(
    invoke({ capability: 'tts', providers: [], env: envFor(home) }),
    (error) => error instanceof CapabilityError
      && error.capability === 'tts'
      && error.failures.length === 0
      && /没有任何可用的 provider/.test(error.message),
  );
});

test('调用·事件写入失败不影响返回值', async () => {
  const home = makeHome('call-events-fail');
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, '不是目录');
  const warns = [];

  const result = await invoke({
    capability: 'tts',
    providers: [provider('edge', { run: async () => ({ path: '/tmp/a.mp3' }) })],
    env: envFor(blocker),
    warn: (message) => warns.push(message),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { path: '/tmp/a.mp3' });
  assert.ok(warns.some((message) => message.includes('事件写入失败')), '写不进去必须 warn');
});

test('调用·连 warn 自己都抛时，返回值依然不受影响', async () => {
  const home = makeHome('call-warn-throws');
  const blocker = path.join(home, 'blocker');
  fs.writeFileSync(blocker, '不是目录');

  const result = await invoke({
    capability: 'tts',
    providers: [provider('edge', { run: async () => 'ok' })],
    env: envFor(blocker),
    warn: () => { throw new Error('warn 自己炸了'); },
  });
  assert.equal(result.value, 'ok');
});

test('调用·全局 run 分发器与 provider.run 两种入口都支持', async () => {
  const home = makeHome('call-run-dispatch');
  const viaDescriptor = await invoke({
    capability: 'tts',
    providers: [provider('a', { run: async (args) => `descriptor:${args.text}` })],
    args: { text: 'x' },
    env: envFor(home),
  });
  assert.equal(viaDescriptor.value, 'descriptor:x');

  const viaGlobal = await invoke({
    capability: 'tts',
    args: { text: 'y' },
    providers: [provider('b'), provider('c')],
    run: async (item, args) => `global:${item.id}:${args.text}`,
    env: envFor(home),
  });
  assert.equal(viaGlobal.value, 'global:b:y');
});

test('调用·没有执行入口是编程错误（TypeError），不许伪装成能力失败', async () => {
  const home = makeHome('call-no-runner');
  await assert.rejects(
    invoke({ capability: 'tts', providers: [provider('ghost')], env: envFor(home) }),
    (error) => error instanceof TypeError && /没有可执行入口/.test(error.message),
  );
});

test('调用·recordEvents:false 时不写事件（离线预演）', async () => {
  const home = makeHome('call-no-record');
  const result = await invoke({
    capability: 'tts',
    providers: [provider('edge', { run: async () => 'ok' })],
    env: envFor(home),
    recordEvents: false,
  });
  assert.equal(result.value, 'ok');
  assert.equal(fs.existsSync(path.join(home, 'events.jsonl')), false);
});

/* ================================================================== *
 * 5. 隔离守卫：shared 只许依赖内置模块与同目录文件
 * ================================================================== */

test('守卫·src/shared 不 import 诊断层，也不 import 网络模块', () => {
  const dir = path.join(ROOT, 'src', 'shared');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length >= 5, 'shared 至少包含 paths/registry/events/budget/call/index');

  const importPattern = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  const networkModules = ['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls'];

  for (const name of files) {
    const relative = path.join('src', 'shared', name);
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    // 注释里的示例 import 不算依赖：先剥掉块注释与整行注释再扫。
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const match of code.matchAll(importPattern)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./'),
        `${relative} 只许 import 内置模块或同目录文件，实际 import 了 '${specifier}'`,
      );
      assert.ok(
        !networkModules.includes(specifier),
        `${relative} 不许 import 网络模块 '${specifier}'（网络只属于 C4/C5 adapter）`,
      );
    }
    assert.ok(!/\bfetch\s*\(/u.test(text), `${relative} 不许出现 fetch()（shared 必须保持离线可测）`);
    assert.ok(!/\bnew\s+WebSocket\s*\(/u.test(text), `${relative} 不许创建 WebSocket`);
  }
});

test('守卫·index.mjs 真的把四块地基都导出了', () => {
  for (const name of [
    'createRegistry', 'registry',
    'appendAttempt', 'readEvents', 'buildAttemptEntry',
    'spentToday', 'spentTotal', 'spentSince', 'startOfLocalDay',
    'invoke', 'classifyError', 'CapabilityError', 'TimeoutError',
    'resolvePondHome', 'eventsFilePath',
  ]) {
    assert.ok(name in shared, `src/shared/index.mjs 缺少导出 ${name}`);
  }
});
