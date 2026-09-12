# llama.cpp 基线升至 b10919 + 补齐新增参数 — 设计

日期：2026-09-12
状态：已确认（待用户审阅本文档）

## 背景

- 表单基线当前为 b10488（commit 9d77fa172）。最新 release 为 **b10919**（commit d3146f2b5，2026-09-12 发布），区间 282 个 commit。
- b10488→b10919 对 llama-server CLI 的全部变更（两 tag 的 `common/arg.cpp` 参数声明集合 diff，完整可靠）：

**新增（server 相关 8 个）：**

| 参数 | 取值/默认 | 语义 |
|---|---|---|
| `--lazy-mode` / `-lzm` | on\|auto\|off，默认 auto | per-layer embeddings 等大张量按行 mmap 按需读盘；on 需 mmap 支持；auto = 仅 >4GiB 的张量 lazy |
| `--log-jsonl` / `--no-log-jsonl` | 默认关 | stdout 输出 JSONL 日志，自动禁用彩色 |
| `--mmproj-device` / `-mmdev` | 设备名，默认跟随 `--device` | mmproj 指定设备；`none` = 不放 GPU |
| `--n-cpu-ffn` / `-ncffn` | N≥0，默认 0 | 前 N 层 dense FFN 权重留在 CPU（MoE 走现有 `--n-cpu-moe`） |
| `--kv-unified-per-slot` | N，默认 unset | 每并行 slot 的 context 上限；与 `-c` 同设时不生效 |
| `--video-fps` | float，默认 4.0 | 视频输入目标帧率 |
| `--video-timestamp-interval` | ms，默认 5000 | 视频文本时间戳间隔 |
| `--video-ffmpeg-dir` | 目录，默认搜 PATH | ffmpeg/ffprobe 所在目录 |

另有 `--spec-synth-len` / `--spec-synth-rates`（benchmarking only，不采用）。

**移除：** `--mmap` / `--mlock` / `--dio` / `-ndio` 在 b10919 彻底删除（无兼容 shim，传入即 invalid argument）。
表单已改用 `loadMode` 字段 → `--load-mode`，不受影响；用户若在「附加参数」里写这三个，启动失败诊断
（`diagnoseStartupFailure` 的「argument has been removed」分支）可捕获并提示。

## 决策记录

| 问题 | 决定 |
|---|---|
| 新基线 | b10919（最新 release；master 领先内容不进基线） |
| 表单字段范围 | 常用 5 个进表单：lazyMode / nCpuFfn / mmprojDevice / kvUnifiedPerSlot / logJsonl |
| video-* 三个 | 不进表单，走「附加参数」（`--video-fps 2 --video-ffmpeg-dir D:\ffmpeg` 等） |
| spec-synth-* | 不采用（benchmarking only） |
| updater 改动 | 无。b10919 x64 win 资产命名（`llama-b10919-bin-win-cuda-12.4/13.3-x64.zip`、`cudart-llama-bin-win-cuda-13.3-x64.zip`）与现有 `MAIN_RE`/`pickMainAsset`/`pickCudaAsset` 兼容；CUDA 选 13.3（13.4 仅 arm64 资产） |
| 基线未安装 | 复用现有友好错误（resolveExe 抛「托管基线 b10919 未安装：…」），不新增自动下载逻辑 |
| loadMode label | 「内存 (mlock/mmap)」→「内存加载 (load-mode)」（--mmap/--mlock 已移除） |

## 设计

### 1. 基线 b10488 → b10919

| 位置 | 改动 |
|---|---|
| `src/main/version.ts:5` | `BASELINE_BUILD = 10919`（`versionBanner` 与 `resolveExe` 错误文案经模板自动更新） |
| `src/renderer/main.ts:300-301`（`fillExeOptions`） | `v.tag === 'b10488'` → `'b10919'`；下拉文案「默认（托管基线 b10919）」 |
| `test/version.test.ts:89` | 断言 `BASELINE_BUILD === 10919`（含 banner 文案用例同步） |
| 主规格 `docs/superpowers/specs/2026-07-25-llama-server-launcher-design.md` | 基线表述更新：L12（当前已下载版本）、L160（§5 表单基线）、L302-303（§9.1 基线版本 + 横幅文案），b10488/9d77fa172 → b10919/d3146f2b5；历史实测示例（L130/142/330/341/345/362：HF 量化解析、资产命名示例、tag 解析示例）保持原文不动 |

`src/main/updater.ts` 不改（兼容性已验证，见决策记录）。

### 2. 新增 5 个表单字段

四处同步：`src/shared/types.ts`（FormValues）、`src/main/config.ts`（DEFAULT_FORM）、`src/main/args.ts`（buildArgs）、`src/renderer/main.ts`（GROUPS）。

| 字段 | 控件 | 组（插入位置） | label | 参数 | 空值语义 |
|---|---|---|---|---|---|
| `lazyMode` | select `['','默认(不传)'],['auto','auto'],['on','on'],['off','off']` | 硬件（`loadMode` 后） | 内存按需加载 (lazy-mode) | `--lazy-mode` | `''` = 不传（server 默认 auto） |
| `nCpuFfn` | text | 硬件（`nCpuMoE` 后） | CPU FFN 层数 (n-cpu-ffn) | `--n-cpu-ffn` | `''` = 不传 |
| `mmprojDevice` | text | 模型（`mmprojOffload` 后） | mmproj 设备 (mmproj-device，none=不放 GPU) | `--mmproj-device` | `''` = 跟随 `--device` |
| `kvUnifiedPerSlot` | text | 上下文（`kvUnified` 后） | 每 slot 上下文上限 (kv-unified-per-slot，与 ctx-size 同设时不生效) | `--kv-unified-per-slot` | `''` = 不传 |
| `logJsonl` | checkbox（默认 false） | 高级（`perf` 后） | JSONL 日志 (log-jsonl) | `--log-jsonl` / `--no-log-jsonl`（bool() 恒显式成对） | false → `--no-log-jsonl` |

- 四个带值字段走 `str()`（留空不传），`logJsonl` 走 `bool()`（恒显式，`argToField` 同时登记正/负两个 flag）。
- args.ts 中各 `str()`/`bool()` 插入现有组的对应位置，组顺序与其余参数不变。
- DEFAULT_FORM 新默认：`lazyMode: ''`、`nCpuFfn: ''`、`mmprojDevice: ''`、`kvUnifiedPerSlot: ''`、`logJsonl: false`。
- **migrateForm 无需改动**：JsonStore.load 的 `{...defaults, ...parsed}` 合并对旧配置自动补新字段默认值；无类型修正需求。

### 3. 测试（vitest）

- `test/version.test.ts`：`BASELINE_BUILD === 10919`；`versionBanner` 基线/非基线文案用例同步 b10919。
- `test/args.test.ts` 增补（沿用现有 buildArgs 断言风格）：
  - `lazyMode: 'on'` → argv 含 `--lazy-mode on`；`'auto'`/`'off'` 同；`''` → 不含 `--lazy-mode`
  - `nCpuFfn: '3'` → `--n-cpu-ffn 3`；`''` → 不传
  - `mmprojDevice: 'cuda1'` / `'none'` → 透传；`''` → 不传
  - `kvUnifiedPerSlot: '4096'` → `--kv-unified-per-slot 4096`；`''` → 不传
  - `logJsonl: true` → `--log-jsonl`；`false` → `--no-log-jsonl`（恒显式）
  - 五个字段的 `argToField` 映射正确
- `npm run typecheck` + `npm test` 全绿。

## 非目标

- video-* 与 spec-synth-* 不加表单字段（「附加参数」可传）
- 不为 extraArgs 里的 `--mmap`/`--mlock`/`--dio` 做特判（依赖现有启动失败诊断）
- 不自动下载 b10919（用户手动「检查更新 / 立即更新」）
- 不改 updater / proxy / slot-cache 逻辑
