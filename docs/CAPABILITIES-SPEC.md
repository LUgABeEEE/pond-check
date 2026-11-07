# pond-check 能力层规格（CAPABILITIES）

> 这份文档定义 pond-check 的第二个身份：除了「体检」，它还提供养鱼人需要的五件基础能力。
>
> 状态：**已实现**（能力层全部落地）。C1–C6 分别交付了 `src/shared/`（基座）、
> `src/memory/`（长期记忆）、`src/wake/`（加权唤醒）、`src/tts/`（语音）、`src/image/`（出图）；
> C7 补上隔离测试与本文的差异说明。
>
> 本文现在是**实现规格**：正文写设计口径，§9 逐条列出「实际实现与设计稿的差异」——
> 读接口以 §9.2 的导出签名为准。诊断层规格见 `docs/SPEC.md`，**诊断完全不受能力层影响**
> （不 import、不联网、不写盘；`tests/isolation.test.mjs` 守这条线）。

---

## 0. 一句话

**诊断层负责「看见」，能力层负责「提供」。**

诊断层只读、不联网、无状态——这是它的全部价值，不能被污染。
能力层提供记忆、唤醒、语音、出图——必然要写、要联网、要有状态。

两者共用同一个仓库，但**在代码层面严格隔离**：`check` 绝不 import 任何能力实现。

---

## 1. 包结构与入口

单包、多入口，不引入 monorepo 复杂度。

```
src/
├── discover/ read/ evaluate/ render/ cli.mjs   诊断层：只读体检（v0.1.1 起）
├── shared/         能力层共享：路径、事件流、成本记账、provider 注册表、云凭据
├── memory/         长期记忆：sqlite 存储 + 三闸沉淀 + 四因子召回
├── wake/           加权唤醒：候选池 + 权重 + 频率控制
├── tts/            语音合成统一接口：edge / command / doubao / mimo
└── image/          图生成统一接口：comfyui / openai-compat / seedream / doubao
```

> 设计稿写的 `src/check/` 在 v0.1.1 的实际仓库里是 `discover/ read/ evaluate/ render/`
> 四个目录；`check` 这个名字仍保留在隔离测试的目录清单里，将来若新增同义目录会被同一条守卫覆盖。

`package.json` 的 `exports`：

```json
{
  "exports": {
    ".":             "./src/cli.mjs",
    "./shared":      "./src/shared/index.mjs",
    "./memory":      "./src/memory/index.mjs",
    "./wake":        "./src/wake/index.mjs",
    "./tts":         "./src/tts/index.mjs",
    "./image":       "./src/image/index.mjs",
    "./package.json": "./package.json"
  }
}
```

**零运行时依赖仍然成立**：
- 存储用 Node 22 内置 `node:sqlite`（已实测可用，含 FTS5）
- 网络用内置 `fetch`
- 本地模型/语音走 `child_process` 调用户自己装的外部程序（不是 npm 依赖）

---

## 2. 统一能力模型（五个能力共用）

### 2.1 Provider 注册表

每个能力有若干 provider，用同一套描述：

```js
{
  id: 'edge',                    // 唯一标识
  name: 'Edge TTS',              // 展示名
  local: true,                   // 是否本地执行（不产生 API 成本）
  requires: ['network'],         // 依赖：network / apiKey / binary
  cost: { unit: 'perKChar', value: 0 },   // 成本口径
  caps: ['mp3', 'ssml'],         // 能力声明
  priority: 50                   // 默认优先级，越大越优先
}
```

> 实际实现：注册表允许并原样保留 adapter 私有字段（`run(args, { signal })`、`keyEnvs`、
> `available`、`unavailableReason`、`voiceMap` 等）；`cost.unit` 只接受
> `perCall / perChar / perKChar / perImage / perSecond / perMinute` 六个口径，写错即
> `RegistryError`（不静默按 perCall 记账）。`resolve()` 返回 priority 降序的候选链，
> 同优先级按**注册先后**（配置者写下的降级意图，不能被字典序打乱）。

### 2.2 调用链与降级

```
调用 → 按 priority 排序 → 逐个尝试
     → 成功即返回，并记账
     → 失败（超时/鉴权/额度/格式）记一次失败，降到下一个
     → 全部失败 → 抛 CapabilityError，带上每个 provider 的失败原因
```

**降级顺序必须是「云 → 本地」还是「本地 → 云」？**
按场景定，写进配置：
- `tts`：`edge(50) → command(20) → doubao(15) → mimo(10)`（免费路径先通，云按需兜底）
- `image`：`comfyui → openai-compat → seedream → doubao`（本地算力优先；本地不可达静默降级并标 `degradedFrom`）
- `memory` / `wake`：不分级，只有本地 provider（`sqlite` / `wake-local`），隐私优先、永不上传

### 2.3 成本记账

每次调用写一条事件：

```js
{
  ts, capability: 'tts'|'image'|'memory'|'wake',
  provider: 'edge',
  units: 1200,                  // 字符数 / 图张数 / 记忆条数
  costEstimate: 0,              // 估算金额（元），本地为 0
  durationMs: 830,
  ok: true,
  error: null
}
```

事件写进同一个 append-only 日志：`~/.pond/events.jsonl`。

> 实际实现：**一次尝试一行**（降级时一次调用会写多行），失败尝试的 `units` /
> `costEstimate` 恒为 0；八个必备字段之后另有 `attempt` / `errorCategory` / `degradedFrom`，
> 记忆与唤醒再追加 `op` / `action` / `reason` 等。因此**诊断层读这个文件时必须容忍额外键**——
> 只按前八个字段读即可（`tests/isolation.test.mjs` 里有这条契约测试）。

**这就是两层的接缝**：诊断层的 `throughput` 与未来的成本指标，直接读这个文件。能力层不关心谁在读它。

### 2.4 统一超时与重试

- 单次调用超时：`tts` 30s / `image` 180s / `memory` 2s
- 重试：仅对网络类错误重试，最多 1 次，指数退避 500ms
- 鉴权类错误（401/403）**不重试**，直接降级

---

## 3. 记忆（memory）

这是五个能力里最重要的一个，也是最容易做烂的一个。

### 3.1 四类记忆

| kind | 是什么 | 例子 | 默认半衰期 |
|---|---|---|---|
| `fact` | 稳定客观信息 | 「主人住在杭州」 | 365 天 |
| `preference` | 态度倾向 | 「讨厌香菜」 | 180 天 |
| `episode` | 带时间的经历 | 「10/28 一起看了芙莉莲第 12 集」 | 45 天 |
| `relation` | 人与人的关系 | 「阿杰是主人大学室友」 | 365 天 |

### 3.2 存储 schema

```sql
CREATE TABLE memories (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,          -- fact|preference|episode|relation
  content       TEXT NOT NULL,          -- 一句话，自包含，可独立阅读
  entities      TEXT,                   -- JSON 数组：["阿杰","杭州"]
  importance    INTEGER NOT NULL DEFAULT 3,  -- 1..5
  confidence    REAL NOT NULL DEFAULT 0.8,   -- 0..1，来自抽取时的确信度
  source        TEXT,                   -- 'chat'|'manual'|'inferred'
  source_ref    TEXT,                   -- 出处（session id / 消息 id）
  created_at    INTEGER NOT NULL,       -- epoch ms
  updated_at    INTEGER NOT NULL,
  last_recalled INTEGER,                -- 上次被召回的时间
  recall_count  INTEGER NOT NULL DEFAULT 0,
  ttl_days      INTEGER,                -- 覆盖默认半衰期
  archived      INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, entities, content='memories', content_rowid='id'
);
```

索引：`(kind)`、`(importance)`、`(last_recalled)`、`(archived)`。

> 实际实现与上表逐字一致（含 4 个索引与 3 个 FTS5 外部内容触发器）。库文件：
> `<POND_HOME>/memory.db`（默认 `~/.pond/memory.db`）。

### 3.3 沉淀（write path）

三闸，缺一不可：

**闸一 · 候选抽取**
从对话里抽候选，只接受四类之一。抽不出类别就不记。

**闸二 · 去重与合并**
- 与既有记忆做文本相似度（无 embedding 时用 trigram Jaccard，阈值 0.75）
- 相似 → **替换而不是新增**（保留旧 id，更新 content + updated_at，importance 取 max）
- 这解决「同一件事被记了二十遍」

**闸三 · 重要性评分**

| 分值 | 判据 |
|---|---|
| 5 | 用户明确说「记住」/ 涉及身份、健康、重要日期 |
| 4 | 明确的好恶表达、反复出现的话题 |
| 3 | 一般事实（默认） |
| 2 | 一次性的闲聊细节 |
| 1 | 猜测性内容（默认不记，除非用户要求） |

**写入必须过闸**：`memory.remember()` 不接受「直接落库」，只接受候选 + 三闸结果。
用户可以用 `force: true` 选项跳过闸二，但跳过会被记进事件日志。

### 3.4 召回（read path）

四因子加权融合，**不是单一排序**：

```
score = 0.40 × 相关度
      + 0.25 × 新鲜度
      + 0.25 × 重要性
      - 0.10 × 重复惩罚
```

- **相关度**：FTS5 BM25，归一化到 0..1；无关键词命中时为 0
- **新鲜度**：`0.5 ** (days / halfLife)`（真半衰；设计稿原写 `exp(-days/halfLife)`，见 §9），
  半衰期按 kind 取，`days` 距 `updated_at` 算（合并即刷新新鲜度）
- **重要性**：`importance / 5`
- **重复惩罚**：`min(1, recall_count / 10)`，被提过越多次权重越低

接口：

```js
memory.recall(query, { limit = 6, kinds, minScore = 0.15 })
  → [{ id, kind, content, score, why }]
```

`why` 是个对象，说明这次为什么被选中（相关度/新鲜度/重要性的分项），用于调试和解释。
**不能让召回变成一个黑盒**——否则用户永远不知道为什么她突然提起三个月前的事。

### 3.5 随机唤醒（wake）

注意：**不是随机，是加权随机**。纯随机会让她今天提三次猫、明天一次不提。

候选池条件：
- `importance >= 3`
- `archived = 0`
- 距 `last_recalled` 至少 24h
- 半衰期内（`now - created_at < halfLife * 2`）

权重：

```
weight = importance² × recency × silence
recency  = 0.5 ** (daysSinceCreated / halfLife)   // 与 §3.4 同一口径
silence  = min(1, daysSinceRecalled / 7)          // 从未提过 = 1（沉默到顶）
```

> 实际实现：`pick()` **有副作用** —— 选中即写一条 `action='picked'` 事件并刷新
> `last_recalled` / `recall_count`（否则 24h 静默与 `silence` 永不生效）；被频率控制拦住时
> 写 `blocked` 事件并返回 `null`（「今天为什么没说话」可追溯）。`schedule()` 是纯预排：
> 不写事件、不改库，跨天时自动跳过 24h 空窗。`budget` 传数字 = 今天还剩几次，
> 传对象 = 覆盖 `dailyLimit` / `minIntervalHours` / `perKindDailyLimit` 等（见 §9.2）。

`importance²` 让重要的事权重压倒性地高；`silence` 让「很久没提」的事浮上来。

频率控制：
- 每日上限：默认 3 次
- 两次唤醒最少间隔：默认 4 小时
- 同一 kind 每日上限：默认 2 次

接口：

```js
wake.pick({ now, budget })  → { memory, reason } | null
wake.schedule({ from, until }) → [{ at, memory }]   // 预排当天唤醒点
```

`reason` 同样要能解释：`'重要且 9 天未提'`。

### 3.6 存储位置与隐私

- 默认 `~/.pond/memory.db`
- 支持 `POND_HOME` 覆盖
- **永不上传**：没有同步、没有云备份、没有遥测
- 导出：`memory.export()` → JSONL（用户自己决定往哪放；模块级便捷函数叫 `exportMemories()`，
  因为 `export` 是保留字）
- 实际状态目录：`<POND_HOME>/memory.db`、`<POND_HOME>/events.jsonl`、`<POND_HOME>/image.json`、
  `<POND_HOME>/out/`；整目录删掉 = 能力层回到初始状态，诊断层结果不变

---

## 4. TTS 统一接口

```js
await tts.speak(text, {
  voice:    'xiaoyi',      // 逻辑音色名，由 adapter 映射到具体 ID（缺省 xiaoxiao）
  emotion:  'happy',       // 可选，不支持则忽略
  speed:    1.0,
  format:   'mp3',         // mp3|wav|ogg
  outPath:  undefined,     // 不传则写临时文件
}) → { path, durationMs, format, provider, estimated, degradedFrom, segments }

tts.providers() → [{ id, name, voices, cost, local, available }]
tts.voices()    → [{ id, name, provider, gender, langs }]
```

> 实际实现：逻辑音色共 21 个（edge 10 个含 `xiaoyi`、doubao 2 个、mimo 9 个）；
> `estimated: true` 表示 `durationMs` 是按时长码率估算的，不是音频元数据算出来的；
> `segments` 是长文本分段后的段数；降级成功时 `degradedFrom` 是链首 provider id。

### builtin adapters

| id | 类型 | 依赖 | 成本 | 备注 |
|---|---|---|---|---|
| `edge` | 云（免费） | network | 0 | 微软 Edge TTS，音色最全，默认首选（priority 50） |
| `command` | 本地 | binary | 0 | 调用户自带 CLI（piper / espeak 等），配置里给模板（priority 20） |
| `doubao` | 云 | network + appId/token | 约 1 元/分钟 | 火山 Seed Audio（priority 15） |
| `mimo` | 云 | network + apiKey | 按量 | 小米 MiMo（priority 10） |

**默认降级链**：`edge → command → doubao → mimo`

> 差异：设计稿里的 `openai-compat`（通用 OpenAI `/audio/speech`）TTS 侧**尚未实现**；
> 图生成侧有同名的 `openai-compat`。云 adapter 的验证状态见 §9.5 —— **未对真实服务验证**。

### 关键约束

- `durationMs` 必须尽量准确（对上层做语音时长控制很重要）；拿不到就返回估算值并标记 `estimated: true`
- 长文本自动分段（按标点，单段 ≤ 300 字），合成后拼接
- **不缓存文本内容到磁盘以外的位置**；临时文件由调用方清理
- 失败必须给出「是哪个 provider、什么错」，不能只抛一个笼统的失败
- 实际实现：edge 生产传输走 Node 22 内置 `WebSocket`；平台不允许自定义 Cookie/Origin
  请求头，若服务端因此拒握手，会按网络类错误降级到 `command`，不会挂死用户（见 §9.5）

---

## 5. 图生成统一接口

```js
await image.generate(prompt, {
  size:     '1024x1024',   // 或 aspect: '1:1'
  style:    'anime',       // anime|photo|pixel|illustration
  negative: 'lowres, bad hands',
  seed:     undefined,     // 给了就尽量复现
  outPath:  undefined,
}) → { path, width, height, provider, seed, degraded?, degradedFrom?,
      seedReproducible, seedNote?, costEstimate, units, promptTruncated? }

image.providers() → [{ id, name, sizes, cost, local, available, unavailableReason? }]
```

> 实际实现：`degraded: true` + `degradedFrom` 表示链首本地 provider 不可达、已静默降级；
> `seedReproducible: false` 时 `seed: null` 且 `seedNote` 说明原因；提示词超过 2000 字
> （负向 800 字）会截断并标 `promptTruncated: true`。

### builtin adapters

| id | 类型 | 依赖 | 成本 | 备注 |
|---|---|---|---|---|
| `comfyui` | 本地 | network(localhost:8188) | 0（电费） | 有显卡时的首选，工作流由 `<POND_HOME>/image.json` 指定 |
| `openai-compat` | 云 | network + apiKey | 按 provider | 通用 `images/generations` |
| `seedream` | 云 | network + apiKey | 按量 | 火山 Seedream（方舟 images/generations） |
| `doubao` | 云 | network + apiKey | 按量 | 豆包 Seedream（方舟 3-0-t2i 线） |

**默认降级链**：`comfyui → openai-compat → seedream → doubao`

> 差异：设计稿里的 `sd-command`（本地 CLI 出图）**尚未实现** —— 本地 CLI 生态尚未定型，
> 不臆造命令模板。云 adapter 的验证状态见 §9.5 —— **未对真实服务验证**。

### 关键约束

- 本地不可达（如 5060 暂时离线）**不能算失败**，要静默降级到云，并在返回结果里标 `degradedFrom: 'comfyui'`
- `seed` 能复现就回传同一个 seed；不能复现就回传 `null` 并说明
- 图片写到 `~/.pond/out/` 或调用方指定路径，**不写进仓库**（实际实现是把「仓库内路径」
  升级为运行时硬闸：命中即 `ImagePathError`，并有测试守）
- 提示词里出现文件名、路径、URL 时要做转义与长度限制（防注入到工作流 JSON）
- 实际配置：`<POND_HOME>/image.json`（`POND_IMAGE_CONFIG` 可覆盖路径），可指定工作流模板、
  端点、模型线、`chain` 降级顺序、`outDir`；尺寸按各 provider 白名单校验，不在档位内即
  `ImageInputError`（云模型只接受固定档位）

---

## 6. 与诊断层的隔离规则（硬约束）

这是整份文档里最重要的一节。

### 6.1 单向依赖

```
check  ──读──>  ~/.pond/events.jsonl     （只读文件，不 import 代码）
check  ✗──>     src/memory, src/tts, src/image  （禁止 import）
```

**`src/check/` 下的任何文件，都不允许 import `src/memory`、`src/tts`、`src/image`、`src/wake`。**

理由：诊断层的价值来自「不联网、不写、无状态」。一旦它 import 了会联网的模块，这个保证就在代码层面失守了，而用户看不见。

### 6.2 用测试守住这条线

```js
// tests/isolation.test.mjs
// 断言：src/{check,discover,read,evaluate,render}/**/*.mjs 与 src/cli.mjs
//       不得 import ../memory、../tts、../image、../wake
```

这条测试比任何文档都有效——它会失败。

实际守卫（`tests/isolation.test.mjs` 九组断言）比这一段更严：

1. 诊断层 → 能力层（memory/tts/image/wake）**禁止**（上面的红线）；
2. 诊断层连 `shared/` 基座也**禁止** import —— 接缝是文件，不是代码；
3. 反向：能力层 → 诊断层**禁止**（依赖只能单向，能力层整目录删掉不影响体检）；
4. `src/` 下每个目录必须显式归类（新目录默认按诊断层严格对待，fail-closed）；
5. 零运行时依赖（无依赖字段；src 只 import 内置模块与相对路径）；
6. 行为：整条诊断管线跑完 `fetch` / `WebSocket` 调用数为 0；
7. 行为：`<POND_HOME>` 堆满能力层状态再整删，诊断结果逐字节一致且目录不被重建；
8. 接缝契约：事件八字段齐备、额外键可容忍、文件只追加不重写；
9. 包入口：`exports` 覆盖五个能力 + 诊断入口，bin 不变，子路径自引用可用。

**变异验证**：往 `src/render/text.mjs` 加一行 `import '../memory/index.mjs'`，第 1 组必须红；
加 `import '../shared/events.mjs'` 则第 2 组红；往 `src/memory/index.mjs` 加诊断 import 则第 3 组红。

### 6.3 能力层可以有状态，但必须可删

`~/.pond/` 目录整删掉，能力层回到初始状态，诊断层完全不受影响。

---

## 7. 实现顺序

按「依赖最少、价值最高」排：

| 阶段 | 内容 | 状态 | 为什么这个顺序 |
|---|---|---|---|
| **C1** | `shared/`：provider 注册表、事件流、成本记账、超时重试 | ✅ 完成 | 五个能力都靠它 |
| **C2** | `memory/`：schema + 三闸沉淀 + 四因子召回 | ✅ 完成 | 最难也最有价值，且不依赖网络 |
| **C3** | `wake/`：加权随机 + 频率控制 | ✅ 完成 | 只依赖 memory，一天能做完 |
| **C4** | `tts/`：接口 + edge adapter + command adapter | ✅ 完成 | 免费路径先通 |
| **C5** | `image/`：接口 + comfyui adapter + openai-compat adapter | ✅ 完成 | 本地算力优先 |
| **C6** | 各能力的云 adapter（doubao / seedream / mimo） | ✅ 完成（协议离线对齐，**未对真实服务验证**，见 §9.5） | 有 key 才需要，最后补 |
| **C7** | 隔离测试 + 文档 | ✅ 完成 | 收尾 |

---

## 8. 与诊断层的最终关系

```
        ┌─────────────────────────────────────┐
        │  ~/.pond/events.jsonl（唯一接缝）     │
        └──────────┬──────────────┬───────────┘
                   │ 写            │ 读
        ┌──────────▼──────┐  ┌────▼──────────────┐
        │   能力层         │  │   诊断层 check     │
        │ memory / wake    │  │ 只读 / 不联网      │
        │ tts / image      │  │ 无状态            │
        └──────────────────┘  └───────────────────┘
```

能力层产生事件，诊断层消费事件。**它们永远不互相 import。**

这样 pond-check 就有了一个完整的闭环：
- 能力层让鱼会记、会想、会说、会画
- 诊断层让养鱼的人看得见她记了什么、想了什么、花了多少、哪里不对

---

## 9. 实际实现与规格的差异

本节记录落地实现相对上面设计稿的偏离与新增约定。**规格写死的数值/接口若偏离，这里必须点名**；
规格没写死的地方以代码与测试为准。

### 9.1 差异表

| 位置 | 设计稿 | 实际实现 | 原因 |
|---|---|---|---|
| §3.4 新鲜度 | `exp(-days/halfLife)` | `0.5 ** (days/halfLife)`（真半衰） | `exp` 在 `days=halfLife` 处是 1/e≈0.368，名不副实；`days` 距 `updated_at` 算（合并即刷新新鲜度） |
| §3.1 kind | fact / preference / episode / relation | 四类全部实现（`relation` 半衰期同 `fact`，365 天） | 按规格取四类；早期任务书口径只有三类，已在 C2 补齐 |
| §3.6 导出 | `memory.export()` | 实例方法仍叫 `memory.export()`；模块级便捷函数叫 `exportMemories()` | `export` 是 JS 保留字，不能做顶层函数名 |
| §4 TTS adapter | edge / openai-compat / doubao / mimo / command | edge / command / doubao / mimo（**openai-compat TTS 未实现**） | 免费路径与两朵云已覆盖；通用 TTS 兼容层留作后续（图侧已有同名 adapter） |
| §4 默认音色 | 例子写 `xiaoyi` | 缺省 `xiaoxiao`；`xiaoyi` 仍是合法逻辑音色 | xiaoxiao 是 Edge 默认女声；21 个逻辑音色全部保留 |
| §4 返回 | `{path,durationMs,format,provider}` | 追加 `estimated` / `degradedFrom` / `segments` | 时长可能是估算的，必须如实标记；降级要可见 |
| §4 传输 | 未规定 | 生产走 Node 22 内置 `WebSocket`；不能自定义 Cookie/Origin 请求头 | 平台限制；若服务端因此拒握手，会按网络类错误降级到 command，不会挂死 |
| §5 image adapter | comfyui / sd-command / openai-compat / seedream / doubao | comfyui / openai-compat / seedream / doubao（**sd-command 未实现**） | 本地 CLI 出图生态尚未定型，先留接口不臆造命令 |
| §5 返回 | `{path,width,height,provider,seed}` | 追加 `degraded`/`degradedFrom`/`seedReproducible`/`seedNote`/`costEstimate`/`units`/`promptTruncated` | 本地不可达静默降级要可见；seed 能否复现必须说清 |
| §5 配置 | 未规定 | `<POND_HOME>/image.json`（`POND_IMAGE_CONFIG` 可覆盖路径） | 工作流 / 端点 / 链序写进文件，不由实现猜 |
| §5 输出 | `~/.pond/out/` 或指定路径 | 默认 `<POND_HOME>/out/`；显式 `outPath`；**仓库内路径一律 `ImagePathError`** | 「不写进仓库」升级为运行时硬闸 + 测试 |
| §5 尺寸 | `size` 或 `aspect`，64..4096 | 每个 provider 有白名单尺寸；超范围或不在档位即 `ImageInputError` | 云模型只接受固定档位，猜一个会被远端拒 |
| §2.3 事件 | 每次调用一条 | **每次尝试一条**（降级时多行），失败 `units`/`costEstimate` 为 0 | 只记赢家会让降级在诊断层变成黑盒 |
| §2.4 重试 | 仅网络类错误重试 1 次 | 相同；**超时 / 429 / 额度 / 格式不重试**，直接降级 | 超时已吃掉完整预算，再试等于让用户多等一倍 |
| §2.4 超时 | 只列 tts/image/memory | 未列出的能力（如 wake）缺省 30s | 宁可慢，也不无声挂死 |
| §2.1 provider | 六个字段 | 额外保留 adapter 私有字段（`run`/`keyEnvs`/`available`/`voiceMap`…） | 注册表是描述层，不吞适配器配置 |
| §2.1 cost.unit | 示例写 `perKChar` | 只接受六个白名单口径，写错抛 `RegistryError` | 打错字静默按 `perCall` 记账会差三个数量级 |
| §1 包结构 | `src/check` | 诊断层实际是 `discover/read/evaluate/render` + `cli.mjs` | v0.1.1 的既有名字；`check` 仍留在隔离测试的目录清单里 |
| §1 exports | 六个入口 | 已加 `.` `./shared` `./memory` `./wake` `./tts` `./image` `./package.json` | 让 npm 装出来的包能 import 子路径；bin 不受影响 |
| 运行环境 | Node >= 22 | 相同；`node:sqlite` 仍标 experimental，打开记忆库会打一行 stderr 警告 | 内置模块现状；功能可用（含 FTS5），不引依赖 |

### 9.2 实际导出签名

```js
// pond-check/memory
createMemory({ env?, dbPath?, now?, warn?, eventsPath? }) -> {
  remember(candidate, { force? }) -> { recorded, action, reason, id, memory, similarity, gates, gatesSkipped }
  recall(query, { limit = 6, kinds?, minScore = 0.15 }) -> [{ id, kind, content, score, why, entities, importance, ... }]
  forget(id) -> { forgotten, id }
  export() -> string            // JSONL，用户自己决定往哪放
  close()
}
remember(candidate, options?) / recall(query, options?) / forget(id, options?) / exportMemories(options?)

// pond-check/wake
createWake({ env?, dbPath?, store?, now?, random?, limits?, warn?, eventsPath? }) -> {
  pick({ now?, budget? }) -> { memory, reason, weight, why } | null
  schedule({ from, until }) -> [{ at, memory, reason, weight }]
  close()
}
pick(options?) / schedule(options?)
WAKE_DEFAULTS = { dailyLimit: 3, minIntervalHours: 4, perKindDailyLimit: 2,
                  minImportance: 3, minSilenceHours: 24, maxAgeHalfLives: 2,
                  silenceDaysForFull: 7, scheduleStepMinutes: 15 }

// pond-check/tts
createTts({ providers?, transport?, command?, registry?, timeoutMs?, now?, sleep?, env?, eventsPath?, warn?, recordEvents? })
  -> { speak, providers, voices, registry }
speak(text, { voice = 'xiaoxiao', emotion?, speed = 1, format = 'mp3', outPath? })
  -> { path, durationMs, format, provider, estimated, degradedFrom, segments }
providers() / voices()

// pond-check/image
createImageClient({ config?, configPath?, env?, transport?, sleep?, now?, warn?, eventsPath?, recordEvents?, timeoutMs? })
  -> { generate, providers, chain, getConfig, registry }
generate(prompt, { size? | aspect?, style?, negative?, seed?, outPath?, timeoutMs? })
  -> { path, width, height, provider, seed, degraded?, degradedFrom?, seedReproducible, seedNote?,
       costEstimate, units, promptTruncated? }
providers()

// pond-check/shared
createRegistry() / registry
registry.register(capability, provider, { replace? }) / registerAll / resolve / list / get / has / unregister / clear
invoke({ capability, providers, args?, run?, units?, timeoutMs?, maxRetries?, backoffMs?, sleep?, now?, env?, eventsPath?, warn?, recordEvents? })
  -> { ok, capability, provider, value, units, costEstimate, degradedFrom, attempts, durationMs }
appendAttempt(entry, options?) / buildAttemptEntry(input, options?) / readEvents(options?)
spentToday(capability?, options?) / spentTotal(capability?, options?) / spentSince(capability?, options?)
resolvePondHome(env?) / eventsFilePath(env?)
resolveCredentials(spec, env?) / MissingKeyError
```

### 9.3 云凭据（环境变量）

| adapter | 环境变量 |
|---|---|
| tts `doubao` | `POND_DOUBAO_TTS_APP_ID` + `POND_DOUBAO_TTS_TOKEN` |
| tts `mimo` | `POND_MIMO_API_KEY` |
| image `openai-compat` | `POND_IMAGE_API_KEY`（或配置 `openai-compat.apiKeyEnv`） |
| image `seedream` | `POND_SEEDREAM_API_KEY` |
| image `doubao` | `POND_DOUBAO_API_KEY` |

没配 key 时：`providers()` 标 `available: false` 并点名缺哪个变量，`resolve()` 直接跳过，
**不 throw、不崩、不碰网络**；配了但调用失败才是 provider 失败（错误类别与文案和「没 key」严格分开）。
密钥只进请求头与闭包，不进事件、日志、`providers()` 输出。

### 9.4 状态目录

```
<POND_HOME>/                     # 默认 ~/.pond，POND_HOME 可覆盖
├── events.jsonl                 # 两层唯一接缝：append-only，不轮转不删除
├── memory.db                    # node:sqlite（memories + memories_fts）
├── image.json                   # 可选：comfyui 工作流 / 端点 / 链序
└── out/                         # 出图默认落点（不写进仓库）
```

整目录删掉 = 能力层回到初始状态；诊断层结果不变（`tests/isolation.test.mjs` 守）。

### 9.5 云 adapter 的验证状态（重要，别当「已支持」）

**C6 交付的三个云 adapter（TTS 的 `doubao` / `mimo`，图的 `seedream` / `doubao`）只做了
「按公开文档离线对齐协议」——在零联网铁律下，它们没有对真实服务跑过一次。**

这意味着：endpoint、请求字段名、鉴权头形态、错误码、响应结构都可能与服务端实际不符；
测试里验证的是「按文档构造出来的请求长什么样」和「失败路径怎么降级」，不是「云端真的返回了音频/图片」。

首次使用建议（**先冒烟，再批量**）：

1. 配好 key 后先发一条最小请求：一句短语音（十来个字）或一张最小尺寸的图；
2. 确认拿到文件且能打开，再上长文本 / 批量 / 生产用途；
3. 失败时先看错误文案：`POND_MISSING_KEY` = 没配 key（本地路径不受影响）；
   401/403 = 鉴权形态不对；429 = 额度/限流；`format` = 响应结构对不上（协议可能需要按服务端现状调）。

本地路径（`edge` / `command` / `comfyui`）不受这一条影响：`edge` 的令牌算法已用
`edge-tts 7.3.1` 的 Python 原实现做过离线对照，`command` / `comfyui` 的行为由本地进程/服务决定。
