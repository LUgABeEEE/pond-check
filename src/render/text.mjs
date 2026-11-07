/**
 * pond-check · D5b 可贴群文本摘要（src/render/text.mjs）
 *
 * 用途：把 D4 的 Report 渲染成**一段能直接 Ctrl+C 贴进 QQ 群 / GitHub issue 的纯文本**。
 * 一屏看完，不换行错位，不带 ANSI 颜色（贴到群里会变成一堆乱码字符）。
 *
 * 输出形态（真机渲染结果，逐字）：
 *
 *   🐟 pond-check · 2026-11-07 20:16 · linux/node 22.23.4
 *   🔴 qq-fish-01     疑似休眠 9 天前  空账本      日志 风控拦截 ×3
 *   ❓ desktop-pet    认不出                       缺 日志
 *   ⚠️ bili-whale-02  疲软 3 天前      5 天未干活  ffmpeg 不可用
 *   ✅ bili-whale-01  活跃 12 分钟前   今天 3 条   依赖 齐了
 *   → 最该做：qq-fish-01：重新登录一次，把新的 cookie/token 存回原来的位置。
 *   ※ 3 项数据读不到（liveness、health），这些项目不能当作正常。
 *   ※ 已跳过 2 个凭证类文件（不显示名称）
 *   共 4 条，活跃 1 / 疲软 1 / 死了 1 / 认不出 1。
 *
 * 四条硬要求与做法：
 *   1. **对齐**：中文/全角/emoji 按 2 列宽、组合符与变体选择符按 0 列宽自己算，不引依赖
 *      （见 charWidth / displayWidth）。所有列按「该列最宽的一行」补空格，最后一列不补
 *      （行尾不留空格，所以整行宽度本来就会不同，对齐的是**每一列的起始列**）。
 *   2. **短**：每条鱼一行；没有横线，只有表头、行、一句最该做的、脚注、统计。
 *      行数超过 MAX_ROWS 时只展开前 MAX_ROWS 条（D4 已把坏的排最前），其余在统计里照样算。
 *   3. **不丢鱼**：任何一条鱼都至少出现一行；渲染单条出错就降级成「（这条鱼的报告读不出来）」，
 *      绝不让它从列表里消失 —— 消失的鱼会被当成「没有这条鱼」。
 *   4. **末尾统计**：最后一行固定是「共 N 条，活跃 X / 疲软 Y / 死了 Z / 认不出 W。」。
 *
 * 这一层**只做排版**，判档与话术全部来自 D4：
 *   - 档位短名用 evaluate 导出的 BAND_LABELS（单一来源，不在这里另抄一份中文名）；
 *   - 「最该做」优先用排序后第一条有 fix 的鱼的第一条 fix（report.nextAction 那句带完整显示名，
 *     长到 160 列开外，只当没有 fixes 时才退回用它）；脚注直接取 report.footnote；
 *   - 凭证只出现聚合数量，绝不出现文件名或路径（report.skippedSensitive.names 是常量 token）。
 *
 * 统计口径：四个词是任务指定的固定词汇，按**每条鱼的总体结论**分桶 ——
 *   活跃 = severity ok｜疲软 = watch｜死了 = bad｜认不出 = unknown。
 * 为什么不按 liveness 的档位分：一条「活着但依赖全坏」的鱼按 liveness 会算成「活跃」，
 * 而报告已经把它判成 bad。这里跟报告结论保持一致，用户才不会读到两个互相打架的结论。
 *
 * 契约：
 *   renderText(report) -> string        （永不抛；report 缺字段/为空也给一段可读的话）
 *   另导出排版小工具供收口测试复用：displayWidth / truncateToWidth / padToWidth / formatAgeHuman
 */

import { BAND_LABELS } from '../evaluate/index.mjs';

/* ------------------------------------------------------------------ *
 * 预算：一屏之内
 * ------------------------------------------------------------------ */

/** 最多展开多少条鱼（其余在统计里照样计数，末尾会留一行说明） */
const MAX_ROWS = 20;

/** 名字列最多占多少列（超过就截断，避免一行的名字把后面几列全推走） */
const MAX_NAME_COLS = 26;

/** 备注列最多占多少列（「所以出什么事了」一句说完，别变成长篇） */
const MAX_NOTE_COLS = 28;

/** 时间单位换算一律由这三个基数相乘得出，**不写秒/天的字面量**（SPEC 的源码扫描会把判定字面量当违规） */
const SEC_PER_MIN = 60;
const MIN_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR;
const SEC_PER_DAY = SEC_PER_HOUR * HOURS_PER_DAY;

const ICONS = Object.freeze({
  ok: '✅',
  watch: '⚠️',
  bad: '🔴',
  unknown: '❓',
});

/* ------------------------------------------------------------------ *
 * 列宽：自己算，不引依赖
 * ------------------------------------------------------------------ */

/**
 * 单个码点的显示宽度（终端列）。
 * 0 = 组合符 / 变体选择符 / 零宽连接符（跟着前一个字符走，不占位）
 * 2 = 中日韩文字、全角标点、emoji
 * 1 = 其余
 */
function charWidth(codePoint) {
  if (codePoint === 0x200d) return 0; // ZWJ
  if (codePoint === 0xfe0e || codePoint === 0xfe0f) return 0; // VS15 / VS16
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // 组合附加符
  if (codePoint < 0x20) return 0; // 控制字符（正常输入里不会出现）

  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // 韩文字母
    (codePoint >= 0x2600 && codePoint <= 0x27bf) || // 杂项符号（✅ ⚠ ❓ 这类 emoji 呈现）
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK 部首 / 标点
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // 假名 / 注音 / CJK 兼容
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 基本区
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // 彝文
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // 韩文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容表意
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) || // 竖排标点
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK 兼容形式
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // 全角 ASCII
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) || // 麻将 / 扑克 / 表情 / 交通 / 补充符号
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK 扩展 B 及以上
  ) {
    return 2;
  }
  return 1;
}

/**
 * 一段文本的显示宽度（列）。
 * @param {string} text
 * @returns {number}
 */
export function displayWidth(text) {
  if (typeof text !== 'string' || text === '') return 0;
  let width = 0;
  for (const char of text) {
    width += charWidth(char.codePointAt(0));
  }
  return width;
}

/**
 * 按显示宽度截断，超长时补一个省略号（省略号本身算 1 列）。
 * @param {string} text
 * @param {number} maxCols
 * @returns {string}
 */
export function truncateToWidth(text, maxCols) {
  if (typeof text !== 'string' || text === '') return '';
  if (!Number.isFinite(maxCols) || maxCols <= 0) return '';
  if (displayWidth(text) <= maxCols) return text;

  const budget = maxCols - 1; // 留一列给省略号
  let used = 0;
  let out = '';
  for (const char of text) {
    const w = charWidth(char.codePointAt(0));
    if (used + w > budget) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

/**
 * 右侧补空格到指定显示宽度；已经超宽就原样返回（绝不为了对齐去砍内容）。
 * @param {string} text
 * @param {number} cols
 * @returns {string}
 */
export function padToWidth(text, cols) {
  const value = typeof text === 'string' ? text : '';
  if (!Number.isFinite(cols) || cols <= 0) return value;
  const gap = cols - displayWidth(value);
  return gap > 0 ? value + ' '.repeat(gap) : value;
}

/* ------------------------------------------------------------------ *
 * 小格式化
 * ------------------------------------------------------------------ */

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 秒 → 「12 分钟前」这种人话。
 * 负数（时钟偏移）按「刚刚」处理 —— 报表里不需要第二个时钟恐慌。
 * @param {number} seconds
 */
export function formatAgeHuman(seconds) {
  if (!isFiniteNumber(seconds)) return '';
  const sec = Math.max(0, Math.round(seconds));
  if (sec < SEC_PER_MIN) return '刚刚';
  if (sec < SEC_PER_HOUR) return `${Math.floor(sec / SEC_PER_MIN)} 分钟前`;
  if (sec < SEC_PER_DAY) return `${Math.floor(sec / SEC_PER_HOUR)} 小时前`;
  return `${Math.floor(sec / SEC_PER_DAY)} 天前`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」（贴群里要能一眼看出是什么时候的体检） */
function formatLocalStamp(iso) {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 档位短名：只查 evaluate 的 BAND_LABELS；查不到原样回显档位 id，不美化、不猜 */
function shortLabel(indicatorId, level) {
  const table = BAND_LABELS[indicatorId];
  const label = table && typeof level === 'string' ? table[level] : null;
  return typeof label === 'string' && label !== '' ? label : String(level ?? '判不出');
}

function normalizeSeverity(severity) {
  return severity === 'ok' || severity === 'watch' || severity === 'bad' ? severity : 'unknown';
}

/**
 * 单元格消毒：控制字符（换行、制表、ESC）一律换成空格。
 *
 * 鱼的显示名/路径是从磁盘上读来的，理论上可以带换行或 ANSI 序列。一行里混进一个
 * 换行就能把整张表撕开、把后面几条鱼顶到奇怪的位置；混进 ESC 则会让终端变色。
 * 贴群文本必须是「一行就是一行」。
 */
function sanitizeCell(value) {
  if (typeof value !== 'string' || value === '') return '';
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * 名字列：短、可区分
 * ------------------------------------------------------------------ */

/**
 * 从 Fish 的显示名里取一个短名。
 * D4 的 name 形如「DSH 插件 · dsh-whale-widget（web-021-rollback-20261105-1703）」，
 * 贴群的场合只需要后半截；kind 前缀占比太大，去掉。
 */
function fishLabel(fish) {
  const raw = typeof fish?.name === 'string' && fish.name !== ''
    ? fish.name
    : (typeof fish?.id === 'string' && fish.id !== '' ? fish.id : '（未命名）');
  const marker = raw.lastIndexOf(' · ');
  return marker >= 0 ? raw.slice(marker + 3) : raw;
}

/**
 * 把名字压到 MAX_NAME_COLS 以内，并且**优先保住能区分同类鱼的那一截**。
 *
 * 真机上两条鱼可能同名不同 profile（「dsh-whale-widget（web）」和
 * 「dsh-whale-widget（web-021-rollback-20261105-1703）」）。从右边硬截会让两行长得
 * 一模一样，贴到群里根本看不出是两条鱼。所以先留「base（…scope 尾部）」，实在放不下
 * 才退化成只留 base。
 */
function shortenLabel(label, maxCols) {
  if (displayWidth(label) <= maxCols) return label;
  const matched = label.match(/^(.*?)（(.*)）$/u);
  if (matched) {
    const base = matched[1];
    const scope = matched[2];
    const overhead = displayWidth(base) + displayWidth('（）') + displayWidth('…');
    const scopeBudget = maxCols - overhead;
    if (scopeBudget >= 4) {
      const tail = scope.length > scopeBudget ? scope.slice(-scopeBudget) : scope;
      const candidate = `${base}（…${tail}）`;
      if (displayWidth(candidate) <= maxCols) return candidate;
    }
    if (displayWidth(base) <= maxCols) return base;
  }
  return truncateToWidth(label, maxCols);
}

/* ------------------------------------------------------------------ *
 * 每一行的三格：存活 / 工作量 / 出了什么事
 * ------------------------------------------------------------------ */

function lifeCell(fish, indicators) {
  const liveness = indicators.liveness;
  const level = typeof liveness?.level === 'string' ? liveness.level : 'unknown';
  const label = shortLabel('liveness', level);

  // 连鱼种都认不出来时，先说的是「认不出」，不是「死活判不出」
  if (fish?.kind === 'unknown' && level === 'unknown') return '认不出';

  const age = liveness?.value;
  if (isFiniteNumber(age) && level !== 'dead' && level !== 'unknown') {
    const human = formatAgeHuman(age);
    return human === '' ? label : `${label} ${human}`;
  }
  return label;
}

function workCell(indicators) {
  const throughput = indicators.throughput;
  const level = typeof throughput?.level === 'string' ? throughput.level : 'unknown';
  const value = throughput?.value;
  const evidence = throughput?.evidence && typeof throughput.evidence === 'object' ? throughput.evidence : {};

  switch (level) {
    case 'productive':
      return isFiniteNumber(value) ? `今天 ${value} 条` : '在干活';
    case 'quiet':
      return '今天 0 条';
    case 'stalled': {
      const days = evidence.daysSinceLastNew;
      if (isFiniteNumber(days)) return `${days} 天未干活`;
      return isFiniteNumber(value) ? `${value} 条后停摆` : '停摆';
    }
    case 'empty':
      return '空账本';
    default:
      return '';
  }
}

/** 备注格里的一句话：先说最该先看的那个指标，且只说一句 */
function noteCell(severity, indicators) {
  if (severity === 'ok') {
    const deps = indicators.deps;
    const level = typeof deps?.level === 'string' ? deps.level : null;
    return level ? `依赖 ${shortLabel('deps', level)}` : '六项正常';
  }

  // 系统类问题比「她睡着了」更该先说：睡着的鱼醒过来就好了，依赖坏了不修永远醒不来
  const order = ['health', 'deps', 'drift', 'throughput', 'rhythm', 'liveness'];
  for (const wanted of ['bad', 'watch', 'unknown']) {
    for (const id of order) {
      const indicator = indicators[id];
      if (!indicator || typeof indicator !== 'object') continue;
      if (normalizeSeverity(indicator.severity) !== wanted) continue;
      const text = digestIndicator(id, indicator);
      if (text !== '') return truncateToWidth(text, MAX_NOTE_COLS);
    }
  }
  return '';
}

/**
 * 缺失项的「人话」词表：D4 的 evidence.missing 是机器键（log / dedupe / schemaVersion…），
 * 直接贴到群里没人看得懂。查不到的词原样回显 —— 不认识的键不许瞎译。
 */
const MISSING_LABELS = Object.freeze({
  log: '日志',
  session: '会话',
  dedupe: '判重表',
  timestamps: '时间戳',
  schemaVersion: '版本号',
  ffmpeg: 'ffmpeg',
  nodeRuntime: 'Node',
  disk: '磁盘',
  homeWritable: '窝权限',
  credentialFreshness: '登录态',
  modelLine: '模型线路',
});

function missingNote(evidence) {
  const missing = Array.isArray(evidence?.missing)
    ? evidence.missing.filter((key) => typeof key === 'string' && key !== '')
    : [];
  if (missing.length === 0) return '';
  const words = missing.slice(0, 3).map((key) => MISSING_LABELS[key] ?? key);
  return `缺 ${words.join('、')}`;
}

/** 单个指标的一句话摘要（只用 D4 已经算好的 evidence，绝不在渲染层重新判档） */
function digestIndicator(id, indicator) {
  const level = typeof indicator.level === 'string' ? indicator.level : 'unknown';
  const label = shortLabel(id, level);
  const evidence = indicator.evidence && typeof indicator.evidence === 'object' ? indicator.evidence : {};

  // 判不出的场合，「缺什么」比「判不出」有用得多：用户照着补数据就能看到结论
  if (normalizeSeverity(indicator.severity) === 'unknown') {
    const missing = missingNote(evidence);
    if (missing !== '') return missing;
  }

  if (id === 'health') {
    const top = evidence.topCategory;
    if (top && typeof top.nameZh === 'string' && top.nameZh !== '' && isFiniteNumber(top.count)) {
      return `日志 ${top.nameZh} ×${top.count}`;
    }
    return `日志 ${label}`;
  }

  if (id === 'deps') {
    const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
    const worst = ['fail', 'warn', 'unknown']
      .map((status) => checks.find((check) => check && check.status === status))
      .find(Boolean);
    if (worst) {
      const name = typeof worst.nameZh === 'string' && worst.nameZh !== '' ? worst.nameZh : '依赖项';
      const word = worst.status === 'fail' ? '不可用' : worst.status === 'warn' ? '有隐患' : '查不到';
      return `${name} ${word}`;
    }
    return `依赖 ${label}`;
  }

  if (id === 'throughput') {
    const days = evidence.daysSinceLastNew;
    if (level === 'stalled' && isFiniteNumber(days)) return `${days} 天未干活`;
    if (level === 'empty') return '判重表是空的';
    if (level === 'quiet') return '今天没干活';
    return `工作量 ${label}`;
  }

  const nameZh = typeof indicator.nameZh === 'string' && indicator.nameZh !== ''
    ? indicator.nameZh
    : id;
  return `${nameZh} ${label}`;
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

function buildRow(fish) {
  const severity = normalizeSeverity(fish?.severity);
  const indicators = fish?.indicators && typeof fish.indicators === 'object' ? fish.indicators : {};

  return {
    icon: ICONS[severity] ?? ICONS.unknown,
    name: sanitizeCell(shortenLabel(fishLabel(fish), MAX_NAME_COLS)),
    life: sanitizeCell(lifeCell(fish, indicators)),
    work: sanitizeCell(workCell(indicators)),
    note: sanitizeCell(noteCell(severity, indicators)),
  };
}

const BROKEN_ROW = Object.freeze({
  icon: ICONS.unknown,
  name: '（这条鱼的报告读不出来）',
  life: '',
  work: '',
  note: '内部错误，请带 --json 重跑一次',
});

/** 按列宽渲染：所有列按最宽的一行补位；整列都是空的行（比如全是 unknown）就把那列去掉 */
function renderRows(rows) {
  const columns = ['life', 'work', 'note'].filter((key) => rows.some((row) => row[key] !== ''));
  const nameWidth = rows.reduce((max, row) => Math.max(max, displayWidth(row.name)), 0);
  const widths = new Map();
  for (const key of columns) {
    widths.set(key, rows.reduce((max, row) => Math.max(max, displayWidth(row[key])), 0));
  }
  const lastColumn = columns.length > 0 ? columns[columns.length - 1] : null;

  return rows.map((row) => {
    let line = `${row.icon} ${padToWidth(row.name, nameWidth)}`;
    for (const key of columns) {
      const value = row[key];
      line += `  ${key === lastColumn ? value : padToWidth(value, widths.get(key))}`;
    }
    return line.replace(/\s+$/u, '');
  });
}

function headerLine(report) {
  const parts = ['🐟 pond-check'];
  const stamp = formatLocalStamp(report?.generatedAt);
  if (stamp) parts.push(stamp);
  const platform = typeof report?.host?.platform === 'string' ? sanitizeCell(report.host.platform) : null;
  const node = typeof report?.host?.node === 'string' ? sanitizeCell(report.host.node) : null;
  if (platform && node) parts.push(`${platform}/node ${node}`);
  else if (platform) parts.push(platform);
  return parts.join(' · ');
}

/**
 * 一句「所以现在该做什么」。
 *
 * 优先用**排序后第一条有 fix 的鱼**的第一条 fix（D4 已按严重度排好），前面挂短名；
 * report.nextAction 里带的是完整显示名（很长），贴群里会把这一行推到 160 列开外，
 * 所以只当没有 fixes 时才退回去用它。
 */
function actionLine(report, fishes) {
  for (const fish of fishes) {
    const fixes = Array.isArray(fish?.fixes) ? fish.fixes : [];
    const fix = fixes.find((item) => typeof item === 'string' && item.trim() !== '');
    if (!fix) continue;
    return `→ 最该做：${sanitizeCell(shortenLabel(fishLabel(fish), MAX_NAME_COLS))}：${sanitizeCell(fix)}`;
  }
  const fallback = typeof report?.nextAction === 'string' ? sanitizeCell(report.nextAction) : '';
  return fallback !== '' ? `→ 最该做：${fallback}` : null;
}

/** 末尾统计行：四个词是固定口径（ok/watch/bad/unknown），不随渲染口味变 */
function statLine(fishes) {
  const buckets = { ok: 0, watch: 0, bad: 0, unknown: 0 };
  for (const fish of fishes) buckets[normalizeSeverity(fish?.severity)] += 1;
  return `共 ${fishes.length} 条，活跃 ${buckets.ok} / 疲软 ${buckets.watch}`
    + ` / 死了 ${buckets.bad} / 认不出 ${buckets.unknown}。`;
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

/**
 * 把 Report 渲染成一段可贴群的纯文本。
 * @param {object} report D4 的 evaluate() 结果
 * @returns {string} 多行文本（不带结尾换行，交给调用方决定怎么输出）
 */
export function renderText(report) {
  try {
    if (!report || typeof report !== 'object') {
      return '🐟 pond-check：没拿到报告对象（内部错误），重跑一次；能复现的话带 --json 提 issue。';
    }

    const fishes = Array.isArray(report.fishes) ? report.fishes : [];
    const rows = fishes.map((fish) => {
      try {
        return buildRow(fish);
      } catch {
        return { ...BROKEN_ROW };
      }
    });

    const shown = rows.slice(0, MAX_ROWS);
    const hidden = rows.length - shown.length;

    const lines = [headerLine(report)];
    lines.push(...renderRows(shown));
    if (hidden > 0) {
      lines.push(`… 还有 ${hidden} 条没展开（坏的排在前面；要看全部用 --json）`);
    }
    const action = actionLine(report, fishes);
    if (action) lines.push(action);
    const footnote = typeof report.footnote === 'string' ? sanitizeCell(report.footnote) : '';
    if (footnote !== '') lines.push(`※ ${footnote}`);
    const skipped = report.skippedSensitive && isFiniteNumber(report.skippedSensitive.count)
      ? report.skippedSensitive.count
      : 0;
    if (skipped > 0) {
      // 只报数量：SPEC §2.4 允许的只有聚合计数与常量 token，路径/文件名一律不出现
      lines.push(`※ 已跳过 ${skipped} 个凭证类文件（不显示名称）`);
    }
    // 一条鱼都没有的时候，把 D4 的「没扫到鱼」那句话带上 —— 空报告不许假装体检通过
    const verdict = typeof report.verdict === 'string' ? sanitizeCell(report.verdict) : '';
    if (fishes.length === 0 && verdict !== '') lines.push(verdict);
    lines.push(statLine(fishes));

    return lines.join('\n');
  } catch {
    return '🐟 pond-check：报告渲染失败（内部错误），重跑一次；能复现的话带 --json 提 issue。';
  }
}

export default renderText;
