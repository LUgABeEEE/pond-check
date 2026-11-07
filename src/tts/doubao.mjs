/**
 * pond-check · 能力层 C6：doubao TTS adapter（src/tts/doubao.mjs）
 *
 * 火山 Seed Audio（豆包语音合成）HTTP 一次性合成接口（规格 §4 的 `doubao`）：
 *   POST https://openspeech.bytedance.com/api/v1/tts
 *   Authorization: Bearer;${access_token}      ← 协议原样：Bearer 与 token 用分号分隔
 *   {
 *     "app":     { "appid", "token", "cluster": "volcano_tts" },
 *     "user":    { "uid" },
 *     "audio":   { "voice_type", "encoding", "speed_ratio", "emotion"? },
 *     "request": { "reqid": "<uuid>", "text", "operation": "query" }
 *   }
 *   响应：{ "code": 1000, "message", "data": "<base64 音频>" }（code≠1000 = 业务失败）
 *
 * 协议出处（离线对照，测试零联网）：火山引擎「豆包语音 · 大模型 HTTP 非流式接口 V1」
 * 文档（docs.volcengine.com/docs/doubao-voice/http-one-timecompositenon-streaming-interface-v1）。
 * 每段文本一次请求，`reqid` 每次必须唯一（UUID）；v1 不支持 2.0 bigtts 音色，
 * 音色 ID 走控制台的 voice_type（这里给一个常用映射表 + 原样透传）。
 *
 * 依赖与计费（规格 §4）：requires = network + appId/token；约 1 元/分钟 ⇒
 * cost = { unit: 'perMinute', value: 1 }，计量用**音频秒数**（perMinute 口径的
 * units 就是秒，registry 负责除以 60）。
 *
 * 硬约束：
 *   - appid / token 只进请求体与闭包；错误文本先脱敏，事件里永远没有密钥；
 *   - 没配 key：provider 标不可用、resolve 跳过，绝不 throw（变异点 M1 就在这条
 *     线上：把「跳过」改成「throw」，tests/cloud-adapters.test.mjs 必须变红）；
 *   - 不 import node:http/https/net/dns/tls；出网只走注入的 transport（默认 fetch）。
 */

import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';

import { assertCredentials, resolveCredentials } from '../shared/credentials.mjs';
import { concatAudio, audioDurationMs } from './segment.mjs';
import { cloudError, defaultCloudTransport, requestJson } from './cloud-http.mjs';

/** provider id（降级链 / 事件流里用它）。 */
export const DOUBAO_TTS_PROVIDER_ID = 'doubao';

/** 一次性合成接口路径（拼在 baseUrl 后）。 */
export const DOUBAO_TTS_PATH = '/api/v1/tts';

/** 默认端点与业务集群（文档默认值）。 */
export const DOUBAO_TTS_BASE_URL = 'https://openspeech.bytedance.com';
export const DOUBAO_TTS_DEFAULT_CLUSTER = 'volcano_tts';

/** 默认凭据环境变量名（「具体 key 名」）。 */
export const DOUBAO_TTS_APP_ID_ENV = 'POND_DOUBAO_TTS_APP_ID';
export const DOUBAO_TTS_TOKEN_ENV = 'POND_DOUBAO_TTS_TOKEN';

/** 缺省音色（火山文档示例音色）。 */
export const DOUBAO_TTS_DEFAULT_VOICE = 'zh_female_cancan_mars_bigtts';

/**
 * 逻辑音色名 → voice_type。没有列进来的 ID 原样透传（控制台上的任何 voice_type
 * 都能用）—— 只收录文档里出现过的，不臆造音色 ID。
 */
export const DOUBAO_TTS_VOICES = Object.freeze({
  cancan: { id: 'zh_female_cancan_mars_bigtts', name: '灿灿', gender: 'female', langs: ['zh-CN'] },
  zixin: { id: 'zh_male_shaonianzixin_moon_bigtts', name: '少年梓辛', gender: 'male', langs: ['zh-CN'] },
});

/** speed_ratio 的保守夹取范围（文档允许 0.5–2.0，超出会被服务端拒）。 */
export const DOUBAO_SPEED_RANGE = Object.freeze({ min: 0.5, max: 2.0 });

/** pond-check 的 format → 服务端 encoding（文档枚举）。 */
export const DOUBAO_ENCODINGS = Object.freeze({
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg_opus',
});

/** 逻辑音色解析：映射表里有就换全名，没有就原样透传。 */
export function resolveDoubaoVoice(voice) {
  if (typeof voice !== 'string' || voice.trim() === '') return DOUBAO_TTS_DEFAULT_VOICE;
  const key = voice.trim().toLowerCase();
  return DOUBAO_TTS_VOICES[key]?.id ?? voice.trim();
}

/** speed 夹取到文档范围（不悄悄吞掉非法值：非数字按 1.0 处理并夹取）。 */
export function clampSpeed(speed) {
  const value = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.min(DOUBAO_SPEED_RANGE.max, Math.max(DOUBAO_SPEED_RANGE.min, value));
}

/**
 * 组一次合成请求体（纯函数，测试直接钉协议形状）。
 *
 * @param {{text: string, voice?: string, speed?: number, emotion?: string, format?: string,
 *          appid: string, token: string, cluster?: string, reqid?: string}} input
 * @returns {object} 请求体对象
 */
export function buildDoubaoTtsRequest(input) {
  const body = {
    app: {
      appid: input.appid,
      token: input.token,
      cluster: input.cluster ?? DOUBAO_TTS_DEFAULT_CLUSTER,
    },
    user: { uid: 'pond-check' },
    audio: {
      voice_type: resolveDoubaoVoice(input.voice),
      encoding: DOUBAO_ENCODINGS[input.format] ?? DOUBAO_ENCODINGS.mp3,
      speed_ratio: clampSpeed(input.speed),
    },
    request: {
      reqid: input.reqid ?? randomUUID(),
      text: input.text,
      operation: 'query',
    },
  };
  // emotion 只有部分音色支持；不支持时由服务端忽略（规格 §4：不支持则忽略）。
  const emotion = typeof input.emotion === 'string' ? input.emotion.trim() : '';
  if (emotion !== '') body.audio.emotion = emotion;
  return body;
}

/**
 * 造 doubao TTS provider（登记进 registry，走 shared/call.mjs 统一调用）。
 *
 * @param {object} [options]
 * @param {(url: string, init?: object) => Promise<Response>} [options.transport] HTTP 传输层（测试注入）
 * @param {Record<string,string|undefined>} [options.env] 凭据所在环境
 * @param {string} [options.appId] / @param {string} [options.token] 显式凭据（优先于环境变量）
 * @param {string} [options.appIdEnv] / @param {string} [options.tokenEnv] 环境变量名覆盖
 * @param {string} [options.cluster] / @param {string} [options.baseUrl]
 * @param {number} [options.priority] / @param {object} [options.cost]
 * @returns {object} provider 描述（含 run()）
 */
export function createDoubaoTtsProvider(options = {}) {
  const transport = options.transport ?? defaultCloudTransport;
  const env = options.env ?? process.env;
  const appIdEnv = options.appIdEnv ?? DOUBAO_TTS_APP_ID_ENV;
  const tokenEnv = options.tokenEnv ?? DOUBAO_TTS_TOKEN_ENV;
  const baseUrl = String(options.baseUrl ?? DOUBAO_TTS_BASE_URL).replace(/\/+$/u, '');
  const cluster = options.cluster ?? DOUBAO_TTS_DEFAULT_CLUSTER;

  const credentials = resolveCredentials([
    { name: 'appid', envVar: appIdEnv, value: options.appId },
    { name: 'token', envVar: tokenEnv, value: options.token },
  ], env);
  const available = credentials.ok; // ← 变异点 M1：把这行换成「无 key 就 throw」必红
  const keyEnvs = [appIdEnv, tokenEnv];

  async function run(args, runCtx = {}) {
    // 防御纵深：正常路径 resolve 已经跳过了没 key 的 provider。
    assertCredentials(credentials, DOUBAO_TTS_PROVIDER_ID);

    const chunks = [];
    let totalMs = 0;
    let allExact = true;

    for (let index = 0; index < args.segments.length; index += 1) {
      const segment = args.segments[index];
      const body = buildDoubaoTtsRequest({
        text: segment,
        voice: args.voice,
        speed: args.speed,
        emotion: args.emotion,
        format: args.format,
        appid: credentials.values.appid,
        token: credentials.values.token,
        cluster,
      });

      const payload = await requestJson(
        transport,
        `${baseUrl}${DOUBAO_TTS_PATH}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // 协议原样：Bearer 与 token 之间是分号，不是空格。
            authorization: `Bearer;${credentials.values.token}`,
          },
          body: JSON.stringify(body),
        },
        {
          provider: DOUBAO_TTS_PROVIDER_ID,
          label: 'doubao TTS',
          redact: credentials.values.token,
          signal: runCtx.signal,
          timeoutMs: options.requestTimeoutMs ?? 25_000,
        },
      );

      if (payload?.code !== 1000) {
        // 业务失败（配了 key 但调用失败）：带 code 与服务端 message，与「没配 key」
        // 的 MissingKeyError 完全不同的文案与 code。
        throw cloudError(
          `doubao TTS 合成失败（code ${payload?.code ?? '?'}: ${payload?.message ?? '无 message'}）`,
          { provider: DOUBAO_TTS_PROVIDER_ID },
        );
      }
      const audio = Buffer.from(String(payload?.data ?? ''), 'base64');
      if (audio.length === 0) {
        throw cloudError(`doubao TTS 第 ${index + 1} 段返回了空音频`, {
          category: 'format', provider: DOUBAO_TTS_PROVIDER_ID,
        });
      }
      chunks.push(audio);

      // 服务端不回时长元数据：wav 可从头精算，其余按码率估算并标 estimated。
      const measured = audioDurationMs(audio, args.format);
      totalMs += measured.durationMs;
      if (measured.estimated) allExact = false;
    }

    const audio = concatAudio(chunks, args.format);
    await fsp.writeFile(args.outPath, audio);

    return {
      path: args.outPath,
      format: args.format,
      durationMs: Math.round(totalMs),
      estimated: !allExact,
      chars: args.text.length,
    };
  }

  return {
    id: DOUBAO_TTS_PROVIDER_ID,
    name: '豆包语音合成（火山 Seed Audio）',
    local: false,
    requires: ['network', 'apiKey'],
    // 规格 §4：约 1 元/分钟 ⇒ perMinute 口径，units = 音频秒数（统一层计量）。
    cost: options.cost ?? { unit: 'perMinute', value: 1 },
    caps: ['mp3', 'wav', 'ogg'],
    priority: options.priority ?? 15,
    voices: Object.entries(DOUBAO_TTS_VOICES).map(([logical, info]) => ({
      id: logical,
      name: info.name ?? logical,
      provider: DOUBAO_TTS_PROVIDER_ID,
      gender: info.gender ?? null,
      langs: info.langs ?? [],
    })),
    /** 「具体 key 名」：requires 只能写 network/apiKey/binary 标签，key 名声明在这。 */
    keyEnvs,
    checkAvailable: () => available,
    availableReason: available
      ? '需要能访问 openspeech.bytedance.com（按量计费，约 1 元/分钟）'
      : credentials.reason,
    run,
  };
}
