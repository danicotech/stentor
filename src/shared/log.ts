// 最小的結構化 logger。
//
// 沒有用 pino / winston:這個 repo 的 log 只有兩種用途——看發生什麼事、
// 出事時對得回 Discord 的 interaction id。為此裝一個框架不划算。
//
// **絕不記密鑰。** service token 與 Discord token 只會出現在設定物件裡,
// 而設定物件永遠不整包丟進 log(見 config/env.ts 的 redact)。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** 注入寫出口,測試用。 */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions, base: Record<string, unknown> = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const threshold = ORDER[options.level];

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}

/** 什麼都不做的 logger,測試預設用它。 */
export const silentLogger: Logger = createLogger({ level: 'error', sink: () => {} });

export function isLogLevel(value: string): value is LogLevel {
  return value in ORDER;
}
