/**
 * pond-check · C6 云 adapter 测试（tests/cloud-adapters.test.mjs）
 *
 * 这个文件钉的是三个云 adapter 的**行为契约**，不是某个服务端的实现细节：
 *   1. 声明：requires（network + 具体 key 名）与 cost 口径各自声明、经注册表校验
 *   2. 无 key：available=false、resolve 跳过、**不报错不崩**、零请求、点名缺哪个 key
 *      （变异点 M1：把「无 key 时跳过」改成「无 key 时 throw」，本文件必须变红）
 *   3. 有 key：按 priority 进降级链，degradedFrom / 事件照 C1 口径
 *   4. 错误分类：「没配 key」（POND_MISSING_KEY）与「配了但调用失败」（HTTP/网络/
 *      格式/业务 code）一眼可分；401/403 不重试、429 归 quota、网络类重试 1 次
 *   5. 成本口径：doubao 按分钟（units=音频秒数）、mimo 按千字符、图按张；
 *      失败尝试 units=0 / cost=0
 *   6. 协议形状：四个 adapter 的请求体/请求头离线钉死（假 transport 拦下来看）
 *
 * 测试纪律（任务书原话「测试全部用注入 transport，不真联网」）：
 *   - 所有 adapter 都注入假 transport，网络「请求」只是一次函数调用；
 *   - 文件开头把 globalThis.fetch 换成会抛的桩并计数，末尾断言计数为 0；
 *   - POND_HOME 一律 mkdtemp，事件/图片互不串，不碰真实 ~/.pond；
 *   - sleep 注入成记录函数，重试退避不真等。
 *
 * 变异验证（真实执行结果记在 update_task 的 commandsRun）：
 *   M1 把「无 key → 标不可用跳过」改成「无 key → throw」→ 无 key 各用例必红；
 *   M2 把可用性探测改成恒 true（跳过失效）→ 「零请求零事件」用例必红；
 *   M3 把 perMinute 计量改回字符数 → 「成本口径」用例必红。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTts } from '../src/tts/index.mjs';
import { createDoubaoTtsProvider, buildDoubaoTtsRequest, resolveDoubaoVoice } from '../src/tts/doubao.mjs';
import { createMimoTtsProvider, buildMimoRequest } from '../src/tts/mimo.mjs';
import * as image from '../src/image/index.mjs';
import { estimateCost, createRegistry } from '../src/shared/registry.mjs';
import { readEvents } from '../src/shared/events.mjs';

/* ------------------------------------------------------------------ *
 * 0. 安全地基：fetch 打桩 + 临时目录
 * ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-cloud-'));

const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  throw new Error('测试里绝不允许真发网络请求（globalThis.fetch 已被换成会抛的桩）');
};

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

let counter = 0;
/** 每个用例一个独立 POND_HOME。 */
function makeHome(label) {
  counter += 1;
  const home = path.join(TEMP_ROOT, `${String(counter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/** 显式环境（不展开 process.env：避免宿主真配了 key 让「无 key」用例意外变绿）。 */
function envFor(home, extra = {}) {
  return { POND_HOME: home, ...extra };
}

function eventsFor(home) {
  return readEvents({ env: { POND_HOME: home } }).entries;
}

/* ------------------------------------------------------------------ *
 * 1. 夹具：假 transport / 假音频 / 假图片
 * ------------------------------------------------------------------ */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 假 HTTP transport：记录请求，按 handler 路由；绝不联网。 */
function makeTransport(handler) {
  const requests = [];
  const transport = async (url, init = {}) => {
    const entry = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    requests.push(entry);
    return handler(entry, requests.length);
  };
  return { transport, requests };
}

/** 一调用就抛的 transport（用来证明「跳过 = 零请求」）。 */
function trapTransport(label) {
  return async () => {
    throw new Error(`被跳过的 provider 不该出网：${label}`);
  };
}

/** 24kHz / 16bit / 单声道 WAV：时长可从头精算（成本口径测试要精确数字）。 */
function wavBuffer(ms) {
  const sampleRate = 24_000;
  const bytesPerSample = 2;
  const dataLen = Math.round((ms / 1000) * sampleRate * bytesPerSample);
  const buffer = Buffer.alloc(44 + dataLen);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLen, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLen, 40);
  return buffer;
}

/** 33 字节 PNG 头（够读宽高）。 */
function pngBuffer(width = 512, height = 384) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  return buffer;
}

function doubaoAudioResponse(ms = 1000) {
  return jsonResponse({ code: 1000, message: 'success', data: wavBuffer(ms).toString('base64') });
}

function mimoAudioResponse(ms = 1000) {
  return jsonResponse({
    id: 'resp-1',
    object: 'chat.completion',
    model: 'mimo-v2.5-tts',
    choices: [{
      finish_reason: 'stop',
      index: 0,
      message: { role: 'assistant', content: '', audio: { id: 'a1', data: wavBuffer(ms).toString('base64') } },
    }],
    usage: { completion_tokens: 97, prompt_tokens: 213, total_tokens: 310 },
  });
}

function seedImageResponse() {
  return jsonResponse({ data: [{ b64_json: pngBuffer().toString('base64') }], usage: {} });
}

const WAV_OUT = () => path.join(makeHome('out'), 'out.wav');

/* ================================================================== *
 * 2. 声明：requires（network + 具体 key 名）与 cost 口径
 * ================================================================== */

test('声明·每个云 adapter 自带 requires（network + apiKey）与具体 key 名', () => {
  const home = makeHome('declare');
  const tts = createTts({ env: envFor(home), warn: () => {} });
  const doubaoTts = tts.registry.get('tts', 'doubao');
  const mimoTts = tts.registry.get('tts', 'mimo');

  assert.deepEqual(doubaoTts.requires, ['network', 'apiKey']);
  assert.deepEqual(doubaoTts.keyEnvs, ['POND_DOUBAO_TTS_APP_ID', 'POND_DOUBAO_TTS_TOKEN']);
  assert.deepEqual(mimoTts.requires, ['network', 'apiKey']);
  assert.deepEqual(mimoTts.keyEnvs, ['POND_MIMO_API_KEY']);

  const client = image.createImageClient({ env: envFor(home), warn: () => {} });
  const seedream = client.registry.get('image', 'seedream');
  const doubaoImage = client.registry.get('image', 'doubao');
  assert.deepEqual(seedream.requires, ['network', 'apiKey']);
  assert.deepEqual(seedream.keyEnvs, ['POND_SEEDREAM_API_KEY']);
  assert.deepEqual(doubaoImage.requires, ['network', 'apiKey']);
  assert.deepEqual(doubaoImage.keyEnvs, ['POND_DOUBAO_API_KEY']);

  for (const provider of [doubaoTts, mimoTts, seedream, doubaoImage]) {
    assert.equal(provider.local, false, `${provider.id} 是云 provider`);
    assert.ok(Array.isArray(provider.requires) && provider.requires.includes('network'));
    assert.ok(Array.isArray(provider.keyEnvs) && provider.keyEnvs.length > 0, '具体 key 名必须声明');
  }
});

test('声明·cost 口径各自声明：doubao 按分钟、mimo 按千字符、图按张', () => {
  const home = makeHome('cost-declare');
  const tts = createTts({ env: envFor(home), warn: () => {} });
  const doubaoTts = tts.registry.get('tts', 'doubao');
  const mimoTts = tts.registry.get('tts', 'mimo');

  assert.deepEqual(doubaoTts.cost, { unit: 'perMinute', value: 1 }, '规格 §4：约 1 元/分钟');
  assert.equal(mimoTts.cost.unit, 'perKChar', 'mimo「按量」按千字符计量（单价以控制台为准）');

  const client = image.createImageClient({ env: envFor(home), warn: () => {} });
  assert.equal(client.registry.get('image', 'seedream').cost.unit, 'perImage');
  assert.equal(client.registry.get('image', 'doubao').cost.unit, 'perImage');

  // 口径数学：perMinute 的 units 是秒（registry 的既有语义）。
  assert.equal(estimateCost({ local: false, cost: { unit: 'perMinute', value: 6 } }, 2.5), 0.25);
  assert.equal(estimateCost({ local: false, cost: { unit: 'perKChar', value: 3 } }, 1200), 3.6);
  assert.equal(estimateCost({ local: false, cost: { unit: 'perImage', value: 0.25 } }, 1), 0.25);
  assert.equal(estimateCost({ local: true, cost: { unit: 'perImage', value: 9 } }, 1), 0, '本地恒 0');
});

test('声明·注册表拒收畸形 cost（口径打错不静默归零）', () => {
  const registry = createRegistry();
  assert.throws(
    () => registry.register('tts', createDoubaoTtsProvider({ cost: { unit: 'perMinutes', value: 1 }, env: {} })),
    (error) => error.name === 'RegistryError' && /perMinute/.test(error.message),
  );
});

/* ================================================================== *
 * 3. 无 key：跳过、不报错、不崩（变异点 M1 / M2）
 * ================================================================== */

test('无 key·providers() 标 available:false 并点名环境变量，不报错不崩（M1）', () => {
  const home = makeHome('no-key-list');
  const tts = createTts({ env: envFor(home), warn: () => {} });
  const list = tts.providers();
  for (const id of ['doubao', 'mimo']) {
    const info = list.find((item) => item.id === id);
    assert.ok(info, `${id} 必须出现在 providers() 里`);
    assert.equal(info.available, false, `${id} 没 key 必须标不可用`);
    assert.ok(
      /POND_(DOUBAO_TTS_APP_ID|MIMO_API_KEY)/.test(String(info.availableReason)),
      `${id} 必须点名缺哪个 key：${info.availableReason}`,
    );
  }

  const client = image.createImageClient({ env: envFor(home), warn: () => {} });
  const cloudIds = client.providers().filter((item) => item.id === 'seedream' || item.id === 'doubao');
  assert.equal(cloudIds.length, 2);
  for (const info of cloudIds) {
    assert.equal(info.available, false);
    assert.match(String(info.unavailableReason), /API key/);
  }
  assert.equal(fetchCalls, 0, 'providers() 不许联网探测');
});

test('无 key·有兜底 provider 时静默跳过：云 adapter 零请求、零事件（M1/M2）', async () => {
  // TTS：edge 正常出声，doubao/mimo 没 key 且 transport 是一碰就炸的陷阱。
  const home = makeHome('no-key-skip-tts');
  const tts = createTts({
    transport: async ({ text }) => ({ audio: Buffer.from(`[${text}]`) }),
    doubao: { transport: trapTransport('doubao tts') },
    mimo: { transport: trapTransport('mimo tts') },
    env: envFor(home),
    warn: () => {},
  });
  const result = await tts.speak('没配云 key 也要能说话', { outPath: WAV_OUT() });
  assert.equal(result.provider, 'edge', '没 key 的云 adapter 必须被跳过，不能抢跑也不能拖垮');
  assert.equal(result.degradedFrom, null, '链首成功不算降级');

  const events = eventsFor(home);
  assert.deepEqual(events.map((entry) => entry.provider), ['edge'], '事件里不该出现被跳过的 provider');
  assert.equal(fetchCalls, 0);

  // 图：chain 里两个云 adapter 都没 key，openai-compat 兜底。
  const homeImage = makeHome('no-key-skip-image');
  const { transport, requests } = makeTransport(() => seedImageResponse());
  const client = image.createImageClient({
    env: envFor(homeImage),
    config: {
      chain: ['seedream', 'doubao', 'openai-compat'],
      seedream: { transport: undefined },
      openaiCompat: { apiKey: 'sk-openai' },
    },
    transport: (url, init) => {
      if (String(url).includes('ark.cn-beijing')) {
        throw new Error('被跳过的 provider 不该出网：seedream/doubao 图');
      }
      return transport(url, init);
    },
    sleep: async () => {},
    warn: () => {},
  });
  const generated = await client.generate('一只猫', { seed: 1 });
  assert.equal(generated.provider, 'openai-compat');
  assert.equal(generated.degraded ?? false, false, '被跳过不算降级');
  const imageEvents = eventsFor(homeImage);
  assert.deepEqual(imageEvents.map((entry) => entry.provider), ['openai-compat']);
  assert.equal(requests.length, 1, '只有 openai-compat 出过一次网');
  assert.equal(fetchCalls, 0);
});

test('无 key·链上全是没 key 的云 adapter：明确报「没有可用 provider」，不是 MissingKey 崩溃（M1）', async () => {
  const home = makeHome('no-key-empty');
  const tts = createTts({
    providers: [createDoubaoTtsProvider({ transport: trapTransport('doubao'), env: {} })],
    env: envFor(home),
    warn: () => {},
  });
  await assert.rejects(
    () => tts.speak('没人能说'),
    (error) => {
      assert.equal(error.name, 'CapabilityError');
      assert.match(error.message, /没有任何可用的 provider/);
      assert.notEqual(error.code, 'POND_MISSING_KEY', '缺 key 不许以 MissingKeyError 的形态炸出来');
      return true;
    },
  );

  const client = image.createImageClient({ env: envFor(home), warn: () => {} });
  await assert.rejects(
    () => client.generate('一只猫'),
    (error) => {
      assert.equal(error.name, 'CapabilityError');
      assert.match(error.message, /POND_SEEDREAM_API_KEY/);
      assert.match(error.message, /POND_DOUBAO_API_KEY/);
      assert.notEqual(error.code, 'POND_MISSING_KEY');
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});

test('无 key·直接 run() 也有清晰防御错误（POND_MISSING_KEY），与调用失败可分', async () => {
  const home = makeHome('no-key-run');
  const provider = createDoubaoTtsProvider({ transport: trapTransport('doubao'), env: {} });
  await assert.rejects(
    () => provider.run({ text: 'x', segments: ['x'], format: 'wav', outPath: WAV_OUT() }, {}),
    (error) => {
      assert.equal(error.code, 'POND_MISSING_KEY');
      assert.match(error.message, /缺少 API key/);
      assert.match(error.message, /POND_DOUBAO_TTS_APP_ID/);
      assert.doesNotMatch(error.message, /HTTP/, '「没配 key」的文案里不许出现调用失败的痕迹');
      return true;
    },
  );

  // 对照：配了 key 但调用失败 —— 文案是 HTTP/网络/格式，绝不提「缺少 API key」。
  const failing = createDoubaoTtsProvider({
    appId: 'app-1',
    token: 'tok-1',
    env: {},
    transport: makeTransport(() => jsonResponse({ error: 'server boom' }, 500)).transport,
  });
  await assert.rejects(
    () => failing.run({ text: 'x', segments: ['x'], format: 'wav', outPath: WAV_OUT() }, {}),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.doesNotMatch(error.message, /缺少 API key/);
      assert.notEqual(error.code, 'POND_MISSING_KEY');
      return true;
    },
  );
});

/* ================================================================== *
 * 4. 有 key：进降级链
 * ================================================================== */

test('降级链·edge 挂了 doubao 顶上：degradedFrom=edge，事件两行（失败 units=0）', async () => {
  const home = makeHome('chain-tts');
  const doubaoHttp = makeTransport(() => doubaoAudioResponse(2500));
  const tts = createTts({
    transport: async () => {
      const error = new Error('transport boom');
      error.category = 'unknown';
      throw error;
    },
    doubao: {
      appId: 'app-1',
      token: 'tok-1',
      transport: doubaoHttp.transport,
      cost: { unit: 'perMinute', value: 6 },
    },
    env: envFor(home),
    warn: () => {},
    sleep: async () => {},
  });

  const outPath = WAV_OUT();
  const result = await tts.speak('降级到豆包', { format: 'wav', outPath });
  assert.equal(result.provider, 'doubao', 'edge 挂了要落到 doubao');
  assert.equal(result.degradedFrom, 'edge');
  assert.equal(result.estimated, false, 'wav 时长精算，不标估算');
  assert.equal(fs.readFileSync(outPath).length, 44 + 120_000, '真写了拼接后的音频');

  const events = eventsFor(home);
  assert.deepEqual(events.map((entry) => [entry.provider, entry.ok]), [['edge', false], ['doubao', true]]);
  assert.equal(events[0].units, 0, '失败尝试不计用量');
  assert.equal(events[0].costEstimate, 0, '失败尝试不计成本');
  assert.equal(events[1].units, 2.5, 'perMinute 口径：units = 音频秒数');
  assert.equal(events[1].costEstimate, 0.25, '2.5 秒 × 6 元/分钟');
  assert.equal(fetchCalls, 0);
});

test('降级链·seedream 出图失败落到 doubao 图：degradedFrom=seedream，成本按张', async () => {
  const home = makeHome('chain-image');
  const { transport, requests } = makeTransport((entry) => {
    if (entry.body?.model?.startsWith('doubao-seedream-4-5')) {
      return jsonResponse({ error: { message: 'model overloaded' } }, 500);
    }
    return seedImageResponse();
  });
  const client = image.createImageClient({
    env: envFor(home),
    config: {
      chain: ['seedream', 'doubao'],
      seedream: { apiKey: 'sk-seed', cost: { unit: 'perImage', value: 0.25 } },
      doubao: { apiKey: 'sk-doubao', cost: { unit: 'perImage', value: 0.2 }, guidanceScale: 2.5 },
    },
    transport,
    sleep: async () => {},
    warn: () => {},
  });

  const result = await client.generate('一只猫', { seed: 12, size: '1024x1024' });
  assert.equal(result.provider, 'doubao');
  assert.equal(result.degraded, true);
  assert.equal(result.degradedFrom, 'seedream', '降级来自链首 seedream');
  assert.equal(result.seed, 12, 'seed 发出去什么就回传什么');
  assert.equal(result.costEstimate, 0.2);
  assert.equal(result.units, 1);

  const events = eventsFor(home);
  assert.deepEqual(events.map((entry) => [entry.provider, entry.ok]), [['seedream', false], ['doubao', true]]);
  assert.equal(events[0].units, 0);
  assert.equal(events[1].units, 1);
  assert.equal(events[1].costEstimate, 0.2);
  assert.equal(requests.length, 2, 'seedream 失败一次 + doubao 成功一次');
  assert.equal(fetchCalls, 0);
});

/* ================================================================== *
 * 5. 错误分类：「没配 key」≠「配了但调用失败」
 * ================================================================== */

/** 只有 doubao + mimo 两个云 provider 的 TTS（分类用例要纯净的链）。 */
function cloudChain(home, { doubao = {}, mimo = {}, sleep } = {}) {
  const tts = createTts({
    providers: [
      createDoubaoTtsProvider({ appId: 'app-1', token: 'tok-1', env: {}, ...doubao }),
      createMimoTtsProvider({ apiKey: 'mk-1', env: {}, ...mimo }),
    ],
    env: envFor(home),
    warn: () => {},
    sleep: sleep ?? (async () => {}),
  });
  return tts;
}

test('错误分类·401 鉴权不重试直接降级，事件 errorCategory=auth', async () => {
  const home = makeHome('err-401');
  const delays = [];
  const doubaoHttp = makeTransport(() => jsonResponse({ message: 'unauthorized' }, 401));
  const mimoHttp = makeTransport(() => mimoAudioResponse(500));
  const tts = cloudChain(home, {
    doubao: { transport: doubaoHttp.transport },
    mimo: { transport: mimoHttp.transport },
    sleep: async (ms) => { delays.push(ms); },
  });

  const result = await tts.speak('鉴权失败要换人', { format: 'wav', outPath: WAV_OUT() });
  assert.equal(result.provider, 'mimo');
  assert.equal(result.degradedFrom, 'doubao');
  assert.deepEqual(delays, [], '401 不许重试（不许走退避）');
  assert.equal(doubaoHttp.requests.length, 1, '只试一次');

  const events = eventsFor(home);
  assert.equal(events[0].errorCategory, 'auth');
  assert.match(events[0].error, /HTTP 401/);
  assert.doesNotMatch(events[0].error, /缺少 API key/);
});

test('错误分类·429 归 quota 不重试；网络类重试 1 次退避 500ms 再降级', async () => {
  // 429：quota，不重试。
  const homeQuota = makeHome('err-429');
  const quotaDelays = [];
  const quotaHttp = makeTransport(() => jsonResponse({ message: 'rate limited' }, 429));
  const ttsQuota = cloudChain(homeQuota, {
    doubao: { transport: quotaHttp.transport },
    mimo: { transport: makeTransport(() => mimoAudioResponse()).transport },
    sleep: async (ms) => { quotaDelays.push(ms); },
  });
  await ttsQuota.speak('限流', { format: 'wav', outPath: WAV_OUT() });
  assert.deepEqual(quotaDelays, [], '429 不许重试');
  assert.equal(quotaHttp.requests.length, 1);
  assert.equal(eventsFor(homeQuota)[0].errorCategory, 'quota');

  // 网络类：重试 1 次（退避 500ms）再降级。
  const homeNet = makeHome('err-net');
  const netDelays = [];
  let netAttempts = 0;
  const ttsNet = cloudChain(homeNet, {
    doubao: {
      transport: async () => {
        netAttempts += 1;
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      },
    },
    mimo: { transport: makeTransport(() => mimoAudioResponse()).transport },
    sleep: async (ms) => { netDelays.push(ms); },
  });
  const result = await ttsNet.speak('网络抖动', { format: 'wav', outPath: WAV_OUT() });
  assert.equal(result.provider, 'mimo');
  assert.equal(netAttempts, 2, '网络类错误应试 2 次（1 重试）');
  assert.deepEqual(netDelays, [500], '指数退避第 1 次等 500ms');
  const netEvents = eventsFor(homeNet);
  assert.deepEqual(netEvents.map((entry) => entry.errorCategory ?? 'ok'), ['network', 'network', 'ok']);
});

test('错误分类·响应不合格式归 format；业务 code≠1000 带 code 且不提「缺少 API key」', async () => {
  // format：mimo 响应里没有音频（链上只有 mimo，纯净观察分类）。
  const homeFormat = makeHome('err-format');
  const ttsFormat = createTts({
    providers: [createMimoTtsProvider({
      apiKey: 'mk-1',
      env: {},
      transport: makeTransport(() => jsonResponse({ choices: [] })).transport,
    })],
    env: envFor(homeFormat),
    warn: () => {},
    sleep: async () => {},
  });
  await assert.rejects(
    () => ttsFormat.speak('坏响应', { format: 'wav', outPath: WAV_OUT() }),
    (error) => {
      assert.equal(error.failures[0].category, 'format');
      assert.match(error.failures[0].reason, /audio\.data/);
      return true;
    },
  );

  // 业务失败：HTTP 200 + code 3001（配了 key 但调用失败）。
  const homeCode = makeHome('err-code');
  const ttsCode = createTts({
    providers: [createDoubaoTtsProvider({
      appId: 'app-1',
      token: 'tok-1',
      env: {},
      transport: makeTransport(() => jsonResponse({ code: 3001, message: 'app auth failed' })).transport,
    })],
    env: envFor(homeCode),
    warn: () => {},
  });
  await assert.rejects(
    () => ttsCode.speak('业务失败', { format: 'wav', outPath: WAV_OUT() }),
    (error) => {
      assert.match(error.message, /code 3001/);
      assert.match(error.message, /app auth failed/);
      assert.doesNotMatch(error.message, /缺少 API key/);
      assert.notEqual(error.code, 'POND_MISSING_KEY');
      return true;
    },
  );
});

test('错误分类·mimo 不支持 ogg（文档边界）：format 错误并降级，不猜参数', async () => {
  const home = makeHome('err-ogg');
  const mimoHttp = makeTransport(() => mimoAudioResponse());
  const tts = createTts({
    providers: [
      createDoubaoTtsProvider({
        appId: 'app-1',
        token: 'tok-1',
        env: {},
        transport: makeTransport(() => doubaoAudioResponse()).transport,
      }),
      createMimoTtsProvider({ apiKey: 'mk-1', env: {}, transport: mimoHttp.transport }),
    ],
    env: envFor(home),
    warn: () => {},
    sleep: async () => {},
  });
  // doubao 会把 ogg 映射成 ogg_opus；单看 mimo 时它必须干净地报 format。
  const ttsMimoOnly = createTts({
    providers: [createMimoTtsProvider({ apiKey: 'mk-1', env: {}, transport: mimoHttp.transport })],
    env: envFor(home),
    warn: () => {},
  });
  await assert.rejects(
    () => ttsMimoOnly.speak('ogg 输出', { format: 'ogg', outPath: WAV_OUT() }),
    (error) => {
      assert.equal(error.failures[0].category, 'format');
      assert.match(error.failures[0].reason, /ogg/);
      return true;
    },
  );
  assert.equal(mimoHttp.requests.length, 0, '格式不支持在发请求前就该拦下');

  const ok = await tts.speak('多语言兜底', { format: 'ogg', outPath: WAV_OUT() });
  assert.equal(ok.provider, 'doubao', 'mimo 不支持 ogg 时 doubao 兜底');
  assert.equal(ok.degradedFrom, null);
});

/* ================================================================== *
 * 6. 成本口径：perMinute（秒）/ perKChar（字符）/ perImage（张）
 * ================================================================== */

test('成本·doubao 按分钟：units=音频秒数，costEstimate=秒/60×单价（M3）', async () => {
  const home = makeHome('cost-doubao');
  const tts = createTts({
    providers: [createDoubaoTtsProvider({
      appId: 'app-1',
      token: 'tok-1',
      env: {},
      cost: { unit: 'perMinute', value: 6 },
      transport: makeTransport(() => doubaoAudioResponse(2500)).transport,
    })],
    env: envFor(home),
    warn: () => {},
  });
  await tts.speak('计费测试', { format: 'wav', outPath: WAV_OUT() });

  const [entry] = eventsFor(home);
  assert.equal(entry.capability, 'tts');
  assert.equal(entry.provider, 'doubao');
  assert.equal(entry.units, 2.5, 'perMinute 的 units 是秒，不是字符');
  assert.equal(entry.costEstimate, 0.25, '2.5 秒 = 2.5/60 分钟 × 6 元');
  assert.equal(entry.ok, true);
});

test('成本·mimo 按千字符；图按张；失败尝试一律 0', async () => {
  const home = makeHome('cost-mimo');
  const tts = createTts({
    providers: [createMimoTtsProvider({
      apiKey: 'mk-1',
      env: {},
      cost: { unit: 'perKChar', value: 3 },
      transport: makeTransport(() => mimoAudioResponse(500)).transport,
    })],
    env: envFor(home),
    warn: () => {},
  });
  const text = '字'.repeat(1200);
  await tts.speak(text, { format: 'wav', outPath: WAV_OUT() });
  const ttsEvents = eventsFor(home);
  assert.equal(ttsEvents[ttsEvents.length - 1].units, 1200, 'perKChar 的 units 是字符数');
  assert.equal(ttsEvents[ttsEvents.length - 1].costEstimate, 3.6, '1200/1000 × 3 元');

  const homeImage = makeHome('cost-image');
  const client = image.createImageClient({
    env: envFor(homeImage),
    config: {
      chain: ['seedream', 'doubao'],
      seedream: { apiKey: 'sk-seed', cost: { unit: 'perImage', value: 0.25 } },
      doubao: { apiKey: 'sk-doubao', cost: { unit: 'perImage', value: 0.2 } },
    },
    transport: makeTransport((entry) => (entry.body?.model?.startsWith('doubao-seedream-4-5')
      ? jsonResponse({ error: 'boom' }, 500)
      : seedImageResponse())).transport,
    sleep: async () => {},
    warn: () => {},
  });
  await client.generate('成本图', { size: '1024x1024' });
  const imageEvents = eventsFor(homeImage);
  assert.equal(imageEvents[0].units, 0, '失败尝试 units=0');
  assert.equal(imageEvents[0].costEstimate, 0, '失败尝试 cost=0');
  assert.equal(imageEvents[1].units, 1, 'perImage 的 units 是张数');
  assert.equal(imageEvents[1].costEstimate, 0.2);
});

/* ================================================================== *
 * 7. 协议形状（假 transport 离线钉请求）
 * ================================================================== */

test('协议·doubao TTS 请求形状：Bearer;token、app/cluster、reqid 每段唯一、speed 夹取', async () => {
  const home = makeHome('proto-doubao');
  const { transport, requests } = makeTransport(() => doubaoAudioResponse());
  const provider = createDoubaoTtsProvider({
    appId: 'app-1',
    token: 'tok-1',
    env: {},
    transport,
  });
  await provider.run({
    text: '第一段。第二段。',
    segments: ['第一段。', '第二段。'],
    voice: 'cancan',
    speed: 3,
    emotion: 'happy',
    format: 'mp3',
    outPath: path.join(home, 'out.mp3'),
  }, {});

  assert.equal(requests.length, 2, '分段逐段合成');
  for (const request of requests) {
    assert.equal(request.url, 'https://openspeech.bytedance.com/api/v1/tts');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer;tok-1', '协议原样：分号分隔');
    assert.deepEqual(request.body.app, { appid: 'app-1', token: 'tok-1', cluster: 'volcano_tts' });
    assert.equal(request.body.user.uid, 'pond-check');
    assert.equal(request.body.audio.voice_type, 'zh_female_cancan_mars_bigtts');
    assert.equal(request.body.audio.encoding, 'mp3');
    assert.equal(request.body.audio.speed_ratio, 2, 'speed_ratio 夹取在 2.0');
    assert.equal(request.body.audio.emotion, 'happy');
    assert.equal(request.body.request.operation, 'query');
    assert.equal(typeof request.body.request.reqid, 'string');
  }
  assert.equal(requests[0].body.request.text, '第一段。');
  assert.equal(requests[1].body.request.text, '第二段。');
  assert.notEqual(
    requests[0].body.request.reqid,
    requests[1].body.request.reqid,
    'reqid 每次必须唯一（文档硬要求）',
  );
  assert.equal(resolveDoubaoVoice('zh_custom_voice'), 'zh_custom_voice', '映射表外的音色原样透传');
});

test('协议·mimo 请求形状：api-key 头、assistant 消息、audio.format/voice、emotion 走 user 消息', () => {
  const withEmotion = buildMimoRequest({ text: '你好', voice: 'bingtang', emotion: 'happy', format: 'mp3' });
  assert.equal(withEmotion.model, 'mimo-v2.5-tts');
  assert.deepEqual(withEmotion.messages, [
    { role: 'user', content: '播报风格：happy' },
    { role: 'assistant', content: '你好' },
  ]);
  assert.deepEqual(withEmotion.audio, { format: 'mp3', voice: '冰糖' });

  const plain = buildMimoRequest({ text: '你好', format: 'wav' });
  assert.deepEqual(plain.messages, [{ role: 'assistant', content: '你好' }]);
  assert.deepEqual(plain.audio, { format: 'wav', voice: 'mimo_default' });

  assert.throws(() => buildMimoRequest({ text: 'x', format: 'ogg' }), /ogg/);

  // 请求头：api-key（文档的认证方式之一）。
  const home = makeHome('proto-mimo-headers');
  const { transport, requests } = makeTransport(() => mimoAudioResponse());
  const provider = createMimoTtsProvider({ apiKey: 'mk-1', env: {}, transport });
  return provider.run({ text: '你好', segments: ['你好'], format: 'mp3', outPath: path.join(home, 'o.mp3') }, {})
    .then(() => {
      assert.equal(requests[0].url, 'https://api.xiaomimimo.com/v1/chat/completions');
      assert.equal(requests[0].headers['api-key'], 'mk-1');
    });
});

test('协议·seedream 图请求形状：Bearer、model/size/seed/response_format，负向提示词追加', async () => {
  const home = makeHome('proto-seedream');
  const { transport, requests } = makeTransport(() => seedImageResponse());
  const client = image.createImageClient({
    env: envFor(home),
    config: {
      chain: ['seedream'],
      seedream: { apiKey: 'sk-seed', model: 'doubao-seedream-4-5-251128' },
    },
    transport,
    sleep: async () => {},
    warn: () => {},
  });
  await client.generate('一只猫', { negative: 'lowres, bad hands', seed: 12, size: '1024x1024' });

  const request = requests[0];
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
  assert.equal(request.headers.authorization, 'Bearer sk-seed');
  assert.equal(request.body.model, 'doubao-seedream-4-5-251128');
  assert.equal(request.body.size, '1024x1024');
  assert.equal(request.body.seed, 12);
  assert.equal(request.body.response_format, 'b64_json');
  assert.equal(request.body.watermark, false);
  assert.equal(request.body.output_format, 'png');
  assert.match(request.body.prompt, /^一只猫/);
  assert.match(request.body.prompt, /Negative prompt: lowres, bad hands/);
  assert.equal(fetchCalls, 0);
});

test('协议·doubao 图请求形状：guidance_scale 只在这条线；supportsSeed:false 回 null 并说明', async () => {
  const home = makeHome('proto-doubao-image');
  const { transport, requests } = makeTransport(() => seedImageResponse());
  const client = image.createImageClient({
    env: envFor(home),
    config: {
      chain: ['doubao'],
      doubao: {
        apiKey: 'sk-doubao',
        model: 'doubao-seedream-3-0-t2i',
        guidanceScale: 2.5,
        supportsSeed: false,
      },
    },
    transport,
    sleep: async () => {},
    warn: () => {},
  });
  const result = await client.generate('一条鱼', { seed: 7, size: '1024x1024' });

  const request = requests[0];
  assert.equal(request.body.model, 'doubao-seedream-3-0-t2i');
  assert.equal(request.body.guidance_scale, 2.5, '豆包 3.0-t2i 线收 guidance_scale');
  assert.equal('seed' in request.body, false, 'supportsSeed:false 不发送 seed');
  assert.equal(result.seed, null);
  assert.equal(result.seedReproducible, false);
  assert.match(String(result.seedNote), /seed/);

  // 对照：supportsSeed 默认 true 时 seed 发出去并原样回传。
  const homeSeeded = makeHome('proto-doubao-seeded');
  const seeded = makeTransport(() => seedImageResponse());
  const clientSeeded = image.createImageClient({
    env: envFor(homeSeeded),
    config: { chain: ['doubao'], doubao: { apiKey: 'sk-doubao' } },
    transport: seeded.transport,
    sleep: async () => {},
    warn: () => {},
  });
  const seededResult = await clientSeeded.generate('一条鱼', { seed: 7, size: '1024x1024' });
  assert.equal(seeded.requests[0].body.seed, 7);
  assert.equal(seededResult.seed, 7);
  assert.equal(seededResult.seedReproducible, true);
});

test('安全·密钥零外泄：错误文本 / 事件 / providers() / 配置副本都不含明文 key', async () => {
  const home = makeHome('redaction');
  const secret = 'sk-VERY-SECRET-KEY-123';
  const { transport } = makeTransport(() => jsonResponse({ error: `bad key ${secret}` }, 500));
  const client = image.createImageClient({
    env: envFor(home),
    config: { chain: ['seedream'], seedream: { apiKey: secret } },
    transport,
    sleep: async () => {},
    warn: () => {},
  });

  await assert.rejects(() => client.generate('一只猫', { size: '1024x1024' }));
  const serialized = JSON.stringify({
    providers: client.providers(),
    config: client.getConfig(),
    events: eventsFor(home),
    error: (await client.generate('一只猫', { size: '1024x1024' }).catch((error) => error)).message,
  });
  assert.equal(serialized.includes(secret), false, 'API key 泄漏到了对外输出');
  assert.ok(serialized.includes('[已隐藏]'), '配置副本里的 key 必须是脱敏占位');
});

test('配置·image.json 的 seedream/doubao 段生效；坏 cost 口径当场拒绝', () => {
  const home = makeHome('config-file');
  fs.writeFileSync(path.join(home, 'image.json'), JSON.stringify({
    chain: ['seedream', 'doubao'],
    seedream: { apiKeyEnv: 'MY_SEED_KEY', model: 'doubao-seedream-5-0-260128' },
    doubao: { apiKey: 'sk-inline' },
  }));

  const client = image.createImageClient({ env: envFor(home, { MY_SEED_KEY: 'sk-from-env' }), warn: () => {} });
  const seedream = client.registry.get('image', 'seedream');
  assert.equal(seedream.available, true, '自定义 apiKeyEnv + 环境变量即视为有 key');
  assert.equal(seedream.run !== undefined, true);
  assert.equal(client.registry.get('image', 'doubao').available, true, '配置里的 inline key 也算有 key');

  const bad = makeHome('config-bad');
  fs.writeFileSync(path.join(bad, 'image.json'), JSON.stringify({
    seedream: { cost: { unit: 'perFoo', value: 1 } },
  }));
  assert.throws(
    () => image.createImageClient({ env: envFor(bad), warn: () => {} }),
    (error) => error.name === 'ImageConfigError' && /perImage/.test(error.message),
  );
});

/* ================================================================== *
 * 8. 零真实网络（必须是最后一个用例）
 * ================================================================== */

test('安全·全程零真实网络：本文件所有请求都走注入的 transport', () => {
  assert.equal(fetchCalls, 0, `有 ${fetchCalls} 次调用落到了 globalThis.fetch —— 测试真的联网了`);
});
