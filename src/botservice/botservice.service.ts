import { Injectable, Logger } from '@nestjs/common';
import { Telegraf, Markup } from 'telegraf';
import { VK } from 'vk-io';
import axios from 'axios';
import * as https from 'https';
import * as crypto from 'crypto';

@Injectable()
export class BotserviceService {
  private readonly logger = new Logger(BotserviceService.name);

  private tgBot: Telegraf | null = null;
  private vk: VK | null = null;

  private readonly telegramChatIds: number[] = [];
  private readonly vkChatIds: number[] = [];

  private pendingEdits: Record<string, any> = {};

  private readonly moderatorChatId = process.env.TELEGRAM_MOD_CHAT_ID
    ? Number(process.env.TELEGRAM_MOD_CHAT_ID)
    : null;

  constructor() {
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const vkToken = process.env.VK_BOT_TOKEN;

    // Telegram
    if (tgToken) {
      this.tgBot = new Telegraf(tgToken);
      this.logger.log('✅ Telegram бот создан');
    } else {
      this.logger.warn('⚠️ TELEGRAM_BOT_TOKEN не задан');
    }

    // VK
    if (vkToken) {
      this.vk = new VK({ token: vkToken });
      this.logger.log('✅ VK бот создан');
    } else {
      this.logger.warn('⚠️ VK_BOT_TOKEN не задан');
    }

    // Telegram Chat IDs
    if (process.env.TELEGRAM_CHAT_IDS) {
      this.telegramChatIds = process.env.TELEGRAM_CHAT_IDS
        .split(',')
        .map((id) => Number(id.trim()))
        .filter(Boolean);
      this.logger.log(`💬 Telegram чаты: ${this.telegramChatIds.join(', ')}`);
    }

    // VK Chat IDs
    if (process.env.VK_CHAT_IDS) {
      this.vkChatIds = process.env.VK_CHAT_IDS
        .split(',')
        .map((id) => Number(id.trim()))
        .filter(Boolean);
      this.logger.log(`💬 VK чаты: ${this.vkChatIds.join(', ')}`);
    }
    if (this.tgBot) {
      this.tgBot.on('callback_query', async (ctx) => {
        const callback = ctx.callbackQuery as any;
        const data = callback?.data as string;
        const msg = callback?.message as any;
        if (!data || !msg) return;

        try {
          this.logger.log(`🔘 Callback query received: ${data}`);

          // --- ОТКЛОНЕНИЕ ---
          if (data.startsWith('reject_')) {
            const parts = data.split('_');
            const orderId = parts[2];

            await ctx.editMessageText(`${msg.text}\n\n❌ Отклонено модератором`, { parse_mode: 'HTML' });
            delete this.pendingEdits?.[orderId];
            this.logger.log(`🗑️ Order ${orderId} rejected`);
            await ctx.answerCbQuery('❌ Заказ отклонён');
            return;
          }

          // --- РЕДАКТИРОВАНИЕ ---
          if (data.startsWith('edit_')) {
            const parts = data.split('_');
            const orderId = parts[2];
            const moderatorId = ctx.from?.id;

            if (moderatorId && orderId) {
              this.pendingEdits[moderatorId] = orderId;
            }

            await ctx.reply('✏️ Скопируйте текст выше, внесите правки и отправьте заново.');
            await ctx.answerCbQuery('Ожидаю правок');
            this.logger.log(`✏️ Order ${orderId} awaiting moderator edits`);
            return;
          }

          // --- ОДОБРЕНИЕ ---
          if (data.startsWith('approve_')) {
            const parts = data.split('_');
            const source = parts[1];
            const orderId = parts[2];
            const backendUrl = process.env.MAIN_BACKEND_URL;

            const order = this.pendingEdits?.[orderId];
            if (!order) {
              this.logger.warn(`⚠️ Не найден заказ для orderId=${orderId}`);
              await ctx.answerCbQuery('⚠️ Данные заказа не найдены');
              return;
            }

            try {
              console.log(backendUrl);
              this.logger.log(`📡 Отправка запроса на ${backendUrl}/order/create-from-bot`);
              const response = await axios.post(`${backendUrl}/order/create-from-bot`, { order });
              if (response.data?.success) {
                this.logger.log(`✅ Order ${orderId} успешно добавлен в базу`);
                await ctx.editMessageText(`${msg.text}\n\n✅ Одобрено модератором`, { parse_mode: 'HTML' });
                await ctx.answerCbQuery('✅ Заказ успешно добавлен в базу');
              } else {
                throw new Error(response.data?.error || 'Неизвестная ошибка при добавлении заказа');
              }
            } catch (err) {
              this.logger.error(`❌ Ошибка при добавлении Order ${orderId} в базу`, err as Error);
              await ctx.answerCbQuery('❌ Ошибка при добавлении заказа в базу');
            }

            delete this.pendingEdits?.[orderId];
          }
        } catch (err) {
          this.logger.error('❌ Ошибка при обработке callback_query', err as Error);
          await ctx.answerCbQuery('Ошибка обработки кнопки');
        }
      });
    }

    this.listenForIncomingMessages();
  }
  
  //ФУНКЦИЯ ПРОСЛУШКИ СООБЩЕНИЙ
  private async listenForIncomingMessages() {
    const gigaKey = process.env.GIGACHAT_API_KEY;
    if (!this.tgBot || !this.vk || !gigaKey) {
      this.logger.warn('⚠️ Отсутствует TELEGRAM/VK бот или GIGACHAT_API_KEY');
      return;
    }

    // === Telegram ===
    this.tgBot.on('text', async (ctx) => {
      const text = ctx.message.text;
      const user = ctx.from;
      this.logger.log(`📩 Telegram сообщение: ${text}`);

      if (!this.isPotentialOrder(text)) return;
      const order = await this.parseOrderWithGigaChat(text, gigaKey);
      await this.sendToModerator(order, user, 'telegram');
    });

    // === VK ===
    this.vk.updates.on('message_new', async (ctx) => {
      const text = ctx.text || '';
      if (!text) return;

      const user = { first_name: ctx.sender?.first_name || '', username: ctx.sender?.username || '' };
      this.logger.log(`📩 VK сообщение: ${text}`);

      if (!this.isPotentialOrder(text)) return;
      const order = await this.parseOrderWithGigaChat(text, gigaKey);
      await this.sendToModerator(order, user, 'vk');
    });

    await this.vk.updates.start().catch(err => this.logger.error('🚨 VK updates error', err));
    await this.tgBot.launch();
    this.logger.log('🤖 Прослушка Telegram и VK запущена');
  }

  //ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ
  private async isPotentialOrder(msg: string) {
    const text = msg.toLowerCase();
    let score = 0;
    const reasons: string[] = [];

    const strong = ['требуется', 'требуются', 'нужен', 'нужны', 'ищем', 'ищется', 'вакансия', 'вакансии'];
    for (const w of strong) if (text.includes(w)) { score += 3; reasons.push(`+kw:${w}`); }

    const pay = ['плачу', 'оплата', 'руб', '₽', 'з/п', 'зарплата'];
    for (const w of pay) if (text.includes(w)) { score += 3; reasons.push(`+pay:${w}`); }

    const timeWords = ['час', 'часа', 'день', 'дней', 'смена', 'смены', 'вечером', 'утром', 'завтра', 'послезавтра', 'сегодня'];
    for (const w of timeWords) if (text.includes(w)) { score += 2; reasons.push(`+time:${w}`); }

    const moneyRegex = /(\d[\d\s.,]*\s?(руб|р\b|₽)|\b\d{3,}\b)/i;
    if (moneyRegex.test(text)) { score += 3; reasons.push('+money'); }

    const pplRegex = /\b(\d+)\s*(человека|чел|человек|людей)\b/i;
    if (pplRegex.test(text)) { score += 2; reasons.push('+people'); }

    const timeRange = /с\s*\d{1,2}[:.]?\d{0,2}\s*(до|-)\s*\d{1,2}[:.]?\d{0,2}/i;
    if (timeRange.test(text)) { score += 2; reasons.push('+timerange'); }

    const jokewords = ['прикол', 'шутк', 'мем', 'лол', 'хаха', 'хах', 'пранк', 'смешн', 'хуй', 'хуе', 'бля', 'лох', 'лош', 'чурк', 'член', 'еблан', 'писюн', 'машонк', 'мошонк', 'гей', 'геи', 'срак', 'героин', 'гера', 'герыч', 'мефедрон', 'соль', 'прон', 'порн', 'сэкс', 'меф', 'чурок'];
    for (const w of jokewords) if (text.includes(w)) { score -= 6; reasons.push(`-joke:${w}`); }

    if (text.trim().split(/\s+/).length < 3) { score -= 2; reasons.push('-too-short'); }

    const trivial = ['привет', 'как дела', 'здорово', 'ура', 'спасибо'];
    for (const w of trivial) if (text.includes(w)) { score -= 4; reasons.push(`-trivial:${w}`); }

    if (text.length > 40) { score += 1; reasons.push('+long'); }

    const threshold = 4;
    return { ok: score >= threshold, score, reasons };
  }


  //ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ
  private async parseOrderWithGigaChat(msg: string, gigaKey: string) {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const authResp = await axios.post(
      'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
      'scope=GIGACHAT_API_PERS',
      {
        headers: {
          Authorization: `Basic ${gigaKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          RqUID: crypto.randomUUID(),
        },
        httpsAgent,
      },
    );

    const token = authResp.data.access_token;
    const resp = await axios.post(
      'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
      {
        model: 'GigaChat:latest',
        messages: [
          {
            role: 'system',
            content: `
Ты — парсер заказов. 
Ответ должен быть строго в формате JSON без лишнего текста, комментариев или объяснений.

Требуемые поля (все обязательно должны присутствовать):

{
  "title": "string", // кратко название работы
  "shortDescription": "string", // короткое описание (1 предложение, максимум 10 слов)
  "description": "string", // сама суть задания, вся детальная информация
  "date": "YYYY-MM-DD", // если указано "сегодня/завтра/послезавтра" — вычисли дату относительно ${new Date().toISOString().split('T')[0]}
  "startTime": "string", // время начала ("10:00" или "не указано")
  "hours": number, // длительность в часах, если можно вычислить (например "с 10 до 18" = 8), иначе 0
  "address": "string", // место проведения работ
  "budget": number, // оплата на одного человека (только число)
  "paymentType": "hourly" | "shift", // если указано "за час" — hourly, иначе shift
  "dateType": "date" | "by agreement", // если дата указана — date, если сказано "по договорённости" — by agreement
  "employer_name": "string", // если есть имя заказчика, иначе "не указано"
  "images": [], // всегда пустой массив
  "type": "string", // если можно определить тип ("грузчики", "уборка", "промоутеры" и т.п.), иначе "другое"
  "applications": [] // всегда пустой массив
}

Если данных нет — обязательно пиши "не указано" или 0 в соответствии с типом поля.

Пример правильного ответа:
{
  "title": "Грузчики",
  "shortDescription": "Помощь при разгрузке фуры",
  "description": "Нужны 2 грузчика для разгрузки фуры с мебелью по адресу Сибирская 27. Начало в 10:00, примерно 6 часов работы. Оплата 2500 рублей за смену.",
  "date": "2025-10-17",
  "startTime": "10:00",
  "hours": 6,
  "address": "Сибирская 27",
  "budget": 2500,
  "paymentType": "shift",
  "dateType": "date",
  "employer_name": "не указано",
  "images": [],
  "type": "грузчики",
  "applications": []
}
`
            ,
          },
          { role: 'user', content: msg },
        ],
      },
      { headers: { Authorization: `Bearer ${token}` }, httpsAgent },
    );

    try {
      return JSON.parse(resp.data.choices[0].message.content);
    } catch {
      return { title: msg, description: msg, date: '', address: '', budget: '', hours: '' };
    }
  }


  //ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ
  private async sendToModerator(order: any, user: any, source: 'telegram' | 'vk') {
    if (!this.moderatorChatId || !this.tgBot) return;

    // Создаём уникальный ID и сохраняем заказ во временное хранилище
    const orderId = order._id?.toString() || crypto.randomUUID();
    if (!this.pendingEdits) this.pendingEdits = {};
    this.pendingEdits[orderId] = order;

    const message = `
<b>✨ Новое объявление!</b>
<b>${order.title}</b>

📝 ${order.description || 'Описание не указано'}
📅 <b>Дата:</b> ${order.date || 'не указано'}
📍 <b>Адрес:</b> ${order.address || 'не указано'}
💰 <b>Оплата:</b> ${order.budget || 'не указано'}

👤 Отправитель: ${user.username || user.first_name || 'неизвестно'}
📦 Источник: ${source}
`;

    await this.tgBot.telegram.sendMessage(this.moderatorChatId, message, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          Markup.button.callback(`✅ Готово`, `approve_${source}_${orderId}`),
          Markup.button.callback(`❌ Отмена`, `reject_${source}_${orderId}`),
          Markup.button.callback(`✏️ Редактировать`, `edit_${source}_${orderId}`)
        ]]
      }
    });

    this.logger.log(`📨 Отправлено модератору (${this.moderatorChatId}), orderId=${orderId}`);
  }

  //ФУНКЦИЯ РАССЫЛКИ ПО ЧАТАМ
  async sendOrderToChats(order: {
    title: string;
    description?: string;
    date?: string;
    address?: string;
    budget?: string;
    startTime?: string;
    hours?: string;
    paymentType?: 'hourly' | 'shift';
    dateType?: 'date' | 'by agreement';
    employerName?: string;
  }) {
    this.logger.log(`🚀 Отправка заказа в чаты: ${JSON.stringify(order)}`);

    const cleanDescription = (order.description || '')
      .replace(/<p[^>]*>/g, '')
      .replace(/<\/p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .trim();

    const dateText =
      order.dateType === 'by agreement'
        ? 'По договорённости'
        : order.date
          ? new Date(order.date).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
          })
          : 'не указана';

    const timeText =
      order.startTime && order.hours
        ? `${order.startTime} (${order.hours} ч)`
        : order.startTime
          ? `${order.startTime}`
          : order.hours
            ? `${order.hours} ч`
            : 'не указано';

    const paymentText =
      order.paymentType === 'hourly'
        ? `${order.budget || 'не указано'} ₽/час`
        : order.paymentType === 'shift'
          ? `${order.budget || 'не указано'} ₽ за смену`
          : `${order.budget || 'не указано'} ₽`;

    const mapUrl = order.address
      ? `https://yandex.ru/maps/?text=${encodeURIComponent(order.address)}`
      : null;

    const message = `
<b>🆕 Новый заказ!</b>

<b>${order.title}</b>
👤 <b>Работодатель:</b> ${order.employerName || 'не указано'}

📝 <b>Описание:</b>
${cleanDescription || 'Описание не указано'}

📅 <b>Дата:</b> ${dateText}
⏰ <b>Время / длительность:</b> ${timeText}
📍 <b>Адрес:</b> ${order.address || 'не указано'}
💰 <b>Оплата:</b> ${paymentText}
`;

    // === Telegram ===
    if (this.tgBot && this.telegramChatIds.length > 0) {
      for (const chatId of this.telegramChatIds) {
        try {
          const mapUrl = order.address
            ? `https://yandex.ru/maps/?text=${encodeURIComponent(order.address)}`
            : null;

          await this.tgBot.telegram.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                ...(mapUrl ? [Markup.button.url('📍 Открыть на карте', mapUrl)] : []),
                Markup.button.url('🌐 Открыть Nirby', 'https://nirby.ru')
              ]]
            }
          });

          this.logger.log(`📤 Сообщение отправлено в Telegram чат ${chatId}`);
          await new Promise((res) => setTimeout(res, 500));
        } catch (err) {
          this.logger.error(
            `❌ Ошибка при отправке в Telegram чат ${chatId}`,
            err as Error,
          );
        }
      }
    } else {
      this.logger.warn(
        '⚠️ Telegram бот не инициализирован или TELEGRAM_CHAT_IDS не заданы',
      );
    }

    // === VK ===
    if (this.vk && this.vkChatIds.length > 0) {
      for (const chatId of this.vkChatIds) {
        try {
          let vkMessage =
            message.replace(/<[^>]+>/g, '') +
            `\n\n🌐 Сайт: https://nirby.ru`;

          if (mapUrl) {
            vkMessage += `\n📍 Карта: ${mapUrl}`;
          }

          await this.vk.api.messages.send({
            peer_id: chatId,
            random_id: Date.now(),
            message: vkMessage,
          });
          this.logger.log(`📤 Сообщение отправлено в VK чат ${chatId}`);
          await new Promise((res) => setTimeout(res, 500));
        } catch (err) {
          this.logger.error(
            `❌ Ошибка при отправке в VK чат ${chatId}`,
            err as Error,
          );
        }
      }
    } else {
      this.logger.warn(
        '⚠️ VK бот не инициализирован или VK_CHAT_IDS не заданы',
      );
    }

    return { success: true, message: 'Сообщения отправлены (если всё настроено)' };
  }
}
