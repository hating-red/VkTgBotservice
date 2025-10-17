// import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// import { InjectModel } from '@nestjs/mongoose';
// import { Model, Types } from 'mongoose';
// import { Telegraf, Markup } from 'telegraf';
// import { VK } from 'vk-io';
// import axios from 'axios';
// import * as crypto from 'crypto';
// import * as https from 'https';
// import { OrderDocument } from './schemas/order.schema';

// @Injectable()
// export class BotService implements OnModuleInit, OnModuleDestroy {
//   private readonly logger = new Logger(BotService.name);

//   private tgBot: Telegraf | null = null;
//   private vk: VK | null = null;

//   private readonly moderatorChatId = process.env.TELEGRAM_MOD_CHAT_ID ? Number(process.env.TELEGRAM_MOD_CHAT_ID) : null;
//   private readonly telegramPubChatId = process.env.TELEGRAM_PUB_CHAT_ID ? Number(process.env.TELEGRAM_PUB_CHAT_ID) : null;

//   constructor(@InjectModel('Order') private readonly orderModel: Model<OrderDocument>) { }

//   async onModuleInit() {
//     const tgToken = process.env.TELEGRAM_BOT_TOKEN;
//     const vkToken = process.env.VK_GROUP_TOKEN;
//     const gigaKey = process.env.GIGACHAT_API_KEY;

//     if (!tgToken || !vkToken || !gigaKey) {
//       this.logger.warn('❌ TELEGRAM_BOT_TOKEN, VK_GROUP_TOKEN или GIGACHAT_API_KEY не заданы');
//       return;
//     }

//     this.tgBot = new Telegraf(tgToken);
//     this.logger.log('✅ Telegram bot создан');

//     this.vk = new VK({ token: vkToken });
//     this.logger.log('✅ VK bot создан');

//     const handleMessage = async (msgText: string, user: any, source: 'telegram' | 'vk') => {
//       this.logger.log(`💬 handleMessage: source=${source}, user=${user.username || user.first_name || 'unknown'}, text="${msgText}"`);

//       const { ok, score, reasons } = this.isPotentialWork(msgText);
//       if (!ok) {
//         this.logger.log(`⏭️ Пропуск (score=${score}): ${reasons.join(', ')}`);
//         return;
//       }
//       this.logger.log(`✅ Прошло фильтр (score=${score}): ${reasons.join(', ')}`);

//       const parsedOrder = await this.parseOrderWithGigaChat(msgText, gigaKey, user);
//       this.logger.log(`📝 GigaChat parsing completed: ${JSON.stringify(parsedOrder)}`);

//       const orderDate = parsedOrder.date ? new Date(parsedOrder.date) : new Date();
//       const createdOrder = await this.orderModel.create({
//         ...parsedOrder,
//         applications: [],
//         employer_id: new Types.ObjectId(),
//         employer_name: user.username || user.first_name || user.firstName || 'неизвестно',
//         paymentType: 'shift',
//         type: source === 'telegram' ? 'Объявление из Telegram' : 'Объявление из VK',
//         createdAt: new Date(),
//         dateType: 'by agreement',
//       });
//       this.logger.log(`💾 Order created in DB: ${createdOrder._id.toString()}`);

//       const message = this.formatMessageForModeration(parsedOrder, user, source);
//       const orderId = createdOrder._id.toString();

//       if (this.moderatorChatId && this.tgBot) {
//         await this.tgBot.telegram.sendMessage(this.moderatorChatId, message, {
//           parse_mode: 'HTML',
//           reply_markup: {
//             inline_keyboard: [[
//               Markup.button.callback(`✅ Готово`, `approve_${source}_${orderId}`),
//               Markup.button.callback(`❌ Отмена`, `reject_${source}_${orderId}`),
//               Markup.button.callback(`✏️ Редактировать`, `edit_${source}_${orderId}`)
//             ]],
//           },
//         });
//         this.logger.log(`📩 Message sent to moderator chat (${this.moderatorChatId})`);
//       } else {
//         this.logger.warn('⚠️ Moderator chat ID not set or Telegram bot missing');
//       }
//     };

//     // --- Telegram обработка ---
//     this.tgBot.on('text', async (ctx) => {
//       const msg = ctx.message.text;
//       const user = ctx.from;
//       const chatId = ctx.chat.id.toString();
//       this.logger.log(`📩 Telegram message received from chatId=${chatId}: ${msg}`);

//       if (chatId === this.moderatorChatId?.toString() || !process.env.TELEGRAM_INPUT_CHAT_ID || chatId === process.env.TELEGRAM_INPUT_CHAT_ID) {
//         await handleMessage(msg, user, 'telegram');
//       } else {
//         this.logger.log(`🚫 Telegram message ignored (not in allowed chat)`);
//       }
//     });

//     // --- VK обработка ---
//     const lp = this.vk.updates;
//     lp.start()
//       .then(() => this.logger.log('🤖 VK bot started and listening for messages'))
//       .catch((err) => this.logger.error('🚨 VK bot start error', err));

//     lp.on('message_new', async (ctx) => {
//       const msg = ctx.text || '';
//       if (!msg) {
//         this.logger.log('⚠️ Empty VK message received, skipping');
//         return;
//       }

//       const user = { first_name: ctx.sender?.first_name || '', username: ctx.sender?.username || '' };
//       this.logger.log(`📩 VK message received from userId=${ctx.senderId}: ${msg}`);

//       await handleMessage(msg, user, 'vk');
//     });

//     // --- Callback_query для модерации ---
//     this.tgBot.on('callback_query', async (ctx) => {
//       const callback = ctx.callbackQuery as any;
//       const data = callback?.data;
//       const msg = callback?.message as any;

//       if (!data || !msg || !this.moderatorChatId) return;

//       try {
//         this.logger.log(`🔘 Callback query received: ${data}`);

//         if (data.startsWith('reject_')) {
//           await ctx.editMessageText(`${msg.text}\n\n❌ Отклонено модератором`, { parse_mode: 'HTML' });
//           const orderId = data.split('_')[2];
//           await this.orderModel.findByIdAndDelete(orderId);
//           this.logger.log(`🗑️ Order ${orderId} rejected and deleted from DB`);
//           return;
//         }

//         if (data.startsWith('edit_')) {
//           await ctx.reply('✏️ Скопируйте текст выше, отредактируйте и отправьте заново.');
//           this.logger.log(`✏️ Order edit requested: ${data}`);
//           return;
//         }

//         if (data.startsWith('approve_')) {
//           const [_, source, orderId] = data.split('_');
//           const order = await this.orderModel.findById(orderId);
//           if (!order) return;

//           await ctx.editMessageText(`${msg.text}\n\n✅ Одобрено модератором`, { parse_mode: 'HTML' });
//           this.logger.log(`✅ Order ${orderId} approved by moderator`);

//           if (source === 'telegram' && this.telegramPubChatId) {
//             await ctx.telegram.sendMessage(this.telegramPubChatId, msg.text, { parse_mode: 'HTML' });
//             this.logger.log(`📤 Order ${orderId} posted to Telegram public chat`);
//           }

//           if (source === 'vk' && this.vk) {
//             try {
//               // Используем peer_id из последнего полученного сообщения
//               const lastMessage = await this.vk.api.messages.getConversations({ count: 1 });
//               const peerId = lastMessage.items[0]?.conversation?.peer?.id;

//               if (!peerId) {
//                 this.logger.error('❌ Не удалось получить peer_id VK чата');
//                 return;
//               }

//               await this.vk.api.messages.send({
//                 peer_id: peerId,
//                 random_id: Date.now(),
//                 message: `
// ✨ ${order.title}
// 📝 ${order.description}
// 📅 Дата: ${order.date.toISOString().split('T')[0]}
// ⏰ Время: ${order.startTime || 'не указано'}
// 📍 Адрес: ${order.address || 'не указано'}
// 💰 Оплата: ${order.budget || 'не указано'} ₽
// ⏳ Длительность: ${order.hours || 'не указано'} ч.
// 👤 Автор VK: ${order.employer_name}
//       `,
//               });

//               this.logger.log(`📤 Order ${orderId} posted to VK chat (peer_id=${peerId})`);
//             } catch (err) {
//               this.logger.error('❌ Ошибка при отправке сообщения в VK', err);
//             }
//           }

//         }
//       } catch (err) {
//         this.logger.error('❌ Error handling callback_query', err as Error);
//       }
//     });

//     this.tgBot.launch().then(() => this.logger.log('🤖 Telegram + VK Bot launched'));
//   }

//   async onModuleDestroy() {
//     if (this.tgBot) await this.tgBot.stop();
//     this.logger.log('🛑 Bot stopped');
//   }

//   // --- Вспомогательные функции ---
//   private isPotentialWork(msg: string) {
//     const text = msg.toLowerCase();
//     let score = 0;
//     const reasons: string[] = [];

//     const strong = ['требуется', 'требуются', 'нужен', 'нужны', 'ищем', 'ищется', 'вакансия', 'вакансии'];
//     strong.forEach(w => text.includes(w) && (score += 3, reasons.push(`+kw:${w}`)));

//     const pay = ['плачу', 'оплата', 'руб', '₽', 'з/п', 'зарплата'];
//     pay.forEach(w => text.includes(w) && (score += 3, reasons.push(`+pay:${w}`)));

//     const timeWords = ['час', 'часа', 'день', 'дней', 'смена', 'смены', 'вечером', 'утром', 'завтра', 'послезавтра', 'сегодня'];
//     timeWords.forEach(w => text.includes(w) && (score += 2, reasons.push(`+time:${w}`)));

//     if (/(\d[\d\s.,]*\s?(руб|р\b|₽)|\b\d{3,}\b)/i.test(text)) { score += 3; reasons.push('+money'); }
//     if (/\b(\d+)\s*(человека|чел|человек|людей)\b/i.test(text)) { score += 2; reasons.push('+people'); }
//     if (/с\s*\d{1,2}[:.]?\d{0,2}\s*(до|-)\s*\d{1,2}[:.]?\d{0,2}/i.test(text)) { score += 2; reasons.push('+timerange'); }

//     return { ok: score >= 4, score, reasons };
//   }

//   private async parseOrderWithGigaChat(msg: string, gigaKey: string, user: any) {
//     const httpsAgent = new https.Agent({ rejectUnauthorized: false });
//     const authResp = await axios.post(
//       'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
//       'scope=GIGACHAT_API_PERS',
//       { headers: { Authorization: `Basic ${gigaKey}`, 'Content-Type': 'application/x-www-form-urlencoded', RqUID: crypto.randomUUID() }, httpsAgent }
//     );
//     const accessToken = authResp.data.access_token;

//     const gptResp = await axios.post(
//       'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
//       {
//         model: 'GigaChat:latest',
//         messages: [
//           {
//             role: 'system', content:
//               `Ты парсер заказов. Отвечай строго JSON.
// Поля:
// - title: кратко название работы
// - description: сама суть задания
// - date: YYYY-MM-DD
// - startTime: если есть время
// - address: место работы
// - budget: оплата на 1 человека
// - hours: длительность работы в часах
// Если данных нет — пиши "не указано". Никакого текста кроме JSON.`
//           },
//           { role: 'user', content: msg }
//         ],
//         temperature: 0.2
//       },
//       { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, httpsAgent }
//     );

//     try { return JSON.parse(gptResp.data.choices[0].message.content); }
//     catch { return { title: msg, description: msg, date: new Date().toISOString().split('T')[0], startTime: 'не указано', address: 'не указано', budget: 'не указано', hours: 'не указано' }; }
//   }

//   private formatMessageForModeration(parsedOrder: any, user: any, source: string) {
//     return `
// <b>✨ Новое объявление!</b>
// <b>${parsedOrder.title}</b>
// 📝 ${parsedOrder.description}
// 📅 <b>Дата:</b> ${parsedOrder.date}
// ⏰ <b>Время:</b> ${parsedOrder.startTime}
// 📍 <b>Адрес:</b> ${parsedOrder.address}
// 💰 <b>Оплата:</b> ${parsedOrder.budget} рублей
// ⏳ <b>Длительность:</b> ${parsedOrder.hours} часов
// 👤 Автор: ${user.username ? '@' + user.username : user.first_name || user.firstName || 'неизвестно'}
// <b>Источник:</b> ${source}`;
//   }
// }
