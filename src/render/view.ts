// 渲染契約 → Discord 元件。
//
// 型別來自 `src/gen/hestia/render/v1/render_pb.ts`,那是 hestia 的 proto 生成的
// (專案鐵則 6:契約自動生成,禁止手寫共用型別)。這支檔案裡沒有一個手寫的契約型別。
//
// 這裡是純函式:同一份描述一定渲染成同一組元件。整份契約的可測性建立在這件事上,
// 所以不要在這裡讀時間、讀環境變數、或做任何跟輸入無關的判斷。

import { ButtonStyle, ComponentType, MessageFlags, TextInputStyle } from 'discord.js';
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIEmbed,
  APIEmbedField,
  APIComponentInMessageActionRow,
  APIModalInteractionResponseCallbackData,
  APIStringSelectComponent,
} from 'discord.js';

import type { Action, Modal, Select, View } from '../gen/hestia/render/v1/render_pb.ts';
import { ActionStyle } from '../gen/hestia/render/v1/render_pb.ts';
import { CUSTOM_ID_MAX_BYTES, customIdByteLength } from '../routing/custom-id.ts';
import { clamp, EMPTY_PLACEHOLDER, LIMITS } from './limits.ts';

export interface MessagePayload {
  readonly content: string;
  readonly embeds: readonly APIEmbed[];
  readonly components: readonly APIActionRowComponent<APIComponentInMessageActionRow>[];
  /** true = 只有觸發的人看得到。呼叫端負責翻成 Discord 的 flags。 */
  readonly ephemeral: boolean;
}

export interface Rendered<T> {
  readonly payload: T;
  /**
   * 渲染過程中被丟掉或截斷的東西。
   *
   * 回傳而不是直接 log,是為了讓渲染保持純函式 —— 測試可以直接斷言
   * 「這份描述會產生哪些警告」,而不必去攔 log。
   */
  readonly warnings: readonly string[];
}

const STYLE_MAP: Record<number, ButtonStyle> = {
  [ActionStyle.PRIMARY]: ButtonStyle.Primary,
  [ActionStyle.SECONDARY]: ButtonStyle.Secondary,
  [ActionStyle.SUCCESS]: ButtonStyle.Success,
  [ActionStyle.DANGER]: ButtonStyle.Danger,
  [ActionStyle.LINK]: ButtonStyle.Link,
};

function buttonStyle(style: ActionStyle): ButtonStyle {
  return STYLE_MAP[style] ?? ButtonStyle.Secondary;
}

type ComponentEmoji = { id: string; name: string; animated: boolean } | { name: string };

function parseEmoji(raw: string): ComponentEmoji {
  // `<:name:123>` / `<a:name:123>` 是 Discord 的自訂 emoji 寫法,其餘當 Unicode。
  const custom = /^<(a?):(\w+):(\d+)>$/.exec(raw);
  if (custom) {
    return { id: custom[3] as string, name: custom[2] as string, animated: custom[1] === 'a' };
  }
  return { name: raw };
}

function renderButton(action: Action, warnings: string[]): APIButtonComponent | null {
  const label = clamp(action.label, LIMITS.buttonLabel);
  const style = buttonStyle(action.style);

  if (style === ButtonStyle.Link) {
    if (!action.url) {
      warnings.push(`LINK 按鈕 "${label}" 沒有 url,已略過`);
      return null;
    }
    return {
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label,
      url: action.url,
      disabled: action.disabled,
      ...(action.emoji ? { emoji: parseEmoji(action.emoji) } : {}),
    };
  }

  if (!action.id) {
    warnings.push(`按鈕 "${label}" 沒有 id,已略過`);
    return null;
  }
  if (customIdByteLength(action.id) > CUSTOM_ID_MAX_BYTES) {
    // 截斷會讓它路由到別的地方去,所以只能丟掉。
    warnings.push(`按鈕 "${label}" 的 custom_id 超過 ${CUSTOM_ID_MAX_BYTES} bytes,已略過`);
    return null;
  }
  return {
    type: ComponentType.Button,
    style: style as Exclude<ButtonStyle, ButtonStyle.Link | ButtonStyle.Premium>,
    label,
    custom_id: action.id,
    disabled: action.disabled,
    ...(action.emoji ? { emoji: parseEmoji(action.emoji) } : {}),
  };
}

function renderSelect(select: Select, warnings: string[]): APIStringSelectComponent | null {
  if (!select.id) {
    warnings.push('下拉選單沒有 id,已略過');
    return null;
  }
  if (customIdByteLength(select.id) > CUSTOM_ID_MAX_BYTES) {
    warnings.push(`下拉選單 "${select.id}" 的 custom_id 超過上限,已略過`);
    return null;
  }
  if (select.options.length === 0) {
    warnings.push(`下拉選單 "${select.id}" 沒有選項,已略過`);
    return null;
  }
  if (select.options.length > LIMITS.selectOptions) {
    warnings.push(
      `下拉選單 "${select.id}" 有 ${select.options.length} 個選項,只保留前 ${LIMITS.selectOptions} 個`,
    );
  }
  const options = select.options.slice(0, LIMITS.selectOptions).map((option) => ({
    label: clamp(option.label || EMPTY_PLACEHOLDER, LIMITS.selectOptionLabel),
    value: clamp(option.value, LIMITS.selectOptionValue),
    default: option.selected,
    ...(option.description
      ? { description: clamp(option.description, LIMITS.selectOptionDescription) }
      : {}),
  }));

  const minValues = select.minValues > 0 ? Math.min(select.minValues, options.length) : 1;
  const maxValues = select.maxValues > 0 ? Math.min(select.maxValues, options.length) : 1;

  return {
    type: ComponentType.StringSelect,
    custom_id: select.id,
    placeholder: clamp(select.placeholder, LIMITS.selectPlaceholder),
    options,
    min_values: minValues,
    max_values: Math.max(minValues, maxValues),
    disabled: select.disabled,
  };
}

/**
 * 分行規則(固定,不可依輸入以外的東西變動):
 *   1. 每個下拉選單各自獨佔一個 row,依原順序排在最前面
 *   2. 按鈕依原順序每 5 顆一個 row
 *   3. 總共超過 5 個 row 的部分丟掉,並記一則警告
 *
 * 讓渲染端決定分行、而不是讓活動服務給 rows,是刻意的:
 * 活動服務不該知道 Discord 一行能放幾顆。
 */
function packRows(
  view: View,
  warnings: string[],
): APIActionRowComponent<APIComponentInMessageActionRow>[] {
  const rows: APIActionRowComponent<APIComponentInMessageActionRow>[] = [];

  for (const select of view.selects) {
    const rendered = renderSelect(select, warnings);
    if (rendered) rows.push({ type: ComponentType.ActionRow, components: [rendered] });
  }

  const buttons: APIButtonComponent[] = [];
  for (const action of view.actions) {
    const rendered = renderButton(action, warnings);
    if (rendered) buttons.push(rendered);
  }
  for (let i = 0; i < buttons.length; i += LIMITS.buttonsPerRow) {
    rows.push({
      type: ComponentType.ActionRow,
      components: buttons.slice(i, i + LIMITS.buttonsPerRow),
    });
  }

  if (rows.length > LIMITS.actionRows) {
    warnings.push(
      `元件需要 ${rows.length} 個 row,Discord 上限 ${LIMITS.actionRows},超出的部分已丟棄`,
    );
    return rows.slice(0, LIMITS.actionRows);
  }
  return rows;
}

function renderFields(view: View, warnings: string[]): APIEmbedField[] {
  if (view.fields.length > LIMITS.embedFields) {
    warnings.push(
      `欄位有 ${view.fields.length} 個,Discord 上限 ${LIMITS.embedFields},只保留前面的`,
    );
  }
  return view.fields.slice(0, LIMITS.embedFields).map((field) => ({
    name: clamp(field.k || EMPTY_PLACEHOLDER, LIMITS.embedFieldName),
    value: clamp(field.v || EMPTY_PLACEHOLDER, LIMITS.embedFieldValue),
    inline: field.inline,
  }));
}

export function renderView(view: View, content = ''): Rendered<MessagePayload> {
  const warnings: string[] = [];

  const embed: APIEmbed = {
    ...(view.title ? { title: clamp(view.title, LIMITS.embedTitle) } : {}),
    ...(view.description ? { description: clamp(view.description, LIMITS.embedDescription) } : {}),
    ...(view.fields.length > 0 ? { fields: renderFields(view, warnings) } : {}),
    ...(view.color !== undefined ? { color: view.color } : {}),
    ...(view.footer ? { footer: { text: clamp(view.footer, LIMITS.embedFooter) } } : {}),
    ...(view.imageUrl ? { image: { url: view.imageUrl } } : {}),
    ...(view.thumbnailUrl ? { thumbnail: { url: view.thumbnailUrl } } : {}),
  };

  return {
    payload: {
      content: clamp(content, LIMITS.messageContent),
      embeds: [embed],
      components: packRows(view, warnings),
      ephemeral: view.ephemeral,
    },
    warnings,
  };
}

export function renderModal(modal: Modal): Rendered<APIModalInteractionResponseCallbackData> {
  const warnings: string[] = [];
  if (modal.inputs.length > LIMITS.modalInputs) {
    warnings.push(
      `表單有 ${modal.inputs.length} 個欄位,Discord 上限 ${LIMITS.modalInputs},只保留前面的`,
    );
  }
  const components = modal.inputs.slice(0, LIMITS.modalInputs).map((input) => ({
    type: ComponentType.ActionRow as const,
    components: [
      {
        type: ComponentType.TextInput as const,
        custom_id: input.id,
        label: clamp(input.label, LIMITS.modalInputLabel),
        style: input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
        required: input.required,
        ...(input.placeholder ? { placeholder: input.placeholder } : {}),
        ...(input.value ? { value: input.value } : {}),
        ...(input.minLength > 0 ? { min_length: input.minLength } : {}),
        ...(input.maxLength > 0 ? { max_length: input.maxLength } : {}),
      },
    ],
  }));

  return {
    payload: {
      custom_id: modal.id,
      title: clamp(modal.title, LIMITS.modalTitle),
      components,
    },
    warnings,
  };
}

/** MessagePayload → discord.js 的 reply / send 參數。 */
export function toDiscordMessage(payload: MessagePayload): Record<string, unknown> {
  return {
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    ...(payload.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  };
}
