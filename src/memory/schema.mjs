/**
 * pond-check · 能力层 C2：记忆 schema 与常量（src/memory/schema.mjs）
 *
 * 表结构照抄 CAPABILITIES-SPEC §3.2：memories 主表 + memories_fts 外部内容
 * FTS5 虚拟表 + 四个索引。差异只有两处，都在注释里点明：
 *
 *   1. kind 只收 fact / preference / episode 三类（任务书口径）。SPEC §3.1
 *      还列了 relation（半衰期同 fact），等 C7 对文档收口时再决定要不要扩；
 *      加一类只需要动 KINDS 与 KIND_HALF_LIFE_DAYS 两个常量。
 *   2. memories_fts 的三个触发器用 segment() 把内容切成二元组再入索引
 *      （原因见 text.mjs 顶部）。插入与删除都走同一段切分逻辑，索引两侧
 *      严格对称，不会留孤儿条目。
 *
 * 存储位置：`<POND_HOME>/memory.db`（默认 ~/.pond/memory.db，POND_HOME 可覆盖）。
 * 隐私铁律：整库只在本地，没有同步、没有备份、没有遥测；删掉 POND_HOME
 * 就回到初始状态（CAPABILITIES-SPEC §3.6 / §6.3）。
 *
 * v0.2.1 schema v2 的两处增量（**都必须能平滑升级 v0.2.0 的旧库**）：
 *   1. memories 加 `valence` / `arousal`（情感坐标，只存不算分，见 MIGRATION_COLUMNS）
 *   2. 新建库直接带上两列；旧库由 store.mjs 的 migrateSchema() 逐列 ALTER 补齐，
 *      旧行两列为 NULL，一条记忆都不丢。
 *
 * 硬约束：不联网、不写盘、零依赖；DDL 以字符串形式导出，由 store.mjs 执行。
 */

/** 记忆库文件名（位于 <POND_HOME> 下）。 */
export const MEMORY_DB_FILE_NAME = 'memory.db';

/**
 * 当前 schema 版本（写进 `PRAGMA user_version`）。
 *
 *   v1  v0.2.0 的首版：memories 主表 + FTS5 + 四索引，无 valence/arousal
 *   v2  v0.2.1：memories 加 valence / arousal 两列（情感坐标，**只存不算分**）
 *
 * 版本号只用于审计与迁移记录；**迁移的判据是列是否存在**（pragma_table_info），
 * 不是版本号——外部工具可能改过 user_version，列才是事实。
 */
export const SCHEMA_VERSION = 2;

/**
 * v1 → v2 的增量列。打开旧库（v0.2.0 的 memory.db）时逐列检查并
 * `ALTER TABLE memories ADD COLUMN`，旧行的新列保持 NULL，一条记忆都不丢。
 *
 * valence / arousal 是 Russell 情感坐标（借鉴 Ombre Brain）：
 *   valence  效价 −1（极负面）.. 1（极正面），NULL = 未知
 *   arousal  唤醒度 0（平静）.. 1（激动），NULL = 未知
 *
 * **预留字段：只存不算分。** 它们绝不进四因子公式（scoring.mjs 的
 * FACTOR_WEIGHTS 里没有、scoreRow 也不读），召回排序与它们无关——
 * 现在存只是为了将来有足够数据时再决定怎么用，不许先斩后奏。
 */
export const MIGRATION_COLUMNS = Object.freeze([
  Object.freeze({ name: 'valence', type: 'REAL' }),
  Object.freeze({ name: 'arousal', type: 'REAL' }),
]);

/**
 * 三类记忆。半衰期单位：天。
 *   fact       稳定客观信息   「主人住在杭州」   365
 *   preference 态度倾向       「讨厌香菜」       180
 *   episode    带时间的经历   「一起看了芙莉莲」  45
 *   relation   人和人的关系   「阿杰是主人大学室友」 365
 */
export const KINDS = Object.freeze(['fact', 'preference', 'episode', 'relation']);

/** 各 kind 的默认半衰期（CAPABILITIES-SPEC §3.1）。 */
export const KIND_HALF_LIFE_DAYS = Object.freeze({
  fact: 365,
  preference: 180,
  episode: 45,
  // 人物关系和人一样，忘得慢：和 fact 同档
  relation: 365,
});

/** 半衰期兜底（未知 kind 时按 fact 处理，不炸）。 */
export const FALLBACK_HALF_LIFE_DAYS = 365;

/** importance 缺省值（SPEC §3.2 默认 3 = 一般事实）。 */
export const DEFAULT_IMPORTANCE = 3;

/** confidence 缺省值（SPEC §3.2 默认 0.8）。 */
export const DEFAULT_CONFIDENCE = 0.8;

/** importance 合法范围。 */
export const MIN_IMPORTANCE = 1;
export const MAX_IMPORTANCE = 5;

/**
 * importance = 5 的硬配额（借鉴 Ombre Brain：重要的东西必须稀缺）。
 *
 * 一旦所有事都是 5 分，四因子里的「重要性」这一项就等于常数——
 * 排序退化，用户也没法靠重要性找回真正要紧的事。所以 5 分条目不设软提示，
 * 而是**硬上限**：写满之后 remember() 直接返回 `importance-quota-full`
 * 并附上现役 5 分条目清单，**绝不静默降级成 4 分**（静默降级等于骗调用方）。
 *
 * 配额只针对 `importance === 5`，不是所有记忆的总量上限。
 * 已归档（archived=1）的条目不占配额——淡出的东西不该继续占着稀缺位。
 */
export const MAX_TOP_IMPORTANCE_ENTRIES = 20;

/** 配额的机器可读描述（事件、返回值、测试共用同一份数字）。 */
export const IMPORTANCE_QUOTA = Object.freeze({
  importance: MAX_IMPORTANCE,
  limit: MAX_TOP_IMPORTANCE_ENTRIES,
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isKind(value) {
  return typeof value === 'string' && KINDS.includes(value);
}

/**
 * 取一条记忆的半衰期：`ttl_days` 覆盖优先，否则按 kind。
 * @param {{ttlDays?: number|null, kind?: string}} row
 * @returns {number} 天
 */
export function halfLifeDaysFor(row) {
  const override = Number(row?.ttlDays);
  if (Number.isFinite(override) && override > 0) return override;
  return KIND_HALF_LIFE_DAYS[row?.kind] ?? FALLBACK_HALF_LIFE_DAYS;
}

/**
 * 只有 FTS 索引部分的 DDL（虚拟表 + 三个触发器）。写路径自愈用它**重建索引**，
 * 刻意不含主表——主表丢了就是真丢了，自愈不许把空表「救」回来冒充没出事。
 *
 * 外部内容 FTS 的删除必须走 'delete' 命令并**给出当时入索引的那份文本**，
 * 所以三个触发器全部用 segment(...) 对称处理 old/new —— 这是官方推荐的
 * external content 触发器写法，只是列值多包了一层切分。
 */
export const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, entities, content='memories', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, entities)
  VALUES (new.id, segment(new.content), segment(COALESCE(new.entities, '')));
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, entities)
  VALUES ('delete', old.id, segment(old.content), segment(COALESCE(old.entities, '')));
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, entities)
  VALUES ('delete', old.id, segment(old.content), segment(COALESCE(old.entities, '')));
  INSERT INTO memories_fts(rowid, content, entities)
  VALUES (new.id, segment(new.content), segment(COALESCE(new.entities, '')));
END;
`;

/**
 * 建库 DDL。`segment()` 是 store.mjs 在每个连接上注册的分词函数（text.mjs），
 * 触发器必须在任何写入之前建好，否则索引会缺行。
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  entities      TEXT,
  importance    INTEGER NOT NULL DEFAULT 3,
  confidence    REAL NOT NULL DEFAULT 0.8,
  source        TEXT,
  source_ref    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_recalled INTEGER,
  recall_count  INTEGER NOT NULL DEFAULT 0,
  ttl_days      INTEGER,
  archived      INTEGER NOT NULL DEFAULT 0,
  valence       REAL,
  arousal       REAL
);

CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_last_recalled ON memories(last_recalled);
CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);

${FTS_SCHEMA_SQL}
`;
