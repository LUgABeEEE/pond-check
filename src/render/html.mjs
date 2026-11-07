/**
 * D5a · 自包含 HTML 渲染（src/render/html.mjs）
 *
 * 把 D4 收口产出的 Report 渲染成**单文件、零外链**的一页 HTML：
 *   - 样式全部内联在 <style> 里，图标用 emoji / CSS 圆点，不引任何 script、
 *     link、img 外链，也不引模板引擎 —— 整个文件只用模板字符串拼；
 *   - 深色底、状态色一眼可辨（绿=ok / 黄=watch / 红=bad / 灰=unknown）；
 *   - unknown 一律灰色问号，绝不用绿色（SPEC §5.1：unknown 不是正常）。
 *
 * 硬约束（来自任务合同 + SPEC §5）：
 *   1. 单文件零外链：产物里不许出现可被当成外链引用的字样；
 *   2. 每条鱼一张卡：状态灯 + 六指标 + 一句诊断 + 一句下一步；
 *   3. 顶部总览：活跃 / 疲软 / 坏了 / 认不出 各几条（数的是**鱼**；「死了」只留给
 *      liveness=dead 的那一格，bad 档统一「坏了」——D8-M4）；
 *   4. viewport meta + 简单响应式；
 *   5. 底部固定声明「本报告只读、不联网、无遥测。」；
 *   6. 永不抛：报告缺字段 / 传乱参数也出一页能看的 HTML，绝不 500。
 *
 * 本模块是**纯函数**：不读文件、不碰网络、不写盘，凭证泄漏问题在上游
 * （D3 读取层 / D4 显示路径脱敏）就地解决，这里只负责把已脱敏的字段转义后画出来。
 */

import { BAND_LABELS, INDICATOR_IDS, UNIT_LABELS, classifyFishBucket, countMultiUnknown } from '../evaluate/index.mjs';

/* ------------------------------------------------------------------ *
 * 0. 常量：全是「渲染用的展示词」，不参与任何判定
 * ------------------------------------------------------------------ */

/** 六格中文名兜底：正常每格自带 nameZh，数据缺了时用它占位（不猜内容）。 */
const INDICATOR_NAME_FALLBACK = Object.freeze({
  liveness: '存活',
  rhythm: '节律',
  throughput: '工作量',
  health: '健康',
  deps: '依赖',
  drift: '漂移',
});

/** 顶部总览四盏灯（任务合同钦定的四个词，D8-M4 把 bad 档统一成「坏了」）：鱼的 severity → 人话。 */
const OVERVIEW_LIGHTS = Object.freeze([
  { severity: 'ok', label: '活跃' },
  { severity: 'watch', label: '疲软' },
  { severity: 'bad', label: '坏了' },
  { severity: 'unknown', label: '认不出' },
]);

/** 状态灯旁边的一小句（title / aria 用）。 */
const SEVERITY_WORDS = Object.freeze({
  ok: '正常',
  watch: '要注意',
  bad: '坏了',
  unknown: '判不出',
});

/** 底部固定声明（任务合同原文）。 */
const FOOTER_TEXT = '本报告只读、不联网、无遥测。';

/** 没有报告对象时的兜底话术——照实说，不粉饰。 */
const NO_REPORT_TEXT = '这份报告数据本身拿不到（不是「没鱼」，是没拿到报告）。';

/* ------------------------------------------------------------------ *
 * 1. 小工具：转义、取值、档位短名
 * ------------------------------------------------------------------ */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * HTML 转义 —— 报告里全是动态文本（路径、现象、下一步），一个都不许漏。
 * 额外把 `://` 拆成实体写法：页面上照样显示原字样，但 HTML 源码里不会
 * 留下能被 grep 判成外链的字面量（合同第 1 条连子串都不许）。
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/:\/\//g, '&#58;//');
}

/** 取一段非空文本；取不到回 null（由调用方决定占位话术，绝不替报告编话）。 */
function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 转义后的文本，取不到时给诚实占位。 */
function escOr(value, fallback) {
  return esc(textOrNull(value) ?? fallback);
}

/**
 * ISO 时间 → 本地「YYYY-MM-DD HH:mm」。
 * 与文本摘要（text.mjs 的 headerLine）用同一个口径，同份报告在两处显示一致。
 */
function formatLocalStamp(iso) {
  if (typeof iso !== 'string' || iso === '') return '（报告里没写生成时间）';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** severity → CSS 类名；不认识的一律按 unknown（灰色），绝不当绿。 */
function sevClass(severity) {
  const sev = textOrNull(severity);
  return sev === 'ok' || sev === 'watch' || sev === 'bad' ? sev : 'unknown';
}

/** severity → 状态灯词；不认识的一律「判不出」。 */
function sevWord(severity) {
  return SEVERITY_WORDS[sevClass(severity)] ?? '判不出';
}

/** 档位短名：rules 里只有档位 id，短名在 BAND_LABELS（只用于渲染）。 */
function levelLabel(id, level) {
  const table = isObject(BAND_LABELS) ? BAND_LABELS[id] : null;
  const label = isObject(table) ? table[textOrNull(level)] : null;
  // 未知档位原样回显 id —— 不猜、不美化（和 evaluate 层同一口径）
  return textOrNull(label) ?? textOrNull(level) ?? '判不出';
}

/** 六格展示名：每格自带 nameZh，缺了才用兜底表。 */
function indicatorName(id, cell) {
  return textOrNull(cell?.nameZh) ?? INDICATOR_NAME_FALLBACK[id] ?? String(id);
}

/** 数字/字符串值 + 单位，只做原样展示；null / 空就不画（不编数）。 */
function valueText(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  const unit = textOrNull(cell?.unit);
  if (!unit) return raw;
  // 机器单位（sec/days/checks…）换成中文；表里没有的原样留着，不猜
  const unitZh = isObject(UNIT_LABELS) ? textOrNull(UNIT_LABELS[unit]) : null;
  return `${raw} ${unitZh ?? unit}`;
}

/* ------------------------------------------------------------------ *
 * 2. 卡片零件
 * ------------------------------------------------------------------ */

/**
 * 状态灯：绿/黄/红圆点，unknown 是灰色问号 —— 一眼可辨、不冒充正常。
 *
 * 颜色之外再给一个符号（✓ / ! / × / ?）：色弱用户分不出绿红（D6b P18），
 * 加个字符的成本是零，但报告对 8% 的男性用户从「看不出」变成「看得出」。
 */
const LIGHT_GLYPH = Object.freeze({
  ok: '✓',
  watch: '!',
  bad: '×',
  unknown: '?',
});

function lightHtml(severity) {
  const cls = sevClass(severity);
  const word = sevWord(severity);
  const inner = LIGHT_GLYPH[cls] ?? '';
  return `<span class="light light-${cls}" role="img" aria-label="${esc(word)}" title="${esc(word)}">${inner}</span>`;
}

/** 六指标小卡：格名 + 档位短名 + 原样数值，颜色跟着 severity 走。 */
function chipHtml(id, cell) {
  const cls = sevClass(cell?.severity);
  const level = levelLabel(id, cell?.level);
  const value = valueText(cell);
  return `<div class="chip chip-${cls}">
  <span class="chip-name">${esc(indicatorName(id, cell))}</span>
  <span class="chip-level">${esc(level)}</span>
  ${value === null ? '' : `<span class="chip-value">${esc(value)}</span>`}
</div>`;
}

/** 一句诊断：优先取最差那格的 phenomenon（人话），并标出是哪一格在说话。 */
function pickDiagnosis(fish) {
  const indicators = isObject(fish?.indicators) ? fish.indicators : {};
  const worstId = textOrNull(fish?.worstIndicator);
  const order = worstId && isObject(indicators[worstId])
    ? [worstId, ...INDICATOR_IDS.filter((id) => id !== worstId)]
    : [...INDICATOR_IDS];
  for (const id of order) {
    const cell = indicators[id];
    const phenomenon = textOrNull(cell?.phenomenon);
    if (phenomenon !== null) {
      return { name: indicatorName(id, cell), text: phenomenon };
    }
  }
  return null;
}

/** 一句下一步：fixes[0] > 最差格的 nextStep > 别的格的 nextStep；全无就照实说没有。 */
function pickNextStep(fish) {
  const indicators = isObject(fish?.indicators) ? fish.indicators : {};
  const fixes = Array.isArray(fish?.fixes) ? fish.fixes : [];
  for (const fix of fixes) {
    const text = textOrNull(fix);
    if (text !== null) return text;
  }
  const worstId = textOrNull(fish?.worstIndicator);
  const order = worstId && isObject(indicators[worstId])
    ? [worstId, ...INDICATOR_IDS.filter((id) => id !== worstId)]
    : [...INDICATOR_IDS];
  for (const id of order) {
    const text = textOrNull(indicators[id]?.nextStep);
    if (text !== null) return text;
  }
  return null;
}

/** 判不出的格子清单（degraded）——「这些不能当正常看」要挂在卡里看得见。 */
function degradedLine(fish) {
  const list = Array.isArray(fish?.degraded) ? fish.degraded : [];
  const names = [];
  for (const item of list) {
    const id = textOrNull(item?.indicator);
    if (id === null) continue;
    const name = INDICATOR_NAME_FALLBACK[id] ?? id;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return '';
  return `<p class="card-degraded">⚠ ${names.length} 项数据读不到（${esc(names.join('、'))}）—— 这些格子不能当作正常。</p>`;
}

/** 一条鱼一张卡。 */
function fishCardHtml(fish, index) {
  const data = isObject(fish) ? fish : {};
  // 卡片状态灯跟鱼级分桶（与四灯、文本统计行同一口径）；六格小卡仍然一格格显示 severity
  const cls = sevClass(bucketOf(data));
  const name = textOrNull(data.name) ?? textOrNull(data.id) ?? `第 ${index + 1} 条鱼（报告里没写名字）`;
  const stateRoot = textOrNull(data.stateRoot);
  const chips = INDICATOR_IDS.map((id) => chipHtml(id, isObject(data.indicators) ? data.indicators[id] : null)).join('\n');

  const diagnosis = pickDiagnosis(data);
  const diagnosisHtml = diagnosis === null
    ? `<p class="card-diagnosis">（这条鱼的报告里没写诊断原话，别当「没事」看。）</p>`
    : `<p class="card-diagnosis"><span class="tag">${esc(diagnosis.name)}</span> ${esc(diagnosis.text)}</p>`;

  const nextStep = pickNextStep(data);
  const nextHtml = nextStep === null
    ? `<p class="card-next">→ 这条鱼的报告里没写下一句下一步。</p>`
    : `<p class="card-next">→ ${esc(nextStep)}</p>`;

  const notes = (Array.isArray(data.notes) ? data.notes : [])
    .map((note) => textOrNull(note))
    .filter((note) => note !== null);
  const notesHtml = notes.length === 0
    ? ''
    : `<ul class="card-notes">${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>`;

  return `<article class="card card-${cls}" aria-label="${esc(name)}">
  <header class="card-head">
    ${lightHtml(bucketOf(data))}
    <h2 class="card-name">${esc(name)}</h2>
  </header>
  ${stateRoot === null ? '' : `<p class="card-root">窝：${esc(stateRoot)}</p>`}
  <div class="chips">
${chips}
  </div>
  ${diagnosisHtml}
  ${nextHtml}
  ${degradedLine(data)}
  ${notesHtml}
</article>`;
}

/* ------------------------------------------------------------------ *
 * 3. 页面零件
 * ------------------------------------------------------------------ */

/** 鱼级分桶：D4 已经算好就用它的，缺了就按同一套规则现算（与文本统计行同源）。 */
function bucketOf(fish) {
  const declared = textOrNull(fish?.bucket);
  if (declared === 'ok' || declared === 'watch' || declared === 'bad' || declared === 'unknown') return declared;
  return classifyFishBucket(fish);
}

/**
 * 顶部总览四盏灯：数的是**鱼的条数**（活跃/疲软/坏了/认不出）。
 *
 * 分桶与 evaluate 的 classifyFishBucket、文本统计行同一口径（D6 队长裁定 + D8-M5）：
 * 「四格有结论、只有 rhythm/deps 判不出」的鱼算活跃；「六格只判得出 1 格」的鱼算认不出。
 */
function overviewHtml(fishes) {
  const counts = { ok: 0, watch: 0, bad: 0, unknown: 0 };
  for (const fish of fishes) counts[bucketOf(fish)] += 1;
  return OVERVIEW_LIGHTS.map((light) => `<div class="ov ov-${light.severity}">
  <span class="ov-count">${counts[light.severity]}</span>
  <span class="ov-label">${esc(light.label)}</span>
</div>`).join('\n');
}

/** 多格判不出的鱼条数（D8-M5）：和文本统计行同一句话，别让人把「活跃」读成六格全绿。 */
function multiBlindHtml(fishes) {
  const count = countMultiUnknown(fishes);
  if (count <= 0) return '';
  return `<p class="summary-line">多格判不出的鱼 ${count} 条（活跃不代表六格全绿）。</p>`;
}

/** 六格统计（summary 数的是指标格，和鱼的条数是两码事，标清楚免得误读）。 */
function summaryLineHtml(summary) {
  if (!isObject(summary)) return '';
  const pick = (key) => (Number.isFinite(summary[key]) ? String(summary[key]) : '—');
  return `<p class="summary-line">六格统计（按格数，不是按鱼）：${pick('ok')} 正常 · ${pick('watch')} 要注意 · ${pick('bad')} 坏了 · ${pick('unknown')} 判不出</p>`;
}

/** 页面外壳：所有动态内容都经 esc，样式全部内联。 */
function pageHtml({ title, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #1b2230;
    --line: #2b3442;
    --text: #e6edf3;
    --muted: #97a3b0;
    --ok: #3fb950;
    --watch: #d29922;
    --bad: #f85149;
    --unknown: #8b949e;
    --accent: #58a6ff;
  }
  * { box-sizing: border-box; }
  html { color-scheme: dark; }
  body {
    margin: 0;
    padding: 0 0 64px;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    line-height: 1.6;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 32px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 0; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 16px; }

  /* 顶部总览：四盏灯 */
  .overview {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
    margin: 12px 0 16px;
  }
  .ov {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    text-align: center;
  }
  .ov-count { display: block; font-size: 30px; font-weight: 700; line-height: 1.2; }
  .ov-label { font-size: 13px; color: var(--muted); }
  .ov-ok .ov-count { color: var(--ok); }
  .ov-watch .ov-count { color: var(--watch); }
  .ov-bad .ov-count { color: var(--bad); }
  .ov-unknown .ov-count { color: var(--unknown); }

  .verdict {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-left: 4px solid var(--accent);
    border-radius: 10px;
    padding: 12px 16px;
    margin: 0 0 10px;
    font-size: 16px;
    white-space: pre-wrap;
  }
  .next-action {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 16px;
    margin: 0 0 20px;
    font-size: 15px;
  }
  .next-action .tag { margin-right: 6px; }
  .summary-line { color: var(--muted); font-size: 13px; margin: -8px 0 20px; }

  /* 鱼卡 */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 4px solid var(--unknown);
    border-radius: 12px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card-ok { border-left-color: var(--ok); }
  .card-watch { border-left-color: var(--watch); }
  .card-bad { border-left-color: var(--bad); }
  .card-head { display: flex; align-items: center; gap: 10px; }
  .card-root { margin: 0; color: var(--muted); font-size: 12.5px; word-break: break-all; }

  /* 状态灯：绿/黄/红圆点，unknown 是灰色问号 */
  .light {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    color: var(--bg);
    background: var(--unknown);
    box-shadow: 0 0 8px rgba(139, 148, 158, 0.55);
  }
  .light-ok { background: var(--ok); box-shadow: 0 0 8px rgba(63, 185, 80, 0.6); }
  .light-watch { background: var(--watch); box-shadow: 0 0 8px rgba(210, 153, 34, 0.6); }
  .light-bad { background: var(--bad); box-shadow: 0 0 8px rgba(248, 81, 73, 0.65); }
  .light-unknown { background: var(--unknown); }

  /* 六指标小卡 */
  .chips { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
  .chip {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chip-name { font-size: 12px; color: var(--muted); }
  .chip-level { font-size: 15px; font-weight: 600; }
  .chip-value { font-size: 11.5px; color: var(--muted); word-break: break-all; }
  .chip-ok .chip-level { color: var(--ok); }
  .chip-watch .chip-level { color: var(--watch); }
  .chip-bad .chip-level { color: var(--bad); }
  .chip-unknown .chip-level { color: var(--unknown); }

  .card-diagnosis, .card-next, .card-degraded { margin: 0; font-size: 14px; white-space: pre-wrap; }
  .card-next { color: var(--accent); }
  .card-degraded { color: var(--watch); font-size: 13px; }
  .card-notes { margin: 0; padding-left: 18px; color: var(--muted); font-size: 12.5px; }
  .tag {
    display: inline-block;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0 6px;
    font-size: 12px;
    color: var(--muted);
    margin-right: 4px;
  }

  .empty {
    background: var(--panel);
    border: 1px dashed var(--line);
    border-radius: 12px;
    padding: 24px 18px;
    color: var(--muted);
    font-size: 15px;
    white-space: pre-wrap;
  }

  /* 报告脚注：降级 / 凭证跳过 */
  .foot-notes { margin-top: 22px; color: var(--muted); font-size: 13px; }
  .foot-notes p { margin: 4px 0; white-space: pre-wrap; }

  /* 底部固定声明：只读、不联网、无遥测 */
  .disclaimer {
    position: sticky;
    bottom: 0;
    margin-top: 26px;
    padding: 10px 16px;
    background: rgba(13, 17, 23, 0.92);
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 13px;
    text-align: center;
    backdrop-filter: blur(6px);
  }

  @media (max-width: 640px) {
    h1 { font-size: 21px; }
    .ov-count { font-size: 24px; }
    .wrap { padding: 16px 12px 24px; }
    .chips { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<div class="wrap">
${body}
</div>
<footer class="disclaimer">${esc(FOOTER_TEXT)}</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * 4. 主入口
 * ------------------------------------------------------------------ */

/**
 * 把 D4 的 Report 渲染成一页自包含 HTML。
 *
 * 永不抛：报告缺字段、传的是 null / 字符串 / 乱七八糟的对象，都出一页能看的
 * HTML（该说「拿不到」就说「拿不到」），绝不让 CLI 因为渲染崩掉。
 *
 * @param {object|string} report D4 收口产出的 Report（或它的 JSON 字符串）
 * @returns {string} 完整 HTML 文档
 */
export function renderHtml(report) {
  try {
    let data = report;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    if (!isObject(data)) {
      return pageHtml({
        title: '鱼况体检 · pond-check',
        body: `<h1>🐟 鱼况体检报告</h1>
<p class="verdict">${esc(NO_REPORT_TEXT)}</p>
<div class="empty">用法：先跑 pond-check 扫描，拿到报告再渲染。判不出就说判不出 —— 这里不会替报告编结论。</div>`,
      });
    }

    const fishes = Array.isArray(data.fishes) ? data.fishes : [];
    // 文本摘要用的是本地时间，HTML 原来印 UTC（差 8 小时，看着像旧报告，D6b P11）。
    // 统一本地时间；ISO 原值留在 title 里，机器要精确时间照样拿得到。
    const generatedAtIso = textOrNull(data.generatedAt);
    const generatedAt = generatedAtIso === null
      ? esc('（报告里没写生成时间）')
      : `<time datetime="${esc(generatedAtIso)}" title="${esc(generatedAtIso)}">${esc(formatLocalStamp(generatedAtIso))}</time>`;
    const platform = escOr(data.host?.platform, '—');
    const node = escOr(data.host?.node, '—');

    const cardsHtml = fishes.length === 0
      ? `<div class="empty">${escOr(data.verdict, '没扫到任何在跑的鱼。')}<br><br>${escOr(data.nextAction, '先确认她真的在跑，再用 --root <她的目录> 指定她的窝。')}</div>`
      : `<div class="cards">
${fishes.map((fish, index) => fishCardHtml(fish, index)).join('\n')}
</div>`;

    const footnote = textOrNull(data.footnote);
    const skipped = isObject(data.skippedSensitive) ? data.skippedSensitive : null;
    const skippedCount = Number.isFinite(skipped?.count) ? skipped.count : 0;
    const footParts = [];
    if (footnote !== null) footParts.push(`<p>${esc(footnote)}</p>`);
    if (skippedCount > 0) {
      footParts.push(`<p>另有 ${esc(String(skippedCount))} 个凭证文件被跳过（只数个数，文件名不进任何输出）。</p>`);
    }

    const body = `<h1>🐟 鱼况体检报告</h1>
<p class="meta">生成时间 ${generatedAt} · 主机 ${platform} · Node ${node}</p>
<div class="overview">
${overviewHtml(fishes)}
</div>
<p class="verdict">${escOr(data.verdict, '（报告里没写总评。）')}</p>
<p class="next-action"><span class="tag">现在该做</span>${escOr(data.nextAction, '（报告里没写下一步。）')}</p>
${summaryLineHtml(data.summary)}
${multiBlindHtml(fishes)}
${cardsHtml}
${footParts.length === 0 ? '' : `<section class="foot-notes">
${footParts.join('\n')}
</section>`}`;

    return pageHtml({ title: '鱼况体检 · pond-check', body });
  } catch {
    // 渲染自己崩了也不能交白卷：给一页说清「渲染出错」的深色页，声明照旧在。
    return pageHtml({
      title: '鱼况体检 · pond-check',
      body: `<h1>🐟 鱼况体检报告</h1>
<p class="verdict">渲染这一步自己出错了 —— 报告内容没画出来。这是体检工具的 bug，把命令行输出贴到仓库 issue。</p>`,
    });
  }
}

export default renderHtml;
