/**
 * pond-check · 能力层 C2：沉淀三道闸（src/memory/gates.mjs）
 *
 * CAPABILITIES-SPEC §3.3：写入必须过三闸，缺一不可，remember() 不接受直接落库。
 *
 *   闸一 · 候选抽取   只接受 fact / preference / episode 三类之一，抽不出就不记
 *   闸二 · 去重合并   trigram Jaccard ≥ 0.75 视为同一件事 → 替换而不是新增
 *                    （保 id、更新 content 与 updated_at、importance 取 max）
 *   闸三 · 重要性     1–5 分；1 分（猜测性内容）默认不记，除非 force
 *
 * `force: true` 只跳过闸二（以及闸三的「默认不记」），跳过会被记进事件流——
 * 用户可以强制写入，但不能悄悄强制。
 *
 * 闸一的抽取是**尽力而为的启发式**：显式给 kind 最可靠；不给 kind 时按句子形态猜
 * （明确好恶 → preference；强时间标记 → episode；其余成句 → fact；语气词/过短 → 不记）。
 * 猜不出来就宁可不记——沉淀闸的全部意义就是「宁缺勿滥」。
 *
 * 硬约束：纯函数、不联网、不写盘、零依赖。
 */

import { isKind, DEFAULT_IMPORTANCE, DEFAULT_CONFIDENCE, MIN_IMPORTANCE, MAX_IMPORTANCE } from './schema.mjs';
import { SIMILARITY_THRESHOLD, trigramJaccard } from './text.mjs';

/** 强时间标记：带时间的经历算 episode（SPEC §3.1）。 */
const EPISODE_MARKERS = /昨天|今天|上午|中午|下午|晚上|前天|上周|下周|这周|上个月|下个月|刚才|去年|前年|礼拜|周[一二三四五六日天]|\d{1,2}\s*月\s*\d{1,2}\s*日|\d+\/\d+|一起|那次|当时/u;

/** 明确的好恶表达算 preference（SPEC §3.1：态度倾向）。 */
const PREFERENCE_MARKERS = /喜欢|讨厌|不喜欢|不爱|最爱|偏好|喜好|烦|恶心|想要|不想要|prefer|love|hate/iu;

/** 纯语气/寒暄：抽不出任何类别，不记。 */
const FILLER = /^(?:嗯+|哦+|噢+|啊+|哎+|唉+|哈+|嘿+|呵+|呃+|额+|好的?|好哒|好呀|好啊|行吧|可以|得了|算了|ok(?:ay)?|yes|no|嗯好的?|谢谢|感谢|辛苦|哈哈哈?|嘿嘿|嘻嘻|呜呜|。。。|[?？!！。、，,~～])+$/u;

/** 猜测性内容（importance 1：默认不记）。 */
const SPECULATIVE_MARKERS = /可能|也许|大概|猜|说不定|估计|似乎|好像|貌似|应该吧|兴许|未必/u;

/** 明确要求记住 / 身份、健康、重要日期（importance 5）。 */
const MUST_REMEMBER_MARKERS = /记住|记一下|记下来|别忘|不要忘|一定要记|必须记|备忘|remind me|must remember/iu;
const IDENTITY_HEALTH_DATE_MARKERS = /身份|身份证|生日|健康|生病|过敏|住院|手术|病史|用药|结婚|纪念日|重要日期|忌日|病假/u;

/**
 * 闸一 · 候选抽取：这句话属于三类中的哪一类？抽不出返回 null（不记）。
 *
 * 显式 kind 直接收编（先于启发式）；「强时间标记」先于好恶标记——
 * 「昨天开始讨厌香菜」是带时间的经历（episode），不是稳定态度。
 *
 * @param {unknown} content 记忆正文
 * @param {string|null} [explicitKind] 调用方显式给的 kind
 * @returns {'fact'|'preference'|'episode'|null}
 */
export function classifyKind(content, explicitKind = null) {
  if (explicitKind != null) return isKind(explicitKind) ? explicitKind : null;
  const text = String(content ?? '').trim();
  if (text === '') return null;
  if (FILLER.test(text)) return null;
  if (EPISODE_MARKERS.test(text)) return 'episode';
  if (PREFERENCE_MARKERS.test(text)) return 'preference';
  // 成句的稳定陈述按 fact 收；太短的碎片抽不出语义，不记
  if (text.replace(/\s+/gu, '').length >= 4) return 'fact';
  return null;
}

/**
 * 闸三 · 重要性评分（CAPABILITIES-SPEC §3.3 的表格）：
 *
 *   5  用户明确说「记住」/ 身份、健康、重要日期
 *   4  明确的好恶表达、反复出现的话题（preference 类默认 4）
 *   3  一般事实（默认）
 *   2  一次性的闲聊细节（episode 类默认 2）
 *   1  猜测性内容（默认不记，除非 force）
 *
 * 显式 importance 优先于启发式（用户说了算）。启发式按上表从上往下第一个命中。
 * @param {{content: string, kind: string, importance?: number}} candidate
 * @returns {number} 1..5
 */
export function scoreImportance(candidate) {
  const explicit = candidate?.importance;
  if (explicit !== undefined && explicit !== null) return explicit; // 归一化阶段已校验
  const text = String(candidate?.content ?? '');
  if (MUST_REMEMBER_MARKERS.test(text) || IDENTITY_HEALTH_DATE_MARKERS.test(text)) return 5;
  if (SPECULATIVE_MARKERS.test(text)) return 1;
  if (candidate?.kind === 'preference' || PREFERENCE_MARKERS.test(text)) return 4;
  if (candidate?.kind === 'episode') return 2;
  return DEFAULT_IMPORTANCE;
}

/**
 * 闸二 · 去重：在既有记忆（同 kind、未归档）里找最相似的一条。
 * @param {object[]} rows 既有记忆行
 * @param {string} content 候选正文
 * @param {string} kind
 * @returns {{row: object, similarity: number}|null} 相似度 ≥ 阈值才返回
 */
export function findSimilarRow(rows, content, kind) {
  let best = null;
  for (const row of rows ?? []) {
    if (row.kind !== kind) continue;
    const similarity = trigramJaccard(row.content, content);
    if (similarity < SIMILARITY_THRESHOLD) continue;
    if (best === null || similarity > best.similarity) best = { row, similarity };
  }
  return best;
}

/**
 * 归一化候选（编程错误直接抛 TypeError，不伪装成「能力不可用」）。
 * @param {object|string} raw
 * @returns {{content: string, kind: string|null, entities: string[], importance: number|null,
 *            confidence: number, valence: number|null, arousal: number|null,
 *            source: string|null, sourceRef: string|null,
 *            ttlDays: number|null, force: boolean}}
 */
export function normalizeCandidate(raw) {
  const candidate = typeof raw === 'string' ? { content: raw } : raw;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('remember 候选必须是字符串或对象');
  }
  const content = typeof candidate.content === 'string' ? candidate.content.trim() : '';
  if (content === '') throw new TypeError('remember 候选的 content 必须是非空字符串');

  const kind = candidate.kind ?? null;
  if (kind !== null && !isKind(kind)) {
    throw new TypeError(`remember 候选的 kind 只能是 fact / preference / episode，收到 ${JSON.stringify(kind)}`);
  }

  let entities = [];
  if (candidate.entities !== undefined && candidate.entities !== null) {
    if (!Array.isArray(candidate.entities) || candidate.entities.some((item) => typeof item !== 'string')) {
      throw new TypeError('remember 候选的 entities 必须是字符串数组');
    }
    entities = [...candidate.entities];
  }

  let importance = null;
  if (candidate.importance !== undefined && candidate.importance !== null) {
    const value = candidate.importance;
    if (!Number.isInteger(value) || value < MIN_IMPORTANCE || value > MAX_IMPORTANCE) {
      throw new TypeError(`remember 候选的 importance 必须是 ${MIN_IMPORTANCE}..${MAX_IMPORTANCE} 的整数，收到 ${JSON.stringify(value)}`);
    }
    importance = value;
  }

  let confidence = DEFAULT_CONFIDENCE;
  if (candidate.confidence !== undefined && candidate.confidence !== null) {
    const value = candidate.confidence;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`remember 候选的 confidence 必须是 0..1 的数，收到 ${JSON.stringify(value)}`);
    }
    confidence = value;
  }

  let ttlDays = null;
  if (candidate.ttlDays !== undefined && candidate.ttlDays !== null) {
    const value = candidate.ttlDays;
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`remember 候选的 ttlDays 必须是正整数，收到 ${JSON.stringify(value)}`);
    }
    ttlDays = value;
  }

  // 情感坐标（Russell 二维）：**只存不算分**。校验收在写入口，
  // 越界是编程错误（TypeError），不伪装成「能力不可用」。
  let valence = null;
  if (candidate.valence !== undefined && candidate.valence !== null) {
    const value = candidate.valence;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
      throw new TypeError(`remember 候选的 valence 必须是 -1..1 的数，收到 ${JSON.stringify(value)}`);
    }
    valence = value;
  }

  let arousal = null;
  if (candidate.arousal !== undefined && candidate.arousal !== null) {
    const value = candidate.arousal;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`remember 候选的 arousal 必须是 0..1 的数，收到 ${JSON.stringify(value)}`);
    }
    arousal = value;
  }

  return {
    content,
    kind,
    entities,
    importance,
    confidence,
    valence,
    arousal,
    source: typeof candidate.source === 'string' && candidate.source !== '' ? candidate.source : null,
    sourceRef: typeof candidate.sourceRef === 'string' && candidate.sourceRef !== '' ? candidate.sourceRef : null,
    ttlDays,
    force: candidate.force === true,
  };
}
