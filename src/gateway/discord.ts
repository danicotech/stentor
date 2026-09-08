// Discord client 的接線。
//
// 這支檔案只做「事件 → 已經寫好的東西」的連接,不含任何判斷邏輯。
// 需要判斷的地方(路由、渲染、活動記錄的狀態變化)都在別的檔案裡,
// 而那些檔案都不認識 discord.js —— 所以它們有測試,這支沒有。

import {
  Client as DiscordJsClient,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
  type VoiceState,
} from 'discord.js';

import type { Config } from '../config/env.ts';
import type { MessageRecorder } from '../activitylog/messages.ts';
import type { VoiceRecorder, VoiceStateSnapshot } from '../activitylog/voice.ts';
import type { ChannelPublisher } from '../consumers/announcements.ts';
import type { MessagePayload } from '../render/view.ts';
import { toDiscordMessage } from '../render/view.ts';
import type { Logger } from '../shared/log.ts';
import { DiscordResponder, fromCommand, fromComponent, fromModal } from './adapter.ts';
import type { Dispatcher } from './dispatcher.ts';

/**
 * intent 的取捨(stentor/CLAUDE.md 的限制表):
 *   GuildVoiceStates    語音進出。**不需要特權 intent**,而且可靠 → 拿來發點數
 *   GuildMessages       訊息事件。則數不需要特權 intent
 *   MessageContent      **特權**。只有設定打開時才要,關掉仍然計數
 *   GuildMessageReactions  表情回應
 *
 * 刻意**沒有** GuildPresences:它是特權 intent,Bot 重啟期間的變化會整段漏掉,
 * 隱身也看不到,掛機就能刷 —— 拿它發任何東西都是錯的,所以連收都不收。
 */
export function intentsFor(config: Config): GatewayIntentBits[] {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ];
  if (config.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);
  return intents;
}

export interface GatewayDeps {
  readonly config: Config;
  readonly dispatcher: Dispatcher;
  readonly voice: VoiceRecorder;
  readonly messages: MessageRecorder;
  readonly log: Logger;
}

export interface Gateway {
  readonly client: DiscordJsClient;
  readonly publisher: ChannelPublisher;
  login(): Promise<void>;
  destroy(): Promise<void>;
}

function snapshot(state: VoiceState, peerCount: number): VoiceStateSnapshot {
  return {
    userId: state.id,
    guildId: state.guild.id,
    channelId: state.channelId,
    selfMuted: state.selfMute ?? false,
    selfDeafened: state.selfDeaf ?? false,
    peerCount,
  };
}

export function createGateway(deps: GatewayDeps): Gateway {
  const { config, dispatcher, voice, messages, log } = deps;

  const client = new DiscordJsClient({
    intents: intentsFor(config),
    // reaction 常常發生在 Bot 沒有快取的舊訊息上,沒有 partial 就整批收不到。
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  client.on(Events.ClientReady, (ready) => {
    log.info('Discord 已連線', { user: ready.user.tag, guilds: ready.guilds.cache.size });
  });

  client.on(Events.Error, (err) => {
    log.error('Discord client 錯誤', { error: `${err.name}: ${err.message}` });
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void handleInteraction(interaction);
  });

  async function handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await dispatcher.dispatch(fromCommand(interaction), new DiscordResponder(interaction));
        return;
      }
      if (interaction.isMessageComponent()) {
        await dispatcher.dispatch(fromComponent(interaction), new DiscordResponder(interaction));
        return;
      }
      if (interaction.isModalSubmit()) {
        await dispatcher.dispatch(fromModal(interaction), new DiscordResponder(interaction));
      }
    } catch (err) {
      // 到這裡還沒被接住的錯誤代表連回覆都失敗了。留 log,別讓它變成
      // unhandled rejection 把整個 process 帶走。
      log.error('互動處理未捕捉的錯誤', {
        interaction_id: interaction.id,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  client.on(Events.VoiceStateUpdate, (before: VoiceState, after: VoiceState) => {
    const peers = after.channel?.members.size ?? before.channel?.members.size ?? 0;
    void voice
      .onVoiceStateUpdate(snapshot(before, peers), snapshot(after, peers))
      .catch((err: unknown) => {
        log.error('語音事件處理失敗', { error: String(err) });
      });
  });

  client.on(Events.MessageCreate, (message: Message) => {
    if (message.author.bot || !message.guildId) return;
    void messages
      .record({
        guildId: message.guildId,
        authorId: message.author.id,
        channelId: message.channelId,
        channelKind: channelKindOf(message),
        threadId: message.channel.isThread() ? message.channelId : null,
        messageId: message.id,
        content: message.content,
        hasAttachment: message.attachments.size > 0,
        replyTo: message.reference?.messageId ?? null,
        createdAt: message.createdAt,
      })
      .catch((err: unknown) => log.error('訊息記錄失敗', { error: String(err) }));
  });

  client.on(Events.MessageUpdate, (before: Message | PartialMessage) => {
    if (before.partial || before.author?.bot || !before.guildId) return;
    void messages
      .recordRevision({
        guildId: before.guildId,
        authorId: before.author.id,
        channelId: before.channelId,
        messageId: before.id,
        previousContent: before.content,
        kind: 'edited',
        capturedAt: new Date(),
      })
      .catch((err: unknown) => log.error('訊息編輯記錄失敗', { error: String(err) }));
  });

  client.on(Events.MessageDelete, (message: Message | PartialMessage) => {
    if (message.partial || message.author?.bot || !message.guildId) return;
    void messages
      .recordRevision({
        guildId: message.guildId,
        authorId: message.author.id,
        channelId: message.channelId,
        messageId: message.id,
        previousContent: message.content,
        kind: 'deleted',
        capturedAt: new Date(),
      })
      .catch((err: unknown) => log.error('訊息刪除記錄失敗', { error: String(err) }));
  });

  const onReaction =
    (action: 'added' | 'removed') =>
    (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): void => {
      const guildId = reaction.message.guildId;
      if (!guildId || user.bot) return;
      void messages
        .recordReaction({
          guildId,
          messageId: reaction.message.id,
          reactorId: user.id,
          emoji: reaction.emoji.toString(),
          action,
          occurredAt: new Date(),
          messageAuthorId: reaction.message.author?.id ?? null,
        })
        .catch((err: unknown) => log.error('表情回應記錄失敗', { error: String(err) }));
    };

  client.on(Events.MessageReactionAdd, onReaction('added'));
  client.on(Events.MessageReactionRemove, onReaction('removed'));

  const publisher: ChannelPublisher = {
    async post(channelId: string, payload: MessagePayload): Promise<void> {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        throw new Error(`頻道 ${channelId} 不存在或不能發訊息`);
      }
      // 頻道推播沒有 ephemeral 這回事,flags 直接丟掉。
      const { flags: _flags, ...body } = toDiscordMessage(payload);
      await channel.send(body);
    },
  };

  return {
    client,
    publisher,
    async login() {
      await client.login(config.discordToken);
    },
    async destroy() {
      await client.destroy();
    },
  };
}

function channelKindOf(message: Message): string {
  if (message.channel.isThread()) return 'thread';
  if (message.channel.isVoiceBased()) return 'voice_text';
  if ('type' in message.channel && String(message.channel.type) === '15') return 'forum';
  return 'text';
}
