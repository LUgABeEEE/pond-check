/**
 * pond-check · 能力层 C2：记忆存储后端（src/memory/store.mjs）
 *
 * 两个后端、一套行接口：
 *
 *   SqliteStore    默认。node:sqlite（内置，含 FTS5），库文件 `<POND_HOME>/memory.db`。
 *   VolatileStore  降级。纯内存 Map——库打不开时保命用（POND_HOME 指到文件上、
 *                  磁盘坏、目录不可写……），会话内照常沉淀/召回，代价是不落盘。
 *
 * 降级链就是「sqlite → memory-volatile」：memory 按 SPEC §2.2 不分级（只有本地、
 * 永不上传），所以链子只有持久化与易失性两档；打不开库不能让整条鱼失忆罢工。
 * 降级会写进事件流（两个 provider 各一条尝试，后者带 degradedFrom），诊断层看得见。
 *
 * 行对象统一 camelCase（DB 列是 snake_case，映射只发生在这里）：
 *   { id, kind, content, entities[], importance, confidence, source, sourceRef,
 *     createdAt, updatedAt, lastRecalled, recallCount, ttlDays, archived,
 *     valence, arousal }
 *
 *   valence / arousal 是 v0.2.1 新增的情感坐标（v1 旧库里没有这两列，由
 *   migrateSchema() 打开时补齐）。**只存不算分**：它们不出现在 scoring.mjs 的
 *   四因子公式里，写进来只是为了将来有数据可用。
 *
 * search(tokens) 返回 { mode, hits }：
 *   mode 'fts'  → BM25，hits: [{ id, raw }]，raw = -bm25（越大越相关）
 *   mode 'scan' → FTS 不可用或易失后端时的全表扫描，hits: [{ id, matched: [...] }]
 *   mode 'none' → 无查询词
 * 归一化与打分在 recall 侧（scoring.mjs），存储层只回答「谁命中、命中多少」。
 *
 * 硬约束：只写 `<POND_HOME>` 下的 memory.db；不联网、零依赖；写库失败向上抛，
 * 由 memory.mjs 决定降级（这里不吞错）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolvePondHome } from '../shared/paths.mjs';
import {
  MEMORY_DB_FILE_NAME,
  SCHEMA_SQL,
  FTS_SCHEMA_SQL,
  MIGRATION_COLUMNS,
  SCHEMA_VERSION,
} from './schema.mjs';
import { segmentText, buildMatchExpr } from './text.mjs';

/** provider id：事件流里记账用（本地能力，成本恒 0）。 */
export const SQLITE_PROVIDER = 'sqlite';
export const VOLATILE_PROVIDER = 'memory-volatile';

const COLUMNS = `
  id, kind, content, entities, importance, confidence,
  source, source_ref, created_at, updated_at, last_recalled,
  recall_count, ttl_days, archived, valence, arousal
`;

/** @param {object} row DB 行（snake_case） → API 行（camelCase） */
function rowFromDb(row) {
  if (!row) return null;
  let entities = [];
  try {
    const parsed = JSON.parse(row.entities ?? '[]');
    if (Array.isArray(parsed)) entities = parsed.filter((item) => typeof item === 'string');
  } catch {
    entities = []; // 脏 JSON 不炸召回，退化成无实体
  }
  return {
    id: Number(row.id),
    kind: row.kind,
    content: row.content,
    entities,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    source: row.source ?? null,
    sourceRef: row.source_ref ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastRecalled: row.last_recalled == null ? null : Number(row.last_recalled),
    recallCount: Number(row.recall_count),
    ttlDays: row.ttl_days == null ? null : Number(row.ttl_days),
    archived: Number(row.archived) === 1,
    // 情感坐标：NULL 保持 null（旧数据升级后就是这样），不拿 0 冒充「中性」
    valence: row.valence == null ? null : Number(row.valence),
    arousal: row.arousal == null ? null : Number(row.arousal),
  };
}

function entitiesToJson(entities) {
  return JSON.stringify(Array.isArray(entities) ? entities : []);
}

/** @param {object} patch camelCase 局部更新 → SQL 列集合 */
function columnsFromPatch(patch) {
  const map = {
    kind: 'kind',
    content: 'content',
    entities: 'entities',
    importance: 'importance',
    confidence: 'confidence',
    source: 'source',
    sourceRef: 'source_ref',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    lastRecalled: 'last_recalled',
    recallCount: 'recall_count',
    ttlDays: 'ttl_days',
    archived: 'archived',
    valence: 'valence',
    arousal: 'arousal',
  };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(map)) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key === 'entities') value = entitiesToJson(value);
    if (key === 'archived') value = value ? 1 : 0;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  return { sets, values };
}

/**
 * SQLite 后端。构造即建库建表（幂等），失败直接抛。
 */
export class SqliteStore {
  /**
   * @param {{env?: Record<string, string|undefined>, dbPath?: string}} [options]
   */
  constructor(options = {}) {
    this.provider = SQLITE_PROVIDER;
    const home = resolvePondHome(options.env ?? process.env);
    this.home = home;
    this.dbPath = options.dbPath ?? path.join(home, MEMORY_DB_FILE_NAME);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    // 触发器里的 segment() 必须先注册再建表/写入，否则第一次插入就炸。
    this.db.function('segment', { deterministic: true }, (text) => segmentText(text));
    this.db.exec(SCHEMA_SQL);
    // v0.2.0 的旧库已经有 memories 主表：CREATE TABLE IF NOT EXISTS 不会给它
    // 补列，必须显式迁移。迁移只加列、不改旧行——旧数据一条都不丢。
    this.migrations = migrateSchema(this.db);
  }

  /** @returns {number} 新行 id */
  insert(row) {
    return this.withFtsHeal(() => {
      const result = this.db.prepare(`
        INSERT INTO memories
          (kind, content, entities, importance, confidence, source, source_ref,
           created_at, updated_at, last_recalled, recall_count, ttl_days, archived,
           valence, arousal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.kind,
        row.content,
        entitiesToJson(row.entities),
        row.importance,
        row.confidence,
        row.source ?? null,
        row.sourceRef ?? null,
        row.createdAt,
        row.updatedAt,
        row.lastRecalled ?? null,
        row.recallCount ?? 0,
        row.ttlDays ?? null,
        row.archived ? 1 : 0,
        // 情感坐标可空：NULL 表示「不知道」，不是 0
        row.valence ?? null,
        row.arousal ?? null,
      );
      return this.get(Number(result.lastInsertRowid));
    });
  }

  /** @returns {object|null} 更新后的行 */
  update(id, patch) {
    return this.withFtsHeal(() => {
      const { sets, values } = columnsFromPatch(patch);
      if (sets.length === 0) return this.get(id);
      this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      return this.get(id);
    });
  }

  /** @returns {boolean} 是否删掉了一行 */
  delete(id) {
    return this.withFtsHeal(() => {
      const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    });
  }

  /** @returns {object|null} */
  get(id) {
    return rowFromDb(this.db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(id));
  }

  /**
   * @param {{kinds?: string[], includeArchived?: boolean}} [options]
   * @returns {object[]} 按 id 升序
   */
  list(options = {}) {
    const where = [];
    const values = [];
    if (!options.includeArchived) where.push('archived = 0');
    if (Array.isArray(options.kinds) && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      values.push(...options.kinds);
    }
    const sql = `SELECT ${COLUMNS} FROM memories
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id ASC`;
    return this.db.prepare(sql).all(...values).map(rowFromDb);
  }

  /**
   * FTS 命中；FTS 表损坏/被删时**不抛**，退化为全表扫描（mode 'scan'），
   * 让召回在索引坏掉时仍可用（相关度口径见 scoring.mjs）。
   * @param {string[]} tokens
   * @returns {{mode: 'fts'|'scan', hits: object[]}}
   */
  search(tokens) {
    const expr = buildMatchExpr(tokens);
    if (expr === null) return { mode: 'none', hits: [] };
    try {
      const rows = this.db.prepare(`
        SELECT rowid AS id, bm25(memories_fts) AS raw
        FROM memories_fts WHERE memories_fts MATCH ?
      `).all(expr);
      return {
        mode: 'fts',
        hits: rows.map((row) => ({ id: Number(row.id), raw: -Number(row.raw) })),
      };
    } catch {
      return scanRows(this.list(), tokens);
    }
  }

  /** 批量更新「上次被召回」计数（单条语句，自愈重试不会重复计数）。 */
  bumpRecall(ids, now) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.withFtsHeal(() => {
      this.db.prepare(
        `UPDATE memories SET recall_count = recall_count + 1, last_recalled = ? WHERE id IN (${placeholders})`,
      ).run(now, ...ids);
    });
  }

  /**
   * 写路径自愈：FTS 索引被删/损坏时（外部 sqlite3 工具误操作、磁盘故障……）
   * 写入会因为触发器找不到 memories_fts 而失败——这时重建索引再重试一次。
   * 重建本身就是「从主表重放」，不丢任何已落库的记忆。
   * 重试仍失败才把错误抛给上层（memory.mjs 会转成 storage-error 结果）。
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  withFtsHeal(fn) {
    try {
      return fn();
    } catch (error) {
      this.rebuildFts();
      return fn();
    }
  }

  /** 重建 FTS 虚拟表 + 三个触发器，并从主表重放索引内容。尽力而为。 */
  rebuildFts() {
    try {
      this.db.exec(`
        DROP TRIGGER IF EXISTS memories_fts_ai;
        DROP TRIGGER IF EXISTS memories_fts_ad;
        DROP TRIGGER IF EXISTS memories_fts_au;
        DROP TABLE IF EXISTS memories_fts;
      `);
      this.db.exec(FTS_SCHEMA_SQL);
      this.db.prepare(`
        INSERT INTO memories_fts(rowid, content, entities)
        SELECT id, segment(content), segment(COALESCE(entities, '')) FROM memories
      `).run();
    } catch {
      // 重建都失败就让原始错误抛出去——索引救不回来时扫描降级仍在
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      // 已关过/从未开成功都无所谓：close 是尽力而为
    }
  }
}

/**
 * 易失后端：内存 Map。行为与 SqliteStore 对齐（同一套行接口），
 * 差别只有「不落盘」和 search 一律走扫描。
 */
export class VolatileStore {
  constructor() {
    this.provider = VOLATILE_PROVIDER;
    this.rows = new Map();
    this.nextId = 1;
  }

  insert(row) {
    const id = this.nextId;
    this.nextId += 1;
    const stored = { ...row, id, recallCount: row.recallCount ?? 0, archived: row.archived === true };
    this.rows.set(id, stored);
    return { ...stored };
  }

  update(id, patch) {
    const existing = this.rows.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id };
    this.rows.set(id, updated);
    return { ...updated };
  }

  delete(id) {
    return this.rows.delete(id);
  }

  get(id) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  list(options = {}) {
    const rows = [...this.rows.values()]
      .filter((row) => options.includeArchived || !row.archived)
      .filter((row) => !Array.isArray(options.kinds) || options.kinds.length === 0
        || options.kinds.includes(row.kind))
      .sort((a, b) => a.id - b.id);
    return rows.map((row) => ({ ...row }));
  }

  search(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return { mode: 'none', hits: [] };
    return scanRows(this.list(), tokens);
  }

  bumpRecall(ids, now) {
    for (const id of ids ?? []) {
      const row = this.rows.get(id);
      if (!row) continue;
      row.recallCount += 1;
      row.lastRecalled = now;
    }
  }

  close() {
    this.rows.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/** 全表扫描命中（降级路径 / 易失后端）：token 子串包含即算命中。 */
function scanRows(rows, tokens) {
  const hits = [];
  for (const row of rows) {
    const haystack = `${row.content} ${(row.entities ?? []).join(' ')}`;
    const matched = tokens.filter((token) => haystack.includes(token));
    if (matched.length > 0) hits.push({ id: row.id, matched });
  }
  return { mode: 'scan', hits };
}

/**
 * 把旧库（v1，v0.2.0 建的）平滑升级到 v2：补齐 MIGRATION_COLUMNS 里缺的列。
 *
 * 判据是 **pragma_table_info 里列是否存在**，不是 user_version——外部 sqlite3
 * 工具可能动过版本号，列才是事实。只做 `ALTER TABLE ... ADD COLUMN`：
 * SQLite 给旧行的新列填 NULL，不重写任何一行，不会丢数据。
 * 返回值是本次真正执行了的迁移（新建库时为空数组），memory.mjs 会把它写进事件流。
 *
 * @param {DatabaseSync} db 已建好主表的连接
 * @returns {{column: string, type: string, from: 'v1', to: 'v2'}[]} 本次执行的迁移
 */
export function migrateSchema(db) {
  const applied = [];
  let existing = new Set();
  try {
    existing = new Set(
      db.prepare("SELECT name FROM pragma_table_info('memories')").all().map((row) => String(row.name)),
    );
  } catch {
    // 主表都读不到说明库坏了：交给上层（openStore → 易失降级），这里不吞
    throw new Error('memories 主表不可读，无法判断迁移');
  }

  for (const column of MIGRATION_COLUMNS) {
    if (existing.has(column.name)) continue;
    // 列名与类型来自模块常量（不是外部输入），拼接是安全的
    db.exec(`ALTER TABLE memories ADD COLUMN ${column.name} ${column.type}`);
    applied.push({ column: column.name, type: column.type, from: 'v1', to: 'v2' });
  }

  try {
    const row = db.prepare('SELECT user_version AS version FROM pragma_user_version').get();
    const version = Number(row?.version ?? 0);
    if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch {
    // user_version 只是审计信息，读不到不影响记忆功能
  }

  return applied;
}

/**
 * 打开存储后端。sqlite 失败 → 易失降级（**不抛**）。
 * @param {{env?: Record<string, string|undefined>, dbPath?: string}} [options]
 * @returns {{store: SqliteStore|VolatileStore, provider: string, degraded: {from: string, error: Error}|null, openError: Error|null}}
 */
export function openStore(options = {}) {
  try {
    const store = new SqliteStore(options);
    return { store, provider: store.provider, degraded: null, openError: null };
  } catch (error) {
    const store = new VolatileStore();
    return {
      store,
      provider: store.provider,
      degraded: { from: SQLITE_PROVIDER, error },
      openError: error,
    };
  }
}
