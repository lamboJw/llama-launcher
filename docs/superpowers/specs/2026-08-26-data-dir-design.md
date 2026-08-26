# 可设置的数据保存路径 — 设计

日期：2026-08-26
状态：已确认

## 背景

应用数据（config.json、profiles/、records/）当前硬编码在 `%APPDATA%/llama-launcher/`
（`defaultConfigDir()`，src/main/config.ts:81）。本设计将其改为可设置，
默认位置改为项目根目录（appRoot）下的 `app_data/` 文件夹，使便携版数据随应用目录走。

appRoot 定义（沿用现状，src/main/index.ts:67）：
- 打包：exe 所在目录
- 开发：`process.cwd()`

## 决策记录

| 问题 | 决定 |
|---|---|
| 覆盖范围 | config.json + profiles/ + records/（llama.cpp 托管目录已在 appRoot，不动） |
| 路径设置存哪 | 固定在 `appRoot/app_data/config.json` 内（`form.dataDir` 字段），启动从这里读取 |
| config.json 是否随 dataDir 走 | 不随。永远固定在 `appRoot/app_data/config.json`；只有 profiles/ 和 records/ 跟随 dataDir |
| 旧数据迁移 | 复制不移动，一次性，幂等 |
| 修改后生效方式 | 保存后提示「重启后生效」，不做运行时热迁移 |
| Chromium userData 缓存 | 一并搬走：`app.setPath('userData', join(dataDir, 'userData'))`，不迁移旧缓存（可再生） |

## 设计

### 1. 路径解析

- `config.json` 固定位置：`appRoot/app_data/config.json`。
  `AppConfig` 构造时传入该目录（不再用 `defaultConfigDir()` 的 %APPDATA% 逻辑；
  `defaultConfigDir()` 保留仅供迁移逻辑引用旧位置）。
- `dataDir` 解析规则：
  - `form.dataDir === ''` → `appRoot/app_data`（默认）
  - 非空 → `path.resolve(form.dataDir)`
- `profiles/` → `join(dataDir, 'profiles')`（ProfilesStore）
- `records/` → `join(dataDir, 'records')`（RecordsStore）
- Chromium userData → `join(dataDir, 'userData')`，通过 `app.setPath('userData', ...)` 设置。
  必须在 `app ready` 前调用；config 读取为同步（readFileSync），时序可行。

### 2. 类型变更（src/shared/types.ts）

`FormValues` App 级新增：

```ts
dataDir: string;   // 数据目录；'' = 默认 appRoot/app_data
```

`DEFAULT_FORM`（src/main/config.ts）同步新增 `dataDir: ''`。
（与 scanDir/hfCacheDir 等 App 级字段同模式；会被 profile 保存携带，与现状一致，可接受。）

### 3. 旧数据迁移

纯函数 `migrateLegacyData(oldDir: string, newDir: string): void`（建议放 config.ts）：

- 仅当 `newDir/config.json` 不存在且 `oldDir/config.json` 存在 → 复制该文件
- 仅当 `newDir/profiles` 不存在且 `oldDir/profiles` 存在 → 递归复制目录
- `records/` 同理
- 旧处全部保留（复制不移动）；目标已存在即跳过（幂等）
- 旧目录整体不存在（全新安装）→ 无操作
- 单项复制失败不抛异常（日志警告即可，不阻塞启动）

`oldDir` = 现 `defaultConfigDir()`（%APPDATA%/llama-launcher）。
Chromium 缓存（Cache/、GPUCache/、Local Storage/ 等）不迁移，新 userData 位置自动重建。

### 4. UI（App 组，src/renderer/main.ts）

- `buildForm()` 的 App 组新增：`buildDirField('dataDir', '数据目录（重启后生效）')`
- 保存走现有 `scheduleSave` 流程，无新增 IPC
- 重启后 `records-dir` 等展示随新路径刷新（现有逻辑已按 main 推送值渲染）

### 5. 错误处理

- 启动时若 `dataDir` 无法创建（如路径被同名文件占用）→ 回退默认 `appRoot/app_data`，
  写日志警告；userData 设置同步使用回退后的目录
- 迁移单项失败 → 日志警告，继续启动

### 6. 启动顺序（src/main/index.ts）

```
1. appDataDir = join(appRoot(), 'app_data')
2. migrateLegacyData(defaultConfigDir(), appDataDir)
3. config = new AppConfig(appDataDir)
4. dataDir = resolveDataDir(config.getSettings().form.dataDir)   // 含回退逻辑
5. app.setPath('userData', join(dataDir, 'userData'))
6. profiles = new ProfilesStore(join(dataDir, 'profiles'))
7. recordsDir = join(dataDir, 'records')
```

注：现状 `config`/`profiles`/`recordsDir` 在模块顶层、`appRoot` 定义之前创建，
需调整声明顺序（appRoot 为 const 箭头函数，存在 TDZ 约束）。

### 7. 测试

- `migrateLegacyData` 单测（test/config.test.ts 或新文件）：
  - 旧目录不存在 → 无操作
  - 目标不存在 + 源存在 → 复制（文件/目录各一）
  - 目标已存在 → 跳过（源内容不被覆盖）
  - 源单项缺失 → 跳过该项，其余正常
- `resolveDataDir` 单测：空串 → 默认；相对路径 → resolve；绝对路径 → 原样
- 现有 config/profiles/records 测试：目录均为注入参数，基本不动

## 非目标

- 运行时热迁移（改路径需重启）
- llama.cpp 托管目录纳入数据路径
- Chromium 旧缓存迁移
- dataDir 的 UI 实时校验（无效路径在下次启动回退并告警）
