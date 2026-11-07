// tests/discover.test.mjs —— D2 收口：discoverPonds 聚合行为
//
// 拐杖目录在 tests/fixtures/<场景>/{dsh,home}，只被读、从不写。
// 断言只看「发现了几条、kind 对不对、id 互不相同、降级有没有留痕」，
// 不锁路径细节 —— 报告层怎么展示是下游的事。
//
// 注意：fixtures 里有 node_modules/ 与 *.log（.gitignore 会拦），
// 提交时需要 `git add -f tests/fixtures`。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPonds } from '../src/discover/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (...parts) => path.join(HERE, 'fixtures', ...parts);

/** 指到某个场景的两棵扫描根跑一次聚合。 */
function scan(scene, extra = {}) {
  return discoverPonds({ dshHome: fx(scene, 'dsh'), home: fx(scene, 'home'), ...extra });
}

test('正常发现：dsh 插件 + 独立鱼都找到，按 kind 排序、id 互不相同', () => {
  const fish = scan('normal');
  assert.ok(Array.isArray(fish), 'discoverPonds 必须同步返回数组');
  assert.equal(fish.length, 2);
  assert.deepEqual(fish.map((f) => f.kind), ['dsh-plugin', 'standalone']);
  assert.ok(new Set(fish.map((f) => f.id)).size === fish.length, 'id 互不相同');
  for (const f of fish) {
    assert.equal(typeof f.id, 'string');
    assert.ok(path.isAbsolute(f.rootPath), 'rootPath 原样给绝对路径');
    assert.equal(typeof f.evidence, 'object');
  }
  const dshHit = fish.find((f) => f.kind === 'dsh-plugin');
  assert.ok(dshHit.evidence.reason.includes('命中'), 'evidence.reason 要说清凭什么判定');
  assert.deepEqual(fish.degraded, [], '两路都活着时不该有降级');
});

test('目录不存在：两棵扫描根都没有 → []，不抛', () => {
  const fish = scan('missing');
  assert.ok(Array.isArray(fish));
  assert.equal(fish.length, 0);
});

test('空目录：目录在但里面没鱼 → []', () => {
  const fish = scan('empty');
  assert.ok(Array.isArray(fish));
  assert.equal(fish.length, 0);
});

test('unknown 降级：名字像鱼但缺关键文件 → 报 unknown + 人话理由', () => {
  const fish = scan('unknown');
  assert.equal(fish.length, 1);
  const [only] = fish;
  assert.equal(only.kind, 'unknown');
  assert.equal(only.reason, 'missing_dedupe');
  assert.ok(only.evidence.reasonText.includes('判重表'), '人话要说清缺什么');
  assert.ok(only.evidence.reasonText.length > 0);
});

test('同一插件装在两个 profile：两条都保留，id 加 scope 区分开', () => {
  const fish = scan('two-profiles');
  assert.equal(fish.length, 2, '两个 profile 各一份安装，不许去重吃掉一条');
  assert.deepEqual(
    fish.map((f) => f.id),
    ['dsh-plugin:web-a/dsh-whale-widget', 'dsh-plugin:web-b/dsh-whale-widget'],
  );
  assert.equal(new Set(fish.map((f) => f.rootPath)).size, 2, 'rootPath 各不相同且原样保留');
  assert.ok(fish.every((f) => f.kind === 'dsh-plugin'));
});

test('降级留痕：generic 一路超时 → dsh 结果照出，degraded 记原因', () => {
  const fish = scan('normal', { timeoutMs: 1 });
  assert.ok(fish.some((f) => f.kind === 'dsh-plugin'), 'dsh 一路不受 generic 降级影响');
  assert.ok(Array.isArray(fish.degraded));
  assert.equal(fish.degraded.length, 1);
  assert.equal(fish.degraded[0].scope, 'generic');
  assert.ok(typeof fish.degraded[0].reason === 'string');
});
