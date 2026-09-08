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
import { missingCapabilities, unavailablePorts } from './platform/ports.ts';
import { PlatformBackend } from './commands/platform-backend.ts';
import { ActivityBackend } from './activity/backend.ts';
import { Dispatcher } from './gateway/dispatcher.ts';
import { createGateway } from './gateway/discord.ts';
import { VoiceRecorder } from './activitylog/voice.ts';
import { MessageRecorder } from './activitylog/messages.ts';
import { AnnouncementDispatcher, MemoryAnnouncementSource } from './consumers/announcements.ts';
import { rulesAnnouncement, RULES_CHANNEL_KEY } from './announce/rules.ts';
import { collectCommands, registerCommands } from './commands/register.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel }, { service: 'stentor' });
  log.info('設定載入完成', redact(config));

  for (const missing of missingCapabilities()) {
    log.warn('hestia 尚未提供的能力,相關指令會回「還沒開放」', { capability: missing });
  }

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
        ports: unavailablePorts,
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
    channels: config.channels,
    publisher: gateway.publisher,
    log,
  });
  // hestia 還沒有把 outbox 事件送出來的傳輸方式(見 consumers/announcements.ts)。
  // 先接一個記憶體來源:介面已經是最終形狀,補上傳輸時只換這一行。
  const announcementSource = new MemoryAnnouncementSource();
  announcements.attach(announcementSource);

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

  if (config.channels.has(RULES_CHANNEL_KEY)) {
    await announcementSource.emit(rulesAnnouncement());
  }

  const shutdown = (signal: string): void => {
    log.info('收到關機訊號', { signal });
    clearInterval(flushTimer);
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
