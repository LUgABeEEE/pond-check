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
  assert.match(only.evidence.reasonText, /没找到判重表/u, '人话要说清缺什么');
  assert.match(only.evidence.reasonText, /没法判断她到底干了多少活/u, '人话要说清后果（为什么判不出工作量）');
  assert.doesNotMatch(only.evidence.reasonText, /\{[A-Za-z_]/u, '人话里不许留未替换的 {var}');
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

// 环境敏感点 #5（原 `timeoutMs: 1` 依赖「1 ms 内 worker 起不来」）：
// timeoutMs=0 = 主线程不等待 worker，无论机器多快都走同一分支 → 确定性降级；
// 不再靠调度运气，也不会在极快机器上翻转。
test('降级留痕：generic 一路超时 → dsh 结果照出，degraded 记 timeout', () => {
  const fish = scan('normal', { timeoutMs: 0 });
  assert.ok(fish.some((f) => f.kind === 'dsh-plugin'), 'dsh 一路不受 generic 降级影响');
  assert.ok(Array.isArray(fish.degraded));
  assert.equal(fish.degraded.length, 1, `只该有一条降级留痕：${JSON.stringify(fish.degraded)}`);
  assert.equal(fish.degraded[0].scope, 'generic');
  // D8c 弱断言 #6：`typeof === 'string'` 连 "whatever" 都能过；锁死机器码。
  assert.equal(fish.degraded[0].reason, 'timeout', `降级原因必须是 timeout：${fish.degraded[0].reason}`);
});
