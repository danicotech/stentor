import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // src/gen 是 buf 從 hestia 的 proto 生成的。它不該被風格規則管:
    // 要改的是 proto,不是產物(專案鐵則 6)。
    ignores: ['dist/**', 'node_modules/**', '.husky/**', 'src/gen/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 未使用的變數用底線開頭表示「刻意不用」
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Discord 的互動有 3 秒逾時,漏掉的 await 會直接變成使用者看到的錯誤
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // 渲染契約是 JSON,any 會讓它形同虛設
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // 這一條是 stentor 的定位,不是風格偏好:它不知道任何活動的規則。
  // 更完整的檢查在 scripts/check-boundaries.mjs。
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'pg',
                'pg-*',
                'postgres',
                'mysql*',
                'better-sqlite3',
                'mongodb',
                'drizzle-orm',
                'prisma',
                '@prisma/*',
              ],
              message: 'stentor 不連資料庫。狀態的權威在 hestia 和活動服務。',
            },
          ],
        },
      ],
    },
  },

  // node:test 的 test() / describe() 會回 Promise,而它的設計就是不去 await 它們
  // (runner 自己收集)。在測試檔強制 await 只會製造一堆沒有意義的 void。
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },

  // 設定檔與腳本不吃型別檢查
  {
    files: ['*.mjs', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
