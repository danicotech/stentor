// 設定載入的測試。
//
// 最重要的一條:**環境裡出現資料庫連線字串就開不起來。**
// 這不是潔癖 —— 那個字串出現在 Bot 的容器裡,代表有人打算讓它直連資料庫,
// 而 Bot 是整個系統暴露面最大的一個。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, loadConfig, redact } from '../src/config/env.ts';

const base = {
  DISCORD_TOKEN: 'fake-discord-token-value',
  DISCORD_APPLICATION_ID: '123456789012345678',
  PLATFORM_API_URL: 'http://hestia:8080',
  PLATFORM_SERVICE_TOKEN: 'fake-service-token-value',
  WEB_BASE_URL: 'https://play.example',
};

describe('設定載入', () => {
  test('最小可用設定', () => {
    const config = loadConfig(base);
    assert.equal(config.platformApiUrl, 'http://hestia:8080');
    assert.deepEqual(config.activityRoutes, []);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.messageContentIntent, false, 'MESSAGE_CONTENT 是特權 intent,預設關');
  });

  test('缺必要變數就爆,而不是跑起來每次呼叫都 401', () => {
    for (const key of Object.keys(base)) {
      const partial = { ...base, [key]: '' };
      assert.throws(() => loadConfig(partial), ConfigError, `少了 ${key} 應該要爆`);
    }
  });

  test('環境裡出現資料庫連線字串 → 直接拒絕啟動', () => {
    for (const key of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'REDIS_URL']) {
      assert.throws(
        () => loadConfig({ ...base, [key]: 'postgres://x' }),
        /不連資料庫/,
        `${key} 應該要被擋下來`,
      );
    }
  });

  test('壞掉的網址立刻爆', () => {
    assert.throws(() => loadConfig({ ...base, PLATFORM_API_URL: 'nope' }), ConfigError);
    assert.throws(() => loadConfig({ ...base, WEB_BASE_URL: 'nope' }), ConfigError);
  });

  test('WEB_BASE_URL 是必要的 —— 沒有它 /bind 沒有東西可指', () => {
    assert.throws(() => loadConfig({ ...base, WEB_BASE_URL: '' }), ConfigError);
  });

  test('LOG_LEVEL 只收四個值', () => {
    assert.equal(loadConfig({ ...base, LOG_LEVEL: 'debug' }).logLevel, 'debug');
    assert.throws(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' }), ConfigError);
  });

  test('布林與整數的格式錯誤也是啟動時爆', () => {
    assert.throws(
      () => loadConfig({ ...base, DISCORD_MESSAGE_CONTENT_INTENT: 'yes' }),
      ConfigError,
    );
    assert.throws(() => loadConfig({ ...base, MESSAGE_BATCH_SIZE: '-1' }), ConfigError);
  });

  test('活動路由與頻道對應一起載入', () => {
    const config = loadConfig({
      ...base,
      ACTIVITY_ROUTES: 'summer-cup=http://themis:8080;public',
      CHANNEL_MAP: 'rules=222222222222222222',
    });
    assert.equal(config.activityRoutes[0]?.prefix, 'summer-cup');
    assert.equal(config.channels.get('rules'), '222222222222222222');
  });
});

describe('redact', () => {
  test('密鑰不會出現在可以印出來的版本裡', () => {
    const printed = JSON.stringify(redact(loadConfig(base)));
    assert.doesNotMatch(printed, /fake-discord-token-value/);
    assert.doesNotMatch(printed, /fake-service-token-value/);
    assert.match(printed, /chars/);
  });

  test('連前幾碼都不留(前綴一樣是可以拿去比對的線索)', () => {
    const printed = JSON.stringify(redact(loadConfig(base)));
    assert.doesNotMatch(printed, /fake-/);
  });
});
