require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const http = require('http');

const bot = new Telegraf(process.env.BOT_TOKEN);

const WELCOME_TEXT =
  `💰 *Зарабатывай на своих рекомендациях*\n\n` +
  `Делись приложением — получай деньги за каждую оплату подписчика.\n\n` +
  `*Как это работает:*\n` +
  `1️⃣ Получаешь уникальную реферальную ссылку\n` +
  `2️⃣ Делишься с подписчиками — они получают *скидку 10% на 14 дней*\n` +
  `3️⃣ Ты получаешь *20% с каждой оплаты*\n\n` +
  `*Примеры дохода:*\n` +
  `• 10 оплат → *980 ₽*\n` +
  `• 50 оплат → *4 900 ₽*\n` +
  `• 100 оплат → *9 800 ₽*\n\n` +
  `Выплаты раз в месяц. Без вложений. Подходит для любого блога.\n\n` +
  `📋 *Условия участия:*\n` +
  `• У вас должно быть от *500 подписчиков*\n` +
  `• Вы сделаете пост с упоминанием нашего приложения и пришлёте его нашему администратору\n\n` +
  `👇 Подайте заявку — пришлём ссылку после проверки:`;

const WELCOME_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.url('📝 Подать заявку', 'https://t.me/hostapaytl')],
  [Markup.button.url('✍️ Написать менеджеру', 'https://t.me/hostapaytl')],
]);

bot.start(async (ctx) => {
  await ctx.reply(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...WELCOME_KEYBOARD,
  });
});

bot.command('help', async (ctx) => {
  await ctx.reply(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...WELCOME_KEYBOARD,
  });
});

bot.on('text', async (ctx) => {
  await ctx.reply(WELCOME_TEXT, {
    parse_mode: 'Markdown',
    ...WELCOME_KEYBOARD,
  });
});

// HTTP-сервер для Render (Web Service требует открытый порт)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('ok')).listen(PORT, () => {
  console.log(`HTTP health check on port ${PORT}`);
});

bot.launch().then(() => {
  console.log('SytayaSemya_PartnerBot запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
