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

  private formatForVK(message: string): string {
    return message
      .replace(/<b>(.*?)<\/b>/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace('🆕 Новый заказ!', '🆕 НОВЫЙ ЗАКАЗ!');
  }

  async sendOrderToChats(order: any) {
    this.logger.log(order.employer_name);
    const timeInfo =
      order.startTime && order.hours
        ? `с ${order.startTime} до ${calculateEndTime(order.startTime, order.hours)} (${order.hours} ч.)`
        : order.startTime || 'не указано';

    let message = `
<b>🆕 Новый заказ!</b>
<b>${order.title}</b>

📝 ${cleanDescription(order.description)}
📅 ${formatDate(order.date) || 'не указано'}
📍 ${order.address || 'не указано'}
💰 ${order.budget || 'не указано'} ₽
⏰ Время: ${timeInfo}
`;

    const mapLink = order.address
      ? `https://yandex.ru/maps/?text=${encodeURIComponent(order.address)}`
      : null;
    const orderLink = `https://nirby.ru/order/${order.orderId}`;

    if (this.vk && this.vkChatIds.length > 0) {
      let vkMessage = this.formatForVK(message);
      if (mapLink) vkMessage += `\n📍 Посмотреть на карте: ${mapLink}`;
      // vkMessage += `\n🔗 Перейти к заказу: ${orderLink}`;
      vkMessage += `\n➡️ Связаться с заказчиком: ${order.employerName}`;

      for (const chat of this.vkChatIds) {
        try {
          await this.vk.api.messages.send({
            peer_id: chat,
            message: vkMessage,
            random_id: Date.now(),
          });
          this.logger.log(`📨 Order sent to VK chat ${chat}`);
        } catch (err) {
          this.logger.error(`❌ Failed to send order to VK chat ${chat}`, err);
        }
      }
    }
    if (this.tgBot && this.telegramChatIds.length > 0) {
      const buttons: any[] = [];
      // buttons.push([{ text: '➡️ Перейти к заказу', url: orderLink }]);
      if (mapLink) buttons.push([{ text: '📍 Посмотреть на карте', url: mapLink }]);
      buttons.push([{ text: '➡️ Связаться с заказчиком', url: order.employerName }]);

      for (const chat of this.telegramChatIds) {
        try {
          await this.tgBot.telegram.sendMessage(chat, message, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: buttons,
            },
          });
          this.logger.log(`📨 Order sent to Telegram chat ${chat}`);
        } catch (err) {
          this.logger.error(`❌ Failed to send order to Telegram chat ${chat}`, err);
        }
      }
    }

    return { success: true };
  }
}
