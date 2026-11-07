/**
 * pond-check · 能力层 C4：Edge TTS 的 Sec-MS-GEC v2 令牌（src/tts/edge-gec.mjs）
 *
 * 微软 Edge 朗读接口要求 URL 上带 `Sec-MS-GEC` 令牌，算法是「魔改 SHA-256 + CS64」
 * 的组合摘要（edge-tts 项目逆向自 Edge 浏览器扩展）。这里做**逐语句忠实移植**：
 *
 *   ticks = (unix 秒 + 11644473600) 向下取整到 300 秒 → ×1e7（100ns tick）
 *   salt  = "<ticks><TRUSTED_CLIENT_TOKEN>"（ASCII）
 *   token = "<CS64 摘要 16 hex>-<SHA-256 摘要 64 hex>"（全大写）
 *
 * 移植自 edge-tts 7.3.1（GPL-3.0）的 `edge_tts/drm.py`：
 *   generate_sec_ms_gec_v2 / _token_hash / _sha256_digest / _sha256_init
 *   / _sha256_rounds / _expand_sha256_schedule / _cs64_digest
 * 正确性用 Python 原实现做离线对照（见 tests/tts.test.mjs 的固定向量用例），
 * 向量由 drm.generate_sec_ms_gec_v2 / drm._token_hash 生成，**不联网**。
 *
 * 与 Python 的差异只有一处写法：Python 用 `e * 0x100000001` 在 64 位里同时保留
 * 两份 e 来偷 ROTR，JS 这里直接写 rotr()（低 32 位逐位等价）；乘法一律 Math.imul
 * （Python 侧最终都 & 0xFFFFFFFF，只有低 32 位有意义）。
 *
 * 硬约束：纯函数、不联网、不写盘、零依赖。
 */

/** Edge 朗读接口的固定客户端令牌（公开常量，来自 Edge 浏览器扩展）。 */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/** 令牌请求里要带的版本号（随 Edge 大版本走）。 */
export const SEC_MS_GEC_VERSION = '2-143.0.3650.75';

/** Windows 文件时间纪元（1601-01-01）到 Unix 纪元的秒数。 */
const WIN_EPOCH = 11644473600;

/** 令牌时间戳按 5 分钟对齐（服务端允许的时钟粒度）。 */
const TICK_ROUND_SECONDS = 300;

const U32 = 0xFFFFFFFF;

/** 32 位无符号归一。 */
function u32(value) {
  return value >>> 0;
}

/** 32 位循环右移。 */
function rotr(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** 32 位循环左移。 */
function rol16(value) {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

/** SHA-256 小 σ0（ROTR7 ^ ROTR18 ^ SHR3）。 */
function sigma0(value) {
  return ((value >>> 7) ^ (value << 25) ^ (value >>> 18) ^ (value << 14) ^ (value >>> 3)) >>> 0;
}

/** SHA-256 小 σ1（ROTR17 ^ ROTR19 ^ SHR10）。 */
function sigma1(value) {
  return ((value >>> 17) ^ (value << 15) ^ (value >>> 19) ^ (value << 13) ^ (value >>> 10)) >>> 0;
}

/* ------------------------------------------------------------------ *
 * 常量表（与 drm.py 逐字对应）
 * ------------------------------------------------------------------ */

/** SHA-256 初始向量（FIPS 180-4 标准值）。 */
const SHA256_INITIAL = Object.freeze([
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
]);

/** 令牌摘要用的固定中间状态（非标准，drm.py 自带）。 */
const SHA256_STATE = Object.freeze([
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
]);

/** 首块调度表前 14 个词（非标准，drm.py 自带）。 */
const SHA256_SCHEDULE = Object.freeze([
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564,
]);

/** 标准 SHA-256 轮常量（FIPS 180-4）。 */
const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
]);

/** 魔改点 1：第 14 轮常量被换成这个值（仅首块生效）。 */
const SHA256_ADJUSTMENT = 0xC9DC06A7;

/** 首块专用轮常量 = 标准表但 [14] 被替换。 */
const SHA256_BLOCK_CONSTANTS = Object.freeze(
  SHA256_ROUND_CONSTANTS.map((value, index) => (index === 14 ? SHA256_ADJUSTMENT : value)),
);

/** 魔改点 2/3：首块调度展开时对 σ0/σ1 的异或扰动。 */
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;

/** CS64 混合器的 14 组系数（coefficient, offset）。 */
const CS64_COEFFICIENTS = Object.freeze([
  [0xE82E91B1, 0xB32700D0],
  [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5],
  [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6],
  [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3],
  [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1],
  [0xCB49E3C6, 0xC5626167],
]);
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xF2F90B1A;
const CS64_ADJUSTMENT1 = 0x0B1A0000;

/* ------------------------------------------------------------------ *
 * 调度展开与压缩（_expand_sha256_schedule / _sha256_rounds）
 * ------------------------------------------------------------------ */

/** 把 words 原地展开到 64 词（标准 SHA-256 调度递推）。 */
function expandSchedule(words, firstWord) {
  for (let index = firstWord; index < 64; index += 1) {
    const x = words[index - 2];
    const y = words[index - 15];
    const value = (sigma1(x) + words[index - 7] + sigma0(y) + words[index - 16]) >>> 0;
    words.push(value);
  }
}

/**
 * SHA-256 压缩 64 轮，可从 firstRound 轮接着跑。
 * Python 版把 8 轮一组做了「寄存器改名」展开优化；那只是写法优化，
 * 数学就是标准 64 轮压缩，这里直接按标准轮写（正确性由 Python 对照向量钉死）。
 */
function sha256Rounds(state, words, firstRound) {
  let [a, b, c, d, e, f, g, h] = state;
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;

  for (let index = firstRound; index < 64; index += 1) {
    const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (g ^ (e & (f ^ g))) >>> 0;
    const t1 = h + bigSigma1 + ch + constants[index] + words[index];
    const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = ((a & b) | (c & (a | b))) >>> 0;
    const t2 = bigSigma0 + maj;

    h = g;
    g = f;
    f = e;
    e = u32(d + t1);
    d = c;
    c = b;
    b = a;
    a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

/** 32 位大端读。 */
function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** 32 位小端读。 */
function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * 首块初始化（_sha256_init）：头 7 字节喂进一个「半块」，
 * 调度词 16..29 用带扰动的 σ 递推、第 30 词带常量调整，然后从第 14 轮起压缩。
 */
function sha256Init(data) {
  const words = new Array(16).fill(0);
  words[14] = (data[0] << 16 | data[1] << 8 | data[2]) >>> 0;
  words[15] = readU32BE(data, 3);

  for (let index = 16; index < 30; index += 1) {
    let value = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) {
      const adjusted = index === 16
        ? (sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0
        : sigma1(words[index - 2]);
      value += adjusted;
    }
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) {
      const adjusted = index === 29
        ? (sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0
        : sigma0(words[index - 15]);
      value += adjusted;
    }
    words.push(u32(value));
  }
  words.push(u32(
    sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14]
    + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14],
  ));
  expandSchedule(words, 31);

  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((value, index) => u32(value + working[index]));
}

/**
 * 令牌摘要的 SHA-256（_sha256_digest）：魔改 padding（长度按 57+len 记账），
 * 首块走 sha256Init，后续块走标准压缩。
 * @param {Uint8Array} data 至少 7 字节
 * @returns {Uint8Array} 32 字节摘要
 */
function sha256Digest(data) {
  if (data.length < 7) throw new RangeError('Token salt must contain at least seven bytes');
  const length = 57 + data.length;
  const padZeros = (((55 - length) % 64) + 64) % 64;

  const tail = new Uint8Array(data.length - 7 + 1 + padZeros + 8);
  tail.set(data.subarray(7), 0);
  tail[data.length - 7] = 0x80;
  const bitLength = length * 8;
  const view = new DataView(tail.buffer);
  view.setBigUint64(tail.length - 8, BigInt(bitLength), false);

  let state = sha256Init(data);
  for (let offset = 0; offset < tail.length; offset += 64) {
    const words = new Array(16);
    for (let i = 0; i < 16; i += 1) words[i] = readU32BE(tail, offset + i * 4);
    expandSchedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((value, index) => u32(value + working[index]));
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, state[i], false);
  return out;
}

/** 把字节切成小端 u32 词，零填充到 4 的倍数，词数为奇再补一个 0（_words_le4_even）。 */
function wordsLe4Even(data) {
  const pad = (4 - (data.length % 4)) % 4;
  const padded = new Uint8Array(data.length + pad);
  padded.set(data, 0);
  const words = [];
  for (let offset = 0; offset < padded.length; offset += 4) words.push(readU32LE(padded, offset));
  if (words.length % 2 === 1) words.push(0);
  return words;
}

/**
 * CS64 混合摘要（_cs64_digest）：以 SHA-256 摘要头两词为密钥的自定义累加器。
 * 所有乘法用 Math.imul —— Python 侧最终都 & 0xFFFFFFFF，只有低 32 位有意义。
 * @returns {[number, number]} 两个 32 位词
 */
function cs64Digest(data, digest) {
  const keyA = readU32LE(digest, 0) | 1;
  const keyB = readU32LE(digest, 4) | 1;
  const factors = [
    Math.imul(keyA, CS64_FACTOR) >>> 0,
    Math.imul(keyB, CS64_FACTOR) >>> 0,
  ];

  const terms = CS64_COEFFICIENTS.map(([coefficient], index) => Math.imul(coefficient, factors[index % 2]) >>> 0);
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);

  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  const dataWords = wordsLe4Even(prefixed);
  for (let index = 0; index < dataWords.length; index += 1) {
    const word = dataWords[index];
    const key = index % 2 === 0 ? keyA : keyB;
    let term = Math.imul(word, key) >>> 0;
    let offset = Math.imul(rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB) >>> 0;
    if (index === 0) {
      term = (term + Math.imul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let t = rol16((offsets[index] + x) >>> 0);
    let q = Math.imul(t, 0x76F50F34) >>> 0;
    swapAcc = (swapAcc + (Math.imul(rol16(q), 0xC3EFEA97) + q >>> 0)) >>> 0;

    t = rol16((offsets[index + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881CE3C) >>> 0;
    swapLast = (Math.imul(rol16(q), 0x35BD1EC9) + q >>> 0) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (Math.imul(state, keyA) + x) >>> 0;
    state = Math.imul(rol16(state), 0xCF98B111) >>> 0;
    state = Math.imul(rol16(state), 0x87085B9F) >>> 0;
    state = Math.imul(rol16(state), 0x12CEB96D) >>> 0;
    state = Math.imul(rol16(state), 0x257E1D83) >>> 0;
    acc = (acc + state) >>> 0;

    t = (Math.imul(state, keyB) + y) >>> 0;
    t = Math.imul(rol16(t), 0xA27416F5) >>> 0;
    t = Math.imul(rol16(t), 0xD38396FF) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t), 0x7C932B89) >>> 0), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }

  return [u32(swapLast ^ state), u32(swapAcc ^ acc)];
}

/**
 * 令牌双摘要（_token_hash）。
 * @param {Uint8Array} data ASCII 字节（ticks + 客户端令牌）
 * @returns {{ cs64: string, sha256: string }} 全大写 hex
 */
export function tokenHash(data) {
  const digest = sha256Digest(data);
  const [word0, word1] = cs64Digest(data, digest);

  let cs64 = '';
  for (const word of [word0, word1]) {
    // 小端打包（struct.pack('<II', ...)）后转大写 hex。
    cs64 += word.toString(16).padStart(8, '0').match(/../g).reverse().join('');
  }
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { cs64: cs64.toUpperCase(), sha256: sha256.toUpperCase() };
}

/**
 * 生成 Sec-MS-GEC v2 令牌（generate_sec_ms_gec_v2）。
 * @param {number} [unixTimestamp] Unix 秒（缺省当前时间）
 * @returns {string} "<16 hex>-<64 hex>"（全大写）
 */
export function generateSecMsGec(unixTimestamp) {
  const seconds = typeof unixTimestamp === 'number' && Number.isFinite(unixTimestamp)
    ? unixTimestamp
    : Date.now() / 1000;

  let ticks = seconds + WIN_EPOCH;
  ticks -= ticks % TICK_ROUND_SECONDS;
  ticks *= 1e7; // S_TO_NS / 100：换算成 100ns tick

  const salt = `${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`;
  const { cs64, sha256 } = tokenHash(new TextEncoder().encode(salt));
  return `${cs64}-${sha256}`;
}
