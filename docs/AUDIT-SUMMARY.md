# D8 审查收口：结论与遗留项（AUDIT-SUMMARY）

- **基线**：`9c5c92b`（D8c 提交后），工作树另有他人未提交的 `src/cli.mjs` 模式位改动（100644→100755），与本文结论无关
- **输入**：三份审查报告 —— [AUDIT-BOUNDARY](AUDIT-BOUNDARY.md)（c7248e1）、[AUDIT-HEALTH](AUDIT-HEALTH.md)（9732029）、[AUDIT-TESTS](AUDIT-TESTS.md)（9c5c92b）
- **收口动作**：三份报告的全部 findings 去重合并 → **回 HEAD 亲自复核每一条「高」及以上**（不转述，全部重跑）→ 定级 → 给 verdict
- **验收门**：`npm test` **114/114 exit 0**；三份报告文件均存在且已入库

---

## 0. Verdict：**needs_revision**

**判据**：存在 1 条未关闭的 blocker —— **健康栏在日志被尾部截断时仍判「干净」**（D8b 原定级「高」，收口按 `src/rules.json` 的 `policy.note`「假健康是本项目最高优先级缺陷」提级为 blocker，理由见 §2）。项目自己的第一红线是「不许把没看到说成没问题」，而这条缺陷让工具对着 2 小时前的真实 412 报出「健康 干净 / 不用动」。

> 附带说明：D8 这个**节点的工作**已经做完（三份审查齐、汇总齐、测试绿）。needs_revision 判的是**代码与文档能不能按现在这个样子发 v0.1.0**，不是审查没做完。下面 §5 的三件事做完即可转 pass，都是小改动。

| 级别 | 数量 | 说明 |
|---|---|---|
| blocker | **1** | 假健康真缺陷（可复现、无测试守） |
| high | 5 | 推断型误判 ×1、文档合同不符 ×2、渲染红线零守卫 ×1、同名鱼撞脸 ×1 |
| medium | 10 | 缺守卫 / 缺实现 / 措辞冲突 |
| low | 10 | 口径可收紧、测试债务 |
| 审查期间已闭环 | 2 | `--no-exec`（跨两份报告重复）、docs-consistency 闸假阳性 |

**正向结论也要写清楚**（详见 §6）：只读边界零破坏（零网络、零依赖、凭证零泄漏、写盘只有报告本身），六格默认值全部 `unknown`、无 `|| 'ok'` 兜底，测试不是自我安慰（15 个注入缺陷 12 个当场被抓）。

---

## 1. 我亲自复核了什么（全部在 HEAD `9c5c92b` 上重跑，不是转述）

### 1.1 blocker：health 在尾部截断时判 clean（D8-B1）

自造 24 小时、86 400 行、7.17 MB 的日志，2 小时前放 3 条真实 `412 Precondition Failed`（在 256 KiB 尾部窗口之外）：

```
$ node src/cli.mjs --root /tmp/d8sum-h1 --json | …打印 health…
health: clean ok | value 0
evidence.bytesRead: 262144  truncated: true  hasBinary: false
bucket: ok | headline: 存活 活跃 · 节律 判不出 · 工作量 今天 1 条 · 健康 干净 · 依赖 判不出 · 漂移 对齐

$ node src/cli.mjs --root /tmp/d8sum-h1 --text | head -4
🐟 pond-check · 2026-11-07 21:16 · linux/node 22.23.4
✅ d8sum-h1  活跃 刚刚  今天 1 条  缺 登录态
→ 最该做：d8sum-h1：日志按天切割、别清 session
※ 2 项数据读不到（节律、依赖），不能当正常。
```

尾部窗口 262 144 B / 7 171 172 B = **3.7% 的文件、约 53 分钟的时段**，却给出「健康 干净」+「2 项读不到（节律、依赖）」——**健康不在「读不到」名单里**，因为它在半个多小时的空窗里没看见坏事。触发条件极普通：日志 >256 KiB/天。

### 1.2 high：同名鱼在 `--text` 撞脸（D8-H5）

真机默认扫描，两条不同 profile 的 `dsh-whale-widget` 渲染成完全相同的两行（连判据都一样），用户无法区分：

```
❓ dsh-whale-widget  判不出  缺 日志
❓ dsh-whale-widget  判不出  缺 日志
```

原因：`src/render/text.mjs:60` 的 `MAX_NAME_COLS = 20`，比「16 列名字 + 括号 + …」还窄，scope 尾巴被丢弃。

### 1.3 high：JSON 合同与 SPEC 不符（D8-H2）

```
top keys: schemaVersion,meta,host,fishes,summary,fishBuckets,traceCounts,
          bucketNote,traceNote,verdict,nextAction,footnote,degradedCount,skippedSensitive
has top generatedAt: false | has fishes: true | has fish: false
meta keys: generatedAt,pondCheckVersion,scanCount
```

而 `docs/SPEC.md:465` 写 `"generatedAt"`、`:467` 写 `"fish": [{`，且 SPEC 自称「下游只依赖这个」。

### 1.4 high：进程表承诺未实现（D8-H3）

```
fish count: 2 | processes 全部为空: true     ← 两条真机鱼
src/evaluate/index.mjs:633:    processes: [],
```

`docs/SPEC.md:92-96` 的 P1 明写 `/proc/<pid>/{cmdline,cwd,exe,stat}`，`:137` 又写 Linux「全量支持（/proc 可用）」。

### 1.5 high：unknown 灰色零守卫（D8-H4）

把 `src/render/html.mjs:328` 的 `--unknown: #8b949e` 改成 `#3fb950`（灰色→绿色，直接违反 SPEC §5.1），`node --test` 结果：

```
# tests 114
# pass 114
# fail 0
```

→ 项目第一红线「unknown 不许冒充正常」在渲染层没有任何测试在看着。

### 1.6 medium：分桶 ok 门槛过低（D8-M5）

三个产物全 `chmod 000` 的鱼：

```
bucket: ok | 已知格: 1 /6 | summary: {"fish":1,"ok":1,"watch":0,"bad":0,"unknown":5}
fishBuckets: {"ok":1,"watch":0,"bad":0,"unknown":0}
```

六格里五格读不到，鱼却被算成 ✅ 活跃、并计进「认不出 0」。

### 1.7 其余项

`--no-exec`（F-01）已由 `f2ae08a` 闭环（`grep -rn "no-exec" src/ docs/SPEC.md` 零命中）；`win32` 分支确实不存在（`grep` 只命中文档/展示用 `platform` 字段）；`src/render/html.mjs:42` 的 `bad → '死了'` 与 `:50` / `:305` 的 `bad → '坏了'` 确实同页两个词。未逐条重跑的 medium/low 均来自三份报告的原机取证，报告里有命令与输出，可复现。

---

## 2. 为什么把 H1 提级为 blocker（定级说明，允许被质疑）

1. **项目自己定的最高优先级**：`src/rules.json` 的 `policy.note`：「假健康是本项目最高优先级缺陷。」用户装这个工具，就是为了不被「看着没事」骗。
2. **它落在「工具的核心承诺」上，不是边角**：SPEC §5「数据不足不默认正常」。H1 不是数据不足，是**数据只读了一半却当成全部**——比 unknown 更危险，因为它穿着绿衣服。
3. **触发条件是常态**：>256 KiB/天的日志在真机上很常见（一台在跑 B 站轮询的机器一天就够）。不是极端输入。
4. **无任何测试守着**：变异测试里「日志不截断」能杀 4 条，但「截断了还判 clean」这条反方向没人守。
5. **代价低、改法明确**：D8b 给的方案 A（`read/log.mjs` 导出首条时间戳 → 覆盖时长 < 24h 判 `unknown(reason='window_truncated')`）约 20 行 + 1 条回归用例。

不加这一条也能「按规则」判 pass（规则只写了 blocker 才必须 needs_revision），但那是拿规则的下限当标准。**认定：现在的 v0.1.0 会把「2 小时前的 412」报成「健康 干净、不用动」，不该以「假健康检查工具」的身份发布。**

---

## 3. 完整 findings 清单（去重、按 severity 排序）

> 命名：`D8-<级别><序号>`；`来源` 列指向三份报告里的原始编号，便于回溯证据。
> `requiredFix` 是「改什么才能关掉它」，不是建议清单。

### 3.1 已关闭（审查期间修复，保留记录）

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| F-01 | fixed | `--no-exec` 写进 SPEC/rules.json/话术，CLI 不认（实测 exit 2）；两份报告独立发现 | 已修 `f2ae08a`：SPEC 改「默认关闭，不显式开启就不执行」，rules 换 `enabledByDefault:false` + `disableNote`。**遗留**：`rules.json` 的结构化字段仍不在一致性闸范围内 | BOUNDARY M1 + TESTS A1 |
| F-02 | fixed | 首轮 `docs-consistency` 闸 113/114 红，其中 3 条是测试自身假阳性 | 已修 `f2ae08a`：闸重写，现 114/114 绿 | HEALTH M3 |

### 3.2 blocker

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| D8-B1 | **blocker** | `health` 在日志被 256 KiB 尾部截断时仍判 `clean`，话术声称「最近 24 小时日志里没看到报错」并给「不用动」。实测尾部只覆盖 24 小时的 3.7%（约 53 分钟），2 小时前的 3 条 412 完全没算进；HTML/文本里 `truncated` 一次都不出现。位置：`src/evaluate/system.mjs:422,521` + `src/rules.json:798` | ①`src/read/log.mjs` 额外导出缓冲区**第一条可解析时间戳**；②`health` 用 `(now - firstTs)/3600 < windowHours` 判定窗口不完整 → `unknown` + `reason:'window_truncated'` + `missing:['log_window']`；③`rules.json` health 补一条 unknown 文案（「只扫到最近 X 分钟」）；④回归用例：>256 KiB 日志 + 412 在窗口外 24 小时内 → 断言 `level==='unknown'`。**最低限度**（不推荐）：`truncated` 时把「这份干净只覆盖最后 256 KiB」写进 `phenomenon` 并在三层渲染可见 | HEALTH H1 |

### 3.3 high

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| D8-H1 | high | `modelLine`：配置里没有任何 `model/provider/baseUrl/apiBase` → `fail` → `deps broken` → 整条鱼「死了」，话术「跑不起来或者跑起来也白跑」。不是每条鱼都用大模型（B 站轮询、桌面宠物、纯脚本 bot）。`src/evaluate/system.mjs:802` + `rules.json:1164` | 「一个模型相关键都没有」→ `unknown`（「这份配置里没看到模型线路，可能她不用模型，也可能配在别处」）；只有「键在但值为空」才 `fail`。或用 `discovery.kinds[*].requiresModel` 跳过不需要模型的鱼。回归：A7 夹具 → `deps.level !== 'broken'` | HEALTH H2（原中高） |
| D8-H2 | high | JSON 合同改过名（`fish`→`fishes`、`generatedAt`→`meta.generatedAt`），SPEC §6.2 仍写旧名且自称「下游只依赖这个」 | 改 `docs/SPEC.md:465,467` 两行（最省事）；并在 `tests/` 加一条**顶层键集合**合同断言（现在没有任何测试断言顶层键名） | TESTS A2 |
| D8-H3 | high | SPEC §3.2 P1 的 `/proc` 进程表探测完全没实现，`processes` 恒 `[]`；§3.5 又写 Linux「全量支持（/proc 可用）」 | 短期：SPEC §8「已知局限」补「v0.1 不读进程表，liveness 只用文件 mtime」，删掉 §3.5 Linux「全量支持」；长期（v0.2）再实现 P1 | TESTS A3 |
| D8-H4 | high | 「unknown 不许冒充正常」在渲染层零守卫：`--unknown` 改绿，114 用例全绿 | 加 HTML 断言：未知档位的颜色**不等于** ok 绿、且卡片带 `?`；同时补一条「四灯 unknown 计数」断言 | TESTS A4 |
| D8-H5 | high | 同名不同 profile 的鱼在 `--text` 渲染成完全相同的两行（`MAX_NAME_COLS=20` 丢掉 scope），真机复现，且无测试守 | ①`src/render/text.mjs:60` 提到 26 或退化时输出 `dsh-whale…（web）` 短 scope 形式；②加回归用例：两条同名鱼渲染行**名字部分必须不同** | TESTS A5 |

### 3.4 medium

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| D8-M1 | medium | `rules.json` 的 `policy.noNetworkModules` / `forbiddenExec` / `readOnly` / `offline` 是纯声明：全仓无任何代码或测试读它们 ⇒ 边界靠自觉 | 加 `tests/source-guards.test.mjs`：扫 `src/**/*.mjs` 的 import 说明符，命中 `noNetworkModules` 或裸 specifier 即失败；`child_process` 只允许出现在 `src/read/state.mjs` 且必须被 `allowExec` 守卫 | BOUNDARY M2 + TESTS B2 |
| D8-M2 | medium | `--out` 静默覆盖已存在文件（实测把 `DO NOT TOUCH` 覆盖成 9 008 B HTML）并递归建父目录，无存在性检查/无 `--force`；符号链接顺链写 | 目标存在且不是本工具产物时拒绝写入并提示 `--force`；`--help` 注明「会覆盖同名文件」 | BOUNDARY M3 |
| D8-M3 | medium | 非视频鱼缺 `ffmpeg` → `fail` → 整条鱼「死了」（实测一条 活跃+今天 1 条+健康干净+漂移对齐 的鱼被判「死了 1」）。`ffmpegOptional` 生产路径恒 false | 给 `discovery.kinds` 加 `producesVideo`；或把 ffmpeg 缺失默认降为 `warn` | HEALTH H2b |
| D8-M4 | medium | 分桶 `bad` 的展示词「死了」与语义不符：同一份 HTML 里 summary 写「1 坏了」、四灯写「死了」；一条 `deps broken` 但活跃的鱼同时出现 🔴 与「活跃 刚刚」 | 统一成 SPEC §6.1 的「坏了」，或把「死了」只留给 `liveness==='dead'`。回归：deps broken + liveness active 的鱼，四灯与统计行不得出现「死了」 | HEALTH H3 |
| D8-M5 | medium | 鱼级分桶 `ok` 门槛过低：5/6 格读不到、只有 liveness 判出也算 ✅ 活跃（实测 `bucket:ok, 已知格 1/6, summary ok:1 unknown:5`），而 summary 老实写「5 判不出」 | 门槛抬到「已知格 ≥2 且 liveness 已知」；或统计行/四灯加「其中 N 条有多格判不出」 | HEALTH H4 |
| D8-M6 | medium | SPEC 承诺 Windows「明确报 unsupported」，`grep -rn win32 src/` 无分支（`cli.mjs` 无平台判断） | 加 8 行早退：`process.platform==='win32'` → 一行「本版本不扫 Windows」+ 一行下一步，exit 0；测试用注入 platform 覆盖 | TESTS B1 |
| D8-M7 | medium | SPEC §7 的 T13/T14 源码扫描守卫既无测试、CI 也没有该步骤 | 新增 `tests/source-guards.test.mjs`（T13 零网络/零裸依赖、T14 阈值只来自 rules）并入 CI | TESTS B2 |
| D8-M8 | medium | JSON 值级脱敏（防御纵深）零测试：关掉 `redactValue` 的脱敏分支，114 用例全绿 | 加一条形似凭证名的 `name` 用例，断言输出为 `sensitivePathToken` | TESTS B3 |
| D8-M9 | medium | `--root` / `--log` / `--dedupe` 指到不存在路径：实测 warn + exit 0，但无用例锁 | 补 3 条 CLI 用例（stderr 有话、exit 0、报告仍出） | TESTS B4 |
| D8-M10 | medium | SPEC:39「不写用户目录」与默认往 cwd 写 `pond-check-<ts>.html` 的措辞冲突（用户分不清「只读」到底指什么） | SPEC 补一句：「唯一写盘 = 报告文件；默认 cwd，可用 `--out` 指定，绝不写进鱼的窝」 | TESTS D5 |

### 3.5 low

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| D8-L1 | low | 环境变量 `POND_CHECK_RULES` 让 `loadRules()` 读任意路径（含凭证文件），无名字闸；CLI 路径不可达（实测 0 open），仅库 API | `customPath` 解析前走一次 `isSensitiveFileName(basename)`，命中返回 null | BOUNDARY L1 |
| D8-L2 | low | `config.json` 内容整份读进内存再解析（敏感键只是「不输出」不是「不读」）；实测 0 泄漏，属设计内 | 不改代码；README/`--help` 隐私段落写清「只判存在性，值不落任何输出」 | BOUNDARY L2 |
| D8-L3 | low | 模式外的凭证味目录（`minasCred`/`minasCert`）被 `readdir` 列名（不 open 内部文件、名字不进报告） | 保守补 `*cred*`/`*cert*` 类目录模式，注意别误杀 `credits` 这类无关目录 | BOUNDARY L3 |
| D8-L4 | low | 默认模式在 cwd 累积 `pond-check-<时间戳>.html`，不清理不覆盖 | 文档提一句；或后续加 `--out` 默认固定名 | BOUNDARY L4 |
| D8-L5 | low | `windowStale` 时 `nextStep` 直接拼接，出现「不用动。先看「存活」那栏…」的自相矛盾 | 改为**替换**而非拼接（rules 里加 `health.variants.windowStale.nextStepTemplate`） | HEALTH M1 |
| D8-L6 | low | 数字关键词边界只排数字与点、不排字母：`BV412`、`?aid=412` 会被算成风控（假报警方向） | 数字关键词要求前后是空白/标点；或匹配前剥掉 URL 与 `BV[0-9A-Za-z]{10}` 形态的 token | HEALTH M2 |
| D8-L7 | low | SPEC §531「sqlite 无驱动时读 mtime/size 估算」与实现不符（实现是 `count=null` + `reason`，更保守） | 改 SPEC 措辞为「无驱动时条目数 `unknown`，只保留 mtime」 | TESTS D7 |
| D8-L8 | low | README:7 「D1–D7 七个阶段」已过时（实际到 D8） | 改 D1–D8 或删掉阶段描述 | TESTS D8 |
| D8-L9 | low | `docs/CAPABILITIES-SPEC.md`（387 行记忆/唤醒/TTS/出图设计）在仓库里零实现，易被读成「已支持」 | README 加一行：「该文件是**未实现的设计稿**，v0.1 不含这些能力」 | TESTS D9 |
| D8-L10 | low | 测试侧债务合集：①10 条弱断言（`evaluate:259 assert.ok(footnote)`、`boundary:724/725 length>0`、`boundary:446 !==null`、`discover:59/79`、`read:89/106`、`render:165-171`、`evaluate:176/178`）；②`tests/evaluate.test.mjs:437` 硬编码 `3600`，违反「改阈值只改 rules.json」；③5 项环境敏感点（root 下 chmod skip、软链/FIFO 仅 POSIX、5 处 `elapsed<5000` 墙上时钟、1ms 超时、1 GiB 稀疏文件）无留痕 | 按 TESTS §4 表逐条强化；`3600` 改读 `rules.json`；环境敏感点加 `t.skip` 说明或改相对阈值 | TESTS §4/§7/§8.3 |

---

## 4. 去重说明（三份报告之间重复的项）

| 重复内容 | 出现处 | 合并为 |
|---|---|---|
| `--no-exec` 不存在 | BOUNDARY M1（独立发现）+ TESTS A1（独立发现） | F-01（已修） |
| 「缺守卫 / 声明没有闸门」同一族 | BOUNDARY M2（policy 声明无闸）→ TESTS A4（unknown 颜色）/ B3（脱敏）/ B2（T13/T14） | 拆成 D8-M1（源码闸）、D8-H4（unknown 颜色）、D8-M8（脱敏）、D8-M7（T13/T14），**同一份 `tests/source-guards.test.mjs` 可一起关掉前两项** |
| 「deps 里推断 → 整鱼死了」同一族 | HEALTH H2（modelLine）/ H2b（ffmpeg） | 拆成 D8-H1 / D8-M3（两个不同检查项，改法不同） |
| 「话术自相矛盾」 | HEALTH M1（windowStale 拼接） | D8-L5（与 D8-B1 同一处代码，修 H1 时顺手） |
| 「文档与实现不符」 | TESTS D2/D3/D5/D7 | D8-H2（JSON 合同）/ D8-H3（进程表）/ D8-M10（只读措辞）/ D8-L7（sqlite 措辞） |

---

## 5. 转 pass 的最短路径（建议按此顺序）

**P0（不做完不建议发 v0.1.0）**

1. **D8-B1** 健康窗口不完整 → `unknown`（约 20 行 + 1 条回归）。这是唯一 blocker。
2. **D8-H5** `--text` 名字列宽 + 「同名鱼可区分」回归（改一个常量 + 1 条用例）。
3. **D8-H2** 改 SPEC 两行键名 + 一条顶层键集合合同测试。

**P1（同一迭代内，做完成本很低）**

4. D8-H4 + D8-M1 + D8-M8 + D8-M7 → 新建 `tests/source-guards.test.mjs`，一次把「零网络/零裸依赖/unknown 不许绿/脱敏/阈值来源」五类红线钉住（四份报告都指向同一件事：**红线没有守卫**）。
5. D8-H1 + D8-M3 → deps 的两处推断降为 `unknown`。
6. D8-M5 + D8-M4 → 分桶口径与展示词。

**P2（v0.1.x 再说）**：D8-H3 / D8-M2 / D8-M6 / D8-M9 / D8-M10 与全部 low。

---

## 6. 正面结论（三份报告都验过、值得写进发布说明）

- **只读边界零破坏**：零网络（grep exit 1 + `strace` 零 socket）、零依赖（四个依赖键不存在、零裸 import）、凭证零泄漏（假凭证炸弹三渲染 0 命中、`strace` 级 0 次 open）、写盘只有报告本身（`--text`/`--json` 0 写、假 HOME 0 项、`execve` 仅 node 自身、`kill` 类 0）。
- **六格默认值全部 `unknown`**，源码无 `|| 'ok'` / `?? 'clean'` 兜底；`deps` 只探到 2 项 → `unknown` 不是 `ready`；判重表无时间戳 → `unknown` 不是 `quiet`；空日志/二进制 → `unknown`（D6 的 B1/B2 修复有效）。
- **测试不是自我安慰**：15 个注入缺陷 12 个被抓（80%），判定层尤其硬（「unknown 当 ok」一次杀 17 条）；边界压测真的在造坏环境（chmod 000 / FIFO / 软链成环 / 1 GiB 稀疏文件 / 二进制 / 时钟错乱）。
- **降级链路三层可见**：`degraded` 在文本 / HTML / JSON 都有，`fixes` 只收非 ok 格，`rules.json` 的 unknown 档没有任何「不用动」话术。

---

## 7. 验收门证据

```
$ ls docs/AUDIT-*.md
docs/AUDIT-BOUNDARY.md  docs/AUDIT-HEALTH.md  docs/AUDIT-SUMMARY.md  docs/AUDIT-TESTS.md

$ npm test … → node --test
# tests 114
# pass 114
# fail 0
# cancelled 0
# skipped 0
exit 0
```

本次收口复核动作（全部真跑，见 §1）：H1 反例重建 + 三种渲染、A5 真机两行撞脸、A2 顶层键打印、A3 `processes` 全空、A4 变异（unknown 改绿 → 114 全绿）、H4 chmod 000 分桶、SPEC/`win32` 定点核对。

---

## 8. 局限

1. **medium/low 未逐条重跑**：它们来自三份报告的原机取证（各自附命令与输出），我复核了其中影响结论走向的部分（§1.7）。
2. **平台**：全部结论在 Linux / Node 22.23.4 上取得；Windows / macOS 的边界与分桶行为未验证（D8-M6 本身就是这个缺口）。
3. **severity 提级是我的判断**：D8-B1 在原报告是「高」，收口按 `rules.json` 的「假健康是本项目最高优先级缺陷」提级为 blocker 并在 §2 写明理由——不同意可以按「高」重判，但**这条缺陷本身不该带着发版**。
4. 本文只做汇总与定级，**没有改动任何代码或测试**（本轮唯一写入 = 本文件）。
