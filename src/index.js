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
// Поддержка нескольких админов через запятую: "123456,930740884"
const ADMIN_IDS = (process.env.ADMIN_TG_IDS || process.env.ADMIN_TG_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Временное хранилище заявок в памяти (очищается при рестарте)
const pendingApps = new Map(); // appId → { tg_id, name, phone, bank, link, username, fullName }
let appCounter = 0;

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

const PARTNER_GROUP_LINK = process.env.PARTNER_GROUP_LINK || 'https://t.me/+UtC4SIPY9j0wYWJi';

const api = {
  stats:      (tg_id)  => apiCall('GET',  '/api/partner-stats', { tg_id }),
  profile:    (tg_id)  => apiCall('GET',  '/api/partner/profile', { tg_id }),
  register:   (body)   => apiCall('POST', '/api/partner/register', body),
  ensureCode: (body)   => apiCall('POST', '/api/partner/ensure-code', body),
  payout:     (tg_id)  => apiCall('POST', '/api/partner/payout', { tg_id }),
  payouts:    (tg_id)  => apiCall('GET',  '/api/partner/payouts', { tg_id }),
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
  [Markup.button.callback('📝 Подать заявку', 'apply_start')],
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

// ── Application flow ──────────────────────────────────────────────────────────

async function startApplication(ctx) {
  ctx.session.apply_step = 'name';
  ctx.session.apply_name = null;
  ctx.session.apply_phone = null;
  ctx.session.apply_bank = null;
  ctx.session.apply_link = null;
  await ctx.reply(
    `📝 *Заявка на партнёрство*\n\n` +
    `*Шаг 1 из 4.* Введите ваше _Имя и Фамилию_:\n` +
    `_Пример: Анна Иванова_`,
    { parse_mode: 'Markdown', ...Markup.forceReply() }
  );
}

async function handleApplicationStep(ctx) {
  const step = ctx.session?.apply_step;
  const text = ctx.message?.text?.trim();
  if (!text || !step) return false;

  if (step === 'name') {
    ctx.session.apply_name = text;
    ctx.session.apply_step = 'phone';
    await ctx.reply(
      `✅ Отлично!\n\n*Шаг 2 из 4.* Введите номер телефона для СБП-перевода:\n_Пример: 79991234567_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
    return true;
  }

  if (step === 'phone') {
    const phone = text.replace(/\D/g, '');
    if (phone.length < 10 || phone.length > 12) {
      await ctx.reply('❌ Неверный формат. Введите номер цифрами, например: 79991234567');
      return true;
    }
    ctx.session.apply_phone = phone;
    ctx.session.apply_step = 'bank';
    await ctx.reply(
      `✅ Принято!\n\n*Шаг 3 из 4.* Укажите ваш банк:\n_Примеры: Сбербанк, Т-Банк, ВТБ, Альфа-Банк_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
    return true;
  }

  if (step === 'bank') {
    ctx.session.apply_bank = text;
    ctx.session.apply_step = 'link';
    await ctx.reply(
      `✅ Принято!\n\n*Шаг 4 из 4.* Пришлите ссылку на ваши соцсети или на рилс/пост о нас:\n` +
      `_Примеры: https://instagram.com/yourblog или https://t.me/yourchannel_`,
      { parse_mode: 'Markdown', ...Markup.forceReply() }
    );
    return true;
  }

  if (step === 'link') {
    ctx.session.apply_link = text;
    ctx.session.apply_step = null;

    const { apply_name, apply_phone, apply_bank, apply_link } = ctx.session;
    const user = ctx.from;
    const username = user.username ? `@${user.username}` : `tg://user?id=${user.id}`;

    // Сохраняем заявку в памяти
    const appId = String(++appCounter);
    pendingApps.set(appId, {
      tg_id:    user.id,
      name:     apply_name,
      phone:    apply_phone,
      bank:     apply_bank,
      link:     apply_link,
      username,
      fullName: [user.first_name, user.last_name].filter(Boolean).join(' '),
    });

    // Уведомляем всех админов с кнопками одобрить/отклонить
    const adminMsg =
      `🆕 <b>Новая заявка на партнёрство!</b>\n\n` +
      `👤 <b>ФИО:</b> ${apply_name}\n` +
      `📱 <b>СБП:</b> ${apply_phone} (${apply_bank})\n` +
      `🔗 <b>Соцсети/пост:</b> ${apply_link}\n\n` +
      `<b>Telegram:</b> ${username} (ID: ${user.id})\n` +
      `<b>Имя в TG:</b> ${[user.first_name, user.last_name].filter(Boolean).join(' ')}`;

    const adminKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Одобрить', `approve_${appId}`),
        Markup.button.callback('❌ Отклонить', `reject_${appId}`),
      ],
    ]);

    for (const adminId of ADMIN_IDS) {
      await bot.telegram.sendMessage(adminId, adminMsg, { parse_mode: 'HTML', ...adminKeyboard }).catch(() => {});
    }

    await ctx.reply(
      `✅ *Заявка отправлена!*\n\n` +
      `Мы проверим ваш профиль и свяжемся с вами в течение 1-2 рабочих дней.\n\n` +
      `Если есть вопросы — напишите менеджеру @hostapaytl 👋`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.url('✍️ Написать менеджеру', 'https://t.me/hostapaytl')]]),
      }
    );

    ctx.session.apply_name = null;
    ctx.session.apply_phone = null;
    ctx.session.apply_bank = null;
    ctx.session.apply_link = null;
    return true;
  }

  return false;
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

// Inline button: apply_start
bot.action('apply_start', async (ctx) => {
  await ctx.answerCbQuery();
  await startApplication(ctx);
});

// Admin command: /fixlink <tg_id> — create blogger code for existing partner if missing
// Must be before bot.on('text') to avoid being swallowed by the text handler
bot.command('fixlink', async (ctx) => {
  const isAdmin = ADMIN_IDS.includes(String(ctx.from.id));
  if (!isAdmin) return ctx.reply('❌ Нет прав администратора. Твой ID: ' + ctx.from.id);
  const parts = ctx.message.text.split(' ');
  const tg_id = parts[1]?.trim();
  if (!tg_id) return ctx.reply('Использование: /fixlink <tg_id>');
  await ctx.reply('Создаю партнёрский код...');
  const result = await api.ensureCode({ tg_id, tg_username: null, name: `partner${tg_id}` });
  if (!result.ok) return ctx.reply(`❌ Ошибка: ${result.error || 'unknown'}`);
  const status = result.already_existed ? 'Код уже существовал' : 'Код создан';
  await ctx.reply(`✅ ${status}\n\n🔗 Ссылка: ${result.link}\n\nОтправь эту ссылку партнёру вручную.`);
  await bot.telegram.sendMessage(
    tg_id,
    `🔗 <b>Ваша реферальная ссылка:</b>\n<code>${result.link}</code>\n\n` +
    `👥 Чат партнёров: ${PARTNER_GROUP_LINK}\n\n` +
    `📊 Статистика — /stats\n💸 Выплаты — /payout`,
    { parse_mode: 'HTML' }
  ).catch(() => {});
});

// Text handler: registration steps, application steps or smart response
bot.on('text', async (ctx) => {
  // Application flow
  if (ctx.session?.apply_step) {
    return handleApplicationStep(ctx);
  }

  // SBP registration flow
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

// ── Admin approve / reject ────────────────────────────────────────────────────

bot.action(/^approve_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Обрабатываю...');
  const appId = ctx.match[1];
  const app = pendingApps.get(appId);
  if (!app) return ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n⚠️ Заявка уже обработана или устарела.', { parse_mode: 'HTML' });

  pendingApps.delete(appId);

  // Регистрируем партнёра в основной базе
  const tgUsername = app.username?.startsWith('@') ? app.username.slice(1) : null;
  const regResult = await api.register({
    tg_id:       app.tg_id,
    name:        app.name,
    sbp_phone:   app.phone,
    sbp_bank:    app.bank,
    tg_username: tgUsername,
  });

  if (!regResult.ok && regResult.error !== 'already_exists') {
    await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n❌ Ошибка регистрации: ${regResult.error || 'unknown'}`, { parse_mode: 'HTML' });
    return;
  }

  // Получаем реферальную ссылку
  const stats = await api.stats(app.tg_id);
  const refLink = stats.link;
  if (!refLink) {
    await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n❌ Ошибка получения ссылки: партнёр не найден в БД`, { parse_mode: 'HTML' });
    return;
  }

  // Уведомляем партнёра
  await bot.telegram.sendMessage(
    app.tg_id,
    `🎉 <b>Ваша заявка одобрена!</b>\n\n` +
    `Вы стали партнёром Сытой Семьи 🚀\n\n` +
    `🔗 <b>Ваша реферальная ссылка:</b>\n<code>${refLink}</code>\n\n` +
    `Делитесь ею в соцсетях — вы получаете <b>20% с каждой оплаты</b> навсегда.\n\n` +
    `👥 <b>Вступайте в закрытый чат партнёров:</b> ${PARTNER_GROUP_LINK}\n\n` +
    `📊 Статистика переходов и баланс — команда /stats\n` +
    `💸 Выплаты — команда /payout`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  await ctx.editMessageText(
    ctx.callbackQuery.message.text + `\n\n✅ <b>Одобрено!</b> Ссылка отправлена партнёру.`,
    { parse_mode: 'HTML' }
  );
});

bot.action(/^reject_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Отклонено');
  const appId = ctx.match[1];
  const app = pendingApps.get(appId);
  if (!app) return ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n⚠️ Заявка уже обработана.', { parse_mode: 'HTML' });

  pendingApps.delete(appId);

  // Уведомляем заявителя
  await bot.telegram.sendMessage(
    app.tg_id,
    `😔 К сожалению, ваша заявка на партнёрство не была одобрена.\n\n` +
    `Если есть вопросы — напишите менеджеру @hostapaytl`,
    { parse_mode: 'HTML' }
  ).catch(() => {});

  await ctx.editMessageText(
    ctx.callbackQuery.message.text + `\n\n❌ <b>Отклонено.</b> Заявитель уведомлён.`,
    { parse_mode: 'HTML' }
  );
});


// Webhook mode on Render (no 409 conflicts), polling fallback locally
const PORT       = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL; // auto-set by Render

if (RENDER_URL) {
  const webhookPath = '/tg-webhook';
  const webhookUrl  = `${RENDER_URL}${webhookPath}`;

  bot.telegram.setWebhook(webhookUrl).then(() => {
    console.log(`Webhook set: ${webhookUrl}`);
  });

  http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === webhookPath) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          await bot.handleUpdate(JSON.parse(body));
        } catch (e) {
          console.error('Webhook handle error:', e.message);
        }
        res.end('ok');
      });
    } else {
      res.end('ok');
    }
  }).listen(PORT, () => {
    console.log(`SytayaSemya_PartnerBot webhook mode on port ${PORT} ✅`);
  });
} else {
  // Local dev: polling
  http.createServer((req, res) => res.end('ok')).listen(PORT);
  bot.launch().then(() => console.log('SytayaSemya_PartnerBot polling mode ✅'));
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
