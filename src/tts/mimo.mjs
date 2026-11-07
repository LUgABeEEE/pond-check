/**
 * pond-check · 能力层 C6：mimo TTS adapter（src/tts/mimo.mjs）
 *
 * 小米 MiMo 语音合成（规格 §4 的 `mimo`）—— OpenAI 兼容的 chat/completions 形态：
 *   POST https://api.xiaomimimo.com/v1/chat/completions
 *   api-key: ${MIMO_API_KEY}                    ← 文档的两种认证之一（另一种是 Bearer）
 *   {
 *     "model": "mimo-v2.5-tts",
 *     "messages": [
 *       { "role": "user",      "content": "<风格描述>" },   // 可选：emotion 映射到这里
 *       { "role": "assistant", "content": "<要合成的文本>" }  // 必选：合成内容
 *     ],
 *     "audio": { "format": "mp3|wav", "voice": "mimo_default" }
 *   }
 *   响应：choices[0].message.audio.data = base64 音频
 *
 * 协议出处（离线对照，测试零联网）：mimo.mi.com/docs/zh-CN/api/audio/tts
 * （语音合成 MiMo-TTS 系列 · OpenAI API 兼容，2026-07 更新）。
 *
 * 文档边界（照实处理，不发明参数）：
 *   - 音色是预置的：mimo_default / 冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean；
 *   - 音频格式只接受 pcm / pcm16 / wav / mp3 —— ogg 请求判 format 错误并降级；
 *   - 文档没有语速参数：speed 按「不支持则忽略」处理（规格 §4 同 emotion 的规则）；
 *   - emotion 映射为 user 消息里的风格描述（文档的风格控制就是走这条消息）。
 *
 * 依赖与计费（规格 §4）：requires = network + apiKey；「按量」计费、单价以小米
 * 控制台为准 ⇒ cost = { unit: 'perKChar', value: 0 }（配置 cost.value 后记账即按
 * 千字符口径算），不臆造价格。
 *
 * 硬约束：key 只进请求头与闭包，错误文本脱敏；没配 key 标不可用被 resolve 跳过
 * （变异点 M1）；不 import 网络模块，出网只走注入的 transport。
 */

import fsp from 'node:fs/promises';

import { assertCredentials, resolveCredentials } from '../shared/credentials.mjs';
import { concatAudio, audioDurationMs } from './segment.mjs';
import { cloudError, defaultCloudTransport, requestJson } from './cloud-http.mjs';

/** provider id。 */
export const MIMO_TTS_PROVIDER_ID = 'mimo';

/** 合成接口路径（拼在 baseUrl 后）。 */
export const MIMO_TTS_PATH = '/v1/chat/completions';

/** 默认端点与模型。 */
export const MIMO_TTS_BASE_URL = 'https://api.xiaomimimo.com';
export const MIMO_TTS_DEFAULT_MODEL = 'mimo-v2.5-tts';

/** 默认凭据环境变量名（文档叫 $MIMO_API_KEY）。 */
export const MIMO_TTS_API_KEY_ENV = 'POND_MIMO_API_KEY';

/** 缺省音色。 */
export const MIMO_TTS_DEFAULT_VOICE = 'mimo_default';

/** 预置音色（文档枚举，ID 原样使用）。 */
export const MIMO_TTS_VOICES = Object.freeze({
  mimo_default: { id: 'mimo_default', name: 'MiMo 默认', gender: null, langs: ['zh-CN'] },
  bingtang: { id: '冰糖', name: '冰糖', gender: null, langs: ['zh-CN'] },
  molihua: { id: '茉莉', name: '茉莉', gender: null, langs: ['zh-CN'] },
  suda: { id: '苏打', name: '苏打', gender: null, langs: ['zh-CN'] },
  baihua: { id: '白桦', name: '白桦', gender: null, langs: ['zh-CN'] },
  mia: { id: 'Mia', name: 'Mia', gender: null, langs: ['zh-CN'] },
  chloe: { id: 'Chloe', name: 'Chloe', gender: null, langs: ['zh-CN'] },
  milo: { id: 'Milo', name: 'Milo', gender: null, langs: ['zh-CN'] },
  dean: { id: 'Dean', name: 'Dean', gender: null, langs: ['en-US'] },
});

/** pond-check 的 format → 服务端 audio.format（文档枚举里没有 ogg）。 */
export const MIMO_FORMATS = Object.freeze({
  mp3: 'mp3',
  wav: 'wav',
});

/** 逻辑音色解析：映射表里有就换 ID，没有就原样透传。 */
export function resolveMimoVoice(voice) {
  if (typeof voice !== 'string' || voice.trim() === '') return MIMO_TTS_DEFAULT_VOICE;
  const key = voice.trim().toLowerCase();
  return MIMO_TTS_VOICES[key]?.id ?? voice.trim();
}

/**
 * 组一次合成请求体（纯函数，测试直接钉协议形状）。
 *
 * @param {{text: string, voice?: string, emotion?: string, format?: string,
 *          model?: string}} input
 * @returns {object} 请求体对象
 */
export function buildMimoRequest(input) {
  const format = MIMO_FORMATS[input.format];
  if (!format) {
    // 文档只接受 pcm / pcm16 / wav / mp3 —— ogg 不猜、不降格，判 format 错误。
    throw cloudError(
      `mimo 不支持 ${JSON.stringify(input.format)} 输出（服务端只接受 pcm / wav / mp3）`,
      { category: 'format', provider: MIMO_TTS_PROVIDER_ID },
    );
  }

  const messages = [];
  // emotion 映射成文档里的「风格描述」user 消息（不支持时服务端自然忽略）。
  const emotion = typeof input.emotion === 'string' ? input.emotion.trim() : '';
  if (emotion !== '') {
    messages.push({ role: 'user', content: `播报风格：${emotion}` });
  }
  // 文档：要合成音频必须有一条 role=assistant 的消息指定合成文本。
  messages.push({ role: 'assistant', content: input.text });

  return {
    model: input.model ?? MIMO_TTS_DEFAULT_MODEL,
    messages,
    audio: {
      format,
      voice: resolveMimoVoice(input.voice),
    },
  };
}

/**
 * 造 mimo TTS provider（登记进 registry，走 shared/call.mjs 统一调用）。
 *
 * @param {object} [options]
 * @param {(url: string, init?: object) => Promise<Response>} [options.transport] HTTP 传输层（测试注入）
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string} [options.apiKey] / @param {string} [options.apiKeyEnv]
 * @param {string} [options.model] / @param {string} [options.baseUrl]
 * @param {number} [options.priority] / @param {object} [options.cost]
 * @returns {object} provider 描述（含 run()）
 */
export function createMimoTtsProvider(options = {}) {
  const transport = options.transport ?? defaultCloudTransport;
  const env = options.env ?? process.env;
  const apiKeyEnv = options.apiKeyEnv ?? MIMO_TTS_API_KEY_ENV;
  const baseUrl = String(options.baseUrl ?? MIMO_TTS_BASE_URL).replace(/\/+$/u, '');
  const model = options.model ?? MIMO_TTS_DEFAULT_MODEL;

  const credentials = resolveCredentials([
    { name: 'apiKey', envVar: apiKeyEnv, value: options.apiKey },
  ], env);
  const available = credentials.ok; // ← 变异点 M1：把这行换成「无 key 就 throw」必红
  const keyEnvs = [apiKeyEnv];

  async function run(args, runCtx = {}) {
    // 防御纵深：正常路径 resolve 已经跳过了没 key 的 provider。
    assertCredentials(credentials, MIMO_TTS_PROVIDER_ID);

    const chunks = [];
    let totalMs = 0;
    let allExact = true;

    for (let index = 0; index < args.segments.length; index += 1) {
      const segment = args.segments[index];
      const body = buildMimoRequest({
        text: segment,
        voice: args.voice,
        emotion: args.emotion,
        format: args.format,
        model,
      });

      const payload = await requestJson(
        transport,
        `${baseUrl}${MIMO_TTS_PATH}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'api-key': credentials.values.apiKey,
          },
          body: JSON.stringify(body),
        },
        {
          provider: MIMO_TTS_PROVIDER_ID,
          label: 'mimo TTS',
          redact: credentials.values.apiKey,
          signal: runCtx.signal,
          timeoutMs: options.requestTimeoutMs ?? 25_000,
        },
      );

      const item = Array.isArray(payload?.choices) ? payload.choices[0] : null;
      const data = typeof item?.message?.audio?.data === 'string' ? item.message.audio.data : '';
      const audio = Buffer.from(data, 'base64');
      if (audio.length === 0) {
        // 响应不合格式（不是调用失败的网络问题）：归 format，不重试，降级。
        throw cloudError('mimo 响应里没有 choices[0].message.audio.data（或解出来是空音频）', {
          category: 'format', provider: MIMO_TTS_PROVIDER_ID,
        });
      }
      chunks.push(audio);

      // 文档响应没有时长：wav 可从头精算，其余按码率估算并标 estimated。
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
    id: MIMO_TTS_PROVIDER_ID,
    name: 'MiMo 语音合成（小米）',
    local: false,
    requires: ['network', 'apiKey'],
    // 「按量」计费，单价以小米控制台为准；配了 cost.value 就按 perKChar 记账。
    cost: options.cost ?? { unit: 'perKChar', value: 0 },
    caps: ['mp3', 'wav'],
    priority: options.priority ?? 10,
    voices: Object.entries(MIMO_TTS_VOICES).map(([logical, info]) => ({
      id: logical,
      name: info.name ?? logical,
      provider: MIMO_TTS_PROVIDER_ID,
      gender: info.gender ?? null,
      langs: info.langs ?? [],
    })),
    /** 「具体 key 名」。 */
    keyEnvs,
    checkAvailable: () => available,
    availableReason: available
      ? '需要能访问 api.xiaomimimo.com（按量计费，单价以小米控制台为准）'
      : credentials.reason,
    run,
  };
}
