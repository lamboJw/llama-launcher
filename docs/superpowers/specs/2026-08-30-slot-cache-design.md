# Slot 上下文自动保存 / 恢复 — 设计

日期：2026-08-30
状态：已确认（写入项目目录待授权；当前位于会话工作区）

## 背景

llama-server（b10636 级别构建起）支持通过 slots API 保存 / 恢复 slot 的 prompt cache（KV 缓存）：

- `POST /slots/{id_slot}?action=save`，JSON body `{"filename": "<文件名>"}`
- `POST /slots/{id_slot}?action=restore`，JSON body `{"filename": "<文件名>"}`

文件落在 `--slot-save-path` 指定的目录内；server 未带 `--slot-save-path` 启动时 action 被拒绝
（`This server does not support slots action. Start it with `--slot-save-path``）。

现状：表单已有 `slotSavePath`（→ `--slot-save-path`）与 `slots`（→ `--slots`）字段并透传，
但保存 / 恢复需手动调 API。本设计将其自动化：

1. **保存**：停止 server 前（停止按钮 / 关窗退出 / 重启换模型 / autoSwitch 切换），
   保存**全部 slot** 的上下文，文件名以模型名称命名；
2. **恢复**：启动后若存在当前模型的存档，自动恢复到对应 slot。

## 决策记录

| 问题 | 决定 |
|---|---|
| 保存范围 | 全部 slot（支持 parallel>1）；文件名 `<模型名>_<slotId>.bin` |
| API 格式 | POST + JSON body `{"filename": ...}`，action 走 query 参数（用户确认） |
| 文件后缀 | `.bin`（用户指定） |
| 保存时机 | 停止 / 退出 / **模型切换前**（切换 = 先存旧模型再起新模型） |
| 保存目录 | 表单 `slotSavePath` 原样使用；为空则本功能禁用（不自动设默认目录） |
| 退出体验 | 关窗拦截：窗口内显示「保存 slot 上下文中…（已用时 Xs）」，保存完成 / 失败后才退出 |
| UI 反馈 | 日志面板 `[launcher]` 行 + 顶栏状态文字 + 启动 / 停止按钮置灰 |
| 失败策略 | save / restore 失败只记日志，绝不阻塞停止 / 启动 |

## 设计

### 1. 新模块 src/main/slot-cache.ts

纯 Node 模块（无 Electron 依赖），可用 fake-server.mjs 单测。

**文件名规则**

- `sanitizeModelName(name: string): string`
  - `\/:*?"<>|` 替换为 `_`（Windows 非法字符；HF repo 名含 `/`）
  - 去尾部点号与空白；净化后为空 → 回退 `model`
- `slotFileName(model: string, slotId: number): string` → `<净化名>_<slotId>.bin`
  - 例：`JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` + slot 0 → `JonathanColetti_Qwen3.8-27B-Uncensored-GGUF_0.bin`
- `findSlotSaves(dir: string, model: string): Map<number, string>`
  - 扫描 `dir` 下匹配 `<净化名>_<id>.bin`（id 为非负整数）的文件，返回 Map(slotId → 绝对路径)

**SlotCache 类**

```ts
export interface SlotCacheOpts {
  dir: string;        // --slot-save-path 目录（非空）
  apiKey?: string;    // form.apiKey；非空时请求带 Authorization: Bearer
  timeoutMs?: number; // 单请求超时，默认 10 分钟
  onLog?: (line: string) => void;
}

export class SlotCache {
  constructor(opts: SlotCacheOpts);
  /** GET /slots → slot id 列表；404 / 错误 → 抛错（调用方记日志并跳过） */
  listSlots(port: number): Promise<number[]>;
  /** 保存全部 slot：逐 slot save；单 slot 失败 → 记日志继续；全部失败 → 抛错 */
  saveAll(port: number, model: string): Promise<void>;
  /** 恢复全部：仅恢复当前 server 存在的 slot；slot 缺失跳过并记日志；无存档 → 无操作 */
  restoreAll(port: number, model: string): Promise<void>;
}
```

- 请求格式：
  - `GET http://127.0.0.1:<port>/slots` → 解析 JSON `slots[].id`
  - `POST http://127.0.0.1:<port>/slots/<id>?action=save|restore`，
    `Content-Type: application/json`，body `{"filename": "<basename>"}`
  - `apiKey` 非空 → 带 `Authorization: Bearer <apiKey>`
  - 每请求 AbortController 超时（默认 10 分钟），超时按失败处理
  - 非 2xx：读取响应体（错误信息）入日志
- 日志（onLog，`[launcher]` 前缀）：
  - 保存开始（模型、目录）、每文件成功 / 失败、汇总（文件数、总大小、耗时）
  - 恢复开始、每文件结果、汇总、跳过说明（slot 缺失 / 无存档）

### 2. ServerController 集成（src/main/server-controller.ts）

- `ControllerEvents` 新增 `onSlotPhase?: (phase: 'saving' | 'restoring' | null, model: string | null) => void`
- `ServerController` 新增 `setSlotCache(sc: SlotCache | null): void`（null = 功能禁用）

**stop()**：`pm.stop()` 之前：

```
if (slotCache && pm.running && (status === 'running' || status === 'switching')) {
  onSlotPhase('saving', state.model)
  try { await slotCache.saveAll(port, state.model) }
  catch (e) { onLog('[launcher] 保存 slot 上下文失败：<e>（继续停止）') }
  finally { onSlotPhase(null, null) }
}
```

- 仅 running / switching 时保存：启动失败路径（status=starting，catch 里直接 pm.stop()）不保存
- 保存失败绝不阻塞停止

**start()**：`waitForHealth` 成功后、`setState(running)` 之前：

```
if (slotCache && findSlotSaves(slotCache.dir, req.model.name).size > 0) {
  onSlotPhase('restoring', req.model.name)
  try { await slotCache.restoreAll(port, req.model.name) }
  catch (e) { onLog('[launcher] 恢复 slot 上下文失败：<e>（空上下文继续）') }
  finally { onSlotPhase(null, null) }
}
```

- 恢复期间状态仍为 'starting'（代理尚未启动，外部请求进不来，无并发冲突）

**全部停 server 路径覆盖**（均经由 start / stop）：

| 路径 | 保存 | 恢复 |
|---|---|---|
| 停止按钮（IPC server:stop） | ✓ 当前模型 | — |
| 关窗退出 | ✓ 当前模型 | — |
| 重启换模型（startServer） | ✓ 旧模型（先 stop） | ✓ 新模型 |
| autoSwitch（proxy → switchTo） | ✓ 旧模型 | ✓ 新模型 |

### 3. index.ts 编排（src/main/index.ts）

**启用功能**（`startServer` 内，`ctl.start` 之前）：

```
const dir = form.slotSavePath.trim();
if (dir !== '') {
  fs.mkdirSync(dir, { recursive: true });
  ctl.setSlotCache(new SlotCache({ dir, apiKey: form.apiKey, onLog: pushLog }));
} else {
  ctl.setSlotCache(null);  // 日志提示：未设置 slot-save-path，slot 上下文保存已禁用
}
```

（`--slot-save-path` 已由 args.ts 按 form.slotSavePath 透传，无需改动。）

**关窗拦截**（新增 `win.on('close')`）：

- `quitPhase: 'idle' | 'saving' | 'final'` 状态机
- close 事件：
  - `final` → 放行
  - `saving` → preventDefault（保存期间忽略重复点 X）
  - `idle` 且功能启用且 server 处于 running / switching → preventDefault，置 `saving`，
    执行 `stopServer()`（含保存）→ 置 `final` → `app.quit()`
  - 其余（功能禁用或 server 未运行）→ 放行关闭，由 `window-all-closed` 现有逻辑处理
- `window-all-closed` 保留现有逻辑（stop + quit），作为不保存路径的兜底

### 4. UI（src/renderer/main.ts、src/preload/index.ts、src/shared/types.ts）

- `shared/types.ts`：`export interface SlotPhaseEvent { phase: 'saving' | 'restoring' | null; model: string | null }`
- preload：EVENTS 白名单加 `'slot:phase'`（经现有 `on` 方法暴露，无新增 API）
- index.ts：`onSlotPhase` 时 `send('slot:phase', ...)`
- 顶栏状态区：
  - phase=saving → badge 显示「保存 slot 上下文中…（Xs）」（yellow）；
    restoring →「恢复 slot 上下文中…（Xs）」（cyan）
  - Xs 由渲染端 1s 计时（收到事件时记开始时间）
  - 期间启动 / 停止按钮置灰（renderState 的 busy 判定扩展）
  - phase=null → 恢复正常状态显示
- 日志面板：`[launcher]` 行（现有 log:lines 通道，无新通道）
- 表单字段 `slotSavePath` 标签补充说明：「Slot KV 缓存保存路径 (slot-save-path，slot 上下文自动保存/恢复需设置)」

### 5. 错误处理与边界

| 场景 | 行为 |
|---|---|
| save / restore 失败（server 报错 / 超时 / 网络） | 只记日志，不阻塞停止 / 启动 |
| `slotSavePath` 为空 | 功能禁用：无 HTTP 调用、无关窗拦截、无状态显示 |
| 未勾选 `slots` 端点（server 无 --slots） | `GET /slots` 404 → 跳过保存 / 恢复 + 日志提示 |
| 保存的 slot 数 > 当前 slot 数 | 只恢复当前 server 存在的 slot，跳过项记日志 |
| 保存被强杀中断（残留半截 .bin） | 下次 restore 被 server 拒绝（Invalid tokens）→ 记日志，空上下文继续 |
| slot 忙（生成进行中）时保存 | server 拒绝则记日志继续 |
| llama.cpp 版本过旧无 slots action API | 请求 404 / 报错 → 记日志继续（功能需 b10636 级别构建） |
| 同名模型不同量化（HF repo 名不含量化） | 可能恢复到过期存档 → server 拒绝（安全失败），不自动清理 |
| autoSwitch 排队 | 保存耗时计入排队等待（默认 5 分钟上限），超时走现有 503 逻辑 |

### 6. 测试（vitest）

**fake-server.mjs 扩展**：

- `GET /slots` → `{"default":0,"slots":[{"id":0},{"id":1}]}`（slot 数可用 env FAKE_SLOTS_N 配置，默认 2）
- `POST /slots/<id>?action=save` → 校验 JSON body filename；向 `FAKE_SLOT_DIR` 目录写同名标记文件；
  `FAKE_SLOT_FAIL=1` → 500
- `POST /slots/<id>?action=restore` → 校验 body；`FAKE_SLOT_DIR` 中无对应标记文件 → 400；
  `FAKE_SLOT_FAIL=1` → 500

**test/slot-cache.test.ts（新增）**：

- `sanitizeModelName`：`a/b:c*d?e"f<g>h|i` → `a_b_c_d_e_f_g_h_i`；尾部点号去除；
  空串 → `model`；`unsloth/Qwen3.8-27B-GGUF` → `unsloth_Qwen3.8-27B-GGUF`（点保留）
- `slotFileName`：model + 0 → `<净化名>_0.bin`
- `findSlotSaves`：临时目录放 `_0.bin` / `_1.bin` → Map{0,1}；无关文件忽略；目录不存在 → 空 Map
- `saveAll`（真实 spawn fake-server）：2 slot → 2 个标记文件（名称正确）；FAKE_SLOT_FAIL → 抛错
- `restoreAll`：无存档 → 无请求；有存档 → 200；slot 不存在的存档 → 跳过（无请求）

**test/server-controller.test.ts（增补）**：

- 启用 slot cache 时 stop → 进程退出前标记文件已生成（保存先于 kill）
- 存在存档时 start → 触发 restore（fake-server 校验文件存在返回 200），状态 running
- restore 失败（FAKE_SLOT_FAIL）→ 启动仍成功（running）
- save 失败（FAKE_SLOT_FAIL）→ 停止仍完成（stopped）
- slot cache 禁用（setSlotCache(null)）→ fake-server 收不到任何 /slots 请求

## 非目标

- 保存进度百分比（llama-server save 为同步阻塞，只能显示已用时秒数）
- 过期存档自动清理（用户自行管理 slot_cache 目录）
- 崩溃时保存（server 已死，API 不可用）
- 文件名按量化区分（HF repo 名不含量化；过期存档由 server 拒绝兜底）
- 手动保存 / 恢复的 UI 按钮（全自动，无手动入口）
