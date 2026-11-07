/**
 * tests/fixtures/fake-tts.mjs —— 假 TTS 命令行（测试专用）
 *
 * 用真子进程验证 command adapter 的调用链（argv 替换 / stdin / 输出文件 /
 * 退出码 / 时长），但**不需要机器上真装 piper / espeak**。
 *
 * 用法：
 *   node fake-tts.mjs --out <path> --text <text>            写 '[<text>]' 假音频
 *   node fake-tts.mjs --stdin --out <path>                  文本走 stdin
 *   node fake-tts.mjs --wav 100 --out <path> --text <t>     写真 wav（100ms 静音）
 *   node fake-tts.mjs --echo-argv --out <path> ...          把 argv/stdin 原样写进 out
 *   node fake-tts.mjs --fail --out <path>                   失败：stderr + exit 3
 *   node fake-tts.mjs --hang --out <path>                   挂住不返回（超时测试）
 */

import fs from 'node:fs';

const argv = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token.startsWith('--')) {
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(token, next);
      index += 1;
    } else {
      flags.set(token, true);
    }
  }
}

const outPath = flags.get('--out');
if (typeof outPath !== 'string') {
  process.stderr.write('fake-tts: 缺 --out\n');
  process.exit(2);
}

if (flags.get('--fail') === true) {
  process.stderr.write('synth exploded: 假合成器故意失败\n');
  process.exit(3);
}

if (flags.get('--hang') === true) {
  // 挂住不返回，直到被 kill（超时/取消路径用）。
  setInterval(() => {}, 1000);
} else {
  const stdinText = flags.get('--stdin') === true ? fs.readFileSync(0, 'utf8') : '';
  const text = flags.get('--stdin') === true ? stdinText : String(flags.get('--text') ?? '');

  if (flags.get('--echo-argv') === true) {
    fs.writeFileSync(outPath, JSON.stringify({ argv, stdinText }, null, 0));
  } else if (flags.has('--wav')) {
    const ms = Number(flags.get('--wav')) || 100;
    // 24kHz / 16bit / 单声道：byteRate = 48000，data 字节数 = ms × 48。
    const dataBytes = Math.round(ms * 48);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);
    fs.writeFileSync(outPath, Buffer.concat([header, Buffer.alloc(dataBytes)]));
  } else {
    // 假音频 = '[<文本>]'：每段的文本直接可见，拼接顺序可断言。
    fs.writeFileSync(outPath, `[${text}]`);
  }
}
