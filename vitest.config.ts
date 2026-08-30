// vitest.config.ts — 测试配置
// fake-server 测试从 59999 起探测端口（probeFreePort）；并行跑多个测试文件时
// 可能同时探到同一端口 → 后绑定的 fake-server EADDRINUSE 退出（code 1）→ 偶发失败。
// 串行执行测试文件消除该竞态。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
