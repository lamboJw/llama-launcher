// server-controller.ts — llama-server 生命周期与模型切换编排（规格 §2.2/§2.3/§5.4）
// 纯 Node（ProcessManager 注入），fake-server.mjs 可单测；实现代理的 SwitchController 接口
import path from 'node:path';
import { buildArgs } from './args.js';
import { probeFreePort, ProcessManager, type ExitInfo } from './process-manager.js';
import type { SwitchController } from './proxy.js';
import type { FormValues, ModelRef, ServerState, SwitchState } from '../shared/types.js';

export interface StartRequest {
  exe: string;
  form: FormValues;
  model: ModelRef;
  /** 托管 CUDA 目录（加入子进程 PATH 前置）；自定义 exe 传 null（规格 §9.2） */
  cudaDir: string | null;
  /** 测试注入：按探测端口追加环境变量（如 FAKE_PORT）；应用端不用 */
  extraEnv?: (port: number) => Record<string, string>;
  /** 测试注入：argv 前缀（如 fake-server 脚本路径）；应用端不用 */
  extraArgvPrefix?: string[];
}

export interface ControllerEvents {
  onStateChange?: (s: ServerState) => void;
  onLog?: (line: string) => void;
  onExit?: (info: ExitInfo) => void;
  onSwitch?: (s: SwitchState) => void;
}

export class ServerController implements SwitchController {
  private pm: ProcessManager;
  private events: ControllerEvents;
  private healthTimeoutMs: number;
  private state: ServerState = { status: 'stopped', port: null, model: null, exitCode: null };
  private port = 0;
  private lastReq: StartRequest | null = null;
  private _switching = false;
  private unionList: ModelRef[] = [];

  constructor(pm: ProcessManager, events: ControllerEvents = {}, healthTimeoutMs = 300000) {
    this.pm = pm;
    this.events = events;
    this.healthTimeoutMs = healthTimeoutMs;
  }

  // ---- SwitchController（代理注入）----
  internalPort(): number | null {
    const s = this.state.status;
    return s === 'running' || s === 'starting' || s === 'switching' ? this.port : null;
  }
  isReady(): boolean { return this.state.status === 'running'; }
  currentModel(): string | null { return this.state.model; }
  union(): ModelRef[] { return this.unionList; }
  switching(): boolean { return this._switching; }
  setUnion(models: ModelRef[]): void { this.unionList = models; }
  getState(): ServerState { return { ...this.state }; }

  private setState(patch: Partial<ServerState>): void {
    this.state = { ...this.state, ...patch };
    this.events.onStateChange?.(this.getState());
  }

  private handleExit(info: ExitInfo): void {
    if (info.intentional) return;
    const s = this.state.status;
    if (s !== 'running' && s !== 'starting' && s !== 'switching') return;
    this.setState({ status: 'crashed', port: null, exitCode: info.code });
    this.events.onExit?.(info);
  }

  /** 启动（运行中则重启）；失败时清理并抛出（规格 §2.2：spawn → 起代理 → /health 就绪） */
  async start(req: StartRequest): Promise<void> {
    const busy = this.state.status === 'starting' || this.state.status === 'running' || this.state.status === 'switching';
    if (busy) await this.stop();
    this.setState({ status: 'starting', port: null, model: req.model.name, exitCode: null });
    try {
      const port = await probeFreePort();
      this.port = port;
      const built = buildArgs(req.form, req.model, port);
      const env: Record<string, string> = { ...built.env, ...(req.extraEnv ? req.extraEnv(port) : {}) };
      if (req.cudaDir) env.PATH = `${req.cudaDir}${path.delimiter}${process.env.PATH ?? ''}`;
      await this.pm.start({
        exe: req.exe,
        argv: [...(req.extraArgvPrefix ?? []), ...built.argv],
        env,
        port,
        onLine: (line) => this.events.onLog?.(line),
        onExit: (info) => this.handleExit(info),
      });
      this.lastReq = req;
      await this.pm.waitForHealth(this.healthTimeoutMs);
      this.setState({ status: 'running', port, model: req.model.name, exitCode: null });
    } catch (e) {
      await this.pm.stop().catch(() => {});
      this.setState({ status: 'stopped', port: null, exitCode: null });
      throw e;
    }
  }

  /** 模型切换（规格 §5.4）：停旧 → 起新 → 等健康；失败抛出（代理回 502，状态回 stopped） */
  async switchTo(model: ModelRef): Promise<void> {
    if (this._switching) throw new Error('switch already in progress');
    const cur = this.state.model;
    if (cur !== null && model.name.toLowerCase() === cur.toLowerCase()) return; // 同模型（忽略大小写）不重启
    const last = this.lastReq;
    if (!last) throw new Error('server not started');
    this._switching = true;
    this.events.onSwitch?.({ switching: true, from: this.state.model, to: model.name });
    this.setState({ status: 'switching', exitCode: null });
    try {
      await this.start({ ...last, model });
    } finally {
      this._switching = false;
      this.events.onSwitch?.({ switching: false, from: null, to: null });
    }
  }

  /** 停止（规格 §2.3）；切换期间停止 = 取消切换（杀掉新 server，回到 stopped） */
  async stop(): Promise<void> {
    if (this.pm.running) await this.pm.stop();
    this.setState({ status: 'stopped', port: null, exitCode: null });
  }
}
