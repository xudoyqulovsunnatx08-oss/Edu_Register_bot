require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

console.log("Kalit borligini tekshirish:", process.env.GEMINI_API_KEY ? "✅ Topildi" : "❌ Topilmadi");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

async function test() {
  try {
    console.log("So'rov yuborilmoqda...");
    const result = await model.generateContent("Salom, ishlaяpsanmi?");
    console.log("✅ JAVOB KELDI:");
    console.log(result.response.text());
  } catch (error) {
    console.log("❌ XATO YUZ BERDI:");
    console.log(error);
  }
}

test();