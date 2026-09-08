// 路由決策。純函式:給它一個互動,回「這該送去哪」。
//
// 這裡沒有任何 await、沒有 I/O,所以它是這個 repo 最容易測到底的地方——
// 而它剛好也是最不能出錯的地方。

import type { IncomingInteraction } from '../gateway/interaction.ts';
import { commandNamespace, parseCustomId, CustomIdError } from './custom-id.ts';
import type { Route, RouteRegistry } from './registry.ts';

export type Resolution =
  | {
      readonly ok: true;
      readonly route: Route;
      readonly key: string;
      readonly segments: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown-prefix' | 'malformed';
      readonly detail: string;
      readonly key: string;
    };

/**
 * 指令與元件走同一張表,差別只在路由鍵從哪裡取:
 *   指令   → 指令路徑的第一段(`summer-cup bet` → `summer-cup`)
 *   元件   → custom_id 的第一段(`summer-cup:bet:5:1` → `summer-cup`)
 */
export function route(registry: RouteRegistry, interaction: IncomingInteraction): Resolution {
  if (interaction.kind === 'command') {
    const key = commandNamespace(interaction.commandPath);
    const found = registry.resolve(key);
    if (!found) {
      return {
        ok: false,
        reason: 'unknown-prefix',
        detail: `沒有註冊的指令命名空間 "${key}"`,
        key,
      };
    }
    const segments = interaction.commandPath.trim().split(/\s+/).slice(1);
    return { ok: true, route: found, key, segments };
  }

  let parsed;
  try {
    parsed = parseCustomId(interaction.customId);
  } catch (err) {
    const detail = err instanceof CustomIdError ? err.message : String(err);
    return { ok: false, reason: 'malformed', detail, key: '' };
  }
  const found = registry.resolve(parsed.prefix);
  if (!found) {
    return {
      ok: false,
      reason: 'unknown-prefix',
      detail: `沒有註冊的前綴 "${parsed.prefix}"`,
      key: parsed.prefix,
    };
  }
  return { ok: true, route: found, key: parsed.prefix, segments: parsed.segments };
}
