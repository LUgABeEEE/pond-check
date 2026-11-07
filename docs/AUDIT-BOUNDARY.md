# 边界与零依赖审查（D8a）

- **审查对象**：`pond-check` 工作区 2026-11-07 21:0x（审查时 HEAD = `3ff97e0`，`src/` 13 个 `.mjs` + `rules.json`）
- **审查人**：reviewer（D8a 只读审查）
- **范围**：`src/**`、`package.json`；`tests/` 仅作旁证，不在本审查范围内
- **方法**：源码 grep（逐文件）+ 逐个读文件调用点人工确认 + `strace` 系统调用取证 + 假凭证炸弹端到端
- **本文件是审查结论，不是代码**：全程没有改动 `src/`、`tests/`、`package.json` 的任何字节

## 0. 结论摘要（一句话一条）

| # | 必查项 | 结论 | 级别 |
|---|--------|------|------|
| 1 | 网络调用（fetch / http / https / net / dns / tls / WebSocket） | `src/` 里**零命中**，`grep` 退出码 1；真机跑一遍 strace 里 `socket/connect` 计数 0 | ✅ 无缺陷 |
| 2 | 读凭证文件**内容** | **没有**任何"打开凭证文件读内容"的路径：19 个读文件调用点全部列在 §2，5 道名字闸 + 软链复查；假凭证炸弹实测 open 计数 0 | ✅ 无 blocker（2 条 low，见 §6） |
| 3 | 写用户目录 / 改配置 / 启停进程 / 执行 shell | 唯一写入是**它自己的报告文件**；唯一 `execFileSync` 默认关死且 CLI 不可达；`kill` 类调用 0 | ⚠️ 边界成立，但 2 条 medium（§6 M1/M3） |
| 4 | `package.json` 依赖 | `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` **四个键全部不存在**，`node_modules` 不存在，裸模块名 import 0 | ✅ 无缺陷 |

**分级总计：blocker 0 / high 0 / medium 3 / low 4。**

一句话交代：**只读边界没有被破坏**。三条 medium 都不是"现在就会出事"，而是"承诺与实现不一致"或"防回归闸门缺失"——它们该在 v0.1.0 发布前补掉，但不足以把下游锁死。

---

## 1. 网络：零引用（无缺陷）

**结论**：`src/` 的 13 个 `.mjs` 里没有任何网络 API、没有网络模块 import、没有 URL 请求拼接。逐文件计数全 0。

```
$ grep -rniE 'fetch|http|https|\bnet\b|\bdns\b|\btls\b|websocket' src/ --include='*.mjs'
（无输出）
exit=1
```

逐文件确认（同一模式，命中数）：

```
src/cli.mjs                  0
src/discover/dsh.mjs         0
src/discover/generic.mjs     0
src/discover/index.mjs       0
src/evaluate/index.mjs       0
src/evaluate/life.mjs        0
src/evaluate/system.mjs      0
src/read/index.mjs           0
src/read/log.mjs             0
src/read/state.mjs           0
src/render/html.mjs          0
src/render/json.mjs          0
src/render/text.mjs          0
```

全仓（含 `tests/`）唯一的网络字样出现在 `src/rules.json:14-18` 的**禁用清单**里，不是 import：

```json
"policy": {
  "readOnly": true,
  "offline": true,
  "noNetworkModules": ["node:http", "node:https", "node:net", "node:dns", "node:tls"],
  "forbiddenExec": ["sh", "bash", "zsh", "cmd", "powershell"]
}
```

**运行期取证**（比 grep 更硬）——真机默认扫描 + 固定窝扫描各跑一次，只 trace 网络系统调用：

```
$ strace -f -e trace=network -o /tmp/aud.net.strace node src/cli.mjs --root <假鱼窝> --text
exit=0
$ grep -cE 'socket\(|connect\(|sendto\(|sendmsg\(|bind\(|getaddrinfo' /tmp/aud.net.strace
0
$ wc -l < /tmp/aud.net.strace
12            # 12 行全是 11 个线程的 "+++ exited with 0 +++"，一条网络调用都没有
```

真机默认扫描（不指定 `--root`，走自动发现，`discoverPonds → readAll → evaluate`）同样为 0。

**同类误读提示**：`src/discover/index.mjs:59` 有一行 `require('node:worker_threads')`，它是**模板字符串里的 worker 源码**（`GENERIC_WORKER_SRC`，第 54-88 行，用 `new Worker(src)` 起的本地线程）为了兼容 CJS/ESM 两种 eval 模式的写法，不是本包的 CJS 依赖；`src/discover/index.mjs:33` 的 `import { Worker } from 'node:worker_threads'` 是本地线程，不是网络。

---

## 2. 读文件调用点全表（逐个说明读的是什么）

**结论**：全部 19 个读文件调用点只读三类东西——①本仓自己的 `rules.json` / `package.json`；②**被扫描的那条鱼自己的**日志 / 配置 / 判重表 / 会话目录；③`/PATH` 上可执行文件的存在性。**没有任何一条路径会把"看着像凭证"的文件打开读内容**；名字闸在 5 处独立生效，且日志读取器还做了 `realpath` 复查堵软链绕过。

| # | 调用点（文件:行） | 读的是什么 | 闸门 | 内容去向 |
|---|---|---|---|---|
| 1 | `src/render/json.mjs:47` | 本仓 `rules.json`(:53)、`package.json`(:60) | — | 只取 `schemaVersion` / `version` |
| 2 | `src/evaluate/life.mjs:129` | 本仓 `rules.json` | — | 判定阈值 |
| 3 | `src/evaluate/life.mjs:121` | `opts.rulesPath` 或环境变量 `POND_CHECK_RULES` 指的文件 | **无凭证闸**（见 L1） | 当判定规则用，不输出内容 |
| 4 | `src/evaluate/index.mjs:144` | 本仓 `rules.json` | — | 档位/阈值 |
| 5 | `src/evaluate/system.mjs:95` | 本仓 `rules.json` | — | 阈值 |
| 6 | `src/evaluate/system.mjs:1087` | 鱼的 `config.json` | `configGateReason()`(:1106-1113) 名字闸 + `isFile` + ≤32 MiB(:1086) | 只出 `schemaVersion` / `pluginVersion` / 键名布尔 |
| 7 | `src/read/state.mjs:72` | 本仓 `rules.json`（模块加载时） | — | 跳过模式/阈值 |
| 8 | `src/read/state.mjs:150`（`readTextFileSafe`） | 判重表（闸在 :299）、配置（闸在 :457）、程序清单（闸在 :495） | 三处各自的 `isSensitiveFileName` + `isFile` + ≤32 MiB(:149) | 判重表只出条数与时间；配置只出布尔与版本号 |
| 9 | `src/read/state.mjs:380` | sqlite 判重表（`new DatabaseSync(filePath, { readOnly: true })`） | :299 名字闸 + `readOnly` + `PRAGMA query_only`(:382) | 只 `SELECT COUNT(*)`，绝不写一个字节 |
| 10 | `src/read/log.mjs:65` | 本仓 `rules.json` | — | 关键词分类表 |
| 11 | `src/read/log.mjs:436`（`open(absPath,'r')`） | 鱼的日志文件尾部 | `sensitiveReason()`(:677) + `realpath` 复查(:688) + 非普通文件拦下(:684) + 字节/行/采样上限 | **只出分类命中计数，日志原文不进任何渲染**（实测见 §5.4） |
| 12 | `src/discover/index.mjs:90` | 本仓 `rules.json` | — | 扫描预算 |
| 13 | `src/discover/dsh.mjs:99` | 插件/技能的 `package.json` | `isFile` + ≤1 MiB(:92,:94) | 只取 `name` / `version` |
| 14 | `src/discover/dsh.mjs:162`、`src/discover/generic.mjs:81` | 本仓 `rules.json` | — | 跳过模式 |
| 15 | `src/discover/generic.mjs:271` | 目录项（`readdir` + dirent） | `skipDirPatterns` + `isCredentialishDirName` | 只出聚合计数（见 L3） |
| 16 | `src/read/index.mjs:177` / `:187` | 会话目录项 + `stat` | 名字闸（`:152-158`） | 文件数 + 最新 mtime |
| 17 | `src/read/state.mjs:694` | `knownCredentialPaths` 白名单（只 `statSync`，**不 open**） | 只取 mtime | 固定占位名 `'credential'` + 天数，真名永不外泄 |
| 18 | `src/read/state.mjs:559` | `/PATH` 上可执行文件（`accessSync(X_OK)`） | 不执行 | 布尔 `found` |
| 19 | `src/cli.mjs:177` / `:205` | `--root` / `--out` 路径的存在性（`statSync`） | — | 布尔 |

**凭证闸五处**（名字命中即整份不读，名字也不进结果）：

- `src/read/log.mjs:589-592` — 日志：`file_name` / `parent_dir` / `credentialish_dir`
- `src/read/state.mjs:299` — 判重表
- `src/read/state.mjs:457` — 配置
- `src/evaluate/system.mjs:1110-1111` — 配置（第二道，判档时再判一次）
- `src/discover/generic.mjs` / `src/read/index.mjs:152-158` — 目录项与候选路径

`rules.json` 的 `credentials.skipFilePatterns` 覆盖 70+ 个模式（`*token*`、`*cookie*`、`.env*`、`id_ed25519*`、`authorized_keys`、`*.pem`、`*.kdbx` …），`skipDirPatterns` 覆盖 `.ssh`、`.gnupg`、`.aws`、`.docker`、`.password-store` 等。

---

## 3. 写 / 改配置 / 启停进程 / 执行 shell

### 3.1 写：只有报告文件自己

**结论**：整个 `src/` 里可写系统调用只有 3 行，全部在 CLI 的"写报告"分支；`--json` / `--text` 模式实测 0 写；默认模式实测只产出 1 个 HTML；假 `HOME` 跑完仍是空的。

```
$ grep -rnE 'writeFileSync|writeFile\(|mkdirSync|unlinkSync|renameSync|chmodSync|truncateSync' src/ --include='*.mjs'
src/cli.mjs:289:      fs.mkdirSync(path.dirname(file), { recursive: true });
src/cli.mjs:290:      fs.writeFileSync(file, data);
src/cli.mjs:337:    d.writeFile(target, d.renderHtml(report));
exit=0
```

strace 取证（只列可写打开 / mkdir / unlink / rename / chmod）：

```
# 默认模式（cwd=/tmp/pc-audit-cwd，无 --out）
mkdir("/tmp/pc-audit-cwd", 0777) = -1 EEXIST (File exists)
openat(AT_FDCWD, "/tmp/pc-audit-cwd/pond-check-20261107-210532.html", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0666) = 21
→ cwd 里新增文件数：1（就是报告本身）

# --text 模式：可写打开计数 0
# --json 模式：可写打开计数 0

# 假 HOME 跑一遍
$ HOME=/tmp/pc-fake-home node src/cli.mjs --root <假鱼窝> --text
→ /tmp/pc-fake-home 内容：0 项（没有缓存、没有配置文件、没有遥测落盘点）
```

**没有**：`chmod` / `chown` / `unlink` / `rename`（0 命中）；不写任何 fish 目录、不写 `~/.dsh`、不写 `~/.config`。

### 3.2 执行 shell：唯一入口默认关死，且 CLI 不可达

**结论**：`src/` 里只有一处 `execFileSync`，被 `allowExec` 守着，缺省 `false`；CLI **从不**传 `allowExec`，因此生产路径不可达（实测 `execve` 只有 node 自己那一次）。

```
$ grep -rn 'child_process' src/
src/read/state.mjs:30:import { execFileSync } from 'node:child_process';

$ grep -rnE 'execFileSync|spawn\(|execSync|fork\(' src/ --include='*.mjs'
src/read/state.mjs:30:import { execFileSync } from 'node:child_process';
src/read/state.mjs:581:        const out = execFileSync('node', ['--version'], {
```

守门链路：`src/read/state.mjs:577` `function probeNodeVersion({ allowExec = false })` → `:579` `if (allowExec)` → 命令行只有 `node --version`（无 shell，`stdio: ['ignore','pipe','ignore']`，带 `timeout`）；`src/read/index.mjs:684` / `:750` 传递 `ctx.allowExec`；`src/cli.mjs:313` 调 `readAll(ponds)` **不传任何选项**，`allowExec` 为 `undefined` → `:655` `options.allowExec === true` 为假。

```
$ grep -rn 'allowExec' src/cli.mjs
（无输出）
```

```
$ strace -f -e trace=execve -o /tmp/aud.exec.strace node src/cli.mjs --root <假鱼窝> --text
execve 行数: 1
2596750 execve("/usr/local/bin/node", ["node", "src/cli.mjs", "--root", "/tmp/pc-audit-pond", "--text"], 0x... /* 27 vars */) = 0
```

→ 整跑只有自身启动那一次 `execve`，**零子进程**。`npm`/`sh`/`ffmpeg` 一个都没起（`ffmpeg` 只走 `accessSync` 找 PATH 上的文件，不执行）。

### 3.3 启停进程：零

```
$ strace -f -e trace=signal -o /tmp/aud.sig.strace node src/cli.mjs --root <假鱼窝> --text
kill 类调用数: 0        # kill( / tkill( / tgkill( / pidfd_send_signal 全 0
```

`src/` 里也没有 `process.kill` / `SIGTERM` / `systemctl` / `pm2` / `docker` 任何字样。

### 3.4 改配置：零

无 `writeFile` 指向配置、无 `process.env.X =` 赋值（只有**读** `process.env.DSH_HOME`(:510)、`POND_CHECK_RULES`(:114)）。

---

## 4. 零运行时依赖（无缺陷）

**结论**：`package.json` 四个依赖键**全部不存在**（不是空对象，是没有这个键），没有锁文件、没有 `node_modules`；源码里没有任何裸模块名 import。

```
$ node -e "const p=require('./package.json'); ..."
dependencies: undefined
devDependencies: undefined
peerDependencies: undefined
optionalDependencies: undefined
has node_modules: false

$ grep -rhoE "from '[^']+'" src/ --include='*.mjs' | sed "s/from '//;s/'$//" | sort -u | grep -vE '^\.|^node:'
（无输出）
exit=1

# 含 tests/ 一起查也一样：
$ grep -rhoE "from ['\"][^'\"]+['\"]" src tests | ... | grep -vE '^\.|^node:'
exit=1
```

全部 import 只有 `node:*` 内建模块（`fs`、`fs/promises`、`path`、`os`、`url`、`worker_threads`、`child_process`）与同仓相对路径。Node 版本要求写在 `engines.node: ">=22"`。

---

## 5. 端到端反证：假凭证炸弹 + 真机默认扫

### 5.1 假凭证炸弹（1 个窝里塞 4 个凭证文件 + 带 token 的配置 + 带 token 的日志）

造法：`app.log`（正常行 + 一行 `风控拦截 412` 且带 `token=MARKER_LOGTOKEN_9f3a`）、`config.json`（`apiKey`/`token`/`password`/嵌套 `refresh_token`，值全是可搜的 MARKER）、`bilibili_cookie.json`、`.env.local`、`id_ed25519`、`sent_sessions.json`（后四个各带一枚独立 MARKER）。

```
$ node src/cli.mjs --root /tmp/pc-audit-pond --json   → exit 0
$ node src/cli.mjs --root /tmp/pc-audit-pond --text   → exit 0
$ node src/cli.mjs --root /tmp/pc-audit-pond --out /tmp/aud.html → exit 0

# 8 枚 MARKER（配置值 4 + 凭证文件 4；日志里那 1 枚在 §5.4 单独验）在三种输出里的命中：
$ grep -c 'MARKER_' /tmp/aud.json /tmp/aud.txt /tmp/aud.html
/tmp/aud.json:0
/tmp/aud.txt:0
/tmp/aud.html:0

# 凭证文件名在三种输出里的命中：
$ grep -oE 'bilibili_cookie|\.env\.local|id_ed25519|sent_sessions' /tmp/aud.json /tmp/aud.txt /tmp/aud.html
（无输出）
```

**更强的一层：系统调用级证明"没打开过"。**

```
$ strace -f -e trace=openat,open,openat2 -o /tmp/aud.open.strace node src/cli.mjs --root /tmp/pc-audit-pond --text
openat 行数: 182

# 打开过的窝内文件（去重计数）——只有 4 个，全是正常产物：
      1 "/tmp/pc-audit-pond"
      1 "/tmp/pc-audit-pond/app.log"
      2 "/tmp/pc-audit-pond/config.json"
      1 "/tmp/pc-audit-pond/processed.json"

# 凭证文件名被 open 的次数（want 0）：
$ grep -cE 'bilibili_cookie|\.env\.local|id_ed25519|sent_sessions' /tmp/aud.open.strace
0
```

### 5.2 把 `--root` 直接指向真实 `~/.dsh`（最坏情况：那一层里就有凭证）

```
$ strace -f -e trace=openat,open -o /tmp/aud.dsh.strace node src/cli.mjs --root /data/agent/.dsh --json
exit=0

# 该跑里被 open 的 .dsh 下路径（去重，节选）：
profiles/web/package.json
plugins/dsh-purge/package.json
plugins/dsh-theme-elysia/package.json
logs
memory
minasCred            ← 见 L3：目录被 readdir 列名，但没进到里面 open 任何文件
minasCert
...

# 凭证味文件名被 open 的次数（want 0）：
$ grep -cE 'credential|auth\.json|token|\.env|id_rsa|id_ed25519|\.pem|\.key' /tmp/aud.dsh.strace
0

# 报告里出现的 4 处 "credential" 全是结构字段名，不是文件名/值：
259: "id": "credentialFreshness"
302: "credentials": { "foundCount": 0, "missingCount": 5, ... }
```

### 5.3 真机默认扫描（不指定 `--root`，用户真会这么用）

```
$ timeout 90 strace -f -e trace=openat -o /tmp/aud.auto.strace node src/cli.mjs --text
exit=0

$ grep -cE 'socket\(|connect\(|execve\(' /tmp/aud.auto.strace
0
$ grep -cE 'credential|auth\.json|token|cookie|\.env|id_rsa|id_ed25519|\.pem|secret|password' /tmp/aud.auto.strace
0
$ grep -cE '/\.ssh|/\.gnupg|/\.aws|/\.password-store' /tmp/aud.auto.strace
0            # skipDirPatterns 生效，这些目录连列都没列
$ grep -ciE 'credential|token|cookie|secret|password|id_ed25519|\.env' /tmp/aud.auto.txt
0            # 输出里也没有
```

### 5.4 日志原文会不会顺带泄漏

`read/log.mjs` 会把命中分类的行存进 `samples`（`src/read/log.mjs:553-565`，截断到 `maxLineChars`），但**判定层不消费 `samples`**：`grep -rn 'samples' src/evaluate/ src/render/` 零命中。实测（日志里放一行 `风控拦截 412 token=MARKER_LOGTOKEN_9f3a`）：

```
token/原文在三种输出里的命中：0 / 0 / 0
但分类计数确实进了报告：  "riskControl" …
```

→ 报告只带"哪一类、命中几次"，不带日志原文。这条对"凭证偶尔出现在日志里"是最关键的一道保险。

---

## 6. 分级缺陷清单

### blocker：0
### high：0

### M1（medium）`--no-exec` 是写在文档/话术里、但 CLI 不认的参数

- **问题**：`SPEC §3.6` 与 `rules.json` 都承诺"唯一允许的执行必须能被 `--no-exec` 关掉"，`src/evaluate/system.mjs:733` 的用户话术也写着「版本取不到（`--no-exec` 或无法执行）」。但 CLI 的参数表里**没有这个开关**，用户照着敲会 `exit 2`。
- **证据**：
  ```
  $ node src/cli.mjs --no-exec --text ; echo $?
  pond-check：不认识的参数：--no-exec（看用法：pond-check --help）
  2
  ```
  声明处：`src/rules.json:269,278,287`（`disableWith: "--no-exec"`）、`src/read/state.mjs:13-14` 注释、`docs/SPEC.md:39,146`。参数表：`src/cli.mjs:79-131`（只有 `--out/--root/--log/--dedupe/--fish/--json/--text/--help`）。
- **影响**：不是"会出事"，而是"**承诺落空 + 想加锁的人加了报错**"。当前实际状态更安全（exec 默认关、CLI 无路可开），所以边界未被破坏；但它把"安全开关"变成了"错误输入"，且 D6 那条「话术里的 `--xxx` 必须真支持」的一致性闸没覆盖到 `disableWith` 与 deps 话术里的这一处。
- **建议修复**（三选一，按代价排序）：①实现 `--no-exec`（当前语义就是"什么都不做"，一行）并在 `--help` 里列出；②删掉所有 `--no-exec` 字样，改成"本工具从不执行任何外部命令"；③保留声明，但补进一致性闸的扫描范围。

### M2（medium）`rules.json` 的 `policy.noNetworkModules` / `forbiddenExec` 是**纯声明，没有任何闸门**

- **问题**：`policy` 里写了只读/离线/禁网/禁 shell 的白名单，但**没有任何代码或测试读这两个键**——谁明天加一行 `import 'node:http'` 也不会被任何门拦下（`grep -rn 'noNetworkModules\|forbiddenExec\|policy\.' tests/ src/ --include='*.mjs'` → 零命中）。
- **证据**：`src/rules.json:11-30`；`grep` 结果为空。
- **影响**：本次审查靠的是"我现在 grep 了一遍"，不是"仓库里有闸"。下一个人改代码时，边界靠自觉。
- **建议修复**：在 `tests/` 加一条 10 行级的源码扫描测试：扫 `src/**/*.mjs` 的 import 说明符，命中 `policy.noNetworkModules` 或裸 specifier 即失败；再扫 `child_process` 只允许出现在 `src/read/state.mjs` 且必须被 `allowExec` 守卫。这条闸比追加文档有效得多。

### M3（medium）`--out` 会**静默覆盖**已存在的任意文件，并递归创建父目录

- **问题**：`src/cli.mjs:288-291` 直接 `mkdirSync(dirname, {recursive:true}) + writeFileSync(file, data)`，没有"目标已存在"检查、没有 `--force`。用户 `--out` 指错（比如指到一个 `.json` 配置）就是不可逆覆盖；`--out` 指向符号链接时还会顺链写到目标。
- **证据**：
  ```
  $ printf 'DO NOT TOUCH\n' > /tmp/pc-audit-out/existing.txt
  $ node src/cli.mjs --root <假鱼窝> --out /tmp/pc-audit-out/existing.txt ; echo $?
  0
  $ head -c 20 /tmp/pc-audit-out/existing.txt
  <!doctype html>          # 原内容已被 9008 字节 HTML 覆盖

  $ node src/cli.mjs --root <假鱼窝> --out /tmp/pc-audit-newdir/a/b/report.html   # 父目录被自动建出来
  ```
- **影响**：属于"用户显式指定路径"的写，不是偷偷写；但"静默覆盖"是可预防的数据丢失。默认模式（无 `--out`）行为温和：只在 cwd 产一个 `pond-check-<时间戳>.html`。
- **建议修复**：目标存在且不是本工具产物（文件开头不是 `<!doctype html>` 或没有 pond-check 标记）时拒绝写入，提示 `--force`；`--help` 里补一句"会覆盖同名文件"。

### L1（low）`POND_CHECK_RULES` 环境变量能让 `loadRules()` 读**任意路径**（含凭证文件），无凭证闸

- **问题**：`src/evaluate/life.mjs:113-121` 取 `opts.rulesPath` 或 `process.env.POND_CHECK_RULES`，直接 `readFileSync` + `JSON.parse`，不做任何名字闸。这是测试用的逃生口（注释明说"测试用"），但如果有人把 env 指到凭证文件，内容会进内存（解析失败则 `null`，**不会**进任何输出）。
- **证据**：
  ```
  $ POND_CHECK_RULES=/tmp/pc-audit-pond/bilibili_cookie.json node -e "...loadRules()..."
  loadRules -> null (解析失败，说明确实读了这个文件)
  strace openat 命中 bilibili_cookie：1
  ```
  **但 CLI 生产路径不可达**：同一 env 下跑完整 CLI，`strace` 里 `bilibili_cookie` 命中 **0**（因为 `evaluate` 已经把 rules 对象传下去，`life.mjs:110` 提前 return）。
- **影响**：仅库 API 直调 `loadRules()` 时可达；CLI 用户不可达。等级 low。
- **建议修复**：`customPath` 在解析前走一次 `isSensitiveFileName(basename)`，命中直接返回 `null`。

### L2（low）`config.json` 的内容会被**完整读进内存**再解析（敏感键只是"不输出"，不是"不读"）

- **问题**：`src/read/state.mjs:461,466` 把整份配置 `readFileSync` + `JSON.parse`，之后才挑 `schemaVersion`/`pluginVersion`/键名布尔；`src/evaluate/system.mjs:1087` 同样整份解析。
- **证据**：`src/read/state.mjs:150`（`readTextFileSafe` 返回全文）+ `:466`（`JSON.parse(loaded.text)`）；`src/evaluate/system.mjs:1087`。
- **影响**：配置文件**不是**凭证文件（它是一种"鱼的设置"，体检要判断 `model/baseUrl` 这类键在不在），所以读它属于设计内；敏感**键**在输出侧被跳过（`isSensitiveKey`）且**不留痕**（连"存在"都不说）。实测塞 `apiKey/token/password/refresh_token` 的配置 → 三种输出 0 命中。真正的问题是：如果用户把 token 直接写在 `config.json` 里，值会短暂进入进程内存。等级 low（不落盘、不外发、不进报告）。
- **建议修复**：不需要改；在 `--help` / README 的隐私段落补一句"只读、只判存在性、值不落任何输出"，把口径写明白。

### L3（low）凭证味但**没命中模式**的目录（实测 `minasCred` / `minasCert`）会被 `readdir` 列名

- **问题**：`src/discover/generic.mjs:170-185` 的 `isCredentialishDirName` 只认 `credential|apikey|api-key|private-key` 整词与 `secret/token/cookie/password/auth/...` 分词；`minasCred` 归一成 `['minascred']`，不命中，于是该目录被 `readdir` 列了一次。
- **证据**：§5.2 的 strace 里 `openat(".../minasCred", O_RDONLY|O_DIRECTORY)`（一次，仅列目录项，**没有** open 里面任何文件）；`minasCred` 在报告输出里命中 **0**。
- **影响**：只读到 dirent（名字），内容与 mtime 都没读，名字也没进任何输出；属于"多看了一眼门牌"，不是"进了房间"。
- **建议修复**：把 `*cred*` / `*cert*` 之类的保守模式补进 `credentials.skipDirPatterns`（注意别误杀 `credits`、`secretary` 这类无关目录，建议还是用精确名 + 白名单例外）。

### L4（low，可忽略）默认模式在 cwd 累积 `pond-check-<时间戳>.html`

- 每跑一次多一个文件，不清理、不覆盖（`src/cli.mjs:288-291` + 时间戳命名）。`.gitignore` 已忽略 `pond-check-*.html`，不会污染仓库；但用户目录会慢慢堆积。建议文档里提一句"报告会留在当前目录，可以删"。

---

## 7. 复现命令与退出码（本审查真跑过的）

| # | 命令 | 退出码 | 说明 |
|---|------|--------|------|
| 1 | `grep -rniE 'fetch\|http\|https\|\bnet\b\|\bdns\b\|\btls\b\|websocket' src/ --include='*.mjs'` | 1 | 零命中 = 无网络引用 |
| 2 | `grep -rn 'child_process' src/` | 0 | 仅 `src/read/state.mjs:30` |
| 3 | `grep -rnE 'execFileSync\|spawn\(\|execSync\|fork\(' src/ --include='*.mjs'` | 0 | 仅 `state.mjs:30,581` |
| 4 | `grep -rnE 'writeFileSync\|writeFile\(\|mkdirSync\|unlinkSync\|renameSync\|chmodSync\|truncateSync' src/ --include='*.mjs'` | 0 | 仅 `cli.mjs:289,290,337` |
| 5 | `grep -rn 'allowExec' src/cli.mjs` | 1 | CLI 从不传 → 生产不可 exec |
| 6 | `grep -rhoE "from '[^']+'" src/ \| ... \| grep -vE '^\.\|^node:'` | 1 | 零裸依赖 |
| 7 | `node -e "require('./package.json') 依赖四键"` | 0 | 四键全 undefined，无 node_modules |
| 8 | `node src/cli.mjs --no-exec --text` | 2 | M1：参数不存在 |
| 9 | `strace -f -e trace=network node src/cli.mjs --root <假鱼窝> --text` | 0 | socket/connect 计数 0 |
| 10 | `strace -f -e trace=execve ... --text` | 0 | execve 行数 1（只有 node 自己） |
| 11 | `strace -f -e trace=signal ... --text` | 0 | kill 类调用 0 |
| 12 | `strace -f -e trace=openat ... --root <假鱼窝> --text` | 0 | 凭证文件 open 0；窝内只开 4 个正常产物 |
| 13 | `strace -f -e trace=openat ... --root /data/agent/.dsh --json` | 0 | 凭证味文件名 open 0 |
| 14 | 真机默认扫描（`--text`，无 `--root`） | 0 | 网络 0 / exec 0 / 凭证 0 / `.ssh` 未列 |
| 15 | 假凭证炸弹三渲染 + `grep MARKER_` | 0 / 0 / 0 | 值 0 泄漏、文件名 0 泄漏 |
| 16 | 日志塞 token（且命中分类）+ 三渲染 `grep` | 0 / 0 / 0 | 日志原文不进报告，只出分类计数 |
| 17 | `node --test`（全仓） | 0 | 111 pass / 0 fail（审查时点） |
| 18 | `--out` 覆盖已存在文件 | 0 | M3：静默覆盖 9008 字节 |

---

## 8. 审查局限（照实说）

1. **动态取证只覆盖两条路径**：默认扫描 + `--root` 指定窝。`--log` / `--dedupe` 单点指定走的是同一批读取器（`readLogTail` / `readDedupeStore`），代码路径已逐行确认有同一道名字闸，但没有单独 strace 复跑。
2. **strace 只看到系统调用层**：能证明"没联网、没 exec、没打开凭证文件"，不能证明"没有逻辑上的越权读"——后者靠 §2 的调用点全表人工确认。
3. **`minasCred` 这类"名字不命中模式"的目录**：本机恰好有，所以被实测到了；别的机器上可能有模式外的凭证目录，`readdir` 会列名（进不了输出）。这属于 L3，不是本审查能穷举的。
4. **平台**：全部在 Linux（`linux/node 22.23.4`）上跑。Windows / macOS 未验证（`realpath`、`O_DIRECTORY`、`accessSync(X_OK)` 的语义在 Windows 上不同，边界结论可能需要重跑）。
5. **本审查没有覆盖 `tests/`**：`tests/` 里的代码不随包发布（`package.json` 的 `files` 只含 `src/docs/README/LICENSE`），但仓库里仍可被误 import，建议在 M2 的闸里一起扫。

---

*本文件由 D8a 只读审查产出。所有 `grep` / `strace` 输出为真机粘贴，未做修饰；缺陷等级标准：blocker = 只读边界被破坏（必须停），high = 无凭证闸的可达读取 / 会写用户配置，medium = 承诺与实现不一致或防回归闸缺失，low = 设计内但可收紧的口径。*
