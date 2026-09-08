// pnpm commands:register
//
// 註冊 slash 指令。獨立於 Bot 主程式,因為它是部署動作而不是執行期行為:
// 指令定義改了才要跑,平常重啟 Bot 不該去動 Discord 上的註冊。

import { loadConfig } from '../config/env.ts';
import { createLogger } from '../shared/log.ts';
import { buildRegistry } from '../routing/bootstrap.ts';
import { ActivityBackend } from '../activity/backend.ts';
import { collectCommands, registerCommands } from '../commands/register.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel }, { service: 'stentor-register' });

  const registry = buildRegistry(config.activityRoutes);
  const activity = new ActivityBackend({
    serviceToken: config.platformServiceToken,
    timeoutMs: config.backendTimeoutMs,
  });

  const collected = await collectCommands(registry, activity, log);
  if (collected.problems.length > 0) {
    for (const problem of collected.problems) log.error('指令註冊檢查', { problem });
    // 部分成功比全部失敗難查:寧可什麼都不註冊,也不要蓋掉線上正確的定義。
    process.exitCode = 1;
    return;
  }

  await registerCommands(config, collected.commands, log);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`指令註冊失敗:${message}\n`);
  process.exit(1);
});
