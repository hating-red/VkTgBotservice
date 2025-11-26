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
      const text = (post as any)?.text;
      if (!text) return;

      const user = { username: 'PitcherBot', first_name: 'Pitcher' };

      let isEditedJSON = false;
      let order: any;

      try {
        order = JSON.parse(text);
        if (order?.orderId) {
          isEditedJSON = true;
          this.logger.log(`[CatcherService] channel_post: received edited JSON for orderId=${order.orderId}`);
        }
      } catch {
      }

      if (isEditedJSON) {
        this.pendingEdits[order.orderId] = order;
        await this.sendToModeratorWithButtons(order.orderId, order, user);
        this.logger.log(`[CatcherService] channel_post: resent edited orderId=${order.orderId} with buttons`);
        return;
      }

      const orderId = generateOrderId();
      this.logger.log(`channel_post: new post, generated orderId=${orderId}. Starting parser...`);

      try {
        const gigaKey = process.env.GIGACHAT_API_KEY;

        // --- Очистка текста от служебных сообщений ---
        let cleanText = text;

        const match = text.match(/📨 <b>Новое объявление \(оригинал\)<\/b>\n([\s\S]*?📦 Источник:.*)/);
        if (match && match[1]) {
          cleanText = match[1].trim();
          this.logger.log(`[CatcherService] channel_post: extracted clean text for parsing`);
        } else {
          this.logger.warn(`[CatcherService] channel_post: unable to extract clean text, using full post`);
        }

        const parsedOrder = await parseOrderWithGigaChat(cleanText, gigaKey!);

        parsedOrder.isEditing = false;
        this.pendingEdits[orderId] = parsedOrder;

        await this.sendToModeratorWithButtons(orderId, parsedOrder, user);
        this.logger.log(`channel_post: sent parsed orderId=${orderId} to moderator with buttons`);
      } catch (err) {
        this.logger.error('❌ Ошибка парсинга заказа в channel_post', err as Error);
      }
    });

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

          const requiredFields = ['title', 'paymentType', 'budget', 'date', 'startTime'];
          for (const field of requiredFields) {
            if (!order[field]) {
              this.logger.error(`❌ Order ${orderId} missing required field: ${field}`);
              await ctx.answerCbQuery(`⚠️ Order неполный. Поле ${field} обязательно`);
              return;
            }
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
          const entry = this.pendingEdits?.[orderId];

          if (!entry) {
            this.logger.warn(`callback_query: edit requested but pendingEdits[${orderId}] not found`);
            await ctx.answerCbQuery('⚠️ Данные заказа не найдены');
            return;
          }

          const editableJSON = {
            ...entry,
            orderId,
          };

          await ctx.reply(
            '✏️ Кикер меняет траекторию мяча.\nСкопируйте JSON ниже, внесите правки и отправьте обратно в канал:',
            { parse_mode: 'Markdown' }
          );
          await ctx.reply('```json\n' + JSON.stringify(editableJSON, null, 2) + '\n```', { parse_mode: 'Markdown' });

          delete this.pendingEdits[orderId];
          this.logger.log(`callback_query: orderId=${orderId} sent as editable JSON to moderator`);
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
🧤🧤🧤🧤🧤🧤🧤🧤🧤🧤

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

🧤🧤🧤🧤🧤🧤🧤🧤🧤🧤
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
