// 組出註冊表。
//
// 平台的前綴是寫死的(它們就是這個 repo 的功能),活動的前綴全部來自設定。
// 兩者放進同一張表,是為了讓「前綴撞名」在啟動時就爆——
// 例如有人把活動取名叫 `shop`,那應該是開不起來,而不是上線後才發現
// 商店的按鈕被送去活動服務。

import { PLATFORM_PREFIXES } from '../commands/platform-backend.ts';
import type { RouteInput } from './registry.ts';
import { RouteRegistry } from './registry.ts';

export function buildRegistry(activityRoutes: readonly RouteInput[]): RouteRegistry {
  const registry = new RouteRegistry();

  for (const prefix of PLATFORM_PREFIXES) {
    registry.register({
      prefix,
      kind: 'platform',
      // 平台指令一律只有自己看得到:餘額與購買紀錄不該洗在公開頻道。
      ephemeral: true,
      updatesSource: false,
    });
  }

  for (const route of activityRoutes) {
    registry.register(route);
  }

  return registry;
}
