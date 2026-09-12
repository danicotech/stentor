// 進入點。
//
// 順序就是 CLAUDE.md 寫的那三件事:
//   1. 讀設定(含 ACTIVITY_ROUTES 的前綴註冊表)
//   2. 建 Discord client,把 interaction 交給 gateway/
//   3. 起 outbox consumer,把事件送到頻道
//
// 這裡不該出現任何活動規則。判準見 scripts/check-boundaries.mjs。

import { loadConfig, redact } from './config/env.ts';
import { createLogger } from './shared/log.ts';
import { buildRegistry } from './routing/bootstrap.ts';
import { createPlatformClients } from './platform/client.ts';
import { PlatformBackend } from './commands/platform-backend.ts';
import { ActivityBackend } from './activity/backend.ts';
import { Dispatcher } from './gateway/dispatcher.ts';
import { createGateway } from './gateway/discord.ts';
import { VoiceRecorder } from './activitylog/voice.ts';
import { MessageRecorder } from './activitylog/messages.ts';
import { AnnouncementDispatcher } from './consumers/announcements.ts';
import { AnnouncementPuller } from './consumers/puller.ts';
import { collectCommands, registerCommands } from './commands/register.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel }, { service: 'stentor' });
  log.info('設定載入完成', redact(config));

  const registry = buildRegistry(config.activityRoutes);
  log.info('路由註冊完成', { prefixes: registry.prefixes() });

  const clients = createPlatformClients({
    baseUrl: config.platformApiUrl,
    serviceToken: config.platformServiceToken,
    timeoutMs: config.backendTimeoutMs,
  });

  const activity = new ActivityBackend({
    serviceToken: config.platformServiceToken,
    timeoutMs: config.backendTimeoutMs,
  });

  const dispatcher = new Dispatcher({
    registry,
    backends: {
      platform: new PlatformBackend({
        clients,
        webBaseUrl: config.webBaseUrl,
      }),
      activity,
    },
    log,
  });

  const voice = new VoiceRecorder({ clients, log });
  const messages = new MessageRecorder({
    clients,
    log,
    batchSize: config.messageBatchSize,
    contentEnabled: config.messageContentIntent,
  });

  const gateway = createGateway({ config, dispatcher, voice, messages, log });

  const announcements = new AnnouncementDispatcher({
    publisher: gateway.publisher,
    log,
  });
  // 開機時自動貼規則公告的那段已移除:頻道對應現在存在 hestia 的
  // space_channel_purposes,閘道沒有(也不該有)查表的能力。
  // 文案仍在 announce/rules.ts,由 /privacy notice 使用;要自動貼的話
  // 應該由 hestia 發一則帶頻道的 outbox 事件,而不是讓閘道自己決定貼哪裡。

  // 真正的 outbox 公告從 hestia 的 NotificationService 拉。
  // 迴圈不 await:它跑到關機為止,await 會讓 main 永遠回不來。
  const puller = new AnnouncementPuller({
    client: clients.notification,
    dispatcher: announcements,
    log,
  });

  const flushTimer = setInterval(() => {
    void messages.flush();
  }, config.messageFlushMs);
  flushTimer.unref();

  await gateway.login();

  // 指令註冊放在登入之後:活動服務的 DescribeCommands 可能要等它們先起來。
  const collected = await collectCommands(registry, activity, log);
  for (const problem of collected.problems) log.error('指令註冊檢查', { problem });
  if (collected.problems.length === 0) {
    await registerCommands(config, collected.commands, log);
  } else {
    log.error('指令有問題,這輪不註冊(避免蓋掉線上正確的定義)');
  }

  // 取貨迴圈放在最後:先確定 Discord 連上、頻道可用,再開始認領事件。
  // 反過來的話,認領到的公告會因為還沒登入而貼不出去,白白吃掉一次可見性逾時。
  void puller.run().catch((err: unknown) => {
    log.error('公告取貨迴圈異常結束', {
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  });

  const shutdown = (signal: string): void => {
    log.info('收到關機訊號', { signal });
    clearInterval(flushTimer);
    puller.stop();
    void messages
      .flush()
      .catch(() => undefined)
      .then(() => gateway.destroy())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`stentor 啟動失敗:${message}\n`);
  process.exit(1);
});
