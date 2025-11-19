import { Injectable, Logger } from '@nestjs/common';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { parseOrderWithGigaChat } from '../../shared/parser';
import { calculateEndTime } from '../../shared/time';
import { cleanDescription } from '../../shared/cleaning';
import { generateOrderId } from '../../shared/order-id';

@Injectable()
export class CatcherService {
  private readonly logger = new Logger(CatcherService.name);

  private tgBot: Telegraf | null = null;

  private readonly modChatId = process.env.TELEGRAM_MOD_CHANNEL_ID;

  private pendingEdits: Record<string, any> = {};

  constructor() {
    const tgToken = process.env.TELEGRAM_CATCHER_TOKEN;

    if (tgToken) {
      this.tgBot = new Telegraf(tgToken);
      this.logger.log('🤖 Catcher Telegram bot started');
    }

    this.listenToModChat();
  }

  private listenToModChat() {
    if (!this.tgBot || !this.modChatId) {
      this.logger.warn('⚠️ Catcher Telegram not configured');
      return;
    }

    this.tgBot.on('channel_post', async (ctx) => {
      const post = ctx.channelPost;

      // Проверяем, что это текстовый пост
      if (!post || !('text' in post)) return;

      const text = post.text;
      if (!text) return;

      const user = { username: 'PitcherBot', first_name: 'Pitcher' };
      const orderId = generateOrderId();

      try {
        const gigaKey = process.env.GIGACHAT_API_KEY;
        const order = await parseOrderWithGigaChat(text, gigaKey!);

        this.pendingEdits[orderId] = order;

        await this.sendToModeratorWithButtons(orderId, order, user);

      } catch (err) {
        this.logger.error('❌ Ошибка парсинга заказа', err);
      }
    });




    // Обработка callback кнопок
    this.tgBot.on('callback_query', async (ctx) => {
      const callback = ctx.callbackQuery as any;
      const data = callback?.data as string;
      const msg = callback?.message as any;
      if (!data || !msg) return;

      try {
        // --- ОДОБРЕНИЕ ---
        if (data.startsWith('approve_')) {
          const parts = data.split('_');
          const orderId = parts[1];
          const backendUrl = process.env.MAIN_BACKEND_URL;

          const order = this.pendingEdits?.[orderId];
          if (!order) {
            this.logger.warn(`⚠️ Не найден заказ для orderId=${orderId}`);
            await ctx.answerCbQuery('⚠️ Данные заказа не найдены');
            return;
          }

          try {
            this.logger.log(`📡 Попытка отправки запроса на ${backendUrl}/order/create-from-bot`);
            const response = await axios.post(`${backendUrl}/order/create-from-bot`, { order });

            if (response.data?.success) {
              this.logger.log(`✅ Order ${orderId} успешно добавлен в базу`);
              await ctx.editMessageText(`${msg.text}\n\n✅ Страйк! Мяч пойман!`, { parse_mode: 'HTML' });
              await ctx.answerCbQuery('✅ Страйк!');
            } else {
              const backendError = response.data?.error || 'Неизвестная ошибка при добавлении заказа';
              this.logger.error(`⚠️ Бэкенд вернул ошибку: ${backendError}`);
              throw new Error(backendError);
            }
          } catch (err) {
            this.logger.error(`❌ Ошибка при добавлении Order ${orderId} в базу`, err);
            await ctx.answerCbQuery('❌ Промах! Мяч улетел мимо!');
          }

          delete this.pendingEdits?.[orderId];
        }

        // --- ОТКЛОНЕНИЕ ---
        if (data.startsWith('reject_')) {
          const orderId = data.split('_')[1];
          delete this.pendingEdits?.[orderId];
          await ctx.editMessageText(`${msg.text}\n\n❌ Мяч не засчитан судьями! Заказ отклонён`, { parse_mode: 'HTML' });
          await ctx.answerCbQuery('❌ Не засчитан!');
        }

        // --- РЕДАКТИРОВАНИЕ ---
        if (data.startsWith('edit_')) {
          const orderId = data.split('_')[1];
          this.pendingEdits[orderId].awaitingEdit = true;
          await ctx.reply('✏️ Кикер меняет траекторию мяча (Скопируйте текст выше, внесите правки и отправьте заново.)');
          await ctx.answerCbQuery('✏️ Переброс');
        }

      } catch (err) {
        this.logger.error('❌ Ошибка при обработке callback_query', err as Error);
        await ctx.answerCbQuery('Ошибка обработки кнопки');
      }
    });

    this.tgBot.launch();
    this.logger.log('🎯 Catcher listening to moderator chat');
  }

  private async sendToModeratorWithButtons(orderId: string, order: any, user: any) {
    if (!this.tgBot || !this.modChatId) return;

    const msg = `
🧤 <b>Кэтчер ловит мяч!</b>

<b>✨ Новое объявление!</b>
<b>${order.title}</b>

📝 ${cleanDescription(order.description)}
📅 Дата: ${order.date || 'не указано'}
📍 Адрес: ${order.address || 'не указано'}
💰 Оплата: ${order.budget || 'не указано'}
⏰ Время: ${order.startTime && order.hours
        ? `с ${order.startTime} до ${calculateEndTime(order.startTime, order.hours)} (${order.hours} ч.)`
        : order.startTime || 'не указано'}

👤 Отправитель: ${user.username || user.first_name || 'неизвестно'}

🧤 <b>Кэтчер ловит мяч!</b>
`;

    await this.tgBot.telegram.sendMessage(this.modChatId, msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          Markup.button.callback(`✅ Готово`, `approve_${orderId}`),
          Markup.button.callback(`❌ Отмена`, `reject_${orderId}`),
          Markup.button.callback(`✏️ Редактировать`, `edit_${orderId}`)
        ]]
      }
    });
  }
}
