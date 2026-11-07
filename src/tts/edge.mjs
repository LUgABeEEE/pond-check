/**
 * pond-check · 能力层 C4：Edge TTS adapter（src/tts/edge.mjs）
 *
 * 微软 Edge 朗读接口：云端、免费、无需 key，音色最全（中英多语种神经嗓），
 * 是降级链的默认首选（CAPABILITIES-SPEC §4）。
 *
 * 结构上分两半：
 *   createEdgeProvider({ transport })  provider 描述 + run()（合成编排、分段拼接）
 *   createEdgeTransport(options)       真正说话的传输层（WebSocket + 令牌握手）
 *
 * **transport 是注入缝**：测试传假 transport（返回假音频字节、记录收到的文本），
 * 一条网络请求都不会发；生产不传就用默认的真实传输层。adapter 的其余逻辑
 * （分段逐段合成、拼接、时长、错误包装）在两种 transport 下走的是同一条路径。
 *
 * 真实传输层要点（协议逆自 Edge 浏览器扩展 / edge-tts 7.3.1）：
 *   - 握手 URL 带 TrustedClientToken + Sec-MS-GEC v2 令牌（edge-gec.mjs，已离线对照验证）；
 *   - 连上先发 speech.config（声明输出格式与边界事件），再发 Path:ssml 的 SSML；
 *   - 二进制帧是音频（前 2 字节头长度），文本帧 Path:audio.metadata 带精确时长
 *     （WordBoundary 的 offset+duration，100ns tick），Path:turn.end 结束一轮；
 *   - Node 的全局 WebSocket 不能带自定义请求头（Cookie/Origin），服务端若因此
 *     拒绝握手，transport 会抛网络类错误并由统一调用器降级到 command —— 不会
 *     把用户挂死，也不会假装成功。
 *
 * 硬约束：不 import node:http/https/net/dns/tls（守卫全域禁止）；fetch/WebSocket
 * 只用内置全局对象；错误一律带 category 供 call.mjs 分类降级。
 */

import fsp from 'node:fs/promises';

import { generateSecMsGec, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN } from './edge-gec.mjs';
import { concatAudio, audioDurationMs } from './segment.mjs';

/** Edge 朗读接口地址（consumer 版，免费无需 key）。 */
export const EDGE_ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

/** pond-check 的 format → 服务端 outputFormat。 */
export const EDGE_FORMATS = Object.freeze({
  mp3: 'audio-24khz-48kbitrate-mono-mp3',
  wav: 'riff-24khz-16bit-mono-pcm',
  ogg: 'ogg-24khz-16bit-mono-opus',
});

/** edge mp3 是 48kbps CBR —— 估算时长时用真实码率，不拿 128k 的通用假设。 */
export const EDGE_MP3_BYTES_PER_MS = 48 / 8;

/** 逻辑音色名 → Edge 具体音色 ID（用户说 'xiaoyi'，adapter 映射到全名）。 */
export const EDGE_VOICES = Object.freeze({
  xiaoxiao: { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', langs: ['zh-CN'] },
  xiaoyi: { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'female', langs: ['zh-CN'] },
  yunxi: { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'male', langs: ['zh-CN'] },
  yunjian: { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'male', langs: ['zh-CN'] },
  yunyang: { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', langs: ['zh-CN'] },
  yunxia: { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'male', langs: ['zh-CN'] },
  liaoxiaobei: { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（辽宁）', gender: 'female', langs: ['zh-CN'] },
  xiaomo: { id: 'zh-CN-XiaomoNeural', name: '晓墨', gender: 'female', langs: ['zh-CN'] },
  emma: { id: 'en-US-EmmaMultilingualNeural', name: 'Emma', gender: 'female', langs: ['en-US', 'zh-CN'] },
  andrew: { id: 'en-US-AndrewMultilingualNeural', name: 'Andrew', gender: 'male', langs: ['en-US', 'zh-CN'] },
});

/** 缺省音色（跟 Edge 朗读默认一致）。 */
export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/**
 * 逻辑音色名解析：映射表里有就换全名，没有就原样透传
 * （用户可以直接给 'zh-CN-YunxiNeural' 这样的服务端 ID）。
 * @param {string|undefined} voice
 * @returns {string}
 */
export function resolveEdgeVoice(voice) {
  if (typeof voice !== 'string' || voice.trim() === '') return EDGE_DEFAULT_VOICE;
  const key = voice.trim().toLowerCase();
  return EDGE_VOICES[key]?.id ?? voice.trim();
}

/** speed 1.0 → 服务端 rate 参数（'+0%'），允许 ±，硬夹在 [-50%, +100%]。 */
export function speedToRate(speed) {
  const value = typeof speed === 'number' && Number.isFinite(speed) && speed > 0 ? speed : 1;
  const percent = Math.max(-50, Math.min(100, Math.round((value - 1) * 100)));
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

/** XML 转义（& < >，属性值再补引号）。 */
function escapeXml(text, forAttribute = false) {
  let out = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (forAttribute) out = out.replace(/"/g, '&quot;');
  return out;
}

/**
 * 组 SSML（协议要求的骨架：speak > voice > prosody）。
 * emotion 不支持时由服务端忽略 —— 不做本地猜测（规格 §4：不支持则忽略）。
 */
export function buildSsml({ text, voice, rate, emotion }) {
  const inner = emotion && String(emotion).trim() !== ''
    ? `<mstts:express-as style="${escapeXml(String(emotion).trim(), true)}">${escapeXml(text)}</mstts:express-as>`
    : escapeXml(text);
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis'"
    + " xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='en-US'>"
    + `<voice name='${escapeXml(voice, true)}'>`
    + `<prosody pitch='+0Hz' rate='${escapeXml(rate, true)}' volume='+0%'>`
    + inner
    + '</prosody></voice></speak>';
}

/** JS 风格日期串（服务端按这个格式解析 X-Timestamp）。 */
function jsDateString(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value) => String(value).padStart(2, '0');
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    + ' GMT+0000 (Coordinated Universal Time)';
}

/** 无连字符的 UUID（协议的 ConnectionId / X-RequestId 格式）。 */
function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 网络类错误（直接给 category，call.mjs 就不用猜）。 */
function networkError(message, cause) {
  const error = new Error(`edge transport：${message}`);
  error.category = 'network';
  if (cause) error.cause = cause;
  return error;
}

/** 协议异常（服务端发了不该发的帧）—— 归格式类，不重试，直接降级。 */
function protocolError(message) {
  const error = new Error(`edge transport 协议异常：${message}`);
  error.category = 'format';
  return error;
}

/**
 * 真实传输层：连 Edge 朗读接口合成**一段**文本。
 *
 * @param {{WebSocketImpl?: Function, now?: () => Date}} [options] 测试注入缝
 * @returns {(request: {text: string, voice: string, rate: string, emotion?: string, format: string, signal?: AbortSignal}) =>
 *   Promise<{audio: Buffer, durationMs: number|null}>}
 */
export function createEdgeTransport(options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const now = options.now ?? (() => new Date());

  return async function edgeTransport(request) {
    if (typeof WebSocketImpl !== 'function') {
      throw networkError('当前 Node 运行时没有内置 WebSocket，无法连接 Edge 朗读接口');
    }
    const { text, voice, rate, emotion, format, signal } = request;
    const outputFormat = EDGE_FORMATS[format] ?? EDGE_FORMATS.mp3;

    const connectionId = connectId();
    const url = `${EDGE_ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
      + `&Sec-MS-GEC=${generateSecMsGec(now().getTime() / 1000)}`
      + `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
      + `&ConnectionId=${connectionId}`;

    return new Promise((resolve, reject) => {
      let settled = false;
      const audioChunks = [];
      let durationMs = null;

      let socket;
      try {
        socket = new WebSocketImpl(url);
      } catch (error) {
        reject(networkError(`连接失败：${error?.message ?? error}`, error));
        return;
      }
      socket.binaryType = 'arraybuffer';

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          socket.close();
        } catch {
          // 已经关了就关了。
        }
      };
      const onAbort = () => finish(reject, networkError('已取消'));

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      socket.addEventListener('open', () => {
        // 1) speech.config：声明输出格式与边界事件（照抄协议要求的两条消息）。
        socket.send(`X-Timestamp:${jsDateString(now())}\r\n`
          + 'Content-Type:application/json; charset=utf-8\r\n'
          + 'Path:speech.config\r\n\r\n'
          + '{"context":{"synthesis":{"audio":{"metadataoptions":{'
          + '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"'
          + '},"outputFormat":' + JSON.stringify(outputFormat) + '}}}}}\r\n');

        // 2) SSML 请求。
        const requestId = connectId();
        const ssml = buildSsml({ text, voice, rate, emotion });
        socket.send(`X-RequestId:${requestId}\r\n`
          + 'Content-Type:application/ssml+xml\r\n'
          + `X-Timestamp:${jsDateString(now())}Z\r\n` // 协议原样（服务端就吃这个怪格式）
          + 'Path:ssml\r\n\r\n'
          + ssml);
      });

      socket.addEventListener('message', (event) => {
        try {
          const payload = event.data;
          if (typeof payload === 'string') {
            const bytes = Buffer.from(payload, 'utf8');
            const splitAt = bytes.indexOf('\r\n\r\n');
            if (splitAt < 0) throw protocolError('文本帧缺分隔头');
            const head = bytes.subarray(0, splitAt).toString('utf8');
            const body = bytes.subarray(splitAt + 2).toString('utf8');
            const headPath = /^Path:(.*)$/m.exec(head)?.[1]?.trim();

            if (headPath === 'audio.metadata') {
              // WordBoundary 的 offset+duration 是 100ns tick，取最大值就是总时长。
              let parsed;
              try {
                parsed = JSON.parse(body);
              } catch (error) {
                throw protocolError(`audio.metadata 不是合法 JSON：${error?.message ?? error}`);
              }
              for (const meta of parsed?.Metadata ?? []) {
                if (meta?.Type === 'WordBoundary' || meta?.Type === 'SentenceBoundary') {
                  const endTicks = (meta?.Data?.Offset ?? 0) + (meta?.Data?.Duration ?? 0);
                  durationMs = Math.max(durationMs ?? 0, endTicks / 10_000);
                }
              }
            } else if (headPath === 'turn.end') {
              if (audioChunks.length === 0) {
                finish(reject, protocolError('一轮结束但没有任何音频（音色名/文本可能不对）'));
                return;
              }
              finish(resolve, {
                audio: stripStraySeparator(Buffer.concat(audioChunks), format),
                durationMs: durationMs === null ? null : Math.round(durationMs),
              });
            }
            // response / turn.start：协议内的占位帧，忽略。
            return;
          }

          // 二进制帧 = 音频：前 2 字节是头长度，其余是头 + 音频。
          const frame = Buffer.from(payload);
          if (frame.length < 2) throw protocolError('二进制帧太短');
          const headerLength = frame.readUInt16BE(0);
          if (headerLength > frame.length) throw protocolError('二进制帧头长度越界');
          const head = frame.subarray(0, headerLength).toString('utf8');
          if (!/^Path:audio\r/m.test(head)) throw protocolError('二进制帧不是音频路径');
          let body = frame.subarray(headerLength + 2);
          if (body.length === 0) return; // 流终止的空帧
          audioChunks.push(body);
        } catch (error) {
          finish(reject, error?.category ? error : protocolError(error?.message ?? error));
        }
      });

      socket.addEventListener('error', () => {
        finish(reject, networkError('WebSocket 握手或传输失败（服务端拒绝/网络不通）'));
      });
      socket.addEventListener('close', () => {
        finish(reject, networkError('连接在收到 turn.end 之前被关闭'));
      });
    });
  };
}

/**
 * 协议的 body 提取约定在「头长度」上有一处 ±2 的含糊：
 * 有的实现把分隔的 \r\n 带进 body。对 mp3 无害（播放器按同步字节重定位），
 * 对 wav 会把 RIFF 头顶掉 —— 这里只在「明显是分隔残留 + 明显是容器头」时剥掉，
 * 不做任何别的猜测。
 */
function stripStraySeparator(buffer, format) {
  if (buffer.length > 6 && buffer[0] === 0x0d && buffer[1] === 0x0a) {
    const magic = buffer.subarray(2, 6).toString('ascii');
    if ((format === 'wav' && magic === 'RIFF') || (format === 'ogg' && magic === 'OggS')) {
      return buffer.subarray(2);
    }
  }
  return buffer;
}

/**
 * 造 edge provider 描述（登记进 registry，走 shared/call.mjs 统一调用）。
 *
 * @param {{transport?: Function, voices?: object, priority?: number}} [options]
 * @returns {object} provider 描述（含 run()）
 */
export function createEdgeProvider(options = {}) {
  const transport = options.transport ?? createEdgeTransport();
  const voiceTable = options.voices ?? EDGE_VOICES;
  const priority = options.priority ?? 50;

  return {
    id: 'edge',
    name: 'Edge TTS',
    local: false,
    requires: ['network'],
    cost: { unit: 'perKChar', value: 0 }, // 免费：微软朗读接口不计费
    caps: ['mp3', 'wav', 'ogg'],
    priority,
    voices: Object.entries(voiceTable).map(([logical, info]) => ({
      id: logical,
      name: info.name ?? logical,
      provider: 'edge',
      gender: info.gender ?? null,
      langs: info.langs ?? [],
    })),
    // 网络可达性没法同步探测 —— 诚实地标「按需连接」，失败时靠降级链兜底。
    checkAvailable: () => true,
    availableReason: '云端免费，无需 key；需要能访问 speech.platform.bing.com',

    /**
     * @param {{text: string, segments: string[], voice?: string, emotion?: string, speed?: number, format: string, outPath: string}} args
     * @param {{signal?: AbortSignal}} ctx
     */
    async run(args, ctx = {}) {
      const voice = resolveEdgeVoice(args.voice);
      const rate = speedToRate(args.speed);

      const chunks = [];
      let totalMs = 0;
      let allExact = true;
      for (const segment of args.segments) {
        const result = await transport({
          text: segment,
          voice,
          rate,
          emotion: args.emotion,
          format: args.format,
          signal: ctx.signal,
        });
        const audio = Buffer.isBuffer(result?.audio) ? result.audio : Buffer.from(result?.audio ?? []);
        if (audio.length === 0) {
          const error = new Error(`edge provider：第 ${chunks.length + 1} 段合成结果是空音频`);
          error.category = 'format';
          throw error;
        }
        chunks.push(audio);

        if (Number.isFinite(result?.durationMs) && result.durationMs >= 0) {
          totalMs += result.durationMs;
        } else {
          // 没有元数据时长（假 transport / 服务端没给边界事件）→ wav 仍可从头精算，
          // 其余按真实码率估算（edge mp3 是 48kbps CBR）。
          const estimated = audioDurationMs(
            audio,
            args.format,
            args.format === 'mp3' ? { bytesPerSecond: EDGE_MP3_BYTES_PER_MS * 1000 } : {},
          );
          totalMs += estimated.durationMs;
          if (estimated.estimated) allExact = false;
        }
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
    },
  };
}
