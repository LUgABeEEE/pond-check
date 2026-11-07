# pond-check 判定规格（D1）

- 规格版本：`specVersion = D1.3`
- 机器可读版本：`src/rules.json`（`schemaVersion = 1`）
- 状态：**生效**。D2–D7 的实现、测试、渲染、文档全部以本文 + `src/rules.json` 为准。
- 一句话：这份文档把「鱼况体检」从想法变成**可实现、可测试的契约**。

---

## 0. 这份文档的地位（先读这一段）

1. **唯一真相源**：六个指标怎么算、怎么分档、怎么说话、什么时候报 `unknown`、哪些文件不许碰 —— 只有这里和 `src/rules.json` 说了算。
2. **阈值只有一个来源**：`src/rules.json` 的 `indicators.<id>.thresholds`。实现文件里出现 `3600` / `86400` / `604800` / `22` / `7` 这类判定数字就是缺陷。D3 的测试必须能抓住它（做法：在临时目录里改一份 rules.json 的常量，断言输出档位跟着变）。
3. **本文与 rules.json 冲突时**：以 rules.json 为机器执行真相，并且必须在同一次提交里把本文改对，不许留下两份互相矛盾的规格。
4. **不许自行发明档位**：`rules.json` 里列了哪些 `level`，报告里就只允许出现这些 `level`；多一个都算规格破坏。

---

## 1. 术语

| 术语 | 含义 |
| --- | --- |
| 鱼（fish） | 机器上一个在跑的 AI Agent 实例。例：DSH 的 B 站插件、AstrBot + NapCat 的 QQ 机器人、桌面宠物。 |
| 窝（state root） | 某条鱼自己的数据目录：配置、日志、session 记录、判重表所在之处。 |
| 判重表（dedupe store） | 鱼用来记录「我已经处理过什么」的本地文件（例如已发过的 BVID 列表）。条目数约等于工作量。 |
| 活动信号（activity signal） | **能证明鱼在那个时刻真的干了活**的痕迹：日志写入时间、session 记录时间、判重表变更时间。 |
| 假活动（fake signal） | `online` / `isOnline` / `connected` / `status: "running"` / 心跳时间戳 这类字段。僵尸进程和断线的 websocket 都能把它们报成正常。**本项目一律不用它判定存活。** |
| unknown | 「读不到 / 算不出」的显式结论。**它不是正常，也不是正常的中立写法。** |
| 拐杖测试（fixture） | `tests/fixtures/<场景>/` 下人造的窝目录，用来锁死阈值行为。 |

---

## 2. 只读与安全边界（不可协商）

### 2.1 三条红线

1. **不联网**：不 import `node:http` / `node:https` / `node:net` / `node:dns` / `node:tls`，不发任何请求（包括「检查更新」）。
2. **不读凭证内容**：命中 §2.2 清单的文件**连 `open` 都不做**，文件名也不进任何输出（详见 §2.3）。
3. **不改任何东西**：不写用户目录、不装插件、不改配置、不启停任何鱼进程。唯一允许的执行是 §3.6 的只读版本探测（`ffmpeg -version`、`node --version`），且必须能被 `--no-exec` 关掉。

### 2.2 不读取的文件模式清单（`rules.json.credentials.skipFilePatterns`）

匹配规则：**对文件名做大小写不敏感的通配符匹配**（`*` 任意长度，`?` 单字符）。命中即跳过，不 stat 内容、不 open。

| 类别 | 模式 | 说明 |
| --- | --- | --- |
| 显式命名 | `*credential*` `*credential*.*` `*cred*` `*secret*` `*secrets*` `secrets.*` | 名字自己承认了 |
| 环境变量 | `.env` `.env.*` `*.env` `*.env.*` `env.local` `env.*.local` | 常在 `.env.local` |
| Cookie / 会话 | `*cookie*` `cookie*.txt` `*cookies.json` `*session*` `*.session` `*session.token` `*_session.json` | B 站 / QQ 登录态 |
| Token / 授权 | `*token*` `*.token` `*tokens*` `*auth*` `auth.json` `*.auth` `*oauth*` `*oauth2*` `*bearer*` | 含 `authorization` 头的缓存 |
| 口令 | `*password*` `*passwd*` `*pwd.json` `.netrc` `.htpasswd` `.npmrc` `.pypirc` `.git-credentials` | 打包机 / 镜像源口令 |
| 私钥 / 证书 | `*.pem` `*.key` `*.p8` `*.p12` `*.pfx` `*.jks` `*.keystore` `id_rsa*` `id_ed25519*` `id_ecdsa*` `id_dsa*` `*.ppk` `authorized_keys` `known_hosts` | SSH / 签名 |
| 密钥库 | `*.kdbx` `*keychain*` `*keyring*` `*credential-store*` `secrets.kdbx` | 系统钥匙串导出 |
| 协议账号 | `*onebot11*` `*account*.json` `*login*.json` `*qq*account*` | NapCat / OneBot 的 token 与 QQ 号 |
| 云凭据 | `*.aws/credentials` `gcloud/application_default_credentials.json` `*service-account*.json` `*.azure/*` `*terraform.tfstate*` | 云厂商凭据 |

### 2.3 不读取的**目录**模式（`rules.json.credentials.skipDirPatterns`）

命中目录**不再向下遍历**（避免一次 readdir 就把里面的文件名带出来）：

`.ssh` `.gnupg` `.git` `.aws` `.config/gcloud` `.config/gh` `.docker` `.password-store` `keyrings` `.pki` `.local/share/keyrings` `secrets` `.npm/_authToken` 所在层 `node_modules`（性能 + 无关） `.cache`（除非该指标的 sourceOrder 明确点名某个子路径）

### 2.4 「连文件名都不进结果」怎么落地（五道闸）

1. **路径闸**：路径在进入任何数据结构**之前**，先过 `classifyPath()`。命中 §2.2/§2.3 → 立刻替换成常量 `SENSITIVE_PATH_TOKEN`（`"[凭证文件已跳过]"`），原始字符串不进入任何对象、任何 `Error` message、任何 `console.debug`。
2. **不 stat 内容、不 open**：跳过判定只看**文件名/目录名**，不看内容。判定为跳过之后，连 `stat` 都不做（mtime 也不拿，避免「最近更新」侧面泄露存在性）。
   - 例外且唯一例外：`deps.credentialFreshness` 检查按 §4.5 的**已知路径白名单**取 mtime —— 它只允许返回**聚合天数**，永不返回路径或文件名。
3. **计数只许聚合**：报告里最多出现一行 `已跳过 N 个凭证类文件（不显示名称）`。不许出现路径列表、不许出现「哪个目录里有几个」。
4. **值级脱敏（第二道防线）**：任何被读进内存的配置对象，在进入输出前递归剥离 key 名命中 `credentials.valueRedactionKeys`（`apikey` `api_key` `secret` `token` `password` `passwd` `cookie` `authorization` `bearer` `credential` `private_key` `access_key`）的字段 —— 值替换为 `"[已隐藏]"`。这是防线不是许可证：**命中 §2.2 的文件仍然整份不读**。
5. **测试闸**：D3 必须有一条硬用例 —— 在 fixture 里放 `bilibili_cookie.json`、`.env.local`、`id_ed25519`，断言 `--json` / `--text` / HTML 三种输出里**都不出现这些字符串**（连子串都不许），只允许出现 `SENSITIVE_PATH_TOKEN` 与聚合计数。

### 2.5 为什么这条比功能重要

用户把 B 站 cookie、QQ token、模型 API key 放在同一个目录里。一个「体检工具」如果把路径打印出来，就等于在群里、在截图里、在 issue 里把这些东西的位置交出去。**报告是可以公开的，凭证的位置不可以。**

---

## 3. 数据源：探测顺序与降级策略

### 3.1 总原则

- **先发现鱼，再读鱼的窝。** 先有「谁在跑」，再去每个窝里取数。
- **每一层都有退路。** 任何一层失败只降级该指标，不整体失败。
- **降级必须留痕。** 降级不是静默的：`evidence.degraded` 记录 `{indicator, reason, missing[]}`，报告脚注里出现「N 项数据读不到」。
- **永不默认正常。** 见 §5。

### 3.2 探测链（严格按序，命中即止）

```
P0  CLI 显式指定      --root <dir> / --fish <name> / --log <file> / --dedupe <file>
       ↓ 未指定
P1  进程表            Linux: /proc/<pid>/{cmdline,cwd,exe,stat}
                      macOS: ps -eo pid,ppid,lstart,command（只读，一次调用）
                      Windows: v0.1 不支持 → 见 §3.5
       ↓ 进程表读不到（权限/平台）
P2  已知窝目录扫描     规则见 discovery.kinds[*].stateCandidates，逐个 stat，存在即用
       ↓ 也没有
P3  用户家目录浅扫     $HOME 下深度 <= 2，只找 kinds 指纹命名的目录
       ↓ 也没有
P4  报「没找到鱼」     一行结论 + 一行「你现在该做什么」（不是空报告，也不是 unknown 堆砌）
```

**关键行为（必须实现）：**

- **P1 与 P2 的结果要合并，不能二选一。** 「进程在跑但窝不在」和「窝在但进程没跑」都是真实现象，都要各自报出来：
  - 进程在、窝不在 → 这条鱼是**黑盒鱼**：`liveness` 只能用进程启动时间（`/proc/<pid>/stat` 第 22 字段算 uptime）+ 工作目录里最新 mtime；`rhythm` / `throughput` / `drift` = `unknown`。
  - 窝在、进程不在 → **有窝没鱼**：`liveness` 仍按 §4.1 的 mtime 判档，`diagnosis` 走 `processCold` 变体（文案见 §4.1 注），报告里明写「没在跑」。
- **同一窝多进程**（例如 AstrBot 主进程 + NapCat 子进程）：按 `kind` 合并成一条鱼，`liveness` 取**最新**活动时间，`health` 合并两类日志，`evidence.processes[]` 列出全部 pid。
- **去重键**：`kind + 真实路径（realpath 后）+ 端口`。同一个窝被 P1/P2 各发现一次只报一次。

### 3.3 降级矩阵（每个指标读不到时的退路）

| 指标 | 首选源（sourceOrder[0]） | 退路 1 | 退路 2 | 全都没有 |
| --- | --- | --- | --- | --- |
| liveness | 日志文件 mtime | session 记录 mtime | 判重表 mtime / 进程启动时间 | `unknown`，`missing:["log","session","dedupe"]` |
| rhythm | 日志行内时间戳按自然日分桶 | session 文件首末时间戳分桶 | 判重表条目日期分桶 | `unknown`，`missing:["timestamps"]` |
| throughput | 判重表条目数 | sqlite 判重表（`node:sqlite` 可用时 `SELECT COUNT(*)`） | — | `unknown`，`missing:["dedupe"]` |
| health | 日志尾部 24h 窗口 | 无时间戳则尾部 N 行（标 `windowApproximated:true`） | 进程 stderr 落盘文件 | `unknown`，`missing:["log"]` |
| deps | 逐项探测（见 §4.5） | 从日志里猜（如 `ffmpeg: command not found`） | — | 单项 `unknown`，全 `unknown` → 指标 `unknown` |
| drift | 配置里的 `schemaVersion` | 配置里的 `version` / 目录内插件 `package.json` | 字段改名表反推（旧字段存在 + 新字段缺失） | `unknown`，`missing:["schemaVersion"]` |

### 3.4 预算与超时（防止体检把机器拖慢）

| 约束 | 值 | 超时后的行为 |
| --- | --- | --- |
| 单文件最多读 | `tailBytes = 262144`（256 KiB） | 只保留尾部，`truncated:true` |
| 单日志最多扫 | `tailLines = 500` 行 | 停在 500 行 |
| 判重表最多数 | `maxEntriesCounted = 100000` 条 | 超限后 `totalEntriesEstimated:true`，按「>=100000」说话 |
| 单指标总耗时 | `indicatorTimeoutMs = 3000` | 该指标 `unknown`，`reason:"timeout"` |
| 全量扫描 | `scanTimeoutMs = 15000` | 其余鱼照报，未完成的那条标 `unknown` + `reason:"timeout"` |
| 目录条目上限 | `maxDirEntries = 5000` | 截断并留痕 |

### 3.5 平台矩阵

| 平台 | v0.1 行为 |
| --- | --- |
| Linux | 全量支持（`/proc` 可用） |
| macOS | `liveness` / `rhythm` / `throughput` / `health` / `deps` / `drift` 支持；进程启动时间用 `ps -eo lstart`；`/proc` 相关能力缺失时按 §3.3 降级 |
| Windows | **明确报 `unsupported`**：一行「本版本不扫 Windows」+ 一行「你现在该做什么（用 WSL 或等 v0.2）」。**不许**输出空报告假称健康。 |

### 3.6 允许执行的只读外部命令（白名单，闭集）

| 命令 | 用途 | 超时 | 关闭方式 |
| --- | --- | --- | --- |
| `ps -eo pid,ppid,lstart,command` | 仅 macOS 的进程表 | 2s | (无) |
| `ffmpeg -version` | 取版本号 | 1s | `--no-exec` 后改用 PATH 查找（只能判「在不在」，版本 `unknown`） |
| `node --version` | 取版本号 | 1s | 同上 |
| `<pid 的 exe> --version` | 探测鱼自己的运行时版本 | 1s | 同上 |
| `git --version` | 仅当某鱼 kind 需要 | 1s | 同上 |

**白名单之外一律 `spawn` 禁止。** 不许 `sh -c`、不许管道、不许重定向写文件。

---

## 4. 六指标定义与阈值表

每个指标在 `rules.json` 里的形状是固定的：

```json
{
  "id": "...", "nameZh": "...", "question": "...（这条指标到底在回答什么）",
  "forbiddenSignals": ["..."],
  "sources": ["..."], "sourceOrder": ["..."],
  "thresholds": { "metric": "...", "constants": {...}, "bands": [ { "level": "...", "allOf": [ {"metric":"...","op":"lt|lte|gt|gte|eq","value|valueRef":"..."} ] } ] },
  "diagnosis": { "<level>": { "severity": "ok|watch|bad|unknown", "phenomenon": "...", "nextStep": "...", "vars": ["..."] } },
  "unknownWhen": ["..."]
}
```

**判定算法（唯一实现口径）**：

1. **先算得出来，再分档**：主指标（`thresholds.metric`）或 `allOf` 里任一 `metric` 为 `null` / `NaN` / 缺失 → **直接 `unknown`，不进 bands**。这一条决定了「读不到」永远不会被误判成某个正常档。
2. `bands` 是**有序数组**，从头逐条检查，`allOf` 全部成立即命中，命中即停，**先命中者赢**。
3. `op` 只有 `lt/lte/gt/gte/eq` 五个；`valueRef` 指向同指标 `constants` 里的键，`value` 是字面量。两者必须二选一，写了 `valueRef` 指向不存在的键 = 规格缺陷，实现必须抛错。
4. **值可算但一条 band 都没命中 = 规格破洞**，实现必须抛错（**不是返回 `ok`**）。每个指标的 bands 都已经配了兜底条（liveness 的 `dead`、rhythm 的 `stopped`、throughput 的 `quiet`、health 的 `clean`、deps 的 `ready`、drift 的 `aligned`），出现「没命中」说明实现算错了指标名或漏传了 metric。

**话术模板**：`phenomenon` / `nextStep` 里允许 `{var}` 占位，变量名必须在同条 `vars` 里声明，实现必须用 evidence 填满。**留着未替换的 `{var}` 出现在报告里 = 缺陷**，D3 要有断言。

---

### 4.1 liveness · 存活

> **问题**：这条鱼最后一次**真的动了**是什么时候？

- **绝不使用的信号**（`forbiddenSignals`）：`online` / `isOnline` / `connected` / `status` / `state` / `alive` / `heartbeat` / `lastPing` / websocket readyState。理由：僵尸进程、假心跳、断线未重连的 bot 都能把它们说成「正常」。
- **使用的信号**（`sourceOrder`，取**最大**的那个时间）：`log_mtime` → `session_mtime` → `dedupe_mtime` → `process_start`。
  - 显式排除：配置文件 mtime（改配置≠干活）、目录 mtime（可能是别人 cd 进去过）。
  - 未来时间戳（clock skew）：超过 `futureSkewToleranceSec = 120` 视为时钟异常，该源作废并留痕 `clockSkew:true`；不足容差则按 0 计。
  - 源时间戳为 `0` / epoch 1970 → 该源无效，跳过。

| level | 条件（ageSec = 现在 − 最后活动） | severity |
| --- | --- | --- |
| `active` 活跃 | `ageSec < 3600`（1 小时内） | ok |
| `slack` 疲软 | `3600 <= ageSec < 86400`（1–24 小时） | watch |
| `dormant` 疑似休眠 | `86400 <= ageSec < 604800`（1–7 天） | watch |
| `dead` 死了 | `ageSec >= 604800`（7 天以上） | bad |
| `unknown` | §3.3 全部源都读不到 / `sourceOrder` 全失效 | unknown |

**常量**：`activeMaxSec=3600`、`slackMaxSec=86400`、`dormantMaxSec=604800`、`futureSkewToleranceSec=120`。

**现象 / 下一步：**

| level | 现象描述（给养鱼的人看） | 下一步做什么 |
| --- | --- | --- |
| active | 她 {ageHuman} 前还在动，是活的。 | 不用管，继续养。 |
| slack | 她今天醒过，但已经 {ageHuman} 没动静了，比平时安静。 | 先等到今天收工再看一眼；如果明天还是这么安静，去看「健康」那栏有没有报错。 |
| dormant | 她已经 {ageDays} 天没动过了 —— 可能在休息，也可能卡住了。 | 打开她的日志看最后一行是什么时候；然后重启一次再观察半天，还不动就查「依赖」那栏缺什么。 |
| dead | 她从 {ageDays} 天前就没再动过，基本可以认定停了。 | 先看进程还在不在：不在就按她的启动命令拉起来；还在就翻日志最后的报错，十有八九是登录过期或依赖缺失。 |
| unknown | 读不到她任何活动记录，**判不出死活**（不是正常）。 | 指明她的窝：`pond-check --fish <名字> --root <她的目录>`；或者告诉体检她的日志放在哪个位置。 |

**`processCold` 变体**（窝在、进程不在）：`phenomenon` 追加一句「而且进程不在 —— 现在没有任何进程在跑她。」，`nextStep` 改为「按启动命令拉起来：{startHint}（从配置里读出来的启动方式，读不到就写『用你平时启动她的那条命令』）。」

---

### 4.2 rhythm · 节律

> **问题**：近 7 天她是不是每天都会醒？还是三天打鱼两天晒网？

- **定义「一次唤醒」**（`wakeDefinition`）：某个**自然日**（本地时区，00:00 分界）内出现 **>= 1 条**带时间戳的活动记录。可用记录：日志行时间戳、session 文件首/末时间戳、判重表条目的处理时间。
- `dailyCounts` = 长度 7 的数组，最后一位是今天；`activeDaysInWindow` = `dailyCounts` 中 `> 0` 的天数。
- 判定主指标：`activeDaysInWindow`。展示附加指标：`avgPerDay`、`maxPerDay`、`todayCount`。

| level | 条件 | severity |
| --- | --- | --- |
| `steady` 规律 | `activeDaysInWindow >= 5` | ok |
| `drifting` 散架 | `3 <= activeDaysInWindow < 5` | watch |
| `sparse` 偶尔回魂 | `1 <= activeDaysInWindow < 3` | bad |
| `stopped` 全停 | `activeDaysInWindow == 0` | bad |
| `unknown` | 一个可用的按天时间戳都没有（`missing:["timestamps"]`） | unknown |

**常量**：`windowDays=7`、`steadyMinActiveDays=5`、`driftingMinActiveDays=3`、`sparseMinActiveDays=1`。

| level | 现象 | 下一步 |
| --- | --- | --- |
| steady | 近 7 天有 {activeDays} 天醒来，平均每天 {avgPerDay} 次，作息是稳的。 | 保持现状，不用动。 |
| drifting | 近 7 天只有 {activeDays} 天醒来过，节律开始散了。 | 先想一下是不是你自己手动开她的次数少了；如果是自动跑的，去看定时任务/常驻进程还在不在（`crontab -l`、`systemctl --user list-timers`）。 |
| sparse | 近 7 天只醒了 {activeDays} 天，基本是在偶尔挣扎一下。 | 当成「快停了」处理：先看「存活」「健康」两栏，再看「依赖」第一项（ffmpeg）是不是缺了。 |
| stopped | 近 7 天一次都没醒。 | 先看「存活」那栏：它要是也判 `dead`，就当已经停了，按启动命令拉起来。 |
| unknown | 没有一条带时间戳的记录，算不出节律（不是规律）。 | 让她的日志按天切割（大多数 bot 框架都有这个开关），或者保留 session 文件别清；有按天记录体检才数得出来。 |

---

### 4.3 throughput · 工作量

> **裁定（2026-11-07）**：判重表「不存在」和「存在但空」是两件不同的事。
> 不存在 = 读不到 = `unknown`；存在但 0 条 = 事实 = `empty`。
> 早期版本把两者都归为 `empty`，会把「这只鱼根本没有账本」误报成「她一次都没干活」。
> 另：日志里「已处理」类计数这条退路**已删除** —— 它需要猜关键词，而猜出来的关键词会误判。


> **问题**：她到底干了多少活？今天有没有干？

- 主数据：**判重表**（`dedupe store`）。
  - 格式识别：`*.json`（数组或 `{items:[]}`）、`*.jsonl`（一行一条）、`*.txt`/`*.list`（一行一条）、`*.db`/`*.sqlite`（`SQLite format 3\0` 魔数 → 只读 count，见下）。
  - `totalEntries`：条目总数（上限 `maxEntriesCounted=100000`，超限标 `totalEntriesEstimated:true`）。
  - `todayNew`：`processedAt / ts / time / created_at / date` 字段落在今天的条目数；没有时间字段 → 用**文件 mtime == 今天** 且无法细分时退化为 `todayNew` = `unknown`（不猜）。
  - `daysSinceLastNew`：从「最近一条带日期的条目」或「判重表最后写入日」算起。
  - sqlite：`node:sqlite` 可用则 `SELECT COUNT(*)`（只读、`readonly:true`）；不可用则**只取 mtime + size**，`totalEntries = unknown`，`reason:"sqlite_no_driver"`。

| level | 条件 | severity |
| --- | --- | --- |
| `empty` 空账本 | `totalEntries == 0`（**表在、但一条都没有** —— 这是事实） | bad |
| `productive` 在干活 | `todayNew >= 1` | ok |
| `stalled` 停摆 | `daysSinceLastNew >= 3` | bad |
| `quiet` 今天歇着 | 其余情况（`totalEntries > 0` 且 `todayNew == 0` 且 `daysSinceLastNew < 3`） | watch |
| `unknown` | 判重表**找不到**（`missing:["dedupe"]`），或表在但没有时间戳（见 `variants.noTimestamps`） | unknown |

**常量**：`stalledAfterDays=3`、`productiveTodayMin=1`、`sampleWindowDays=7`、`maxEntriesCounted=100000`。

| level | 现象 | 下一步 |
| --- | --- | --- |
| productive | 今天新处理了 {todayNew} 条，累计 {totalEntries} 条。 | 不用动，她正常在出货。 |
| quiet | 今天还没新增，累计 {totalEntries} 条 —— 可能今天本来就没活，也可能卡住了。 | 先看「存活」「健康」：两栏都正常就只是今天没内容；「健康」报了错那就是卡住了，按那栏的提示处理。 |
| stalled | 已经 {daysSinceLastNew} 天没有新增了，判重表停在第 {totalEntries} 条。 | 翻日志最后 20 行：最常见就两种 —— 登录失效（412/验证码）或源站根本没更新。前者按「健康」那栏重新登录。 |
| empty | 判重表是空的，或者压根没有 —— 她可能一次都没成功干过活。 | 先查「依赖」那栏（ffmpeg 在不在、登录有没有配），然后手动触发一次，看第一条记录能不能写进去。 |
| unknown | 找不到判重表，也不知道她干了多少（不是「干得挺好」）。 | 指明她的数据目录：`--root <她的目录>`；如果这鱼本来就不落账，那工作量只能长期是 `unknown`，报告会照实写。 |

---

### 4.4 health · 健康

> **问题**：她最近有没有在骂人？骂的是什么？

- 扫描窗口：`windowHours=24`，只看日志尾部 `tailBytes=262144`、`tailLines=500`。
- 每个日志行按 `categories[*].keywords` 做**大小写不敏感的包含匹配**（中文原样匹配）。一行命中多个类别各计一次。
- 类别分两档：`hard`（这条鱼现在发不出东西）与 `soft`（吵，但还在转）。

**类别与关键词（`rules.json.indicators.health.thresholds.categories`）**

| 类别 | 档 | 关键词（任一命中即计一次） |
| --- | --- | --- |
| `loginExpired` 登录失效 | hard | `登录失效` `未登录` `登录过期` `请重新登录` `登录状态失效` `cookie 失效` `cookie过期` `token expired` `401` `unauthorized` `invalid csrf` |
| `riskControl` 风控/412 | hard | `412` `Precondition Failed` `请求被拦截` `风控` `-412` `403` `Forbidden` `access denied` |
| `rateLimited` 限流/429 | hard | `429` `Too Many Requests` `rate limit` `请求过于频繁` `操作频繁` |
| `captcha` 验证码 | hard | `验证码` `captcha` `geetest` `滑块` `极验` `人机验证` |
| `breaker` 熔断 | hard | `熔断` `circuit breaker` `circuit open` `已冷却` `cooldown` `暂停发送` `too many failures` |
| `runtimeError` 运行报错 | soft | `error` `ERROR` `Error:` `Traceback` `Exception` `Unhandled` `panic` `FATAL` `致命` |
| `ioError` 系统报错 | soft | `ENOENT` `EACCES` `EPERM` `ECONNREFUSED` `ETIMEDOUT` `No such file` `permission denied` `磁盘` `disk full` |

| level | 条件（`hardHits` / `softHits`） | severity |
| --- | --- | --- |
| `critical` 已经挂了 | `hardHits >= 3` | bad |
| `sick` 有病 | `hardHits >= 1` 或 `softHits >= 3` | bad |
| `noisy` 有点吵 | `softHits >= 1` | watch |
| `clean` 干净 | `hardHits == 0 && softHits == 0` | ok |
| `unknown` | 没有日志可读（`missing:["log"]`），或日志尾部全无可用行 | unknown |

**常量**：`windowHours=24`、`tailBytes=262144`、`tailLines=500`、`sickHardHits=1`、`criticalHardHits=3`、`noisySoftHits=1`、`sickSoftHits=3`。
**无时间戳退化**：日志行里没有可解析时间戳时，用尾部 N 行代替窗口，`windowApproximated:true`，报告里必须写「按最后 N 行估算」。

| level | 现象 | 下一步 |
| --- | --- | --- |
| clean | 最近 24 小时日志里没看到报错。 | 不用动。 |
| noisy | 最近 24 小时有 {softHits} 条小报错（{topCategory} 为主），但还在转。 | 可以先不管；如果同一句话反复刷，把那一行原样发出来再查。 |
| sick | 日志里在报警：{topCategoryZh} 命中 {hardHits} 次。她现在发的每一条大概率都失败了。 | 按类别处理：风控/412 → 换 cookie 并把请求间隔调大；429 → 调大间隔或减少并发；验证码 → 得人工登录一次；其他报错 → 看报错下面那几行 traceback。 |
| critical | 已经明确挂了：{topCategoryZh} 命中 {hardHits} 次，她现在什么都发不出去。 | 现在就去重新登录并保存新的登录态，然后重启她；重启后盯 10 分钟日志，还在刷同一句就把日志贴出来。 |
| unknown | 读不到日志，健康状况未知（不是健康）。 | 用 `--log <她的日志文件>` 指定日志位置，或 `--root <她的安装目录>` 让她自己找；找不到日志的鱼，健康分永远是 `unknown`。 |

---

### 4.5 deps · 依赖

> **问题**：她要是跑不起来，缺的是哪一样？

六项检查，每项独立出结论，最后取最差。

| check id | 检查什么 | 判定 | 不通过时的下一步（人话+命令） |
| --- | --- | --- | --- |
| `ffmpeg` | `ffmpeg` 在 PATH 上（视频类鱼硬依赖） | 找到且可执行 → pass；找不到 → **fail**（若该 kind 不产视频 → warn） | `apt install ffmpeg`（Debian/Ubuntu）/ `brew install ffmpeg`（macOS）；装完 `ffmpeg -version` 验证。 |
| `nodeRuntime` | 她跑的 Node 主版本 `>= 22` | `major >= 22` → pass；`major < 22` → **fail**；版本取不到 → warn(`versionUnknown`) | 用 nvm 切到 22+：`nvm install 22 && nvm use 22`，然后重启她。 |
| `credentialFreshness` | 已知凭证文件的 mtime 距今天数（**只取天数，不取路径**） | `< 30` 天 → pass；`30–60` → warn；`> 60` 或文件不存在 → fail | 登录态大概率过期了：重新登录一次，把新的 cookie/token 存回原处，再重启她。 |
| `homeWritable` | 她的窝可写（`access(W_OK)`，**不写入任何字节**） | 可写 → pass；不可写 → **fail** | 目录权限不对：`chmod u+w <她的目录>`，或用 `sudo chown $(whoami) <她的目录>` 把属主改回自己。 |
| `modelLine` | 模型线路已配（配置里 `model` / `provider` / `baseUrl` 至少一个非空；**只看字段存在与否，值不落结果**） | 有 → pass；全空/全缺 → **fail** | 在配置里填上模型线路（provider/apiBase/model 三项），或用她的登录命令重新授权。 |
| `diskSpace` | 窝所在分区剩余空间 | `>= 1 GiB` → pass；`200 MiB–1 GiB` → warn；`< 200 MiB` → **fail** | 清空间：先清 `logs/` 里 7 天前的旧日志和 `tmp/` 缓存，别删判重表。 |

| level | 条件 | severity |
| --- | --- | --- |
| `broken` 坏了 | 任一项 `fail` | bad |
| `warn` 有隐患 | 无 `fail`，任一 `warn` | watch |
| `unknown` 查不出 | 无 `fail` 无 `warn`，但有任一项探不出结论（`unknownCount >= 1`） | unknown |
| `ready` 齐了 | 六项全部 `pass`（`unknownCount == 0`） | ok |

> 判定顺序就是上表顺序：`broken` → `warn` → `unknown` → `ready`。**「查不出」不能算 `pass`** —— 有一项查不出就是 `unknown`，不是 `ready`。

**常量**：`nodeMinMajor=22`、`credentialStaleWarnDays=30`、`credentialStaleFailDays=60`、`diskWarnFreeBytes=1073741824`、`diskFailFreeBytes=209715200`、`checksRequired=6`。

| level | 现象 | 下一步 |
| --- | --- | --- |
| ready | 依赖齐全：ffmpeg、Node、登录态、窝可写、模型线路、磁盘都正常。 | 不用动。她要是还不干活，那就是「健康」或「工作量」那栏的问题。 |
| warn | 有 {warnCount} 项需要留意：{failedChecksZh}。现在还能跑，但迟早绊到。 | 按下面每条给的办法补：{fixHint} |
| broken | 有 {failCount} 项已经坏了：{failedChecksZh}。她现在跑不起来，或者跑起来也白跑。 | 照着补，一条一条来：{fixHint} 补完再体检一次确认。 |
| unknown | 有 {unknownCount} 项查不出来（缺路径或没权限），不能当成正常。 | 先定位她的窝：`--root <她的目录>`；窝找到了，这六项大多就能查。 |

**报告形状**：`deps` 必须逐项列出 `{id, nameZh, status: pass|warn|fail|unknown, detail, fix}` —— 只给总分没用，用户要的是「缺哪一样、怎么补」。

---

### 4.6 drift · 漂移

> **问题**：配置和程序还是不是一套的？升级/改名之后有没有谁没跟上？

- 取配置里的版本字段：`schemaVersion` → `schema_version` → `configVersion` → `version`（按序取第一个存在的）。
- 取插件/程序版本：窝内 `package.json.version`；取不到 → `programVersion = unknown`（不阻断判定）。
- 字段改名表（`renames`）：`{from, to, since}`。判定：**旧字段存在 且 新字段不存在** → 计一次 `staleFieldHits`。

| level | 条件 | severity |
| --- | --- | --- |
| `drifted` 落后 | `staleFieldHits >= 1`，或 `configSchemaVersion < 2` | bad |
| `mismatch` 对不上 | `configSchemaVersion > 3`（配置比程序新） | bad |
| `aligned` 对齐 | `2 <= configSchemaVersion <= 3` 且 `staleFieldHits == 0` | ok |
| `unknown` | 配置里四个版本字段一个都没有（`missing:["schemaVersion"]`） | unknown |

**常量**：`minSupportedSchemaVersion=2`、`expectedSchemaVersion=3`、`staleFieldFailHits=1`、`versionFieldNames=[...]`、`renames=[{"from":"cookiePath","to":"credentials.cookieFile","since":2},{"from":"interval","to":"postIntervalSec","since":2},{"from":"targets","to":"subscriptions","since":3}]`。

| level | 现象 | 下一步 |
| --- | --- | --- |
| aligned | 配置版本 v{configSchemaVersion} 和程序对得上，没有旧字段。 | 不用动。 |
| drifted | 配置还是旧格式（v{configSchemaVersion}，程序要 v{expectedSchemaVersion}），有 {staleFieldHits} 个字段已经被改名了。 | 备份配置后跑一次她的迁移命令（或按 `renames` 表手动改名 `{firstStaleField}` → 新名字），改完重启她。 |
| mismatch | 配置比程序新（配置 v{configSchemaVersion} > 程序支持的 v{expectedSchemaVersion}）—— 你升过配置但没升程序。 | 把程序升到配套版本；不能升就把配置回滚到上一份备份，二选一。 |
| unknown | 这份配置里没有版本号，判断不了漂没漂（不是「没漂」）。 | 在配置里加一行 `schemaVersion`，或者用 `--expect-schema 3` 告诉体检你期望的版本。 |

---

## 5. `unknown` 规则与「假健康」禁令（本项目最高优先级）

### 5.1 硬规则

1. **数据不足时不默认正常 —— `unknown` 不是正常。**
   任何指标数据不足 → 必须输出 `unknown`（不是 `clean`、不是 `ready`、不是跳过、不是绿色），并且**必须**在 `evidence.missing` 里列出缺什么（机器读）+ 在 `phenomenon` 里说人话（人读）+ 在 `nextStep` 里说「补什么才能判得出来」。
   反过来也成立：**绝不默认正常** —— 没有一个指标的默认值是 `ok`；`rules.json` 的 `policy.neverDefaultToOk = true` 就是这个约束的机器表达。
2. **`unknown` 不参与「正常」统计。** 总评里 `unknown` 单独计数；`--json` 里 `summary.unknown` 独立字段；HTML 里 `unknown` 用与 `ok` **不同的颜色**（灰色，不是绿色）。
3. **不许把 `unknown` 折叠成上一个状态。** 没有「默认 ok」的 fallback，没有 `catch { return 'ok' }`，没有 `|| 'ok'`。D3 必须有断言：fixture 里把日志删掉 → `health.level === 'unknown'`（不是 `clean`）。
4. **不许用假活动信号救场。** `liveness` 的 `forbiddenSignals` 里任何字段都不许参与判定；即使配置里有 `online: true` 也只能进 `evidence` 的展示区，不能改 level。
5. **不许凭「进程还在」就判活着。** 进程在只是「没死透」，`liveness` 只看活动时间；进程状态进 `evidence.processAlive`，只影响文案变体（§4.1 `processCold`）。
6. **降级要可见。** `evidence.degraded[]` 非空时，报告脚注必须出现一行「N 项数据读不到（{indicators}），这些项目不能当作正常。」
7. **「没找到鱼」也要给下一步。** P4 空结果不是报告结束，是「你现在该做什么」的开始（见 §3.2 P4）。

### 5.2 各指标的 `unknownWhen`（机器可读版在 `rules.json`）

| 指标 | 触发 `unknown` 的条件 |
| --- | --- |
| liveness | 所有 sourceOrder 源都不存在 / 全部无效（未来时间、epoch 0）/ 全部超时 |
| rhythm | 没有任何带可解析时间戳的记录 |
| throughput | 判重表不存在 / 表在但无时间戳 / sqlite 无驱动且无法数行 |
| health | 没有日志文件 / 日志尾部无可读行 / 读取被权限拒绝 |
| deps | 有任一项检查探不出结论（`unknownCount >= 1`）且无 `fail`/`warn` / 定位不到窝 |
| drift | 四个版本字段一个都没有 |

---

## 6. 报告组装约束（给 D4/D5 的硬要求）

### 6.1 一页 = 每条鱼一段，每段必须能回答三个问题

每条鱼必须有：**是谁**（kind + 窝的显示名，**不含凭证路径**）、**六格状态**、**一行「所以现在该做什么」**。

```
🐟 DSH · bilibili 插件        <窝的显示名>
   存活 活跃  ·  节律 规律  ·  工作量 今天 3 条  ·  健康 干净  ·  依赖 齐了  ·  漂移 对齐
   → 不用管，继续养。
```

- 顶部总评：`N 条鱼 · X 正常 · Y 要注意 · Z 坏了 · W 判不出`
- **`W > 0` 时总评里必须有一句：「W 项判不出来 —— 这些不是正常，是没看到。」**
- 排序：`bad`（`dead`/`empty`/`critical`/`broken`/`drifted`）→ `unknown` → `watch` → `ok`。**坏的排最上面。**
- 每条鱼的 `fixes[]`：把六格里的 `nextStep` 去重合并成按优先级排的可执行清单，最多 3 条 —— 用户不会读完 6 段。

### 6.2 `--json` 形状（下游只依赖这个）

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-07T10:00:00.000Z",
  "host": { "platform": "linux", "node": "22.11.0" },
  "fish": [{
    "id": "dsh-bilibili@/home/u/.dsh",
    "kind": "dsh",
    "name": "DSH · bilibili 插件",
    "stateRoot": "/home/u/.dsh",
    "processes": [{ "pid": 1234, "alive": true, "startedAtSec": 1699300000 }],
    "indicators": {
      "liveness":  { "level": "active", "severity": "ok", "value": 720, "unit": "sec", "evidence": {}, "phenomenon": "...", "nextStep": "..." },
      "rhythm":    { "...": "同上" },
      "throughput":{ "...": "同上" },
      "health":    { "...": "同上" },
      "deps":      { "...": "同上" },
      "drift":     { "...": "同上" }
    },
    "fixes": ["..."],
    "degraded": [{ "indicator": "rhythm", "reason": "no_timestamps", "missing": ["timestamps"] }]
  }],
  "summary": { "fish": 1, "ok": 5, "watch": 1, "bad": 0, "unknown": 0 },
  "skippedSensitive": { "count": 2, "names": "[凭证文件已跳过]" }
}
```

约束：`indicators` 必须**恰好**是这六个键；每个必须是 `rules.json` 里声明过的 `level`；`severity` 必须与该 level 在 rules.json 中登记的 severity 一致（D3 断言）。

---

## 7. 给 D3 的测试锚点（每条都是一个 fixture 目录）

| # | 场景 | 断言 |
| --- | --- | --- |
| T1 | 日志 10 分钟前写过 | `liveness.level == "active"` |
| T2 | 日志 2 小时前写过（以及 23 小时） | `liveness.level == "slack"` |
| T2b | 日志 25 小时前写过（刚跨过 24h） | `liveness.level == "dormant"`（时钟边界必须测，别在 86400 上写 `<=`） |
| T3 | 日志 3 天前 / 10 天前 | `dormant` / `dead` |
| T4 | 配置里 `online: true` 但日志 10 天前 | 仍然 `dead`（不许被假信号救） |
| T5 | 日志全删了 | `health.level == "unknown"`（不是 `clean`） |
| T6 | 判重表 0 条 / 今天 +3 条 / 停在 5 天前 | `empty` / `productive` / `stalled` |
| T7 | 日志尾部含 3 条 `412` | `health.level == "critical"` |
| T8 | 日志含 1 条 `Traceback` | `noisy` |
| T9 | 缺 ffmpeg（PATH 置空） | `deps.level == "broken"` 且 `checks[ffmpeg].status == "fail"` |
| T10 | 配置 `schemaVersion: 1` / 含旧字段 `cookiePath` / 无版本字段 | `drifted` / `drifted` / `unknown` |
| T11 | fixture 内放 `bilibili_cookie.json`、`.env.local`、`id_ed25519` | 三种输出里这些字符串**一次都不出现**，只有 `SENSITIVE_PATH_TOKEN` 与聚合计数 |
| T12 | 临时改 `rules.json` 的 `activeMaxSec` 为 60，日志 120 秒前 | `liveness.level == "slack"`（证明阈值真的从 json 读） |
| T13 | 源码扫描 | `src/` 下无 `node:http`/`node:https`/`node:net`/`node:dns` 导入 |
| T14 | 源码扫描 | 除 `rules.json` 外，`src/**/*.mjs` 不出现 `3600`/`86400`/`604800` 判定字面量 |
| T15 | 每条鱼的 `nextStep` | 非空、不出现未替换的 `{var}` |

---

## 8. 已知局限（照实写，不粉饰）

1. **Windows 不扫**：v0.1 明确 `unsupported`，不假装扫到了什么。
2. **sqlite 判重表**：无驱动时只读 mtime/size，条目数 `unknown` —— 宁可 unknown 也不估。
3. **日志无时间戳**：窗口退化为「尾部 N 行」，报告里必须写「按最后 N 行估算」。
4. **时钟错乱**：未来 mtime 会让存活判定看起来「刚动过」，因此设 `futureSkewToleranceSec=120` 并把越界源作废留痕。
5. **不认识的新鱼种**：kind 落到 `unknown`，只做 `liveness`（进程启动时间）+ `health`（若找到日志），其余 `unknown`。**新产品不该被假装体检通过。**
6. **多窝同鱼**：按 `realpath` 去重；同一窝挂了两份配置（`profile`）时按 profile 各算一条鱼。

---

## 9. 变更流程

1. 改阈值 → 只改 `src/rules.json` 的 `constants`，**不要动 bands 结构**。
2. 改档位/新增 level → 必须同时改：`rules.json` 的 `bands` + `diagnosis`、本文对应表格、D3 的 fixture 断言。三者同一次提交。
3. 改话术 → 改 `diagnosis[*].phenomenon/nextStep`，并检查 `vars` 仍然够用。
4. 每次改都要 bump `specVersion`（如 `D1.4`）。

---

## 10. 一句话总结

**看得见 > 好看。判不出就说判不出。每条结论后面都必须跟着一句「那你现在该做什么」。**
