/**
 * pond-check · 文档与实现一致性闸（tests/docs-consistency.test.mjs）
 *
 * 为什么有这个文件：
 *   D6 加了「rules.json 里的话术不许教用户敲不存在的参数」这条闸，但没覆盖 docs/。
 *   结果 `docs/SPEC.md:380` 一直写着「用 --expect-schema 3 告诉体检你期望的版本」，
 *   而 CLI 根本不认这个参数——照文档敲就 exit 2。走查抓到了它，但走查只发生一次。
 *
 *   凡是「文档教用户敲一个不存在的东西」这类错，都必须被机器挡住。
 *
 * 扫描范围（面向用户的文档）：
 *   README.md · docs/SPEC.md · docs/CAPABILITIES-SPEC.md
 *
 * 不扫（故意的）：
 *   docs/FIELD-NOTES.md —— 那是走查的历史记录，里面提到不存在的参数是在**描述问题**，
 *   不是在建议用户去敲。把它纳入扫描等于逼人删掉证据。
 *
 * 排除规则：出现在外部命令行里的参数不归我们管（`git push --force`、`node --version`）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliArgs } from '../src/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 面向用户的文档：用户会照着这里的话去敲命令。 */
const USER_DOCS = [
  'README.md',
  'docs/SPEC.md',
  'docs/CAPABILITIES-SPEC.md',
];

/** 别人家的命令：这些后面跟的参数不归 pond-check 管。 */
const FOREIGN_COMMANDS = new Set([
  'systemctl', 'journalctl', 'launchctl', 'node', 'npm', 'npx', 'pnpm', 'yarn',
  'git', 'docker', 'apt', 'apt-get', 'brew', 'ps', 'grep', 'rg', 'chmod', 'chown',
  'sudo', 'nvm', 'curl', 'wget', 'ffmpeg', 'pm2', 'supervisorctl', 'ssh', 'scp',
  'pip', 'pip3', 'python', 'python3', 'tar', 'unzip', 'make', 'cargo', 'go',
]);

/**
 * 通用参数白名单：这些不是 pond-check 的开关，而是随便哪个程序都有的通用参数。
 * 文档里出现 `node --version`、`<她的可执行文件> --version` 是在描述「查版本」这个动作，
 * 不是在教用户敲 `pond-check --version`。
 */
const UNIVERSAL_FLAGS = new Set(['--version', '--help']);

/** 读一份文档，返回出现的所有 `--xxx`。 */
function collectFlags(text) {
  const tokens = text.split(/\s+/u);
  const found = new Set();

  tokens.forEach((token, index) => {
    // 去掉包裹的反引号、行尾标点，只认纯参数形态
    const cleaned = token.replace(/^[`'"(（【]+/u, '').replace(/[`'")）。、，,;；:：]+$/u, '');
    const match = cleaned.match(/^(--[a-z][a-z0-9-]*)$/u);
    if (!match) return;

    // 往前看三个 token：如果其中出现外部命令名，这个参数不归我们管。
    // token 常带标点（`-l、systemctl`），要按非词字符再切一遍才认得出命令名。
    const headWords = tokens
      .slice(Math.max(0, index - 3), index)
      .flatMap((item) => item.split(/[^\w-]+/u))
      .filter(Boolean);
    if (headWords.some((word) => FOREIGN_COMMANDS.has(word))) return;
    if (UNIVERSAL_FLAGS.has(match[1])) return;

    found.add(match[1]);
  });

  return found;
}

test('文档里出现的每一个 --xxx，CLI 都必须真支持', () => {
  const violations = [];
  let scannedDocs = 0;
  let scannedFlags = 0;

  for (const relative of USER_DOCS) {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) continue; // 文档还没写就跳过，不假装测过
    scannedDocs += 1;
    const text = fs.readFileSync(absolute, 'utf8');
    for (const flag of collectFlags(text)) {
      scannedFlags += 1;
      // 探针：给 flag 后面塞一个占位值。
      // - 值参数（--root）：整串合法，ok
      // - 开关参数（--json）：占位值会被拒，报「不认识的参数：占位值」——但这不是 flag 的错
      // 所以只有错误里**点名了这个 flag**，才说明 CLI 真的不认它。
      const parsed = parseCliArgs([flag, '__probe__']);
      const errors = parsed.errors.join(' ');
      const rejected = errors.includes(`不认识的参数：${flag}`);
      if (rejected) {
        violations.push(`${relative} 让你敲 ${flag}，但 CLI 不认它`);
      }
    }
  }

  assert.ok(scannedDocs > 0, '一份用户文档都没扫到，说明扫描路径写错了');
  assert.ok(scannedFlags > 0, '一个参数都没扫到，说明提取逻辑坏了');
  assert.deepEqual(violations, [], `文档与实现不一致：\n${violations.join('\n')}`);
});

test('回归保护：--expect-schema 不许在任何面向用户的文档里复活', () => {
  for (const relative of USER_DOCS) {
    const absolute = path.join(ROOT, relative);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    assert.equal(
      text.includes('--expect-schema'),
      false,
      `${relative} 里又出现了 --expect-schema —— 那是内部测试参数，CLI 不支持，不该教用户`,
    );
  }
});

test('文档里提到的每个逃生口参数都真的在 --help 里', () => {
  // 四个逃生口：窝、日志、判重表、指定鱼。少一个，真机上的鱼就读不出来。
  const escapeHatches = ['--root', '--log', '--dedupe', '--fish'];
  const help = parseCliArgs(['--help']);
  assert.equal(help.ok, true, '--help 都解析失败，说明 CLI 坏了');

  const helpText = fs.readFileSync(path.join(ROOT, 'src', 'cli.mjs'), 'utf8');
  for (const flag of escapeHatches) {
    const parsed = parseCliArgs([flag, 'whatever']);
    assert.equal(parsed.ok, true, `${flag} 不被 CLI 接受`);
    assert.equal(
      helpText.includes(flag),
      true,
      `${flag} 在 CLI 里能用，但 --help 里没写 —— 用户不会知道有这条路`,
    );
  }
});
