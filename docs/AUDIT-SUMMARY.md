# D8 审查收口：结论与遗留项（AUDIT-SUMMARY）

- **基线**：`caa7832`（fix(D8)：关闭重判剩余的 4 条 high）——本文件为**终判轮（attempt 3）**版本
- **输入**：三份审查报告 —— [AUDIT-BOUNDARY](AUDIT-BOUNDARY.md)（c7248e1）、[AUDIT-HEALTH](AUDIT-HEALTH.md)（9732029）、[AUDIT-TESTS](AUDIT-TESTS.md)（9c5c92b）
- **收口动作**：三份报告 findings 去重 → 回 HEAD 亲自复核 → 定级 → verdict；此后每一轮修复，我都**重跑原来那份反例**再判一次，不读提交说明
- **验收门**：`npm test` **125/125 exit 0**；三份审查报告 + 本汇总均存在

---

## 0. Verdict：**pass**

| 级别 | 数量 | 说明 |
|---|---|---|
| blocker | **0** | 唯一的 blocker（假健康：日志截断仍判 clean）已在 `b110106` 修好并由我复核 |
| high | **0** | 5 条已全部关闭（H1 / H2 / H3 / H4 / H5），见 §1 |
| medium | 6 | 不阻塞发布，建议 v0.1.1 内清（见 §2.1） |
| low | 8 | 口径可收紧 / 测试债务（见 §2.2） |
| 三轮共关闭 | 14 | 含 1 blocker、5 high、6 medium、2 low |

**判定依据**：任务口径「有任何未关闭的 blocker → needs_revision；只有 medium/low → 可以 pass，并列出遗留项」。现在 **blocker 与 high 均为 0**，剩余全是 medium/low —— 满足 pass 条件。

**为什么这次可以放行（不是妥协）**：

1. **唯一 blocker 真修好了**：不是把阈值调大，而是把「窗口到底覆盖了多久」变成一等证据（`coveredHours`）并写进人话：「日志太大了，这次只看了最后一段（覆盖 0.9 小时，不到 24 小时），所以「没看到报错」不等于「真的没报错」。」
2. **5 条 high 全部有回归守着**：每条我都用原来那个反例重跑过（§1），不是只跑测试套件。
3. **红线从「零守卫」变成「有守卫且能杀变异」**：`tests/source-guards.test.mjs` 现在 9 条，其中颜色层那条我亲手验证过「改绿立刻红」（`not ok 124`）。
4. **剩余 6 medium / 8 low 都不影响「这页报告是否可信」**：它们是覆盖保护、用词统一、边界用例、文档措辞这类问题，见 §2。

---

## 1. 终判轮复核证据（全部我自己跑，命令可复现）

### 1.1 D8-H1（配置里没有模型字段）→ ✅ 关闭

```
$ node src/cli.mjs --root /tmp/d8a3-h1 --json      # 夹具 config.json = {"schemaVersion":3}
deps: unknown unknown
checks: ffmpeg:pass, nodeRuntime:pass, credentialFreshness:unknown, homeWritable:pass, modelLine:unknown, diskSpace:pass
bucket: ok | headline: 存活 活跃 · 节律 判不出 · 工作量 判不出 · 健康 干净 · 依赖 判不出 · 漂移 对齐
```

修前：`modelLine: fail → deps broken/bad → bucket bad`（整条鱼「死了」）。修后：`unknown`，不再冤判。

### 1.2 D8-M3（PATH 里没有 ffmpeg）→ ✅ 关闭

```
$ PATH=/nonexistent node src/cli.mjs --root /tmp/d8a3-m3 --json
deps: warn watch | ffmpeg: "warn"
bucket: watch
```

修前：`ffmpeg: fail → deps broken → bucket bad`。修后：能力缺失降为 `warn`，整鱼「疲软」而不是「死了」。

### 1.3 D8-H4（unknown 灯的颜色守卫）→ ✅ 关闭（这次是真闭环）

上一轮我判定「假闭环」：守卫查 class 名不查颜色，改绿仍 121/121 全绿。`caa7832` 补了颜色层守卫，我用**同一把刀**再试一次：

```
$ cp -a . /tmp/d8a3-mut && sed -i 's/--unknown: #8b949e;/--unknown: #3fb950;/' /tmp/d8a3-mut/src/render/html.mjs
$ cd /tmp/d8a3-mut && node --test
not ok 124 - 红线·unknown 灯色不许偏绿（颜色层，不是 class 名）
# tests 125
# pass 124
# fail 1
```

不改变异时基线 **125 / 125 pass / 0 fail**。→ 变异能杀，守卫有效。

### 1.4 D8-H3（SPEC 承诺的进程表）→ ✅ 关闭

`docs/SPEC.md` 四处对齐实现：

- §3.2 P1：`**v0.1.0 未实现**（见 §8 局限）：现返回空数组，不假装探到了`
- §3.2「黑盒鱼」：`**v0.1.0 暂不支持**：进程表未实现`
- §3.5 平台表：Linux →「支持六指标；**进程表未实现**」；macOS →「未在 v0.1.0 验证」
- §8 已知局限：第 7/8/9/10 条新增「进程表未实现」「macOS 未验证」「不读凭证内容」「不做精确账单」

### 1.5 顺手回归

```
$ node src/cli.mjs --text          # 真机
❓ widget（…105-1703）  判不出  缺 日志
❓ hale-widget（…web）  判不出  缺 日志      ← H5 的修复仍然有效，两行可区分
```

---

## 2. 遗留项（不阻塞发布，按建议版本排序）

### 2.1 medium（6 条，建议 v0.1.1）

| id | problem | requiredFix | 来源 |
|---|---|---|---|
| D8-M2 | `--out` 静默覆盖已存在文件（实测把 `DO NOT TOUCH` 覆盖成 9 008 B HTML），递归建父目录、无 `--force`，符号链接顺链写 | 目标存在且非本工具产物时拒绝 + `--force`；`--help` 注明 | BOUNDARY M3 |
| D8-M4 | 分桶 `bad` 同页两个词：四灯/统计行「死了」、summary「坏了」；deps broken 但活跃的鱼同屏 🔴 + 「活跃 刚刚」 | 统一「坏了」，或「死」只留给 `liveness==='dead'`。回归：deps broken + liveness active 不得出现「死了」 | HEALTH H3 |
| D8-M5 | 分桶 `ok` 门槛过低：1/6 格已知仍 `bucket:ok`、`fishBuckets ok:1 unknown:0`，summary 却写 `unknown:5` | 抬到「已知格 ≥2 且 liveness 已知」；或统计行加「其中 N 条有多格判不出」 | HEALTH H4 |
| D8-M6 | Windows「明确报 unsupported」未实现（`grep win32 src/cli.mjs` = 0） | 8 行早退 + 注入 platform 的测试 | TESTS B1 |
| D8-M9 | `--root` / `--log` / `--dedupe` 指到不存在路径（warn + exit 0）无用例锁 | 补 3 条 CLI 用例：stderr 有话、exit 0、报告仍出 | TESTS B4 |
| D8-M10 | SPEC:39「不写用户目录」与默认往 cwd 写 `pond-check-<ts>.html` 措辞冲突 | SPEC 补一句：唯一写盘 = 报告文件；默认 cwd，可用 `--out`，绝不写进鱼的窝 | TESTS D5 |

### 2.2 low（8 条）

| id | problem | requiredFix | 来源 |
|---|---|---|---|
| D8-L1 | `POND_CHECK_RULES` 让 `loadRules()` 读任意路径（含凭证文件）无名字闸；CLI 不可达（strace 0 open），仅库 API | `customPath` 先过 `isSensitiveFileName` | BOUNDARY L1 |
| D8-L2 | `config.json` 整份进内存再解析（敏感键只跳输出）；实测 0 泄漏，属设计内 | 文档写清口径即可 | BOUNDARY L2 |
| D8-L3 | `skipDirPatterns` 未覆盖 `*cred*`/`*cert*`（实测 `minasCred`/`minasCert` 被 readdir 列名；不 open、名字不进报告） | 保守补目录模式，注意别误杀 `credits` | BOUNDARY L3 |
| D8-L4 | 默认模式在 cwd 累积 `pond-check-<时间戳>.html` | 文档提一句 | BOUNDARY L4 |
| D8-L5 | `windowStale` 的 nextStep 仍是拼接，可能出现「不用动。先看「存活」那栏…」 | 改为替换而非拼接 | HEALTH M1 |
| D8-L6 | 数字关键词边界不排字母：`BV412` / `?aid=412` 会被算成风控（假报警方向） | 前后要求空白/标点，或先剥 URL/BVID | HEALTH M2 |
| D8-L9 | `docs/CAPABILITIES-SPEC.md` 是零实现的设计稿，易被读成「已支持」 | README 加一行「未实现的设计稿，v0.1 不含这些能力」 | TESTS D9 |
| D8-L10 | 测试债务：10 条弱断言 + `evaluate.test:437` 硬编码 3600 + 5 项环境敏感点无留痕 | 按 TESTS §4 表强化；3600 改读 rules；敏感点加 skip 说明 | TESTS §4/§7/§8.3 |

> 另外两条 low 在复核时发现已随 D7a/D8 的文档修改自然消解：**D8-L7**（SPEC §8 的 sqlite 措辞现为「条目数 `unknown` —— 宁可 unknown 也不估」，与实现一致）、**D8-L8**（README 已无「D1–D7」阶段描述）。

---

## 3. 关闭台账（三轮合计 14 条）

| id | 原级别 | 关闭轮次 | 关闭方式（我都复核过） |
|---|---|---|---|
| F-01 `--no-exec` 参数不存在 | — | f2ae08a | SPEC/rules 改「默认关闭」措辞 |
| F-02 docs 一致性闸假阳性 | — | f2ae08a | 闸重写 |
| D8-B1 假健康（尾部截断仍判 clean） | blocker | b110106 | `firstTimestamp` + `coveredHours` → `unknown(window_truncated)` |
| D8-H2 JSON 合同与 SPEC 不符 | high | b110106 | SPEC 改 `meta.generatedAt` / `fishes` + 注记 |
| D8-H5 同名鱼撞脸 | high | b110106 | 压缩后做冲突检测，给 scope 留位置 |
| D8-M1 policy 声明无闸门 | medium | b110106 | `tests/source-guards.test.mjs` 直接读 `RULES.policy` |
| D8-M7 T13/T14 源码守卫缺失 | medium | b110106 | 同上（不联网 ×2 / 不外执行 / 只读写盘） |
| D8-M8 JSON 值级脱敏零测试 | medium | b110106 | 行为断言（并顺手修掉 fixes 长版真泄漏） |
| D8-H1 modelLine 推断型 fail | high | caa7832 | 一个模型键都没有 → `unknown` |
| D8-M3 非视频鱼缺 ffmpeg → fail | medium→high | caa7832 | ffmpeg 缺失 → `warn` |
| D8-H4 unknown 颜色零守卫 | high | caa7832 | 颜色层守卫，改绿立刻红（我验证过） |
| D8-H3 进程表承诺未实现 | high | caa7832 | SPEC 四处标注「v0.1.0 未实现」+ §8 补局限 |
| D8-L7 sqlite 措辞 | low | 文档演进 | 现措辞与实现一致 |
| D8-L8 README 阶段描述过时 | low | D7a 重写 | 已无该描述 |

---

## 4. 正面结论（写进发布说明都不亏）

- **只读边界零破坏**：零网络（已升级为源码闸门，不只是「我 grep 过」）、零运行时依赖、凭证零泄漏（假凭证炸弹三渲染 0 命中 + strace 级 0 次 open）、写盘只有 `cli.mjs` 一处（同样进闸门）、`execve` 整跑仅 node 自身、`kill` 类 0。
- **假健康主链路成立**：六格默认全 `unknown`、无 `|| 'ok'` 兜底；健康栏现在会主动说「只看了最后 X 小时，不等于没报错」。
- **红线有守卫且能杀变异**：9 条 source-guards，覆盖不联网 / 不外执行 / unknown 不许绿（类名 + 颜色）/ JSON 脱敏 / 只读写盘。
- **测试是真硬的**：125 用例，判定层变异成片杀；边界压测真的在造坏环境（chmod 000 / FIFO / 软链成环 / 1 GiB 稀疏文件 / 二进制 / 时钟错乱）。
- **复盘文化**：`caa7832` 的提交说明里直接承认「上一版 H4 修复是假闭环」并自测「改绿后守卫立刻红」——这比修好本身更值钱。

---

## 5. 局限（照实写）

1. **我复核的是「原来那份反例」**：每条 high 都用上一轮自己造的那份输入重跑，因此能证明「这个具体缺陷被关掉了」；不能证明「这一类缺陷再也不会出现」——后者靠的是 §4 的守卫。
2. **平台**：全部结论在 Linux / Node 22.23.4 取得；Windows/macOS 未验证（D8-M6 就是这个缺口，README 与 SPEC 已如实标注）。
3. **medium/low 未逐条重跑**：它们来自三份报告的原机取证，我只对影响结论走向的项做了抽查（M2/M4/M5/M6 在 `caa7832` 上仍成立）。
4. **本文件只做汇总与定级**：本轮唯一写入 = 本文件，未改任何代码或测试。
