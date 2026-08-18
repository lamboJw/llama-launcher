# llama-server 桌面启动器 — 设计规格

- 日期：2026-07-25
- 状态：已确认（用户逐节批准）
- 目标平台：Windows x64
- 技术栈：Electron + TypeScript
- 打包：electron-builder 便携版 zip（解压即用，无安装器）

## 1. 背景与目标

做一个 Windows 桌面应用，用于启动本机 llama-server。默认使用 App 目录内托管的
llama.cpp 版本（`<appRoot>/llama.cpp/<tag>/llama-server.exe`，当前已下载 b10488 / build 10488 / commit 9d77fa172，
参数表单以其 --help 为基线）；也支持「自定义路径」指向外部二进制（如 F:\llama\Release\llama-server.exe，v9222）。

功能目标：
1. 设置模型扫描目录，扫描本地 .gguf 模型并选择；
2. 表单化填写 llama-server 启动参数（留空 = 不传，用 llama-server 默认值）；
3. 彩色日志面板（ANSI）实时显示 llama-server 输出；
4. 统计面板：首 token 时间（TTFT）、prefill 时间、prefill 速度、decode 速度、缓存命中率；
5. 勾选项：记录每一轮的 prompt 与 decode 内容（大文件分页加载，注意性能）；
6. 内置测试聊天（走同一代理端口，同样被记录）；
7. 每个模型一份参数档案，下次选中该模型时自动应用；
8. llama.cpp 版本更新：启动时检查 GitHub 最新版，下载 Windows x64 (CUDA 13) 主包与对应 CUDA DLLs，
   更新到 App 目录 llama.cpp/ 下，最多保留两个版本，界面可选。

## 2. 总体架构

采用「常开反向代理」架构（用户已确认，方案 1）。

```
┌─────────────────────────── Electron 应用 ───────────────────────────┐
│ 渲染进程 (UI)                主进程                                    │
│ ┌─────────────────────┐      ┌────────────────────────────────────┐ │
│ │ 模型扫描区           │      │ ① 进程管理器                        │ │
│ │ 参数表单            │◄IPC─►│    spawn llama-server.exe           │ │
│ │ 日志面板 (ANSI)     │      │    参数 = 表单值 + 强制参数           │ │
│ │ 统计面板            │      │    stdout/stderr → 按行切分 → IPC    │ │
│ │ 聊天面板            │      │    时序日志行正则解析 → 统计事件       │ │
│ │ 轮次记录面板         │      │ ② 反向代理 (用户可见端口, 默认 8080)  │ │
│ └─────────────────────┘      │    HTTP/SSE 透传 → 内部端口           │ │
│                              │    TTFT 计时 / 缓存命中率计算           │ │
│                              │    每轮 prompt/decode 记录 (JSONL)     │ │
│                              │ ③ 配置与档案持久化                    │ │
│                              └────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
                 ▲ HTTP (SSE)
                 │
   外部客户端 (Open WebUI / 脚本) + 内置聊天（均指向可见端口）
```

### 2.1 端口模型
- llama-server 监听**内部端口**：127.0.0.1，从 59999 起探测空闲端口（占用则 +1）。
- App 主进程在**用户可见端口**（默认 8080，可配置）跑 HTTP 反向代理，透传全部请求（含 SSE 流式）。
- 外部客户端与内置聊天都只面向可见端口；用户只需记一个固定端口。

### 2.2 启动流程
1. 用户点「启动」→ 主进程组装参数（见 §5.3 强制参数）。
2. spawn llama-server.exe（子进程，stdout/stderr 管道）。
3. 启动反向代理监听可见端口；就绪判定 = 轮询内部端口 /health 返回 200。
4. 状态置「运行中」，顶栏显示端口。

### 2.3 停止与崩溃
- 点「停止」/ 关窗口 / 进程崩溃：结束子进程（Windows 用 taskkill /T /F 杀进程树），关闭代理。
- 子进程意外退出：状态栏红色「已崩溃 (exit N)」，日志保留最后输出，提供「重启」按钮。
- 可见端口被占用：启动前检测，失败则弹错并提示改端口。
- 代理在 server 未就绪时返回 503。

## 3. UI 布局

单窗口，左右分栏，中文界面。

```
┌──────────────────────────────────────────────────────────────────┐
│ 顶栏: [模型: qwen3-8b.gguf ▾] [状态: ● 运行中 :8080] [▶ 启动] [■ 停止] │
├───────────────────────────┬──────────────────────────────────────┤
│ 左栏: 设置 (可滚动)         │ 右栏: 标签页                           │
│ ┌───────────────────────┐ │ ┌──────────────────────────────────┐ │
│ │ 模型扫描               │ │ │ 日志 │ 统计 │ 聊天 │ 轮次记录      │ │
│ │ [F:\models ▾] [🔍扫描] │ │ ├──────────────────────────────────┤ │
│ │  · qwen3-8b-q4.gguf 4.2G│ │ │                                  │ │
│ │  · llama3.1-8b-q8.gguf 8.1G│ │ │   （当前标签内容区）            │ │
│ ├───────────────────────┤ │ │                                  │ │
│ │ [💾 保存当前参数到档案]  │ │ │                                  │ │
│ │ 参数分组 (折叠面板)      │ │ │                                  │ │
│ │ ▾ 模型    ▸ 服务       │ │ │                                  │ │
│ │ ▸ 硬件    ▸ 上下文     │ │ │                                  │ │
│ │ ▸ 采样    ▸ 高级       │ │ │                                  │ │
│ └───────────────────────┘ │ └──────────────────────────────────┘ │
└───────────────────────────┴──────────────────────────────────────┘
```

- **日志标签**：ANSI 彩色渲染、自动滚动（上滚暂停、回到底部恢复）、关键字过滤、清空按钮。
- **统计标签**：5 张指标卡（最近一轮值）+ 最近 20 轮明细表。
- **聊天标签**：内置测试聊天，流式显示，请求走可见端口（因此也被记录）。
- **轮次记录标签**：每轮一条，可展开看完整 prompt / decode；仅勾选「记录每轮」时启用。

## 4. 模型扫描

- 路径输入框 + 「浏览…」原生目录对话框；记住上次目录。
- 递归扫描目录下所有 .gguf：文件名、完整路径、大小（GB）、修改时间；按修改时间倒序。
- 点击列表项选中，作为 --model；顶栏显示选中模型名。
- 「重新扫描」按钮手动刷新；纯文件枚举，不轮询。
- 兜底：「手动输入模型路径」输入框（模型在别处或想用 --hf-repo 等）。
- 扫描结果不持久化（每次启动按目录重扫）；只持久化「目录 + 上次选中路径」。

## 5. 参数表单

按 llama-server **b10488**（build 10488，commit 9d77fa172，表单基线版本）实际 --help 参数分组。
**留空 = 不传该参数**（用 llama-server 默认值），App 不自行维护默认值，避免版本漂移。
每个参数带 tooltip（--help 原文说明 + 默认值）。

| 分组 | 参数 |
|---|---|
| 模型 | 模型文件（扫描/手动）、--alias、--mmproj（多模态投影文件，可选，带浏览按钮）、--mmproj-url（投影文件 URL，可选）、--mmproj-auto（默认开，配合 -hf 自动用投影）、--mmproj-offload（默认开，投影 GPU 卸载）、--image-min-tokens / --image-max-tokens（动态分辨率图像 token 上下限，留空=读模型） |
| 服务 | 可见端口（默认 8080）、--host（**代理**监听地址，默认 127.0.0.1，填 0.0.0.0 允许局域网访问；server 自身永远绑 127.0.0.1，见 §5.3）、--api-key、--timeout（默认 600）、--jinja（默认开）、--ui WebUI 开关（默认开，代理透传后自带 WebUI 同端口可访问）、--sse-ping-interval（默认 30，SSE 心跳，-1 关）、CORS 四件套：--cors-origins / --cors-methods / --cors-headers / --cors-credentials（局域网多客户端场景用） |
| 硬件 | --n-gpu-layers（默认 auto）、--threads、--threads-batch、--split-mode、--device、--load-mode（默认 auto；**替代已废弃的 --mmap/--mlock/--direct-io**，取值 auto/none/mmap/mlock/direct_io 等）、--fit（默认开）、--cache-type-k / --cache-type-v（默认 f16）、--n-cpu-moe |
| 上下文 | --ctx-size（留空=模型默认）、--parallel、--batch-size（默认 2048）、--ubatch-size（默认 512）、--cache-ram（MiB）、--flash-attn（默认 auto）、--swa-full |
| 采样 | --temperature（0.80）、--top-k（40）、--top-p（0.95）、--min-p（0.05）、--repeat-penalty（1.00）、--presence-penalty、--frequency-penalty、--repeat-last-n（64）、--seed（-1）、--ignore-eos、--reasoning-effort（default/minimal/low/medium/high/xhigh/max）、--reasoning-preserve（开关，推理模型保留完整思考链） |
| 投机解码 (MTP) | --spec-type（多选：none / draft-simple / draft-eagle3 / **draft-mtp** / draft-dflash / draft-dspark / ngram-simple / ngram-map-k / ngram-map-k4v / ngram-mod / ngram-cache；MTP 选 draft-mtp）、--spec-draft-model（MTP/draft 模型文件，带浏览按钮）、--spec-draft-hf（HF 上的 draft 模型 `<user>/<model>[:quant]`）、--spec-draft-n-max（默认 3）、--spec-draft-n-min（默认 0）、--spec-draft-ngl（默认 auto）、--spec-draft-threads（默认同 --threads）、--spec-draft-p-split（默认 0.10）、--spec-draft-p-min（默认 0.00）、--spec-default（开关，启用默认投机解码配置） |
| 高级 | --verbosity（默认 3）、--warmup（默认开）、--context-shift、--cache-reuse、--perf、--log-prompts-dir（llama.cpp 自带 prompt 落盘调试）、--mcp-servers-config（MCP 服务器定义 JSON 路径）、--mtmd-batch-max-tokens（默认 1024，多模态图像 token 批大小）、--spec-draft-backend-sampling（开关）、**附加参数自由文本框**（shell 风格分词后追加，覆盖一切未表单化的参数） |

### 5.1 每模型参数档案
- **选中即应用**：点选模型 → 若该模型有档案，自动填入表单（覆盖当前表单）；无档案保持默认/上次值。
- **启动即保存**：点「启动」时把当前表单按该模型存为档案（自动记住上次成功配置）。
- **手动保存**：表单顶部「💾 保存当前参数到档案」按钮。
- **档案内容**：表单全部参数（含附加参数自由文本）+ 模型路径。
- **键**：模型完整路径。
- **存储位置**：App 数据目录 %APPDATA%/llama-launcher/profiles/，按模型路径哈希命名（用户已确认，不放模型同目录）。

### 5.2 持久化
- 全部设置（含表单值、扫描目录、可见端口、记录开关等）自动持久化到 electron-store（%APPDATA%/llama-launcher/），下次启动恢复。

### 5.3 强制参数（用户不可改，App 组装时追加）
- --log-colors on（管道下 auto 会关颜色，必须显式 on 才能拿到 ANSI）
- --metrics（启用 /metrics 端点备用）
- --host 127.0.0.1 --port <内部端口>（server 自身永远只绑 127.0.0.1 内部端口；表单里的可见端口与 --host 均作用于代理层，不传给 server）

## 6. 日志（彩色）

- 主进程合并子进程 stdout+stderr，按 \n 切行；**原始行（含 ANSI 转义码）原样**经 IPC 发渲染进程。
- 渲染进程用 ansi-to-html 转 <span style="color…">，等宽字体 + 深色背景。
- 自动滚动：用户上滚即暂停，回到底部恢复。
- 关键字过滤：匹配行高亮。
- 内存保留上限约 5000 行，超出丢最旧；**不落盘**（llama-server 自身可用 --log-file，App 不重复做）。
- 主进程对每行旁路跑正则解析（§7），不影响原始行转发。

## 7. 统计（5 指标）

数据源两条路，互不依赖：

| 指标 | 来源 | 时机 |
|---|---|---|
| prefill 时间 / prefill 速度 | 日志行 prompt eval time = X ms / N tokens (… ms per token, … tokens per second) | 每轮生成结束 |
| decode 速度 | 日志行 eval time = X ms / N tokens (… ms per token, … tokens per second) | 每轮生成结束 |
| TTFT | 代理层计时：收到 /v1/chat/completions 请求体 → 转发后收到第一个含 content 的 SSE chunk 的耗时 | 每个流式请求 |
| 缓存命中率 | 代理层读响应 JSON usage.prompt_tokens_details.cached_tokens / prompt_tokens；流式读末尾 usage chunk | 每个请求 |

- 主进程把每轮事件（5 值 + 时间戳）经 IPC 发渲染进程。
- 面板：5 张指标卡显示最近一轮；下方表格最近 20 轮明细（时间 / TTFT / prefill 时间 / prefill 速度 / decode 速度 / 缓存命中率）。
- 解析不到的指标显示 —，不报错。
- 并发多 slot 时日志行会交错；v1 按「最近一次出现的行」归并到最近一轮，够用即可，不做完美归并。

## 8. 轮次记录（勾选项，大文件性能设计）

- 设置区勾选项：「记录每一轮的 prompt 与 decode 内容」，默认关。
- 开启后，代理层对每个 /v1/chat/completions（及 /v1/completions）请求：
  - 请求体 messages（或 prompt）→ 拼出完整 prompt 文本；
  - 流式响应逐 chunk 累积 content 直到 [DONE] → 完整 decode 文本；
  - 追加一条 JSONL：{ts, model, prompt, decode, ttft_ms, usage}。
- 关闭勾选项时代理层完全不做累积（零开销）；已存记录保留。
- 隐私提示：记录为明文对话内容，文件在 App 数据目录，用户可随时删。

### 8.1 写入侧
- JSONL 追加写，每条一次 appendFile（O(1)）。
- 单文件上限 50MB：超过滚动新文件（2026-07-25.jsonl → 2026-07-25-1.jsonl → …）。
- 总量上限 1GB（可配置）：超出删除最旧文件，磁盘占用有界。

### 8.2 读取侧（核心：绝不整文件加载）
- JSONL 每行一条，支持从尾部读：
  - 首屏只读文件末尾 ~2MB chunk，按行切分解析出最后若干条 → 最新一页；若末尾行不完整（单条记录超过 2MB），继续向前扩展读取直到该行完整；
  - 每页 50 条，「加载更多」再往前读下一个 2MB chunk，O(页大小) 而非 O(文件大小)；
  - 500MB 与 5MB 文件首屏耗时一致。
- 列表行只渲染摘要（时间 + prompt 前 80 字 + token 数）；完整内容展开时才显示（数据已在页内，展开零 IO）。
- 文件读取在主进程异步（fs.open + read 指定 offset），渲染进程只收 IPC 传来的 JSON 页，UI 不卡。
- 跨天/跨文件：按「日期 + 文件序号」倒序遍历，当前文件读完再开上一个。
- 兜底：某行损坏（写入中断）则跳过该行继续，不中断整页加载。

性能目标：1GB 记录量下首屏加载 < 50ms，翻页 < 100ms。

## 9. llama.cpp 版本兼容与更新

### 9.1 被动兼容 + 精准诊断（应对参数改名）

设计原则：**被动兼容 + 精准诊断**，不做自动适配——参数改名后「自动换成新名字」不可靠
（新名字语义可能不同），「告诉用户哪个参数坏了、在哪改」是 100% 可靠的。

1. **版本探测与基线提示**
   - App 启动时（及用户修改 exe 路径后）运行 `llama-server.exe --version` 解析版本。
     **两种格式都要支持**：旧版 `version: 9222 (9a532ae4b)`、新版
     `version: 0.1.2-dev (build 10488, commit 9d77fa172)`（正则提取 build/数字 + commit）。
   - 顶栏/设置区显示当前版本；表单内置**基线版本 b10488**（参数集的设计依据）。
   - 探测版本 ≠ 基线 → 非阻塞黄色横幅：「检测到 llama.cpp vXXXX，参数表单基于 b10488 设计，
     个别参数可能已改名」。
2. **启动失败精准诊断（核心机制）**
   - server 启动后短时间内（< 10s）非零退出 → 扫描 stderr：
     - 匹配 `error: invalid argument: --xxx`（arg.cpp 实测格式）→ 反查「CLI 参数 ← 表单字段」
       映射表，弹错：「参数 `--xxx` 未被当前版本识别（可能已改名或移除），请清空对应字段，
       或改用『附加参数』填新版本参数」；
     - 匹配 `the argument has been removed. ...` → 同类提示。
   - App 组装参数时记录每个 CLI 参数 ← 来源字段（表单字段名 / 附加参数 / 强制参数）的映射。
3. **防御性日志解析**
   - 时序行正则支持多格式变体（当前格式 + 已知历史格式），任一匹配即提取；
     解析不到显示 `—`，绝不因格式变化崩溃。
   - TTFT / 缓存命中率由代理层自测，与 llama.cpp 版本无关，版本变化影响面小。
4. **转义通道**：「附加参数」自由文本框——新版本新增参数不更新 App 也能传。

明确不做（YAGNI）：运行时解析 --help 动态生成表单（help 文本解析极脆弱）；
自动参数改名映射表（不可靠，真遇到具体改名时再加单条映射）。

### 9.2 版本更新（GitHub 检查 + 自动下载）

**目录结构（App 目录内，便携）：**

```
<appRoot>/llama.cpp/
├─ manifest.json              # 已装版本清单 [{tag, cudaVersion, installedAt}]
├─ cuda/
│  └─ cuda-13.3/              # CUDA DLLs（cudart 等），按 CUDA 版本共享，跨版本复用
├─ b10488/                    # 托管版本（主包解压：llama-server.exe 等）
└─ b9222/                     # 旧版本
```

- CUDA DLLs 放共享目录：~373MB 只下一次，两个 llama.cpp 版本共用（同 CUDA 版本 DLL 通用）。
  启动托管版本时把 `<appRoot>/llama.cpp/cuda/cuda-<ver>` 加进子进程 PATH。
- 目录位置可配置，默认 `<appRoot>/llama.cpp`。

**检查更新：**
- App 启动时（异步非阻塞）+ 设置区手动「检查更新」按钮。
- 请求 `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`（releases 页面的 API 源），
  解析 `tag_name`（如 `b10488`）。
- 最新版 ∉ 已装版本集合 → 黄色横幅「发现新版本 bXXXXX」+「立即更新」。
- 网络失败/超时 → 灰色小字「检查更新失败」，不阻塞任何功能。

**资产匹配（基于 b10488 实测资产命名）：**
- 主包：优先 `llama-b<NNNN>-bin-win-cuda-13.*-x64.zip`（当前 win-cuda-13.3-x64，~140MB）；
  若该版本无 13.x 资产，回退 `win-cuda-<最高CUDA版本>-x64.zip` 并提示。
- CUDA DLLs：`cudart-llama-bin-win-cuda-<与主包相同CUDA版本>-x64.zip`（~373MB）。
- 「已有对应版本」判定：`cuda/cuda-<ver>/` 下存在 `cudart64_<主版本>.dll` → 跳过下载。

**更新流程：**
1. 磁盘预检：剩余空间 ≥ 2GB（zip + 解压峰值），不足则拒绝并提示。
2. 下载主包 → 进度条（%、MB/s）；**断点续传**（`.part` 文件 + HTTP Range）。
3. 解压到 `<appRoot>/llama.cpp/<tag>/`，删除 zip。
4. 检查 CUDA DLLs：已存在 → 跳过；否则下载 + 解压到 `cuda/cuda-<ver>/`，删除 zip。
5. 验证：跑 `<tag>/llama-server.exe --version` 确认可执行。
6. 修剪：版本目录最多保留 2 个，删最旧（若最旧是当前选中的版本，改删中间那个）；
   `cuda/` 下无版本引用的 CUDA 目录一并清理。
7. 更新 manifest.json，UI 自动选中新版本。

**UI：**
- 设置区「**llama.cpp 版本**」下拉框：已装托管版本（b10488 / b9222…）+「**自定义路径…**」
  （保留外部 exe 用法）。选托管版本 → exe 路径 = `<appRoot>/llama.cpp/<tag>/llama-server.exe`，
  PATH 注入对应 cuda 目录。
- 更新按钮旁状态：检查中 / 下载中(进度) / 解压中 / 完成 / 失败(原因 + 重试)。
- 与 §9.1 联动：选中版本 ≠ 基线版本 → 参数兼容提示横幅。

**失败处理：**
- 下载中断 → `.part` 保留，重试续传。
- 解压失败 → 删不完整的版本目录，旧版本不受影响。
- 验证失败 → 标红该版本，不自动选中。

## 10. 错误处理汇总

- 可见端口被占用 → 启动前检测，弹错提示改端口。
- llama-server 崩溃 → 红色状态 + exit code + 保留日志 + 重启按钮。
- 模型文件不存在/无效 → 由 server 日志报错，App 不预校验（避免重复维护校验逻辑）。
- 代理 server 未就绪 → 503。
- 记录文件损坏行 → 跳过。
- 档案文件损坏 → 忽略该档案，按无档案处理。

## 11. 测试

- 单元测试（vitest）：
  - 日志解析器：用真实捕获的 prompt eval time / eval time 行样本验证正则与数值提取；
  - 代理层：SSE 透传、TTFT 计时、usage/缓存命中率解析、prompt/decode 累积；
  - 记录存储：尾部 chunk 分页读取、50MB 滚动、1GB 总量淘汰、损坏行跳过；
  - 档案：按模型路径哈希存取、损坏档案忽略；
  - 版本模块：双格式版本字符串解析（`9222 (abc)` / `0.1.2-dev (build 10488, commit ...)`）、
    资产名匹配（win-cuda-13.*-x64 优先、回退最高 CUDA 版本）、`invalid argument` 诊断映射；
  - 下载器：断点续传（Range 头）、磁盘预检、版本修剪（保留 2 个、跳过当前选中）。
- 集成冒烟：起真实 llama-server（小模型），启动/停止/崩溃恢复、彩色日志、统计值与 /metrics 对照。

## 12. 项目结构（Electron）

```
llama-launcher/
├─ src/
│  ├─ main/
│  │  ├─ index.ts          # 入口、窗口、IPC 注册
│  │  ├─ process-manager.ts# spawn/停止/崩溃/就绪判定
│  │  ├─ proxy.ts          # 反向代理 + TTFT + 缓存命中率 + 轮次累积
│  │  ├─ log-parser.ts     # 行切分 + 时序行正则
│  │  ├─ records.ts        # JSONL 写入/滚动/分页尾部读取/总量淘汰
│  │  ├─ profiles.ts       # 每模型档案存取
│  │  ├─ config.ts         # electron-store 封装
│  │  ├─ scan.ts           # .gguf 递归扫描
│  │  ├─ version.ts        # --version 探测（双格式解析）、基线对比
│  │  └─ updater.ts        # GitHub 检查/资产匹配/断点续传下载/解压/修剪/manifest
│  ├─ preload/
│  │  └─ index.ts          # contextBridge 暴露 API
│  └─ renderer/
│     ├─ index.html
│     ├─ main.ts           # 应用外壳、标签页
│     ├─ components/       # 模型扫描/参数表单/日志/统计/聊天/记录
│     └─ styles/
├─ electron-builder.yml    # 便携版 zip
├─ package.json
└─ tsconfig.json
```
