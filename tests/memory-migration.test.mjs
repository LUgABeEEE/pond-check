/**
 * pond-check · v0.2.1 schema 迁移测试（tests/memory-migration.test.mjs）
 *
 * 为什么单独一个文件：
 *   迁移的成败只能在**真的旧库**上验证。用当前代码建出来的库永远带着新列，
 *   拿它测迁移等于什么都没测。所以这里手写 v0.2.0（schema v1）的 DDL——
 *   那是已发布的表结构，钉死在测试里，将来谁改 schema 都得先让这份旧库升得上来。
 *
 * 钉住的四件事：
 *   1. 旧库（v1，没有 valence/arousal）用新代码打开 → 自动 ALTER 补列，不报错
 *   2. 旧数据一条不丢：内容 / 实体 / importance / 时间戳 / archived 全保持原值，
 *      新列对旧行是 NULL（不是 0）
 *   3. 旧索引与 FTS 触发器在迁移后仍然可用（旧行查得到，新行也进索引）
 *   4. 迁移留痕：事件流有 op='migrate' 记录；重开不重复迁移、不重复记账
 *
 * 测试纪律与 memory.test.mjs 一致：临时 POND_HOME、注入时钟、不碰真实 ~/.pond。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createMemory, MIGRATION_COLUMNS, SCHEMA_VERSION } from '../src/memory/index.mjs';
import { FTS_SCHEMA_SQL } from '../src/memory/schema.mjs';
import { segmentText } from '../src/memory/text.mjs';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-migration-'));
const NOW = Date.parse('2026-11-01T10:00:00+08:00');

let counter = 0;

after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function makeHome(label) {
  counter += 1;
  const home = path.join(TEMP_ROOT, `${String(counter).padStart(2, '0')}-${label}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

/**
 * v0.2.0（schema v1）的建表 DDL —— **已发布的表结构，照抄不改**。
 * 与当前 SCHEMA_SQL 的差别只有一处：没有 valence / arousal 两列。
 */
const V1_SCHEMA_SQL = `
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

/** 造一个 v0.2.0 的旧库，返回里面两条旧记忆的原始字段（用于逐字段比对）。 */
function makeLegacyDb(home) {
  const dbPath = path.join(home, 'memory.db');
  const db = new DatabaseSync(dbPath);
  // 触发器里的 segment() 必须先注册，否则插入就炸（与 store.mjs 同一纪律）
  db.function('segment', { deterministic: true }, (text) => segmentText(text));
  db.exec(V1_SCHEMA_SQL);
  // v0.2.0 不认识 user_version，默认是 0；这里显式写成 1，模拟真实旧库
  db.exec('PRAGMA user_version = 1');

  const insert = db.prepare(`
    INSERT INTO memories
      (kind, content, entities, importance, confidence, source, source_ref,
       created_at, updated_at, last_recalled, recall_count, ttl_days, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('fact', '主人住在杭州', JSON.stringify(['杭州']), 5, 0.9,
    'legacy', null, NOW - 30 * 86400000, NOW - 2 * 86400000, NOW - 86400000, 3, null, 0);
  insert.run('preference', '主人讨厌香菜', '[]', 4, 0.8,
    'legacy', 'ref-1', NOW - 60 * 86400000, NOW - 60 * 86400000, null, 0, 90, 1);

  const rows = db.prepare('SELECT * FROM memories ORDER BY id ASC').all();
  db.close();
  return { dbPath, rows: rows.map((row) => ({ ...row })) };
}

function eventsOf(home) {
  const file = path.join(home, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function columnsOf(dbPath) {
  const db = new DatabaseSync(dbPath);
  const columns = db.prepare("SELECT name, type FROM pragma_table_info('memories')").all();
  db.close();
  return columns.map((row) => ({ name: String(row.name), type: String(row.type) }));
}

test('迁移：v0.2.0 的旧库用新代码打开 → 自动补 valence/arousal，不报错', () => {
  const home = makeHome('legacy-open');
  const { dbPath, rows } = makeLegacyDb(home);
  assert.equal(rows.length, 2, '旧库夹具应有两条记忆');

  const before = columnsOf(dbPath).map((column) => column.name);
  assert.equal(before.includes('valence'), false, '前提：旧库确实没有 valence');
  assert.equal(before.includes('arousal'), false, '前提：旧库确实没有 arousal');

  const warns = [];
  const memory = createMemory({ env: { POND_HOME: home }, now: () => NOW, warn: (m) => warns.push(String(m)) });
  assert.equal(memory.mode, 'sqlite', '旧库必须能打开（不许悄悄降级到易失后端）');
  assert.deepEqual(warns, [], '迁移不该产生任何 warn');

  const after = columnsOf(dbPath);
  for (const column of MIGRATION_COLUMNS) {
    const found = after.find((item) => item.name === column.name);
    assert.ok(found, `迁移后缺列 ${column.name}`);
    assert.equal(found.type, column.type, `${column.name} 的类型应为 ${column.type}`);
  }
  assert.deepEqual(memory.migrations.map((item) => item.column).sort(), ['arousal', 'valence'],
    '实例要报告这次真的执行了哪两条迁移');
  memory.close();
});

test('迁移：旧数据一条不丢，旧行的新列是 NULL（不是 0）', () => {
  const home = makeHome('legacy-data');
  const { rows } = makeLegacyDb(home);

  const memory = createMemory({ env: { POND_HOME: home }, now: () => NOW, warn: () => {} });
  const exported = memory.export({ includeArchived: true })
    .trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(exported.length, rows.length, '迁移不许增减行');
  for (const [index, row] of rows.entries()) {
    const got = exported[index];
    assert.equal(got.id, row.id);
    assert.equal(got.kind, row.kind);
    assert.equal(got.content, row.content, '正文必须逐字保持');
    assert.deepEqual(got.entities, JSON.parse(row.entities));
    assert.equal(got.importance, row.importance, 'importance 不许被迁移改写');
    assert.equal(got.confidence, row.confidence);
    assert.equal(got.source, row.source ?? null);
    assert.equal(got.sourceRef, row.source_ref ?? null);
    assert.equal(got.createdAt, row.created_at, 'created_at 必须原样保留');
    assert.equal(got.updatedAt, row.updated_at);
    assert.equal(got.lastRecalled, row.last_recalled);
    assert.equal(got.recallCount, row.recall_count);
    assert.equal(got.ttlDays, row.ttl_days);
    assert.equal(got.archived, row.archived === 1, 'archived 标记不许被迁移冲掉');
    assert.equal(got.valence, null, '旧行的 valence 必须迁移成 NULL');
    assert.equal(got.arousal, null, '旧行的 arousal 必须迁移成 NULL');
  }

  // archived=1 的那条仍然按归档处理：日常召回看不到，includeArchived 才出现
  const activeHits = memory.recall('香菜', { minScore: 0 }).filter((item) => item.kind === 'preference');
  assert.equal(activeHits.length, 0, '旧库里归档的条目升级后仍然要淡出');
  const archivedHits = memory.recall('香菜', { minScore: 0, includeArchived: true })
    .filter((item) => item.kind === 'preference');
  assert.equal(archivedHits.length, 1);
  assert.equal(archivedHits[0].valence, null);
  memory.close();
});

test('迁移：FTS 索引在 ALTER 之后仍然可用（旧行查得到，新行也进索引）', () => {
  const home = makeHome('legacy-fts');
  makeLegacyDb(home);

  const memory = createMemory({ env: { POND_HOME: home }, now: () => NOW, warn: () => {} });
  const oldHit = memory.recall('杭州').filter((item) => item.content === '主人住在杭州');
  assert.equal(oldHit.length, 1, '旧行必须还能被关键词召回');
  assert.equal(oldHit[0].why.retrieval, 'fts', '迁移后仍是 FTS 命中，不是扫描兜底');
  assert.ok(oldHit[0].why.relevance > 0);

  // 新写入用上新列，同时继续进 FTS 索引
  const created = memory.remember({
    content: '昨天在西湖边散步', kind: 'episode', valence: 0.6, arousal: 0.3,
  });
  assert.equal(created.recorded, true, '迁移后的库必须能正常写入');
  assert.equal(created.memory.valence, 0.6);
  assert.equal(created.memory.arousal, 0.3);
  const newHit = memory.recall('西湖').filter((item) => item.id === created.id);
  assert.equal(newHit.length, 1, '新行也必须进 FTS 索引');
  assert.equal(newHit[0].why.retrieval, 'fts');
  assert.equal(newHit[0].valence, 0.6);
  memory.close();
});

test('迁移：事件流留痕，重开不重复迁移、不丢数据', () => {
  const home = makeHome('legacy-events');
  makeLegacyDb(home);

  const first = createMemory({ env: { POND_HOME: home }, now: () => NOW, warn: () => {} });
  first.close();

  const migrateEvents = eventsOf(home).filter((event) => event.op === 'migrate');
  assert.equal(migrateEvents.length, 1, '第一次打开旧库必须留一条迁移事件');
  assert.equal(migrateEvents[0].action, 'migrated');
  assert.equal(migrateEvents[0].ok, true);
  assert.deepEqual(
    migrateEvents[0].migrations.map((item) => item.column).sort(),
    ['arousal', 'valence'],
    '事件里要能看出补了哪两列',
  );

  // 重开：列已存在，不该再迁移，也不该再记一条 migrate
  const second = createMemory({ env: { POND_HOME: home }, now: () => NOW, warn: () => {} });
  assert.deepEqual(second.migrations, [], '第二次打开不该重复迁移');
  assert.equal(eventsOf(home).filter((event) => event.op === 'migrate').length, 1,
    '重开不该重复记迁移事件');
  assert.equal(second.export({ includeArchived: true }).trim().split('\n').length, 2,
    '重开之后旧数据还在');
  second.close();
});

test('迁移：版本号升到 2；新建库直接带两列且版本即 2（不误报迁移）', () => {
  const legacyHome = makeHome('legacy-version');
  const { dbPath } = makeLegacyDb(legacyHome);
  const migrated = createMemory({ env: { POND_HOME: legacyHome }, now: () => NOW, warn: () => {} });
  migrated.close();

  const db = new DatabaseSync(dbPath);
  const version = Number(db.prepare('SELECT user_version AS version FROM pragma_user_version').get()?.version);
  db.close();
  assert.equal(version, SCHEMA_VERSION, '迁移后 user_version 必须等于 SCHEMA_VERSION');
  assert.equal(SCHEMA_VERSION, 2);

  // 全新库：建表就带两列，迁移列表为空
  const freshHome = makeHome('fresh-version');
  const fresh = createMemory({ env: { POND_HOME: freshHome }, now: () => NOW, warn: () => {} });
  assert.deepEqual(fresh.migrations, [], '新库不该有迁移动作');
  const freshColumns = columnsOf(path.join(freshHome, 'memory.db')).map((column) => column.name);
  for (const column of MIGRATION_COLUMNS) {
    assert.ok(freshColumns.includes(column.name), `新库缺列 ${column.name}`);
  }
  assert.equal(eventsOf(freshHome).filter((event) => event.op === 'migrate').length, 0);
  fresh.close();
});
