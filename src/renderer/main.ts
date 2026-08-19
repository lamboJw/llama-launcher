// renderer/main.ts — 占位界面（Task 15-17 替换为完整 UI：布局 §3 / 彩色日志 / 统计 / 聊天 / 轮次记录）
declare global {
  interface Window {
    llama: {
      boot(): Promise<{ server: { status: string; port: number | null; model: string | null }; form: unknown }>;
      startServer(form: unknown, model: unknown): Promise<void>;
      stopServer(): Promise<void>;
      saveForm(form: unknown): Promise<void>;
      on(channel: string, cb: (payload: unknown) => void): () => void;
    };
  }
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  app.textContent = '正在连接主进程…';
  try {
    const state = await window.llama.boot();
    const srv = state.server;
    app.textContent = `主进程已连接 | server: ${srv.status}${srv.port ? ` :${srv.port}` : ''}${srv.model ? ` ${srv.model}` : ''}`;
    window.llama.on('state:change', (p: unknown) => {
      const s = p as { status: string; port: number | null; model: string | null };
      app.textContent = `state:change → ${s.status}${s.port ? ` :${s.port}` : ''}${s.model ? ` ${s.model}` : ''}`;
    });
  } catch (e) {
    app.textContent = `主进程连接失败: ${String(e)}`;
  }
}
void main();
export {};
