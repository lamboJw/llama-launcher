# llama-launcher

Windows 桌面版 llama-server 启动器（Electron + TypeScript）。一条命令拉起 llama.cpp 的 `llama-server`，并在其前面套一层反向代理，提供模型管理、参数表单、自动切模型、请求统计等能力。

## 功能

- **模型管理**：本地目录扫描（`.gguf`）+ HuggingFace 缓存扫描，两者合并为模型下拉列表；同名冲突时本地优先
- **启动 llama-server**：托管版本（自动下载 llama.cpp release 到 `llama.cpp/` 目录）或自定义 exe 路径；自动探测 CUDA 目录并注入子进程 PATH；启动后轮询 `/health` 确认就绪
- **反向代理**：server 永远只绑 `127.0.0.1` 内部端口，用户通过可见端口（默认 8080）访问；支持 API Key 鉴权、CORS、SSE 透传
- **自动切换模型**：开启后代理按请求的 `model` 字段自动切换后端模型（切换期间请求排队）
- **参数表单**：模型 / 服务 / 硬件 / 上下文 / 采样 / 投机解码（MTP）/ 高级 七组，覆盖 llama-server 常用参数；留空 = 不传（用 llama.cpp 默认值）
- **参数档案（profiles）**：每个模型一份参数快照，启动时自动保存，切换模型自动应用
- **轮次记录**：可选记录每轮 prompt/decode 的 token 与耗时，倒序分页查看
- **请求统计**：最近请求与历史统计（耗时、token 数）
- **llama.cpp 版本管理**：检查 GitHub release、下载安装、多版本共存、版本横幅提示
- **可设置数据目录**：config / profiles / records 的保存位置可在设置中修改（默认 `app_data/`），修改后重启生效；首次启动自动迁移旧版 `%APPDATA%` 数据

## 开发

```bash
npm install
npm run dev        # 构建 + 启动 Electron
npm test           # vitest（168 个测试）
npm run typecheck  # tsc --noEmit
```

## 打包（便携 zip）

```bash
npm run package
```

产物：`release/llama-launcher-<version>-portable-win32-x64.zip`，解压即用，根目录为 `llama_launcher/`。llama.cpp 托管目录 `llama_launcher/llama.cpp/` 在首次启动时自动创建（点「检查更新 / 立即更新」下载）。

## 目录结构

```
src/
  main/        主进程：config、args（命令行组装）、server-controller、
               process-manager、proxy（反向代理）、profiles、records、
               updater、scan（本地/HF 模型扫描）、stats
  preload/     预加载桥
  renderer/    渲染层：表单 UI、日志（ANSI 着色）、统计面板
  shared/      主/渲染共享类型（FormValues 等）
test/          vitest 测试（纯 Node，不依赖 Electron）
scripts/       copy-assets、zip-release
docs/          设计规格与实施计划
llama.cpp/     托管的 llama.cpp 版本与 CUDA 目录（运行时生成，不入库）
app_data/      应用数据：config.json、profiles/、records/、userData/（运行时生成，不入库）
```

## 配置位置

- 应用配置：`<app>/app_data/config.json`（表单 + 上次模型）
- 参数档案：`<数据目录>/profiles/`
- 轮次记录：`<数据目录>/records/`
- Chromium 缓存：`<数据目录>/userData/`

`<app>` 为应用所在目录（开发模式为仓库根目录），`<数据目录>` 默认为 `<app>/app_data/`，可在设置「数据目录」中修改（重启后生效）。旧版 `%APPDATA%/llama-launcher/` 的数据在首次启动时自动复制到新位置（复制不移动，旧目录保留）。

## 技术栈

Electron 43 · TypeScript 5 · vitest · electron-builder；运行时依赖仅 `adm-zip`（打包脚本用）。
