// 临时验证脚本：测量长日志下页面/日志区的滚动行为（无头 Electron）
import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(fileURLToPath(new URL('../dist/renderer/index.html', import.meta.url)));
  await new Promise((r) => setTimeout(r, 400)); // 等 renderer 初始化（IPC 缺失会报错，不影响布局）
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const frag = [];
      for (let i = 0; i < 5000; i++) frag.push('<div class="log-line">llama.cpp log line with some numbers 1234567890 and text to be long ' + i + '</div>');
      document.getElementById('log-view').innerHTML = frag.join('');
      const lv = document.getElementById('log-view');
      const main = document.getElementById('main');
      const tab = document.querySelector('.tab');
      return {
        pageScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight,
        docClient: document.documentElement.clientHeight,
        docScrollH: document.documentElement.scrollHeight,
        bodyClient: document.body.clientHeight,
        bodyScrollH: document.body.scrollHeight,
        mainH: main.getBoundingClientRect().height,
        tabH: tab.getBoundingClientRect().height,
        logViewClient: lv.clientHeight,
        logViewScrollH: lv.scrollHeight,
      };
    })()
  `);
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
});
