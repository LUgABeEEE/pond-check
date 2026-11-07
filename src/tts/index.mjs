/**
 * pond-check · 能力层 C4：TTS 统一接口（src/tts/index.mjs）
 *
 * 一个口子说话，底下随便换嗓（CAPABILITIES-SPEC §4）：
 *
 *   await tts.speak(text, { voice, emotion, speed, format, outPath })
 *     → { path, durationMs, format, provider, estimated, degradedFrom, segments }
 *   tts.providers() → [{ id, name, voices, cost, local, available }]
 *   tts.voices()    → [{ id, name, provider, gender, langs }]
 *
 * 内置 adapter：
 *   edge     云（微软 Edge 朗读接口，免 key，音色最全）—— 默认首选
 *   command  本地（用户自带 CLI：piper / espeak / …，模板由配置给）—— 离线兜底
 *   doubao   云（火山 Seed Audio，appId/token，约 1 元/分钟）—— C6
 *   mimo     云（小米 MiMo，apiKey，按量）—— C6
 *
 * C6 的云 adapter 遵守「有 key 才需要」（规格 §7）：没配 key 时 provider 标
 * available:false、被 resolve 的可用性过滤**跳过**，不报错、不崩、不碰网络；
 * 配了 key 自动按 priority 进降级链（edge 50 → command 20 → doubao 15 → mimo 10，
 * 与规格 §4 的默认链一致）。
 *
 * 执行走 shared/call.mjs 的统一调用器：
 *   - 单次超时 30s（CAPABILITY_TIMEOUTS.tts）；
 *   - 降级链按 priority（edge 50 → command 20），失败自动换下一个，
 *     成功结果带 degradedFrom（= 链首 id）；
 *   - 每次尝试都记进 <POND_HOME>/events.jsonl（一次尝试一行）；
 *   - 全部失败抛 CapabilityError，message 里逐个 provider 写清「谁、什么错」。
 *
 * 长文本按标点自动分段（单段 ≤ 300 字），逐段合成后拼接 —— 分段在统一层做，
 * 所有 adapter 共享同一条不变量（segment.mjs，join('') 还原原文）。
 *
 * 测试接缝（都走 createTts 的注入参数）：
 *   transport  edge 的传输层（假 transport ⇒ 测试零联网）
 *   runner     command 的执行器（假 runner ⇒ 不依赖真装了 piper）
 *   registry / now / sleep / warn / env / eventsPath / recordEvents / timeoutMs
 *
 * 硬约束：
 *   - 不 import 诊断层任何代码；状态只落 <POND_HOME> 与调用方指定的 outPath；
 *   - 记忆/文本内容不外发（edge 是把待合成文本发给微软的朗读接口 —— 这是
 *     TTS 的物理性质，已在文档里写明；其余数据一个字节都不出网）；
 *   - 编程错误（空文本、非法 format）抛 TypeError，不伪装成能力失败。
 */

import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';

import { createRegistry } from '../shared/registry.mjs';
import { invoke, timeoutFor, CapabilityError, CAPABILITY_TIMEOUTS } from '../shared/call.mjs';

import {
  createEdgeProvider,
  createEdgeTransport,
  EDGE_VOICES,
  EDGE_FORMATS,
} from './edge.mjs';
import {
  createCommandProvider,
  tokenizeCommand,
  fillTemplate,
  binaryAvailable,
} from './command.mjs';
import { createDoubaoTtsProvider } from './doubao.mjs';
import { createMimoTtsProvider } from './mimo.mjs';
import {
  segmentText,
  concatAudio,
  audioDurationMs,
  textDurationMs,
  wavDurationMs,
  parseWav,
  SEGMENT_MAX_CHARS,
} from './segment.mjs';
import { generateSecMsGec, tokenHash, SEC_MS_GEC_VERSION } from './edge-gec.mjs';

/** speak() 支持的输出格式。 */
export const TTS_FORMATS = Object.freeze(['mp3', 'wav', 'ogg']);

/** 逻辑音色的缺省解析：不传 voice 时 edge 用它。 */
export const DEFAULT_VOICE = 'xiaoxiao';

function assertText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('speak: text 必填（非空字符串）');
  }
}

function assertFormat(format) {
  if (!TTS_FORMATS.includes(format)) {
    throw new TypeError(`speak: format 必须是 ${TTS_FORMATS.join(' / ')} 之一，收到 ${JSON.stringify(format)}`);
  }
}

function assertSpeed(speed) {
  if (speed === undefined || speed === null) return;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    throw new TypeError('speak: speed 必须是大于 0 的有限数字');
  }
}

/**
 * 计量口径跟随 provider 的 `cost.unit`（registry 的语义）：
 *   perSecond / perMinute ⇒ units = 音频秒数（这两个口径就该按秒计量；
 *     doubao 约 1 元/分钟，事件里的 costEstimate 才算得对）；
 *   其余（perChar / perKChar / perCall）⇒ 沿用 C4 的字符数口径。
 * 时长拿不到时返回 0（宁可少记，不把字符数冒充秒数）。
 */
function measureTtsUnits(provider, value, chars) {
  const unit = provider?.cost?.unit;
  if (unit === 'perSecond' || unit === 'perMinute') {
    const ms = Number.isFinite(value?.durationMs) && value.durationMs > 0 ? value.durationMs : 0;
    return ms / 1000;
  }
  return chars;
}

/** 未配置 command 时的占位描述：providers() 里如实标注「不可用 + 为什么」。 */
function unconfiguredCommandProvider() {
  return {
    id: 'command',
    name: '本地命令（未配置）',
    local: true,
    requires: ['binary'],
    cost: { unit: 'perCall', value: 0 },
    caps: [],
    priority: 20,
    voices: [],
    checkAvailable: () => false,
    availableReason: '未配置 command 模板（createTts({ command }) 里给命令后启用）',
    async run() {
      // 真被调到就是编程错误：降级链的 predicate 会先把它过滤掉。
      throw new TypeError('command provider 未配置命令模板');
    },
  };
}

/**
 * 造一个 TTS 实例（测试用注入依赖；生产用默认导出的单例）。
 *
 * @param {object} [options]
 * @param {object[]} [options.providers] 整链自定义（测试/高级场景，跳过内置 adapter）
 * @param {Function} [options.transport] edge 的传输层（默认真实 WebSocket）
 * @param {object} [options.command] command adapter 配置（见 command.mjs）
 * @param {object} [options.registry] 自带注册表实例
 * @param {number} [options.timeoutMs] 覆盖单次超时（测试提速用）
 * @param {() => number} [options.now] / @param {(ms:number)=>Promise<void>} [options.sleep]
 * @param {Record<string,string|undefined>} [options.env] / @param {string} [options.eventsPath]
 * @param {(msg:string)=>void} [options.warn] / @param {boolean} [options.recordEvents]
 * @returns {{speak: Function, providers: Function, voices: Function, registry: object}}
 */
export function createTts(options = {}) {
  const registry = options.registry ?? createRegistry();
  const hooks = {
    now: options.now,
    sleep: options.sleep,
    warn: options.warn,
    env: options.env,
    eventsPath: options.eventsPath,
    recordEvents: options.recordEvents,
    timeoutMs: options.timeoutMs,
    backoffMs: options.backoffMs,
    maxRetries: options.maxRetries,
  };

  if (Array.isArray(options.providers)) {
    for (const provider of options.providers) registry.register('tts', provider);
  } else {
    registry.register('tts', createEdgeProvider({
      transport: options.transport ?? (options.edge?.transport),
      voices: options.edge?.voices,
      priority: options.edge?.priority,
    }));
    if (options.command) {
      registry.register('tts', createCommandProvider(options.command));
    } else {
      registry.register('tts', unconfiguredCommandProvider());
    }
    // C6 云 adapter：始终登记（providers() 里如实可见），没配 key 时
    // checkAvailable()=false，resolve 的可用性过滤会把它们跳过 —— 不报错不崩。
    registry.register('tts', createDoubaoTtsProvider({
      ...(options.doubao ?? {}),
      env: options.env ?? process.env,
    }));
    registry.register('tts', createMimoTtsProvider({
      ...(options.mimo ?? {}),
      env: options.env ?? process.env,
    }));
  }

  const isAvailable = (provider) => {
    if (typeof provider.checkAvailable !== 'function') return true;
    try {
      return provider.checkAvailable() === true;
    } catch {
      return false;
    }
  };

  /**
   * 合成一段文本。
   *
   * @param {string} text
   * @param {object} [speakOptions]
   * @param {string} [speakOptions.voice] 逻辑音色名（由 adapter 映射）
   * @param {string} [speakOptions.emotion] 不支持的 adapter 直接忽略
   * @param {number} [speakOptions.speed] 倍速，缺省 1.0
   * @param {'mp3'|'wav'|'ogg'} [speakOptions.format] 缺省 mp3
   * @param {string} [speakOptions.outPath] 不传则写临时文件（调用方自己清理）
   * @param {number} [speakOptions.timeoutMs] 覆盖本次超时
   * @returns {Promise<{path: string, durationMs: number, format: string, provider: string,
   *                    estimated: boolean, degradedFrom: string|null, segments: number}>}
   * @throws {CapabilityError} 全部 provider 失败（message 含每个 provider 的原因）
   */
  async function speak(text, speakOptions = {}) {
    assertText(text);
    const format = speakOptions.format ?? 'mp3';
    assertFormat(format);
    assertSpeed(speakOptions.speed);
    if (speakOptions.voice !== undefined && typeof speakOptions.voice !== 'string') {
      throw new TypeError('speak: voice 必须是字符串');
    }
    if (speakOptions.outPath !== undefined && (typeof speakOptions.outPath !== 'string' || speakOptions.outPath === '')) {
      throw new TypeError('speak: outPath 必须是非空字符串');
    }

    const segments = segmentText(text, SEGMENT_MAX_CHARS);
    const outPath = speakOptions.outPath
      ?? path.join(os.tmpdir(), `pond-tts-${randomUUID().slice(0, 8)}.${format}`);
    await fsp.mkdir(path.dirname(outPath), { recursive: true });

    const chain = registry.resolve('tts', { predicate: isAvailable });

    const envelope = await invoke({
      capability: 'tts',
      providers: chain,
      args: {
        text,
        segments,
        voice: speakOptions.voice ?? DEFAULT_VOICE,
        emotion: speakOptions.emotion,
        speed: speakOptions.speed ?? 1,
        format,
        outPath,
      },
      units: ({ value, provider }) => measureTtsUnits(provider, value, text.length),
      ...hooks,
      ...(speakOptions.timeoutMs !== undefined ? { timeoutMs: speakOptions.timeoutMs } : {}),
    });

    const value = envelope.value ?? {};
    return {
      path: value.path ?? outPath,
      durationMs: Math.round(value.durationMs ?? 0),
      format,
      provider: envelope.provider,
      estimated: value.estimated === true,
      degradedFrom: envelope.degradedFrom ?? null,
      segments: segments.length,
    };
  }

  /** provider 清单（available 当场探测）。 */
  function providers() {
    return registry.list('tts').map((provider) => {
      const available = isAvailable(provider);
      return {
        id: provider.id,
        name: provider.name,
        voices: provider.voices ?? [],
        cost: { unit: provider.cost?.unit ?? 'perCall', value: provider.cost?.value ?? 0 },
        local: provider.local === true,
        available,
        availableReason: available ? (provider.availableReason ?? null) : (provider.availableReason ?? '不可用'),
      };
    });
  }

  /** 全部逻辑音色（跨 provider）。 */
  function voices() {
    const out = [];
    for (const provider of registry.list('tts')) {
      for (const voice of provider.voices ?? []) out.push({ ...voice, provider: provider.id });
    }
    return out;
  }

  return { speak, providers, voices, registry };
}

/* ------------------------------------------------------------------ *
 * 进程级默认实例（edge 真实传输层 + 未配置的 command 兜底）
 * ------------------------------------------------------------------ */

const defaultTts = createTts();

/** 合成语音（默认实例）。 */
export function speak(text, speakOptions) {
  return defaultTts.speak(text, speakOptions);
}

/** provider 清单（默认实例）。 */
export function providers() {
  return defaultTts.providers();
}

/** 音色清单（默认实例）。 */
export function voices() {
  return defaultTts.voices();
}

/** 默认实例的注册表（要自定义降级链时用）。 */
export const registry = defaultTts.registry;

/* ------------------------------------------------------------------ *
 * 复用导出：分段 / 拼接 / 时长 / 令牌 —— 测试与上层都从一个口子拿
 * ------------------------------------------------------------------ */

export {
  createEdgeProvider,
  createEdgeTransport,
  EDGE_VOICES,
  EDGE_FORMATS,
  createCommandProvider,
  tokenizeCommand,
  fillTemplate,
  binaryAvailable,
  createDoubaoTtsProvider,
  createMimoTtsProvider,
  segmentText,
  concatAudio,
  audioDurationMs,
  textDurationMs,
  wavDurationMs,
  parseWav,
  generateSecMsGec,
  tokenHash,
  SEC_MS_GEC_VERSION,
  SEGMENT_MAX_CHARS,
  CAPABILITY_TIMEOUTS,
  timeoutFor,
  CapabilityError,
};
