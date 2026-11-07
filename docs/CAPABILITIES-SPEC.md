# pond-check 能力层规格（CAPABILITIES）

> ## ⚠️ 未实现的设计稿 —— v0.1 不含本文描述的任何能力
>
> **本文写到的记忆 / 唤醒 / 语音（TTS）/ 图生成，v0.1 一行代码都没实现。**
> 文档里出现的命令、目录结构、接口、参数都是**设计目标，不是现有功能**——照着敲不会有效果。
> v0.1 真正能用的只有**诊断层**：`node src/cli.mjs` 那套只读体检（规格见 `docs/SPEC.md`）。
> 这份文档是**第二期的设计基线**：供以后实现时照着做，也供现在评审边界用，**别当功能清单读**。

> 这份文档定义 pond-check 的第二个身份：除了「体检」，它还提供养鱼人需要的那五件基础能力。
>
> 状态：设计定稿，**待实现（v0.1 不含）**。
> 前置：`docs/SPEC.md`（诊断层的判定规格）

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
├── check/          D2–D5 已交付：只读诊断
├── shared/         能力层共享：配置、事件流、成本记账、provider 注册表
├── memory/         长期记忆：沉淀 + 召回 + 存储
├── wake/           随机唤醒：加权调度
├── tts/            语音合成统一接口
└── image/          图生成统一接口
```

`package.json` 的 `exports`：

```json
{
  "exports": {
    ".":         "./src/check/cli.mjs",
    "./memory":  "./src/memory/index.mjs",
    "./wake":    "./src/wake/index.mjs",
    "./tts":     "./src/tts/index.mjs",
    "./image":   "./src/image/index.mjs",
    "./shared":  "./src/shared/index.mjs"
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

### 2.2 调用链与降级

```
调用 → 按 priority 排序 → 逐个尝试
     → 成功即返回，并记账
     → 失败（超时/鉴权/额度/格式）记一次失败，降到下一个
     → 全部失败 → 抛 CapabilityError，带上每个 provider 的失败原因
```

**降级顺序必须是「云 → 本地」还是「本地 → 云」？**
按场景定，写进配置：
- `tts`：默认 `local-first`（Edge 免费且快）
- `image`：默认 `local-first`（5060 有算力时省钱），本地不可达则走云
- `memory`：不分级，只有本地（隐私优先，永不上传）

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
- **新鲜度**：`exp(-days / halfLife)`，半衰期按 kind 取
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
recency  = exp(-daysSinceCreated / halfLife)
silence  = min(1, daysSinceRecalled / 7)
```

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
- 导出：`memory.export()` → JSONL（用户自己决定往哪放）

---

## 4. TTS 统一接口

```js
await tts.speak(text, {
  voice:    'xiaoyi',      // 逻辑音色名，由 adapter 映射到具体 ID
  emotion:  'happy',       // 可选，不支持则忽略
  speed:    1.0,
  format:   'mp3',         // mp3|wav|ogg
  outPath:  undefined,     // 不传则写临时文件
}) → { path, durationMs, format, provider }

tts.providers() → [ProviderInfo]
tts.voices()    → [{ id, name, provider, gender, langs }]
```

### builtin adapters

| id | 类型 | 依赖 | 成本 | 备注 |
|---|---|---|---|---|
| `edge` | 云（免费） | network | 0 | 微软 Edge TTS，音色最全，默认首选 |
| `openai-compat` | 云 | network + apiKey | 按 provider | 通用 OpenAI /audio/speech 兼容 |
| `doubao` | 云 | network + appId/token | 约 1 元/分钟 | 火山 Seed Audio，音质最好 |
| `mimo` | 云 | network + apiKey | 按量 | 小米 MiMo |
| `command` | 本地 | binary | 0 | 调用户自带 CLI（piper / espeak 等），配置里给模板 |

**默认降级链**：`edge → command → openai-compat → doubao → mimo`

### 关键约束

- `durationMs` 必须尽量准确（对上层做语音时长控制很重要）；拿不到就返回估算值并标记 `estimated: true`
- 长文本自动分段（按标点，单段 ≤ 300 字），合成后拼接
- **不缓存文本内容到磁盘以外的位置**；临时文件由调用方清理
- 失败必须给出「是哪个 provider、什么错」，不能只抛一个笼统的失败

---

## 5. 图生成统一接口

```js
await image.generate(prompt, {
  size:     '1024x1024',   // 或 aspect: '1:1'
  style:    'anime',       // anime|photo|pixel|illustration
  negative: 'lowres, bad hands',
  seed:     undefined,     // 给了就尽量复现
  outPath:  undefined,
}) → { path, width, height, provider, seed }

image.providers() → [ProviderInfo]
```

### builtin adapters

| id | 类型 | 依赖 | 成本 | 备注 |
|---|---|---|---|---|
| `comfyui` | 本地 | network(localhost:8188) | 0（电费） | 有显卡时的首选，工作流由配置指定 |
| `sd-command` | 本地 | binary | 0 | 调本地 stable-diffusion.cpp 一类 CLI |
| `openai-compat` | 云 | network + apiKey | 按 provider | 通用 images/generations |
| `seedream` | 云 | network + apiKey | 按量 | 火山 Seedream |
| `doubao` | 云 | network + apiKey | 按量 | 豆包 Seedream |

**默认降级链**：`comfyui → sd-command → openai-compat → seedream → doubao`

### 关键约束

- 本地不可达（如 5060 暂时离线）**不能算失败**，要静默降级到云，并在返回结果里标 `degradedFrom: 'comfyui'`
- `seed` 能复现就回传同一个 seed；不能复现就回传 `null` 并说明
- 图片写到 `~/.pond/out/` 或调用方指定路径，**不写进仓库**
- 提示词里出现文件名、路径、URL 时要做转义与长度限制（防注入到工作流 JSON）

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
// 断言：src/check/**/*.mjs 里不得出现对 ../memory、../tts、../image、../wake 的 import
```

这条测试比任何文档都有效——它会失败。

### 6.3 能力层可以有状态，但必须可删

`~/.pond/` 目录整删掉，能力层回到初始状态，诊断层完全不受影响。

---

## 7. 实现顺序

按「依赖最少、价值最高」排：

| 阶段 | 内容 | 为什么这个顺序 |
|---|---|---|
| **C1** | `shared/`：provider 注册表、事件流、成本记账、超时重试 | 五个能力都靠它 |
| **C2** | `memory/`：schema + 三闸沉淀 + 四因子召回 | 最难也最有价值，且不依赖网络 |
| **C3** | `wake/`：加权随机 + 频率控制 | 只依赖 memory，一天能做完 |
| **C4** | `tts/`：接口 + edge adapter + command adapter | 免费路径先通 |
| **C5** | `image/`：接口 + comfyui adapter + openai-compat adapter | 本地算力优先 |
| **C6** | 各能力的云 adapter（doubao / seedream / mimo） | 有 key 才需要，最后补 |
| **C7** | 隔离测试 + 文档 | 收尾 |

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
