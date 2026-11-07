/**
 * pond-check · 能力层 C1：Provider 注册表（src/shared/registry.mjs）
 *
 * 五个能力（memory / wake / tts / image，以及未来的其它能力）共用同一套
 * provider 描述（CAPABILITIES-SPEC §2.1）：
 *
 *   {
 *     id: 'edge', name: 'Edge TTS', local: true,
 *     requires: ['network'],                  // network | apiKey | binary
 *     cost: { unit: 'perKChar', value: 0 },   // 成本口径
 *     caps: ['mp3', 'ssml'],                  // 能力声明
 *     priority: 50                            // 越大越优先
 *   }
 *
 * 注册表只做三件事：**登记、校验、排序**。它不执行任何 provider，也不碰网络
 * 或磁盘 —— 执行是 `call.mjs` 的事，写事件是 `events.mjs` 的事。
 *
 * 排序规则（确定性，测试可断言）：
 *   1. `priority` 降序（越大越优先，与规格一致）；
 *   2. 同 priority 按**注册先后**（先注册者优先）—— 不用 id 字典序，因为
 *      「默认降级链」是配置者按顺序写下的意图，字典序会把它打乱；
 *   3. 同 priority 同批次里的本地/云不作隐含偏置：local-first 只能由 priority
 *      显式表达（规格 §2.2 要求降级顺序「写进配置」，不能由实现偷偷决定）。
 *
 * 硬约束：
 *   - 零运行时依赖、不联网、不写盘。
 *   - 不静默接受畸形描述：非法 `requires` / 负成本 / 重复 id 一律抛
 *     `RegistryError`，错误信息指出是哪个能力、哪个字段。
 *   - `register` 默认拒绝覆盖同 id（覆盖会让某条降级链静默变味）；确需覆盖
 *     时显式传 `{ replace: true }`。
 *   - 返回的 provider 一律是**副本**（注册表内部状态不被调用方改写）。
 */

/** 允许的依赖标签（规格 §2.1）。 */
export const REQUIREMENTS = Object.freeze(['network', 'apiKey', 'binary']);

/**
 * 允许的成本口径。`value` 是「每个 unit 块」的单价（元）：
 *   perCall   每次调用        units = 调用次数
 *   perChar   每字符          units = 字符数
 *   perKChar  每千字符        units = 字符数（内部除以 1000）
 *   perImage  每张图          units = 图片张数
 *   perSecond 每秒            units = 秒数
 *   perMinute 每分钟          units = 秒数（内部除以 60）
 * 未列出的口径按 `units × value` 计（units 视为「块数」），不静默归零。
 */
export const COST_UNITS = Object.freeze([
  'perCall', 'perChar', 'perKChar', 'perImage', 'perSecond', 'perMinute',
]);

/** 成本口径 → 除数（units 先除再乘单价）。 */
const COST_SCALARS = Object.freeze({
  perCall: 1,
  perChar: 1,
  perKChar: 1000,
  perImage: 1,
  perSecond: 1,
  perMinute: 60,
});

/** 注册表校验错误：能力层配置写坏了要立刻响，不能静默降级。 */
export class RegistryError extends Error {
  /**
   * @param {string} message
   * @param {{capability?: string, providerId?: string, field?: string}} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'RegistryError';
    this.code = 'REGISTRY_INVALID';
    if (detail.capability !== undefined) this.capability = detail.capability;
    if (detail.providerId !== undefined) this.providerId = detail.providerId;
    if (detail.field !== undefined) this.field = detail.field;
  }
}

/** 成本金额保留 6 位小数，消掉浮点噪声（0.1*3 之类）。 */
export function roundCost(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6) / 1e6;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringArray(value, capability, providerId, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RegistryError(
      `provider ${providerId} (${capability}) 的 ${field} 必须是数组`,
      { capability, providerId, field },
    );
  }
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new RegistryError(
        `provider ${providerId} (${capability}) 的 ${field} 里含非字符串项`,
        { capability, providerId, field },
      );
    }
    const trimmed = item.trim();
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 校验并规范化一个 provider 描述。
 * 未知字段原样保留（adapter 常要带自己的配置，如 voiceMap / workflow），
 * 已知字段以校验后的值为准，防止调用方用 `id: 123` 之类蒙混过关。
 *
 * @param {string} capability
 * @param {object} input
 * @returns {object} 规范化后的副本
 */
export function normalizeProvider(capability, input) {
  if (typeof capability !== 'string' || capability.trim() === '') {
    throw new RegistryError('register: capability 必须是非空字符串', { capability });
  }
  if (!isPlainObject(input)) {
    throw new RegistryError(`register: ${capability} 的 provider 必须是对象`, { capability });
  }

  const { id: rawId } = input;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id) {
    throw new RegistryError(`register: ${capability} 的 provider 缺少非空 id`, { capability, field: 'id' });
  }

  const name = typeof input.name === 'string' && input.name.trim() !== ''
    ? input.name
    : id;

  const local = input.local === undefined ? false : input.local;
  if (typeof local !== 'boolean') {
    throw new RegistryError(`provider ${id} 的 local 必须是布尔值`, { capability, providerId: id, field: 'local' });
  }

  const requires = assertStringArray(input.requires, capability, id, 'requires');
  for (const requirement of requires) {
    if (!REQUIREMENTS.includes(requirement)) {
      throw new RegistryError(
        `provider ${id} 的 requires 含未知依赖 '${requirement}'（允许：${REQUIREMENTS.join(' / ')}）`,
        { capability, providerId: id, field: 'requires' },
      );
    }
  }

  const rawCost = input.cost === undefined ? {} : input.cost;
  if (!isPlainObject(rawCost)) {
    throw new RegistryError(`provider ${id} 的 cost 必须是对象`, { capability, providerId: id, field: 'cost' });
  }
  const unit = rawCost.unit === undefined ? 'perCall' : rawCost.unit;
  if (typeof unit !== 'string' || unit.trim() === '') {
    throw new RegistryError(`provider ${id} 的 cost.unit 必须是非空字符串`, { capability, providerId: id, field: 'cost.unit' });
  }
  if (!COST_UNITS.includes(unit)) {
    // 严格拒绝未知口径：把 'perKChar' 打成 'perKchars' 时若静默按 perCall 算，
    // 记账会差三个数量级且没人发现 —— 这正是「成本指标变成摆设」的典型来源。
    throw new RegistryError(
      `provider ${id} 的 cost.unit '${unit}' 不是已知口径（允许：${COST_UNITS.join(' / ')}）`,
      { capability, providerId: id, field: 'cost.unit' },
    );
  }
  const value = rawCost.value === undefined ? 0 : rawCost.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RegistryError(`provider ${id} 的 cost.value 必须是 >= 0 的有限数字`, { capability, providerId: id, field: 'cost.value' });
  }

  const caps = assertStringArray(input.caps, capability, id, 'caps');

  const priority = input.priority === undefined ? 0 : input.priority;
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new RegistryError(`provider ${id} 的 priority 必须是有限数字`, { capability, providerId: id, field: 'priority' });
  }

  const known = { id, name, local, requires, cost: { unit, value }, caps, priority };
  // 未知字段（含可选的 run()）先铺开，已知字段后覆盖 —— 保证校验过的值胜出。
  const normalized = { ...input, ...known };
  return normalized;
}

/**
 * 估算一次调用的成本（元）。
 *
 * **本地 provider 恒为 0**（规格 §2.3：电费不算钱）。这条是硬编码的，
 * 不依赖注册描述里写的 value —— 本地 provider 就算填了单价，记账也必须为 0。
 *
 * @param {{local?: boolean, cost?: {unit?: string, value?: number}}|null|undefined} provider
 * @param {number} units 计量单位数（字符数 / 张数 / 次数 / 秒数，见 COST_UNITS）
 * @returns {number} 元，6 位小数
 */
export function estimateCost(provider, units) {
  if (!isPlainObject(provider)) return 0;
  if (provider.local === true) return 0;
  const unit = provider.cost?.unit;
  const value = provider.cost?.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 0;
  const scalar = COST_SCALARS[unit];
  const count = typeof units === 'number' && Number.isFinite(units) && units > 0 ? units : 0;
  if (!scalar) return roundCost(count * value);
  return roundCost((count / scalar) * value);
}

/**
 * Provider 注册表。每个实例彼此隔离 —— 测试、多能力并行注册都用自己的实例，
 * 不要靠进程级的全局状态传递隐式依赖。
 */
export class ProviderRegistry {
  constructor() {
    /** @type {Map<string, Map<string, object>>} capability -> (id -> provider) */
    this._store = new Map();
  }

  /**
   * 登记一个 provider。
   * @param {string} capability
   * @param {object} provider
   * @param {{replace?: boolean}} [options]
   * @returns {object} 规范化后的 provider 副本
   */
  register(capability, provider, options = {}) {
    const normalized = normalizeProvider(capability, provider);
    const key = capability.trim();
    if (!this._store.has(key)) this._store.set(key, new Map());
    const bucket = this._store.get(key);
    if (bucket.has(normalized.id) && !options.replace) {
      throw new RegistryError(
        `${key} 里已存在 provider '${normalized.id}'（要覆盖请显式传 { replace: true }）`,
        { capability: key, providerId: normalized.id },
      );
    }
    bucket.set(normalized.id, normalized);
    return { ...normalized, cost: { ...normalized.cost }, requires: [...normalized.requires], caps: [...normalized.caps] };
  }

  /**
   * 批量登记。任何一条非法都会抛出，且**不留下半截状态**（先全部校验再写）。
   * @param {string} capability
   * @param {object[]} providers
   * @param {{replace?: boolean}} [options]
   * @returns {object[]}
   */
  registerAll(capability, providers, options = {}) {
    if (!Array.isArray(providers)) {
      throw new RegistryError('registerAll: providers 必须是数组', { capability });
    }
    const normalized = providers.map((provider) => normalizeProvider(capability, provider));
    const key = capability.trim();
    const bucket = this._store.get(key) ?? new Map();
    const seen = new Set();
    for (const provider of normalized) {
      if (seen.has(provider.id)) {
        throw new RegistryError(
          `${key} 的注册批次里出现重复 id '${provider.id}'`,
          { capability: key, providerId: provider.id },
        );
      }
      seen.add(provider.id);
      if (bucket.has(provider.id) && !options.replace) {
        throw new RegistryError(
          `${key} 里已存在 provider '${provider.id}'（要覆盖请显式传 { replace: true }）`,
          { capability: key, providerId: provider.id },
        );
      }
    }
    if (!this._store.has(key)) this._store.set(key, bucket);
    for (const provider of normalized) bucket.set(provider.id, provider);
    return normalized.map((provider) => ({ ...provider, cost: { ...provider.cost } }));
  }

  /**
   * 按 priority 降序返回候选链（同 priority 保持注册顺序）。
   * @param {string} capability
   * @param {{caps?: string[], require?: string[], exclude?: string[], predicate?: (p: object) => boolean}} [filters]
   * @returns {object[]} 新数组 + 新对象，改它不影响注册表
   */
  resolve(capability, filters = {}) {
    return this.list(capability, filters);
  }

  /**
   * 同 resolve，名字区分「看清单」与「取调用链」两种意图，实现只有一份。
   * @param {string} capability
   * @param {{caps?: string[], require?: string[], exclude?: string[], predicate?: (p: object) => boolean}} [filters]
   * @returns {object[]}
   */
  list(capability, filters = {}) {
    if (typeof capability !== 'string' || capability.trim() === '') return [];
    const bucket = this._store.get(capability.trim());
    if (!bucket) return [];

    const needCaps = Array.isArray(filters.caps) ? filters.caps : [];
    const needRequires = Array.isArray(filters.require) ? filters.require : [];
    const exclude = Array.isArray(filters.exclude) ? filters.exclude : [];
    const predicate = typeof filters.predicate === 'function' ? filters.predicate : null;

    const candidates = [];
    let index = 0;
    for (const provider of bucket.values()) {
      // 注册顺序即同 priority 的稳定次序，用 index 记下来（Map 迭代顺序 = 插入顺序）。
      const withOrder = { provider, index };
      index += 1;
      if (exclude.includes(provider.id)) continue;
      if (predicate && !predicate(provider)) continue;
      if (needCaps.some((cap) => !provider.caps.includes(cap))) continue;
      if (needRequires.some((requirement) => !provider.requires.includes(requirement))) continue;
      candidates.push(withOrder);
    }

    candidates.sort((a, b) => {
      if (b.provider.priority !== a.provider.priority) return b.provider.priority - a.provider.priority;
      return a.index - b.index;
    });

    return candidates.map(({ provider }) => ({
      ...provider,
      requires: [...provider.requires],
      caps: [...provider.caps],
      cost: { ...provider.cost },
    }));
  }

  /** 取单个 provider（未登记返回 null）。 */
  get(capability, id) {
    const bucket = this._store.get(String(capability ?? '').trim());
    if (!bucket) return null;
    const provider = bucket.get(String(id ?? '').trim());
    if (!provider) return null;
    return { ...provider, requires: [...provider.requires], caps: [...provider.caps], cost: { ...provider.cost } };
  }

  has(capability, id) {
    return this.get(capability, id) !== null;
  }

  /** 摘掉一个 provider（不存在返回 false）。 */
  unregister(capability, id) {
    const bucket = this._store.get(String(capability ?? '').trim());
    if (!bucket) return false;
    return bucket.delete(String(id ?? '').trim());
  }

  /** 清空（不传 capability 则清空全部）。 */
  clear(capability) {
    if (capability === undefined) this._store.clear();
    else this._store.delete(String(capability).trim());
  }

  /** 已登记的能力名列表。 */
  capabilities() {
    return [...this._store.keys()];
  }

  /** 某能力的 provider 数量。 */
  count(capability) {
    return this._store.get(String(capability ?? '').trim())?.size ?? 0;
  }
}

/** 造一个独立注册表（测试 / 多实例用）。 */
export function createRegistry() {
  return new ProviderRegistry();
}

/**
 * 进程级默认注册表。能力适配器在 import 时登记自己（例如 C4 的 edge adapter），
 * 调用方通过 `registry.resolve('tts')` 取链。
 *
 * 有状态，但只在内存里：进程重启即回到适配器登记时的状态，不持久化、不影响
 * 诊断层（它压根不 import 这里）。
 */
export const registry = createRegistry();
