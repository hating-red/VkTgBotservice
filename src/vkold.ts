// import {
//   Injectable,
//   Logger,
//   OnModuleInit,
//   OnModuleDestroy,
// } from '@nestjs/common';
// import { InjectModel } from '@nestjs/mongoose';
// import { Model, Types } from 'mongoose';
// import { VK } from 'vk-io';
// import axios from 'axios';
// import * as crypto from 'crypto';
// import * as https from 'https';

// import { OrderDocument } from './schemas/order.schema';

// @Injectable()
// export class VkService implements OnModuleInit, OnModuleDestroy {
//   private readonly logger = new Logger(VkService.name);
//   private vk: VK | null = null;

//   constructor(
//     @InjectModel('Order') private readonly orderModel: Model<OrderDocument>,
//   ) {}

//   async onModuleInit() {
//     const vkToken = process.env.VK_GROUP_TOKEN;
//     const gigaKey = process.env.GIGACHAT_API_KEY;

//     if (!vkToken) {
//       this.logger.warn('⚠️ VK_GROUP_TOKEN не задан в .env');
//       return;
//     }

//     if (!gigaKey) {
//       this.logger.warn('⚠️ GIGACHAT_API_KEY не задан в .env');
//       return;
//     }

//     this.vk = new VK({ token: vkToken });
//     const lp = this.vk.updates;

//     // Стартуем Long Poll
//     lp.start()
//       .then(() => this.logger.log('🤖 VK-бот запущен и слушает сообщения'))
//       .catch((err) => this.logger.error('🚨 Ошибка запуска VK-бота', err));

//     // -----------------------
//     // Обработка входящих сообщений
//     // -----------------------
//     lp.on('message_new', async (context) => {
//       const msg = context.text || '';
//       const userId = context.senderId;

//       this.logger.log(`📩 Новое сообщение VK от ${userId}: ${msg}`);

//       try {
//         // -----------------------
//         // 1. Фильтрация сообщений
//         // -----------------------
//         function isPotentialWork(msg: string): { ok: boolean; score: number; reasons: string[] } {
//           const text = msg.toLowerCase();
//           let score = 0;
//           const reasons: string[] = [];

//           // + ключевые слова (сильные)
//           const strong = ['требуется', 'требуются', 'нужен', 'нужны', 'ищем', 'ищется', 'вакансия', 'вакансии'];
//           for (const w of strong) if (text.includes(w)) { score += 3; reasons.push(`+kw:${w}`); }

//           // + слова про оплату
//           const pay = ['плачу', 'оплата', 'руб', '₽', 'з/п', 'зарплата'];
//           for (const w of pay) if (text.includes(w)) { score += 3; reasons.push(`+pay:${w}`); }

//           // + слова про время/смены
//           const timeWords = ['час', 'часа', 'день', 'дней', 'смена', 'смены', 'вечером', 'утром', 'завтра', 'послезавтра', 'сегодня'];
//           for (const w of timeWords) if (text.includes(w)) { score += 2; reasons.push(`+time:${w}`); }

//           // + наличие чисел/сумм
//           const moneyRegex = /(\d[\d\s.,]*\s?(руб|р\b|₽)|\b\d{3,}\b)/i;
//           if (moneyRegex.test(text)) { score += 3; reasons.push('+money'); }

//           // + "на X человек" или "X человек"
//           const pplRegex = /\b(\d+)\s*(человека|чел|человек|людей)\b/i;
//           if (pplRegex.test(text)) { score += 2; reasons.push('+people'); }

//           // + диапазон времени "с 10 до 18"
//           const timeRange = /с\s*\d{1,2}[:.]?\d{0,2}\s*(до|-)\s*\d{1,2}[:.]?\d{0,2}/i;
//           if (timeRange.test(text)) { score += 2; reasons.push('+timerange'); }

//           // - слова явной шутки / неработы
//           const jokewords = ['прикол', 'шутк', 'мем', 'лол', 'хаха', 'хах', 'пранк', 'смешн','хуй','хуе','бля','лох','лош','чурк','член','еблан','писюн','машонк','мошонк','гей','геи','срак','героин','гера','герыч','мефедрон','соль','прон','порн','сэкс','меф','чурок'];
//           for (const w of jokewords) if (text.includes(w)) { score -= 6; reasons.push(`-joke:${w}`); }

//           // - короткие сообщения
//           if (text.trim().split(/\s+/).length < 3) { score -= 2; reasons.push('-too-short'); }

//           // - массовые фразы типа "как дела" "привет"
//           const trivial = ['привет', 'как дела', 'здорово', 'ура', 'спасибо'];
//           for (const w of trivial) if (text.includes(w)) { score -= 4; reasons.push(`-trivial:${w}`); }

//           // + длинные сообщения
//           if (text.length > 40) { score += 1; reasons.push('+long'); }

//           const threshold = 4;
//           return { ok: score >= threshold, score, reasons };
//         }

//         const check = isPotentialWork(msg);
//         if (!check.ok) {
//           this.logger.log(`⏭ Пропуск (score=${check.score}): ${check.reasons.join(', ')}`);
//           return;
//         }
//         this.logger.log(`✅ Прошло фильтр (score=${check.score}): ${check.reasons.join(', ')}`);

//         // -----------------------
//         // 2. Парсинг через GigaChat
//         // -----------------------
//         const httpsAgent = new https.Agent({ rejectUnauthorized: false });

//         const authResp = await axios.post(
//           'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
//           'scope=GIGACHAT_API_PERS',
//           {
//             headers: {
//               Authorization: `Basic ${gigaKey}`,
//               'Content-Type': 'application/x-www-form-urlencoded',
//               RqUID: crypto.randomUUID(),
//             },
//             httpsAgent,
//           },
//         );

//         const accessToken = authResp.data.access_token;

//         const gptResp = await axios.post(
//           'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
//           {
//             model: 'GigaChat:latest',
//             messages: [
//               {
//                 role: 'system',
//                 content: `
// Ты парсер заказов. Отвечай строго JSON.
// Поля:
// - title: кратко название работы
// - description: сама суть задания
// - date: YYYY-MM-DD (понимай "сегодня/завтра/послезавтра" относительно ${new Date().toISOString().split('T')[0]})
// - startTime: если есть время (например "с 10:00"), иначе "не указано"
// - address: место работы
// - budget: оплата на 1 человека
// - hours: длительность работы в часах (если указано время начала и конца — вычисли)

// Если данных нет — пиши "не указано". Никакого текста кроме JSON.`,
//               },
//               { role: 'user', content: msg },
//             ],
//             temperature: 0.2,
//           },
//           {
//             headers: {
//               Authorization: `Bearer ${accessToken}`,
//               'Content-Type': 'application/json',
//             },
//             httpsAgent,
//           },
//         );

//         const rawText = gptResp.data.choices[0].message.content;
//         let parsedOrder: any;

//         try {
//           parsedOrder = JSON.parse(rawText);
//         } catch {
//           this.logger.warn('⚠️ Не удалось распарсить JSON из ответа GigaChat, fallback');
//           parsedOrder = {
//             title: `Сообщение от vk_user_${userId}`,
//             description: msg,
//             date: new Date().toISOString().split('T')[0],
//             startTime: 'не указано',
//             address: 'не указано',
//             budget: 'не указано',
//             hours: 'не указано',
//           };
//         }

//         // дата всегда валидна
//         const safeDate = new Date(parsedOrder.date);
//         const orderDate = isNaN(safeDate.getTime()) ? new Date() : safeDate;

//         // -----------------------
//         // 3. Сохраняем заказ в MongoDB
//         // -----------------------
//         const createdOrder = await this.orderModel.create({
//           title: parsedOrder.title || `Сообщение от vk_user_${userId}`,
//           description: parsedOrder.description || msg,
//           applications: [],
//           employer_id: new Types.ObjectId(), // placeholder
//           employer_name: `vk_user_${userId}`,
//           date: orderDate,
//           startTime: parsedOrder.startTime !== 'не указано' ? parsedOrder.startTime : '',
//           address: parsedOrder.address !== 'не указано' ? parsedOrder.address : '',
//           budget: parsedOrder.budget !== 'не указано' ? parsedOrder.budget : '',
//           hours: parsedOrder.hours !== 'не указано' ? parsedOrder.hours : '',
//           paymentType: 'shift',
//           type: 'Объявление из VK',
//           createdAt: new Date(),
//           dateType: 'by agreement',
//         });

//         // -----------------------
//         // 4. Отвечаем пользователю ВК
//         // -----------------------
//         const message = `
// ✨ Новое объявление!
// ${parsedOrder.title}
// 📝 ${parsedOrder.description}

// 📅 Дата: ${parsedOrder.date || 'не указано'}
// ⏰ Время: ${parsedOrder.startTime || 'не указано'}
// 📍 Адрес: ${parsedOrder.address || 'не указано'}
// 💰 Оплата: ${parsedOrder.budget || 'не указано'} рублей
// ⏳ Длительность: ${parsedOrder.hours || 'не указано'} ч.

// (ссылка на отклик позже)
//         `;

//         await context.send(message);
//       } catch (err) {
//         this.logger.error('❌ Ошибка при сохранении заказа из VK', err as Error);
//         await context.send('⚠️ Не удалось сохранить объявление');
//       }
//     });
//   }

//   async onModuleDestroy() {
//     if (this.vk) {
//       this.logger.log('🛑 VK-бот остановлен');
//     }
//   }
// }
