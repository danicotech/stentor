// custom_id 的編解碼。
//
// 格式:`<前綴>:<段>:<段>...`,第一段就是路由鍵(stentor/CLAUDE.md)。
// 這支檔案是整個路由機制的基礎,而且它**完全不知道任何一個前綴的意義**——
// 它只會拆字串、驗長度。前綴代表什麼是 registry 的事。

/** Discord 的 custom_id 上限是 100 bytes(UTF-8),不是 100 個字元。 */
export const CUSTOM_ID_MAX_BYTES = 100;

export const CUSTOM_ID_SEPARATOR = ':';

/**
 * 前綴的字元集刻意收得很窄:小寫、數字、連字號,最長 32。
 *
 * 理由是它同時要當**設定檔的鍵**與 **Discord custom_id 的第一段**。
 * 放寬到任意字元的話,`ACTIVITY_ROUTES` 的解析就得處理跳脫,
 * 而跳脫規則出錯的症狀是「按鈕按下去沒反應」——線上才會發現。
 */
export const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class CustomIdError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'CustomIdError';
  }
}

export interface ParsedCustomId {
  /** 路由鍵。 */
  readonly prefix: string;
  /** 前綴之後的段;活動服務自己解讀,stentor 不看內容。 */
  readonly segments: readonly string[];
  readonly raw: string;
}

export function isValidPrefix(value: string): boolean {
  return PREFIX_PATTERN.test(value);
}

export function customIdByteLength(raw: string): number {
  return Buffer.byteLength(raw, 'utf8');
}

export function parseCustomId(raw: string): ParsedCustomId {
  if (raw.length === 0) {
    throw new CustomIdError('custom_id 是空的', raw);
  }
  if (customIdByteLength(raw) > CUSTOM_ID_MAX_BYTES) {
    throw new CustomIdError(`custom_id 超過 ${CUSTOM_ID_MAX_BYTES} bytes(Discord 上限)`, raw);
  }
  const parts = raw.split(CUSTOM_ID_SEPARATOR);
  const prefix = parts[0] ?? '';
  if (!isValidPrefix(prefix)) {
    throw new CustomIdError(`前綴 "${prefix}" 不合法(${PREFIX_PATTERN.source})`, raw);
  }
  return { prefix, segments: parts.slice(1), raw };
}

/**
 * 組出 custom_id。給平台自己的元件用;活動服務的 id 是它自己組的,
 * stentor 只驗長度不改內容。
 */
export function buildCustomId(prefix: string, ...segments: readonly string[]): string {
  if (!isValidPrefix(prefix)) {
    throw new CustomIdError(`前綴 "${prefix}" 不合法`, prefix);
  }
  for (const segment of segments) {
    if (segment.includes(CUSTOM_ID_SEPARATOR)) {
      throw new CustomIdError(`段 "${segment}" 不能含有分隔字元`, segment);
    }
  }
  const raw = [prefix, ...segments].join(CUSTOM_ID_SEPARATOR);
  if (customIdByteLength(raw) > CUSTOM_ID_MAX_BYTES) {
    throw new CustomIdError(`custom_id 超過 ${CUSTOM_ID_MAX_BYTES} bytes`, raw);
  }
  return raw;
}

/**
 * 指令路徑(`daily`、`privacy optout`、`summer-cup bet`)的第一段也是路由鍵。
 * 這樣按鈕與指令走的是同一張表,不會出現「指令通了但按鈕沒人接」。
 */
export function commandNamespace(commandPath: string): string {
  const first = commandPath.trim().split(/\s+/)[0] ?? '';
  return first;
}
