# Changelog

本文件记录 pond-check 对外的行为变化，分组沿用 Added / Changed / Fixed。

判定口径与阈值的权威来源是 `docs/SPEC.md` 与 `src/rules.json`；本文件只做汇总与索引，不替代规格。
版本号与 `package.json` 一致。

## Unreleased

暂无变更。

## [0.1.1] - 2026-11-07

清掉 D8 审查（`docs/AUDIT-SUMMARY.md` §2）遗留的 6 条 medium + 8 条 low，共 14 条。
每条都补了回归测试并做变异验证（把修复改回旧逻辑，对应用例必须红）；全量 167 tests 全绿。

### Fixed

- **D8-M2** `--out` 静默覆盖 / 符号链接顺链写：新增 `checkWriteTarget` 写盘安全闸（扫描前执行）——
  目标已存在默认拒绝（stderr 说明「加 `--force` 覆盖或换个路径」，exit 1）；`--force` 只放行覆盖普通文件；
  目标是符号链接时连 `--force` 也不写穿；父目录不存在仍递归创建、父目录是文件则明确报错；`--help` 注明 `--force` 语义。
- **D8-M4** 分桶 `bad` 同页两个词：四灯 / 统计行与 summary 统一「坏了」，「死了」只留 `liveness=dead` 档位名；
  deps broken + liveness active 的鱼全文不再出现「死了」。
- **D8-M5** 分桶 `ok` 门槛过低：抬到「已知格 ≥2 且 liveness 已知」（已知格与 summary 六格同尺），达不到落 `unknown`；
  统计行 / HTML 追加「多格判不出的鱼 N 条（活跃不代表六格全绿）」。
- **D8-M6** Windows「明确报 unsupported」未实现：`platform` 可注入，win32 在解析后、扫描前早退 ——
  stderr 明确「v0.1 不支持 Windows」、exit 1、不扫描 / 不渲染 / 不写盘。
- **D8-M9** 逃生口（`--root` / `--log` / `--dedupe` 指到不存在路径）无用例锁：新增 `tests/cli-paths.test.mjs`
  4 条真 CLI 子进程用例 —— stderr 有对应提醒且带路径、exit 0、报告仍产出、那条鱼六格全 unknown。
- **D8-M10** SPEC「不写用户目录」与默认往 cwd 写报告的措辞冲突：SPEC §2.1 补「写盘边界说全」段 ——
  唯一写盘 = 一份 HTML 报告、默认写 cwd（`pond-check-<YYYYMMDD-HHMMSS>.html`）、`--out` 可指定
  （默认拒覆盖 / `--force` 才覆盖 / 符号链接不写穿）、绝不写进鱼的窝。
- **D8-L1** `POND_CHECK_RULES` / `rulesPath` 让 `loadRules()` 读任意路径无名字闸：`customPath` 先过敏感名闸
  （文件名或任意一段目录命中凭证 / 证书模式即拒绝，返回 `null`），正常 `rules.json` 不误伤；
  新增 `tests/rules-path.test.mjs` 5 条正反用例。（收口阶段补派修复）
- **D8-L2** `config.json` 内存口径：SPEC 新增 §2.6 —— 整份读进内存再解析（32 MiB 防呆上限）、
  敏感键只跳输出（`[已隐藏]`），标注属设计内并引用 `tests/boundary.test.mjs` 的 5 哨兵零泄漏回归。
- **D8-L3** `skipDirPatterns` 未覆盖 `*cred*` / `*cert*`：保守补目录模式（`*cred*` / `*creds*` / `*cert*` 等），
  `minasCred` / `minasCert` 不再被 readdir 列名，`credits` / `certified` / `secretary` 不误杀。
- **D8-L4** 默认模式在 cwd 累积报告文件：README / SPEC 补累积提示与清理建议（`rm pond-check-*.html`，
  `.gitignore` 已忽略该模式），或用 `--out` 固定输出位置。
- **D8-L5** `windowStale` 的 nextStep 是拼接（会出现「不用动。先看『存活』那栏…」自相矛盾）：改为**替换** ——
  窗口过期时输出「先看『存活』…」专用文案；窗口未过期仍用 `diagnosis.clean` 原话术。
- **D8-L6** 数字关键词边界不排字母（`BV412` / `?aid=412` 被算成风控，假报警方向）：关键词改为独立 token 边界匹配
  （前后不得紧邻字母 / 数字 / 下划线，也不得紧邻 `.` `=` `@` `/` `\` `-`）；`BV412`、`sleep 4121ms`、`1.412.0` 不再误报，
  真 412 / 429 / 401 / 403 与中文紧邻「返回412」仍命中。
- **D8-L9** `docs/CAPABILITIES-SPEC.md` 是零实现的设计稿易被读成「已支持」：顶部加 ⚠️「未实现的设计稿」标注
  （v0.1 不含其中任何能力，是第二期设计基线），README 开发节加带同样标注的指针。
- **D8-L10** 测试债务：10 条弱断言逐条强化（脚注 / HTML 骨架 / 六格键集合 / reasonText / hardHits 等）；
  evaluate S15 阈值期望改读 `src/rules.json`（删硬编码 3600）；5 项环境敏感点留痕（skip 原因 + 诊断）。

## [0.1.0] - 2026-11-07

### Added

**规格与规则（D1）**

- `docs/SPEC.md`（specVersion `D1.3`）：六个指标（存活 / 节律 / 工作量 / 健康 / 依赖 / 漂移）的档位与话术、
  `unknown` 触发条件、「数据不足不许默认正常」的硬规则；只读与凭证边界（三条红线、文件/目录跳过清单、五道闸）；
  探测链 P0–P4 与降级矩阵；预算与超时；16 条测试锚点（T1–T15，含边界用例 T2b）。
- `src/rules.json`（schemaVersion `1`）：阈值、档位 bands、诊断话术模板、健康关键词（5 类 hard + 2 类 soft）、
  依赖 6 项检查、漂移改名表 3 条、预算（日志 256 KiB / 500 行、单指标 3 s、扫描 15 s）、severity 排序。
  实现里的档位一律按 bands 计算，不硬编码判定数字。

**扫描 · 发现（D2）**

- DSH 宿主探测：读 `profiles/*/package.json` 的依赖与 `plugins/` 目录；关键词按整词 / 词首前缀匹配，
  避免把 `dsh-client-ui-deliverables` 这类包名误认成 `live`。
- 通用目录探测：`$DSH_HOME` 一层子目录与 `$HOME` 浅扫，要求「配置 + 日志 + 判重表」三件套齐全；
  认不出就报「认不出」并给出原因，不猜鱼种。
- 发现聚合：两路结果合并、按 kind + 真实路径去重、按「插件 → 宿主 → 独立 → 未识别」排序、降级留痕。

**扫描 · 读取（D3）**

- 日志尾部读取：只按预算读尾部（≤ 256 KiB），不整份读；时间戳支持 ISO / 本地时间 / 中文 / epoch / 仅日期 / Syslog；
  7 类关键词计数（纯数字关键词做边界匹配，`sleep 4121ms` 不算 412）；FIFO、二进制、超长行、半行截断都有专门处理。
- 状态读取：判重表五种形态（JSON 数组 / 容器 / JSONL / 行 / sqlite，sqlite 走 `node:sqlite` 只读 COUNT）；
  配置读版本字段与「字段是否非空」，敏感键连存在性都不输出；依赖探针（ffmpeg 在 PATH、Node 版本、
  窝可写 `access(W_OK)`、磁盘 `statfs`）；凭证新鲜度只 stat mtime，只出天数与数量。
- 读取聚合：日志 / 配置 / 判重表 / 会话目录逐源定位（显式参数 → 发现层证据 → 浅列举 → profile 补齐），
  逐源独立降级，输出 `degraded[]`（indicator / reason / missing）。

**判定（D4）**

- 存活 / 节律 / 工作量：活动时间只取日志、session、判重表的 mtime 与进程启动时间（取最大值），不看 `online` 之类假信号；
  节律按本地自然日分桶；工作量取判重表条目数与今日新增。
- 健康 / 依赖 / 漂移：健康直接消费读取层的关键词计数，按 hard / soft 命中数分档，并给出命中类别的修法；
  依赖 6 项逐条 `pass / warn / fail / unknown` 并附安装或修复命令；漂移比对配置 schema 版本与程序版本、
  检查改名表残留，只报告不修改。
- 聚合：六格结论 + 总评 + 「最该做」一句 + 鱼级分桶（`fishBuckets`）+ 每条鱼最多 3 条修复建议。

**渲染与 CLI（D5）**

- HTML：单文件深色报告，零外链、零脚本、零图片请求；每条鱼一张卡（状态灯 + 六格 + 一句诊断 + 一句下一步）；
  `unknown` 用灰色问号，不冒充绿色。
- 文本：可贴群摘要，列宽自算（CJK / emoji 按 2 列），最多展开 20 条，统计行按全部鱼计数。
- JSON：字段序固定、`evidence` 键排序，同一输入逐字节稳定；含 `schemaVersion` 与
  `meta{generatedAt, pondCheckVersion, scanCount}`；值级脱敏，凭证类路径替换为常量 token。
- CLI：`pond-check`（默认生成 HTML）、`--out`、`--json`、`--text`、`--root`、`--log`、`--dedupe`、`--fish`、`--help`；
  退出码 0 = 正常（扫到 0 条鱼也是 0）/ 2 = 参数用错 / 1 = 真异常；stdout 只输出结果，诊断与警告走 stderr。

**测试与文档（D6）**

- 111 个测试用例（discover / read / evaluate / render / boundary / regression-d6），fixtures 覆盖正常、空、双 profile、未识别四种场景。
- 边界压测覆盖：目录不存在、权限拒绝、空 / 超大 / 二进制 / 非 UTF-8 / 软链成环日志、FIFO、未来 mtime、
  垃圾入参、300 条目录、坏配置，以及「凭证值不出现在任何输出里」。
- `docs/FIELD-NOTES.md`：首次使用走查——三种模式的真实输出、宽度实测、22 项问题清单。
- CI：Node 22 / 24 矩阵，含语法检查、单元测试与零运行时依赖校验。
- `docs/CAPABILITIES-SPEC.md`：能力层（记忆 / 唤醒 / 语音 / 出图）设计稿，标注「待实现」，v0.1.0 不包含实现。

### Changed

- 健康：日志被尾部截断时，改按「窗口实际覆盖了多久」判——覆盖不足 24 小时即判 `unknown(window_truncated)`，
  不再拿半个多小时的干净冒充「最近 24 小时没看到报错」。`evidence.coveredHours` 如实给出覆盖时长。
- 依赖 · 模型线路：配置里一个模型相关键都没有时判 `unknown`（原先判 `fail`）——「这份配置没写」不等于
  「她需要模型且没配」，不是每条鱼都用大模型。
- 依赖 · ffmpeg：缺失降为 `warn`（原先 `fail`）——缺的是能力，不是她坏了；只有明确声明产视频的鱼才 `fail`。
- 依赖 · 登录态新鲜度：白名单凭据文件一个都不存在时判 `unknown`（原先判 `fail`）——「没找到文件」是事实，
  「登录一定坏了」是推断，工具只报事实。
- 工作量：「判重表不存在」与「表在但 0 条」分开处理——前者 `unknown`，后者 `empty`；并补「表在但没有时间戳」的话术变体。
- 鱼级分桶改按关键格：存活与工作量都判不出才算「认不出」；文本统计行、HTML 四灯、卡片样式、行首图标同源。
- `unknown` 话术分两种：没有运行痕迹（可能是界面组件）与有痕迹读不到（建议指窝）；
  用 `--root` / `--log` / `--dedupe` 指过窝仍读不到时，不再重复建议指窝。
- 文本「最该做」改用 `rules.json` 的 `fixShort`，窝路径单独一行原样输出（不截断，可复制）。
- CLI 话术不再建议 `--expect-schema`（该参数不提供）；新增 `--log`、`--dedupe` 两个逃生口。
- 移除「日志已处理计数」作为工作量退路——它需要猜关键词，猜错会误判。
- 测试命令改为免参 `node --test`。

### Fixed

- **`npm install -g` 装出来的 `pond-check` 静默退出 0、一个字都不输出**：入口守卫直接拿 `argv[1]` 与
  `import.meta.url` 比字符串，而 npm 的 bin 是符号链接（argv[1] 是链接、`import.meta.url` 是真实文件），
  判定失败后整条命令什么也不做。改为两边都走 `realpath` 再比；新增 `tests/release.test.mjs`
  用「符号链接」这一真实形态真跑一次，变异回旧代码立刻红。
- `unknown` 灯色的红线只有类名守卫、没有颜色守卫：把 `--unknown` 从灰改成 ok 绿，全部用例照样全绿。
  补颜色层断言（unknown 与 ok 色值必须不同、且不得落在绿色系），改绿立刻红。
- 同名不同 profile 的鱼在文本摘要里渲染成完全相同的两行（名字列压缩时丢掉了 profile）——
  压缩后做冲突检测，优先保住 scope，两行可区分。
- 二进制日志被判「健康 干净」：含 NUL 的日志不可能命中关键词，「0 命中」不等于干净；
  现在直接判 `unknown(binary_content)`，并保留 `hasBinary` 证据。
- 空日志 + 新鲜 mtime 被判「活跃」：0 字节日志不再进入存活证据链（`touch` 或日志轮转也会让 mtime 变新）。
- 读取层的降级证据被判层丢掉：读取层标出的 `{indicator:'health', reason:'binary_content'}` 现在会透传到报告与脚注。
- 权限拒绝时把「读不到」说成「0 条」：三个源都不可读时，相关指标为 `unknown`，工作量不出 0。
- 日志窗口两处缩水：节律只拿到默认 50 行（看不到 7 天）、健康窗口静默缩到 64 KiB——分别改为 500 行与 `rules.json` 的 256 KiB。
- 话术教用户敲不存在的参数（`--log`、`--expect-schema`），以及「照着建议做完、结论不变、建议原样复读」的死循环。
- 超宽行：「最该做」曾达 128 列、命令在窄终端被折断。
- 四格已有结论的鱼被统计成「认不出」，出现「❓ 图标却算作活跃」的自相矛盾。
- CI 红：Node 22 下 `node --test tests/` 会把目录当模块加载而报 `MODULE_NOT_FOUND`；
  语法检查引用了当时尚未产出的 `src/cli.mjs`。
