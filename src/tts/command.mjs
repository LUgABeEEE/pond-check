/**
 * pond-check · 能力层 C4：command adapter（src/tts/command.mjs）
 *
 * 调用户自己装的 TTS 命令行（piper / espeak / say …）：本地、零成本、离线可用。
 * 命令**由配置给模板**，adapter 不猜参数风格 —— 不同 CLI 的参数千奇百怪，
 * 模板是用户对自己那条命令最诚实的表达：
 *
 *   command: ['piper', '--model', '{voice}', '--output_file', '{out}']  // 文本走 stdin
 *   command: 'espeak -v {voice} -s 160 -w {out} {text}'                 // 字符串也行
 *
 * 占位符（逐段替换，互不重扫）：
 *   {out} 输出文件路径（该段的临时文件）  {text} 该段文本
 *   {voice} 逻辑音色经 voiceMap 映射后的名字  {speed} speak() 收到的倍速数字
 *   {format} mp3 / wav / ogg
 *
 * **不走 shell**：字符串模板用 tokenizeCommand 按引号规则切词，然后 execFile
 * 直接执行 argv —— 没有 sh -c，也就没有注入面（rules.json 的 forbiddenExec
 * 红线照旧成立：src 里永远不会出现执行 shell 的代码）。代价是模板里不能用
 * 管道/重定向 —— 要复杂管道请写个小脚本，模板里指向那个脚本。
 *
 * 测试用假 runner / 假 shell 片段（echo 到文件）验证调用链，不要求机器上
 * 真装了 piper。
 *
 * 硬约束：不联网；失败带「哪个 provider、什么错」；分段逐段跑 CLI 再拼接。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { concatAudio, audioDurationMs } from './segment.mjs';

/** 模板占位符（一次替换成型，替换结果不会被再次扫描）。 */
export const COMMAND_PLACEHOLDERS = Object.freeze(['out', 'text', 'voice', 'speed', 'format']);

const PLACEHOLDER_PATTERN = /\{(out|text|voice|speed|format)\}/g;

/**
 * 把命令字符串切成 argv（支持 ' " 引号与反斜杠转义，不支持管道/重定向 ——
 * 那是 shell 的活，这里故意没有 shell）。
 *
 * @param {string} input
 * @returns {string[]}
 */
export function tokenizeCommand(input) {
  if (typeof input !== 'string') throw new TypeError('tokenizeCommand: input 必须是字符串');
  const tokens = [];
  let current = '';
  let quote = null;
  let tokenStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && (input[index + 1] === '"' || input[index + 1] === '\\')) {
        // 双引号内仅 \" \\ 是转义（POSIX 语义的子集，够模板用）。
        current += input[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === '\\' && index + 1 < input.length) {
      current += input[index + 1];
      index += 1;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (tokenStarted || current !== '') {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    tokenStarted = true;
    current += char;
  }
  if (quote) throw new TypeError('tokenizeCommand: 引号没有闭合');
  if (tokenStarted || current !== '') tokens.push(current);
  return tokens;
}

/**
 * 占位符替换（同时替换：{text} 的内容里出现 {out} 不会被二次替换）。
 * @param {string[]} template argv 模板
 * @param {Record<string, string|number>} vars
 * @returns {string[]}
 */
export function fillTemplate(template, vars) {
  return template.map((item) => String(item).replace(
    PLACEHOLDER_PATTERN,
    (_, key) => String(vars[key] ?? ''),
  ));
}

/** 文件是否可执行（存在 + X_OK）。 */
function executableExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测 CLI 在不在（providers() 的 available 就是它）。
 * @param {string} file 可执行文件名或路径
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function binaryAvailable(file, env = process.env) {
  if (typeof file !== 'string' || file.trim() === '') return false;
  const target = file.trim();
  if (target.includes('/') || target.includes('\\')) return executableExists(target);
  const pathVar = typeof env.PATH === 'string' ? env.PATH : (typeof env.Path === 'string' ? env.Path : '');
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir !== '' && executableExists(path.join(dir, target))) return true;
  }
  return false;
}

/** 默认执行器：execFile（不经 shell），signal 来自统一调用器的超时，文本可走 stdin。 */
export function defaultCommandRunner(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });

    // stdin 模式：把该段文本喂给子进程并收口（不喂的话 CLI 会一直等）。
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // 子进程提前退出导致的 EPIPE 不该盖过真正的结果。
      });
      child.stdin.end(String(options.stdin));
    }
  });
}

/**
 * 造 command provider 描述。
 *
 * @param {object} config
 * @param {string|string[]} config.command 命令模板（argv 数组或字符串）
 * @param {boolean} [config.stdin] true 则文本走 stdin（{text} 占位符就用不上）
 * @param {Record<string,string>} [config.voiceMap] 逻辑音色 → CLI 参数里的名字
 * @param {string[]} [config.formats] 该 CLI 支持的输出格式（缺省全支持）
 * @param {number} [config.priority] 降级链优先级（缺省 20：本地兜底排在 edge 后）
 * @param {boolean|(() => boolean)} [config.available] 覆盖可用性探测
 * @param {Function} [config.runner] 测试注入的执行器
 * @param {Record<string,string|undefined>} [config.env] 额外环境变量
 * @param {number} [config.timeoutMs] execFile 自身的兜底 kill 超时
 * @param {string} [config.id] provider id（缺省 'command'）
 * @param {string} [config.name] 展示名
 * @returns {object} provider 描述（含 run()）
 */
export function createCommandProvider(config = {}) {
  const rawCommand = config.command;
  const template = Array.isArray(rawCommand)
    ? rawCommand.map((item) => String(item))
    : (typeof rawCommand === 'string' ? tokenizeCommand(rawCommand) : null);
  if (!template || template.length === 0) {
    throw new TypeError('createCommandProvider: config.command 必须是 argv 数组或命令字符串');
  }

  const id = typeof config.id === 'string' && config.id.trim() !== '' ? config.id.trim() : 'command';
  const name = typeof config.name === 'string' && config.name.trim() !== '' ? config.name : `本地命令（${template[0]}）`;
  const voiceMap = config.voiceMap ?? {};
  const formats = Array.isArray(config.formats) && config.formats.length > 0 ? [...config.formats] : ['mp3', 'wav', 'ogg'];
  const priority = Number.isFinite(config.priority) ? config.priority : 20;
  const runner = typeof config.runner === 'function' ? config.runner : defaultCommandRunner;
  const binary = template[0];

  const checkAvailable = () => {
    if (typeof config.available === 'function') return config.available() === true;
    if (typeof config.available === 'boolean') return config.available;
    return binaryAvailable(binary, config.env ?? process.env);
  };

  return {
    id,
    name,
    local: true,
    requires: ['binary'],
    cost: { unit: 'perCall', value: 0 }, // 本地 CLI：电费不算钱（estimateCost 对本地恒 0）
    caps: formats,
    priority,
    voices: Object.entries(voiceMap).map(([logical, cliName]) => ({
      id: logical,
      name: String(cliName),
      provider: id,
      gender: null,
      langs: [],
    })),
    checkAvailable,
    availableReason: `命令模板指向 ${binary}`,

    /**
     * @param {{text: string, segments: string[], voice?: string, emotion?: string, speed?: number, format: string, outPath: string}} args
     * @param {{signal?: AbortSignal}} ctx
     */
    async run(args, ctx = {}) {
      const multi = args.segments.length > 1;
      const partPaths = [];
      const chunks = [];

      try {
        for (let index = 0; index < args.segments.length; index += 1) {
          const segment = args.segments[index];
          const partPath = multi ? `${args.outPath}.part${index}` : args.outPath;
          partPaths.push(partPath);

          const argv = fillTemplate(template, {
            out: partPath,
            text: segment,
            voice: voiceMap[args.voice] ?? args.voice ?? '',
            speed: args.speed ?? 1,
            format: args.format,
          });
          const vars = {
            file: argv[0],
            args: argv.slice(1),
            stdin: config.stdin === true ? segment : undefined,
            signal: ctx.signal,
            env: config.env ? { ...process.env, ...config.env } : undefined,
            timeoutMs: config.timeoutMs,
          };

          try {
            await runner(vars.file, vars.args, vars);
          } catch (error) {
            // 原因放最前、命令行放最后：统一调用器会把 reason 截到 300 字符，
            // 真正有用的（退出码 + stderr）必须活在截断线以前。
            const stderrText = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
            const reason = stderrText !== ''
              ? `${error?.code ? `exit ${error.code}` : '执行失败'}（stderr: ${stderrText.slice(0, 200)}）`
              : `${error?.message ?? error}`;
            const cmdline = `${vars.file} ${vars.args.join(' ')}`.slice(0, 160);
            const wrapped = new Error(`${id} provider 执行失败：${reason}（命令：${cmdline}）`);
            wrapped.category = error?.category ?? undefined;
            wrapped.cause = error;
            throw wrapped;
          }

          const produced = await fsp.readFile(partPath).catch(() => null);
          if (!produced || produced.length === 0) {
            const error = new Error(`${id} provider：命令跑完但 ${partPath} 不存在或为空（模板的 {out} 有没有传给 CLI？）`);
            error.category = 'format';
            throw error;
          }
          chunks.push(produced);
        }

        const audio = concatAudio(chunks, args.format);
        if (multi) {
          await fsp.writeFile(args.outPath, audio);
        }
        // 时长从最终音频算：wav 从头精确，其余按码率估算并标 estimated。
        const { durationMs, estimated } = audioDurationMs(audio, args.format);

        return {
          path: args.outPath,
          format: args.format,
          durationMs,
          estimated,
          chars: args.text.length,
        };
      } finally {
        if (multi) {
          for (const partPath of partPaths) {
            await fsp.unlink(partPath).catch(() => {});
          }
        }
      }
    },
  };
}
