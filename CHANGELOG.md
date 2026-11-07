# Changelog

本文件记录 pond-check 对外的行为变化，分组沿用 Added / Changed / Fixed。

判定口径与阈值的权威来源是 `docs/SPEC.md` 与 `src/rules.json`；本文件只做汇总与索引，不替代规格。
版本号与 `package.json` 一致。

## Unreleased

暂无变更。

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
