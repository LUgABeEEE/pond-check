# D6b · 首次使用体验走查（FIELD-NOTES）

> 走查人：release-owner（D6b）｜时间：2026-11-07 20:33–20:45（Asia/Shanghai）
> 环境：linux / Node 22.23.4 · 仓库基线 44965ff（D5 收口完成态）
> 视角：**第一次用 pond-check 的养鱼用户**。真机上扫到 2 条鱼（dsh-whale-widget × 2），六格全部判不出——这恰好是新用户最常见的眼前场景，所以本次走查重点全落在「判不出 / 认不出」这条链路上。
> 范围：只写本文件，`src/` 与 `tests/` 一个字没动。以下所有输出均为真跑逐字，宽度均用仓库自己的 `displayWidth`（src/render/text.mjs）实测。

## 0. 一句话总结

工具是**诚实**的：unknown 一律灰色问号、不冒充绿色，缺什么直接说（「缺 日志」），底部还钉着「只读、不联网、无遥测」——第一印象可信。但「**下一步**」的话术有三处会让新用户当场卡死：

1. 建议里让敲的参数 **不存在**（`--log`、`--expect-schema`），照着敲直接 exit 2（P1、P2）；
2. 照「最该做」做完（`--root` 指了窝）**结果一点没变，建议还一字不差地重复**，用户在原地绕圈（P4）；
3. 文本摘要「→ 最该做」一行 **128 显示列**，手机群/窄终端折成三行，`--root <她的目录>` 被拦腰折断，复制即错（P5、P17）。

另有 19 项中低优先级问题（英文 id 混进中文话术、鱼数和格数混在一句、HTML 时间是 UTC 等），全部见文末**问题清单总表**。

---

## 1. 真跑输出逐字

### 1.1 默认模式（写 HTML）

```
$ node src/cli.mjs --out /tmp/field-notes-default.html
/tmp/field-notes-default.html
[exit=0]   （产物 10760 字节）
```

stdout 只有文件路径一行，干净。✓

### 1.2 `--text`

```
$ node src/cli.mjs --text
🐟 pond-check · 2026-11-07 20:34 · linux/node 22.23.4
❓ dsh-whale-widget（…-1703）  判不出  缺 日志
❓ dsh-whale-widget（web）     判不出  缺 日志
→ 最该做：dsh-whale-widget（…-1703）：指明她的窝：pond-check --fish <名字> --root <她的目录>；或者告诉体检她的日志放在哪个位置。
※ 12 项数据读不到（liveness、rhythm、throughput、health、drift、deps），这些项目不能当作正常。
共 2 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 2。
[exit=0]
```

### 1.3 `--json`（节选，全文 29924 字节）

```json
{
  "summary": { "fish": 2, "ok": 0, "watch": 0, "bad": 0, "unknown": 12 },
  "verdict": "2 条鱼 · 0 正常 · 0 要注意 · 0 坏了 · 12 判不出。12 项判不出来 —— 这些不是正常，是没看到。",
  "nextAction": "DSH 插件 · dsh-whale-widget（web-021-rollback-20261105-1703）：指明她的窝：pond-check --fish <名字> --root <她的目录>；或者告诉体检她的日志放在哪个位置。",
  "footnote": "12 项数据读不到（liveness、rhythm、throughput、health、drift、deps），这些项目不能当作正常。",
  "degradedCount": 12,
  "skippedSensitive": { "count": 0, "names": "[凭证文件已跳过]" }
}
```

### 1.4 补充场景真跑（新用户会真实走到的四条路）

**① `--help`**（exit 0，写得很好：参数、退出码、只读承诺都全。✓）

**② 照话术敲 `--log` / `--expect-schema`** —— 因为「下一步」里就是这么教的：

```
$ node src/cli.mjs --text --log /var/log/foo.log
pond-check：不认识的参数：--log（看用法：pond-check --help）
pond-check：不认识的参数：/var/log/foo.log（看用法：pond-check --help）
[exit=2]

$ node src/cli.mjs --text --expect-schema 3
pond-check：不认识的参数：--expect-schema（看用法：pond-check --help）
[exit=2]
```

**③ 照「最该做」敲 `--root`（把她的窝原样指给体检）**：

```
$ node src/cli.mjs --text --root ~/.dsh/profiles/web/node_modules/dsh-whale-widget
🐟 pond-check · 2026-11-07 20:43 · linux/node 22.23.4
❓ dsh-whale-widget（web）  判不出  缺 日志
→ 最该做：dsh-whale-widget（web）：指明她的窝：pond-check --fish <名字> --root <她的目录>；或者告诉体检她的日志放在哪个位置。
※ 6 项数据读不到（liveness、rhythm、throughput、health、drift、deps），这些项目不能当作正常。
共 1 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 1。
[exit=0]
```

**做了建议的事，结论没变，建议还一字不差地再让你做一遍** —— 死循环。（P4）

**④ `--fish` 名字打错**：

```
$ node src/cli.mjs --text --fish no-such-fish
🐟 pond-check · 2026-11-07 20:44 · linux/node 22.23.4
→ 最该做：先跑 ps aux | grep -i <她的名字> 确认她还在跑；确认在跑，再用 --root <她的目录> 指定她的窝。
没扫到任何在跑的鱼。先确认她真的在跑（ps aux | grep -i <她的名字>），再用 --root <她的目录> 指定她的窝。
共 0 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 0。
[exit=0]
--- stderr ---
pond-check：没找到叫「no-such-fish」的鱼。本次扫到的是：dsh-plugin:web-021-rollback-20261105-1703/dsh-whale-widget、dsh-plugin:web/dsh-whale-widget
```

stderr 说得清楚（过滤没匹配到、并列出了真名），但 stdout 报告说「没扫到任何在跑的鱼。先确认她真的在跑」——**鱼明明在跑**，只是过滤词没对上，报告却让用户去查进程。（P7）

---

## 2. 文本摘要逐行宽度实测（>60 列清单 + 短版）

测量口径：仓库自己的 `displayWidth`（CJK/emoji = 2 列，组合符 = 0 列）。

| 行 | 实测宽度 | 内容摘要 | 短版（≤40 列） |
|---|---|---|---|
| 表头 | 53 列 | `🐟 pond-check · 2026-11-07 20:34 · linux/node 22.23.4` | 不用改 |
| 鱼行 ×2 | 46 列 | `❓ dsh-whale-widget（…-1703）  判不出  缺 日志` | 不用改 |
| **「→ 最该做」** | **128 列** | `→ 最该做：dsh-whale-widget（…-1703）：指明她的窝：pond-check --fish <名字> --root <她的目录>；或者告诉体检她的日志放在哪个位置。` | `→ 最该做：用 --root 指明她的窝`（30 列；要保鱼名则 58 列：`→ 最该做：dsh-whale-widget（…-1703）：用 --root 指明她的窝`） |
| **脚注** | **94 列** | `※ 12 项数据读不到（liveness、rhythm、throughput、health、drift、deps），这些项目不能当作正常。` | `※ 12 项读不到（六格全缺），不能当正常。`（39 列） |
| 统计 | 46 列 | `共 2 条，活跃 0 / 疲软 0 / 死了 0 / 认不出 2。` | 不用改 |

其它场景实测的超宽行：

| 场景 | 实测宽度 | 短版（≤40 列） |
|---|---|---|
| `--root` 之后脚注（6 项） | 93 列 | `※ 6 项读不到（六格全缺），不能当正常。`（38 列） |
| 0 鱼「→ 最该做」 | 102 列 | `→ 最该做：确认她在跑，再用 --root 指窝`（38 列） |
| 0 鱼 verdict（missingFishTemplate） | 104 列 | `没扫到鱼。确认她在跑，再用 --root 指窝。`（40 列） |

**结构性超宽**：鱼行本身也不保险——名字上限 26 列 + 备注上限 28 列（src/render/text.mjs:54–57），加上图标、时间、工作量两列，**最坏一行约 92 列**，本机碰巧全空才只有 46 列（P15）。

---

## 3. 结构性超宽：fix 文案需要短版（交 D6 收口）

「→ 最该做」一行的构成是：前缀「→ 最该做：」10 列 + 鱼名 ≤26 列 + 「：」2 列 + **fix 原文**。而 rules.json 里所有 `nextStep` / `fix` 的实测宽度是：

- 超过 60 列的有 **30+ 条**，最长 131 列（rhythm.drifting）、128 列（health.critical）、113 列（health.unknown）；
- 只要鱼出了非 ok 的格，这一行就必然超 60 列——本机 128 列不是特例，是常态。

**建议（P5 的落点）**：D6 收口在 rules.json 里给每条会进 `fixes[]` 的 `nextStep` / `fix` 加 `fixShort` 字段（≤40 字），text.mjs 的 `actionLine` 优先用 `fixShort`，HTML/JSON 继续用全文。候选短版（全部实测 ≤40 列）：

| 位置（src/rules.json） | 现文案（宽） | fixShort 候选（宽） |
|---|---|---|
| :476 liveness.unknown.nextStep | 指明她的窝：pond-check --fish …（90） | `用 --root 指明她的窝`（20） |
| :981 health.unknown.nextStep | 用 --log …永远是 unknown（113） | `用 --root 指定安装目录找日志`（28） |
| :1314 drift.unknown.nextStep | 在配置里加一行 schemaVersion…（77） | `配置里加一行 schemaVersion`（26） |
| :582 rhythm.drifting.nextStep | 先想一下是不是…（131） | `查 crontab / systemd 定时还在不在`（33） |
| :971 health.critical.nextStep | 现在就按这个修：{fixHint}…（128） | `换新 cookie、调大请求间隔后重启`（31） |
| :460 liveness.dormant.nextStep | 打开她的日志看最后一行…（88） | `看日志最后一行，重启后观察半天`（30） |
| :468 liveness.dead.nextStep | 先看进程还在不在…（96） | `进程不在就按启动命令拉起`（24） |
| :718 throughput.stalled.nextStep | 翻日志最后 20 行…（102） | `翻日志最后 20 行看登录是否失效`（30） |
| :727 throughput.empty.nextStep | 先查「依赖」那栏…（93） | `先补依赖，再手动触发一次`（24） |
| :1294 drift.drifted.nextStep | 先备份配置，再跑迁移…（106） | `先备份配置，再跑迁移命令`（24） |
| :1079 deps.ffmpeg.fix | apt install ffmpeg（…）…（101） | `apt install ffmpeg 后 ffmpeg -version`（37） |
| :1090 deps.node.fix | 用 nvm 切到 22 以上…（63） | `nvm install 22 && nvm use 22`（28） |
| :1102 deps.credential.fix | 登录态大概率过期了…（74） | `重新登录，把 cookie 存回原处再重启`（34） |
| :1115 deps.writable.fix | 目录权限不对…（89） | `chmod u+w <她的目录>`（20） |
| :1131 deps.modelLine.fix | 在配置里填上模型线路…（83） | `配置里补 provider / apiBase / model`（35） |
| :1142 deps.disk.fix | 清空间：先清 logs/…（62） | `清 logs/ 旧日志和 tmp/ 缓存`（27） |
| :846 health 登录失效.fix | 重新登录一次…（62） | `重新登录存回 cookie 再重启`（≈22） |
| :862 health 风控拦截.fix | B 站一类的 412…（96） | `换新 cookie、调大请求间隔再试`（≈28） |

rollup 模板同理（P6、P7 的短版见上表）。

---

## 4. 贴进 40 字符宽窗口会怎样？（实测折行）

按 40 显示列硬折，真机 `--text` 输出折完是这样（`|` 行首、`+` 折行续行）：

```
||🐟 pond-check · 2026-11-07 20:34 · linux
+|/node 22.23.4
||❓ dsh-whale-widget（…-1703）  判不出
+|缺 日志
||❓ dsh-whale-widget（web）     判不出
+|缺 日志
||→ 最该做：dsh-whale-widget（…-1703）：指
+|明她的窝：pond-check --fish <名字> --roo
+|t <她的目录>；或者告诉体检她的日志放在哪
+|个位置。
||※ 12 项数据读不到（liveness、rhythm、thr
+|oughput、health、drift、deps），这些项目
+|不能当作正常。
||共 2 条，活跃 0 / 疲软 0 / 死了 0 / 认不
+|出 2。
```

结论（P17）：

- **会错行**：鱼行的「判不出」和「缺 日志」被折到两行，四列小表格在 40 列下完全散架（这不算 bug，表格本来就按 60+ 列设计，但「最该做」是给人执行的，不该折）；
- **命令被折断**：`--root` 被劈成 `--roo` / `t <她的目录>`，照抄就错——这是最伤的一处；
- **emoji 对齐没崩**：🐟/❓/⚠️/✅ 都按 2 列算且渲染也是 2 列，行首对齐成立；
- **一个隐患（P16）**：`…`（U+2026）、`·`（U+00B7）、`→`（U+2192）是东亚**歧义宽度**字符，`displayWidth` 按 1 列算，而中文 locale 的终端经常按 2 列渲染——名字里带 `…` 的鱼行在那种终端下会比别人右移 1 列，表格整体错位。要么把这三个字符计 2 列，要么在 README 里写明「对齐按窄体歧义字符计算」。

---

## 5. 逐句读诊断话术

**九成是人话，而且是难得的「说人话」**：「不用管，继续养。」「现在还能跑，但迟早绊到。」「这些不是正常，是没看到。」——每条都回答了「所以我现在该做什么」，「她/窝」的养鱼隐喻前后一致。问题**全部集中在 unknown 分支**（恰恰是新用户第一眼看到的那些句子）：

| 句子（逐字） | 评审 |
|---|---|
| 「读不到她任何活动记录，判不出死活（不是正常）。」 | ✓ 好：照实说 + 括号里堵住「没消息=没事」的误读 |
| 「指明她的窝：pond-check --fish <名字> --root <她的目录>；或者告诉体检她的日志放在哪个位置。」 | ✗ 三连坑：①「告诉体检她的日志放在哪个位置」**没有任何机制**（P3）；② `<她的目录>` 是占位符，文本摘要里根本没印她的真路径（P22）；③ 照做后这句话原样重复（P4） |
| 「用 --log <她的日志文件> 指定日志位置，或 --root <她的安装目录> 让她自己找；找不到日志的鱼，健康分永远是 unknown。」 | ✗ `--log` 不存在（P1）；「永远是 unknown」英文档位词混进中文（P10） |
| 「在配置里加一行 schemaVersion，或者用 --expect-schema 3 告诉体检你期望的版本。」 | ✗ `--expect-schema` 不存在（P2）；前半句是好的 |
| 「翻日志最后 20 行：最常见就两种 —— 登录失效（412/验证码）或源站根本没更新。前者按「健康」那栏重新登录。」 | ✗ 只讲了「前者」，「源站没更新」没说该怎么办（P20）→ 建议改成「……。登录失效就按「健康」那栏重新登录；源站没更新就不用管，等她下次有货。」 |
| 「近 7 天只醒了 {activeDays} 天，基本是在偶尔挣扎一下。」 | ✗ 「基本是在偶尔挣扎」语病、像机翻（P21）→「近 7 天只醒了 {activeDays} 天，只是偶尔挣扎一下。」 |
| 「改名表还没核对过，看不出有没有残留旧字段」「判重表找到了，但里面没有时间戳，算不出今天新增了多少」 | ✗ 句末缺句号（P13），其余意思清楚 |
| 「现在就按这个修：{fixHint} 修完重启她，然后盯 10 分钟日志……」 | △ 填完 fixHint 会出现「再试。 修完重启她」——句号后多个空格（P14），小瑕疵 |
| 「如果这鱼本来就不落账，那工作量只能长期是 unknown，报告会照实写。」 | △ 英文 unknown（P10）；「报告会照实写」这半句是好的——提前安抚了「一直 unknown 是不是坏了」的疑问 |
| 其余 active / slack / dormant / dead / steady / sparse / stopped / clean / noisy / sick / ready / warn / broken / aligned / drifted / mismatch 及 7 条 health 类别 fix、6 条 deps fix | ✓ 全部有具体下一步（命令、路径、动作三选一），无一句是「请注意检查相关配置」这种空话 |

---

## 6. HTML 源码评审（结构 / 状态灯）

真机产物 10760 字节，单文件零外链（无 script/link/img/@import，`://` 被拆成实体），源码结构从上到下：`h1 + meta → 四灯总览 → verdict → 现在该做 → 六格统计（按格数，不是按鱼）→ 鱼卡×N → 脚注 → sticky 声明`。**结构合理**，两个口径（数鱼 vs 数格）还专门标了「按格数，不是按鱼」，好评。

状态灯（src/render/html.mjs:135–139）：16px 圆点 + 辉光，绿 #3fb950 / 黄 #d29922 / 红 #f85149 / **灰 #8b949e 带问号**——unknown 绝不用绿色，SPEC §5.1 落实到位，一眼可辨。✓

小问题：

- **P11**：`<p class="meta">生成时间 2026-11-07T12:34:20.232Z …`——UTC 带 Z，而同一份报告的文本模式写的是本地时间 20:34。新用户会以为报告是 8 小时前的旧报告。建议 HTML 也用本地时间（title 属性里可留 ISO）。
- **P12**：六格 chip 的数值带英文单位：`<span class="chip-value">0 checks</span>`（还有 sec/days/count/hits/version，见 rules.json:357/500/617/754/1001/1192）。建议加中文单位映射（0 项 / 3 秒 / 5 天…）。
- **P18**：ok/watch/bad 的灯是纯色圆点，只靠颜色区分，色弱用户分不出绿红。建议灯里加符号（✓ / ! / ×，unknown 已有 ?）。

---

## 7. 「认不出」的表达：用户知道该做什么吗？

**一半知道**。好的一面：行里直接印「缺 日志」（缺什么说什么，比「状态未知」有用十倍）；「※ …这些项目不能当作正常」明确堵住「没消息=没事」；灰色问号贯穿文本和 HTML。

不知道的一面（都是 P 项的回声）：

1. 「→ 最该做」让她 `--root <她的目录>`，但**文本摘要里从头到尾没印她的窝路径**（HTML 有「窝：~/.dsh/…」，文本没有）——新用户不知道 `<她的目录>` 该敲什么（P22）；
2. 照做之后**没有「你做对了，但这条鱼确实不写日志」这类出口**，同一句话再喊一遍（P4）；
3. 「认不出」（四灯，数鱼）和「判不出」（六格）两个词并用，靠「共 2 条，… 认不出 2。」勉强能对上，但没人解释这俩是不是一回事（P19）。

---

## 8. 问题清单总表

严重度：高 = 新用户当场卡死/照抄就错；中 = 误导或显著影响窄屏使用；低 = 观感/一致性。

| # | 问题 | 文件:行 | 严重度 | 建议怎么改（具体到这句话） |
|---|---|---|---|---|
| P1 | 话术教用户敲 `--log`，CLI 根本没这个参数（实测 exit 2「不认识的参数」） | src/rules.json:981 | 高 | 这句改成：「用 --root <她的安装目录> 指定她的窝让她自己找日志；找不到日志的鱼，健康永远判不出。」若 D6 要加 `--log` 参数，则须同时进 `--help` 与 parseCliArgs |
| P2 | 话术教用户敲 `--expect-schema 3`，参数不存在（实测 exit 2） | src/rules.json:1314 | 高 | 这句改成：「在配置里加一行 schemaVersion（版本号看她的程序文档）。」删掉 `--expect-schema` |
| P3 | 「或者告诉体检她的日志放在哪个位置」——不存在任何「告诉体检」的机制 | src/rules.json:476 | 高 | 这句改成：「指明她的窝：pond-check --root <她的目录>。」（若要留第二句，先实现 `--log`） |
| P4 | 照「最该做」做完（`--root`）结果不变，建议一字不差重复，用户绕圈 | src/rules.json:476（话术）× src/render/text.mjs:472（组装） | 高 | 话术按状态分两版：没指过窝 → 现文案；**指过窝仍缺** →「已经指过窝还是找不到日志——这条鱼可能本来不写日志；确认她真有日志文件后，用 --json 看缺哪几项。」 |
| P5 | 「→ 最该做」128 列（任务给 127，本次实测 128，差 1 在箭头宽度口径），窄屏折三行 | src/render/text.mjs:472 + src/rules.json:476 | 高 | rules.json 为每条进 fixes[] 的 nextStep/fix 加 `fixShort`（≤40 字，见 §3 表）；actionLine 优先拼 fixShort。本行短版：「→ 最该做：用 --root 指明她的窝」（30 列） |
| P6 | 脚注 94 列，且括号里是英文指标 id（liveness、rhythm…），不像人话；JSON notes 同病 | src/evaluate/index.mjs:763 + src/rules.json:59 | 中 | {indicators} 改填六格中文名（存活、节律、工作量、健康、依赖、漂移）；模板改「{count} 项数据读不到（{indicators}），不能当正常。」短版：「※ 12 项读不到（六格全缺），不能当正常。」（39 列） |
| P7 | `--fish` 过滤没匹配到时，报告仍说「没扫到任何在跑的鱼。先确认她真的在跑」——鱼在跑，误导 | src/rules.json:58 + src/evaluate/index.mjs:726–731 | 中 | 过滤未命中单独成句：「过滤条件「no-such-fish」没匹配到鱼（本次扫到 2 条：…）。」别用 missingFishTemplate；0 鱼模板短版：「没扫到鱼。确认她在跑，再用 --root 指窝。」（40 列） |
| P8 | 0 鱼时「→ 最该做」与 verdict 两句内容几乎重复（ps aux… --root…），白占两行 | src/evaluate/index.mjs:734–738 + src/render/text.mjs:475 | 低 | 0 鱼时 text 模式只留 verdict 一句；或 nextAction 短版「→ 最该做：确认她在跑，再用 --root 指窝」（38 列） |
| P9 | verdict「2 条鱼 · … · 12 判不出。12 项判不出来 —— …」把鱼数和格数混在一句，且后半句重复「判不出/判不出来」 | src/evaluate/index.mjs:722–725 + src/rules.json:57 | 中 | verdict 补口径：「2 条鱼 · 六格口径：0 正常 · 0 要注意 · 0 坏了 · 12 判不出。」；unknownNoteTemplate 改「这些项不是正常，是没看到。」（去掉重复的项数） |
| P10 | 中文话术里夹英文档位词：「健康分永远是 unknown」「工作量只能长期是 unknown」 | src/rules.json:981、733 | 中 | unknown → 「判不出」（与 BAND_LABELS 同词） |
| P11 | HTML 生成时间是 UTC（12:34Z），文本模式是本地 20:34，同份报告差 8 小时 | src/render/html.mjs:499、519 | 中 | HTML 改本地时间「2026-11-07 20:34」，title 属性可保留 ISO 原值 |
| P12 | HTML 六格 chip 数值带英文单位「0 checks」（还有 sec/days/count/hits/version） | src/rules.json:357/500/617/754/1001/1192 + src/render/html.mjs:126 | 低 | 加中文单位映射：0 项 / 秒 / 天 / 条 / 次 / 号；或 rules.json 每格补 unitZh |
| P13 | 两处 phenomenon 句末缺句号 | src/rules.json:745、1319 | 低 | 补「。」：「……算不出今天新增了多少。」「……看不出有没有残留旧字段。」 |
| P14 | {fixHint} 填进模板后出现「再试。 修完重启她」——句号后多余空格 | src/rules.json:971（同型 :1166「{fixHint} 补完」） | 低 | 模板把「{fixHint} 修完」「{fixHint} 补完」改成「{fixHint}修完」「{fixHint}补完」，或填参时把 fixHint 尾部「。 」收紧 |
| P15 | 名字 26 + 备注 28 列上限叠加，鱼行最坏约 92 列，超 60 预算 | src/render/text.mjs:54–57 | 中 | 名字/备注上限降到 20/22 列（最坏行 ≈ 60），或备注超 24 列截断 |
| P16 | `…`、`·`、`→` 按 1 列算，中文终端按 2 列渲染时表格整体错位 | src/render/text.mjs:87–110（charWidth） | 低 | 东亚歧义宽度字符改按 2 列算（或提供 --text --ascii 用 ASCII 箭头/省略号） |
| P17 | 40 列窗口下「最该做」的命令被折断（`--roo`/`t`），照抄即错 | src/render/text.mjs:472 组装方式 | 中 | 命令独占一行：「→ 最该做：<短句>」换行缩进 4 列放完整命令（配合 P5 的 fixShort） |
| P18 | 状态灯 ok/watch/bad 只靠颜色区分，色弱用户分不出 | src/render/html.mjs:135–139 | 低 | 灯内加符号：✓ / ! / ×（unknown 已是 ?） |
| P19 | 「认不出」（四灯，数鱼）与「判不出」（六格）两个词并用，没解释 | src/render/text.mjs:478–483（statLine） | 低 | 统计行尾加半句：「（认不出 = 整条鱼判不出）」，或四灯词统一用「判不出」 |
| P20 | throughput.stalled.nextStep 只讲了「前者（登录失效）」怎么办，「源站没更新」悬空 | src/rules.json:718 | 中 | 改成：「……。登录失效就按「健康」那栏重新登录；源站没更新就不用管，等她下次有货。」 |
| P21 | 「基本是在偶尔挣扎一下」语病、像机翻 | src/rules.json:589 | 低 | 改成：「近 7 天只醒了 {activeDays} 天，只是偶尔挣扎一下。」 |
| P22 | `<她的目录>` 是占位符，文本摘要不印窝路径，用户不知道该敲什么 | src/rules.json:476 等 + src/render/text.mjs（行内容） | 中 | 文本行或「最该做」里把 `<她的目录>` 替换成已脱敏的 stateRoot（HTML 已有「窝：…」，文本对齐即可）；短版配合 P5 |

## 9. 亮点（保持，别改）

- unknown 一律灰色 + 问号 + 「（不是正常）」「不能当作正常」三重防呆，假健康零容忍贯彻到了话术层；
- 「缺 日志」这种**说缺什么**的备注，比任何「状态未知」都好；
- `--help` 一次讲清参数、退出码、只读承诺；stdout/stderr 分流干净，`--json` 可直接回读；
- 鱼行对齐、同名不同 profile 可区分（`（…-1703）` vs `（web）`）、名字里的换行/ANSI 都洗过；
- HTML 零外链、深色、四灯 + 六格 chip + sticky 免责声明，转发给别人打开也安全；
- 0 鱼、乱参数、坏数据都不崩，兜底话术照实说「不是没鱼，是没拿到报告」。
