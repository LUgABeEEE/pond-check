/**
 * pond-check · 能力层 C5：图生成错误类型（src/image/errors.mjs）
 *
 * 为什么单独一类而不是到处 `new Error('...')`：
 *   1. 调用方要能**按类别**决策（配置写坏了 → 直接修；provider 挂了 → 换一个）；
 *   2. `src/shared/call.mjs` 的 `classifyError` 会读 `err.category` / `err.status`，
 *      自定义错误必须把这两个字段说清楚，否则降级链会把它当 `unknown`；
 *   3. 错误消息里**绝不能出现 API key**（openai-compat 的错误文本会先脱敏）。
 *
 * 硬约束：本文件不联网、不读盘、零依赖。
 */

/** 图生成能力的基础错误：带机器可读的 `code` 与附加上下文。 */
export class ImageError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, cause?: unknown} & Record<string, unknown>} [detail]
   */
  constructor(message, { code = 'IMAGE_ERROR', cause, ...detail } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    for (const [key, value] of Object.entries(detail)) {
      if (value !== undefined) this[key] = value;
    }
  }
}

/** 入参不合格（空提示词、非法 seed、非法 size…）——这是调用方的编程错误，不重试。 */
export class ImageInputError extends ImageError {
  constructor(message, detail = {}) {
    super(message, { code: 'IMAGE_INVALID_INPUT', ...detail });
  }
}

/** 配置写坏了（JSON 语法、工作流缺占位符、inject 路径不存在…）——要立刻响，不静默兜底。 */
export class ImageConfigError extends ImageError {
  constructor(message, detail = {}) {
    super(message, { code: 'IMAGE_CONFIG', ...detail });
  }
}

/** 出图目标路径不安全（例如落在 pond-check 仓库里）。 */
export class ImagePathError extends ImageError {
  constructor(message, detail = {}) {
    super(message, { code: 'IMAGE_PATH_UNSAFE', ...detail });
  }
}

/** 图片落盘失败（磁盘满 / 没权限 / 父目录是文件）。 */
export class ImageWriteError extends ImageError {
  constructor(message, detail = {}) {
    super(message, { code: 'IMAGE_WRITE_FAILED', ...detail });
  }
}

/**
 * provider 返回了错误（HTTP 非 2xx / 响应缺字段 / 工作流执行失败）。
 * `status` 与 `category` 会交给 shared 的 classifiyError 决定「重试还是降级」。
 */
export class ImageProviderError extends ImageError {
  /**
   * @param {string} message
   * @param {{provider?: string, status?: number|null, category?: string, cause?: unknown}} [detail]
   */
  constructor(message, { provider, status = null, category, cause } = {}) {
    super(message, { code: 'IMAGE_PROVIDER_ERROR', cause, provider, status, category });
    // 兼容 shared.classifyError 读到的 `statusCode`（它先看 status，再看 statusCode）。
    if (status !== null) this.statusCode = status;
  }
}

/**
 * 单次尝试超时。显式标 `category: 'timeout'` —— shared 的调用器据此**不重试**
 * （再等一遍只会把用户的等待翻倍，正确反应是换下一个 provider）。
 */
export class ImageTimeoutError extends ImageError {
  constructor(message, detail = {}) {
    super(message, { code: 'IMAGE_TIMEOUT', category: 'timeout', ...detail });
  }
}

/**
 * 本地服务不可达（ComfyUI 不在线）。
 *
 * 关键语义：**这不是"能力失败"，是"这一档不可用"**。错误被显式归为 `network`，
 * 交给调用器重试一次后**降级到云**，最终 `generate()` 仍然成功并标 `degradedFrom`。
 */
export class LocalUnavailableError extends ImageError {
  constructor(message, { provider, cause } = {}) {
    super(message, { code: 'LOCAL_UNAVAILABLE', category: 'network', provider, cause });
  }
}
