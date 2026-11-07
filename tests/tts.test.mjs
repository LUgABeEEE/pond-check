/**
 * pond-check · C4 TTS 统一接口测试（tests/tts.test.mjs）
 *
 * 这个文件钉的是**说话这件事的契约**：
 *   1. 接口形状：speak() 返回值 / providers() 清单 / voices() 清单
 *   2. 分段拼接：长文本按标点分段（单段 ≤ 300 字）、逐段合成、拼接还原
 *   3. estimated 标记：有精确时长就不标，拿不到就估算并标 estimated: true
 *   4. provider 降级：edge 挂了自动落到 command，结果带 degradedFrom
 *   5. 全失败报错：CapabilityError 必须写清「哪个 provider、什么错」
 *   6. 零联网：所有 edge 测试注入假 transport，全局 fetch/WebSocket 打桩兜底
 *   7. 令牌对照：edge-gec.mjs 与 edge-tts 7.3.1 的 Python 原实现离线对照向量
 *
 * 验收门（任务书原话）：
 *   node --test tests/tts.test.mjs 全绿；覆盖接口形状、分段拼接、estimated 标记、
 *   provider 降级、全失败报错含原因；测试里绝不能真发起网络请求。
 *   变异验证：去掉分段逻辑，长文本测试必须红（见 update_task 的 commandsRun）。
 *
 * 测试纪律：
 *   - 事件写入都指向 mkdtemp 的临时 POND_HOME，不碰真实 `~/.pond`；
 *   - 网络类错误的重试退避用注入的 sleep 记录，不真的等 500ms；
 *   - command adapter 走真子进程（tests/fixtures/fake-tts.mjs），但不依赖
 *     机器上装了任何真实 TTS CLI。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEvents } from '../src/shared/events.mjs';
import { CAPABILITY_TIMEOUTS, timeoutFor, CapabilityError } from '../src/shared/call.mjs';

import {
  createTts,
  segmentText,
  concatAudio,
  audioDurationMs,
  wavDurationMs,
  parseWav,
  textDurationMs,
  tokenizeCommand,
  fillTemplate,
  binaryAvailable,
  generateSecMsGec,
  tokenHash,
  SEGMENT_MAX_CHARS,
  TTS_FORMATS,
} from '../src/tts/index.mjs';
import { EDGE_VOICES, speedToRate, buildSsml, resolveEdgeVoice } from '../src/tts/edge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = path.join(HERE, 'fixtures', 'fake-tts.mjs');
const NODE = process.execPath;

/** 造一个临时目录（输出文件 / POND_HOME 都放这里）。 */
function tempDir(prefix = 'pond-tts-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 标准测试实例：假 transport（记录每次收到的文本）+ 假 CLI command 兜底，
 * 事件写进临时 POND_HOME，sleep 记录不真等。
 */
function makeTts(overrides = {}) {
  const calls = [];
  const home = tempDir('pond-tts-home-');
  const transport = overrides.transport ?? (async ({ text }) => {
    calls.push(text);
    return { audio: Buffer.from(`[${text}]`) };
  });
  const tts = createTts({
    transport,
    command: overrides.command ?? {
      command: [NODE, FAKE_CLI, '--out', '{out}', '--text', '{text}'],
      available: true,
    },
    env: { POND_HOME: home },
    sleep: overrides.sleep ?? (async () => {}),
    warn: () => {},
    ...overrides.hooks,
  });
  return { tts, calls, home, transport };
}

/* ------------------------------------------------------------------ *
 * 7. 令牌对照（先钉住：真实 edge transport 的握手令牌 == edge-tts 原实现）
 * ------------------------------------------------------------------ */

test('令牌·Sec-MS-GEC 与 edge-tts 7.3.1 的 Python 原实现逐字一致（离线对照向量）', () => {
  // 向量由 /tmp 里 edge-tts 7.3.1 的 drm.generate_sec_ms_gec_v2 / drm._token_hash
  // 生成（Python 对照脚本），**不联网**；逐字钉死防「看起来像」的假移植。
  const vectors = [
    ['1700000000', '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2'],
    ['1700000001.25', '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2'],
    ['0', '52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6'],
    ['1234567890.987', 'BA405D1577B8E0CE-61F01E88539977A1A1E969572D82EECFA45FB1E5DEBD122D6ACBAF0054F959E5'],
    ['1762600000', '32867DDE941117D8-371C0B0740F6E768F46C1308F20143CB3199EDE1C27EDE417D84DF918DF601FC'],
    ['1762600000.125', '32867DDE941117D8-371C0B0740F6E768F46C1308F20143CB3199EDE1C27EDE417D84DF918DF601FC'],
  ];
  for (const [timestamp, want] of vectors) {
    assert.equal(generateSecMsGec(Number(timestamp)), want, `GEC 向量不一致：${timestamp}`);
  }

  const hashVectors = [
    ['1234567890123456786A5AA1D4EAFF4E9FB37E23D68491D6F4', '28189552C0C7D43E', '64170AF48B46BD3C8BD6B940FFF358ABDB1F366B3DC83D4137FACC1B784A52DD'],
    ['9999999999999999996A5AA1D4EAFF4E9FB37E23D68491D6F4', 'DE40A5F2695051E8', 'D01B8C7E4BC071D71922E54412629F7E2E84B82DA2A65CF4AAC5025207F77A53'],
    ['11111116A5AA1D4EAFF4E9FB37E23D68491D6F4', '6019211E14EB299E', '5B54E6F79CC3A6823E85D6189AFDFE798B179F30DB1D17BAB527D0F17F800BF0'],
  ];
  for (const [data, cs64, sha256] of hashVectors) {
    const got = tokenHash(new TextEncoder().encode(data));
    assert.equal(got.cs64, cs64, `CS64 不一致：${data.slice(0, 12)}…`);
    assert.equal(got.sha256, sha256, `SHA-256 不一致：${data.slice(0, 12)}…`);
  }
});

/* ------------------------------------------------------------------ *
 * 1. 接口形状
 * ------------------------------------------------------------------ */

test('接口形状·providers() 每项有 {id, name, voices, cost, local, available}，免费项 cost 为 0', () => {
  const { tts } = makeTts();
  const list = tts.providers();

  assert.ok(Array.isArray(list) && list.length >= 2, 'providers() 应至少列出 edge 与 command');
  for (const info of list) {
    for (const key of ['id', 'name', 'voices', 'cost', 'local', 'available']) {
      assert.ok(key in info, `provider ${info.id} 缺字段 ${key}`);
    }
    assert.equal(typeof info.available, 'boolean');
    assert.deepEqual(Object.keys(info.cost).sort(), ['unit', 'value']);
  }

  const edge = list.find((item) => item.id === 'edge');
  const command = list.find((item) => item.id === 'command');
  assert.ok(edge && command, 'edge 与 command 都要在清单里');
  assert.equal(edge.local, false, 'edge 是云端 provider');
  assert.equal(command.local, true, 'command 是本地 provider');
  assert.equal(edge.cost.value, 0, 'edge 免费');
  assert.equal(command.cost.value, 0, 'command 免费');
  assert.equal(edge.available, true);
  assert.ok(edge.voices.length > 0, 'edge 要带音色表');
});

test('接口形状·未配置 command 时如实标 available:false 并说明原因', () => {
  const home = tempDir('pond-tts-home-');
  const tts = createTts({
    transport: async ({ text }) => ({ audio: Buffer.from(`[${text}]`) }),
    env: { POND_HOME: home },
    warn: () => {},
  });
  const command = tts.providers().find((item) => item.id === 'command');
  assert.equal(command.available, false);
  assert.match(String(command.availableReason), /未配置/u);
});

test('接口形状·voices() 带 provider 归属，edge 音色含性别与语种', () => {
  const { tts } = makeTts();
  const voices = tts.voices();
  const xiaoyi = voices.find((item) => item.id === 'xiaoyi');
  assert.ok(xiaoyi, 'voices() 里要有 xiaoyi');
  assert.equal(xiaoyi.provider, 'edge');
  assert.equal(xiaoyi.gender, 'female');
  assert.ok(Array.isArray(xiaoyi.langs) && xiaoyi.langs.includes('zh-CN'));
});

test('接口形状·speak() 返回 {path, durationMs, format, provider, estimated} 并真的落盘', async () => {
  const { tts } = makeTts();
  const outDir = tempDir('pond-tts-out-');
  const outPath = path.join(outDir, 'hello.mp3');

  const result = await tts.speak('你好，世界。', { outPath });

  for (const key of ['path', 'durationMs', 'format', 'provider', 'estimated', 'degradedFrom', 'segments']) {
    assert.ok(key in result, `speak() 返回缺 ${key}`);
  }
  assert.equal(result.path, outPath);
  assert.equal(result.format, 'mp3');
  assert.equal(result.provider, 'edge');
  assert.equal(result.degradedFrom, null, '链首成功不该有 degradedFrom');
  assert.equal(result.segments, 1);
  assert.equal(typeof result.durationMs, 'number');
  assert.equal(typeof result.estimated, 'boolean');
  assert.equal(fs.readFileSync(outPath, 'utf8'), '[你好，世界。]', '合成内容应该写进 outPath');
});

test('接口形状·不传 outPath 写临时文件（.mp3 后缀）', async () => {
  const { tts } = makeTts();
  const result = await tts.speak('测试');
  assert.ok(fs.existsSync(result.path), '临时文件要存在');
  assert.match(result.path, /\.mp3$/u);
  assert.equal(path.dirname(result.path), os.tmpdir());
  fs.rmSync(result.path, { force: true });
});

test('接口形状·非法入参是编程错误（TypeError），不伪装成能力失败', async () => {
  const { tts } = makeTts();
  await assert.rejects(() => tts.speak(''), TypeError);
  await assert.rejects(() => tts.speak('   '), TypeError);
  await assert.rejects(() => tts.speak(null), TypeError);
  await assert.rejects(() => tts.speak('hi', { format: 'flac' }), TypeError);
  await assert.rejects(() => tts.speak('hi', { speed: 0 }), TypeError);
  await assert.rejects(() => tts.speak('hi', { speed: 'fast' }), TypeError);
  await assert.rejects(() => tts.speak('hi', { outPath: '' }), TypeError);
});

/* ------------------------------------------------------------------ *
 * 2. 分段拼接
 * ------------------------------------------------------------------ */

test('分段·segmentText 单元性质：每段 ≤300、join 还原原文、短文不分', () => {
  // 长文：30 个带标点的句子（25 字 × 30 = 750 字 → 至少 3 段）。
  const sentence = '这是一个测试句子，用来验证分段逻辑是否正确工作。';
  const longText = sentence.repeat(30);
  assert.ok(longText.length > SEGMENT_MAX_CHARS * 2, '测试文本要长到至少 3 段');

  const segments = segmentText(longText);
  assert.ok(segments.length >= 3, `长文应该分多段，实际 ${segments.length}`);
  for (const segment of segments) {
    assert.ok(segment.length <= SEGMENT_MAX_CHARS, `有一段超长：${segment.length} 字`);
  }
  assert.equal(segments.join(''), longText, '分段必须无损还原原文');

  // 短文一段搞定。
  assert.deepEqual(segmentText('短句。'), ['短句。']);
  assert.deepEqual(segmentText(''), [], '空文本返回空数组');

  // 无标点长跑：硬切也要守住上限，仍然无损。
  const noPunct = 'a'.repeat(650);
  const hard = segmentText(noPunct);
  assert.equal(hard.length, 3);
  for (const segment of hard) assert.ok(segment.length <= SEGMENT_MAX_CHARS);
  assert.equal(hard.join(''), noPunct);

  // 标点归前段末尾（用缩小的 maxChars 观察断点行为：短文本来就不分段）。
  assert.deepEqual(segmentText('第一句。第二句！', 5), ['第一句。', '第二句！']);
  assert.deepEqual(segmentText('第一句。第二句！', 4), ['第一句。', '第二句！']);
});

test('分段·长文本逐段合成、每段 ≤300 字、输出是各段音频按序拼接', async () => {
  const { tts, calls } = makeTts();
  const outDir = tempDir('pond-tts-out-');
  const outPath = path.join(outDir, 'long.mp3');

  const sentence = '这是一个测试句子，用来验证分段逻辑是否正确工作。';
  const longText = sentence.repeat(30);

  const result = await tts.speak(longText, { outPath });

  assert.ok(result.segments >= 3, `应该至少 3 段，实际 ${result.segments}`);
  assert.equal(calls.length, result.segments, 'transport 收到的次数 = 段数');
  for (const chunk of calls) {
    assert.ok(chunk.length <= SEGMENT_MAX_CHARS, `单段超过 ${SEGMENT_MAX_CHARS} 字：${chunk.length}`);
    assert.ok(chunk.length > 0, '不该有空段发给 transport');
  }
  assert.equal(calls.join(''), longText, '各段拼起来必须还原原文');

  // 假 transport 每段返回 '[<文本>]' —— 输出文件应该就是按序拼接。
  const expected = calls.map((chunk) => `[${chunk}]`).join('');
  assert.equal(fs.readFileSync(outPath, 'utf8'), expected, '多段音频必须按序拼接');
});

test('分段·短文本只合成一次', async () => {
  const { tts, calls } = makeTts();
  await tts.speak('短句。');
  assert.equal(calls.length, 1);
});

test('拼接·wav 多段合并 RIFF：时长相加、data 不带重复的头', () => {
  const makeWav = (dataBytes) => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);
    return Buffer.concat([header, Buffer.alloc(dataBytes)]);
  };

  const a = makeWav(4800); // 100ms
  const b = makeWav(9600); // 200ms
  const merged = concatAudio([a, b], 'wav');

  const parsed = parseWav(merged);
  assert.ok(parsed, '合并后的 wav 头必须还能解析');
  assert.equal(parsed.dataEnd - parsed.dataStart, 4800 + 9600, 'data 块应该是两段之和');
  assert.equal(merged.readUInt32LE(4), merged.length - 8, 'RIFF 长度字段要修对');
  assert.equal(wavDurationMs(merged), 300, '合并后时长 = 100ms + 200ms');
});

/* ------------------------------------------------------------------ *
 * 3. estimated 标记
 * ------------------------------------------------------------------ */

test('estimated·transport 不给时长且非 wav → 估算值 + estimated:true', async () => {
  const { tts } = makeTts();
  const result = await tts.speak('估个时长试试', { format: 'mp3' });
  assert.equal(result.estimated, true, '拿不到精确时长必须标 estimated');
  // 假音频 '[…]' 6 字节 + 文本字节，按 16 字节/ms 估。
  assert.ok(result.durationMs > 0, '估算也要给出正的时长');
});

test('estimated·transport 给了精确时长 → 不标 estimated，逐段相加', async () => {
  let seen = 0;
  const { tts } = makeTts({
    transport: async ({ text }) => {
      seen += 1;
      return { audio: Buffer.from(`[${text}]`), durationMs: 500 };
    },
  });
  const sentence = '这是一个测试句子，用来验证分段逻辑是否正确工作。';
  const result = await tts.speak(sentence.repeat(30));
  assert.equal(result.estimated, false, '有精确时长不该标 estimated');
  assert.equal(result.durationMs, seen * 500, '总时长 = 各段精确时长之和');
});

test('estimated·command 输出真 wav → 从头精确算，estimated:false', async () => {
  const { tts } = makeTts({
    command: {
      command: [NODE, FAKE_CLI, '--wav', '100', '--out', '{out}', '--text', '{text}'],
      available: true,
    },
    transport: async () => {
      throw new Error('本用例不该走 edge');
    },
  });
  const result = await tts.speak('本地合成一段', { format: 'wav' });
  assert.equal(result.provider, 'command');
  assert.equal(result.estimated, false, 'wav 时长可以从头精算');
  assert.equal(result.durationMs, 100);
});

test('estimated·command 多段 wav 拼接后总时长 = 各段之和且仍不标估算', async () => {
  const { tts } = makeTts({
    command: {
      command: [NODE, FAKE_CLI, '--wav', '100', '--out', '{out}', '--text', '{text}'],
      available: true,
    },
    transport: async () => {
      throw new Error('本用例不该走 edge');
    },
  });
  const sentence = '这是一个测试句子，用来验证分段逻辑是否正确工作。';
  const result = await tts.speak(sentence.repeat(30), { format: 'wav' });
  assert.ok(result.segments >= 3);
  assert.equal(result.durationMs, result.segments * 100);
  assert.equal(result.estimated, false);
});

test('estimated·command 输出非 wav 字节 → 估算值 + estimated:true', async () => {
  const { tts } = makeTts({
    command: {
      command: [NODE, FAKE_CLI, '--out', '{out}', '--text', '{text}'],
      available: true,
    },
    transport: async () => {
      throw new Error('本用例不该走 edge');
    },
  });
  const result = await tts.speak('本地假音频', { format: 'mp3' });
  assert.equal(result.provider, 'command');
  assert.equal(result.estimated, true);
  assert.ok(result.durationMs > 0);
});

test('时长·audioDurationMs/textDurationMs 的估算语义', () => {
  const mp3 = audioDurationMs(Buffer.alloc(160), 'mp3');
  assert.equal(mp3.estimated, true);
  assert.equal(mp3.durationMs, 10, 'mp3 按 16 字节/ms 估');

  assert.ok(textDurationMs('中文四个字') > textDurationMs('abcd'));
  assert.equal(textDurationMs(''), 0);
});

/* ------------------------------------------------------------------ *
 * 4. provider 降级
 * ------------------------------------------------------------------ */

test('降级·edge 失败自动落到 command，结果带 degradedFrom，事件记两条尝试', async () => {
  const { tts, home } = makeTts({
    transport: async () => {
      const error = new Error('transport boom');
      error.category = 'unknown'; // 不重试，直接降级（快且语义清楚）
      throw error;
    },
  });
  const outDir = tempDir('pond-tts-out-');
  const outPath = path.join(outDir, 'fallback.mp3');

  const result = await tts.speak('降级测试', { outPath });

  assert.equal(result.provider, 'command', 'edge 挂了要用 command 出声');
  assert.equal(result.degradedFrom, 'edge', '必须告知降级来自链首 edge');
  assert.equal(fs.readFileSync(outPath, 'utf8'), '[降级测试]', 'command 真的合成了内容');

  const events = readEvents({ env: { POND_HOME: home } }).entries;
  assert.equal(events.length, 2, '一次尝试一行：edge 失败 + command 成功');
  assert.deepEqual(events.map((entry) => [entry.provider, entry.ok]), [['edge', false], ['command', true]]);
  assert.equal(events[0].units, 0, '失败尝试不计用量');
  assert.equal(events[1].units, '降级测试'.length, '成功尝试按字符数计');
  assert.equal(events[1].costEstimate, 0, '免费 provider 成本为 0');
});

test('降级·网络类错误先重试一次再降级（退避走注入的 sleep，不真等）', async () => {
  const delays = [];
  let attempts = 0;
  const { tts } = makeTts({
    transport: async () => {
      attempts += 1;
      throw new Error('fetch failed'); // 网络类 → 可重试
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    hooks: {},
  });
  // 只留 edge（command 先摘掉），看 edge 自己的重试节奏。
  tts.registry.unregister('tts', 'command');
  await assert.rejects(() => tts.speak('重试测试'));
  assert.equal(attempts, 2, '网络类错误应试 2 次（1 重试）');
  assert.deepEqual(delays, [500], '指数退避第 1 次等 500ms');
});

test('降级·超时按 timeout 归类、不重试、直接降级（单次超时上限 30s 钉在共享层）', async () => {
  assert.equal(CAPABILITY_TIMEOUTS.tts, 30_000, 'tts 单次超时必须是 30s');
  assert.equal(timeoutFor('tts'), 30_000);

  const { tts, home } = makeTts({
    transport: async ({ signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const outDir = tempDir('pond-tts-out-');
  const result = await tts.speak('超时测试', { outPath: path.join(outDir, 'timeout.mp3'), timeoutMs: 120 });

  assert.equal(result.provider, 'command', '超时要降级到本地命令');
  assert.equal(result.degradedFrom, 'edge');

  const events = readEvents({ env: { POND_HOME: home } }).entries;
  assert.equal(events[0].provider, 'edge');
  assert.equal(events[0].errorCategory, 'timeout', '超时归类必须是 timeout');
});

test('降级·鉴权类错误不重试直接降级', async () => {
  let attempts = 0;
  const { tts } = makeTts({
    transport: async () => {
      attempts += 1;
      const error = new Error('401 unauthorized');
      error.status = 401;
      throw error;
    },
    sleep: async () => {
      throw new Error('鉴权错误不该走到重试的 sleep');
    },
  });
  const result = await tts.speak('鉴权测试');
  assert.equal(result.provider, 'command');
  assert.equal(attempts, 1, '401 不该重试');
});

/* ------------------------------------------------------------------ *
 * 5. 全失败报错
 * ------------------------------------------------------------------ */

test('全失败·CapabilityError 写清每个 provider 是谁、什么错', async () => {
  const { tts } = makeTts({
    transport: async () => {
      throw new Error('transport boom');
    },
    command: {
      command: [NODE, FAKE_CLI, '--fail', '--out', '{out}', '--text', '{text}'],
      available: true,
    },
  });

  await assert.rejects(
    () => tts.speak('全军覆没'),
    (error) => {
      assert.equal(error.name, 'CapabilityError');
      assert.ok(error instanceof CapabilityError);
      const message = error.message;
      assert.match(message, /edge/u, '报错要提到 edge');
      assert.match(message, /command/u, '报错要提到 command');
      assert.match(message, /transport boom/u, '报错要带 edge 的失败原因');
      assert.match(message, /synth exploded/u, '报错要带 command 的 stderr 原因');

      assert.equal(error.failures.length, 2, 'err.failures 逐个 provider 一条');
      const byProvider = Object.fromEntries(error.failures.map((failure) => [failure.provider, failure]));
      assert.ok(byProvider.edge && byProvider.command);
      for (const failure of error.failures) {
        assert.ok(['auth', 'timeout', 'network', 'quota', 'format', 'unknown'].includes(failure.category));
        assert.equal(typeof failure.reason, 'string');
        assert.ok(failure.reason.length > 0);
      }
      return true;
    },
  );
});

test('全失败·一个可用 provider 都没有时说「没有任何可用的 provider」', async () => {
  const tts = createTts({ providers: [] });
  await assert.rejects(
    () => tts.speak('没人能说'),
    (error) => {
      assert.equal(error.name, 'CapabilityError');
      assert.match(error.message, /没有任何可用的 provider/u);
      return true;
    },
  );
});

test('全失败·command 找不到可执行文件时报错含 provider 与原因', async () => {
  const { tts } = makeTts({
    transport: async () => {
      const error = new Error('transport boom');
      error.category = 'unknown';
      throw error;
    },
    command: {
      command: ['/nonexistent/definitely-not-a-tts', '--out', '{out}', '--text', '{text}'],
      available: true,
    },
  });

  await assert.rejects(
    () => tts.speak('找不到命令'),
    (error) => {
      assert.match(error.message, /command/u);
      assert.match(error.message, /ENOENT|no such file|not-a-tts/iu);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * 6. command adapter 细节
 * ------------------------------------------------------------------ */

test('command·argv 模板逐项替换，shell 元字符原样透传（无 shell 参与）', async () => {
  const { tts } = makeTts({
    command: {
      command: [
        NODE, FAKE_CLI, '--echo-argv', '--out', '{out}',
        '--text', '{text}', '--voice', '{voice}', '--speed', '{speed}', '--format', '{format}',
      ],
      voiceMap: { xiaoyi: 'cli-yixiao' },
      available: true,
    },
    transport: async () => {
      throw new Error('本用例不该走 edge');
    },
  });

  const evilText = 'hello; rm -rf / $(whoami) `reboot`';
  const result = await tts.speak(evilText, { voice: 'xiaoyi', speed: 1.25, format: 'wav' });
  const seen = JSON.parse(fs.readFileSync(result.path, 'utf8'));

  assert.equal(seen.argv[seen.argv.indexOf('--text') + 1], evilText, '文本要作为一个 argv 项原样传，不做 shell 展开');
  assert.equal(seen.argv[seen.argv.indexOf('--voice') + 1], 'cli-yixiao', 'voiceMap 生效');
  assert.equal(seen.argv[seen.argv.indexOf('--speed') + 1], '1.25', 'speed 原样透传');
  assert.equal(seen.argv[seen.argv.indexOf('--format') + 1], 'wav');
  assert.equal(seen.argv[seen.argv.indexOf('--out') + 1], result.path, '{out} 换成真实输出路径');
});

test('command·stdin 模式：文本走 stdin 而不是 argv', async () => {
  const { tts } = makeTts({
    command: {
      command: [NODE, FAKE_CLI, '--stdin', '--echo-argv', '--out', '{out}'],
      stdin: true,
      available: true,
    },
    transport: async () => {
      throw new Error('本用例不该走 edge');
    },
  });

  const result = await tts.speak('走 stdin 的文本');
  const seen = JSON.parse(fs.readFileSync(result.path, 'utf8'));
  assert.equal(seen.stdinText, '走 stdin 的文本');
  assert.ok(!seen.argv.includes('走 stdin 的文本'), '文本不该出现在 argv 里');
});

test('command·假 shell 片段（echo 到文件）走通整条调用链', async () => {
  // 任务书点名的验证方式：假 shell 片段 echo 到文件 —— 不依赖真装了 piper。
  const { tts } = makeTts({
    command: {
      command: ['sh', '-c', 'printf %s "$1" > "$2"', 'sh', '{text}', '{out}'],
      available: true,
    },
    transport: async () => {
      throw new Error('本用例不该走 edge');
    },
  });
  const outDir = tempDir('pond-tts-out-');
  const outPath = path.join(outDir, 'echo.txt.mp3');
  const result = await tts.speak('echo 到文件', { outPath });
  assert.equal(result.provider, 'command');
  assert.equal(fs.readFileSync(outPath, 'utf8'), 'echo 到文件');
});

test('command·多段合成：分段各跑一次 CLI，按序拼接，part 临时文件清理干净', async () => {
  const outDir = tempDir('pond-tts-out-');
  const outPath = path.join(outDir, 'multi.mp3');
  const { tts } = makeTts({
    command: {
      command: [NODE, FAKE_CLI, '--out', '{out}', '--text', '{text}'],
      available: true,
    },
    transport: async () => {
      throw new Error('本用例不该走 edge');
    },
  });

  const sentence = '这是一个测试句子，用来验证分段逻辑是否正确工作。';
  const longText = sentence.repeat(30);
  const result = await tts.speak(longText, { outPath });

  assert.ok(result.segments >= 3);
  const segments = segmentText(longText);
  assert.equal(fs.readFileSync(outPath, 'utf8'), segments.map((s) => `[${s}]`).join(''), '拼接顺序 = 文本顺序');

  const leftovers = fs.readdirSync(outDir).filter((name) => name.includes('.part'));
  assert.deepEqual(leftovers, [], '中间产物 .part 文件必须清理');
});

test('command·命令失败带 stderr 原因，provider 名在错误里', async () => {
  const provider = (await import('../src/tts/command.mjs')).createCommandProvider({
    command: [NODE, FAKE_CLI, '--fail', '--out', '{out}', '--text', '{text}'],
    available: true,
  });
  const outDir = tempDir('pond-tts-out-');
  await assert.rejects(
    () => provider.run({ text: 'x', segments: ['x'], format: 'mp3', outPath: path.join(outDir, 'x.mp3') }, {}),
    (error) => {
      assert.match(error.message, /command/u);
      assert.match(error.message, /synth exploded/u, 'stderr 要进错误原因');
      return true;
    },
  );
});

test('command·tokenizeCommand 与 fillTemplate 的语义', () => {
  assert.deepEqual(tokenizeCommand("piper --model 'my model.onnx' -f {out}"), ['piper', '--model', 'my model.onnx', '-f', '{out}']);
  assert.deepEqual(tokenizeCommand('say -v "Tingting" {text}'), ['say', '-v', 'Tingting', '{text}']);
  assert.throws(() => tokenizeCommand('piper --model "没闭合'), TypeError);

  // 同时替换：{text} 的内容里出现 {out} 不会被二次替换。
  assert.deepEqual(
    fillTemplate(['--out', '{out}', '--text', '{text}'], { out: '/a.mp3', text: '看见 {out} 也别动' }),
    ['--out', '/a.mp3', '--text', '看见 {out} 也别动'],
  );
});

test('command·binaryAvailable：绝对路径与 PATH 探测', () => {
  assert.equal(binaryAvailable(NODE), true, 'node 本身应该在 PATH 上');
  assert.equal(binaryAvailable('/nonexistent/not-here'), false);
  assert.equal(binaryAvailable(''), false);
});

/* ------------------------------------------------------------------ *
 * edge adapter 细节（离线）
 * ------------------------------------------------------------------ */

test('edge·音色映射、语速换算与 SSML 组装（不联网）', () => {
  assert.equal(resolveEdgeVoice('xiaoyi'), 'zh-CN-XiaoyiNeural');
  assert.equal(resolveEdgeVoice('zh-CN-YunxiNeural'), 'zh-CN-YunxiNeural', '服务端 ID 原样透传');
  assert.equal(resolveEdgeVoice(undefined), 'zh-CN-XiaoxiaoNeural');

  assert.equal(speedToRate(1), '+0%');
  assert.equal(speedToRate(1.25), '+25%');
  assert.equal(speedToRate(0.8), '-20%');
  assert.equal(speedToRate(3), '+100%', '上限夹到 +100%');

  const ssml = buildSsml({ text: '你好 <世界>', voice: 'zh-CN-XiaoyiNeural', rate: '+0%', emotion: 'happy' });
  assert.ok(ssml.includes("name='zh-CN-XiaoyiNeural'"));
  assert.ok(ssml.includes('&lt;世界&gt;'), 'XML 转义不能丢');
  assert.ok(ssml.includes('mstts:express-as style="happy"'), 'emotion 不支持也要带上，服务端会忽略');

  assert.ok(EDGE_VOICES.xiaoyi.id.startsWith('zh-CN-'));
});

test('edge·空音频视为格式错误（不静默返回空文件）', async () => {
  const { tts } = makeTts({
    transport: async () => ({ audio: Buffer.alloc(0) }),
    command: {
      command: [NODE, FAKE_CLI, '--out', '{out}', '--text', '{text}'],
      available: true,
    },
  });
  const result = await tts.speak('空音频测试');
  assert.equal(result.provider, 'command', 'edge 给空音频必须判失败并降级');
  assert.equal(result.degradedFrom, 'edge');
});

/* ------------------------------------------------------------------ *
 * 6b. 零联网红线
 * ------------------------------------------------------------------ */

test('红线·测试全程零联网：fetch/WebSocket 被打桩后 speak 照常工作', async () => {
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;
  const trap = () => {
    throw new Error('测试里不允许发起真实网络请求');
  };
  globalThis.fetch = trap;
  globalThis.WebSocket = trap;
  try {
    const { tts } = makeTts();
    const result = await tts.speak('零联网自检');
    assert.equal(result.provider, 'edge');
    assert.equal(fs.readFileSync(result.path, 'utf8'), '[零联网自检]');
    fs.rmSync(result.path, { force: true });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
  }
});

/* ------------------------------------------------------------------ *
 * 记账接缝（能力层写、诊断层读的唯一文件）
 * ------------------------------------------------------------------ */

test('记账·speak 的尝试事件落 <POND_HOME>/events.jsonl，八字段齐全', async () => {
  const { tts, home } = makeTts();
  await tts.speak('记账测试');

  const events = readEvents({ env: { POND_HOME: home } });
  assert.equal(events.entries.length, 1);
  const entry = events.entries[0];
  for (const field of ['ts', 'capability', 'provider', 'units', 'costEstimate', 'durationMs', 'ok', 'error']) {
    assert.ok(field in entry, `事件缺必备字段 ${field}`);
  }
  assert.equal(entry.capability, 'tts');
  assert.equal(entry.provider, 'edge');
  assert.equal(entry.units, '记账测试'.length);
  assert.equal(entry.costEstimate, 0);
  assert.equal(entry.ok, true);
});
