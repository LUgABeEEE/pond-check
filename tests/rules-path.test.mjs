/**
 * pond-check · rulesPath 名字闸（tests/rules-path.test.mjs）
 *
 * D8-L1：`loadRules({ rulesPath })` 与环境变量 `POND_CHECK_RULES` 都能指向任意路径，
 * 没有名字闸。CLI 侧走不到这里（没有 --rules 参数），但库 API 能 —— 有人拿它去读
 * `~/.ssh/id_ed25519` 或任何 `credentials.json`，它就会照读并解析。
 *
 * 「CLI 走不到」不等于「代码不该防」：这一层的价值就在于它不依赖调用方自律。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRules } from '../src/evaluate/life.mjs';

const TEMP_ROOTS = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pond-rules-'));
  TEMP_ROOTS.push(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of TEMP_ROOTS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

test('D8-L1 名字闸：rulesPath 指向凭证名文件 → 拒绝读取', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'credentials.json');
  fs.writeFileSync(target, JSON.stringify({ secret: 'sk-LEAK', indicators: {} }));

  assert.equal(loadRules({ rulesPath: target }), null, '居然把凭证名文件当配置读了');
});

test('D8-L1 名字闸：环境变量 POND_CHECK_RULES 指向凭证名文件 → 同样拒绝', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'secrets.json');
  fs.writeFileSync(target, JSON.stringify({ token: 'tok-LEAK' }));

  const previous = process.env.POND_CHECK_RULES;
  process.env.POND_CHECK_RULES = target;
  try {
    assert.equal(loadRules(), null, '环境变量这条路漏了');
  } finally {
    if (previous === undefined) delete process.env.POND_CHECK_RULES;
    else process.env.POND_CHECK_RULES = previous;
  }
});

test('D8-L1 名字闸：路径落在敏感目录里 → 拒绝（哪怕文件名很普通）', () => {
  const dir = makeTempDir();
  const sshDir = path.join(dir, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  const target = path.join(sshDir, 'config');
  fs.writeFileSync(target, 'Host *\n  IdentityFile ~/.ssh/id_rsa\n');

  assert.equal(loadRules({ rulesPath: target }), null, '.ssh 目录下的普通文件名也被读了');
});

test('D8-L1 不误伤：正常的 rules.json 仍然能读', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'rules.json');
  const rules = { schemaVersion: 1, indicators: { liveness: { id: 'liveness' } } };
  fs.writeFileSync(target, JSON.stringify(rules));

  const loaded = loadRules({ rulesPath: target });
  assert.ok(loaded, '正常配置文件被误伤了');
  assert.equal(loaded.schemaVersion, 1);
  assert.ok(loaded.indicators && loaded.indicators.liveness);
});

test('D8-L1 不误伤：项目自带的 src/rules.json 能正常读', () => {
  const own = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'rules.json');
  const loaded = loadRules({ rulesPath: own });
  assert.ok(loaded, '项目自带的 rules.json 都读不了，闸开太大了');
  assert.equal(Object.keys(loaded.indicators).length, 6);
});
