require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const XLSX = require('xlsx');
const cron = require('node-cron');
const sharp = require('sharp');
const quizData = require('./quizData');

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
const ADMIN_PHONE = '+998 88 176 26 66';
const BOT_USERNAME = 'Edu_Register_bot'; // @ belgisisiz, aynan bot username

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

// ==== Bot FAQAT shaxsiy chatlarda ishlaydi ====
// Guruh, kanal yoki boshqa turdagi chatlarga (masalan @Turk_akademisi kanaliga)
// bot hech qachon javob yozmasligi, xabar joylamasligi kerak.
bot.use((ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') {
    return; // e'tiborsiz qoldiramiz, hech narsa qilmaymiz
  }
  return next();
});

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

// ==== Grammatika test natijalari ====
const TEST_RESULTS_FILE = './test-results.json';
let testResults = [];
if (fs.existsSync(TEST_RESULTS_FILE)) {
  try { testResults = JSON.parse(fs.readFileSync(TEST_RESULTS_FILE, 'utf8')); } catch (e) { testResults = []; }
}
function saveTestResults() {
  fs.writeFileSync(TEST_RESULTS_FILE, JSON.stringify(testResults, null, 2));
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
function registerUser(chatId, lang, referredBy) {
  const existing = allUsers.find(u => u.chatId === chatId);
  if (existing) {
    if (lang) existing.lang = lang;
    // referredBy faqat birinchi marta o'rnatiladi, keyin o'zgartirilmaydi
    if (referredBy && !existing.referredBy && referredBy !== chatId) {
      existing.referredBy = referredBy;
    }
  } else {
    allUsers.push({
      chatId,
      lang: lang || 'uz',
      referredBy: referredBy && referredBy !== chatId ? referredBy : null,
      firstSeen: new Date().toISOString(),
    });
  }
  saveUsers();
}

function getReferralCount(chatId) {
  // Chegirma faqat TO'LIQ ro'yxatdan o'tgan do'stlar uchun hisoblanadi
  return students.filter(s => s.referredBy === chatId).length;
}

const DISCOUNT_TIERS = [
  { count: 60, percent: 15 },
  { count: 40, percent: 10 },
  { count: 20, percent: 5 },
];

function getDiscountPercent(count) {
  const tier = DISCOUNT_TIERS.find(t => count >= t.count);
  return tier ? tier.percent : 0;
}

function getNextTier(count) {
  const remaining = [...DISCOUNT_TIERS].reverse().find(t => count < t.count);
  return remaining || null; // null bo'lsa — eng yuqori darajaga yetgan
}

function getReferralLink(chatId) {
  return `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
}

// ==== Xotiradagi holatlar ====
const userLang = {};
const regState = {};
const testState = {}; // chatId -> { level, step, data:{name,phone}, current, correct, answers:[] }

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
    menuReferral: "🎁 Do'stlarni taklif qilish",
    menuTest: "📝 Test ishlash",
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
    referralTitle: "🎁 <b>Do'stlarni taklif qilish</b>",
    referralDesc: (link, count) => {
      const discount = getDiscountPercent(count);
      const next = getNextTier(count);
      const discountLine = discount > 0
        ? `🏷 Sizning hozirgi chegirmangiz: <b>${discount}%</b>\n`
        : '';
      const nextLine = next
        ? `📈 Yana ${next.count - count} ta do'st taklif qilsangiz — <b>${next.percent}%</b> chegirma olasiz\n`
        : '🏆 Siz eng yuqori chegirma darajasidasiz!\n';
      return (
        `🎁 <b>Do'stlarni taklif qilish</b>\n\n` +
        `Do'stlaringizni quyidagi shaxsiy havolangiz orqali taklif qiling. ` +
        `Ular ro'yxatdan o'tishi bilan sizga xabar boradi!\n\n` +
        `🔗 <code>${link}</code>\n\n` +
        `👥 Siz orqali ro'yxatdan o'tganlar: <b>${count} ta</b>\n` +
        discountLine +
        nextLine +
        `\n🏷 Chegirma darajalari:\n` +
        `  20 ta do'st — 5%\n` +
        `  40 ta do'st — 10%\n` +
        `  60 ta do'st — 15%\n\n` +
        `Chegirmani olish uchun admin bilan bog'laning: ${ADMIN_PHONE}`
      );
    },
    referralNotify: (name) =>
      `🎉 Sizning havolangiz orqali <b>${name}</b> ro'yxatdan o'tdi! Rahmat.`,
    referralTierUp: (percent) =>
      `🏆 Tabriklaymiz! Siz endi <b>${percent}%</b> chegirma darajasiga yetdingiz!`,

    testIntro:
      "📝 <b>Grammatika testi haqida</b>\n\n" +
      "Bu bo'limda siz tanlagan darajangiz (A1, A2, B1 yoki B2) bo'yicha 40 ta grammatika " +
      "savolidan iborat testdan o'tasiz.\n\n" +
      "📌 Qoidalar:\n" +
      "• Har bir savolga 4 tadan javob varianti beriladi, to'g'ri javobni tanlang\n" +
      "• Test davomida orqaga qaytib bo'lmaydi\n" +
      "• Test tugagach, natijangiz avtomatik hisoblanadi\n" +
      "• Agar natijangiz <b>85% yoki undan yuqori</b> bo'lsa — rasmiy sertifikat olasiz!\n" +
      "• Bir marta sertifikat olgan darajangizni qaytadan topshira olmaysiz. " +
      "Agar 85%ga yetmasangiz, sertifikat olguningizcha xohlagancha qayta urinib ko'rishingiz mumkin.\n\n" +
      "Tayyor bo'lsangiz, pastdagi tugmani bosing.",
    understoodBtn: "✅ Tushundim",
    testChooseLevel: "Qaysi daraja bo'yicha test topshirmoqchisiz?",
    testAlreadyPassed: (level) =>
      `🎓 Siz <b>${level}</b> darajasi bo'yicha testni allaqachon ishlab, sertifikatni qo'lga kiritgansiz.\n\n` +
      "Ushbu darajani qayta topshirish shart emas. Boshqa daraja tanlashingiz mumkin.",
    testAskName: "Ism va familiyangizni kiriting:",
    testAskPhone: "Telefon raqamingizni yuboring:",
    testQuestionHeader: (current, total) => `📝 Savol ${current}/${total}`,
    testResultPass: (name, level, correct, total, percent) =>
      `🎉 <b>Tabriklaymiz, ${name}!</b>\n\n` +
      `Siz <b>${level}</b> darajasi bo'yicha testdan muvaffaqiyatli o'tdingiz!\n\n` +
      `✅ To'g'ri javoblar: ${correct}/${total}\n` +
      `📊 Natija: ${percent}%`,
    testResultFail: (name, level, correct, total, percent) =>
      `📊 <b>Test natijasi</b>\n\n` +
      `${name}, siz <b>${level}</b> darajasi bo'yicha testni yakunladingiz.\n\n` +
      `✅ To'g'ri javoblar: ${correct}/${total}\n` +
      `📊 Natija: ${percent}%\n\n` +
      "Afsuski, sertifikat olish uchun kamida 85% natija kerak. " +
      "Qayta tayyorlanib, xohlagancha qayta urinib ko'rishingiz mumkin. Omad!",
    downloadCertPrompt: "Sertifikatingiz tayyor — pastdagi tugma orqali yuklab oling:",
    downloadCertBtn: "🎓 Sertifikatni yuklab olish",
    certError: "Sertifikatni tayyorlashda xatolik yuz berdi. Iltimos, /admin orqali murojaat qiling yoki keyinroq urinib ko'ring.",
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
    menuReferral: "🎁 Пригласить друзей",
    menuTest: "📝 Пройти тест",
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
    referralTitle: "🎁 <b>Пригласить друзей</b>",
    referralDesc: (link, count) => {
      const discount = getDiscountPercent(count);
      const next = getNextTier(count);
      const discountLine = discount > 0
        ? `🏷 Ваша текущая скидка: <b>${discount}%</b>\n`
        : '';
      const nextLine = next
        ? `📈 Ещё ${next.count - count} друзей — и вы получите <b>${next.percent}%</b> скидку\n`
        : '🏆 Вы достигли максимального уровня скидки!\n';
      return (
        `🎁 <b>Пригласить друзей</b>\n\n` +
        `Приглашайте друзей по вашей персональной ссылке. ` +
        `Как только они зарегистрируются — вам придёт уведомление!\n\n` +
        `🔗 <code>${link}</code>\n\n` +
        `👥 Зарегистрировано по вашей ссылке: <b>${count}</b>\n` +
        discountLine +
        nextLine +
        `\n🏷 Уровни скидок:\n` +
        `  20 друзей — 5%\n` +
        `  40 друзей — 10%\n` +
        `  60 друзей — 15%\n\n` +
        `Для получения скидки свяжитесь с администратором: ${ADMIN_PHONE}`
      );
    },
    referralNotify: (name) =>
      `🎉 По вашей ссылке зарегистрировался(-ась) <b>${name}</b>! Спасибо.`,
    referralTierUp: (percent) =>
      `🏆 Поздравляем! Вы достигли уровня скидки <b>${percent}%</b>!`,

    testIntro:
      "📝 <b>О грамматическом тесте</b>\n\n" +
      "В этом разделе вы пройдёте тест из 40 грамматических вопросов по выбранному " +
      "уровню (A1, A2, B1 или B2).\n\n" +
      "📌 Правила:\n" +
      "• На каждый вопрос даётся 4 варианта ответа, выберите правильный\n" +
      "• Вернуться назад во время теста нельзя\n" +
      "• После завершения результат подсчитывается автоматически\n" +
      "• Если результат <b>85% и выше</b> — вы получите официальный сертификат!\n" +
      "• Уровень, за который вы уже получили сертификат, повторно пройти нельзя. " +
      "Если результат ниже 85%, можно пробовать снова сколько угодно раз.\n\n" +
      "Если готовы, нажмите кнопку ниже.",
    understoodBtn: "✅ Понятно",
    testChooseLevel: "По какому уровню хотите пройти тест?",
    testAlreadyPassed: (level) =>
      `🎓 Вы уже прошли тест по уровню <b>${level}</b> и получили сертификат.\n\n` +
      "Повторное прохождение этого уровня не требуется. Вы можете выбрать другой уровень.",
    testAskName: "Введите имя и фамилию:",
    testAskPhone: "Отправьте номер телефона:",
    testQuestionHeader: (current, total) => `📝 Вопрос ${current}/${total}`,
    testResultPass: (name, level, correct, total, percent) =>
      `🎉 <b>Поздравляем, ${name}!</b>\n\n` +
      `Вы успешно прошли тест по уровню <b>${level}</b>!\n\n` +
      `✅ Правильных ответов: ${correct}/${total}\n` +
      `📊 Результат: ${percent}%`,
    testResultFail: (name, level, correct, total, percent) =>
      `📊 <b>Результат теста</b>\n\n` +
      `${name}, вы завершили тест по уровню <b>${level}</b>.\n\n` +
      `✅ Правильных ответов: ${correct}/${total}\n` +
      `📊 Результат: ${percent}%\n\n` +
      "К сожалению, для сертификата нужно минимум 85%. " +
      "Подготовьтесь и попробуйте снова — количество попыток не ограничено. Удачи!",
    downloadCertPrompt: "Ваш сертификат готов — скачайте его кнопкой ниже:",
    downloadCertBtn: "🎓 Скачать сертификат",
    certError: "Произошла ошибка при подготовке сертификата. Свяжитесь через /admin или попробуйте позже.",
  },
};

function t(chatId) {
  return texts[userLang[chatId] || 'uz'];
}

function mainMenuKeyboard(chatId) {
  const tt = t(chatId);
  return Markup.keyboard([
    [tt.menuRegister],
    [tt.menuPricing, tt.menuReferral],
    [tt.menuTest],
    [tt.menuInfo, tt.menuContact],
  ]).resize();
}

// ==== /start ====
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  delete regState[chatId];

  // Referal havolasi orqali kirgan bo'lsa: /start?ref_123456789
  let referredBy = null;
  const payload = ctx.startPayload; // "ref_123456789"
  if (payload && payload.startsWith('ref_')) {
    const refId = parseInt(payload.replace('ref_', ''), 10);
    if (!isNaN(refId)) referredBy = refId;
  }

  registerUser(chatId, userLang[chatId], referredBy); // botni ishga tushirgan hamma shu yerda qayd etiladi

  ctx.replyWithHTML(
    texts.uz.intro,
    Markup.inlineKeyboard([
      [Markup.button.callback(texts.uz.langBtn, 'lang:uz')],
      [Markup.button.callback(texts.ru.langBtn, 'lang:ru')],
    ])
  );
});

// ==== Til tanlash ====
bot.action(/lang:(uz|ru)/, (ctx) => {
  const chatId = ctx.chat.id;
  userLang[chatId] = ctx.match[1];
  registerUser(chatId, ctx.match[1]);
  ctx.answerCbQuery();
  ctx.reply(t(chatId).mainMenuTitle, mainMenuKeyboard(chatId));
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

bot.hears([texts.uz.menuReferral, texts.ru.menuReferral], (ctx) => {
  const chatId = ctx.chat.id;
  const link = getReferralLink(chatId);
  const count = getReferralCount(chatId);
  ctx.replyWithHTML(t(chatId).referralDesc(link, count));
});

// ==== TEST ISHLASH bo'limi ====
bot.hears([texts.uz.menuTest, texts.ru.menuTest], (ctx) => {
  const chatId = ctx.chat.id;
  delete regState[chatId];
  delete testState[chatId];
  ctx.replyWithHTML(
    t(chatId).testIntro,
    Markup.inlineKeyboard([[Markup.button.callback(t(chatId).understoodBtn, 'test_intro_ok')]])
  );
});

bot.action('test_intro_ok', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.answerCbQuery();
  ctx.reply(
    t(chatId).testChooseLevel,
    Markup.inlineKeyboard([
      [Markup.button.callback('A1', 'testlevel:A1'), Markup.button.callback('A2', 'testlevel:A2')],
      [Markup.button.callback('B1', 'testlevel:B1'), Markup.button.callback('B2', 'testlevel:B2')],
    ])
  );
});

bot.action(/testlevel:(A1|A2|B1|B2)/, (ctx) => {
  const chatId = ctx.chat.id;
  const level = ctx.match[1];
  const tt = t(chatId);

  const alreadyPassed = testResults.some(r => r.chatId === chatId && r.level === level && r.passed);
  if (alreadyPassed) {
    ctx.answerCbQuery();
    ctx.reply(tt.testAlreadyPassed(level));
    return;
  }

  testState[chatId] = { level, step: 'name', data: {}, current: 0, correct: 0 };
  ctx.answerCbQuery();
  ctx.reply(t(chatId).testAskName, Markup.removeKeyboard());
});

function sendTestQuestion(ctx, chatId) {
  const state = testState[chatId];
  const questions = quizData[state.level];
  const q = questions[state.current];
  const header = t(chatId).testQuestionHeader(state.current + 1, questions.length);

  const buttons = q.options.map((opt, idx) =>
    [Markup.button.callback(opt, `testans:${idx}`)]
  );

  ctx.reply(`${header}\n\n${q.q}`, Markup.inlineKeyboard(buttons));
}

bot.action(/testans:(\d)/, async (ctx) => {
  const chatId = ctx.chat.id;
  const state = testState[chatId];
  if (!state || state.step !== 'quiz') return ctx.answerCbQuery();

  const selected = parseInt(ctx.match[1], 10);
  const questions = quizData[state.level];
  const q = questions[state.current];

  if (selected === q.correct) state.correct++;
  ctx.answerCbQuery(selected === q.correct ? '✅' : '❌');

  state.current++;

  if (state.current < questions.length) {
    sendTestQuestion(ctx, chatId);
  } else {
    await finishTest(ctx, chatId);
  }
});

async function finishTest(ctx, chatId) {
  const state = testState[chatId];
  const tt = t(chatId);
  const total = quizData[state.level].length;
  const percent = Math.round((state.correct / total) * 100);
  const passed = percent >= 85;

  const result = {
    chatId,
    lang: userLang[chatId] || 'uz',
    name: state.data.name,
    phone: state.data.phone,
    level: state.level,
    correct: state.correct,
    total,
    percent,
    passed,
    date: new Date().toISOString(),
  };
  testResults.push(result);
  saveTestResults();
  const certId = testResults.length - 1;
  delete testState[chatId];

  if (passed) {
    ctx.replyWithHTML(
      tt.testResultPass(result.name, result.level, result.correct, total, percent),
      mainMenuKeyboard(chatId)
    );
    ctx.reply(
      tt.downloadCertPrompt,
      Markup.inlineKeyboard([[Markup.button.callback(tt.downloadCertBtn, `downloadcert:${certId}`)]])
    );
  } else {
    ctx.replyWithHTML(
      tt.testResultFail(result.name, result.level, result.correct, total, percent),
      mainMenuKeyboard(chatId)
    );
  }
}

bot.action(/downloadcert:(\d+)/, async (ctx) => {
  const chatId = ctx.chat.id;
  const idx = parseInt(ctx.match[1], 10);
  const record = testResults[idx];
  const tt = t(chatId);

  if (!record || record.chatId !== chatId) {
    ctx.answerCbQuery();
    return;
  }

  ctx.answerCbQuery('🎓 ...');
  try {
    const certBuffer = await generateCertificate(record.name, record.level, record.percent);
    await ctx.replyWithPhoto({ source: certBuffer }, { caption: '🎓 Sertifikatingiz tayyor!' });
  } catch (e) {
    console.error('Sertifikat xatosi:', e.message);
    ctx.reply(tt.certError);
  }
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
      [Markup.button.callback("🧪 Test natijalari", 'admin:testresults')],
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

  // Eng ko'p taklif qilgan o'quvchilar (top 5)
  const referralCounts = {};
  students.forEach(s => {
    if (s.referredBy) {
      referralCounts[s.referredBy] = (referralCounts[s.referredBy] || 0) + 1;
    }
  });
  const topReferrers = Object.entries(referralCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([refChatId, count]) => {
      const refStudent = students.find(s => s.chatId === parseInt(refChatId, 10));
      const refName = refStudent ? refStudent.name : `ID: ${refChatId}`;
      return `${refName} — ${count} ta`;
    });
  const referralSection = topReferrers.length
    ? `\n\n🎁 Eng faol taklif qiluvchilar:\n${topReferrers.join('\n')}`
    : '';

  const msg =
    `📊 <b>Statistika</b>\n\n` +
    `👥 Jami: ${total} ta\n\n` +
    `💻 Onlayn: ${online} ta\n` +
    `🏫 Oflayn: ${offline} ta\n\n` +
    `🇺🇿 O'zbek tilida: ${uz} ta\n` +
    `🇷🇺 Rus tilida: ${ru} ta\n\n` +
    `📚 Darajalar bo'yicha:\n${levelCounts}` +
    referralSection;

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

  const rows = students.map((s, i) => {
    const referrer = s.referredBy ? students.find(st => st.chatId === s.referredBy) : null;
    return {
      '№': i + 1,
      'Ism familiya': s.name,
      'Yosh': s.age,
      'Telefon': s.phone,
      'Format': s.format === 'online' ? 'Onlayn' : 'Oflayn',
      'Daraja': s.level,
      'Til': s.lang === 'ru' ? 'Rus' : "O'zbek",
      'Kim taklif qildi': referrer ? referrer.name : '',
      'Ro\'yxatdan o\'tgan sana': new Date(s.date).toLocaleString('uz-UZ'),
    };
  });

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

// ==== Admin: Test natijalari ====
bot.action('admin:testresults', (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return ctx.answerCbQuery();
  ctx.answerCbQuery();

  if (testResults.length === 0) {
    ctx.reply("Hozircha hech kim test topshirmagan.");
    return;
  }

  const levels = ['A1', 'A2', 'B1', 'B2'];
  let msg = "🧪 <b>Test natijalari</b>\n\n";
  const totalAttempts = testResults.length;
  const totalPassed = testResults.filter(r => r.passed).length;

  msg += `Jami urinishlar: ${totalAttempts} ta\n`;
  msg += `Sertifikat olganlar: ${totalPassed} ta\n\n`;

  levels.forEach(lvl => {
    const attempts = testResults.filter(r => r.level === lvl);
    if (attempts.length === 0) return;
    const passed = attempts.filter(r => r.passed).length;
    const avg = Math.round(attempts.reduce((sum, r) => sum + r.percent, 0) / attempts.length);
    msg += `<b>${lvl}</b>: ${attempts.length} ta urinish, ${passed} ta sertifikat, o'rtacha ${avg}%\n`;
  });

  ctx.replyWithHTML(msg);
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

    const uniqueChatIds = [...new Set(allUsers.map(u => u.chatId))]
      .filter(id => !isAdmin(id)); // adminlarga o'z xabari qaytarilmaydi
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

  // ==== Test uchun ism/telefon so'rash bosqichi ====
  const tState = testState[chatId];
  if (tState && (tState.step === 'name' || tState.step === 'phone')) {
    if (tState.step === 'name') {
      tState.data.name = text.trim();
      tState.step = 'phone';
      ctx.reply(
        tt.testAskPhone,
        Markup.keyboard([[Markup.button.contactRequest(tt.sharePhoneBtn)]]).resize().oneTime()
      );
      return;
    }
    if (tState.step === 'phone') {
      tState.data.phone = text.trim();
      tState.step = 'quiz';
      ctx.reply('👍', Markup.removeKeyboard());
      sendTestQuestion(ctx, chatId);
      return;
    }
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

  const tState = testState[chatId];
  if (tState && tState.step === 'phone') {
    tState.data.phone = ctx.message.contact.phone_number;
    tState.step = 'quiz';
    ctx.reply('👍', Markup.removeKeyboard());
    sendTestQuestion(ctx, chatId);
    return;
  }

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

  const userRecord = allUsers.find(u => u.chatId === chatId);
  const referredBy = userRecord ? userRecord.referredBy : null;

  const student = {
    chatId,
    lang,
    format: state.data.format,
    level: state.data.level,
    name: state.data.name,
    age: state.data.age,
    phone: state.data.phone,
    referredBy: referredBy || null,
    date: new Date().toISOString(),
  };
  students.push(student);
  saveStudents();
  delete regState[chatId];

  ctx.replyWithHTML(tt.regDone(student), mainMenuKeyboard(chatId));

  // Taklif qiluvchiga xabar yuboramiz
  if (referredBy) {
    const referrerLang = (allUsers.find(u => u.chatId === referredBy) || {}).lang || 'uz';

    // Yangi umumiy son (shu student qo'shilgandan keyingi holat)
    const newCount = getReferralCount(referredBy);
    const oldCount = newCount - 1;
    const oldTierPercent = getDiscountPercent(oldCount);
    const newTierPercent = getDiscountPercent(newCount);

    bot.telegram
      .sendMessage(referredBy, texts[referrerLang].referralNotify(student.name), { parse_mode: 'HTML' })
      .catch(() => {}); // taklif qiluvchi botni bloklagan bo'lishi mumkin

    // Agar yangi chegirma darajasiga o'tgan bo'lsa — alohida tabrik xabari
    if (newTierPercent > oldTierPercent) {
      bot.telegram
        .sendMessage(referredBy, texts[referrerLang].referralTierUp(newTierPercent), { parse_mode: 'HTML' })
        .catch(() => {});
    }
  }
}

// ==== Sertifikat generatsiyasi (SVG -> PNG) ====
async function generateCertificate(name, level, percent) {
  const dateStr = new Date().toLocaleDateString('uz-UZ');
  const escapedName = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const svg = `
<svg width="1200" height="850" viewBox="0 0 1200 850" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fdf6e3"/>
      <stop offset="100%" stop-color="#f5ead0"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#b8860b"/>
      <stop offset="50%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#b8860b"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="850" fill="url(#bg)"/>
  <rect x="30" y="30" width="1140" height="790" fill="none" stroke="url(#gold)" stroke-width="6"/>
  <rect x="50" y="50" width="1100" height="750" fill="none" stroke="#b8860b" stroke-width="2"/>

  <!-- Burchak bezaklari -->
  <circle cx="70" cy="70" r="10" fill="#d4af37"/>
  <circle cx="1130" cy="70" r="10" fill="#d4af37"/>
  <circle cx="70" cy="780" r="10" fill="#d4af37"/>
  <circle cx="1130" cy="780" r="10" fill="#d4af37"/>

  <text x="600" y="150" font-family="Georgia, 'Times New Roman', serif" font-size="26" fill="#b8860b" text-anchor="middle" letter-spacing="4">TURK TILI O'QUV KURSI</text>
  <text x="600" y="185" font-family="Georgia, serif" font-size="18" fill="#8a6d00" text-anchor="middle">@Turk_akademisi</text>

  <text x="600" y="270" font-family="Georgia, serif" font-size="64" font-weight="bold" fill="#3a2a00" text-anchor="middle" letter-spacing="6">SERTIFIKAT</text>

  <line x1="400" y1="300" x2="800" y2="300" stroke="#d4af37" stroke-width="2"/>

  <text x="600" y="360" font-family="Georgia, serif" font-size="20" fill="#555" text-anchor="middle">Ushbu sertifikat quyidagi shaxsga topshiriladi:</text>

  <text x="600" y="440" font-family="Georgia, serif" font-size="48" font-weight="bold" fill="#1a1a1a" text-anchor="middle">${escapedName}</text>

  <text x="600" y="500" font-family="Georgia, serif" font-size="22" fill="#333" text-anchor="middle">
    Turk tili ${level} darajasi bo'yicha grammatika testidan
  </text>
  <text x="600" y="535" font-family="Georgia, serif" font-size="22" fill="#333" text-anchor="middle">
    <tspan font-weight="bold" fill="#2e7d32">${percent}%</tspan> natija bilan muvaffaqiyatli o'tganligini tasdiqlaydi.
  </text>

  <text x="600" y="620" font-family="Georgia, serif" font-size="20" fill="#555" text-anchor="middle">Sana: ${dateStr}</text>

  <line x1="230" y1="700" x2="480" y2="700" stroke="#999" stroke-width="1"/>
  <text x="355" y="730" font-family="Georgia, serif" font-size="18" fill="#333" text-anchor="middle">O'qituvchi</text>
  <text x="355" y="755" font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#1a1a1a" text-anchor="middle">Sunnatillo hoca</text>

  <line x1="720" y1="700" x2="970" y2="700" stroke="#999" stroke-width="1"/>
  <text x="845" y="730" font-family="Georgia, serif" font-size="18" fill="#333" text-anchor="middle">Kurs rahbariyati</text>
  <text x="845" y="755" font-family="Georgia, serif" font-size="20" font-weight="bold" fill="#1a1a1a" text-anchor="middle">Turk Akademisi</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ==== Kunlik so'z eslatmasi ====
const dailyWords = [
  // Asosiy iboralar
  { tr: "merhaba", uz: "salom", ru: "привет" },
  { tr: "teşekkür ederim", uz: "rahmat", ru: "спасибо" },
  { tr: "günaydın", uz: "xayrli tong", ru: "доброе утро" },
  { tr: "iyi akşamlar", uz: "xayrli kech", ru: "добрый вечер" },
  { tr: "nasılsın", uz: "qandaysiz", ru: "как дела" },
  { tr: "evet", uz: "ha", ru: "да" },
  { tr: "hayır", uz: "yo'q", ru: "нет" },
  { tr: "kitap", uz: "kitob", ru: "книга" },
  { tr: "araba", uz: "mashina", ru: "машина" },
  { tr: "okul", uz: "maktab", ru: "школа" },
  { tr: "dost", uz: "do'st", ru: "друг" },
  { tr: "para", uz: "pul", ru: "деньги" },
  { tr: "öğrenci", uz: "o'quvchi", ru: "ученик" },
  { tr: "sınıf", uz: "sinf", ru: "класс" },
  { tr: "dünya", uz: "dunyo", ru: "мир" },
  { tr: "hayat", uz: "hayot", ru: "жизнь" },
  { tr: "aşk", uz: "sevgi", ru: "любовь" },
  { tr: "iş", uz: "ish", ru: "работа" },
  { tr: "yol", uz: "yo'l", ru: "дорога" },
  { tr: "şehir", uz: "shahar", ru: "город" },

  // Raqamlar 1-20
  { tr: "bir", uz: "bir", ru: "один" },
  { tr: "iki", uz: "ikki", ru: "два" },
  { tr: "üç", uz: "uch", ru: "три" },
  { tr: "dört", uz: "to'rt", ru: "четыре" },
  { tr: "beş", uz: "besh", ru: "пять" },
  { tr: "altı", uz: "olti", ru: "шесть" },
  { tr: "yedi", uz: "yetti", ru: "семь" },
  { tr: "sekiz", uz: "sakkiz", ru: "восемь" },
  { tr: "dokuz", uz: "to'qqiz", ru: "девять" },
  { tr: "on", uz: "o'n", ru: "десять" },
  { tr: "on bir", uz: "o'n bir", ru: "одиннадцать" },
  { tr: "on iki", uz: "o'n ikki", ru: "двенадцать" },
  { tr: "on üç", uz: "o'n uch", ru: "тринадцать" },
  { tr: "on dört", uz: "o'n to'rt", ru: "четырнадцать" },
  { tr: "on beş", uz: "o'n besh", ru: "пятнадцать" },
  { tr: "on altı", uz: "o'n olti", ru: "шестнадцать" },
  { tr: "on yedi", uz: "o'n yetti", ru: "семнадцать" },
  { tr: "on sekiz", uz: "o'n sakkiz", ru: "восемнадцать" },
  { tr: "on dokuz", uz: "o'n to'qqiz", ru: "девятнадцать" },
  { tr: "yirmi", uz: "yigirma", ru: "двадцать" },

  // Hafta kunlari
  { tr: "pazartesi", uz: "dushanba", ru: "понедельник" },
  { tr: "salı", uz: "seshanba", ru: "вторник" },
  { tr: "çarşamba", uz: "chorshanba", ru: "среда" },
  { tr: "perşembe", uz: "payshanba", ru: "четверг" },
  { tr: "cuma", uz: "juma", ru: "пятница" },
  { tr: "cumartesi", uz: "shanba", ru: "суббота" },
  { tr: "pazar", uz: "yakshanba", ru: "воскресенье" },

  // Oylar
  { tr: "ocak", uz: "yanvar", ru: "январь" },
  { tr: "şubat", uz: "fevral", ru: "февраль" },
  { tr: "mart", uz: "mart", ru: "март" },
  { tr: "nisan", uz: "aprel", ru: "апрель" },
  { tr: "mayıs", uz: "may", ru: "май" },
  { tr: "haziran", uz: "iyun", ru: "июнь" },
  { tr: "temmuz", uz: "iyul", ru: "июль" },
  { tr: "ağustos", uz: "avgust", ru: "август" },
  { tr: "eylül", uz: "sentyabr", ru: "сентябрь" },
  { tr: "ekim", uz: "oktyabr", ru: "октябрь" },
  { tr: "kasım", uz: "noyabr", ru: "ноябрь" },
  { tr: "aralık", uz: "dekabr", ru: "декабрь" },

  // Ranglar
  { tr: "kırmızı", uz: "qizil", ru: "красный" },
  { tr: "mavi", uz: "ko'k", ru: "синий" },
  { tr: "yeşil", uz: "yashil", ru: "зелёный" },
  { tr: "sarı", uz: "sariq", ru: "жёлтый" },
  { tr: "siyah", uz: "qora", ru: "чёрный" },
  { tr: "beyaz", uz: "oq", ru: "белый" },
  { tr: "pembe", uz: "pushti", ru: "розовый" },
  { tr: "mor", uz: "binafsha", ru: "фиолетовый" },
  { tr: "turuncu", uz: "to'q sariq", ru: "оранжевый" },
  { tr: "gri", uz: "kulrang", ru: "серый" },
  { tr: "kahverengi", uz: "jigarrang", ru: "коричневый" },

  // Oila
  { tr: "anne", uz: "ona", ru: "мама" },
  { tr: "baba", uz: "ota", ru: "папа" },
  { tr: "kardeş", uz: "aka-uka/opa-singil", ru: "брат/сестра" },
  { tr: "abla", uz: "opa", ru: "старшая сестра" },
  { tr: "ağabey", uz: "aka", ru: "старший брат" },
  { tr: "teyze", uz: "xola", ru: "тётя (по маме)" },
  { tr: "hala", uz: "amma", ru: "тётя (по папе)" },
  { tr: "dayı", uz: "tog'a", ru: "дядя (по маме)" },
  { tr: "amca", uz: "amaki", ru: "дядя (по папе)" },
  { tr: "dede", uz: "bobo", ru: "дедушка" },
  { tr: "büyükanne", uz: "buvi", ru: "бабушка" },
  { tr: "çocuk", uz: "bola", ru: "ребёнок" },
  { tr: "oğul", uz: "o'g'il", ru: "сын" },
  { tr: "kız", uz: "qiz", ru: "дочь / девочка" },
  { tr: "eş", uz: "turmush o'rtoq", ru: "супруг(а)" },

  // Tana a'zolari
  { tr: "baş", uz: "bosh", ru: "голова" },
  { tr: "göz", uz: "ko'z", ru: "глаз" },
  { tr: "kulak", uz: "quloq", ru: "ухо" },
  { tr: "burun", uz: "burun", ru: "нос" },
  { tr: "ağız", uz: "og'iz", ru: "рот" },
  { tr: "diş", uz: "tish", ru: "зуб" },
  { tr: "el", uz: "qo'l", ru: "рука" },
  { tr: "ayak", uz: "oyoq", ru: "нога" },
  { tr: "saç", uz: "soch", ru: "волосы" },
  { tr: "yüz", uz: "yuz", ru: "лицо" },
  { tr: "boyun", uz: "bo'yin", ru: "шея" },
  { tr: "sırt", uz: "orqa", ru: "спина" },
  { tr: "karın", uz: "qorin", ru: "живот" },

  // Ovqat
  { tr: "ekmek", uz: "non", ru: "хлеб" },
  { tr: "su", uz: "suv", ru: "вода" },
  { tr: "süt", uz: "sut", ru: "молоко" },
  { tr: "et", uz: "go'sht", ru: "мясо" },
  { tr: "tavuk", uz: "tovuq", ru: "курица" },
  { tr: "balık", uz: "baliq", ru: "рыба" },
  { tr: "pirinç", uz: "guruch", ru: "рис" },
  { tr: "sebze", uz: "sabzavot", ru: "овощи" },
  { tr: "meyve", uz: "meva", ru: "фрукты" },
  { tr: "elma", uz: "olma", ru: "яблоко" },
  { tr: "muz", uz: "banan", ru: "банан" },
  { tr: "portakal", uz: "apelsin", ru: "апельсин" },
  { tr: "üzüm", uz: "uzum", ru: "виноград" },
  { tr: "domates", uz: "pomidor", ru: "помидор" },
  { tr: "patates", uz: "kartoshka", ru: "картофель" },
  { tr: "soğan", uz: "piyoz", ru: "лук" },
  { tr: "sarımsak", uz: "sarimsoq", ru: "чеснок" },
  { tr: "peynir", uz: "pishloq", ru: "сыр" },
  { tr: "yumurta", uz: "tuxum", ru: "яйцо" },
  { tr: "şeker", uz: "shakar", ru: "сахар" },
  { tr: "tuz", uz: "tuz", ru: "соль" },
  { tr: "çay", uz: "choy", ru: "чай" },
  { tr: "kahve", uz: "qahva", ru: "кофе" },
  { tr: "bal", uz: "asal", ru: "мёд" },

  // Hayvonlar
  { tr: "kedi", uz: "mushuk", ru: "кошка" },
  { tr: "köpek", uz: "it", ru: "собака" },
  { tr: "kuş", uz: "qush", ru: "птица" },
  { tr: "at", uz: "ot", ru: "лошадь" },
  { tr: "inek", uz: "sigir", ru: "корова" },
  { tr: "koyun", uz: "qo'y", ru: "овца" },
  { tr: "tavşan", uz: "quyon", ru: "кролик" },
  { tr: "aslan", uz: "sher", ru: "лев" },
  { tr: "kaplan", uz: "yo'lbars", ru: "тигр" },
  { tr: "fil", uz: "fil", ru: "слон" },
  { tr: "ayı", uz: "ayiq", ru: "медведь" },
  { tr: "kurt", uz: "bo'ri", ru: "волк" },
  { tr: "tilki", uz: "tulki", ru: "лиса" },
  { tr: "yılan", uz: "ilon", ru: "змея" },
  { tr: "kaplumbağa", uz: "toshbaqa", ru: "черепаха" },
  { tr: "arı", uz: "ari", ru: "пчела" },
  { tr: "kelebek", uz: "kapalak", ru: "бабочка" },

  // Uy
  { tr: "ev", uz: "uy", ru: "дом" },
  { tr: "oda", uz: "xona", ru: "комната" },
  { tr: "mutfak", uz: "oshxona", ru: "кухня" },
  { tr: "banyo", uz: "hammom", ru: "ванная" },
  { tr: "kapı", uz: "eshik", ru: "дверь" },
  { tr: "pencere", uz: "deraza", ru: "окно" },
  { tr: "masa", uz: "stol", ru: "стол" },
  { tr: "sandalye", uz: "stul", ru: "стул" },
  { tr: "yatak", uz: "karavot", ru: "кровать" },
  { tr: "dolap", uz: "shkaf", ru: "шкаф" },
  { tr: "televizyon", uz: "televizor", ru: "телевизор" },
  { tr: "buzdolabı", uz: "muzlatgich", ru: "холодильник" },
  { tr: "lamba", uz: "lampa", ru: "лампа" },

  // Kiyim
  { tr: "gömlek", uz: "ko'ylak", ru: "рубашка" },
  { tr: "pantolon", uz: "shim", ru: "брюки" },
  { tr: "etek", uz: "yubka", ru: "юбка" },
  { tr: "ayakkabı", uz: "poyabzal", ru: "обувь" },
  { tr: "çorap", uz: "paypoq", ru: "носки" },
  { tr: "şapka", uz: "shlyapa", ru: "шапка" },
  { tr: "çanta", uz: "sumka", ru: "сумка" },
  { tr: "ceket", uz: "kurtka", ru: "куртка" },
  { tr: "elbise", uz: "libos", ru: "платье" },

  // Kasblar
  { tr: "öğretmen", uz: "o'qituvchi", ru: "учитель" },
  { tr: "doktor", uz: "shifokor", ru: "врач" },
  { tr: "mühendis", uz: "muhandis", ru: "инженер" },
  { tr: "avukat", uz: "advokat", ru: "адвокат" },
  { tr: "polis", uz: "politsiyachi", ru: "полицейский" },
  { tr: "aşçı", uz: "oshpaz", ru: "повар" },
  { tr: "şoför", uz: "haydovchi", ru: "водитель" },
  { tr: "çiftçi", uz: "dehqon", ru: "фермер" },
  { tr: "yazar", uz: "yozuvchi", ru: "писатель" },
  { tr: "ressam", uz: "rassom", ru: "художник" },
  { tr: "hemşire", uz: "hamshira", ru: "медсестра" },
  { tr: "mimar", uz: "me'mor", ru: "архитектор" },

  // Tabiat
  { tr: "güneş", uz: "quyosh", ru: "солнце" },
  { tr: "ay", uz: "oy", ru: "луна" },
  { tr: "yıldız", uz: "yulduz", ru: "звезда" },
  { tr: "gökyüzü", uz: "osmon", ru: "небо" },
  { tr: "deniz", uz: "dengiz", ru: "море" },
  { tr: "dağ", uz: "tog'", ru: "гора" },
  { tr: "orman", uz: "o'rmon", ru: "лес" },
  { tr: "nehir", uz: "daryo", ru: "река" },
  { tr: "göl", uz: "ko'l", ru: "озеро" },
  { tr: "çiçek", uz: "gul", ru: "цветок" },
  { tr: "ağaç", uz: "daraxt", ru: "дерево" },
  { tr: "yağmur", uz: "yomg'ir", ru: "дождь" },
  { tr: "kar", uz: "qor", ru: "снег" },
  { tr: "rüzgar", uz: "shamol", ru: "ветер" },
  { tr: "bulut", uz: "bulut", ru: "облако" },

  // Vaqt
  { tr: "gün", uz: "kun", ru: "день" },
  { tr: "hafta", uz: "hafta", ru: "неделя" },
  { tr: "ay (zaman)", uz: "oy", ru: "месяц" },
  { tr: "bugün", uz: "bugun", ru: "сегодня" },
  { tr: "yarın", uz: "ertaga", ru: "завтра" },
  { tr: "dün", uz: "kecha", ru: "вчера" },
  { tr: "şimdi", uz: "hozir", ru: "сейчас" },
  { tr: "sonra", uz: "keyin", ru: "потом" },
  { tr: "saat", uz: "soat", ru: "час" },
  { tr: "dakika", uz: "daqiqa", ru: "минута" },
  { tr: "zaman", uz: "vaqt", ru: "время" },

  // Hissiyotlar
  { tr: "mutlu", uz: "baxtli", ru: "счастливый" },
  { tr: "üzgün", uz: "xafa", ru: "грустный" },
  { tr: "kızgın", uz: "g'azablangan", ru: "злой" },
  { tr: "yorgun", uz: "charchagan", ru: "уставший" },
  { tr: "heyecanlı", uz: "hayajonlangan", ru: "взволнованный" },
  { tr: "korkmuş", uz: "qo'rqqan", ru: "испуганный" },
  { tr: "sevinçli", uz: "quvonchli", ru: "радостный" },

  // Fe'llar
  { tr: "gitmek", uz: "bormoq", ru: "идти" },
  { tr: "gelmek", uz: "kelmoq", ru: "приходить" },
  { tr: "yemek", uz: "yemoq", ru: "есть" },
  { tr: "içmek", uz: "ichmoq", ru: "пить" },
  { tr: "uyumak", uz: "uxlamoq", ru: "спать" },
  { tr: "okumak", uz: "o'qimoq", ru: "читать" },
  { tr: "yazmak", uz: "yozmoq", ru: "писать" },
  { tr: "konuşmak", uz: "gaplashmoq", ru: "говорить" },
  { tr: "dinlemek", uz: "tinglamoq", ru: "слушать" },
  { tr: "görmek", uz: "ko'rmoq", ru: "видеть" },
  { tr: "duymak", uz: "eshitmoq", ru: "слышать" },
  { tr: "bilmek", uz: "bilmoq", ru: "знать" },
  { tr: "istemek", uz: "xohlamoq", ru: "хотеть" },
  { tr: "sevmek", uz: "sevmoq", ru: "любить" },
  { tr: "çalışmak", uz: "ishlamoq", ru: "работать" },
  { tr: "oynamak", uz: "o'ynamoq", ru: "играть" },
  { tr: "koşmak", uz: "yugurmoq", ru: "бегать" },
  { tr: "yürümek", uz: "yurmoq", ru: "ходить" },
  { tr: "oturmak", uz: "o'tirmoq", ru: "сидеть" },
  { tr: "durmak", uz: "to'xtamoq", ru: "останавливаться" },

  // Sifatlar
  { tr: "büyük", uz: "katta", ru: "большой" },
  { tr: "küçük", uz: "kichik", ru: "маленький" },
  { tr: "güzel", uz: "chiroyli", ru: "красивый" },
  { tr: "çirkin", uz: "xunuk", ru: "некрасивый" },
  { tr: "uzun", uz: "uzun", ru: "длинный" },
  { tr: "kısa", uz: "qisqa", ru: "короткий" },
  { tr: "yeni", uz: "yangi", ru: "новый" },
  { tr: "eski", uz: "eski", ru: "старый" },
  { tr: "sıcak", uz: "issiq", ru: "горячий" },
  { tr: "soğuk", uz: "sovuq", ru: "холодный" },
  { tr: "hızlı", uz: "tez", ru: "быстрый" },
  { tr: "yavaş", uz: "sekin", ru: "медленный" },
  { tr: "kolay", uz: "oson", ru: "лёгкий" },
  { tr: "zor", uz: "qiyin", ru: "трудный" },
  { tr: "ucuz", uz: "arzon", ru: "дешёвый" },
  { tr: "pahalı", uz: "qimmat", ru: "дорогой" },
  { tr: "temiz", uz: "toza", ru: "чистый" },
  { tr: "kirli", uz: "iflos", ru: "грязный" },

  // Savol so'zlari
  { tr: "ne", uz: "nima", ru: "что" },
  { tr: "kim", uz: "kim", ru: "кто" },
  { tr: "nerede", uz: "qayerda", ru: "где" },
  { tr: "ne zaman", uz: "qachon", ru: "когда" },
  { tr: "nasıl", uz: "qanday", ru: "как" },
  { tr: "neden", uz: "nega", ru: "почему" },
  { tr: "kaç", uz: "qancha", ru: "сколько" },
  { tr: "hangi", uz: "qaysi", ru: "какой" },
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