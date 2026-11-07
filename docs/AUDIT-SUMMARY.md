# D8 审查收口：结论与遗留项（AUDIT-SUMMARY）

- **基线**：`b110106`（fix(D8)：关闭 P0 blocker 与三条 high）——本文件在**重判轮（attempt 2）**更新
- **输入**：三份审查报告 —— [AUDIT-BOUNDARY](AUDIT-BOUNDARY.md)（c7248e1）、[AUDIT-HEALTH](AUDIT-HEALTH.md)（9732029）、[AUDIT-TESTS](AUDIT-TESTS.md)（9c5c92b）
- **收口动作**：三份报告 findings 去重 → 回 HEAD 亲自复核 → 定级 → verdict；`b110106` 落地后**逐条重跑原反例**再判一次
- **验收门**：`npm test` **121/121 exit 0**；三份审查报告 + 本汇总均存在

---

## 0. 本轮重判（attempt 2 相对 attempt 1）

上一轮判 **needs_revision**（1 blocker + 5 high + 10 medium + 10 low）。随后 `b110106` 声称关闭「P0 blocker + 三条 high」。我逐条重跑，结果如下——**不读提交说明，只重跑我自己那份反例**：

| finding | 上轮 | 现在 | 我这轮的实测证据 |
|---|---|---|---|
| **D8-B1** 假健康（尾部截断仍判 clean） | blocker | ✅ **关闭** | 同一份 24h / 86 400 行 / 7.17 MB 日志 → `health: unknown`，`evidence: {truncated:true, coveredHours:0.9, reason:'window_truncated', missing:['log_window']}`；phenomenon「日志太大了，这次只看了最后一段（覆盖 0.9 小时，不到 24 小时），所以「没看到报错」不等于「真的没报错」。」；文本行「3 项数据读不到（节律、健康、依赖），不能当正常」 |
| **D8-H2** JSON 合同与 SPEC 不符 | high | ✅ **关闭** | SPEC:465 已写 `meta.generatedAt`、:467 已写 `fishes`，:498 另加「字段名以实际实现为准」注记；`--json` 实测顶层键与之吻合 |
| **D8-H5** 同名鱼撞脸 | high | ✅ **关闭** | 真机两条 dsh-whale-widget 现在渲染成 `❓ widget（…105-1703）` / `❓ hale-widget（…web）`，可区分（代价是掉了公共前缀，可接受） |
| **D8-M1** policy 声明无闸门 | medium | ✅ **关闭** | 新增 `tests/source-guards.test.mjs` 7 条守卫，直接读 `RULES.policy.noNetworkModules` / `forbiddenExec`，并加「写文件只允许 cli.mjs」 |
| **D8-M7** T13/T14 源码守卫缺失 | medium | ✅ **关闭** | 同上文件（不联网 ×2 / 不外执行 / 只读写盘） |
| **D8-M8** JSON 值级脱敏零测试 | medium | ✅ **关闭** | 行为断言：`id_ed25519` / `~/.npmrc` 必须被替换、修复话术必须保留；另外提交顺手修掉一个真泄漏（fixes 长版未走脱敏） |
| **D8-H4** unknown 灰色零守卫 | high | ⚠️ **未关闭（部分）** | 新增 4 条 unknown 断言，但查的是 **class 名**（`card-unknown` / `light-unknown` / 文本不带 ✅），**没有查颜色**。我重跑原变异：`--unknown: #8b949e` → `#3fb950`，`node --test` 仍然 **121 pass / 0 fail**；而 `.light-unknown { background: var(--unknown) }`（html.mjs:424）说明颜色就是灯色 → **原缺陷可原样复现，守卫没拦住**。提交说明称「H4 关闭」，属于**假闭环** |
| **D8-H1** modelLine 推断型 fail | high | ❌ **未关闭** | `config.json` 只有 `{"schemaVersion":3}` → `modelLine: fail` → `deps: broken/bad` → 鱼 `bucket: bad`（headline「依赖 坏了」），话术仍是「跑不起来或者跑起来也白跑」。不是每条鱼都用大模型 |
| **D8-H3** 进程表承诺未实现 | high | ❌ **未关闭** | `processes: []`；SPEC:92-96 的 P1 `/proc` 探测、:137「Linux 全量支持」、:106「黑盒鱼」一节仍在 |
| **D8-M3** 非视频鱼缺 ffmpeg → fail | medium | ❌ **未关闭，且提级 high** | `resolveFfmpegOptional`（system.mjs:894）分支写好了，但 `rules.json` 里 `ffmpegOptionalKinds` 未定义、5 个 kind 的 `producesVideo` **全是 null** → 生产路径恒 false。实测 `PATH=/nonexistent` → `ffmpeg: fail` → `deps: broken` → `bucket: bad` |

---

## 1. Verdict：**needs_revision**（比上一轮大幅收窄）

**结论**：blocker **已清零**（B1 真修好了，我复核过反例）。但现在还有 **2 条会当场误判真鱼的 high**、**1 条文档承诺未兑现**、**1 条「守卫假闭环」**——其中前两条**同一个根因**，一次概念修正就能同时关掉。

| 级别 | 数量 | 是什么 |
|---|---|---|
| blocker | **0** | 假健康已闭环 |
| high | **4** | D8-H1、D8-M3（← 提级）、D8-H3、D8-H4（守卫没守住） |
| medium | 6 | `--out` 覆盖 / 「死了」用词 / 分桶门槛 / Windows / 缺用例 / SPEC 措辞 |
| low | 10 | 见 §4.5 |
| 本轮已关闭 | 6 | B1、H2、H5、M1、M7、M8（上一轮还关了 F-01/F-02） |

**为什么仍然不是 pass**：`D8-H1` 与 `D8-M3` 会让体检对着**一条正常的鱼**喊「依赖 坏了 / 死了」——旗舰场景（B 站轮询机器人、桌面宠物）恰恰是「不用大模型、不产视频」的那类。零 blocker，但**发版第一天就会收到「它说我死了，其实我在跑」的 issue**，而这正是本工具最不该犯的错（方向与假健康相反，但同样毁信任）。

**给队长的两条路（我不替你做决定）**

- **路 A（推荐）**：修 §3 的 P0 两条（同一个根因，约 30 行 + 2 条回归）→ 我把 H1/M3 标关闭，剩下的 H3（SPEC 两段话）与 H4（一条颜色断言）都是 10 行级 → 我给 **pass**。
- **路 B**：判断「假报警可接受」，把 H1/M3 写进 README「已知问题」+ CHANGELOG 的 Known issues → 回我一句「按 accepted-risk 处理」，我在本文件标 **accepted-risk** 并改判 **pass**（无 blocker 时这属于发布裁量权，我不会用规则卡你）。

---

## 2. 为什么把 D8-M3 提级为 high（本轮定级口径）

同一类错误的两个实例：

- **H1**：配置里**没有**模型字段 → 判 `fail`。「这份配置没写」≠「她需要模型且没配」。
- **M3**：PATH 上**没有** ffmpeg → 判 `fail`。「这台机器没装 ffmpeg」≠「这条鱼要用 ffmpeg」。

两者都落在 deps 六项检查里，都直接把整条鱼推进 `bad` 桶（「死了」），都在**最常见的鱼种**上触发。D8b 把 M3 定为「中」是因为 D4b 先报过；但既然这是发布闸门，我按**用户可见后果**定级，不按「谁先报的」定级。

**一个概念修正同时关掉两条**：把 deps 的 `fail` 语义收紧成「**证伪才 fail**」——

- 模型线路：键在且非空 → `pass`；键在但空 → `fail`；**一个键都没有 → `unknown`**（「这份配置里没看到模型线路，可能她不用模型，也可能配在别处」）。
- ffmpeg：`producesVideo !== true` 的鱼（B 站轮询、桌面宠物、astrbot）→ `warn` 或 `unknown`；只有声明产视频的鱼才 `fail`。`resolveFfmpegOptional` 的骨架已经写好，**只差把 `rules.json` 的 `ffmpegOptionalKinds` / `producesVideo` 填上**。

---

## 3. 本轮要动手的四条（按性价比排序）

### P0-1 D8-H1 + D8-M3：deps 的「没看到」不许当「坏了」（约 30 行）

| 项 | 内容 |
|---|---|
| 位置 | `src/evaluate/system.mjs:802`（modelLine）、`:714`（ffmpeg）、`src/rules.json:1164`（modelLine 检查项）、rules 的 `discovery.kinds[*].producesVideo` / `deps.thresholds.ffmpegOptionalKinds` |
| 改法 | 见 §2 的两段语义；判成 `unknown` 时 fixes 不许出现「跑不起来」这类话术，改成「这份配置里没看到…」+「如果她确实要模型，把 model/baseUrl 写进 config.json」 |
| 回归 | ①`{"schemaVersion":3}` 夹具 → 断言 `deps.level !== 'broken'`；②`PATH=/nonexistent` + 非视频 kind → 断言 `ffmpeg` 不是 `fail`（或整鱼不进 `bad` 桶） |

### P0-2 D8-H3：把「进程表」这件事在 SPEC 里说清楚（两段话）

`processes` 恒 `[]` 短期不好补（要 `/proc` 解析 + 黑盒鱼），但**不能继续在 SPEC 里承诺**：

- §8「已知局限」补一条：「v0.1 不读进程表：只按目录 / `--root` 定位；`processes` 恒空；`liveness` 只用文件 mtime。」
- §3.5 表格把 Linux 的「全量支持（`/proc` 可用）」改成「文件信号全支持；进程表见 §8」。
- （可选）§4.1「黑盒鱼」一节加「v0.1 未实现」。

### P0-3 D8-H4：把守卫从「类名」补到「颜色」（约 5 行）

现有 4 条断言查的是 `card-unknown` / `light-unknown` 类名——我那把「灰改绿」的刀从旁边过去了。补一条就够：

```js
// 断言 unknown 的灯色不等于 ok 绿
const html = renderHtml(unknownFishReport());
const unknownHex = /--unknown:\s*(#[0-9a-fA-F]{6})/u.exec(html)?.[1]?.toLowerCase();
const okHex = /--ok:\s*(#[0-9a-fA-F]{6})/u.exec(html)?.[1]?.toLowerCase();
assert.ok(unknownHex && okHex && unknownHex !== okHex,
  'unknown 用了和 ok 一样的绿 —— 灰的冒充成绿的了');
```

### P1 D8-M2 / M4 / M5 / M6 / M9 / M10

`--out` 覆盖保护、统一「坏了」、分桶 ok 门槛、Windows 早退、`--root` 不存在路径用例、SPEC「只读/写盘」措辞——都是小改，见 §4.4。

---

## 4. 完整 findings 清单（去重、按 severity 排序，含状态）

> `来源` 指向三份报告的原编号。状态：**closed（本轮）** / **open** / **accepted-risk**（队长裁量）。

### 4.1 已关闭（8 条，保留台账）

| id | severity | problem | 关闭方式 | 来源 |
|---|---|---|---|---|
| F-01 | fixed | `--no-exec` 写在 SPEC/rules 里但 CLI 不认（exit 2） | `f2ae08a`：SPEC 改「默认关闭」措辞、rules 换 `enabledByDefault:false` | BOUNDARY M1 + TESTS A1 |
| F-02 | fixed | `docs-consistency` 闸首轮 113/114 红（3 条是测试自身假阳性） | `f2ae08a` 重写闸 | HEALTH M3 |
| D8-B1 | blocker→closed | health 在 256 KiB 尾部截断时判 clean，声称 24h | `b110106`：`firstTimestamp` + `coveredHours` + `window_truncated` → 我复核为 `unknown` | HEALTH H1 |
| D8-H2 | high→closed | JSON 合同 `fish`/`generatedAt` 与 SPEC 不符 | `b110106`：改 SPEC 两行 + 注记 | TESTS A2 |
| D8-H5 | high→closed | 同名不同 profile 的鱼渲染成两行相同 | `b110106`：压缩后做冲突检测，给 scope 留位置 | TESTS A5 |
| D8-M1 | medium→closed | policy 声明无闸门 | `tests/source-guards.test.mjs` 直接读 `RULES.policy` | BOUNDARY M2 |
| D8-M7 | medium→closed | T13/T14 源码守卫缺失 | 同上（不联网 ×2、不外执行、只读写盘） | TESTS B2 |
| D8-M8 | medium→closed | JSON 值级脱敏零测试 | 行为断言 + 顺手修掉 fixes 长版真泄漏 | TESTS B3 |

### 4.2 blocker

**无。**

### 4.3 high（4 条，全部 open）

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| D8-H1 | high | `modelLine`：配置里一个模型键都没有 → `fail` → deps `broken` → 整条鱼「坏了/死了」；实测 `{"schemaVersion":3}` 即触发 | 「一个键都没有」→ `unknown`；只有「键在值为空」才 `fail`；fixes 文案同步改。回归：A7 夹具 `deps.level !== 'broken'` | HEALTH H2 |
| D8-M3 | **high**（原中，提级） | 非视频鱼缺 ffmpeg → `fail` → 整鱼「死了」；`resolveFfmpegOptional` 分支已写但 `ffmpegOptionalKinds`/`producesVideo` 全未配，生产恒 false。实测 `PATH=/nonexistent` → `deps broken / bucket bad` | 填 rules：`discovery.kinds[*].producesVideo`（bilibili / desktop-pet / astrbot = false）或 `deps.thresholds.ffmpegOptionalKinds`；没声明产视频的鱼 ffmpeg 缺失降 `warn`/`unknown` | HEALTH H2b |
| D8-H3 | high | SPEC §3.2 P1 的 `/proc` 进程表未实现，`processes` 恒 `[]`；§3.5 仍写 Linux「全量支持」、§4.1 仍写「黑盒鱼」 | SPEC §8 补「v0.1 不读进程表，liveness 只用文件 mtime」；§3.5 去掉「全量支持」；§4.1 标「v0.1 未实现」 | TESTS A3 |
| D8-H4 | high | 「unknown 不许冒充绿」守卫**查类名不查颜色**：重跑 `--unknown: #8b949e → #3fb950`，`node --test` 仍 121/121 全绿；而 `.light-unknown { background: var(--unknown) }` 说明这颜色就是灯色 | 补一条颜色断言（§3 P0-3 的 5 行），并自测「改绿必须变红」 | TESTS A4 |

### 4.4 medium（6 条，全部 open）

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| D8-M2 | medium | `--out` 静默覆盖已存在文件（实测把 `DO NOT TOUCH` 覆盖成 9 008 B）+ 递归建目录，无 `--force`，符号链接顺链写 | 目标存在且非本工具产物时拒绝 + `--force`；`--help` 注明 | BOUNDARY M3 |
| D8-M4 | medium | 分桶 `bad` 同页两个词：四灯/统计行「死了」，summary「坏了」；deps broken 但活跃的鱼同屏 🔴 + 「活跃 刚刚」 | 统一「坏了」，或只把「死」留给 `liveness==='dead'`。回归：deps broken + liveness active 不得出现「死了」 | HEALTH H3 |
| D8-M5 | medium | 分桶 `ok` 门槛过低：实测 1/6 格已知仍 `bucket:ok`、`fishBuckets ok:1 unknown:0`，summary 却写 `unknown:5` | 门槛抬到「已知格 ≥2 且 liveness 已知」；或统计行加「其中 N 条有多格判不出」 | HEALTH H4 |
| D8-M6 | medium | Windows「明确报 unsupported」未实现（`grep win32 src/` 只命中 ffmpeg 文件名与 rules 表） | 8 行早退 + 注入 platform 的测试 | TESTS B1 |
| D8-M9 | medium | `--root` / `--log` / `--dedupe` 指到不存在路径（warn + exit 0）无用例锁 | 补 3 条 CLI 用例 | TESTS B4 |
| D8-M10 | medium | SPEC:39「不写用户目录」与默认往 cwd 写 `pond-check-<ts>.html` 措辞冲突 | SPEC 补一句「唯一写盘 = 报告文件；默认 cwd，可用 `--out`，绝不写进鱼的窝」 | TESTS D5 |

### 4.5 low（10 条，全部 open）

| id | severity | problem | requiredFix | 来源 |
|---|---|---|---|---|
| D8-L1 | low | `POND_CHECK_RULES` 让 `loadRules()` 读任意路径（含凭证文件）无名字闸；CLI 不可达（strace 0 open），仅库 API | `customPath` 先过 `isSensitiveFileName` | BOUNDARY L1 |
| D8-L2 | low | `config.json` 整份进内存再解析（敏感键只跳输出）；实测 0 泄漏，设计内 | 文档写清口径即可 | BOUNDARY L2 |
| D8-L3 | low | 模式外的凭证味目录（`minasCred`/`minasCert`）被 readdir 列名（不 open、名字不进报告） | 保守补 `*cred*`/`*cert*` 目录模式 | BOUNDARY L3 |
| D8-L4 | low | 默认模式在 cwd 累积带时间戳 HTML | 文档提一句 | BOUNDARY L4 |
| D8-L5 | low | `windowStale` 的 nextStep 拼接出「不用动。先看「存活」那栏」 | 改替换而非拼接 | HEALTH M1 |
| D8-L6 | low | 数字关键词不排字母：`BV412` / `?aid=412` 误判风控 | 前后要求空白/标点，或先剥 URL/BVID | HEALTH M2 |
| D8-L7 | low | SPEC:536「sqlite 无驱动时读 mtime/size」与实现不符（实现更保守） | 改措辞为「条目数 unknown，只保留 mtime」 | TESTS D7 |
| D8-L8 | low | README 的 D1–D7 阶段描述（D7a 重写后已改善，可复查） | 一并核对 | TESTS D8 |
| D8-L9 | low | `docs/CAPABILITIES-SPEC.md` 零实现的设计稿易被读成已支持 | README 加「未实现设计稿」指针 | TESTS D9 |
| D8-L10 | low | 测试债务：10 条弱断言 + `evaluate.test:437` 硬编码 3600 + 5 项环境敏感点无留痕 | 按 TESTS §4 表强化；3600 改读 rules；敏感点加 skip 说明 | TESTS §4/§7/§8.3 |

---

## 5. 本轮我实际跑过的复核命令（可复现）

```bash
# blocker 复跑（同一份 24h / 86400 行 / 7.17 MB 日志，2h 前 3 条 412 在尾窗之外）
node src/cli.mjs --root /tmp/d8sum-h1 --json   # health: unknown, coveredHours 0.9, missing ['log_window']
node src/cli.mjs --root /tmp/d8sum-h1 --text   # 「3 项数据读不到（节律、健康、依赖），不能当正常」

# H5 真机
node src/cli.mjs --text                        # ❓ widget（…105-1703） / ❓ hale-widget（…web）

# H2
node src/cli.mjs --json                        # 顶层 …fishes…；SPEC:465 meta.generatedAt / :467 fishes

# H4 原变异重跑
cp -a . /tmp/d8mut2 && sed -i 's/--unknown: #8b949e;/--unknown: #3fb950;/' /tmp/d8mut2/src/render/html.mjs
( cd /tmp/d8mut2 && node --test )              # 121 pass / 0 fail   ← 守卫没拦住

# H1
printf '{"schemaVersion":3}' > cfg.json; node src/cli.mjs --root <夹具> --json
# deps: broken bad；checks: …, modelLine: fail, …；bucket: bad

# M3
PATH=/nonexistent node src/cli.mjs --root <夹具> --json
# ffmpeg: fail → deps: broken → bucket: bad（rules 的 ffmpegOptionalKinds=undefined、producesVideo 全 null）

# H3
node src/cli.mjs --root <夹具> --json          # processes: []
grep -n '进程表\|/proc\|全量支持' docs/SPEC.md # :92-96 / :106 / :137 仍在

# 基线
npm test                                       # 121 tests / 121 pass / 0 fail / exit 0
```

---

## 6. 正面结论（本轮又加强了）

- **只读边界零破坏**：零网络（现已从「我 grep 过」升级为 `tests/source-guards.test.mjs` 闸门）、零依赖、凭证零泄漏、写盘只有 `cli.mjs` 一处（同样进了闸门）。
- **假健康主链路真的修好了**：B1 的修法不是打补丁，而是把「窗口覆盖了多少」变成证据（`coveredHours`）并写进人话——这是本项目的正确方向。
- **红线从 0 守卫到 6 条**：unknown 类名 / 文本 ✅ 标记、JSON 脱敏、只读写盘、不联网 ×2、不外执行——只差 unknown 的**颜色**这一条（H4）。
- **测试仍是硬的**：121 用例全绿，判定层变异仍能成片杀。
- **修复质量本身不错**：`b110106` 顺手抓到 `json.mjs` fixes 长版未脱敏的真泄漏，并补了 `cli.mjs` 的 shebang（`npm i -g` 装出来不再坏）——这两条都不在审查清单里。

---

## 7. 局限

1. medium/low 未逐条重跑（沿用三份报告的原机取证）；high 及以上**全部**由我本轮亲自复跑。
2. 全部结论基于 Linux / Node 22.23.4；Windows 行为未验证（D8-M6 就是这个缺口）。
3. D8-M3 由 medium 提为 high 是我的定级判断，理由在 §2；不同意可以按 medium 处理，但它和 H1 是同一个用户可见后果。
4. 本轮唯一写入 = 本文件；未改任何代码或测试。
