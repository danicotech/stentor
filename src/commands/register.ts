// Slash 指令註冊。
//
// 指令清單 = 平台自己的(definitions.ts)+ 每個活動服務自己交出來的
// (DescribeCommands)。所以加一個活動不需要有人來這裡加一行。
//
// 註冊前會驗一件事:**每個指令的名字都要是註冊表裡的前綴**。
// 沒有這個檢查的話,活動可以註冊一個 `/foo`,而按鈕 `foo:...` 卻沒人接;
// 那種錯只有使用者按下去才會發現。
//
// 用法:pnpm commands:register

import { REST, Routes } from 'discord.js';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

import type { ActivityBackend } from '../activity/backend.ts';
import type { Config } from '../config/env.ts';
import type { RouteRegistry } from '../routing/registry.ts';
import type { Logger } from '../shared/log.ts';
import { platformCommands } from './definitions.ts';

export interface CollectResult {
  readonly commands: readonly RESTPostAPIApplicationCommandsJSONBody[];
  readonly problems: readonly string[];
}

/**
 * 收集全部指令並檢查一致性。純函式化到能測的程度:
 * 傳進來的 activity 只要有 describeCommands 就行。
 */
export async function collectCommands(
  registry: RouteRegistry,
  activity: Pick<ActivityBackend, 'describeCommands'>,
  log: Logger,
): Promise<CollectResult> {
  const commands: RESTPostAPIApplicationCommandsJSONBody[] = [...platformCommands()];
  const problems: string[] = [];

  for (const route of registry.activityRoutes()) {
    let described;
    try {
      described = await activity.describeCommands(route);
    } catch (err) {
      problems.push(
        `活動 "${route.prefix}" 的 DescribeCommands 失敗:${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    for (const prefix of described.prefixes) {
      if (!registry.has(prefix)) {
        problems.push(`活動 "${route.prefix}" 宣告它收前綴 "${prefix}",但設定裡沒有這個前綴`);
      }
    }

    for (const raw of described.commands) {
      const name = typeof raw['name'] === 'string' ? raw['name'] : '';
      if (name !== route.prefix) {
        problems.push(
          `活動 "${route.prefix}" 的指令叫 "${name}",指令名必須等於前綴,否則按鈕會沒人接`,
        );
        continue;
      }
      commands.push(raw as unknown as RESTPostAPIApplicationCommandsJSONBody);
    }
    log.info('已取得活動指令', { prefix: route.prefix, count: described.commands.length });
  }

  return { commands, problems };
}

export async function registerCommands(
  config: Config,
  commands: readonly RESTPostAPIApplicationCommandsJSONBody[],
  log: Logger,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const route = config.discordDevGuildId
    ? Routes.applicationGuildCommands(config.discordApplicationId, config.discordDevGuildId)
    : Routes.applicationCommands(config.discordApplicationId);

  await rest.put(route, { body: commands });
  log.info('指令已註冊', {
    count: commands.length,
    scope: config.discordDevGuildId ? `guild:${config.discordDevGuildId}` : 'global',
    names: commands.map((c) => c.name),
  });
}
