// ansi.ts — 极简 SGR(ANSI) → HTML 转换器（覆盖 llama-server --log-colors 输出）
// 计划偏差：npm ansi-to-html@0.7.2 仅 CJS 无浏览器 bundle，引入需额外打包器；llama.cpp 的 SGR 子集很小，内联实现
const PALETTE: Record<number, string> = {
  30: '#5c6370', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#dcdfe4',
  90: '#7f848e', 91: '#ff7b86', 92: '#b8e09a', 93: '#f0d088', 94: '#82c4ff', 95: '#d89af0', 96: '#7fd8e8', 97: '#ffffff',
};

const CUBE = [0, 95, 135, 175, 215, 255];

/** 把一行（可含多段 SGR）原始日志转成 HTML（自动转义 & < >） */
export function ansiHtml(raw: string): string {
  let out = '';
  let buf = '';
  let fg: string | null = null;
  let bold = false;
  const flush = (): void => {
    if (buf === '') return;
    const esc = buf.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const style = (fg ? `color:${fg};` : '') + (bold ? 'font-weight:700;' : '');
    out += style !== '' ? `<span style="${style}">${esc}</span>` : esc;
    buf = '';
  };
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\u001b' && raw[i + 1] === '[') {
      const end = raw.indexOf('m', i + 2);
      if (end === -1) { buf += raw.slice(i); break; }
      const codes = raw.slice(i + 2, end).split(';').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
      flush();
      for (let k = 0; k < codes.length; k++) {
        const c = codes[k];
        if (c === 0) { fg = null; bold = false; }
        else if (c === 1) { bold = true; }
        else if (c === 22) { bold = false; }
        else if (c >= 30 && c <= 37) { fg = PALETTE[c] ?? null; }
        else if (c >= 90 && c <= 97) { fg = PALETTE[c] ?? null; }
        else if (c === 38 || c === 48) {
          if (codes[k + 1] === 5 && codes[k + 2] !== undefined) {
            const n = codes[k + 2];
            if (n >= 16 && n <= 231) {
              const v = n - 16;
              fg = `rgb(${CUBE[Math.floor(v / 36)]},${CUBE[Math.floor((v % 36) / 6)]},${CUBE[v % 6]})`;
            } else if (n >= 232) {
              const x = 8 + (n - 232) * 10;
              fg = `rgb(${x},${x},${x})`;
            } else if (c === 38) { fg = PALETTE[n + 30] ?? null; }
            k += 2;
          } else if (codes[k + 1] === 2 && c === 38) {
            fg = `rgb(${codes[k + 2]},${codes[k + 3]},${codes[k + 4]})`;
            k += 4;
          }
        }
      }
      i = end + 1;
    } else {
      buf += raw[i];
      i++;
    }
  }
  flush();
  return out;
}

export function ansiTestLine(): string {
  return '\u001b[0;32m  prompt eval    time =    100.00 ms /    10 tokens   \u001b[0m | \u001b[0;94m eval count    =    20 tokens  \u001b[0m | \u001b[0;31merror line\u001b[0m';
}
