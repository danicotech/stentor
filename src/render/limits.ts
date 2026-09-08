// Discord 的硬限制。
//
// 全部集中在這裡,是因為它們不是「我們的規則」—— 是 Discord 的。
// 散在渲染邏輯裡的話,哪天 Discord 放寬限制就得全檔案找。
//
// 來源:Discord API docs(Embed Limits / Message Components / Modals)。

export const LIMITS = {
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooter: 2048,
  /** 一則訊息最多 5 個 action row。 */
  actionRows: 5,
  /** 一個 row 最多 5 顆按鈕;一個 select 獨佔一個 row。 */
  buttonsPerRow: 5,
  buttonLabel: 80,
  selectPlaceholder: 150,
  selectOptions: 25,
  selectOptionLabel: 100,
  selectOptionValue: 100,
  selectOptionDescription: 100,
  /** modal 最多 5 個輸入欄。 */
  modalInputs: 5,
  modalTitle: 45,
  modalInputLabel: 45,
  messageContent: 2000,
} as const;

/**
 * 截斷。超過就砍並補省略號 —— 不是丟例外。
 *
 * 為什麼不丟:活動服務給了一段太長的說明,使用者該看到的是「內容被截斷」,
 * 不是「機器人壞了」。渲染層的失敗模式應該是降級,不是中斷。
 */
export function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return value.slice(0, max - 1) + '…';
}

/** Discord 不接受空字串的欄位名/值,但活動服務給空字串是合理的(還沒填)。 */
export const EMPTY_PLACEHOLDER = '—';
