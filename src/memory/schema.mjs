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
 * 硬约束：不联网、不写盘、零依赖；DDL 以字符串形式导出，由 store.mjs 执行。
 */

/** 记忆库文件名（位于 <POND_HOME> 下）。 */
export const MEMORY_DB_FILE_NAME = 'memory.db';

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
  archived      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_last_recalled ON memories(last_recalled);
CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);

${FTS_SCHEMA_SQL}
`;
