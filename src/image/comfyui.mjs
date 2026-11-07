/**
 * pond-check · 能力层 C5：ComfyUI adapter（src/image/comfyui.mjs）
 *
 * ComfyUI 是**本地**首选（有显卡时零 API 成本）。它暴露的是 HTTP 接口
 * （默认 `http://127.0.0.1:8188`），所以仍然走内置 fetch，只是打的是 loopback。
 *
 * 调用序列：
 *
 *   POST /prompt              { prompt: <工作流对象>, client_id }   → { prompt_id }
 *   GET  /history/<prompt_id>                                     → outputs.<node>.images[]
 *   GET  /view?filename=…&subfolder=…&type=output                  → 图片二进制
 *
 * 三条关键语义：
 *
 *   1. **本地不可达不能算失败**：连接被拒 / 服务没起 → 抛 `LocalUnavailableError`
 *      （category=network）。shared 调用器重试 1 次后**降级到云**，最终
 *      `generate()` 仍然成功，并标 `degradedFrom: 'comfyui'`。
 *      （测试的变异验证就是把这条改成"不可达就抛出去"，对应用例必须红。）
 *   2. **seed 能注入就回传同一个**：工作流里有 `{{seed}}` 或 `inject.seed` 才算
 *      能注入；没有注入点时回传 `seed: null` 并说明原因，不假装能复现。
 *   3. **工作流由配置指定**，adapter 不含任何硬编码工作流；配置写坏在建客户端时
 *      就抛 `ImageConfigError`，不拖到生成时静默降级。
 *
 * 硬约束：不 import node:http 等网络模块；请求一律通过注入的 `transport`。
 */

import { randomInt } from 'node:crypto';

import {
  ImageConfigError,
  ImageProviderError,
  ImageTimeoutError,
} from './errors.mjs';
import { detectImageFormat } from './output.mjs';
import { hasPlaceholder, instantiateWorkflow, instantiateWorkflowString, validateWorkflowTemplate } from './workflow.mjs';
import { readBinary, readJson, send } from './transport.mjs';

/** provider 元信息（成本口径写死 perImage=0：本地只花电费）。 */
export const COMFY_PROVIDER_ID = 'comfyui';

/** 默认优先级（本地优先；配置里的 chain 顺序会覆盖它）。 */
export const COMFY_PRIORITY = 50;

/** ComfyUI 的 seed 是 64 位整数，但 JS 侧只用安全整数。 */
// crypto.randomInt 的上界必须 < 2^48（写 2**48 会抛 RangeError）。
const MAX_SEED = 2 ** 48 - 1;

function randomSeed() {
  return randomInt(0, MAX_SEED);
}

function summarizeFailure(status) {
  if (!status || typeof status !== 'object') return '未知原因';
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const parts = [];
  for (const message of messages) {
    if (Array.isArray(message) && message.length >= 2 && message[1] && typeof message[1] === 'object') {
      const detail = message[1];
      const text = detail.exception_message ?? detail.error ?? detail.message;
      if (text) parts.push(String(text));
    }
  }
  return parts.length > 0 ? parts.join('；').slice(0, 300) : '工作流执行失败';
}

function collectImages(entry) {
  const outputs = entry?.outputs;
  if (!outputs || typeof outputs !== 'object') return [];
  const images = [];
  for (const node of Object.values(outputs)) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.images)) continue;
    for (const image of node.images) {
      if (image && typeof image.filename === 'string' && image.filename !== '') images.push(image);
    }
  }
  // 优先正式输出（type=output），临时预览放后面。
  return images.sort((a, b) => {
    const weight = (item) => (item.type === 'output' || item.type === undefined ? 0 : 1);
    return weight(a) - weight(b);
  });
}

/**
 * 造 ComfyUI provider（每个客户端一个实例，配置绑在闭包里，不靠全局状态）。
 *
 * @param {object} config 规范化后的 comfyui 配置
 * @param {{transport: Function, sleep: Function, now: Function}} ctx
 * @returns {object} provider 描述（含 run）
 * @throws {ImageConfigError} 工作流配置写坏
 */
export function createComfyProvider(config, ctx) {
  // 预检：缺 {{prompt}}、inject 路径不存在、字符串模板不是 JSON —— 全部在
  // createImageClient() 时就炸，而不是生成时静默降级到云把配置错误藏起来。
  validateWorkflowTemplate(config.workflow, { inject: config.inject });

  const hasWorkflow = config.workflow !== null && config.workflow !== undefined;
  const seedInjectable = hasWorkflow
    && (hasPlaceholder(config.workflow, 'seed') || Boolean(config.inject.seed));

  const baseUrl = config.baseUrl;
  const label = 'ComfyUI 本地服务';

  async function run(args, runCtx = {}) {
    const { transport, sleep, now } = ctx;
    const { signal } = runCtx;

    if (!hasWorkflow) {
      throw new ImageConfigError('comfyui 未配置工作流（comfyui.workflow / workflowPath）');
    }

    const seed = args.seed ?? randomSeed();
    const fields = {
      prompt: args.prompt,
      negative: args.negative ?? '',
      seed,
      width: args.width,
      height: args.height,
    };

    let workflow;
    try {
      workflow = typeof config.workflow === 'string'
        ? instantiateWorkflowString(config.workflow, fields, { inject: config.inject })
        : instantiateWorkflow(config.workflow, fields, { inject: config.inject });
    } catch (error) {
      if (error instanceof ImageConfigError) throw error;
      throw new ImageConfigError(`ComfyUI 工作流实例化失败：${error?.message ?? error}`, { cause: error });
    }

    // 1) 提交任务。连不上会抛 LocalUnavailableError（→ 调用器降级到云）。
    const submitResponse = await send(
      transport,
      `${baseUrl}/prompt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: config.clientId }),
      },
      { provider: COMFY_PROVIDER_ID, label, signal, timeoutMs: config.connectTimeoutMs },
    );
    const submitted = await readJson(submitResponse, { provider: COMFY_PROVIDER_ID, label });
    const promptId = submitted?.prompt_id;
    if (typeof promptId !== 'string' || promptId === '') {
      throw new ImageProviderError('ComfyUI /prompt 没有返回 prompt_id', {
        provider: COMFY_PROVIDER_ID,
        category: 'format',
      });
    }

    // 2) 轮询历史。
    const deadline = now() + config.timeoutMs;
    let image = null;
    for (;;) {
      if (signal?.aborted) {
        throw new ImageTimeoutError('ComfyUI 生成被上层取消（超出能力超时）', { provider: COMFY_PROVIDER_ID });
      }

      const historyResponse = await send(
        transport,
        `${baseUrl}/history/${encodeURIComponent(promptId)}`,
        { method: 'GET' },
        { provider: COMFY_PROVIDER_ID, label, signal, timeoutMs: config.connectTimeoutMs },
      );
      const history = await readJson(historyResponse, { provider: COMFY_PROVIDER_ID, label });
      const entry = history?.[promptId];

      const images = collectImages(entry);
      if (images.length > 0) {
        [image] = images;
        break;
      }
      if (entry?.status?.status_str === 'error') {
        throw new ImageProviderError(
          `ComfyUI 工作流执行失败：${summarizeFailure(entry.status)}`,
          { provider: COMFY_PROVIDER_ID, category: 'format' },
        );
      }
      if (now() >= deadline) {
        throw new ImageTimeoutError(
          `ComfyUI 生成超时（${config.timeoutMs}ms）`,
          { provider: COMFY_PROVIDER_ID },
        );
      }
      await sleep(config.pollIntervalMs);
    }

    // 3) 下载图片。
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder ?? '',
      type: image.type ?? 'output',
    });
    const fileResponse = await send(
      transport,
      `${baseUrl}/view?${query.toString()}`,
      { method: 'GET' },
      { provider: COMFY_PROVIDER_ID, label, signal, timeoutMs: config.connectTimeoutMs },
    );
    const data = await readBinary(fileResponse, { provider: COMFY_PROVIDER_ID, label });
    const detected = detectImageFormat(data);

    return {
      data,
      width: detected?.width ?? args.width,
      height: detected?.height ?? args.height,
      seed: seedInjectable ? seed : null,
      seedReproducible: seedInjectable,
      seedNote: seedInjectable
        ? null
        : 'comfyui 工作流没有 seed 注入点（{{seed}} 占位符或 comfyui.inject.seed），无法复现同一张图',
      format: detected?.format ?? 'png',
    };
  }

  return {
    id: COMFY_PROVIDER_ID,
    name: 'ComfyUI（本地）',
    local: true,
    requires: ['network'],
    cost: { unit: 'perImage', value: 0 },
    caps: ['png', 'jpeg', 'webp', 'workflow'],
    priority: COMFY_PRIORITY,
    sizes: [...config.sizes],
    available: hasWorkflow,
    unavailableReason: hasWorkflow ? null : '未配置 comfyui.workflow / comfyui.workflowPath（工作流由配置指定）',
    seedInjectable,
    run,
  };
}

/** 仅供测试/诊断：识别「本地不可达」错误（按 code，不依赖类名）。 */
export function isLocalUnavailable(error) {
  return Boolean(error) && error.code === 'LOCAL_UNAVAILABLE';
}
