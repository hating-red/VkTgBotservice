import { Injectable, Logger } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { VK } from 'vk-io';
import { cleanDescription } from '../shared/cleaning';
import { calculateEndTime } from '../shared/time';
import { formatDate } from '../shared/date';

@Injectable()
export class BotserviceService {
  private readonly logger = new Logger(BotserviceService.name);

  private tgBot: Telegraf | null = null;
  private vk: VK | null = null;

  private telegramChatIds: number[] = [];
  private vkChatIds: number[] = [];

  constructor() {
    const tgToken = process.env.TELEGRAM_PITCHER_TOKEN;
    const vkToken = process.env.VK_BOT_TOKEN;

    if (tgToken) this.tgBot = new Telegraf(tgToken);
    if (vkToken) this.vk = new VK({ token: vkToken });

    if (process.env.TELEGRAM_CHAT_IDS) {
      this.telegramChatIds = process.env.TELEGRAM_CHAT_IDS.split(',').map(Number);
    }

    if (process.env.VK_CHAT_IDS) {
      this.vkChatIds = process.env.VK_CHAT_IDS.split(',').map(Number);
    }
  }

  async sendOrderToChats(order: any) {
    const timeInfo =
      order.startTime && order.hours
        ? `с ${order.startTime} до ${calculateEndTime(order.startTime, order.hours)} (${order.hours} ч.)`
        : order.startTime || 'не указано';

    let message = `
<b>🆕 Новый заказ!</b>
<b>${order.title}</b>

📝 ${order.description}
📅 ${formatDate(order.date) || 'не указано'}
📍 ${order.address || 'не указано'}
💰 ${order.budget || 'не указано'} ₽
⏰ Время: ${timeInfo}
`;

    message = cleanDescription(message);

    // --- Telegram ---
    if (this.tgBot) {
      for (const chat of this.telegramChatIds) {
        try {
          await this.tgBot.telegram.sendMessage(chat, message, { parse_mode: 'HTML' });
          this.logger.log(`📨 Order sent to Telegram chat ${chat}`);
        } catch (err) {
          this.logger.error(`❌ Failed to send order to Telegram chat ${chat}`, err);
        }
      }
    }

    // --- VK ---
    if (this.vk) {
      for (const chat of this.vkChatIds) {
        try {
          await this.vk.api.messages.send({
            peer_id: chat,
            message,
            random_id: Date.now(),
          });
          this.logger.log(`📨 Order sent to VK chat ${chat}`);
        } catch (err) {
          this.logger.error(`❌ Failed to send order to VK chat ${chat}`, err);
        }
      }
    }

    return { success: true };
  }
}
