// preload/index.ts — contextBridge API（CJS 编译，规格 §3 顶栏/左栏/右栏全部交互）
import { contextBridge, ipcRenderer } from 'electron';

const EVENTS = ['state:change', 'log:lines', 'switch:change', 'stats:request', 'stats:round', 'update:progress', 'banner:change', 'exit:crash'] as const;

contextBridge.exposeInMainWorld('llama', {
  boot: (): Promise<unknown> => ipcRenderer.invoke('app:boot'),
  scanModels: (dir: string): Promise<unknown> => ipcRenderer.invoke('models:scan', dir),
  scanHf: (dir: string): Promise<unknown> => ipcRenderer.invoke('hf:scan', dir),
  startServer: (form: unknown, model: unknown): Promise<void> => ipcRenderer.invoke('server:start', { form, model }),
  stopServer: (): Promise<void> => ipcRenderer.invoke('server:stop'),
  saveForm: (form: unknown): Promise<void> => ipcRenderer.invoke('form:save', form),
  listProfiles: (): Promise<unknown> => ipcRenderer.invoke('profiles:list'),
  saveProfile: (model: string, params: unknown): Promise<void> => ipcRenderer.invoke('profiles:save', { model, params }),
  loadProfile: (model: string): Promise<unknown> => ipcRenderer.invoke('profiles:load', model),
  deleteProfile: (model: string): Promise<void> => ipcRenderer.invoke('profiles:delete', model),
  recordFiles: (): Promise<unknown> => ipcRenderer.invoke('records:files'),
  recordsTail: (page: number): Promise<unknown> => ipcRenderer.invoke('records:tail', page),
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
  runUpdate: (tag: string): Promise<unknown> => ipcRenderer.invoke('updater:run', tag),
  openDirDialog: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:dir', defaultPath),
  getStats: (): Promise<unknown> => ipcRenderer.invoke('stats:get'),
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!(EVENTS as readonly string[]).includes(channel)) return () => {};
    const listener = (_e: unknown, payload: unknown): void => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
});
export {};
