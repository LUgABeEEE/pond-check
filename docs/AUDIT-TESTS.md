# pond-check 测试真实性与文档一致性审查（D8c）

> 审查对象：`tests/*.test.mjs`（7 个文件 / 114 个用例 / 548 条断言）、`src/`（13 个模块）、
> `README.md`、`docs/SPEC.md`。目的只有一个：**测试是不是在自我安慰，文档是不是在吹牛。**
>
> 审查方式：逐文件读断言 + 全仓 grep + 真跑 CLI + **变异测试**（往代码里注入缺陷，看测试能不能抓住）。
> 所有结论都能用第 11 节的命令复现，不依赖审查者的主观印象。
>
> 利益冲突声明：本次审查的成员（probe-dev）写过分支里的 `src/read/*`、`src/render/text.mjs`
> 与 `tests/read.test.mjs`。凡涉及这几处的结论，下面一律给出**可复现的变异编号**或**真机输出**，
> 不靠「我觉得没问题」。
>
> **审查基线**：最终结论以提交 `f2ae08a`（D7/D8 收口，114 用例全绿）为准。
> 审查过程中仓库在动：我先按 `8ee7ee2`（D6 收口）读完代码与测试，期间队友提交了 `f2ae08a`
> （清掉 `--no-exec` / `--expect-schema` 残留、新增 `tests/docs-consistency.test.mjs`）。
> 两份状态我都核对过——**已修的条目我标「已修(f2ae08a)」并保留证据，不冒领、也不装作没发生过**；
> 变异测试在 `f2ae08a` 上重跑了一遍（§5 的数字是新的）。

---

## 0. 先看结论

**测试不是自我安慰。** 15 个注入缺陷里有 12 个被测试当场抓住（80%），边界压测那一路（`tests/boundary.test.mjs`）
是真的在下狠手（chmod 000、FIFO、软链成环、1 GiB 稀疏文件、二进制、时钟错乱都测了）。

下面 9 项里有 5 项是**文档承诺了、实现或测试没跟上**。其中 A1 在审查期间已被 `f2ae08a` 修掉
（保留在表里是因为它暴露的「机制缺口」值得记），其余 8 项在当前 HEAD 上仍然成立：

| # | 问题 | 严重度 | 一句话证据 |
| --- | --- | --- | --- |
| A1 | `--no-exec` 写进了 SPEC 与 rules.json，CLI 根本不认 | **高 → 已修（f2ae08a）** | 修前：`node src/cli.mjs --no-exec` → `不认识的参数`，exit 2；修后：rules.json 改 `enabledByDefault:false`，全仓已无 `--no-exec` |
| A2 | JSON 合同改过名：`fish`→`fishes`、`generatedAt`→`meta.generatedAt`，SPEC 仍写旧名且自称「下游只依赖这个」 | **高** | 真机 `--json` 顶层键实测见 §9 |
| A3 | SPEC §3.2 的 P1 进程表探测**完全没实现**，`processes` 恒为 `[]` | **高** | `grep -rn "/proc" src/` 只命中 rules.json 的字面量 |
| A4 | 「unknown 不许冒充正常」的灰色没有测试 | **高** | 把 `--unknown` 改成绿色，114 个用例**全绿**（变异 M17） |
| A5 | 同名不同 profile 的鱼在 `--text` 里已退化成两行一模一样，且无测试 | **高** | 真机两条 `dsh-whale-widget` 渲染完全相同 |
| B1 | Windows「明确报 unsupported」未实现 | 中 | `grep -rn "win32" src/` 只有 ffmpeg 文件名那一处 |
| B2 | SPEC §7 的 T13/T14 源码扫描守卫没有任何测试或 CI 步骤 | 中 | CI 只有语法 / 单测 / 零依赖三步 |
| B3 | JSON 值级脱敏是「防御纵深」但零测试 | 中 | 关掉 `redactValue` 的脱敏分支，114 个用例全绿（变异 M13） |
| B4 | `--root` / `--log` / `--dedupe` 指到不存在路径的行为无测试 | 中 | CLI 实测会 warn + 继续，但没有用例锁 |

---

## 1. 审查范围与方法

### 1.1 规模

| 项 | 数量 |
| --- | --- |
| 测试文件 | 7（含审查期间新增的 `tests/docs-consistency.test.mjs`） |
| 用例 | 114（`f2ae08a` 上全绿、0 skip；审查开始时 8ee7ee2 为 111） |
| 断言 | 548 条（`assert.equal` 305 / `assert.ok` 150 / `deepEqual` 38 / `assert.match` 37 / `notEqual` 12 / `doesNotThrow` 3 / `doesNotMatch` 3） |
| 全量耗时 | ~280 ms |
| 源码 | `src/**/*.mjs` 13 个模块，9 377 行 |
| 文档 | README 55 行 / SPEC 551 行 / FIELD-NOTES 276 行 / CAPABILITIES-SPEC 387 行 |

### 1.2 变异测试（判断「测试是否真能抓住缺陷」的唯一硬办法）

做法：把仓库整份复制到 `/tmp`，每次只注入**一个**已知缺陷，跑 `node --test`，看有多少用例变红。
脚本见 §11，结果见 §5。**杀不掉**的变异 = 该行为没有任何测试在看着。

---

## 2. 测试总体画像

| 文件 | 用例 | 断言 | 非正常路径用例（启发式） | 评价 |
| --- | --- | --- | --- | --- |
| `tests/boundary.test.mjs` | 27 | 116 | 19 / 27 | 全仓最强的一组。真在造坏环境，不是走过场 |
| `tests/evaluate.test.mjs` | 19 | 114 | 9 / 19 | 契约级断言扎实（六格键集、severity 来源、排序、分桶）；少量弱断言 |
| `tests/regression-d6.test.mjs` | 26 | 111 | 7 / 26 | 话术/口径回归很好（含「话术里的 `--xxx` 必须真支持」这种聪明闸门） |
| `tests/render.test.mjs` | 22 | 86 | 5 / 22 | 渲染+CLI 行为覆盖全；多为子串断言，能抓「有没有」抓不住「对不对」 |
| `tests/read.test.mjs` | 11 | 87 | 5 / 11 | 五种规定场景齐；凭证闸隔离度不够（见 §4） |
| `tests/discover.test.mjs` | 6 | 27 | 4 / 6 | 夹具驱动、能复现；断言偏「类型对不对」而非「值对不对」 |
| `tests/docs-consistency.test.mjs` | 3 | 7 | 3 / 3 | `f2ae08a` 新增：把「文档教的参数必须真存在」变成机器闸门。思路对，覆盖面还差 `rules.json` 的结构化字段 |

> 「非正常路径」是按用例名里的关键词（坏/空/缺/不存在/失败/异常/unknown/bad/…）数出来的，
> 只是量级参考，不是精确分类——比如 evaluate 的 S02「六格全绿」虽然算正常路径，但它断言的是
> 六格的具体值，含金量并不低。

**总体判断：不是 happy-path only。** 边界、降级、凭证、乱参数这四类都有真实覆盖；
薄弱点在「渲染细节的正确性」和「文档承诺的开关」。

---

## 3. 逐文件审查

### 3.1 `tests/boundary.test.mjs`（27 例 / 116 断言）

**覆盖**：chmod 000、空日志、8 MiB + 1 GiB 稀疏日志、单行 1 MiB、非 UTF-8、含 NUL 的二进制、
软链成环（自指/互指/logs 回环）、FIFO 当日志、300 条目目录、未来 mtime、垃圾入参、坏 JSON 配置、
二进制判重表、凭证文件名（含只有 `*session*` 能拦住的 `bili-session.log`）、`readAll` 一条坏鱼不拖累其它。

**强度**：好。断言落到**状态与理由**（`reason='eacces'`、`missing` 数组、`unreadable` 列表），
不是「没抛就行」。3 处 `doesNotThrow` 用在「垃圾输入不该崩」上是合理的。

**问题**
- `tests/boundary.test.mjs:724-725` —— `assert.ok(html.length > 0)` / `assert.ok(text.length > 0)`
  是收口断言里最弱的两条：渲染器退化成只输出一个 `<html>` 壳也能过。
  建议：断言底部声明 + 至少一条鱼的名字 + 统计行（同一文件 :727 已经断言了声明，可合并强化）。
- `tests/boundary.test.mjs:446` —— `every((fish) => fish.indicators !== null)`：只证明不是 null，
  六个键存不存在没证明。
  建议：`assert.deepEqual(Object.keys(fish.indicators), INDICATOR_IDS)`。
- `tests/boundary.test.mjs` 里共有 5 处 `assert.ok(elapsed < 5000)`（:175、:316、:420、:439、:702）——
  全是墙上时钟断言，CI 抖动时会偶发红。5 秒阈值算宽松，但建议改成「相对基线 × N」或去掉耗时断言、只断言产物正确。
- 依赖平台能力：`mkfifo`（:604 有 win32 跳过守卫，但没有「容器里没有 mkfifo」的守卫——
  实际上 :611 会 `t.skip`，OK）；软链用例（:409-432）在 Windows 上会直接失败。
  CI 只跑 ubuntu，所以不构成 CI 风险，但要写进「支持平台」里。

### 3.2 `tests/evaluate.test.mjs`（19 例 / 114 断言）

**覆盖**：空列表、六格全绿、死了的鱼、空窝、有点吵+停摆、ffmpeg 缺失、旧 schema、排序、
severity 来源、fixes 去重封顶、degraded 合并、凭证路径替换、乱参数、四种输入形状、**阈值真的读 rules**、
显示名 `~` 缩写、`skippedSensitive` 只出计数、六格键集合固定、聚合自身崩溃也要出鱼。

**强度**：高。S09/S18 是契约级断言（六格键集、每格 severity 必须来自 rules），这类断言最值钱。

**问题**
- `tests/evaluate.test.mjs:259` —— `assert.ok(report.footnote)`：只证明脚注「非空」。
  一个永远输出 `"x"` 的实现也能过。
  建议：`assert.match(report.footnote, /项数据读不到/u)` + 断言里面提到的格名是中文。
- `tests/evaluate.test.mjs:437` —— `assert.equal(...activeMaxSec, 3600)`：把 rules.json 的当前值
  硬编码进测试。SPEC §9 明确允许「改阈值只改 rules.json」，一旦有人照做，这条测试会误报红。
  建议：`const DEFAULT_RULES = JSON.parse(fs.readFileSync(new URL('../src/rules.json', import.meta.url)))`
  再取 `DEFAULT_RULES.indicators.liveness.thresholds.constants.activeMaxSec`。
- 健康分的关键词链路只喂**假的** `hardHits`（:97、:156、:267、:350），没有一条端到端用例
  「日志里真的写了 412 → health=critical」。SPEC T7 这个锚点目前只在 D4 层用假计数覆盖（见 §6）。

### 3.3 `tests/regression-d6.test.mjs`（26 例 / 111 断言）

**覆盖**：三条假鱼端到端、鱼级分桶、三处口径一致（evaluate/文本/HTML）、unknown A/B 话术、
`--log`/`--dedupe` 真实现、**「话术里出现的每个 `--xxx` 都必须真支持」的一致性闸**、
`--expect-schema` 已删除、总评口径、fixShort 长度、话术体检、0 条鱼、`--fish` 没命中、
本地时区、HTML 单位/状态灯、名字列宽、歧义宽度字符、路径可复制、JSON 分桶。

**强度**：高，而且方法聪明——话术一致性闸把「文档教用户敲的参数」变成了可执行断言。
**但这道闸只扫 `rules.json` 里的话术，扫不到 `docs/SPEC.md`**——这正是 A1 `--no-exec` 长期漏网的原因。
（审查期间 `f2ae08a` 已补了专门扫 docs 的 `tests/docs-consistency.test.mjs`，见 §3.7。）

**问题**
- 建议把 :422 的闸门扩到 SPEC/README：扫 `docs/*.md` 与 `README.md` 里所有 `` `--xxx` ``，
  断言 `parseCliArgs` 认（排除外部命令参数）。这一条能直接抓住 A1。
- 缺「两条同名鱼必须可区分」的断言（A5 就是这么漏掉的）。

### 3.4 `tests/render.test.mjs`（22 例 / 86 断言）

**覆盖**：HTML 结构/零外链/XSS 转义、文本统计行/一屏上限/无 ANSI、JSON 字段序与逐字节稳定、
CLI 参数解析与用法错误、`runCli` 10 种行为（默认写盘、`--out`、`--json`、`--text`、`--root` 替换、
撞窝复用、`--fish` 过滤/没命中、0 鱼、真异常 exit 1、用法错误 exit 2、`--help`）。

**强度**：中上。零外链断言写得很硬（正则 + 全量扫 + 三类页面各扫一遍），XSS 也真断言了转义结果。

**问题**
- 全是 `includes` 子串断言：能证明「字符串出现过」，不能证明「出现在正确的位置/正确的那条鱼上」。
  例如 :204 断言统计行文本，但如果渲染器把四条鱼的名字全写成同一个，它照样绿（这正是 A5）。
- `tests/render.test.mjs:165-171` 四条 HTML 断言都基于同一个合成报告，缺「空报告/兜底页」的结构断言
  （:185-186 只断言了兜底页的声明，没断言它的骨架）。

### 3.5 `tests/read.test.mjs`（11 例 / 87 断言）

**覆盖**：正常四源、700 KB 超大日志（只读 262144 字节、窗口外 429 不计入）、空文件、chmod 000、
凭证拒读、D2b evidence 定位优先、全缺失降级、`readAll` 顺序与坏输入、关键词单一来源、
dsh 插件 profile 根补齐、**deps.homeWritable 按每条鱼自己的窝判**。

**强度**：中上。断言到具体值（`bytesRead === 262144`、`fromOffset + bytesRead === size`、
`sources.log.reason === 'eacces'`）。

**问题**
- **凭证闸隔离度不足**：`tests/read.test.mjs:216` 的敏感日志叫 `api_token.log`，
  即使 `skipFilePatterns` 整个失效，它仍会被 `isCredentialishDirName`（token 词）兜住——
  变异 M6 里这条用例**没有变红**就是证据。真正的 `skipFilePatterns` 闸只有
  `tests/boundary.test.mjs:529`（第 18 个 subtest）一个用例在守。
  建议：加一条只靠 `*cookie*`（不含 token/secret 词）的用例，例如 `bilibili_cookie.json` 作为
  `paths.dedupe` 传入，断言 `skippedSensitive` 命中且文件名不出现在 JSON 输出里。
- `tests/read.test.mjs:89` —— `hardHits >= 1`：夹具行同时含 `412` 与 `Precondition Failed`，
  删掉其中一个关键词仍然通过（变异 M2）。
  建议：断言 `categories.find(c => c.id === 'riskControl').count === 1`（已有）+ **另加**一条
  只有 `412` 的行、和一条 `sleep 4121ms`（必须不命中）的行，锁住 D3a 的数字边界匹配。
- `tests/read.test.mjs:164-167` chmod 用例在 root 下静默跳过；容器化 root CI 会丢掉这层覆盖。
  建议：skip 时用 `t.diagnostic()` 留痕，或在 CI 里断言 `id -u != 0`。

### 3.6 `tests/discover.test.mjs`（6 例 / 27 断言）

**覆盖**：正常发现、目录不存在、空目录、unknown 降级、双 profile、generic 超时降级。
夹具在 `tests/fixtures/`，只读不写（`.gitignore` 有豁免，`git ls-files` 确认 5 个文件都入库）。

**强度**：中。断言偏「形状」而非「值」：
- `tests/discover.test.mjs:59` `assert.ok(only.evidence.reasonText.length > 0)` —— 上一行已经
  断言了 `includes('判重表')`，这条是重复且更弱。
- `tests/discover.test.mjs:79` `assert.ok(typeof fish.degraded[0].reason === 'string')` ——
  只证明是字符串，`"whatever"` 也能过。
  建议：断言具体 `reason`（如 `'timeout'`）+ `scope==='generic'`。
- `tests/discover.test.mjs:76` `scan('normal', { timeoutMs: 1 })` 依赖「1 ms 内 worker 起不来」，
  在极快机器上理论上可能翻转。建议注入一个必然超时的假 worker，或把断言改成「要么降级、要么结果完整」。

### 3.7 `tests/docs-consistency.test.mjs`（3 例 / 7 断言，审查期间新增）

**覆盖**：扫 `README.md` / `docs/SPEC.md` / `docs/CAPABILITIES-SPEC.md` 里出现的每个 `--xxx`，
用 `parseCliArgs` 探针验证 CLI 真认；回归保护 `--expect-schema` 不许复活；`--help` 必须列出所有逃生口参数。

**强度**：中上。设计得很讲究——排除外部命令（`git push --force`、`node --version`）与通用参数
（`--version`/`--help`），并且**故意不扫 `docs/FIELD-NOTES.md`**（那是问题记录，提到不存在的参数是在描述问题，
不是建议）。这个判断是对的。

**问题**
- **闸门只覆盖「文档正文」**：`f2ae08a` 已经把 `rules.json` 里那个 `disableWith: "--no-exec"` 换成了
  `enabledByDefault: false` + `disableNote`，所以当前没有残留。但**结构性字段不在闸门内**——
  下次若有人在 `rules.json` 的某个字符串字段里写 `--some-flag`，这条闸拦不住。
  建议：加一条「`rules.json` 里任何字符串值出现的 `--xxx` 都必须被 `parseCliArgs` 支持」的用例
  （读 JSON 比扫文本可靠；`disableNote` 这种说明性文字可以像 `FIELD-NOTES.md` 一样豁免）。
- **第 3 个用例（`:122`）是文本断言而不是行为断言**：它把 `src/cli.mjs` 当源码读、断言
  `helpText.includes(flag)`（`:128-136`）。如果某天某参数从 `parseCliArgs` 里被删掉、但 USAGE 字符串还留着，
  这条用例会照绿——而用户照着 `--help` 敲就会 exit 2。
  建议：用现成的 `runCli` 注入 `stdout`，抓**真实** `--help` 输出再断言（`tests/render.test.mjs:406` 已有同款写法）。
- `collectFlags` 按空白切 token（`:55`）：参数紧贴中文写作「用`--root`指路」时，整段可能被当成一个 token 漏掉。
  建议补一条自测：喂 `'用--root指路'` 也应被识别，或明确把这条盲区写进注释。

---

## 4. 弱断言清单（逐条给改法）

| 文件:行 | 断言 | 为什么弱 | 应该怎么改 |
| --- | --- | --- | --- |
| `tests/evaluate.test.mjs:259` | `assert.ok(report.footnote)` | 非空即过，内容可以是垃圾 | `assert.match(report.footnote, /\d+ 项数据读不到/u)` |
| `tests/boundary.test.mjs:724` | `assert.ok(html.length > 0)` | 空壳 HTML 也过 | `assert.ok(html.includes('本报告只读、不联网、无遥测。') && html.includes('鱼况体检'))` |
| `tests/boundary.test.mjs:725` | `assert.ok(text.length > 0)` | 同上 | 断言首行 `🐟 pond-check` + 末行 `共 N 条` |
| `tests/boundary.test.mjs:446` | `fish.indicators !== null` | 不证明六键齐全 | `assert.deepEqual(Object.keys(fish.indicators), INDICATOR_IDS)` |
| `tests/discover.test.mjs:59` | `reasonText.length > 0` | 与上一行重复且更弱 | 删除，或改为断言完整句包含「判重表」与「补上」 |
| `tests/discover.test.mjs:79` | `typeof reason === 'string'` | 任意字符串都过 | `assert.equal(fish.degraded[0].reason, 'timeout')` |
| `tests/read.test.mjs:89` | `hardHits >= 1` | 夹具含两个关键词，测不出单点回归 | 补「只有 412」与「4121 不得命中」两条 |
| `tests/render.test.mjs:165-171` | 四条 `includes` | 只证明标签存在 | 增加「报告里每条鱼都有卡片」计数断言（`(html.match(/class="fish-card"/g)||[]).length === report.fishes.length`） |
| `tests/evaluate.test.mjs:176,178` | `phenomenon/nextStep.length > 0` | 非空即过 | 加「不含未替换的 `{var}`」断言（SPEC T15 明确要求） |
| `tests/read.test.mjs:106` | `result.credentials.foundCount >= 0` | 只能证明字段存在，证明不了「本机没有凭证时不谎报有」 | 用注入的空 `credentials` 断言 `foundCount === 0` 且 `reason === 'no_credentials_found'` |

> 说明：`assert.ok(x.length > 0)` 这类断言在「批量检查六格都不为空」的场景里是合理的折衷，
> 单独看每条不冤；但上面 9 条里有 5 条**完全可以在不修实现的情况下继续绿**，这才是风险。

---

## 5. 变异测试矩阵（15 个注入缺陷，12 个被抓住）

> 跑在基线提交 `f2ae08a`（114 用例、全绿）上，这样「红了几条」可直接读数；
> 每个变异体只改一处、跑完丢弃（夹具在 `/tmp` 的副本里，从不碰工作树）。

| # | 注入的缺陷 | 变红用例数 / 114 | 判定 |
| --- | --- | --- | --- |
| M1 | `rules.json` `liveness.activeMaxSec` 3600→60 | 3 | ✅ 抓住（阈值真从 rules 读） |
| M2 | `rules.json` 只删 `412` 一个关键词 | 0 | ❌ **漏网**（夹具同时含 `Precondition Failed`） |
| M2b | 同时删 `412` + `Precondition Failed` | 2 | ✅ 抓住 |
| M3 | `log.mjs` 去掉尾部截断（读整个文件） | 4 | ✅ 抓住 |
| M4 | `classifyFishBucket` 恒返回 `ok` | 9 | ✅ 抓住（鱼级分桶被锁死） |
| M5 | HTML 头部注入 `<link href="https://…">` | 3 | ✅ 抓住（零外链验收门有效） |
| M6 | `isSensitiveFileName` 恒 false（凭证闸全关） | 1 | ⚠️ 抓住但**只有 1 条**（红线太单薄） |
| M7 | `displayWidth` 把中文算 1 列 | 1 | ✅ 抓住（但只有 1 条） |
| M8 | CLI `--json` 改从 stderr 输出 | 1 | ✅ 抓住 |
| M11 | `rules.json` `criticalHardHits` 3→999 | 1 | ✅ 抓住（health 档位被锁，但只 1 条） |
| M12 | 文本统计四桶全算「活跃」 | 4 | ✅ 抓住 |
| M13 | JSON 值级脱敏失效 | 0 | ❌ **漏网**（该防御零测试） |
| M16 | `unknown` 严重度悄悄当 `ok` | 17 | ✅ 抓住（`neverDefaultToOk` 守得最牢） |
| M17 | HTML `--unknown` 由灰改绿（SPEC §5.1 明令禁止） | 0 | ❌ **漏网**（红线无测试） |
| M18 | 日志窗口缩到 1 KiB | 2 | ✅ 抓住 |

**读法**：M16 杀 17 条说明「不许假健康」在**判定层**守得很好；M17 杀 0 条说明同样的原则在**渲染层**
只是注释里的一句话。M6 杀 1 条说明凭证红线靠单点断言撑着——worst case 一次重构就能悄悄关掉。

---

## 6. 覆盖缺口（没有任何测试在看着的行为）

| # | 未被锁的行为 | 现状证据 | 建议用例 |
| --- | --- | --- | --- |
| G1 | `--no-exec` | CLI 实测 exit 2；SPEC:39、SPEC:146、`rules.json:269/278/287` 都承诺它存在 | 要么实现，要么改 SPEC；并加「文档里每个 `--xxx` 都必须被 `parseCliArgs` 认识」的闸门（把 regression-d6:422 扩到 `docs/*.md` + README） |
| G2 | `unknown` 必须是灰色、不许绿色 | M17 全绿 | 断言 `--unknown` 值不是任一绿系色值，且 unknown 灯的 class 是 `ov-unknown`（`src/render/html.mjs:328`） |
| G3 | JSON 值级脱敏 | M13 全绿 | 造一条 fish.name 形似 `id_ed25519` 的报告，断言 `renderJson` 输出里被换成常量 |
| G4 | 数字关键词的边界匹配（`4121` 不算 412） | 无任何用例 | `classifyLine('sleep 4121ms')` 不命中 riskControl；`classifyLine('HTTP 412')` 命中 |
| G5 | `--root` / `--log` / `--dedupe` 指到不存在的路径 | 无用例（CLI 实测会 warn + exit 0，行为本身是对的） | 注入假 fs 或用临时不存在的路径，断言 stderr 有「不存在」且 exit 0、报告里那条鱼不是 ok |
| G6 | 同名不同 profile 的鱼在文本里可区分 | **已实测退化**（见 A5） | 两条同名鱼，断言两行的名字列不相同 |
| G7 | T13/T14 源码守卫（无网络导入 / 阈值字面量） | 无用例、CI 也无此步骤 | 见 §8.3 的一段现成测试 |
| G8 | Windows 平台分支 | 无实现、无测试 | 短期：SPEC 标注 v0.1 不支持；长期：`process.platform === 'win32'` 早退 |

---

## 7. 环境依赖与 CI 可移植性

**结论：测试不依赖真实用户目录，CI 不会因为 `~/.dsh` 不存在而红。**

- 所有扫描类用例都显式传 `dshHome` / `home`：`tests/discover.test.mjs:21`（夹具）、
  `tests/boundary.test.mjs:443`、`tests/read.test.mjs`（`mkdtemp`）、`tests/render.test.mjs:136`（假管线）。
- 唯一出现 `os.homedir()` 的地方是 `tests/evaluate.test.mjs:441`，只用来拼一个**字符串路径**做
  `~` 缩写断言，不读盘。
- 有 3 处 `readAll(...)` 没传 `home`（`tests/read.test.mjs:299/310`、`tests/boundary.test.mjs:678`），
  于是会去 stat 真实 `$HOME` 下的 `knownCredentialPaths`——但**没有任何断言依赖它的结果**
  （`tests/read.test.mjs:106` 只断言 `foundCount >= 0`），所以 CI 上 `$HOME` 里一个凭证文件都没有也照样绿。
  这既是「不依赖真实家目录」的证据，也说明那条断言没在验证什么（见 §4）。
- 没有 `process.env` 写入、没有改 `PATH`；`deps` 一格在边界用例里被显式排除在断言外
  （`tests/boundary.test.mjs:23` 的注释 + `DATA_INDICATORS` 常量），不会因本机有没有 ffmpeg 而翻转。
- 时区：`tests/regression-d6.test.mjs:608-613` 用本地 `Date` 方法算期望值，不是硬编码 `+08:00`，
  在 UTC 的 CI 上同样成立。（对比：如果它写死 `2026-11-07 20:16`，CI 必红——好在没有。）
- 夹具入库：`git ls-files tests/fixtures` 确认 5 个文件都在，`.gitignore:15-20` 有豁免。

**仍有 5 项环境敏感点**（都不阻塞当前 ubuntu CI，但要知道）：

| 风险 | 位置 | 说明 | 建议 |
| --- | --- | --- | --- |
| root 下 chmod 失效 | `tests/read.test.mjs:164`、`tests/boundary.test.mjs:64`（`CAN_CHMOD`） | 以 root 跑测试会静默 skip 掉权限类用例 | CI 里加一步 `test "$(id -u)" != 0`，或在 skip 时 `t.diagnostic()` 显性留痕 |
| 软链 / FIFO / `/dev/null` | `tests/boundary.test.mjs:409-432`、`:604` | 仅 POSIX；Windows 会红（CI 只跑 ubuntu） | 与 README/SPEC 的平台声明保持一致即可 |
| 墙上时钟 | `tests/boundary.test.mjs:175/316/420/439/702`（`elapsed < 5000`，共 5 处） | CI 抖动可能偶发 | 改成相对阈值或删掉 |
| 1 ms 超时 | `tests/discover.test.mjs:76` | 依赖 worker 启动慢于 1 ms | 换确定性超时注入 |
| 耗时上限 | `tests/boundary.test.mjs:296-316`（1 GiB 稀疏文件）、`:319`（单行 1 MiB） | 部分容器/文件系统不支持稀疏文件，写入会真占空间 | 已是 `ftruncateSync` 稀疏写法；补一条「文件系统不支持稀疏就 skip」的守卫 |

---

## 8. 阈值来源审查（SPEC T14）

### 8.1 结论：`src/` 里**没有**硬编码阈值字面量

```
$ grep -rnE "\b(3600|86400|604800)\b" src/*.mjs src/*/*.mjs
  (无输出)
$ grep -rnE "\b(3600|86400|604800)\b" src/ | grep -v rules.json
  (无输出)
```

秒/天的换算全部由常量相乘得出（`src/evaluate/life.mjs:82-84`、`src/evaluate/system.mjs:66-68`、
`src/render/text.mjs:57-61`），档位与常量全部读 `src/rules.json`。

### 8.2 测试侧证据

- `tests/evaluate.test.mjs:427-437`（S15）：注入 `activeMaxSec=60` → 同一份输入从 `active` 变 `slack`，
  并断言全局 rules 未被污染。
- 变异 M1（改 `activeMaxSec`）杀 3 条、M11（改 `criticalHardHits`）杀 1 条 → 阈值确实被测试看着。

### 8.3 不足与建议

1. **锁点偏少**：六指标几十个常量，只有 liveness 与 health 各一个常量被变异验证过。
   建议加一条参数化用例：遍历 `rules.indicators[*].thresholds.constants`，整体替换成「极值」
   （0 或 1e9）后断言对应指标档位必变——一次锁住全部常量。
2. **T13/T14 没有守卫测试**（SPEC:523-524 明确要求「源码扫描」）。CI 也没有这一步。
   建议新增 `tests/source-guards.test.mjs`：

   ```js
   test('T13 src 不得导入网络模块', () => {
     const files = walk('src');
     for (const f of files) {
       const s = readFileSync(f, 'utf8');
       assert.doesNotMatch(s, /node:(http|https|net|dns|tls)/u, f);
     }
   });
   test('T14 src 不得出现秒/天判定字面量', () => {
     for (const f of walk('src').filter(f => !f.endsWith('rules.json'))) {
       assert.doesNotMatch(readFileSync(f, 'utf8'), /\b(3600|86400|604800)\b/u, f);
     }
   });
   ```

3. `tests/evaluate.test.mjs:437` 反过来把 `3600` 写死在测试里，与「改阈值只改 rules.json」冲突（见 §4）。

---

## 9. 文档一致性：README / SPEC 逐条对照实现

### 9.1 真机取证

```bash
# ① JSON 顶层键（HEAD f2ae08a 实测）
$ node src/cli.mjs --json | node -e '…打印 Object.keys…'
[ 'schemaVersion','meta','host','fishes','summary','fishBuckets','traceCounts',
  'bucketNote','traceNote','verdict','nextAction','footnote','degradedCount','skippedSensitive' ]
has top generatedAt: false    |  has meta.generatedAt: true
processes of fish0: []        |  summary: {"fish":2,"ok":0,"watch":0,"bad":0,"unknown":12}

# ② --no-exec（修前 8ee7ee2 的实测，留作出证）
$ node src/cli.mjs --no-exec
pond-check：不认识的参数：--no-exec（看用法：pond-check --help）      exit 2
# 修后（f2ae08a）：
$ grep -rn "no-exec" src/ docs/SPEC.md
（零命中 —— A1 闭环）
```

### 9.2 对照表

| # | 文档位置 | 声称 | 实现 | 判定 | 应该怎么改 |
| --- | --- | --- | --- | --- | --- |
| D1 | 基线 `docs/SPEC.md:39`、`:146`；`src/rules.json` 三处 `disableWith`；`src/read/state.mjs:14` | 只读版本探测「必须能被 `--no-exec` 关掉」 | 修前：CLI 无此参数（`--no-exec` exit 2），实际行为是「默认就不 exec」。**`f2ae08a` 已全清**：SPEC 改成「默认关闭，不显式开启就不执行」，rules.json 换成 `enabledByDefault:false` + `disableNote`，`state.mjs` 注释同步改 | **已修（f2ae08a）** | 无残留。唯一遗留是「这类结构化字段仍不在闸门内」，见 §3.7 的建议 |
| D2 | `docs/SPEC.md:465`、`:467` | 顶层 `generatedAt`、数组键 `fish` | 顶层是 `meta.generatedAt`，数组键是 `fishes` | **不符（高）** | SPEC 自称「下游只依赖这个」，就必须对齐：改 SPEC 两行（最省事），或让 `renderJson` 同时输出 `fish` 别名与顶层 `generatedAt`。**建议改 SPEC + 在 tests 里加「顶层键集合」合同断言**（现在没有任何测试断言顶层键名集合） |
| D3 | `docs/SPEC.md:92-106`（P1 进程表 / 黑盒鱼）、`:137`（Linux 全量支持）、`:531`（Windows 不扫） | 有 `/proc` 进程表探测、黑盒鱼、进程启动时间 | `grep -rn "/proc" src/` 只命中 `rules.json` 字面量；`src/evaluate/index.mjs:633` `processes: []` 恒空 | **不符（高）** | 在 SPEC §8「已知局限」补一条「v0.1 不读进程表：`--root`/目录探测为主，`processes` 恒空，liveness 只用文件 mtime」，并去掉 §3.5 Linux 的「全量支持」。否则用户按 §4.1 期待「进程在跑」判定会失望 |
| D4 | `docs/SPEC.md:139`、`:531` | Windows 明确报 `unsupported` | `grep -rn "win32" src/` 只有 `state.mjs:554` 的 ffmpeg 文件名；`cli.mjs` 无平台分支 | **不符（中）** | 加 8 行：`if (process.platform === 'win32')` → 打印一行「本版本不扫 Windows」+ 一行「用 WSL 或等 v0.2」，exit 0。测试用注入 `platform` 或子进程 `--platform` 覆盖 |
| D5 | `docs/SPEC.md:39`「不写用户目录」 vs `README.md:32`「HTML 落在当前目录」 | 只读、不写用户目录 | 默认在 cwd 写 `pond-check-<ts>.html`（真机实测） | **措辞冲突（中）** | SPEC 补一句「唯一写盘 = 报告文件；默认 cwd，可用 `--out` 指定，绝不写进鱼的窝」 |
| D6 | `docs/SPEC.md:523-524`（T13/T14 源码扫描） | 有这两条守卫断言 | 无用例、CI 无此步骤 | **不符（中）** | 见 §8.3 的现成测试；CI 里那三步 + 这一步一起跑 |
| D7 | `docs/SPEC.md:531`「sqlite 无驱动时只读 mtime/size」 | 无驱动 → 读 mtime/size 估算 | `src/read/state.mjs:373-410`：无驱动 → `count=null` + `reason='sqlite_no_driver'`，只出 `fileMtimeAt`，不估算条目数 | **措辞不符（低）** | 改成「无驱动时条目数 `unknown`，只保留 mtime」——现在的实现其实更保守、更符合「宁可 unknown 也不估」 |
| D8 | `README.md:7`「D1–D7 七个阶段依次交付」 | 七个阶段 | 实际已到 D8（审查/发布） | **过时（低）** | 改成「D1–D8」或删掉这句阶段描述 |
| D9 | `docs/CAPABILITIES-SPEC.md`（387 行，记忆/唤醒/TTS/出图） | 第二大身份的完整设计，「设计定稿，待实现」 | 仓库里**一行实现都没有**（`grep -rni "tts\|mnemon" src/` 无命中） | **可能误导（低）** | README 加一行指针：「`docs/CAPABILITIES-SPEC.md` 是**未实现的设计稿**，v0.1 不含这些能力」 |
| D10 | `README.md:23`「一条网络请求都没有」 | 零网络 | `grep -rn "node:http\|node:https\|node:net\|node:dns\|node:tls" src/` 无命中；无第三方依赖 | ✅ 相符 | — |
| D11 | `README.md:24`「连文件名都不会出现在报告里」 | 凭证零泄漏 | `tests/boundary.test.mjs:529`（第 18 例）+ `tests/render.test.mjs` 的凭证断言 | ✅ 相符（但只有 1 条用例直接守 `skipFilePatterns`，见 §5 M6） | 建议加 1-2 条不同文件名模式的用例 |
| D12 | `README.md` 用法（`--json`/`--text`/`--root`/`--log`/`--dedupe`/`--help`/退出码） | 全部可用 | 逐条真机跑过：`--text`/`--json`/`--help` exit 0，`--root <不存在>` warn + exit 0 | ✅ 相符 | — |

### 9.3 一条用户可见的回归（不是文档问题，但审查中实测发现的）

`--text` 在真机上把两条 `dsh-whale-widget`（不同 profile）渲染成**完全相同**的两行：

```
❓ dsh-whale-widget  判不出  缺 日志
❓ dsh-whale-widget  判不出  缺 日志
```

原因：D6 把名字列压到 20 列（`src/render/text.mjs:60`），而 `dsh-whale-widget` 本身 16 列 +
`（）` + `…` 已超过 20，`shortenLabel`（`src/render/text.mjs:265-281`）的 scope 尾巴保不住，
退回只留 base → 两行撞脸。**没有任何测试守住「同名鱼可区分」**，所以回归无声无息。

建议：`MAX_NAME_COLS` 放到 26，或退化时输出 `dsh-whale…（web）` 这种短 scope 形式；
并加用例：两条同名 fish 的渲染行，名字部分必须不同。

---

## 10. 必改清单

> 状态截至 `f2ae08a`。带 ✅ 的是审查期间已经修掉的，保留是为了让后来人知道「这类缺陷长什么样」。

### 已完成（审查期间）

- ✅ **D1 `--no-exec`**：`f2ae08a` 全清（SPEC 两处措辞 + rules.json 三处 `disableWith` + `state.mjs` 注释），
  并新增 docs 一致性闸。**这条是本次审查里唯一被完整闭环的 P0。**

### P0（发布前必须，仍未修）

1. **D2 JSON 合同**：`docs/SPEC.md:465` 的 `generatedAt` 与 `:467` 的 `fish` 与实际输出
   （`meta.generatedAt` / `fishes`）不符。SPEC 自己写着「下游只依赖这个」。
   改 SPEC 两行即可；同时补一条**顶层键集合**的合同测试（现在没有任何测试断言顶层键名）。
2. **A5 同名鱼撞脸**：`src/render/text.mjs:60` 的 `MAX_NAME_COLS=20` 让 scope 尾巴保不住，
   真机两条 `dsh-whale-widget` 渲染成完全相同的两行。修宽度或退化形式 + 加回归用例。
3. **D3 进程表**：SPEC §3.2 P1 / §4.1 / §3.5 承诺的 `/proc` 探测完全不存在，`processes` 恒为 `[]`。
   短期：SPEC §8 补「v0.1 不做进程表」，删掉 Linux「全量支持」；长期：实现 P1。

### P1（本迭代内）

4. **A4 unknown 颜色**：加 HTML 断言（变异 M17 证明现在零守卫，改绿全绿）。
5. **B3 JSON 脱敏**：加一条形似凭证名的 `name` 用例（变异 M13 证明零守卫）。
6. **G4 数字边界**：加 `sleep 4121ms` / `1.412.0` 不得命中、`HTTP 412` 必须命中的用例（变异 M2）。
7. **B1 Windows**：加 `process.platform === 'win32'` 早退（8 行）+ 测试。
8. **B2 T13/T14 守卫**：新增 `tests/source-guards.test.mjs`（§8.3 有现成代码）；CI 同步加这一步。
9. **docs 闸再进一步**（`tests/docs-consistency.test.mjs`）：① 加「`rules.json` 里任何字符串值出现的
   `--xxx` 都必须被支持」；② 把 `:122` 的第 3 例改成抓**真实** `--help` 输出（别读源码文本）。

### P2（清理）

10. 弱断言按 §4 表逐条强化（10 条）。
11. `tests/evaluate.test.mjs:437` 的 `3600` 改成从 `rules.json` 读默认值（否则改阈值会误伤测试）。
12. G5 `--root` / `--log` / `--dedupe` 指到不存在路径的用例。
13. G1 root/chmod skip 留痕；5 处 `elapsed < 5000` 改成相对阈值。
14. README:7 阶段描述（D1–D7 → D1–D8）；README 加 `docs/CAPABILITIES-SPEC.md`「未实现设计稿」的指针。

---

## 11. 复现命令

```bash
# 基础事实
node --test                                   # 基线 f2ae08a：114 / pass 114 / skip 0 / ~270ms
for f in tests/*.test.mjs; do node --test "$f" | grep -E '^# (tests|pass)'; done

# 阈值字面量（应为空）
grep -rnE "\b(3600|86400|604800)\b" src/*.mjs src/*/*.mjs

# 网络模块（应只在 rules.json 的禁列表里出现）
grep -rn "node:http\|node:https\|node:net\|node:dns\|node:tls" src/

# 进程表 / Windows（应只在 rules.json 里出现）
grep -rn "/proc" src/ ; grep -rn "win32" src/

# CLI 与文档的偏差
node src/cli.mjs --no-exec ; echo "exit=$?"          # 期望 0，实际 2
node src/cli.mjs --json | head -3                    # 看顶层是 meta + fishes

# 变异测试（脚本骨架；每次只改一处，跑完 node --test 看红了几条）
mut () {
  rm -rf /tmp/mut-repo && cp -a . /tmp/mut-repo
  ( cd /tmp/mut-repo && eval "$1" )
  ( cd /tmp/mut-repo && node --test 2>&1 | grep -E '^# (pass|fail)' )
}
mut 'sed -i "s/--unknown: #8b949e;/--unknown: #3fb950;/" src/render/html.mjs'   # M17：应红 0 条 → 缺口
mut 'sed -i "s/\"criticalHardHits\": 3/\"criticalHardHits\": 999/" src/rules.json'  # M11：红 1 条
mut 'sed -i "s/const span = Math.min(maxBytes, size);/const span = size;/" src/read/log.mjs'  # M3：红 4 条
```

---

## 12. 一句话总结

**测试是硬的，文档是软的。** 判定层（假健康、unknown、分桶、阈值）守得很好——变异 M16 一次杀 17 条用例就是证据；
渲染层的红线（unknown 不许绿、凭证值级脱敏）和文档承诺（JSON 键名、进程表、Windows）仍在裸奔。P0 三条改完，
这份报告才配得上它自己写的「一页看完、不许假健康」。

公道话：审查期间 `f2ae08a` 把「文档教用户敲不存在的参数」这个缺陷类型**机制化地挡住了**（新增 docs 一致性闸），
这是本次审查里最有价值的一次修复；剩下的同类风险只在 `rules.json` 的结构化字段与源码注释里。
