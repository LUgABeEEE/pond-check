/**
 * pond-check · C5 图生成统一接口测试（tests/image.test.mjs）
 *
 * 这个文件钉的是「图生成」这一层的行为，不是某个 provider 的实现细节：
 *   1. 接口形状：generate / providers / 返回字段
 *   2. **本地不可达静默降级**：ComfyUI 不在线 → 云兜底 → degradedFrom，不报失败
 *   3. seed：能注入就回传同一个；不能注入回传 null 并说明
 *   4. 提示词转义与限长：引号/反斜杠/路径/URL/占位符不许变成工作流结构
 *   5. 落盘：默认 <POND_HOME>/out，显式路径可用，**仓库内路径被拒**
 *   6. 失败路径：全部不可用 / 401 不重试 / 工作流执行失败 / 配置写坏
 *   7. 隔离守卫：src/image 不 import 诊断层、不 import 网络模块
 *
 * 测试纪律（任务书原话「测试里绝不能真发起网络请求」）：
 *   - 所有客户端都注入假 transport，网络「请求」只是一次函数调用；
 *   - 文件开头把 `globalThis.fetch` 换成会抛异常的桩，漏网的真请求当场炸；
 *   - 落盘一律写 mkdtemp 出来的临时 POND_HOME，绝不碰真实 `~/.pond`；
 *   - 轮询 sleep 注入成异步空函数，测试不真等。
 *
 * 变异验证（commandsRun 里记了真实执行结果）：
 *   M1 把「本地不可达 → 降级」改成「不可达就失败」→ 降级用例必须红；
 *   M2 去掉提示词长度上限 → 截断用例红；
 *   M3 去掉字符串模板的 JSON 转义 → 注入用例红；
 *   M4 去掉仓库写盘闸 → 仓内路径用例红；
 *   M5 忽略 supportsSeed 恒回传 seed → seed-null 用例红；
 *   M6 去掉结果里的 degraded/degradedFrom 标记 → 降级用例红。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as image from '../src/image/index.mjs';
import { readEvents } from '../src/shared/events.mjs';

/* ------------------------------------------------------------------ *
 * 0. 安全地基：把真 fetch 换掉 + 临时目录
 * ------------------------------------------------------------------ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-image-'));

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
/** 每个用例一个独立 POND_HOME，事件/图片互不串。 */
function makeHome(label) {
  counter += 1;
  const home = path.join(TEMP_ROOT, `${String(counter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function envFor(home) {
  // 显式覆盖（不是展开 process.env）：避免宿主上真配了 POND_IMAGE_API_KEY
  // 让「没有 key」的用例意外变成有 key。
  return { POND_HOME: home };
}

const NOW = 1_700_000_000_000;

/* ------------------------------------------------------------------ *
 * 1. 夹具：假 transport / 假图片 / 工作流
 * ------------------------------------------------------------------ */

/** 33 字节的 PNG 头（够读宽高，不需要真解码）。 */
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 假 transport：记录每次请求，按 URL 路由到固定响应。
 * 任何没被覆盖的 URL 都回 404（而不是去联网）。
 */
function makeTransport(options = {}) {
  const requests = [];
  const transport = async (url, init = {}) => {
    const target = String(url);
    const entry = {
      url: target,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    };
    requests.push(entry);

    if (typeof options.onRequest === 'function') {
      const custom = await options.onRequest(entry, requests.length);
      if (custom) return custom;
    }

    if (target.startsWith('http://127.0.0.1:8188')) {
      if (target.endsWith('/prompt')) return jsonResponse({ prompt_id: options.promptId ?? 'pid-1' });
      if (target.includes('/history/')) {
        return jsonResponse(options.history ?? {
          'pid-1': {
            outputs: {
              '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
            },
          },
        });
      }
      if (target.includes('/view?')) return new Response(options.image ?? pngBuffer(), { status: 200 });
    }

    if (target.includes('/images/generations')) {
      const data = options.image ?? pngBuffer();
      return jsonResponse(options.openaiBody ?? { data: [{ b64_json: data.toString('base64') }] });
    }

    return new Response('unexpected url in fake transport', { status: 404 });
  };
  return { transport, requests };
}

/** 最小可用工作流模板：覆盖 prompt / negative / seed / width / height 五个注入点。 */
function workflowTemplate() {
  return {
    '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 20 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}' } },
  };
}

function configWith(overrides = {}) {
  const { comfyui = {}, openaiCompat = {}, ...rest } = overrides;
  return {
    chain: ['comfyui', 'openai-compat'],
    comfyui: {
      baseUrl: 'http://127.0.0.1:8188',
      workflow: workflowTemplate(),
      pollIntervalMs: 1,
      ...comfyui,
    },
    openaiCompat: {
      apiKey: 'sk-test-key',
      baseUrl: 'https://image.example.test/v1',
      ...openaiCompat,
    },
    ...rest,
  };
}

function createClientFor(home, extra = {}) {
  const { config = configWith(), transport = makeTransport().transport, ...rest } = extra;
  return image.createImageClient({
    env: envFor(home),
    config,
    transport,
    sleep: async () => {},
    now: () => NOW,
    warn: () => {},
    ...rest,
  });
}

/** 从请求记录里找最后一次 POST /prompt 的工作流对象。 */
function lastWorkflow(requests) {
  const posts = requests.filter((item) => item.url.endsWith('/prompt'));
  assert.ok(posts.length > 0, '没有发出 POST /prompt —— ComfyUI 根本没被调用');
  return posts[posts.length - 1].body.prompt;
}

/* ================================================================== *
 * 2. 接口形状
 * ================================================================== */

test('接口·generate / providers 存在；默认配置下四个内置 provider 都列出但不可用', () => {
  assert.equal(typeof image.generate, 'function');
  assert.equal(typeof image.providers, 'function');
  assert.equal(typeof image.createImageClient, 'function');

  const home = makeHome('default-config');
  const list = image.providers({ env: envFor(home) });

  // C6 起默认链含 seedream / doubao（规格 §5）：没 key 也要如实可见、标不可用。
  assert.deepEqual(list.map((item) => item.id), ['comfyui', 'openai-compat', 'seedream', 'doubao']);
  for (const item of list) {
    assert.equal(typeof item.name, 'string');
    assert.ok(Array.isArray(item.sizes) && item.sizes.length > 0);
    assert.equal(typeof item.cost, 'object');
    assert.equal(typeof item.cost.unit, 'string');
    assert.equal(typeof item.cost.value, 'number');
    assert.equal(typeof item.local, 'boolean');
    assert.equal(item.available, false, '默认（没有工作流、没有 key）四个 provider 都必须标不可用');
  }

  const [comfy, openai, seedream, doubao] = list;
  assert.equal(comfy.local, true);
  assert.equal(comfy.cost.value, 0, '本地 provider 成本恒 0');
  assert.match(comfy.unavailableReason, /workflow/);
  assert.equal(openai.local, false);
  assert.match(openai.unavailableReason, /API key/);
  // C6 云 adapter：「没配 key」必须点名具体 key 名（与「配了但调用失败」分开）。
  assert.equal(seedream.local, false);
  assert.match(seedream.unavailableReason, /POND_SEEDREAM_API_KEY/);
  assert.equal(doubao.local, false);
  assert.match(doubao.unavailableReason, /POND_DOUBAO_API_KEY/);
  assert.equal(fetchCalls, 0, 'providers() 不许联网探测');
});

test('接口·默认配置 generate 会明确失败（列出每个 provider 的原因），且不联网', async () => {
  const home = makeHome('no-provider');
  await assert.rejects(
    image.generate('一只猫', { env: envFor(home) }),
    (error) => {
      assert.equal(error.name, 'CapabilityError');
      assert.equal(error.capability, 'image');
      assert.equal(error.failures.length, 4);
      assert.ok(error.message.includes('comfyui'), '必须点名 comfyui');
      assert.ok(error.message.includes('openai-compat'), '必须点名 openai-compat');
      assert.ok(error.message.includes('seedream'), '必须点名 seedream');
      assert.ok(error.message.includes('doubao'), '必须点名 doubao');
      assert.ok(/workflow/.test(error.message), '必须说明工作流没配');
      assert.ok(/API key/.test(error.message), '必须说明缺 API key');
      assert.ok(/POND_SEEDREAM_API_KEY/.test(error.message), 'seedream 要点名缺哪个 key');
      assert.ok(/POND_DOUBAO_API_KEY/.test(error.message), 'doubao 要点名缺哪个 key');
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
  assert.equal(fs.existsSync(path.join(home, 'out')), false);
});

test('安全·providers() 与配置副本都不泄露 API key', () => {
  const home = makeHome('secret');
  const client = createClientFor(home);
  const serialized = JSON.stringify({ providers: client.providers(), config: client.getConfig() });
  assert.equal(serialized.includes('sk-test-key'), false, 'API key 出现在了对外输出里');
  assert.ok(serialized.includes('[已隐藏]'), '配置副本里的 key 必须是脱敏占位');
});

/* ================================================================== *
 * 3. 落盘边界
 * ================================================================== */

test('落盘·默认写 <POND_HOME>/out，文件名带时间戳与扩展名，绝不在仓库内', async () => {
  const home = makeHome('out-default');
  const { transport } = makeTransport();
  const client = createClientFor(home, { transport });

  const result = await client.generate('一只猫', { seed: 1 });

  assert.equal(result.provider, 'comfyui');
  assert.equal(path.dirname(result.path), path.join(home, 'out'), '默认必须写 POND_HOME/out');
  assert.ok(fs.existsSync(result.path), '图片必须真的落盘');
  assert.equal(image.isInside(ROOT, result.path), false, '图片不许落进仓库');
  assert.match(path.basename(result.path), /^image-\d{8}T\d{6}-[0-9a-f]{8}\.png$/u);
  // 宽高以**实际图片**为准（假图 512x384），不是请求的 1024x1024。
  assert.equal(result.width, 512);
  assert.equal(result.height, 384);
});

test('落盘·调用方 outPath 原样使用；目录则自动补文件名', async () => {
  const home = makeHome('out-explicit');
  const directory = path.join(TEMP_ROOT, 'explicit-out');
  fs.mkdirSync(directory, { recursive: true });
  const { transport } = makeTransport();
  const client = createClientFor(home, { transport });

  const explicit = await client.generate('cat', { outPath: path.join(directory, 'my.png') });
  assert.equal(explicit.path, path.join(directory, 'my.png'));
  assert.ok(fs.existsSync(explicit.path));

  const intoDirectory = await client.generate('cat', { outPath: directory });
  assert.equal(path.dirname(intoDirectory.path), directory);
  assert.notEqual(intoDirectory.path, explicit.path);
});

test('落盘·仓库内路径被拒（显式 outPath 与配置 outDir 都拒）', async () => {
  const home = makeHome('out-repo');
  const { transport } = makeTransport();
  const client = createClientFor(home, { transport });

  // 变异验证（M4）会真的把文件写进仓库，所以这里用进程独立的目录并在 finally 清掉，
  // 避免上一次变异运行污染下一次基线。
  const repoDir = path.join(ROOT, `tmp-image-test-${process.pid}`);
  const repoPath = path.join(repoDir, 'should-not-exist.png');
  fs.rmSync(repoDir, { recursive: true, force: true });
  try {
    await assert.rejects(
      client.generate('cat', { outPath: repoPath }),
      (error) => error.code === 'IMAGE_PATH_UNSAFE' && /仓库/.test(error.message),
    );
    assert.equal(fs.existsSync(repoPath), false, '拒绝之后不许留下文件');

    const repoDirClient = createClientFor(home, {
      config: configWith({ outDir: repoDir }),
      transport,
    });
    await assert.rejects(
      repoDirClient.generate('cat'),
      (error) => error.code === 'IMAGE_PATH_UNSAFE',
    );
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

/* ================================================================== *
 * 4. 核心：本地不可达静默降级（M1 变异点）
 * ================================================================== */

test('降级·ComfyUI 本地不可达 → 静默降级到云，结果标 degradedFrom 而不是失败', async () => {
  const home = makeHome('degrade');
  const requests = [];
  const delays = [];

  const transport = async (url, init = {}) => {
    const target = String(url);
    requests.push(target);
    if (target.includes('127.0.0.1:8188')) {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error; // 本地服务没起
    }
    if (target.includes('/images/generations')) {
      return jsonResponse({ data: [{ b64_json: pngBuffer().toString('base64') }] });
    }
    return new Response('unexpected', { status: 404 });
  };

  const client = image.createImageClient({
    env: envFor(home),
    config: configWith(),
    transport,
    sleep: async (ms) => { delays.push(ms); },
    now: () => NOW,
    warn: () => {},
  });

  const result = await client.generate('一只猫', { seed: 7 });

  assert.equal(result.provider, 'openai-compat', '必须降级到云');
  assert.equal(result.degraded, true, '必须标记降级');
  assert.equal(result.degradedFrom, 'comfyui', '必须说明是哪一档不可用');
  assert.equal(result.seed, null, '云这一档不保证复现，seed 必须回 null');
  assert.equal(result.seedReproducible, false);
  assert.ok(/seed/.test(result.seedNote), '不返回 seed 时必须说明原因');
  assert.ok(fs.existsSync(result.path), '降级后仍然要真的出图');

  // 本地网络错误重试 1 次（500ms 退避）后才降级 —— 不是无限重试，也不是不试。
  assert.equal(requests.filter((item) => item.endsWith('/prompt')).length, 2);
  assert.deepEqual(delays, [500]);

  const events = readEvents({ env: envFor(home) }).entries;
  assert.deepEqual(
    events.map((entry) => [entry.provider, entry.ok, entry.errorCategory]),
    [['comfyui', false, 'network'], ['comfyui', false, 'network'], ['openai-compat', true, null]],
    '诊断层必须看得见「试过 comfyui、失败了、然后降级」',
  );
  assert.equal(events[2].units, 1);
  assert.equal(events[2].degradedFrom, 'comfyui');
});

test('失败·本地不可达且云也没配：CapabilityError 带 comfyui 的 network 原因', async () => {
  const home = makeHome('degrade-none');
  const requests = [];
  const transport = async (url) => {
    requests.push(String(url));
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  };
  const client = createClientFor(home, {
    config: configWith({ openaiCompat: { apiKey: undefined } }),
    transport,
  });

  await assert.rejects(
    client.generate('cat'),
    (error) => {
      assert.equal(error.name, 'CapabilityError');
      assert.equal(error.capability, 'image');
      const failure = error.failures.find((item) => item.provider === 'comfyui');
      assert.ok(failure, '必须列出 comfyui 的失败');
      assert.equal(failure.category, 'network');
      assert.ok(/不可达/.test(failure.reason), `失败原因必须说清是"不可达"：${failure.reason}`);
      return true;
    },
  );
  assert.equal(requests.filter((item) => item.endsWith('/prompt')).length, 2);
});

/* ================================================================== *
 * 5. seed 语义
 * ================================================================== */

test('seed·ComfyUI 指定 seed 原样注入并回传；不给 seed 时回传随机整数', async () => {
  const home = makeHome('seed-comfy');
  const { transport, requests } = makeTransport();
  const client = createClientFor(home, { transport });

  const fixed = await client.generate('cat', { seed: 42 });
  assert.equal(fixed.seed, 42);
  assert.equal(fixed.seedReproducible, true);
  assert.equal(lastWorkflow(requests)['3'].inputs.seed, 42, 'seed 必须写进工作流且是数字');

  const random = await client.generate('cat');
  const seeded = lastWorkflow(requests)['3'].inputs.seed;
  assert.equal(Number.isSafeInteger(random.seed), true);
  assert.equal(random.seed, seeded, '回传的 seed 必须就是工作流里用的那个');
  assert.notEqual(random.seed, 42, '随机 seed 不该碰巧等于上一次的 42（概率极低）');
});

test('seed·工作流没有注入点：回传 null 并说明无法复现', async () => {
  const home = makeHome('seed-none');
  const { transport, requests } = makeTransport();
  const client = createClientFor(home, {
    config: configWith({
      comfyui: {
        workflow: {
          '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
        },
      },
    }),
    transport,
  });

  const result = await client.generate('cat', { seed: 9 });
  assert.equal(result.seed, null);
  assert.equal(result.seedReproducible, false);
  assert.match(result.seedNote, /seed 注入点|无法复现/u);
  const workflow = lastWorkflow(requests);
  assert.deepEqual(Object.keys(workflow), ['6'], '没有注入点时不许凭空加 seed 节点');
});

test('seed·openai-compat 默认不接受 seed（回 null）；显式 supportsSeed 才发并回传', async () => {
  const home = makeHome('seed-openai');
  const { transport, requests } = makeTransport();

  const defaultClient = createClientFor(home, {
    config: configWith({
      chain: ['openai-compat'],
      comfyui: { workflow: null },
      openaiCompat: { supportsSeed: false },
    }),
    transport,
  });
  const withoutSeed = await defaultClient.generate('cat', { seed: 123 });
  assert.equal(withoutSeed.seed, null);
  assert.equal(withoutSeed.seedReproducible, false);
  assert.match(withoutSeed.seedNote, /seed/u);
  const sentBody = requests.find((item) => item.url.includes('/images/generations')).body;
  assert.equal('seed' in sentBody, false, '不支持 seed 时不许往请求体里塞 seed');

  const seedClient = createClientFor(home, {
    config: configWith({
      chain: ['openai-compat'],
      comfyui: { workflow: null },
      openaiCompat: { supportsSeed: true },
    }),
    transport,
  });
  const withSeed = await seedClient.generate('cat', { seed: 123 });
  assert.equal(withSeed.seed, 123);
  assert.equal(withSeed.seedReproducible, true);
  const bodies = requests.filter((item) => item.url.includes('/images/generations'));
  assert.equal(bodies[bodies.length - 1].body.seed, 123);
});

test('seed·非法值（负数 / 小数 / 字符串）直接报错，不悄悄当随机', async () => {
  const home = makeHome('seed-invalid');
  const client = createClientFor(home);
  for (const seed of [-1, 1.5, '42', Number.NaN]) {
    await assert.rejects(
      client.generate('cat', { seed }),
      (error) => error.code === 'IMAGE_INVALID_INPUT' && /seed/.test(error.message),
      `seed=${JSON.stringify(seed)} 应该被拒绝`,
    );
  }
});

/* ================================================================== *
 * 6. 提示词转义与限长（M2 / M3 变异点）
 * ================================================================== */

test('提示词·引号 / 反斜杠 / 路径 / URL / 占位符都不会破坏工作流 JSON', async () => {
  const home = makeHome('prompt-injection');
  const { transport, requests } = makeTransport();
  const client = createClientFor(home, { transport });

  const prompt = '画一个 "logo" }} 还有 /home/u/.ssh/id_rsa 和 C:\\tmp\\x.png '
    + '以及 https://example.com/a?b=1#c\n换行\t制表 {{seed}}';
  const result = await client.generate(prompt, { seed: 5 });
  assert.equal(result.provider, 'comfyui');

  const workflow = lastWorkflow(requests);
  assert.deepEqual(Object.keys(workflow).sort(), ['3', '5', '6', '7'], '工作流结构被提示词改写了');

  const text = workflow['6'].inputs.text;
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('/home/u/.ssh/id_rsa'), '路径应作为普通文本保留');
  assert.ok(text.includes('C:\\tmp\\x.png'), 'Windows 路径应原样保留');
  assert.ok(text.includes('https://example.com/a?b=1#c'), 'URL 应原样保留');
  assert.ok(!text.includes('{{seed}}'), '占位符序列必须被拆开，防止二次注入');
  assert.ok(text.includes('{ {seed} }'));
  assert.equal(workflow['3'].inputs.seed, 5, '用户文本里的 {{seed}} 不许覆盖真正的 seed 槽位');
  assert.deepEqual(JSON.parse(JSON.stringify(workflow)), workflow, '工作流必须是可 JSON 往返的合法结构');
});

test('提示词·字符串模板模式按 JSON 规则转义，注入串不产生新键（M3 变异点）', () => {
  const template = '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"{{prompt}}"}}}';
  const evil = 'x", "evil": {"class_type": "EvilNode"}, "z": "';

  const workflow = image.instantiateWorkflowString(
    template,
    { prompt: evil, negative: '', seed: 1, width: 8, height: 8 },
  );

  assert.deepEqual(Object.keys(workflow), ['6']);
  assert.deepEqual(Object.keys(workflow['6'].inputs), ['text']);
  assert.equal(workflow['6'].inputs.text, evil, '转义后模型看到的必须还是原文');
  assert.equal(workflow.evil, undefined);
});

test('提示词·字符串模板里 prompt 占位符写在字符串外 → ImageConfigError', () => {
  assert.throws(
    () => image.instantiateWorkflowString(
      '{"6":{"inputs":{"text": {{prompt}}}}}',
      { prompt: 'cat', negative: '', seed: 1, width: 8, height: 8 },
    ),
    (error) => error.code === 'IMAGE_CONFIG' && /JSON/u.test(error.message),
  );
});

test('提示词·超长截断到上限并打标记（M2 变异点）', async () => {
  const home = makeHome('prompt-long');
  const { transport, requests } = makeTransport();
  const client = createClientFor(home, { transport });

  const long = 'a'.repeat(5000);
  const result = await client.generate(long);
  const text = lastWorkflow(requests)['6'].inputs.text;

  assert.equal(text.length, image.MAX_PROMPT_CHARS, `必须截到 ${image.MAX_PROMPT_CHARS} 字`);
  assert.ok(text.endsWith('…'), '截断必须留痕迹');
  assert.equal(result.promptTruncated, true);
});

test('提示词·空串 / 纯空白 / 非字符串报错；风格白名单与负向提示词生效', async () => {
  const home = makeHome('prompt-invalid');
  const { transport, requests } = makeTransport();
  const client = createClientFor(home, { transport });

  for (const bad of ['', '   \n\t ', 123, null]) {
    await assert.rejects(
      client.generate(bad),
      (error) => error.code === 'IMAGE_INVALID_INPUT',
      `prompt=${JSON.stringify(bad)} 应该被拒绝`,
    );
  }

  await assert.rejects(
    client.generate('cat', { style: 'anme' }),
    (error) => error.code === 'IMAGE_INVALID_INPUT' && /style/u.test(error.message),
  );

  const styled = await client.generate('cat', { style: 'pixel', negative: 'lowres, bad hands' });
  assert.equal(styled.provider, 'comfyui');
  const workflow = lastWorkflow(requests);
  assert.ok(workflow['6'].inputs.text.includes('pixel art'), '风格补语必须进入提示词');
  assert.equal(workflow['7'].inputs.text, 'lowres, bad hands', '负向提示词必须进入工作流');
});

test('提示词·工作流缺 {{prompt}} 也没有 inject.prompt → 建客户端时就报错（不静默生成"没听提示词"的图）', () => {
  assert.throws(
    () => image.createImageClient({
      env: envFor(makeHome('workflow-no-prompt')),
      config: configWith({
        comfyui: { workflow: { '3': { inputs: { seed: '{{seed}}' } } } },
      }),
      transport: makeTransport().transport,
    }),
    (error) => error.code === 'IMAGE_CONFIG' && /prompt/u.test(error.message),
  );
});

test('提示词·inject 路径不存在 → ImageConfigError（不悄悄新建节点）', () => {
  assert.throws(
    () => image.createImageClient({
      env: envFor(makeHome('workflow-bad-inject')),
      config: configWith({ comfyui: { inject: { prompt: '9.inputs.text' } } }),
      transport: makeTransport().transport,
    }),
    (error) => error.code === 'IMAGE_CONFIG' && /不存在/u.test(error.message),
  );
});

/* ================================================================== *
 * 7. 配置
 * ================================================================== */

test('配置·从 <POND_HOME>/image.json 读工作流与 chain；坏 JSON / 显式路径缺失报错', () => {
  const home = makeHome('config-file');
  fs.writeFileSync(path.join(home, 'image.json'), JSON.stringify({
    chain: ['comfyui'],
    comfyui: { workflow: workflowTemplate(), pollIntervalMs: 1 },
  }), 'utf8');

  const client = image.createImageClient({
    env: envFor(home),
    transport: makeTransport().transport,
    sleep: async () => {},
    now: () => NOW,
    warn: () => {},
  });
  assert.deepEqual(client.chain(), ['comfyui']);
  const comfy = client.providers().find((item) => item.id === 'comfyui');
  assert.equal(comfy.available, true);

  const broken = makeHome('config-broken');
  fs.writeFileSync(path.join(broken, 'image.json'), '{ not json', 'utf8');
  assert.throws(
    () => image.createImageClient({ env: envFor(broken), transport: makeTransport().transport }),
    (error) => error.code === 'IMAGE_CONFIG' && /JSON/u.test(error.message),
  );

  const missing = path.join(TEMP_ROOT, 'no-such-image-config.json');
  assert.throws(
    () => image.createImageClient({ env: envFor(home), configPath: missing, transport: makeTransport().transport }),
    (error) => error.code === 'IMAGE_CONFIG' && /读不到/u.test(error.message),
  );
});

test('配置·workflowPath 相对配置文件目录解析', () => {
  const home = makeHome('config-workflow-path');
  const subdir = path.join(home, 'comfy');
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'workflow.json'), JSON.stringify(workflowTemplate()), 'utf8');
  fs.writeFileSync(path.join(home, 'image.json'), JSON.stringify({
    chain: ['comfyui'],
    comfyui: { workflowPath: 'comfy/workflow.json' },
  }), 'utf8');

  const client = image.createImageClient({
    env: envFor(home),
    transport: makeTransport().transport,
    sleep: async () => {},
    now: () => NOW,
    warn: () => {},
  });
  assert.equal(client.providers().find((item) => item.id === 'comfyui').available, true);
});

/* ================================================================== *
 * 8. 失败路径
 * ================================================================== */

test('失败·ComfyUI 缺 prompt_id / 工作流执行失败 / 空图片 → 都降级到云', async () => {
  const variants = [
    {
      label: 'missing-prompt-id',
      onRequest: (entry) => (entry.url.endsWith('/prompt') ? jsonResponse({}) : null),
    },
    {
      label: 'workflow-error',
      onRequest: (entry) => (entry.url.includes('/history/')
        ? jsonResponse({
          'pid-1': {
            status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] },
            outputs: {},
          },
        })
        : null),
    },
    {
      label: 'empty-image',
      onRequest: (entry) => {
        if (entry.url.includes('/view?')) return new Response(Buffer.alloc(0), { status: 200 });
        return null;
      },
    },
  ];

  for (const variant of variants) {
    const home = makeHome(`failure-${variant.label}`);
    const { transport } = makeTransport({ onRequest: variant.onRequest });
    const client = createClientFor(home, { transport });
    const result = await client.generate('cat', { seed: 1 });
    assert.equal(result.provider, 'openai-compat', `${variant.label}：应降级到云`);
    assert.equal(result.degradedFrom, 'comfyui', `${variant.label}：应标 degradedFrom`);
    assert.ok(fs.existsSync(result.path));
  }
});

test('失败·openai 401 不重试，CapabilityError 里只有一次尝试（auth）', async () => {
  const home = makeHome('openai-401');
  const { transport, requests } = makeTransport({
    onRequest: (entry) => (entry.url.includes('/images/generations')
      ? jsonResponse({ error: { message: 'invalid api key' } }, 401)
      : null),
  });
  const client = createClientFor(home, {
    config: configWith({ chain: ['openai-compat'], comfyui: { workflow: null } }),
    transport,
  });

  await assert.rejects(
    client.generate('cat'),
    (error) => {
      assert.equal(error.name, 'CapabilityError');
      assert.equal(error.failures.length, 1);
      assert.equal(error.failures[0].provider, 'openai-compat');
      assert.equal(error.failures[0].category, 'auth');
      assert.equal(error.failures[0].attempts, 1, '401 不许重试');
      return true;
    },
  );
  assert.equal(requests.filter((item) => item.url.includes('/images/generations')).length, 1);
});

test('失败·openai 响应缺 data[0] → provider 错误归类为 format，不当作成功', async () => {
  const home = makeHome('openai-format');
  const { transport } = makeTransport({
    onRequest: (entry) => (entry.url.includes('/images/generations') ? jsonResponse({ data: [] }) : null),
  });
  const client = createClientFor(home, {
    config: configWith({ chain: ['openai-compat'], comfyui: { workflow: null } }),
    transport,
  });

  await assert.rejects(
    client.generate('cat'),
    (error) => error.name === 'CapabilityError'
      && error.failures[0].category === 'format'
      && /data\[0\]/u.test(error.failures[0].reason),
  );
});

/* ================================================================== *
 * 9. 记账（事件流是唯一接缝）
 * ================================================================== */

test('记账·成功出图写一条 image 事件：本地 1 张 = 0 元，云按 perImage 单价', async () => {
  const localHome = makeHome('budget-local');
  const { transport } = makeTransport();
  const localClient = createClientFor(localHome, { transport });
  await localClient.generate('cat', { seed: 1 });

  const localEvents = readEvents({ env: envFor(localHome) }).entries;
  assert.equal(localEvents.length, 1);
  assert.deepEqual(
    [localEvents[0].capability, localEvents[0].provider, localEvents[0].units, localEvents[0].costEstimate, localEvents[0].ok],
    ['image', 'comfyui', 1, 0, true],
  );
  assert.equal('prompt' in localEvents[0], false, '事件里不许出现提示词');
  assert.equal('path' in localEvents[0], false, '事件里不许出现图片路径');

  const cloudHome = makeHome('budget-cloud');
  const cloudClient = createClientFor(cloudHome, {
    config: configWith({
      chain: ['openai-compat'],
      comfyui: { workflow: null },
      openaiCompat: { cost: { unit: 'perImage', value: 0.04 } },
    }),
    transport,
  });
  await cloudClient.generate('cat');
  const cloudEvents = readEvents({ env: envFor(cloudHome) }).entries;
  assert.equal(cloudEvents[0].provider, 'openai-compat');
  assert.equal(cloudEvents[0].units, 1);
  assert.equal(cloudEvents[0].costEstimate, 0.04);
});

/* ================================================================== *
 * 10. 隔离守卫
 * ================================================================== */

test('守卫·src/image 只 import 内置模块与共享层，不碰诊断层 / 网络模块', () => {
  const dir = path.join(ROOT, 'src', 'image');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length >= 8, `src/image 至少 8 个模块，实际 ${files.length}`);

  const bannedNetwork = ['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls'];
  const forbiddenDiagnostic = ['../cli', '../discover', '../read', '../evaluate', '../render', '../check'];
  const importPattern = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gu;

  for (const name of files) {
    const relative = path.join('src', 'image', name);
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    // 先剥注释，注释里的示例 import 不算依赖。
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

    for (const match of code.matchAll(importPattern)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../shared/'),
        `${relative} 只许 import 内置模块 / 同目录文件 / ../shared/，实际 import 了 '${specifier}'`,
      );
      assert.equal(bannedNetwork.includes(specifier), false, `${relative} 不许 import ${specifier}`);
      assert.equal(forbiddenDiagnostic.includes(specifier), false, `${relative} 不许 import 诊断层 ${specifier}`);
    }

    // fetch 只允许出现在 index.mjs（默认 transport 的装配处）。
    if (name !== 'index.mjs') {
      assert.equal(/\bfetch\s*\(/u.test(code), false, `${relative} 不许直接调用 fetch()（只通过注入的 transport）`);
    }
    assert.equal(/\bnew\s+WebSocket\s*\(/u.test(code), false, `${relative} 不许创建 WebSocket`);
  }
});

/* ================================================================== *
 * 11. 零真实网络（必须是最后一个用例）
 * ================================================================== */

test('安全·全程零真实网络：本文件所有请求都走假 transport', () => {
  assert.equal(fetchCalls, 0, `有 ${fetchCalls} 次调用落到了 globalThis.fetch —— 测试真的联网了`);
});
