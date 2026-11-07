/**
 * pond-check · 能力层 C5：图片落盘与格式识别（src/image/output.mjs）
 *
 * 三条硬规则（规格 §5）：
 *
 *   1. **图片写 `<POND_HOME>/out/`**（默认 `~/.pond/out/`），或调用方显式给的
 *      `outPath`；**绝不写进 pond-check 仓库** —— 这条由 `resolveImageOutPath()`
 *      在真正写盘之前拦（显式路径违反也拒绝，不是"默认才守"）。
 *   2. 落盘是「先写同目录临时文件、再 rename」：中途失败不会留下半张图让上层
 *      误以为成功；临时文件失败时清掉。
 *   3. 宽高以**实际图片**为准：从 PNG/GIF/JPEG/WebP 头里读，读不到才退回请求值。
 *      provider 说 1024×1024 不算数，文件里是多少就是多少。
 *
 * 硬约束：不联网、零依赖（只用 node:fs / node:path / node:crypto）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolvePondHome } from '../shared/paths.mjs';
import { ImageError, ImagePathError, ImageProviderError, ImageWriteError } from './errors.mjs';

/**
 * pond-check 包根目录（本文件在 src/image/ 下）。
 * 图片是用户资产，不写回代码仓库 —— 显式 outPath 指进来也拒绝。
 */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * target 是否在 root 里面（含 root 本身）。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '') return true;
  return !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

/**
 * 从图片头识别格式与真实像素尺寸（只读前几十字节，不解码整张图）。
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{format: string, ext: string, mime: string, width: number|null, height: number|null}|null}
 */
export function detectImageFormat(input) {
  if (!Buffer.isBuffer(input)) {
    if (!(input instanceof Uint8Array)) return null;
    input = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  const data = input;

  // PNG：89 50 4E 47 0D 0A 1A 0A，IHDR 宽高在 16/20 字节（大端）。
  if (data.length >= 24
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return {
      format: 'png',
      ext: 'png',
      mime: 'image/png',
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  }

  // GIF：GIF87a / GIF89a，宽高在 6/8 字节（小端）。
  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'GIF') {
    return {
      format: 'gif',
      ext: 'gif',
      mime: 'image/gif',
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    };
  }

  // JPEG：FF D8 开头，扫 SOF0/1/2/3/5/6/7/9/10/11/13/14/15 段读宽高。
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    let width = null;
    let height = null;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      const size = data.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        height = data.readUInt16BE(offset + 5);
        width = data.readUInt16BE(offset + 7);
        break;
      }
      if (size < 2) break;
      offset += 2 + size;
    }
    return { format: 'jpeg', ext: 'jpg', mime: 'image/jpeg', width, height };
  }

  // WebP：RIFF....WEBP，VP8X 里是 24 位宽高（减 1 存储）。
  if (data.length >= 16
    && data.toString('ascii', 0, 4) === 'RIFF'
    && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.toString('ascii', 12, 16) === 'VP8X' && data.length >= 30) {
      return {
        format: 'webp',
        ext: 'webp',
        mime: 'image/webp',
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    }
    return { format: 'webp', ext: 'webp', mime: 'image/webp', width: null, height: null };
  }

  return null;
}

/** 自动文件名：`image-<UTC 时间戳>-<随机 hex>.<ext>`（按名字排序即按时间排序）。 */
export function autoImageName({ format = 'png', now = Date.now(), randomHex } = {}) {
  const ext = typeof format === 'string' && /^[a-z0-9]{2,5}$/u.test(format) ? format : 'png';
  const stamp = new Date(now).toISOString().replace(/[-:]/gu, '').replace(/\..+$/u, '');
  const random = typeof randomHex === 'function' ? randomHex() : randomBytes(4).toString('hex');
  return `image-${stamp}-${random}.${ext}`;
}

/**
 * 决定图片写到哪。
 *
 * @param {object} [options]
 * @param {string|null} [options.outPath] 调用方显式路径（目录会补自动文件名）
 * @param {Record<string,string|undefined>} [options.env]
 * @param {string|null} [options.outDir] 配置里的输出目录（绝对路径）
 * @param {string} [options.format] 图片格式（决定扩展名）
 * @param {number} [options.now]
 * @param {() => string} [options.randomHex] 测试注入
 * @returns {string} 绝对路径
 * @throws {ImagePathError} 目标落在仓库内
 * @throws {ImageInputError} outPath 非法
 */
export function resolveImageOutPath(options = {}) {
  const format = typeof options.format === 'string' ? options.format.toLowerCase() : 'png';
  const now = Number.isFinite(options.now) ? options.now : Date.now();

  let target;
  if (options.outPath !== undefined && options.outPath !== null) {
    if (typeof options.outPath !== 'string' || options.outPath.trim() === '') {
      throw new ImagePathError(
        `outPath 必须是非空字符串，收到 ${options.outPath === null ? 'null' : typeof options.outPath}`,
      );
    }
    target = path.resolve(options.outPath.trim());
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(target).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory || options.outPath.trim().endsWith(path.sep)) {
      target = path.join(target, autoImageName({ format, now, randomHex: options.randomHex }));
    } else if (path.extname(target) === '') {
      target = `${target}.${format}`;
    }
  } else {
    const dir = options.outDir
      ? path.resolve(options.outDir)
      : path.join(resolvePondHome(options.env ?? process.env), 'out');
    target = path.join(dir, autoImageName({ format, now, randomHex: options.randomHex }));
  }

  if (isInside(PACKAGE_ROOT, target)) {
    throw new ImagePathError(
      `图片目标路径落在 pond-check 仓库内（${target}）—— 图片不许写进仓库`,
      { path: target },
    );
  }
  return target;
}

/**
 * 写图片：mkdir -p → 同目录临时文件 → rename。
 *
 * @param {Buffer} data
 * @param {string} target 已通过 resolveImageOutPath 检查的绝对路径
 * @returns {Promise<string>}
 */
export async function writeImageFile(data, target) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new ImageProviderError('图片数据为空，拒绝落盘', { provider: 'image', category: 'format' });
  }
  if (typeof target !== 'string' || target.trim() === '') {
    throw new ImageError('writeImageFile: target 必须是非空路径');
  }

  const directory = path.dirname(target);
  const temp = path.join(directory, `.${path.basename(target)}.part-${process.pid}-${randomBytes(3).toString('hex')}`);
  try {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(temp, data);
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw new ImageWriteError(`图片写入失败（${target}）：${error?.message ?? error}`, {
      path: target,
      cause: error,
    });
  }
  return target;
}
