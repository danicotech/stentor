/**
 * stentor 的 custom lint。
 *
 * 這個 repo 的整個價值建立在一件事上:它不知道任何一場活動的規則。
 * 一旦有人「順手」在這裡判斷賽事階段或算了一次賠率,它就從通用閘道
 * 退化成這次比賽的 Bot,下一場活動就得改它。
 *
 * ESLint 抓不到這種事 —— 那不是語法問題,是知識跑錯層。所以用這支腳本。
 */

import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 出現就是錯的東西。 */
const FORBIDDEN = [
  {
    name: '資料庫連線',
    pattern:
      /\b(pg|postgres|postgresql|mysql|sqlite|mongodb|redis):\/\/|\bDATABASE_URL\b|\bnew\s+(Pool|Client)\s*\(/i,
    why: 'Bot 暴露在 Discord 那一側,它被打下來時不該連著資料庫。狀態的權威在 hestia 和活動服務。',
  },
  {
    name: '活動規則',
    pattern: /\b(odds|payout|parlay|bracket|seeding|tournamentPhase|matchPhase)\b/i,
    why: '賠率、派彩、串關、賽程樹是活動層的事。這裡只把別人算好的顯示描述渲染出來。',
  },
  {
    name: '階段判斷',
    pattern: /\bphase\s*(===|!==|==|!=)/i,
    why: '階段是活動服務的概念。要顯示什麼由它決定,這裡不做條件判斷。',
  },
];

/**
 * 例外標記。
 *
 * 只有一種情況該用它:這一行**本身就是在執行這條規則**。
 * 例如設定載入器要檢查「環境裡有沒有出現 DATABASE_URL」,它必須寫得出那個字。
 *
 * 標記寫成**下一行的注解**:`// boundary-guard: <理由>`,豁免緊接著的那一行。
 * 理由是必要的 —— 一個沒有理由的例外,下一個人只會照抄。
 */
const GUARD = /\/\/\s*boundary-guard:\s*\S/;

// 生成的契約碼不掃:它是 proto 的產物,要改也不是改這裡。
const files = globSync('src/**/*.{ts,mts,cts,js,mjs}', { cwd: root }).filter(
  (f) => !f.split(/[\\/]/).includes('gen'),
);
const violations = [];
let guarded = 0;

for (const file of files) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  let exempt = false;
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    if (GUARD.test(line)) {
      // 標記本身放行,並且豁免下一行(只有一行,不會擴散)。
      exempt = true;
      guarded += 1;
      return;
    }
    if (exempt) {
      exempt = false;
      return;
    }
    if (trimmed.startsWith('//')) return;
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(line)) {
        violations.push({ file, line: i + 1, rule, text: line.trim() });
      }
    }
  });
}

if (violations.length === 0) {
  console.log(
    `custom lint: 掃了 ${files.length} 個檔案,沒有越界` +
      (guarded > 0 ? `(${guarded} 行標了 boundary-guard 例外)` : ''),
  );
  process.exit(0);
}

console.error(`\ncustom lint 發現 ${violations.length} 處越界:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.rule.name}]`);
  console.error(`    ${v.text}`);
  console.error(`    → ${v.rule.why}\n`);
}
console.error('如果你確定這是誤判,要改的是這支腳本的規則,不是把它跳過。\n');
process.exit(1);
