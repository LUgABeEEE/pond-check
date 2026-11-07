# pond-check · 假健康审查（D8b / AUDIT-HEALTH）

- 审查对象：`v0.1.0` 工作树 @ `f2ae08a`（D7/D8 修完文档-实现不一致之后；首轮审查起点是 `3ff97e0`，两个 commit 之间只改了 `--no-exec` 措辞与文档闸，不涉及本文任何结论）
- 审查范围：`src/discover` → `src/read` → `src/evaluate` → `src/render` → `src/cli.mjs` 全链路
- 审查方式：**只读**。读源码 + 构造反例真跑（不改任何代码、不提交任何 src/）
- 审查环境：Linux / Node 22.23.4 / 仓库 `/data/agent/workspace/大肥鱼/pond-check`
- 本项目最高优先级缺陷是「假健康」：把「没看到」说成「没问题」。这份文档只干一件事 —— 找出所有会让用户以为没事、但实际上没看见的地方。

## 0. 一句话结论

**六格的默认值全部是 `unknown`（没有一个指标在缺数据时默认 ok），unknown 分支、降级链路、统计口径整体成立；但发现 1 个高危假健康缺陷（健康栏在日志被尾部截断时仍判「干净」并声称「最近 24 小时」）、2 个推断型误判（模型线路、ffmpeg「没找到就判坏了」，后者 D4b 已上报）、1 个鱼级分桶口径漏洞（5/6 格读不到仍算「活跃」）。**

| # | 严重度 | 一句话 | 位置 |
| --- | --- | --- | --- |
| H1 | **高（真缺陷）** | 日志被 256 KiB 尾部截断时，健康仍判 `clean`「最近 24 小时日志里没看到报错」—— 实测只覆盖了 24 小时的 **2%**，且 HTML/文本里没有任何提示 | `src/evaluate/system.mjs:422,521` + `src/rules.json:798` |
| H2 | 中高（推断型判定） | `modelLine`「配置里没找到 model/provider/baseUrl/apiBase → fail」→ deps `broken` → 整条鱼 🔴 | `src/evaluate/system.mjs:802`（rules: `src/rules.json:1164`） |
| H2b | 中（同类，已被 D4b 上报） | 非视频鱼缺 ffmpeg → `fail` → 整条鱼 🔴「死了」；实测一条活跃+出货+干净+对齐的鱼因此显示「死了 1」 | `src/evaluate/system.mjs:714` |
| H3 | 中 | 鱼级分桶 `bad` 的展示词是「死了」，但 `bad` 也包含 deps/health/drift 的「坏」——同一行里会出现「🔴 … 活跃 刚刚 … 依赖 坏了」 | `src/render/text.mjs:36,76` / `src/render/html.mjs:42` |
| H4 | 中 | 鱼级分桶 `ok` 的门槛过低：只要「存活/工作量」有一格判出、且无坏无警，就 ✅ 活跃并计入「活跃 N」——实测 5/6 格读不到的鱼也算「活跃 1 / 认不出 0」 | `src/evaluate/index.mjs:482-493` |
| M1 | 低 | `windowStale` 话术与 rules 原话拼接后自相矛盾：「不用动。先看「存活」那栏确认她还在跑」 | `src/evaluate/system.mjs:499` |
| M2 | 低（假报警，非假健康） | 关键词边界只排数字与点，不排字母：`BV412`、`?aid=412` 这类会被算成风控 | `src/read/log.mjs`（边界匹配） |
| M3 | —（已在 `f2ae08a` 修复，复验 114/114 绿） | 首轮审查时全仓 113/114：文档-实现一致性闸 1 红，其中 2 条是真违规（`--no-exec`/`--version`）、3 条是测试自身假阳性；现已清掉伪参数并把闸重写 | `tests/docs-consistency.test.mjs:79` |

> **正面结论先说**：六格的默认值全部是 `unknown`，源码里没有任何 `|| 'ok'` / `?? 'clean'` 兜底；`deps` 六项只探到 2 项时判 `unknown` 而不是 `ready`；空目录 / 不存在的窝 / 过滤没命中都不进「正常」；`summary` 把 unknown 单独计数、绝不算进 ok；三层渲染都显示降级数量。详见 §7。

---

## 1. 默认值审查：数据缺失时各指标是什么

**方法**：读实现 + 构造「六格全空」的 PondRead 走真实 `evaluate()`（不是看注释）。

```
$ node /tmp/audit-matrix.mjs
【1 empty（什么都没读到）】bucket=unknown severity=unknown cells(ok=0,unknown=6)
   live=unknown rhyt=unknown thro=unknown heal=unknown deps=unknown drif=unknown
   脚注: YES | 1 条鱼 · 六格口径：0 正常 · 0 要注意 · 0 坏了 · 6 判不出。这些项不是正常，是没看到。
```

| 指标 | 数据缺失时的档位 | 依据（实现） | 结论 |
| --- | --- | --- | --- |
| liveness | `unknown` + `missing:['log','session','dedupe']` | `life.mjs` 四源全空 → `assemble(level:'unknown')` | ✅ 不是 ok |
| rhythm | `unknown` + `missing:['timestamps']` 或 `['log']` | `life.mjs` `hasAnyTimestamp === false` 分支 | ✅ 不是 steady |
| throughput | `unknown` + `missing:['dedupe']` | `life.mjs` `totalEntries === null` 分支 | ✅ 不是 quiet/empty |
| health | `unknown` + `missing:['log']` | `system.mjs` 无 log / log.ok!==true / lineCount===0 / keywords 缺计数 | ✅ 不是 clean |
| deps | `unknown`（六项全 unknown → bands 的 `unknown` 档） | `system.mjs:buildCheck` 每项默认 `status:'unknown'` | ✅ 不是 ready |
| drift | `unknown` + `missing:['schemaVersion']` | `system.mjs` `schemaVersion === null` | ✅ 不是 aligned |

**源码扫描（没有任何「默认 ok」兜底）**：

```
$ grep -rnE "\|\| *'(ok|clean|ready|aligned|active|productive|steady)'|\?\? *'(ok|clean|ready|aligned|active|productive|steady)'" src/ --include=*.mjs | grep -vE ":[0-9]+: *(\*|//)"
$ echo $?
1        # = 无命中（唯一的两处出现都在注释里，说的是「本文件没有 || 'ok'」）
```

`catch` 分支也全部落到 `unknown`：

```
$ grep -n "level: 'unknown'" src/evaluate/*.mjs
src/evaluate/index.mjs:590:    level: 'unknown',          ← failedFish（聚合自己崩了）
src/evaluate/life.mjs:383/733/1047/1122/1248/1270
src/evaluate/system.mjs:183/208/321/931
```
（这 11 处全部是「判不出」的落点，没有一处写 `ok`/`clean`。）

---

## 2. 每条 `unknown` 分支：显式 unknown，还是悄悄降级？

逐条对照 `rules.json` 的 `unknownWhen` 与实测：

| 指标 | rules 声明的 unknown 触发 | 实现 | 实测 |
| --- | --- | --- | --- |
| liveness | 所有源都不存在 / 全部无效（未来时间、epoch 0）/ 超时 | 四源 status 分别记 `missing/invalid/skipped_sensitive`，全空才 unknown；未来时间超 `futureSkewToleranceSec` 记 `clock_skew`；`epoch 0` 记 `invalid` | A1/A5 实测 unknown ✅ |
| rhythm | 没有任何带可解析时间戳的记录 | `hasAnyTimestamp` 为 false → unknown；日志覆盖不足 7 天 → unknown(`insufficient_coverage`) | A2/A4 实测 unknown ✅ |
| throughput | 判重表不存在 / sqlite 无驱动 / 超时 | `count===null` → unknown；`todayNew===null`（有条目无时间戳）→ **unknown，不命中 quiet** | 矩阵场景 8 实测 unknown ✅ |
| health | 无日志 / 尾部无可读行 / 权限拒绝 | `!log`、`log.ok!==true`、`lineCount===0`、`keywords` 缺计数 → unknown；`hasBinary` → unknown | A3（二进制）、A5（空日志）实测 unknown ✅ |
| deps | 任一检查项探不出结论且无 fail/warn / 定位不到窝 | 每项独立 `unknown`；`unknownCount>=1` 的 band 在 `ready` 之前 | 矩阵场景 6（只探到 2 项）实测 unknown ✅ |
| drift | 四个版本字段一个都没有 / 权限拒绝 / 改名表核对不了 | 无 schemaVersion → unknown；`probeConfigPresence` 失败 → `renames_unchecked` unknown（不是 aligned） | A1/A5 实测 unknown ✅ |

**没有发现「悄悄降级成正常」的分支。** 唯一的「静默」问题不在 unknown 分支里，而在 §3 的 H1：**数据是完整的那个子集里恰好没有坏事，于是判了 clean** —— 档位本身算得出来，但结论被当成整个 24 小时的结论。

---

## 3. 构造反例实测（真实命令 + 真实输出）

所有夹具都在 `/tmp`，不写仓库、不改用户配置。命令都在仓库根执行。

### A1｜目录存在，但三个产物全部读不到（权限 000）

```
$ rm -rf /tmp/audit-a1
mkdir -p /tmp/audit-a1/logs
$ printf 'config ok\n' > /tmp/audit-a1/config.json
$ printf '2026-11-07 10:00:00 poll ok\n' > /tmp/audit-a1/logs/app.log
$ printf '[{"bvid":"BV1","processedAt":"2026-11-07T10:00:00Z"}]\n' > /tmp/audit-a1/dedupe.json
$ chmod 000 /tmp/audit-a1/config.json /tmp/audit-a1/logs/app.log /tmp/audit-a1/dedupe.json
$ node src/cli.mjs --root /tmp/audit-a1 --text
🐟 pond-check · 2026-11-07 21:04 · linux/node 22.23.4
✅ audit-a1  活跃 刚刚  缺 日志
→ 最该做：audit-a1：日志按天切割、别清 session
※ 5 项数据读不到（节律、工作量、健康、漂移、依赖），不能当正常。
共 1 条，活跃 1 / 疲软 0 / 死了 0 / 认不出 0。
```

`--json` 里的关键事实：

```
summary: {"fish": 1, "ok": 1, "watch": 0, "bad": 0, "unknown": 5}
trace: unreadable | bucket: ok | severity: unknown
liveness active ok | missing= [] | reason= None
rhythm unknown | missing= ['timestamps'] | reason= eacces
throughput unknown | missing= ['dedupe'] | reason= permission_denied
health unknown | missing= ['log'] | reason= eacces
deps unknown | missing= ['credentialFreshness','modelLine']
drift unknown | missing= ['schemaVersion'] | reason= permission_denied
```

**评价**：
- liveness 确实有真实痕迹（文件 mtime 刚被写），判 active 站得住；
- 五格 unknown 也都如实写了 `missing` + `reason`，脚注也出来了 —— **没有被静默**；
- 但**鱼级分桶是 `ok`（✅ 活跃），统计行写「活跃 1 / 认不出 0」**。一条 5/6 格读不到的鱼在总览里占的是「活跃」这一格 —— 见 H4。

### A2｜目录存在但是空的

```
$ node src/cli.mjs --root /tmp/audit-a2 --text
❓ audit-a2  认不出  缺 日志
→ 最该做：audit-a2：查路径/权限/日志在不在
※ 6 项数据读不到（存活、节律、工作量、健康、漂移、依赖），不能当正常。
※ 认不出 = 存活与工作量两格都判不出（不是没这条鱼）。
共 1 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 1。
```

HTML 四灯：`0 活跃 / 0 疲软 / 0 死了 / 1 认不出`。**「认不出」独立成桶，没有被算进正常。** ✅

### A3｜二进制日志（含 NUL）

```
$ node src/cli.mjs --root /tmp/audit-a3 --text
✅ audit-a3  活跃 刚刚  缺 日志
※ 5 项数据读不到（节律、工作量、健康、漂移、依赖），不能当正常。
```
```
health: unknown unknown | 读不到日志，健康状况未知（不是健康）。
evidence: {"hardHits": null, "hasBinary": true, "bytesRead": 3229}
```

**D6a 的 B1 缺陷（二进制日志曾被判 clean）已修复并复验** ✅。同 A1：分桶仍落「活跃」（H4）。

### A4｜**H1 反例**：24 小时内的 412 被挤出 256 KiB 尾部窗口

造法：日志 1,012,210 字节；最前面 3 行是 2 小时前的真实 `412 Precondition Failed`，后面 22,000 行正常轮询把它挤出 256 KiB 尾部窗口。

```
$ node src/cli.mjs --root /tmp/audit-a4 --text
🐟 pond-check · 2026-11-07 21:04 · linux/node 22.23.4
✅ audit-a4  活跃 刚刚  今天 50 条  缺 登录态
→ 最该做：audit-a4：日志按天切割、别清 session
※ 2 项数据读不到（节律、依赖），不能当正常。
共 1 条，活跃 1 / 疲软 0 / 死了 0 / 认不出 0。
```

```
health: clean ok
phenomenon: 最近 24 小时日志里没看到报错。
nextStep: 不用动。
evidence: {"hardHits": 0, "softHits": 0, "bytesRead": 262144, "truncated": true,
           "windowApproximated": false, "windowStale": false, "lineCount": 5699}
```

**尾部窗口实际覆盖的时长**（读同一份日志算出来的）：

```
窗口起点行: 2026-11-07T12:36:24.196Z poll ok 正常轮询
覆盖时长: 28 分钟 / 24h = 2.0%
首行是半行截断（D3a 会丢弃）: true
被挤到窗口外的 412：
  2026-11-07T11:04:53.596Z GET /x/web-interface 412 Precondition Failed
  2026-11-07T11:04:54.596Z GET /x/web-interface 412 Precondition Failed
  2026-11-07T11:04:55.596Z GET /x/web-interface 412 Precondition Failed
```

HTML 里同样只有一枚绿色的 `健康 干净 0 次`：

```
<div class="chip chip-ok">
  <span class="chip-name">健康</span>
  <span class="chip-level">干净</span>
  <span class="chip-value">0 次</span>
</div>
```
（`renderHtml` 产物中 `truncated` / `只扫` / `尾部` 三个词一次都没出现）

**这是本次审查最严重的一条**：结论的措辞是「最近 24 小时」，实际只看了 28 分钟（2%），中间的 3 次 412 完全没进视野，且三层渲染都没有任何提示。触发条件很普通：**24 小时内写超过 256 KiB 的日志**（约 2600 行 / 每 33 秒一行）就会命中。

### A5｜空日志（0 字节）

```
❓ audit-a5  认不出  缺 日志
※ 6 项数据读不到（存活、节律、工作量、健康、漂移、依赖），不能当正常。
共 1 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 1。
```
liveness 也是 unknown —— 空文件的 mtime 不算活动（`log_empty_no_content` 留痕）。D6a 的 B2 已修复并复验 ✅。

### A6｜十天内没写过的日志

```
🔴 audit-a6  死了  节律 全停
※ 3 项数据读不到（工作量、漂移、依赖），不能当正常。
```
```
health: clean ok
phenomenon: 最近 24 小时日志里没看到报错。（注意：日志最后一条是 10 天前写的，
            最近 24 小时她根本没写日志 —— 上面的结论只反映更早的那段日志，不等于「最近没出事」。）
nextStep: 不用动。先看「存活」那栏确认她还在跑；等她重新写日志、日志有了新内容，再体检一次健康。
```

「窗口过期」有注脚（`windowStale: true`）✅，但 `nextStep` 拼接后自相矛盾（先「不用动」再「先看存活」）—— 见 M1。

### A7｜**H2 反例**：配置里没有模型字段

```
$ cat /tmp/audit-a7/config.json
{"schemaVersion":3}
$ node src/cli.mjs --root /tmp/audit-a7 --text
🔴 audit-a7  活跃 刚刚  今天 1 条  模型线路 不可用
→ 最该做：audit-a7：照每条 fix 补，补完再体检
※ 1 项数据读不到（节律），不能当正常。
共 1 条，活跃 0 / 疲软 0 / 死了 1 / 认不出 0。
```
```
deps: broken bad | 有 1 项已经坏了：模型线路。她现在跑不起来或者跑起来也白跑。
   ffmpeg pass | nodeRuntime pass | credentialFreshness unknown
   homeWritable pass | modelLine fail | 模型线路没配 | diskSpace pass
```

这条鱼：日志在写（活跃）、判重表今天 +1（在干活）、健康干净、漂移对齐，**只因为 config.json 里没有 `model/provider/baseUrl/apiBase` 就被判「坏了」并显示「死了」**。而「不用模型」的 agent 完全合法（B 站轮询插件、桌面宠物、纯脚本 bot）。这是**推断型判定**：把「没找到字段」推成「没配 = 跑不起来」。

### A8｜**H2b 反例**：PATH 上没有 ffmpeg

```
$ env PATH= /usr/local/bin/node src/cli.mjs --root /tmp/audit-a8 --text
🔴 audit-a8  活跃 刚刚  今天 1 条  ffmpeg 不可用
※ 1 项数据读不到（节律），不能当正常。
共 1 条，活跃 0 / 疲软 0 / 死了 1 / 认不出 0。
```
```
deps: broken bad | bucket: bad
headline: 存活 活跃 · 节律 判不出 · 工作量 今天 1 条 · 健康 干净 · 依赖 坏了 · 漂移 对齐
   ffmpeg fail | ffmpeg 没找到；版本 未知
```

同一行里同时出现「🔴」「活跃 刚刚」「死了 1」和 headline 的「存活 活跃」——**图标与文字互相打架**（H3），根因是「非视频鱼缺 ffmpeg」被当成坏（H2b，D4b 已上报队长）。

### 场景矩阵（10 个构造输入，看「已知格 / 未知格」与分桶的关系）

```
【1 empty】                        bucket=unknown  ok=0 unknown=6
【2 只有日志行、无时间戳】          bucket=ok       ok=2 unknown=4   live=active heal=clean
【3 只有判重表（今天 +5）】         bucket=ok       ok=2 unknown=4   live=active thro=productive
【4 日志只有 mtime 新（空内容）】    bucket=unknown  ok=0 unknown=6
【5 二进制日志 + 判重表在出货】      bucket=ok       ok=2 unknown=4
【6 deps 只探到 2 项】              bucket=ok       ok=2 unknown=4   deps=unknown ✅
【7 deps 完全没有探测结果】          bucket=ok       ok=2 unknown=4   deps=unknown ✅
【8 判重表有条目但无时间戳】        bucket=ok       ok=1 unknown=5   thro=unknown ✅
【9 十天内没写过的日志】            bucket=bad      ok=1 unknown=4   live=dead heal=clean
【10 日志被截断但尾部干净】         bucket=ok       ok=3 unknown=3   heal=clean ← H1
```

注意场景 **6/7/8** 是好消息：deps 只探到 2 项、判重表无时间戳，都没有被算成 `ready` / `quiet`。场景 **8** 与 A1 是同一类问题：**只有 1 格已知，分桶仍是 ok**（H4）。

---

## 4. 六指标逐个评估：数据不足时会不会误导

| 指标 | 数据不足的表现 | 会不会误导 | 判断 |
| --- | --- | --- | --- |
| **liveness** | 四源全空 → unknown；单源 mtime 就能判 active | **会**，但属于设计口径：`touch`/日志轮转/备份工具都会更新 mtime，看起来「刚动过」 | 可接受。SPEC 明确「只看真实写入痕迹」，mtime 就是痕迹；且 unknown 分支完备 |
| **rhythm** | 日志覆盖不足 7 天 → unknown（下界/上界不同档才判） | 不会。这是我 D4a 特意做的「盲区」逻辑，宁 unknown 不误报 bad/stopped | ✅ |
| **throughput** | 判重表没有时间戳 → unknown（绝不命中 quiet）；条目数封顶会写明「是下限」 | 不会 | ✅ |
| **health** | 日志被尾部截断 → **判 clean + 声称 24 小时** | **会，且是本次唯一的真·假健康** | ❌ H1 |
| **deps** | 六项里任一项 unknown → 整格 unknown（不判 ready） | 不会往「好」的方向错；但反过来会**误判坏**（H2/H2b）——「没找到 X 就判 fail」 | ⚠️ H2 / H2b |
| **drift** | 无版本字段 → unknown；改名表核对不了 → unknown（不写 aligned） | 不会 | ✅ |

补充两点检查：

- **`deps` 会不会「五项没查就算齐了」？** 不会。bands 的 `unknown` 档在 `ready` 之前，`unknownCount >= 1` 即 unknown。实测矩阵场景 6/7。
- **`health` 读到一半就 pass 的另一种形态**：`windowApproximated`（日志没有时间戳）时有「按最后 N 行估算」的注脚，`windowStale`（日志最后一条早于窗口）时也有注脚。唯独 **`truncated`（尾部字节不够覆盖窗口）没有任何注脚** —— 这正是 H1 与其他两种形态的不对称。

---

## 5. 「认不出」的鱼在总览里的统计位置

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 「认不出」是否独立计数、不并入正常 | ✅ 独立成桶 | A2：`共 1 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 1`；HTML 四灯 `0/0/0/1` |
| 是否会被算进 `summary.ok` | ✅ 不会，`summary` 数的是指标格 | A2：`summary {ok:0, unknown:6}` |
| 是否会被折叠成上一个状态 | ✅ 不会，`level:'unknown'` 显式保留 | `countIndicators` 对未声明 severity 也计 unknown |
| 是否解释了「认不出 ≠ 没这条鱼」 | ✅ 文本版有一行 `※ 认不出 = 存活与工作量两格都判不出（不是没这条鱼）。` | A2 输出 |
| **反向问题：未知格很多的鱼被算成「活跃」** | ❌ A1（5/6 未知）与矩阵场景 8（5/6 未知）都算 `活跃` | H4 |

---

## 6. 缺陷清单

### H1（高）健康栏在尾部截断时仍判「干净」，话术声称 24 小时

- **现象**：`log.truncated === true` 时，`health` 只统计最后 256 KiB 里的关键词，却用「最近 24 小时」的措辞判 `clean`。实测窗口只覆盖 28 分钟（2%），窗口内的 3 次 412 完全没算。
- **代码**：`src/evaluate/system.mjs:422`（`windowStale` 只看最后一条时间戳，不看 `truncated`）、`:521`（`truncated` 只写进 evidence，不参与判定）、`src/rules.json:798-799`（只声明 `windowHours/tailBytes`，没有「窗口不完整」的口径）。
- **影响**：这是「读到一半数据就默认 pass」的教科书案例，直接违反 SPEC §5「数据不足不默认正常」。任何日志量大（>256 KiB/天）的鱼都会命中。
- **修复建议（二选一，建议 A）**：
  - **A（正确）**：`src/read/log.mjs` 额外导出「缓冲区第一条可解析时间戳」`firstTimestamp`；`health` 计算 `(now - firstTimestamp) / 3600 < windowHours` 时 → `unknown`，`reason:'window_truncated'`，`missing:['log_window']`。同时给 `rules.json` 的 health 补一条 unknown 文案（「只扫到最近 X 分钟的日志，24 小时窗口不完整」）。
  - **B（最小改动能接受的底线）**：`truncated === true` 时沿用 `windowStale` 那套 caveat，把「这份干净只反映最后 256 KiB」写进 `phenomenon`，并在 HTML/文本里可见。**但档位仍是 clean，仍然是「假干净」的弱化版**，不推荐。
- **验收测试**：造一个 >256 KiB 的日志，把 3 条 412 放在尾部窗口之外、24 小时之内 → 断言 `health.level === 'unknown'`（A 方案）或至少 `evidence.windowTruncated === true`（B 方案）。

### H2（中高）`modelLine`「没找到模型字段 → fail」是推断型判定

- **现象**：配置能读、但里面没有 `model/provider/baseUrl/apiBase` → `modelLine: fail` → `deps` 的 `broken` → 整条鱼 🔴「死了」，话术「她现在跑不起来或者跑起来也白跑」。
- **代码**：`src/evaluate/system.mjs:802`（`status: configured ? 'pass' : 'fail'`）+ `src/rules.json:1164` 的 `modelLine` 检查项（rules 里写着 `fail: 全部缺失或为空`）。
- **为什么是问题**：不是每条鱼都用大模型（B 站轮询插件、桌面宠物、纯脚本 bot）。「没找到字段」只能证明「这份配置里没写」，不能证明「她需要模型且没配」。这与队长已裁定的 `credentialFreshness` 是同一类错误。
- **修复建议**：`fieldsPresent` 全 false 且配置里**一个模型相关键都没有** → `unknown`（「这份配置里没看到模型线路，可能她不用模型，也可能配在别处/环境变量里」）；只有「键在但值为空」才 `fail`。或给 `discovery.kinds` 加 `requiresModel`，不要求模型的 kind 直接跳过。
- **验收测试**：A7 夹具 → 断言 `deps.level === 'unknown'`（或至少不是 broken）。

### H2b（中）非视频鱼缺 ffmpeg → fail

- **现象**：`PATH` 里没有 ffmpeg → `ffmpeg: fail` → `deps broken` → 整条鱼 🔴「死了」（A8）。
- **代码**：`src/evaluate/system.mjs:714`（`ctx.ffmpegOptional ? 'warn' : 'fail'`），`ffmpegOptional` 目前在生产路径永远是 false（rules 里没有机器字段）。
- **判定**：D4b 已上报队长，这里只补一条**影响证据**：它不只是「依赖栏红一个」，而是把整条鱼推进「死了」桶、把「最该做」顶成「照每条 fix 补」。
- **建议**：给 `discovery.kinds` 加 `producesVideo`（dsh-whale-widget / desktop-pet / astrbot 多为 false），或默认把 ffmpeg 缺失降为 `warn`——它很少是「跑不起来」的直接原因。

### H3（中）分桶 `bad` 的展示词「死了」与 `bad` 的语义不符（同一页两个词）

- **现象**：`bad` 桶 = 任一格 `severity: bad`，包括 deps/health/drift。四灯/统计行/行首图标用的展示词却是「死了」。A8 同一行既有「🔴」又有「活跃 刚刚」，统计行写「死了 1」。
- **同一份 HTML 里两个词**（A7 产物实测）：

```
summary-line: 六格统计（按格数，不是按鱼）：4 正常 · 0 要注意 · 1 坏了 · 1 判不出
ov labels:    活跃 / 疲软 / 死了 / 认不出
```
  同一条鱼，上面写「1 坏了」，右上角灯写「死了」。
- **代码**：`src/render/text.mjs:36,76`、`src/render/html.mjs:42`（`{ severity: 'bad', label: '死了' }`）vs `src/render/html.mjs:305`（summary 行用「坏了」）。
- **建议**：统一成 SPEC §6.1 的措辞「坏了」；或把「死」只留给 `liveness === 'dead'` 的鱼，`bad` 另起「有问题」。
- **验收测试**：一条 `deps broken` 但 `liveness active` 的鱼 → 四灯与统计行都不得出现「死了」。

### H4（中）鱼级分桶 `ok` 门槛过低：1 格已知也算「活跃」

- **现象**：`classifyFishBucket` 的规则是「有 bad → bad；有 watch → watch；关键两格都 unknown → unknown；否则 ok」。于是 **5/6 格读不到、只有 liveness 判出** 的鱼也算 `ok` → ✅ 活跃，统计行「活跃 1 / 认不出 0」（A1、矩阵场景 8）。
- **代码**：`src/evaluate/index.mjs:482-493`。
- **为什么是假健康**：`summary`（六格）老实写着「1 正常 · 5 判不出」，但用户第一眼看的是 ✅ 和「活跃 1 / 认不出 0」。桶的语义是「这条鱼算活着」，颜色却是「一切正常」。
- **建议（择一）**：
  - 把 ok 的门槛从「关键格不全 unknown」抬到「**已知格 ≥ 2 且 liveness 已知**」——A1 会落进「认不出」，D6b 那条「四格有结论、两格判不出」的鱼仍然是活跃；
  - 或保留分桶，但在统计行/HTML 灯里加一句「其中 N 条有多格判不出」，让「活跃」不再等于「没事」。
- **验收测试**：A1 夹具 → 断言 `bucket !== 'ok'`（方案一）；或 `report.summary.unknown >= 5` 时统计行必须带限定语（方案二）。

### M1（低）`windowStale` 话术拼接后自相矛盾

- **现象**：`health.nextStep` = 「不用动。先看「存活」那栏确认她还在跑；等她重新写日志…」——前半句让人别动，后半句让人去看存活。
- **代码**：`src/evaluate/system.mjs:499`（把 caveat 直接拼在 rules 的 `nextStep` 后面）。
- **建议**：`windowStale` 时**替换**而非拼接 `nextStep`（rules 里加 `health.variants.windowStale.nextStepTemplate`）。

### M2（低，假报警方向的同类风险）关键词边界不排字母

- **现象**：造 A4 的第一版夹具时，我用了 `bvid BV412`，结果 `hardHits` 被算成 20 次「风控」——因为数字 `412` 前后是 `V` 和空格，被当作独立 token。
- **真实影响**：标准 BVID（`BV1` + 9 位 base58）命中概率极低，但 URL 查询参数（`?aid=412`）、自增 ID（`item412`）会中招。
- **建议**：数字关键词的边界把「字母」也排除（要求前后是空白/标点），或在匹配前先剥掉 URL 与 `BV[0-9A-Za-z]{10}` 形态的 token。属假报警，不是假健康，排序在最后。

---

## 7. 已验证「不是缺陷」的项（附证据）

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 六格默认值 | 全部 `unknown`，源码无 `|| 'ok'` 兜底 | §1 扫描 + 矩阵场景 1 |
| `unknown` 是否被算进 `summary.ok` | **不会**；未声明 severity 也计 unknown | A2：`summary{ok:0,unknown:6}`；`countIndicators` |
| `deps` 部分探测是否判 `ready` | **不会**，`unknownCount>=1` 先命中 unknown | 矩阵场景 6/7 |
| 判重表无时间戳是否判 `quiet` | **不会**，主指标 `todayNew` 为 null → unknown | 矩阵场景 8 |
| 空日志 / 二进制日志 | **unknown**（B1/B2 修复有效） | A3/A5 |
| 空目录 / 不存在的窝 | **认不出**，不并入正常 | A2；`--root /tmp/definitely-not-here` 实测 |
| 过滤没命中 | 说「过滤条件没匹配到」，不冒充「没鱼」 | `--fish zzz-nope` 实测 |
| degraded 三层渲染是否被忽略 | **都显示**：文本 `※ N 项数据读不到`、HTML `⚠ N 项数据读不到…`、JSON `degraded[]` + `degradedCount` | A1 三种输出 |
| `fixes` 是否会从 ok 格里冒「没事」 | 只收 `severity !== 'ok'` 的 nextStep，且去重封顶 | A1：3 条 fix 全部来自 unknown 格 |
| 话术里是否存在「unknown 却说没事」 | rules 里 unknown 档的 nextStep 全部是行动句（无「不用动」） | `grep rules.json` 扫描 |
| `summary` 的两个口径（鱼/格）是否会混 | 分开写：`N 条鱼 · 六格口径：…`，HTML 另行注明「按格数，不是按鱼」 | A1/A2 输出 |

---

## 8. 审查期间的全仓测试状态（首轮红 → 已修复）

**首轮审查（`3ff97e0`）时全仓测试是红的**：

```
$ node --test
# tests 114
# pass 113
# fail 1
```
唯一失败：`tests/docs-consistency.test.mjs`「文档里出现的每一个 --xxx，CLI 都必须真支持」。报错列表里 3 条是假阳性、2 条是真违规：

```
docs/SPEC.md 让你敲 --json，但 CLI 不认它        ← 假阳性（CLI 认 --json）
docs/SPEC.md 让你敲 --text，但 CLI 不认它        ← 假阳性
docs/SPEC.md 让你敲 --no-exec，但 CLI 不认它      ← 真违规（SPEC 写了，CLI 没实现）
docs/SPEC.md 让你敲 --version，但 CLI 不认它      ← 真违规
docs/CAPABILITIES-SPEC.md 让你敲 --force，但 CLI 不认它  ← 别的项目的选项混进了我们的文档
```

假阳性的根因（已复现）：

```
$ node --input-type=module -e "import {parseCliArgs} from './src/cli.mjs'; console.log(JSON.stringify(parseCliArgs(['--json','whatever'])))"
{"ok":false,...,"errors":["不认识的参数：whatever（看用法：pond-check --help）"]}
```
测试用 `parseCliArgs([flag, 'whatever'])` 探测，`whatever` 这个尾随位置参数让**所有**无参开关都被判成「不认」，与 `--json/--text` 是否实现无关。

**现状（`f2ae08a` 之后）**：伪参数已清掉（`--no-exec` 改成「外部命令默认不执行」的说明、SPEC 里的 `--expect-schema` 换成「配置里加 schemaVersion」、CAPABILITIES-SPEC 的 `--force` 改成 `force: true`），一致性闸也重写成「无参开关只传自己、需要值的开关单独给值」，并扩到文档层。

```
$ node --test
# tests 114
# pass 114
# fail 0
```

> 记在这里的原因：这不是假健康问题，但它是「体检自己的门」曾经红着的事实。D8 收口引用本文时，请以 `f2ae08a` 之后的 114/114 为准。

## 9. 复现附录

以下命令都在仓库根 `/data/agent/workspace/大肥鱼/pond-check` 执行，全部只读（只写 `/tmp`）。

```bash
# A1 目录存在、三个产物全部读不到
rm -rf /tmp/audit-a1
mkdir -p /tmp/audit-a1/logs
printf 'config ok\n' > /tmp/audit-a1/config.json
printf '2026-11-07 10:00:00 poll ok\n' > /tmp/audit-a1/logs/app.log
printf '[{"bvid":"BV1","processedAt":"2026-11-07T10:00:00Z"}]\n' > /tmp/audit-a1/dedupe.json
chmod 000 /tmp/audit-a1/config.json /tmp/audit-a1/logs/app.log /tmp/audit-a1/dedupe.json
node src/cli.mjs --root /tmp/audit-a1 --text

# A2 空目录
rm -rf /tmp/audit-a2
mkdir -p /tmp/audit-a2
node src/cli.mjs --root /tmp/audit-a2 --text

# A3 二进制日志（含 NUL）
rm -rf /tmp/audit-a3
mkdir -p /tmp/audit-a3/logs
node -e '
const fs = require("fs");
const head = Buffer.from("2026-11-07 10:00:00 boot ok\n");
const junk = Buffer.from([0,1,2,3,255,254,0,7]);
fs.writeFileSync("/tmp/audit-a3/logs/app.log", Buffer.concat([head, Buffer.concat(Array(400).fill(junk))]));
'
node src/cli.mjs --root /tmp/audit-a3 --text

# A4 24 小时内的 412 被挤出 256 KiB 尾部窗口（H1 反例）
rm -rf /tmp/audit-a4
mkdir -p /tmp/audit-a4/logs
node -e '
const fs = require("fs");
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const lines = [];
for (let i = 0; i < 3; i += 1) lines.push(iso(now - 2*3600*1000 + i*1000) + " GET /x/web-interface 412 Precondition Failed");
for (let i = 0; i < 22000; i += 1) lines.push(iso(now - 2*3600*1000 + 600000 + i*300) + " poll ok 正常轮询");
fs.writeFileSync("/tmp/audit-a4/logs/app.log", lines.join("\n") + "\n");
const entries = []; for (let i = 0; i < 50; i += 1) entries.push({ bvid: "x"+i, processedAt: new Date(now - i*1000).toISOString() });
fs.writeFileSync("/tmp/audit-a4/dedupe.json", JSON.stringify(entries));
fs.writeFileSync("/tmp/audit-a4/config.json", JSON.stringify({ schemaVersion: 3, model: "m", provider: "p" }));
'
node src/cli.mjs --root /tmp/audit-a4 --text
node src/cli.mjs --root /tmp/audit-a4 --json | python3 -c 'import json,sys; h=json.load(sys.stdin)["fishes"][0]["indicators"]["health"]; print(h["level"], h["phenomenon"], {k:h["evidence"].get(k) for k in ("bytesRead","truncated")})'

# A5 空日志（0 字节）
rm -rf /tmp/audit-a5
mkdir -p /tmp/audit-a5/logs
: > /tmp/audit-a5/logs/app.log
node src/cli.mjs --root /tmp/audit-a5 --text

# A6 十天内没写过的干净日志
rm -rf /tmp/audit-a6
mkdir -p /tmp/audit-a6/logs
printf '2026-10-28 10:00:00 poll ok\n2026-10-28 10:05:00 poll ok\n' > /tmp/audit-a6/logs/app.log
touch -d '10 days ago' /tmp/audit-a6/logs/app.log
node src/cli.mjs --root /tmp/audit-a6 --text

# A7 配置能读、但没有模型字段（H2 反例）
rm -rf /tmp/audit-a7
mkdir -p /tmp/audit-a7/logs
printf '{"schemaVersion":3}\n' > /tmp/audit-a7/config.json
printf '2026-11-07 20:00:00 poll ok\n2026-11-07 20:30:00 poll ok\n' > /tmp/audit-a7/logs/app.log
printf '[{"bvid":"y1","processedAt":"%s"}]\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/audit-a7/dedupe.json
node src/cli.mjs --root /tmp/audit-a7 --text

# A8 PATH 上没有 ffmpeg（H2b / H3 反例）
rm -rf /tmp/audit-a8
mkdir -p /tmp/audit-a8/logs
printf '{"schemaVersion":3,"model":"m","provider":"p"}\n' > /tmp/audit-a8/config.json
printf '2026-11-07 20:00:00 poll ok\n2026-11-07 20:30:00 poll ok\n' > /tmp/audit-a8/logs/app.log
printf '[{"bvid":"y1","processedAt":"%s"}]\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/audit-a8/dedupe.json
env PATH= "$(command -v node)" src/cli.mjs --root /tmp/audit-a8 --text

# 场景矩阵（1 空 / 2 只有日志行 / 3 只有判重表 / … / 10 截断）
node /tmp/audit-matrix.mjs
```

> 审查期间未修改任何 `src/`、`tests/`、`rules.json`；本文件是本次审查唯一产出。
>
> **复验记录**：以上 8 组反例 + 场景矩阵在 `f2ae08a` 上原样重跑，输出与首轮逐字一致（除时间戳），退出码全 0。
