// 環境變數 → 設定物件。
//
// 兩條規則:
//   1. **這裡永遠不會出現資料庫連線字串。** 哪天覺得需要它,先回頭看是不是
//      有邏輯跑錯層了(stentor/README.md)。
//   2. 密鑰只放在設定物件裡,絕不整包丟進 log。要印設定就印 redact() 的結果。
//
// 缺必要變數就開不起來。這比「跑起來了但每次呼叫都 401」好查太多。

import { isLogLevel, type LogLevel } from '../shared/log.ts';
import type { RouteInput } from '../routing/registry.ts';
import { parseActivityRoutes, parseChannelMap } from './routes.ts';

export interface Config {
  readonly discordToken: string;
  readonly discordApplicationId: string;
  /** 開發期把指令只註冊到測試伺服器,生效是即時的(全域要等快取)。 */
  readonly discordDevGuildId: string | null;
  readonly platformApiUrl: string;
  readonly platformServiceToken: string;
  /**
   * 網頁前端的位址。
   *
   * 綁定帳號只能在使用者自己的瀏覽器裡完成(OAuth 的 state 綁在 cookie 上),
   * 所以 Bot 唯一能做的就是給連結 —— 沒有這個值,`/bind` 沒有東西可指。
   */
  readonly webBaseUrl: string;
  readonly activityRoutes: readonly RouteInput[];
  readonly channels: ReadonlyMap<string, string>;
  readonly logLevel: LogLevel;
  /**
   * 是否啟用 MESSAGE_CONTENT 特權 intent。
   *
   * 關掉時仍然會記則數(那不需要特權 intent),只是內容一律空的。
   * 預設關:特權 intent 要跟 Discord 申請,而且是最敏感的一個。
   */
  readonly messageContentIntent: boolean;
  /** 訊息批次送出的間隔與大小(hestia 的 RecordMessages 是批次介面)。 */
  readonly messageFlushMs: number;
  readonly messageBatchSize: number;
  /** 呼叫後端的逾時。Discord 的互動只有 3 秒。 */
  readonly backendTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`缺少必要的環境變數 ${key}`);
  return value;
}

function optional(env: Env, key: string, fallback = ''): string {
  return env[key]?.trim() || fallback;
}

function integer(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ConfigError(`${key} 必須是非負整數,拿到 "${raw}"`);
  }
  return parsed;
}

function boolean_(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${key} 必須是 true / false,拿到 "${raw}"`);
}

export function loadConfig(env: Env = process.env): Config {
  const level = optional(env, 'LOG_LEVEL', 'info');
  if (!isLogLevel(level)) {
    throw new ConfigError(`LOG_LEVEL 必須是 debug / info / warn / error,拿到 "${level}"`);
  }

  // boundary-guard: 這一行就是在執行「不連資料庫」那條規則,必須寫得出那些變數名
  for (const forbidden of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL']) {
    if (env[forbidden]) {
      // 不是潔癖:容器裡出現連線字串就代表有人打算讓 Bot 直連資料庫。
      throw new ConfigError(
        `環境裡出現 ${forbidden}。stentor 不連資料庫,狀態的權威在 hestia 與活動服務。`,
      );
    }
  }

  const platformApiUrl = required(env, 'PLATFORM_API_URL');
  try {
    new URL(platformApiUrl);
  } catch {
    throw new ConfigError(`PLATFORM_API_URL "${platformApiUrl}" 不是合法網址`);
  }

  const webBaseUrl = required(env, 'WEB_BASE_URL');
  try {
    new URL(webBaseUrl);
  } catch {
    throw new ConfigError(`WEB_BASE_URL "${webBaseUrl}" 不是合法網址`);
  }

  return {
    discordToken: required(env, 'DISCORD_TOKEN'),
    discordApplicationId: required(env, 'DISCORD_APPLICATION_ID'),
    discordDevGuildId: optional(env, 'DISCORD_DEV_GUILD_ID') || null,
    platformApiUrl,
    platformServiceToken: required(env, 'PLATFORM_SERVICE_TOKEN'),
    webBaseUrl,
    activityRoutes: parseActivityRoutes(optional(env, 'ACTIVITY_ROUTES')),
    channels: parseChannelMap(optional(env, 'CHANNEL_MAP')),
    logLevel: level,
    messageContentIntent: boolean_(env, 'DISCORD_MESSAGE_CONTENT_INTENT', false),
    messageFlushMs: integer(env, 'MESSAGE_FLUSH_MS', 5000),
    messageBatchSize: integer(env, 'MESSAGE_BATCH_SIZE', 25),
    backendTimeoutMs: integer(env, 'BACKEND_TIMEOUT_MS', 8000),
  };
}

/** 可以安全印出來的版本。密鑰一律換成長度,連前幾碼都不留。 */
export function redact(config: Config): Record<string, unknown> {
  return {
    discordToken: `<${config.discordToken.length} chars>`,
    discordApplicationId: config.discordApplicationId,
    discordDevGuildId: config.discordDevGuildId,
    platformApiUrl: config.platformApiUrl,
    platformServiceToken: `<${config.platformServiceToken.length} chars>`,
    webBaseUrl: config.webBaseUrl,
    activityRoutes: config.activityRoutes.map((r) => `${r.prefix}=${r.baseUrl ?? ''}`),
    channels: [...config.channels.keys()],
    logLevel: config.logLevel,
    messageContentIntent: config.messageContentIntent,
    messageFlushMs: config.messageFlushMs,
    messageBatchSize: config.messageBatchSize,
    backendTimeoutMs: config.backendTimeoutMs,
  };
}
