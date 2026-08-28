require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const XLSX = require('xlsx');
const cron = require('node-cron');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const ADMIN_PHONE = '+998 88 176 26 66';
const CHANNEL_USERNAME = '@Turk_akademisi'.trim();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

const AI_SYSTEM_PROMPT = {
  uz:
    "Siz 'Turk tili o'quv kursi' Telegram botining aqlli yordamchisisiz. " +
    "O'quvchilarning kurs, darslar, darajalar (A1-B2), onlayn/oflayn shakllar haqidagi savollariga " +
    "qisqa, aniq va do'stona javob bering. Agar savol kursga umuman aloqador bo'lmasa yoki " +
    "aniq javob bera olmasangiz, buni halol ayting va admin bilan bog'lanishni tavsiya eting: " +
    `${ADMIN_PHONE}. Javobni faqat o'zbek tilida, 2-4 gapda bering.`,
  ru:
    "Вы умный помощник Telegram-бота 'Курсы турецкого языка'. " +
    "Отвечайте на вопросы учеников о курсе, занятиях, уровнях (A1-B2), онлайн/офлайн формате " +
    "кратко, точно и дружелюбно. Если вопрос не относится к курсу или вы не знаете точного ответа, " +
    `честно скажите об этом и посоветуйте связаться с админом: ${ADMIN_PHONE}. ` +
    "Отвечайте только на русском языке, 2-4 предложениями.",
};

async function askAI(question, lang, attempt = 1) {
  const systemPrompt = AI_SYSTEM_PROMPT[lang] || AI_SYSTEM_PROMPT.uz;
  try {
    const result = await geminiModel.generateContent(
      `${systemPrompt}\n\nO'quvchi savoli: ${question}`
    );
    return result.response.text();
  } catch (error) {
    const isOverloaded = error.message && error.message.includes('503');
    if (isOverloaded && attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      return askAI(question, lang, attempt + 1);
    }
    throw error;
  }
}

// ==== Ma'lumotlar bazasi (JSON fayl) ====
const STUDENTS_FILE = './students.json';
let students = [];
if (fs.existsSync(STUDENTS_FILE)) {
  try { students = JSON.parse(fs.readFileSync(STUDENTS_FILE, 'utf8')); } catch (e) { students = []; }
}
function saveStudents() {
  fs.writeFileSync(STUDENTS_FILE, JSON.stringify(students, null, 2));
}

// ==== Botni ishga tushirgan BARCHA foydalanuvchilar (ro'yxatdan o'tmagan bo'lsa ham) ====
const USERS_FILE = './users.json';
let allUsers = [];
if (fs.existsSync(USERS_FILE)) {
  try { allUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { allUsers = []; }
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(allUsers, null, 2));
}
function registerUser(chatId, lang) {
  const existing = allUsers.find(u => u.chatId === chatId);
  if (existing) {
    if (lang) existing.lang = lang;
  } else {
    allUsers.push({ chatId, lang: lang || 'uz', firstSeen: new Date().toISOString() });
  }
  saveUsers();
}

// ==== Xotiradagi holatlar ====
const userLang = {};
const regState = {};

// ==== Matnlar (uz / ru) ====
const texts = {
  uz: {
    intro:
      "🇹🇷 <b>Turk tili o'quv kursi</b>\n\n" +
      "Assalomu alaykum! Bizning Turk tili kursimizga xush kelibsiz.\n" +
      "Bu bot orqali siz kursimizga onlayn yoki oflayn ro'yxatdan o'tishingiz, " +
      "darajangizni tanlashingiz va biz bilan bog'lanishingiz mumkin.\n\n" +
      "Davom etish uchun tilni tanlang 👇",
    langBtn: "🇺🇿 O'zbek tili",
    mainMenuTitle: "Asosiy menyu:",
    menuRegister: "📝 Ro'yxatdan o'tish",
    menuInfo: "ℹ️ Ma'lumot",
    menuContact: "📞 Aloqa",
    menuPricing: "💰 Narxlar",
    chooseFormat: "O'qish shaklini tanlang:",
    online: "💻 Onlayn",
    offline: "🏫 Oflayn",
    chooseLevel: "Darajangizni tanlang:",
    askName: "Ism va familiyangizni kiriting (masalan: Aliyev Vali):",
    askAge: "Yoshingizni kiriting (faqat raqam):",
    invalidAge: "❗️ Iltimos, yoshingizni faqat raqamda kiriting (masalan: 21).",
    askPhone: "Telefon raqamingizni yuboring:",
    sharePhoneBtn: "📱 Raqamni yuborish",
    regDone: (d) =>
      "✅ <b>Siz muvaffaqiyatli ro'yxatdan o'tdingiz!</b>\n\n" +
      `👤 Ism: ${d.name}\n` +
      `🎂 Yosh: ${d.age}\n` +
      `📞 Telefon: ${d.phone}\n` +
      `🏫 Shakl: ${d.format === 'online' ? 'Onlayn' : 'Oflayn'}\n` +
      `📚 Daraja: ${d.level}\n\n` +
      "Tez orada operatorlarimiz siz bilan bog'lanadi!",
    contactText: `📞 <b>Aloqa uchun</b>\n\nAdmin: ${ADMIN_PHONE}`,
    infoText:
      "ℹ️ <b>Kurs haqida ma'lumot</b>\n\n" +
      "🇹🇷 Turk tili kursimizda A1 dan B2 gacha bo'lgan darajalarda ta'lim beriladi.\n" +
      "📌 Dars shakllari: Onlayn va Oflayn\n" +
      "👨‍🏫 Tajribali o'qituvchilar\n" +
      "📚 Zamonaviy o'quv materiallari\n\n" +
      "Ro'yxatdan o'tish uchun \"📝 Ro'yxatdan o'tish\" tugmasini bosing.",
    pricingText:
      "💰 <b>Kurs narxlari</b>\n\n" +
      "💻 <b>Onlayn:</b> 250 000 so'm/oy\n" +
      "  Haftada 4 kun dars\n\n" +
      "🏫 <b>Oflayn:</b> 300 000 so'm/oy\n" +
      "  Haftada 4 kun dars\n\n" +
      `Batafsil ma'lumot uchun admin bilan bog'laning: ${ADMIN_PHONE}`,
  },
  ru: {
    intro:
      "🇹🇷 <b>Курсы турецкого языка</b>\n\n" +
      "Добро пожаловать на наши курсы турецкого языка!\n" +
      "Через этого бота вы можете зарегистрироваться на онлайн или офлайн курс, " +
      "выбрать свой уровень и связаться с нами.\n\n" +
      "Выберите язык, чтобы продолжить 👇",
    langBtn: "🇷🇺 Русский язык",
    mainMenuTitle: "Главное меню:",
    menuRegister: "📝 Регистрация",
    menuInfo: "ℹ️ Информация",
    menuContact: "📞 Контакты",
    menuPricing: "💰 Цены",
    chooseFormat: "Выберите формат обучения:",
    online: "💻 Онлайн",
    offline: "🏫 Офлайн",
    chooseLevel: "Выберите уровень:",
    askName: "Введите имя и фамилию (например: Алиев Вали):",
    askAge: "Введите ваш возраст (только цифрами):",
    invalidAge: "❗️ Пожалуйста, введите возраст цифрами (например: 21).",
    askPhone: "Отправьте номер телефона:",
    sharePhoneBtn: "📱 Отправить номер",
    regDone: (d) =>
      "✅ <b>Вы успешно зарегистрированы!</b>\n\n" +
      `👤 Имя: ${d.name}\n` +
      `🎂 Возраст: ${d.age}\n` +
      `📞 Телефон: ${d.phone}\n` +
      `🏫 Формат: ${d.format === 'online' ? 'Онлайн' : 'Офлайн'}\n` +
      `📚 Уровень: ${d.level}\n\n` +
      "Наши операторы скоро свяжутся с вами!",
    contactText: `📞 <b>Контакты</b>\n\nАдмин: ${ADMIN_PHONE}`,
    infoText:
      "ℹ️ <b>О курсе</b>\n\n" +
      "🇹🇷 На наших курсах турецкого языка обучение проходит с уровня A1 до B2.\n" +
      "📌 Форматы обучения: Онлайн и Офлайн\n" +
      "👨‍🏫 Опытные преподаватели\n" +
      "📚 Современные учебные материалы\n\n" +
      "Чтобы зарегистрироваться, нажмите \"📝 Регистрация\".",
    pricingText:
      "💰 <b>Цены на курс</b>\n\n" +
      "💻 <b>Онлайн:</b> 250 000 сум/мес\n" +
      "  4 занятия в неделю\n\n" +
      "🏫 <b>Офлайн:</b> 300 000 сум/мес\n" +
      "  4 занятия в неделю\n\n" +
      `Подробнее у администратора: ${ADMIN_PHONE}`,
  },
};

function t(chatId) {
  return texts[userLang[chatId] || 'uz'];
}

function mainMenuKeyboard(chatId) {
  const tt = t(chatId);
  return Markup.keyboard([
    [tt.menuRegister],
    [tt.menuPricing],
    [tt.menuInfo, tt.menuContact],
  ]).resize();
}

// ==== Kanalga obuna tekshiruvi ====
const subscribeTexts = {
  uz: {
    notSubscribed:
      "🇹🇷 <b>Turk tili o'quv kursi</b>\n\n" +
      "Botdan foydalanish uchun avval bizning kanalimizga a'zo bo'ling, " +
      "so'ng \"✅ Tekshirish\" tugmasini bosing.",
    subscribeBtn: "📢 Kanalga o'tish",
    checkBtn: "✅ Tekshirish",
    stillNot: "❗️ Siz hali kanalga a'zo bo'lmagansiz. Iltimos, avval a'zo bo'ling.",
  },
  ru: {
    notSubscribed:
      "🇹🇷 <b>Курсы турецкого языка</b>\n\n" +
      "Чтобы пользоваться ботом, сначала подпишитесь на наш канал, " +
      "затем нажмите \"✅ Проверить\".",
    subscribeBtn: "📢 Перейти в канал",
    checkBtn: "✅ Проверить",
    stillNot: "❗️ Вы ещё не подписаны на канал. Пожалуйста, подпишитесь сначала.",
  },
};

async function isSubscribed(ctx, chatId) {
  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_USERNAME, chatId);
    return !['left', 'kicked'].includes(member.status);
  } catch (e) {
    console.error('Obuna tekshirish xatosi:', e.message);
    return false;
  }
}

function subscribePrompt(chatId) {
  const lang = userLang[chatId] || 'uz';
  const st = subscribeTexts[lang];
  return {
    text: st.notSubscribed,
    keyboard: Markup.inlineKeyboard([
      [Markup.button.url(st.subscribeBtn, `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`)],
      [Markup.button.callback(st.checkBtn, 'check_sub')],
    ]),
  };
}

// ==== /start ====
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  delete regState[chatId];
  registerUser(chatId, userLang[chatId]); // botni ishga tushirgan hamma shu yerda qayd etiladi

  const subscribed = await isSubscribed(ctx, chatId);
  if (!subscribed) {
    const prompt = subscribePrompt(chatId);
    ctx.replyWithHTML(prompt.text, prompt.keyboard);
    return;
  }

  ctx.replyWithHTML(
    texts.uz.intro,
    Markup.inlineKeyboard([
      [Markup.button.callback(texts.uz.langBtn, 'lang:uz')],
      [Markup.button.callback(texts.ru.langBtn, 'lang:ru')],
    ])
  );
});

// ==== "Tekshirish" tugmasi ====
bot.action('check_sub', async (ctx) => {
  const chatId = ctx.chat.id;
  const subscribed = await isSubscribed(ctx, chatId);

  if (subscribed) {
    ctx.answerCbQuery();
    ctx.replyWithHTML(
      texts.uz.intro,
      Markup.inlineKeyboard([
        [Markup.button.callback(texts.uz.langBtn, 'lang:uz')],
        [Markup.button.callback(texts.ru.langBtn, 'lang:ru')],
      ])
    );
  } else {
    const lang = userLang[chatId] || 'uz';
    ctx.answerCbQuery(subscribeTexts[lang].stillNot, { show_alert: true });
  }
});

// ==== Til tanlash ====
bot.action(/lang:(uz|ru)/, (ctx) => {
  const chatId = ctx.chat.id;
  userLang[chatId] = ctx.match[1];
  registerUser(chatId, ctx.match[1]);
  ctx.answerCbQuery();
  ctx.reply(t(chatId).mainMenuTitle, mainMenuKeyboard(chatId));
});

// ==== Majburiy obuna middleware ====
// /start va "check_sub" o'zi ichida tekshiradi, shuning uchun bu yerda o'tkazib yuboriladi.
// Admin foydalanuvchilar tekshiruvdan ozod qilinadi.
bot.use(async (ctx, next) => {
  const chatId = ctx.chat && ctx.chat.id;
  if (!chatId) return next();
  if (isAdmin(chatId)) return next();

  const isStartCmd = ctx.message && ctx.message.text === '/start';
  const isCheckSubAction = ctx.callbackQuery && ctx.callbackQuery.data === 'check_sub';
  if (isStartCmd || isCheckSubAction) return next();

  const subscribed = await isSubscribed(ctx, chatId);
  if (!subscribed) {
    if (ctx.callbackQuery) ctx.answerCbQuery();
    const prompt = subscribePrompt(chatId);
    ctx.replyWithHTML(prompt.text, prompt.keyboard);
    return;
  }
  return next();
});

// ==== Asosiy menyu tugmalari ====
bot.hears([texts.uz.menuRegister, texts.ru.menuRegister], (ctx) => {
  const chatId = ctx.chat.id;
  regState[chatId] = { step: 'format', data: {} };
  const tt = t(chatId);
  ctx.reply(
    tt.chooseFormat,
    Markup.inlineKeyboard([
      [Markup.button.callback(tt.online, 'format:online')],
      [Markup.button.callback(tt.offline, 'format:offline')],
    ])
  );
});

bot.hears([texts.uz.menuInfo, texts.ru.menuInfo], (ctx) => {
  ctx.replyWithHTML(t(ctx.chat.id).infoText);
});

bot.hears([texts.uz.menuContact, texts.ru.menuContact], (ctx) => {
  ctx.replyWithHTML(t(ctx.chat.id).contactText);
});

bot.hears([texts.uz.menuPricing, texts.ru.menuPricing], (ctx) => {
  ctx.replyWithHTML(t(ctx.chat.id).pricingText);
});

// ==== Format (onlayn/oflayn) tanlash ====
bot.action(/format:(online|offline)/, (ctx) => {
  const chatId = ctx.chat.id;
  if (!regState[chatId]) regState[chatId] = { step: 'level', data: {} };
  regState[chatId].data.format = ctx.match[1];
  regState[chatId].step = 'level';
  ctx.answerCbQuery();

  const tt = t(chatId);
  ctx.reply(
    tt.chooseLevel,
    Markup.inlineKeyboard([
      [Markup.button.callback('A1', 'level:A1'), Markup.button.callback('A2', 'level:A2')],
      [Markup.button.callback('B1', 'level:B1'), Markup.button.callback('B2', 'level:B2')],
    ])
  );
});

// ==== Daraja tanlash ====
bot.action(/level:(A1|A2|B1|B2)/, (ctx) => {
  const chatId = ctx.chat.id;
  if (!regState[chatId]) regState[chatId] = { step: 'name', data: {} };
  regState[chatId].data.level = ctx.match[1];
  regState[chatId].step = 'name';
  ctx.answerCbQuery();

  ctx.reply(t(chatId).askName, Markup.removeKeyboard());
});

// ==================== ADMIN PANEL ====================
// MUHIM: bu qism bot.on('text') dan OLDIN turishi shart,
// aks holda /admin buyrug'i umumiy matn handleri tomonidan "yutib yuboriladi"

function isAdmin(chatId) {
  return ADMIN_IDS.includes(String(chatId));
}

// ==== Diagnostika buyrug'i (faqat admin) — kanal tekshiruvi nima xato berayotganini ko'rsatadi ====
// ==== Takrorlangan yozuvlarni tozalash (faqat admin) ====
bot.command('dedupe', (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return;

  const seenPhones = new Set();
  const seenNames = new Set();
  const cleaned = [];
  let removed = 0;

  for (const s of students) {
    const normPhone = normalizePhone(s.phone);
    const normName = normalizeName(s.name);
    if (seenPhones.has(normPhone) || seenNames.has(normName)) {
      removed++;
      continue;
    }
    seenPhones.add(normPhone);
    seenNames.add(normName);
    cleaned.push(s);
  }

  students.length = 0;
  students.push(...cleaned);
  saveStudents();

  ctx.reply(`✅ Tozalandi. ${removed} ta takroriy yozuv o'chirildi.\nQoldi: ${students.length} ta.`);
});

bot.command('checksub', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return;

  ctx.reply(`Tekshirilayotgan kanal: ${CHANNEL_USERNAME}\nSizning chat ID: ${chatId}`);

  try {
    const chat = await ctx.telegram.getChat(CHANNEL_USERNAME);
    ctx.reply(`✅ Kanal topildi:\nID: ${chat.id}\nNomi: ${chat.title}\nUsername: @${chat.username || 'yo\'q'}`);
  } catch (e) {
    ctx.reply(`❌ Kanal topilmadi.\nXato: ${e.message}`);
    return;
  }

  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_USERNAME, chatId);
    ctx.reply(`✅ A'zolik holati: ${member.status}\n\n(agar "left" yoki "kicked" bo'lsa — a'zo emassiz deb hisoblanadi)`);
  } catch (e) {
    ctx.reply(
      `❌ A'zolikni tekshirishda XATO:\n${e.message}\n\n` +
      `Bu odatda bot kanalga ADMIN qilib qo'shilmagani uchun bo'ladi. ` +
      `Kanal → Administrators → bot username'ini qidirib toping va qo'shing.`
    );
  }
});

bot.command('admin', (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) {
    ctx.reply("⛔️ Sizda admin huquqi yo'q.");
    return;
  }
  ctx.reply(
    "👨‍💻 Admin panel",
    Markup.inlineKeyboard([
      [Markup.button.callback("👥 O'quvchilar", 'admin:students')],
      [Markup.button.callback("📊 Statistika", 'admin:stats')],
      [Markup.button.callback("📥 Excel yuklab olish", 'admin:export')],
      [Markup.button.callback("📢 Xabar yuborish", 'admin:broadcast')],
    ])
  );
});

bot.action('admin:students', (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return ctx.answerCbQuery();
  ctx.answerCbQuery();

  if (students.length === 0) {
    ctx.reply("Hozircha ro'yxatdan o'tgan o'quvchilar yo'q.");
    return;
  }

  const levels = ['A1', 'A2', 'B1', 'B2'];
  let msg = "👥 <b>O'quvchilar (daraja bo'yicha)</b>\n\n";
  levels.forEach(lvl => {
    const list = students.filter(s => s.level === lvl);
    msg += `<b>${lvl}</b> — ${list.length} ta\n`;
    list.forEach((s, i) => {
      msg += `  ${i + 1}. ${s.name}, ${s.age} yosh, ${s.phone} (${s.format === 'online' ? 'Onlayn' : 'Oflayn'})\n`;
    });
    msg += '\n';
  });

  ctx.replyWithHTML(msg);
});

bot.action('admin:stats', (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return ctx.answerCbQuery();
  ctx.answerCbQuery();

  const total = students.length;
  const online = students.filter(s => s.format === 'online').length;
  const offline = students.filter(s => s.format === 'offline').length;
  const uz = students.filter(s => s.lang === 'uz').length;
  const ru = students.filter(s => s.lang === 'ru').length;

  const levelCounts = ['A1', 'A2', 'B1', 'B2']
    .map(lvl => `${lvl}: ${students.filter(s => s.level === lvl).length} ta`)
    .join('\n');

  const msg =
    `📊 <b>Statistika</b>\n\n` +
    `👥 Jami: ${total} ta\n\n` +
    `💻 Onlayn: ${online} ta\n` +
    `🏫 Oflayn: ${offline} ta\n\n` +
    `🇺🇿 O'zbek tilida: ${uz} ta\n` +
    `🇷🇺 Rus tilida: ${ru} ta\n\n` +
    `📚 Darajalar bo'yicha:\n${levelCounts}`;

  ctx.replyWithHTML(msg);
});

// ==== Excel eksport ====
bot.action('admin:export', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return ctx.answerCbQuery();
  ctx.answerCbQuery();

  if (students.length === 0) {
    ctx.reply("Hozircha ro'yxatdan o'tgan o'quvchilar yo'q.");
    return;
  }

  const rows = students.map((s, i) => ({
    '№': i + 1,
    'Ism familiya': s.name,
    'Yosh': s.age,
    'Telefon': s.phone,
    'Format': s.format === 'online' ? 'Onlayn' : 'Oflayn',
    'Daraja': s.level,
    'Til': s.lang === 'ru' ? 'Rus' : "O'zbek",
    'Ro\'yxatdan o\'tgan sana': new Date(s.date).toLocaleString('uz-UZ'),
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "O'quvchilar");
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  ctx.replyWithDocument({ source: buffer, filename: 'oquvchilar.xlsx' });
});

// ==== Xabar yuborish (Broadcast) ====
const adminState = {}; // chatId -> { mode: 'broadcast' }

bot.action('admin:broadcast', (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return ctx.answerCbQuery();
  ctx.answerCbQuery();
  adminState[chatId] = { mode: 'broadcast' };
  ctx.reply(
    "📢 Botdan foydalangan barcha foydalanuvchilarga yuboriladigan xabar matnini yozing.\n\n" +
    "Bekor qilish uchun /cancel yozing."
  );
});

bot.command('cancel', (ctx) => {
  const chatId = ctx.chat.id;
  if (adminState[chatId]) {
    delete adminState[chatId];
    ctx.reply("❌ Bekor qilindi.");
  }
});
// Bu handler ENG OXIRIDA turishi kerak, chunki u barcha matnlarni ushlaydi
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const state = regState[chatId];
  const text = ctx.message.text;
  const tt = t(chatId);

  if (text.startsWith('/')) return; // buyruqlarni bu yerda ishlatmaymiz

  // ==== Admin broadcast rejimida bo'lsa ====
  if (isAdmin(chatId) && adminState[chatId] && adminState[chatId].mode === 'broadcast') {
    delete adminState[chatId];

    const uniqueChatIds = [...new Set(allUsers.map(u => u.chatId))];
    let sent = 0;
    let failed = 0;

    ctx.reply(`⏳ ${uniqueChatIds.length} ta o'quvchiga yuborilmoqda...`);

    for (const targetId of uniqueChatIds) {
      try {
        await ctx.telegram.sendMessage(targetId, text);
        sent++;
      } catch (e) {
        failed++;
      }
      await new Promise(resolve => setTimeout(resolve, 50)); // Telegram limitiga zid bo'lmaslik uchun
    }

    ctx.reply(`✅ Yuborildi: ${sent} ta\n❌ Yetib bormadi: ${failed} ta`);
    return;
  }

  // Agar ro'yxatdan o'tish jarayonida bo'lmasa — bu erkin savol, AI javob beradi
  if (!state) {
    if (!userLang[chatId]) return; // til hali tanlanmagan bo'lsa, e'tiborsiz qoldiramiz
    try {
      await ctx.sendChatAction('typing');
      const answer = await askAI(text, userLang[chatId]);
      ctx.reply(answer);
    } catch (e) {
      console.error('AI xatosi:', e.message);
      ctx.reply(
        userLang[chatId] === 'ru'
          ? 'Извините, произошла ошибка. Попробуйте позже или свяжитесь с админом.'
          : "Kechirasiz, xatolik yuz berdi. Keyinroq urinib ko'ring yoki admin bilan bog'laning."
      );
    }
    return;
  }

  if (state.step === 'name') {
    state.data.name = text.trim();
    state.step = 'age';
    ctx.reply(tt.askAge);
    return;
  }

  if (state.step === 'age') {
    const age = parseInt(text.trim(), 10);
    if (isNaN(age) || age <= 0 || age > 100) {
      ctx.reply(tt.invalidAge);
      return;
    }
    state.data.age = age;
    state.step = 'phone';
    ctx.reply(
      tt.askPhone,
      Markup.keyboard([[Markup.button.contactRequest(tt.sharePhoneBtn)]]).resize().oneTime()
    );
    return;
  }

  if (state.step === 'phone') {
    state.data.phone = text.trim();
    finishRegistration(ctx, chatId, state);
    return;
  }
});

// ==== Telefon "Raqamni yuborish" tugmasi orqali kelsa ====
bot.on('contact', (ctx) => {
  const chatId = ctx.chat.id;
  const state = regState[chatId];
  if (!state || state.step !== 'phone') return;

  state.data.phone = ctx.message.contact.phone_number;
  finishRegistration(ctx, chatId, state);
});

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, ''); // faqat raqamlarni qoldiradi
}

function normalizeName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findExistingStudent(name, phone) {
  const normPhone = normalizePhone(phone);
  const normName = normalizeName(name);
  return students.find(
    s => normalizePhone(s.phone) === normPhone || normalizeName(s.name) === normName
  );
}

const alreadyRegisteredText = {
  uz: (s) =>
    "⚠️ <b>Siz avval ro'yxatdan o'tgansiz!</b>\n\n" +
    `👤 Ism: ${s.name}\n` +
    `📞 Telefon: ${s.phone}\n` +
    `📚 Daraja: ${s.level}\n` +
    `🏫 Shakl: ${s.format === 'online' ? 'Onlayn' : 'Oflayn'}\n\n` +
    "Agar ma'lumotlaringizni o'zgartirish kerak bo'lsa, admin bilan bog'laning.",
  ru: (s) =>
    "⚠️ <b>Вы уже зарегистрированы!</b>\n\n" +
    `👤 Имя: ${s.name}\n` +
    `📞 Телефон: ${s.phone}\n` +
    `📚 Уровень: ${s.level}\n` +
    `🏫 Формат: ${s.format === 'online' ? 'Онлайн' : 'Офлайн'}\n\n` +
    "Если нужно изменить данные, свяжитесь с администратором.",
};

function finishRegistration(ctx, chatId, state) {
  const tt = t(chatId);
  const lang = userLang[chatId] || 'uz';

  const existing = findExistingStudent(state.data.name, state.data.phone);
  if (existing) {
    delete regState[chatId];
    const msg = alreadyRegisteredText[lang](existing);
    ctx.replyWithHTML(msg, mainMenuKeyboard(chatId));
    return;
  }

  const student = {
    chatId,
    lang,
    format: state.data.format,
    level: state.data.level,
    name: state.data.name,
    age: state.data.age,
    phone: state.data.phone,
    date: new Date().toISOString(),
  };
  students.push(student);
  saveStudents();
  delete regState[chatId];

  ctx.replyWithHTML(tt.regDone(student), mainMenuKeyboard(chatId));
}

// ==== Kunlik so'z eslatmasi ====
const dailyWords = [
  { tr: "merhaba", uz: "salom", ru: "привет" },
  { tr: "teşekkür ederim", uz: "rahmat", ru: "спасибо" },
  { tr: "günaydın", uz: "xayrli tong", ru: "доброе утро" },
  { tr: "iyi akşamlar", uz: "xayrli kech", ru: "добрый вечер" },
  { tr: "nasılsın", uz: "qandaysiz", ru: "как дела" },
  { tr: "evet", uz: "ha", ru: "да" },
  { tr: "hayır", uz: "yo'q", ru: "нет" },
  { tr: "su", uz: "suv", ru: "вода" },
  { tr: "ekmek", uz: "non", ru: "хлеб" },
  { tr: "kitap", uz: "kitob", ru: "книга" },
  { tr: "araba", uz: "mashina", ru: "машина" },
  { tr: "ev", uz: "uy", ru: "дом" },
  { tr: "okul", uz: "maktab", ru: "школа" },
  { tr: "dost", uz: "do'st", ru: "друг" },
  { tr: "aile", uz: "oila", ru: "семья" },
  { tr: "güzel", uz: "chiroyli", ru: "красивый" },
  { tr: "büyük", uz: "katta", ru: "большой" },
  { tr: "küçük", uz: "kichik", ru: "маленький" },
  { tr: "para", uz: "pul", ru: "деньги" },
  { tr: "zaman", uz: "vaqt", ru: "время" },
];

async function sendDailyWords() {
  // 20 tadan so'zlar ro'yxatidan tasodifiy 10 tasini olamiz
  const shuffled = [...dailyWords].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, 10);

  for (const u of allUsers) {
    const lang = u.lang || 'uz';
    const title = lang === 'ru' ? '📩 <b>10 слов дня</b>\n' : "📩 <b>Kunning 10 ta so'zi</b>\n";
    const lines = selected
      .map((w, i) => `${i + 1}. ${w.tr} — ${lang === 'ru' ? w.ru : w.uz}`)
      .join('\n');
    const msg = `${title}\n${lines}`;

    try {
      await bot.telegram.sendMessage(u.chatId, msg, { parse_mode: 'HTML' });
    } catch (e) {
      // Foydalanuvchi botni bloklagan bo'lishi mumkin — o'tkazib yuboramiz
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Har kuni 09:00, 13:00 va 21:00 da (Toshkent vaqti bilan)
['0 9 * * *', '0 13 * * *', '0 21 * * *'].forEach(cronTime => {
  cron.schedule(cronTime, () => {
    sendDailyWords();
  }, { timezone: 'Asia/Tashkent' });
});

bot.launch();
console.log("Bot ishga tushdi...");