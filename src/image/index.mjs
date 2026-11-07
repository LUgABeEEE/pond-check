/**
 * pond-check · 能力层 C5：图生成统一接口（src/image/index.mjs）
 *
 *   await generate(prompt, {
 *     size,        // '1024x1024' 或 { width, height }
 *     aspect,      // '1:1' | '4:3' | …（size 优先）
 *     style,       // anime | photo | pixel | illustration
 *     negative,    // 负向提示词
 *     seed,        // 给了就尽量复现；复现不了回传 null 并说明
 *     outPath,     // 不传则写 <POND_HOME>/out/；仓库内路径会被拒
 *   }) → { path, width, height, provider, seed, degraded?, degradedFrom?, … }
 *
 *   providers() → [{ id, name, sizes, cost, local, available }]
 *
 * 实现要点：
 *   - 降级链由 `config.chain` 决定（默认 `comfyui → openai-compat`，本地优先）；
 *     每个 provider 的 priority 按 chain 顺序赋值，registry 负责排序。
 *   - 走 shared 的 `invoke()`：超时、网络重试、失败归类、事件记账、`degradedFrom`
 *     全部复用 C1 的基座，不在这里另写一套。
 *   - **本地不可达不是失败**：comfyui 抛网络错误 → 重试 1 次 → 切到云；最终结果
 *     成功并带 `degraded: true` / `degradedFrom: 'comfyui'`。
 *   - 图片落盘在**拿到图片之后**才做：provider 只负责返回 buffer，路径策略只有
 *     一份（output.mjs），这样「绝不写进仓库」只有一处需要守。
 *   - 事件流仍然是 `<POND_HOME>/events.jsonl`（唯一接缝），事件里只有 provider id，
 *     没有提示词、没有 API key、没有图片内容。
 *
 * 测试纪律：tests/image.test.mjs 全程注入假 transport，并把 `globalThis.fetch`
 * 换成「一调用就抛」。任何漏网的真网络请求都会立刻炸出来。
 */

import { createRegistry } from '../shared/registry.mjs';
import { CapabilityError, invoke } from '../shared/call.mjs';

import { loadImageConfig, normalizeImageConfig } from './config.mjs';
import { createComfyProvider } from './comfyui.mjs';
import { createOpenAICompatProvider } from './openai-compat.mjs';
import { createSeedreamProvider } from './seedream.mjs';
import { createDoubaoImageProvider } from './doubao.mjs';
import { detectImageFormat, resolveImageOutPath, writeImageFile } from './output.mjs';
import { composePrompt, normalizeSeed, parseSize } from './prompt.mjs';
import { ImageInputError } from './errors.mjs';

/** 能力名（事件流里的 capability 字段、shared 超时表的键）。 */
export const IMAGE_CAPABILITY = 'image';

/** 内置 adapter（C5：comfyui / openai-compat；C6 云：seedream / doubao）。 */
export const BUILTIN_IMAGE_PROVIDERS = Object.freeze(['comfyui', 'openai-compat', 'seedream', 'doubao']);

/** 默认 transport：内置 fetch。adapter 只认这个函数签名，测试注入假实现。 */
const defaultTransport = (url, init) => fetch(url, init);

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 默认告警口（配置里写了未知 provider 之类）。测试传 warn 捕获。 */
function defaultWarn(message) {
  console.warn(`[pond/image] ${message}`);
}

/** 把 provider 描述裁剪成对外的公开信息（不含 run、不含任何密钥）。 */
function providerInfo(provider) {
  const info = {
    id: provider.id,
    name: provider.name,
    sizes: [...provider.sizes],
    cost: { ...provider.cost },
    local: provider.local === true,
    available: provider.available !== false,
  };
  if (info.available === false && typeof provider.unavailableReason === 'string') {
    info.unavailableReason = provider.unavailableReason;
  }
  return info;
}

/**
 * 按配置组装 provider 列表。chain 里的顺序 → priority；没进 chain 的也注册，
 * 这样 `providers()` 能看到「有这个能力但没启用」。
 */
function buildProviders(config, ctx) {
  const builtin = new Map([
    ['comfyui', createComfyProvider(config.comfyui, ctx)],
    ['openai-compat', createOpenAICompatProvider(config.openaiCompat, ctx)],
    // C6 云 adapter：始终登记；没配 key 时 available=false，generate 的
    // 可用性过滤会把它们跳过 —— 不报错、不崩、不碰网络（有 key 才需要，规格 §7）。
    ['seedream', createSeedreamProvider(config.seedream, ctx)],
    ['doubao', createDoubaoImageProvider(config.doubao, ctx)],
  ]);

  const list = [];
  const chain = config.chain;
  chain.forEach((id, index) => {
    const provider = builtin.get(id);
    if (!provider) {
      ctx.warn(`chain 里的 provider '${id}' 没有内置 adapter（C5 内置：${BUILTIN_IMAGE_PROVIDERS.join(' / ')}），已跳过`);
      return;
    }
    list.push({ ...provider, priority: (chain.length - index) * 10 });
  });
  for (const [id, provider] of builtin) {
    if (!chain.includes(id)) list.push({ ...provider, priority: 0 });
  }
  return list;
}

/**
 * 造一个图生成客户端。所有依赖（transport / sleep / now / env）可注入 ——
 * 测试用它做到「零真实网络、零真实等待」。
 *
 * @param {object} [options]
 * @param {object} [options.config] 显式配置对象（优先于配置文件）
 * @param {string} [options.configPath] 显式配置文件路径
 * @param {Record<string,string|undefined>} [options.env] 环境变量（POND_HOME / API key / POND_IMAGE_CONFIG）
 * @param {(url: string, init?: object) => Promise<Response>} [options.transport]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.warn]
 * @param {string} [options.eventsPath] 显式事件文件路径（测试隔离）
 * @param {boolean} [options.recordEvents] 是否记账（缺省 true）
 * @param {number} [options.timeoutMs] 覆盖单次能力超时
 * @param {number} [options.maxRetries] 覆盖每个 provider 的重试次数
 * @param {number} [options.backoffMs] 覆盖重试退避基数
 * @returns {{generate: Function, providers: Function, chain: Function, registry: object, getConfig: Function}}
 */
export function createImageClient(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config !== undefined
    ? normalizeImageConfig(options.config, { filePath: null, env })
    : loadImageConfig({ env, configPath: options.configPath ?? null });

  const transport = options.transport ?? defaultTransport;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? defaultWarn;

  const registry = createRegistry();
  registry.registerAll(IMAGE_CAPABILITY, buildProviders(config, { transport, sleep, now, env, warn }));

  const chainIds = [...config.chain];

  /** 当前 chain 里**声明过**的 provider（含不可用的，用来报"为什么没有可用 provider"）。 */
  function chainProviders() {
    const seen = new Set();
    const out = [];
    for (const id of chainIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const provider = registry.get(IMAGE_CAPABILITY, id);
      if (provider) out.push(provider);
    }
    return out;
  }

  function providers() {
    return registry.list(IMAGE_CAPABILITY).map(providerInfo);
  }

  function chain() {
    return [...chainIds];
  }

  /** 返回一份脱敏后的配置副本（便于诊断；API key 永远不外露）。 */
  function getConfig() {
    const clone = JSON.parse(JSON.stringify({
      ...config,
      comfyui: { ...config.comfyui, workflow: config.comfyui.workflow },
      openaiCompat: { ...config.openaiCompat },
    }));
    for (const section of ['openaiCompat', 'seedream', 'doubao']) {
      if (clone?.[section]) {
        clone[section].apiKey = config[section].apiKey ? '[已隐藏]' : null;
      }
    }
    return clone;
  }

  /**
   * 生成一张图。
   *
   * @param {string} prompt
   * @param {object} [generateOptions] 见文件头；额外支持 `randomHex` 便于测试确定文件名
   * @returns {Promise<{path: string, width: number, height: number, provider: string, seed: number|null, degraded?: true, degradedFrom?: string, seedReproducible: boolean, seedNote?: string, costEstimate: number, units: number}>}
   * @throws {ImageInputError} 入参不合格
   * @throws {ImagePathError} 输出路径不安全（仓内）
   * @throws {CapabilityError} 所有 provider 都不可用或都失败
   */
  async function generate(prompt, generateOptions = {}) {
    if (generateOptions === null || typeof generateOptions !== 'object' || Array.isArray(generateOptions)) {
      throw new ImageInputError('generate 的第二个参数必须是对象');
    }

    const composed = composePrompt({
      prompt,
      style: generateOptions.style ?? config.defaults.style,
      negative: generateOptions.negative ?? config.defaults.negative,
    });
    const size = parseSize({
      size: generateOptions.size ?? config.defaults.size,
      aspect: generateOptions.aspect ?? config.defaults.aspect,
    });
    const seed = normalizeSeed(generateOptions.seed);

    // 候选链：chain 里声明过、且当前可用的 provider。
    const candidates = chainProviders().filter((provider) => provider.available !== false);
    if (candidates.length === 0) {
      // 不是「没有 provider」而是「每一个都不可用」：把原因逐个列出来，
      // 否则用户只会看到「图生成失败」并去猜。
      const failures = chainProviders().map((provider) => ({
        provider: provider.id,
        attempts: 0,
        category: 'unavailable',
        reason: provider.unavailableReason ?? '不可用',
        durationMs: 0,
        retryable: false,
      }));
      throw new CapabilityError(IMAGE_CAPABILITY, failures);
    }

    // 交给 shared 的调用器：超时 / 重试 / 降级 / 事件全部走基座。
    const outcome = await invoke({
      capability: IMAGE_CAPABILITY,
      providers: candidates,
      args: {
        prompt: composed.prompt,
        negative: composed.negative,
        style: composed.style,
        size: size.label,
        width: size.width,
        height: size.height,
        seed,
      },
      units: () => 1, // 每张图 1 个单位（perImage）
      timeoutMs: generateOptions.timeoutMs ?? options.timeoutMs,
      maxRetries: generateOptions.maxRetries ?? options.maxRetries,
      backoffMs: generateOptions.backoffMs ?? options.backoffMs,
      sleep,
      now,
      env,
      eventsPath: generateOptions.eventsPath ?? options.eventsPath,
      warn,
      recordEvents: generateOptions.recordEvents ?? options.recordEvents,
    });

    const value = outcome.value;
    if (!value || !Buffer.isBuffer(value.data)) {
      // provider 没按约定返回 buffer 属于编程/协议错误，直接抛，不落一张坏图。
      throw new ImageInputError(
        `provider '${outcome.provider}' 没有返回图片数据（内部约定：adapter 必须返回 { data: Buffer }）`,
      );
    }

    const detected = detectImageFormat(value.data);
    const format = detected?.ext ?? value.format ?? 'png';
    const target = resolveImageOutPath({
      outPath: generateOptions.outPath ?? null,
      env,
      outDir: config.outDir,
      format,
      now: now(),
      randomHex: typeof generateOptions.randomHex === 'function' ? generateOptions.randomHex : undefined,
    });
    await writeImageFile(value.data, target);

    const result = {
      path: target,
      width: detected?.width ?? value.width ?? size.width,
      height: detected?.height ?? value.height ?? size.height,
      provider: outcome.provider,
      seed: value.seed ?? null,
      seedReproducible: value.seed !== null && value.seed !== undefined && value.seedReproducible !== false,
      costEstimate: outcome.costEstimate,
      units: outcome.units,
    };

    // degraded 只在「链首没赢」时出现（与 shared 的语义一致）。
    if (outcome.degradedFrom) {
      result.degraded = true;
      result.degradedFrom = outcome.degradedFrom;
    }
    if (typeof value.seedNote === 'string' && value.seedNote !== '') {
      result.seedNote = value.seedNote;
    } else if (result.seed === null) {
      result.seedNote = 'provider 没有回传 seed，无法复现同一张图';
    }
    if (composed.truncated) result.promptTruncated = true;

    return result;
  }

  return { generate, providers, chain, getConfig, registry };
}

/**
 * 进程级便捷接口：每次按当前配置新建客户端（配置很小，读一次文件而已）。
 * 好处是改了 `POND_HOME` / 配置文件立刻生效，不会缓存旧配置。
 *
 * @param {object} [options] 同 createImageClient
 * @returns {Promise<object>} 见 createImageClient().generate
 */
export async function generate(prompt, options = {}) {
  return createImageClient(options).generate(prompt, options);
}

/**
 * @param {object} [options] 同 createImageClient
 * @returns {Array<{id: string, name: string, sizes: string[], cost: object, local: boolean, available: boolean}>}
 */
export function providers(options = {}) {
  return createImageClient(options).providers();
}

export * from './errors.mjs';
export * from './prompt.mjs';
export * from './workflow.mjs';
export * from './output.mjs';
export * from './config.mjs';
export * from './transport.mjs';
export * from './comfyui.mjs';
export * from './openai-compat.mjs';
export * from './generations.mjs';
export * from './seedream.mjs';
export * from './doubao.mjs';
