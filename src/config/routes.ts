// `ACTIVITY_ROUTES` 的解析。
//
// 這一個環境變數就是「加一個活動」的全部動作:
//
//   ACTIVITY_ROUTES=summer-cup=http://themis:8080;public,winter-cup=http://themis2:8080
//
// 格式:`<前綴>=<base URL>[;旗標][;旗標],...`
//   public  預設回覆是公開的(不加就是只有自己看得到)
//   update  元件互動預設就地更新原訊息(不加就是回一則新訊息)
//
// 解析失敗一律丟例外,而且是在啟動時丟。錯字的症狀是「按鈕沒反應」,
// 那種錯只會在線上被使用者發現。

import { isValidPrefix } from '../routing/custom-id.ts';
import type { RouteInput } from '../routing/registry.ts';

export class RouteConfigError extends Error {
  constructor(message: string) {
    super(`ACTIVITY_ROUTES 設定錯誤:${message}`);
    this.name = 'RouteConfigError';
  }
}

const KNOWN_FLAGS = new Set(['public', 'update']);

export function parseActivityRoutes(raw: string): readonly RouteInput[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  const seen = new Set<string>();
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [head = '', ...flagParts] = entry.split(';').map((p) => p.trim());
      const eq = head.indexOf('=');
      if (eq <= 0) {
        throw new RouteConfigError(`"${entry}" 少了 "=",格式是 <前綴>=<base URL>`);
      }
      const prefix = head.slice(0, eq).trim();
      const baseUrl = head.slice(eq + 1).trim();

      if (!isValidPrefix(prefix)) {
        throw new RouteConfigError(`前綴 "${prefix}" 不合法(只允許小寫、數字、連字號,最長 32)`);
      }
      if (seen.has(prefix)) {
        throw new RouteConfigError(`前綴 "${prefix}" 重複`);
      }
      seen.add(prefix);

      if (baseUrl === '') {
        throw new RouteConfigError(`前綴 "${prefix}" 沒有 base URL`);
      }
      try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new RouteConfigError(`前綴 "${prefix}" 的 base URL 不是 http(s)`);
        }
      } catch (err) {
        if (err instanceof RouteConfigError) throw err;
        throw new RouteConfigError(`前綴 "${prefix}" 的 base URL "${baseUrl}" 不是合法網址`);
      }

      const flags = flagParts.filter((f) => f !== '');
      for (const flag of flags) {
        if (!KNOWN_FLAGS.has(flag)) {
          throw new RouteConfigError(
            `前綴 "${prefix}" 有不認得的旗標 "${flag}"(可用:${[...KNOWN_FLAGS].join(' / ')})`,
          );
        }
      }

      return {
        prefix,
        kind: 'activity' as const,
        baseUrl,
        ephemeral: !flags.includes('public'),
        updatesSource: flags.includes('update'),
      };
    });
}

/**
 * `CHANNEL_MAP` 的解析:邏輯頻道名 → Discord channel id。
 *
 *   CHANNEL_MAP=announcements=123456789,rules=987654321
 *
 * 後端只知道 `announcements` 這種名字,不知道 channel id。頻道搬家是部署設定的事。
 */
export function parseChannelMap(raw: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new Error(`CHANNEL_MAP 設定錯誤:"${trimmed}" 少了 "="`);
    }
    const key = trimmed.slice(0, eq).trim();
    const id = trimmed.slice(eq + 1).trim();
    if (!/^\d{5,25}$/.test(id)) {
      throw new Error(`CHANNEL_MAP 設定錯誤:"${key}" 的 channel id "${id}" 不像 snowflake`);
    }
    map.set(key, id);
  }
  return map;
}
