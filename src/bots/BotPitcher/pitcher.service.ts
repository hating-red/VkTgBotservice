import { Injectable, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { VK } from 'vk-io';
import { isPotentialOrder } from '../../shared/filters';

@Injectable()
export class PitcherService {
  private readonly logger = new Logger(PitcherService.name);

  private tgBot: Telegraf | null = null;
  private vk: VK | null = null;

  private readonly draftChannelId = process.env.TELEGRAM_MOD_CHANNEL_ID;

  constructor() {
    const tgToken = process.env.TELEGRAM_PITCHER_TOKEN;
    const vkToken = process.env.VK_BOT_TOKEN;

    if (tgToken) {
      this.tgBot = new Telegraf(tgToken);
      this.logger.log('🤖 Pitcher Telegram bot started');
    }

    if (vkToken) {
      this.vk = new VK({ token: vkToken });
      this.logger.log('🤖 Pitcher VK bot started');
    }

    this.listen();
  }

  private async listen() {
    if (!this.tgBot || !this.draftChannelId) {
      this.logger.warn('⚠️ Pitcher Telegram not configured');
      return;
    }

    // === Telegram listener ===
    this.tgBot.on('text', async (ctx) => {
      // Игнорируем посты, если они уже идут из канала (чтобы не зацикливать)
      if (ctx.chat.id === Number(this.draftChannelId)) return;

      const text = ctx.message.text;
      const user = ctx.from;
      this.logger.log(text);
      // Проверяем, похоже ли на заказ
      const potential = isPotentialOrder(text);
      if (!potential.ok) return;

      await this.sendToModerator(text, user, 'telegram');
    });

    // === VK listener ===
    if (this.vk) {
      this.vk.updates.on('message_new', async (ctx) => {
        const text = ctx.text || '';
        if (!text) return;

        const user = { first_name: ctx.sender?.first_name || '', username: ctx.sender?.username || '' };

        const potential = isPotentialOrder(text);
        if (!potential.ok) return;

        await this.sendToModerator(text, user, 'vk');
      });

      await this.vk.updates.start().catch(err => this.logger.error('🚨 VK updates error', err));
    }

    await this.tgBot.launch();
    this.logger.log('🎯 Pitcher listening to Telegram & VK');
  }

  private async sendToModerator(text: string, user: any, source: 'telegram' | 'vk') {
    if (!this.draftChannelId || !this.tgBot) return;

    const msg = `

⚾⚾⚾⚾⚾⚾⚾⚾⚾⚾

📨 <b>Новое объявление (оригинал)</b>

${text}

👤 Отправитель: ${user.username || user.first_name || 'неизвестно'}
📦 Источник: ${source}

⚾⚾⚾⚾⚾⚾⚾⚾⚾⚾
`;

    await this.tgBot.telegram.sendMessage(this.draftChannelId, msg, { parse_mode: 'HTML' });
    this.logger.log(`📤 Сообщение переслано в модераторский канал (${source})`);
  }
}
