require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const http  = require('http');
const https = require('https');

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

const MAIN_BOT   = process.env.MAIN_BOT_USERNAME  || 'sitaya_semya_bot';
const MAIN_API   = process.env.MAIN_BOT_API_URL   || 'https://sytaya-semya-bot.onrender.com';
const API_SECRET = process.env.PARTNER_API_SECRET || '';
const MIN_PAYOUT = 1000;

// ── API helpers ───────────────────────────────────────────────────────────────

function apiCall(method, path, body = null) {
  const url = `${MAIN_API}${path}${method === 'GET' && body ? '?' + new URLSearchParams(body).toString() : ''}`;
  return new Promise((resolve) => {
    const isGet  = method === 'GET';
    const data   = !isGet && body ? JSON.stringify({ ...body, secret: API_SECRET }) : null;
    const urlObj = new URL(isGet ? url + (API_SECRET ? `&secret=${API_SECRET}` : '') : url);
    const opts   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || 443,
      path:     urlObj.pathname + urlObj.search,
      method,
      headers:  {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    if (data) req.write(data);
    req.end();
  });
}

const api = {
  stats:    (tg_id)  => apiCall('GET',  '/api/partner-stats', { tg_id }),
  profile:  (tg_id)  => apiCall('GET',  '/api/partner/profile', { tg_id }),
  register: (body)   => apiCall('POST', '/api/partner/register', body),
  payout:   (tg_id)  => apiCall('POST', '/api/partner/payout', { tg_id }),
  payouts:  (tg_id)  => apiCall('GET',  '/api/partner/payouts', { tg_id }),
};

// ── Texts ─────────────────────────────────────────────────────────────────────

const WELCOME_TEXT =
  `💰 *Зарабатывай на своих рекомендациях*\n\n` +
  `Делись приложением — получай *20% с каждой оплаты* подписчика пожизненно (LTV).\n\n` +
  `*Как это работает:*\n` +
  `1️⃣ Получаешь уникальную реферальную ссылку\n` +
  `2️⃣ Делишься с подписчиками — они получают *скидку 10% на 14 дней*\n` +
  `3️⃣ Ты получаешь *20% с каждой оплаты и автопродления* 🔥\n\n` +
  `*Примеры дохода:*\n` +
  `• 10 оплат → *980 ₽*\n` +
  `• 50 оплат → *4 900 ₽*\n` +
  `• 100 оплат → *9 800 ₽*\n\n` +
  `Выплаты каждый понедельник на карту по СБП.\n\n` +
  `📋 *Условия:*\n` +
  `• От *500 подписчиков*\n` +
  `• Пост с упоминанием приложения\n\n` +
  `👇 Подайте заявку:`;

const WELCOME_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.url('📝 Подать заявку', `https://t.me/${MAIN_BOT}?start=apply`)],
  [Markup.button.url('✍️ Написать менеджеру', 'https://t.me/hostapaytl')],
]);

// ── Stats screen ──────────────────────────────────────────────────────────────

async function showStats(ctx) {
  const stats = await api.stats(ctx.from.id);
  if (!stats.ok) {
    return ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...WELCOME_KEYBOARD });
  }

  const earned  = stats.total_earned || 0;
  const balance = stats.balance || 0;
  const profile = stats.profile;

  const profileLine = profile
    ? `\n👤 *${profile.name}*${profile.blog ? ` / ${profile.blog}` : ''}\n📱 ${profile.sbp_phone} (${profile.sbp_bank})\n`
    : '\n⚠️ _СБП реквизиты не указаны — введи /setup для регистрации_\n';

  const payoutLine = balance >= MIN_PAYOUT
    ? `\n💸 Доступно к выводу: *${balance} ₽* → /payout`
    : `\n💵 До минимальной выплаты: *${Math.max(0, MIN_PAYOUT - balance)} ₽*`;

  await ctx.reply(
    `📊 *Ваша партнёрская статистика*\n` +
    profileLine +
    `\n🔗 Ваша ссылка:\n\`${stats.link}\`\n\n` +
    `👆 Переходов: *${stats.clicks}*\n` +
    `💳 Оплат: *${stats.sales}*\n` +
    `💰 Заработано всего: *${earned} ₽*\n` +
    `💵 Баланс: *${balance} ₽*` +
    payoutLine,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...(balance >= MIN_PAYOUT ? [[Markup.button.callback('💸 Запросить выплату', 'do_payout')]] : []),
        [Markup.button.url('✍️ Поддержка', 'https://t.me/hostapaytl')],
      ]),
    }
  );
}

// ── Registration flow ─────────────────────────────────────────────────────────

async function startRegistration(ctx) {
  ctx.session.step = 'name';
  await ctx.reply(
    `📝 *Регистрация СБП-реквизитов*\n\n` +
    `Для получения выплат нам нужны ваши данные.\n\n` +
    `*Шаг 1 из 3.* Введите ваше _Имя Фамилия_ и название блога:\n` +
    `_Пример: Анна Иванова / @fashion_blog_`,
    { parse_mode: 'Markdown', ...Markup.forceReply() }
  );
}

async function handleRegistrationStep(ctx) {
  const step  = ctx.session?.step;
  const text  = ctx.message.text?.trim();
  if (!text) return;

  if (step === 'name') {
    ctx.session.reg_name = text;
    ctx.session.step = 'phone';
    return ctx.reply(
      `✅ Отлично!\n\n*Шаг 2 из 3.* Введите номер телефона для СБП:\n_Пример: 79991234567_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  }

  if (step === 'phone') {
    const phone = text.replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 12) {
      return ctx.reply('❌ Неверный формат. Введите номер цифрами, например: 79991234567');
    }
    ctx.session.reg_phone = phone;
    ctx.session.step = 'bank';
    return ctx.reply(
      `✅ Принято!\n\n*Шаг 3 из 3.* Укажите ваш банк:\n_Примеры: Сбербанк, Тинькофф, ВТБ, Альфа-Банк_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
  }

  if (step === 'bank') {
    ctx.session.reg_bank = text;
    ctx.session.step = null;

    const nameParts = (ctx.session.reg_name || '').split(/[/|,]/);
    const name = nameParts[0]?.trim() || ctx.session.reg_name;
    const blog = nameParts[1]?.trim() || null;

    const result = await api.register({
      tg_id:     ctx.from.id,
      name,
      blog,
      sbp_phone: ctx.session.reg_phone,
      sbp_bank:  ctx.session.reg_bank,
    });

    if (result.ok) {
      await ctx.reply(
        `✅ *Реквизиты сохранены!*\n\n` +
        `👤 *${name}*${blog ? ` / ${blog}` : ''}\n` +
        `📱 ${ctx.session.reg_phone} (${ctx.session.reg_bank})\n\n` +
        `Теперь при достижении *${MIN_PAYOUT} ₽* на балансе вы можете запросить выплату командой /payout.\n\n` +
        `_Для просмотра статистики — /stats_`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply('❌ Ошибка сохранения. Попробуйте /setup снова или напишите @hostapaytl');
    }

    ctx.session.reg_name  = null;
    ctx.session.reg_phone = null;
    ctx.session.reg_bank  = null;
    return;
  }
}

// ── Payout flow ───────────────────────────────────────────────────────────────

async function requestPayout(ctx) {
  const tg_id = ctx.from.id;

  // Check profile
  const profileRes = await api.profile(tg_id);
  if (!profileRes.profile) {
    return ctx.reply(
      '⚠️ Сначала укажите реквизиты СБП командой /setup — без них выплата невозможна.',
      { parse_mode: 'Markdown' }
    );
  }

  const result = await api.payout(tg_id);

  if (result.ok) {
    return ctx.reply(
      `✅ *Заявка на выплату принята!*\n\n` +
      `Сумма: *${result.amount} ₽*\n\n` +
      `Заявки обрабатываются до пятницы 23:00 МСК. Деньги придут в понедельник-вторник.\n\n` +
      `Когда выплата будет отправлена — вы получите уведомление здесь. 🚀`,
      { parse_mode: 'Markdown' }
    );
  }

  if (result.reason === 'low_balance') {
    return ctx.reply(
      `❌ Баланс слишком мал для выплаты.\n\n` +
      `Ваш баланс: *${result.balance || 0} ₽*\nМинимум: *${MIN_PAYOUT} ₽*\n\n` +
      `Продолжайте рекомендовать приложение — деньги накапливаются!`,
      { parse_mode: 'Markdown' }
    );
  }

  if (result.reason === 'already_pending') {
    return ctx.reply(
      `⏳ У вас уже есть заявка на выплату в обработке.\n\n` +
      `Сумма: *${result.payout?.amount || '?'} ₽*\n` +
      `Выплата будет отправлена в ближайший понедельник.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (result.reason === 'window_closed') {
    return ctx.reply(
      `⏰ Окно приёма заявок закрыто.\n\n` +
      `Заявки принимаются *с понедельника по пятницу до 23:00 МСК*.\n\n` +
      `Приходите в начале следующей недели!`,
      { parse_mode: 'Markdown' }
    );
  }

  if (result.reason === 'not_partner') {
    return ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...WELCOME_KEYBOARD });
  }

  return ctx.reply('❌ Ошибка. Попробуйте позже или напишите @hostapaytl');
}

// ── Payout history ────────────────────────────────────────────────────────────

async function showPayoutHistory(ctx) {
  const { history } = await api.payouts(ctx.from.id);
  if (!history?.length) {
    return ctx.reply('История выплат пуста. Накапливайте баланс и запрашивайте выплаты! 💰');
  }
  const lines = history.map(p => {
    const date = new Date(p.created_at * 1000).toLocaleDateString('ru-RU');
    const icon = p.status === 'paid' ? '✅' : '⏳';
    return `${icon} ${date} — *${p.amount} ₽* → ${p.sbp_phone} (${p.sbp_bank})`;
  });
  await ctx.reply(
    `📋 *История выплат*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
}

// ── Bot commands ──────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const stats = await api.stats(ctx.from.id);
  if (stats.ok) {
    await showStats(ctx);
  } else {
    await ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...WELCOME_KEYBOARD });
  }
});

bot.command('stats',   showStats);
bot.command('payout',  requestPayout);
bot.command('history', showPayoutHistory);
bot.command('setup',   startRegistration);
bot.command('help', async (ctx) => {
  const stats = await api.stats(ctx.from.id);
  if (stats.ok) {
    await ctx.reply(
      `Доступные команды:\n` +
      `/stats — статистика и баланс\n` +
      `/payout — запросить выплату\n` +
      `/history — история выплат\n` +
      `/setup — обновить реквизиты СБП`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...WELCOME_KEYBOARD });
  }
});

// Inline button: do_payout
bot.action('do_payout', async (ctx) => {
  await ctx.answerCbQuery();
  await requestPayout(ctx);
});

// Text handler: registration steps or smart response
bot.on('text', async (ctx) => {
  // If in registration flow → process step
  if (ctx.session?.step) {
    return handleRegistrationStep(ctx);
  }

  const stats = await api.stats(ctx.from.id);
  if (stats.ok) {
    await showStats(ctx);
  } else {
    await ctx.reply(WELCOME_TEXT, { parse_mode: 'Markdown', ...WELCOME_KEYBOARD });
  }
});

// HTTP health check for Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('ok')).listen(PORT, () => {
  console.log(`HTTP health check on port ${PORT}`);
});

bot.launch().then(() => {
  console.log('SytayaSemya_PartnerBot запущен ✅');
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
