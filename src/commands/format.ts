// 顯示用的格式化。
//
// 這裡只做「數字怎麼寫出來」,不做任何計算——金額的權威是 hestia 回的 int64,
// stentor 連加一都不會做(專案鐵則 3、4)。
//
// 不用 toLocaleString:它的輸出取決於 Node 的 ICU 版本,同一份輸入在不同機器上
// 可能不一樣,而渲染測試靠的正是「同一份輸入 → 同一份輸出」。

export function formatAmount(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

export function formatDurationDays(days: number | undefined): string {
  return days === undefined ? '永久' : `${days} 天`;
}

export function formatLimit(limit: number | undefined): string {
  return limit === undefined ? '不限' : `${limit} 次`;
}
