import { Logger } from '@nestjs/common';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import { parseOrderWithGigaChat } from '../../shared/parser';
import { BotserviceService } from '../../botservice/botservice.service';
import { calculateEndTime } from '../../shared/time';
import { cleanDescription } from '../../shared/cleaning';

type ServiceType = 'site' | 'site+broadcast';

interface UserDraft {
    step: 'idle' | 'awaiting_text' | 'confirm';
    serviceType?: ServiceType;
    rawText?: string;
    order?: any;
}

export class CreatorService {
    private readonly logger = new Logger(CreatorService.name);
    private bot: Telegraf;
    private drafts = new Map<number, UserDraft>();

    private startKeyboard() {
        return Markup.inlineKeyboard([
            [Markup.button.callback('➕ Создать новый заказ', 'start_create')],
        ]);
    }


    constructor(
        private readonly botservice: BotserviceService,
    ) {
        const token = process.env.TELEGRAM_CREATOR_TOKEN;
        if (!token) throw new Error('TELEGRAM_CREATOR_TOKEN not set');

        this.bot = new Telegraf(token);
        this.init();
        this.bot.launch();
        this.logger.log('🤖 OrderCreatorBot started');
    }

    private init() {
        this.bot.start(async (ctx) => {
            if (ctx.chat.type !== 'private') return;

            this.drafts.set(ctx.from.id, { step: 'idle' });

            await ctx.reply(
                '👋 Добро пожаловать!\n\nНажмите кнопку ниже, чтобы создать заказ:',
                this.startKeyboard(),
            );
        });

        this.bot.action('start_create', async (ctx) => {
            if (ctx.chat?.type !== 'private') return;

            this.drafts.set(ctx.from.id, { step: 'idle' });

            await ctx.editMessageText(
                '📝 Создание заказа\n\nВыберите вариант размещения:',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [Markup.button.callback('📢 Бесплатно — только сайт', 'service_site')],
                            [Markup.button.callback('🚀 Платно — сайт + рассылка', 'service_broadcast')],
                        ],
                    },
                },
            );
        });


        /** SERVICE SELECT */
        this.bot.action(['service_site', 'service_broadcast'], async (ctx) => {
            const callback = ctx.callbackQuery as any;
            const data = callback?.data as string;
            const serviceType: ServiceType =
                data === 'service_site'
                    ? 'site'
                    : 'site+broadcast';

            this.drafts.set(ctx.from.id, {
                step: 'awaiting_text',
                serviceType,
            });

            await ctx.editMessageText(
                '✏️ Напишите заказ одним сообщением.\n\nПример:\n\n' +
                'Нужны 2 грузчика\n' +
                'Адрес: Пермский 86\n' +
                'Завтра с 10:00 до 16:00\n' +
                'Оплата 2500 за смену',
            );
        });

        /** TEXT INPUT */
        this.bot.on('text', async (ctx) => {
            if (ctx.chat.type !== 'private') return;

            const draft = this.drafts.get(ctx.from.id);
            if (!draft || draft.step !== 'awaiting_text') return;

            draft.rawText = ctx.message.text;

            try {
                const gigaKey = process.env.GIGACHAT_API_KEY!;
                const order = await parseOrderWithGigaChat(draft.rawText, gigaKey);

                order.employer_name = this.buildTelegramProfileLink(ctx.from);
                draft.order = order;
                draft.step = 'confirm';

                await ctx.reply(
                    this.buildPreviewMessage(order),
                    {
                        parse_mode: 'HTML',
                        reply_markup:
                        {
                            inline_keyboard: ([
                                [Markup.button.callback('✅ Подтвердить', 'confirm')],
                                [Markup.button.callback('✏️ Отредактировать текст', 'edit')],
                                [Markup.button.callback('❌ Отменить', 'cancel')],
                            ]),
                        }
                    },
                );
            } catch (e) {
                this.logger.error(e);
                await ctx.reply('❌ Не удалось разобрать заказ. Попробуйте переформулировать.');
            }
        });

        this.bot.action('confirm', async (ctx) => {
            const draft = this.drafts.get(ctx.from.id);
            if (!draft || draft.step !== 'confirm') return;

            const backendUrl = process.env.MAIN_BACKEND_URL!;
            const order = draft.order;

            try {
                if (draft.serviceType === 'site+broadcast') {
                    let res = await axios.post(`${backendUrl}/order/create-from-bot`, { order });
                    if (!res.data?.success) throw new Error('Backend error');
                }
                else {
                    let res = await axios.post(`${backendUrl}/order/create-from-bot-without-sending`, { order });
                    if (!res.data?.success) throw new Error('Backend error');
                }
                await ctx.editMessageText(
                    draft.serviceType === 'site'
                        ? '✅ Заказ опубликован на сайте nirby.ru'
                        : '🚀 Заказ опубликован и разослан по чатам',
                    {
                        reply_markup: this.startKeyboard().reply_markup,
                    }
                );

                this.drafts.delete(ctx.from.id);
            } catch (e) {
                this.logger.error(e);
                await ctx.reply('❌ Ошибка при публикации заказа');
            }
        });

        /** РЕДАКТИРОВАНИЕ */
        this.bot.action('edit', async (ctx) => {
            const draft = this.drafts.get(ctx.from.id);
            if (!draft) return;

            draft.step = 'awaiting_text';

            await ctx.editMessageText(
                '✏️ Отправьте исправленный текст заказа одним сообщением',
            );
        });

        /** ОТМЕНА */
        this.bot.action('cancel', async (ctx) => {
            this.drafts.delete(ctx.from.id);
            await ctx.editMessageText(
                '❌ Создание заказа отменено',
                {
                    reply_markup: this.startKeyboard().reply_markup,
                });
        });
    }

    // ---------- HELPERS ----------

    private buildTelegramProfileLink(user: any): string {
        if (user.username) {
            return `https://t.me/${user.username}`;
        }
        return `tg://user?id=${user.id}`;
    }

    private buildPreviewMessage(order: any): string {
        const time =
            order.startTime && order.hours
                ? `с ${order.startTime} до ${calculateEndTime(order.startTime, order.hours)}`
                : order.startTime || 'не указано';

        return cleanDescription(`
<b>🧾 Проверьте заказ</b>

<b>${order.title}</b>

📝 ${order.description}
📅 ${order.date || 'не указано'}
📍 ${order.address || 'не указано'}
💰 ${order.budget || 'не указано'} ₽
⏰ ${time}

👤 Заказчик: ${order.employer_name}
`);
    }
}