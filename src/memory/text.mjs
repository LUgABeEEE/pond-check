/**
 * pond-check · 能力层 C2：记忆的文本地基（src/memory/text.mjs）
 *
 * 记忆层有三个「文本 → 数字」的问题，全在这一个文件里解决：
 *
 *   1. 去重相似度  —— trigram Jaccard（CAPABILITIES-SPEC §3.2 闸二指定的口径）
 *   2. FTS5 索引分词 —— CJK 二元切分（见下）
 *   3. 查询分词    —— 与索引同一套切分，保证「查得到」
 *
 * 为什么不能直接用 FTS5 默认分词：unicode61 把一整段连续汉字当成**一个** token。
 * 「主人住在杭州」整句是一个词，查「杭州」永远打不中——中文关键词召回会整体失灵。
 * 而 trigram 分词器要求查询至少 3 字，「香菜」「杭州」这种两字词（中文里最常见的
 * 形态）反而查不到。所以采用**索引侧 unigram+bigram、查询侧 bigram（单字词除外）**：
 *
 *   索引「主人住在杭州」→ 主 人 住 在 杭 州 主人 人住 住在 在杭 杭州
 *   查询「杭州」        → 杭州            （命中）
 *   查询「杭」          → 杭              （单字查询退化为 unigram，命中）
 *   查询「Edge TTS」    → edge tts        （拉丁词整词，大小写折叠）
 *
 * 查询侧只用 bigram（单字查询除外）是刻意的：unigram 查询（比如「在」）会命中
 * 大半个语料，BM25 会被稀释；bigram 已经足够表达「词」，又不需要词典。
 *
 * 硬约束：纯函数、不联网、不写盘、零依赖。
 * 注意红线守卫会扫这个文件——网络模块名与 fetch 调用形态不得出现（连注释里也不要
 * 用引号包着网络模块名）。
 */

/** FTS5 MATCH 单条查询最多使用多少个 token（防超长查询拖垮解析）。 */
export const MAX_QUERY_TOKENS = 64;

/** 相似度闸阈值（CAPABILITIES-SPEC §3.3 闸二：trigram Jaccard 0.75）。 */
export const SIMILARITY_THRESHOLD = 0.75;

/**
 * 归一化文本用于相似度比较：小写、去掉空白与标点，只留汉字/字母/数字。
 * 「主人住在杭州。」与「主人住在杭州」归一化后完全一致。
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForSimilarity(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Letter}\p{Number}]+/gu, '');
}

/**
 * 字符三元组集合。归一化后不足 3 字时整串当作一个 gram（否则短句会被算成
 * 0/0 = 0，「杭州」永远合并不了「杭州市」这种近邻）。
 * @param {string} normalized
 * @returns {Set<string>}
 */
export function trigramSet(normalized) {
  const text = String(normalized ?? '');
  const grams = new Set();
  if (text.length === 0) return grams;
  if (text.length < 3) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i + 3 <= text.length; i += 1) {
    grams.add(text.slice(i, i + 3));
  }
  return grams;
}

/**
 * trigram Jaccard 相似度：|A∩B| / |A∪B|，取值 0..1。
 * 两个空串不算相似（返回 0），避免空候选互相合并。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function trigramJaccard(a, b) {
  const setA = trigramSet(normalizeForSimilarity(a));
  const setB = trigramSet(normalizeForSimilarity(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 抽出「汉字连续段」与「拉丁词/数字」段；标点、空白、emoji 一律当分隔符。 */
function textRuns(text) {
  return String(text ?? '').match(/[\p{Script=Han}]+|[a-zA-Z0-9_]+/gu) ?? [];
}

const LATIN_RUN = /^[a-zA-Z0-9_]+$/u;

/**
 * 索引侧分词：CJK 段切成 unigram + bigram，拉丁/数字段整词（小写）。
 * 返回可直接进 FTS5 列的空格分隔串。
 * @param {unknown} text
 * @returns {string}
 */
export function segmentText(text) {
  const tokens = [];
  for (const run of textRuns(text)) {
    if (LATIN_RUN.test(run)) {
      tokens.push(run.toLowerCase());
      continue;
    }
    for (let i = 0; i < run.length; i += 1) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens.join(' ');
}

/**
 * 查询侧分词：CJK 段取 bigram（单字段取该字），拉丁/数字段整词（小写）。
 * 去重并保序，最多 MAX_QUERY_TOKENS 个。
 * @param {unknown} text
 * @returns {string[]}
 */
export function queryTokens(text) {
  const tokens = new Set();
  for (const run of textRuns(text)) {
    if (LATIN_RUN.test(run)) {
      tokens.add(run.toLowerCase());
      continue;
    }
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return [...tokens].slice(0, MAX_QUERY_TOKENS);
}

/**
 * 把 token 数组拼成 FTS5 MATCH 表达式（OR 语义：任一关键词命中即算命中，
 * 命中多少交给 BM25 排序）。每个 token 都整体引号包裹，用户查询里的
 * AND / OR / NEAR / 星号 / 冒号 这些运算符永远不会被解释成语法（防注入）。
 * @param {string[]} tokens
 * @returns {string|null} 空数组返回 null（调用方应跳过 MATCH）
 */
export function buildMatchExpr(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const parts = tokens
    .filter((token) => typeof token === 'string' && token.length > 0)
    .map((token) => `"${token.replace(/"/gu, '""')}"`);
  return parts.length === 0 ? null : `(${parts.join(' OR ')})`;
}
