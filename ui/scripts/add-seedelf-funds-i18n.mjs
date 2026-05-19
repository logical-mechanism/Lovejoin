#!/usr/bin/env node
// One-shot maintenance: add the registers-vs-funds explanatory copy
// introduced when the Spend affordance was moved off registers and
// onto funds. See PR #157.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCALES_DIR = resolve(__dirname, "..", "src", "i18n", "locales");

const TRANSLATIONS = {
  zh: {
    registers_help:
      "注册是你的隐身地址 — 把它们的 seedelf id 分享给发送者。它们不是用来花费的余额。",
    funds_heading: "资金",
    funds_help:
      "资金是别人发送到你的注册的付款，经过重新随机化以防止发送者跟踪。支出资金以转出 ADA 或将其轮换到一个新注册中。",
  },
  hi: {
    registers_help:
      "रजिस्टर आपके स्टेल्थ पते हैं — उनकी seedelf id भेजने वालों के साथ साझा करें। ये खर्च करने योग्य शेष नहीं हैं।",
    funds_heading: "फंड",
    funds_help:
      "फंड वे भुगतान हैं जो किसी ने आपके रजिस्टर को भेजे, फिर से रैंडमाइज़ किए गए ताकि भेजने वाला उन्हें ट्रैक न कर सके। ADA बाहर भेजने या किसी नए रजिस्टर में स्थानांतरित करने के लिए फंड खर्च करें।",
  },
  es: {
    registers_help:
      "Los registros son tus direcciones sigilosas — comparte su seedelf id con los remitentes. No son un saldo que gastes.",
    funds_heading: "Fondos",
    funds_help:
      "Los fondos son pagos enviados a uno de tus registros, re-aleatorizados para que el remitente no pueda seguirlos. Gasta fondos para mover ADA fuera o rotarlo a un registro nuevo.",
  },
  fr: {
    registers_help:
      "Les registres sont vos adresses furtives — partagez leur seedelf id avec les expéditeurs. Ce n'est pas un solde à dépenser.",
    funds_heading: "Fonds",
    funds_help:
      "Les fonds sont les paiements envoyés à l'un de vos registres, re-randomisés pour que l'expéditeur ne puisse pas les suivre. Dépensez les fonds pour sortir des ADA ou les rouler vers un nouveau registre.",
  },
  ar: {
    registers_help:
      "السجلات هي عناوينك الخفية — شارك معرف seedelf الخاص بها مع المرسلين. إنها ليست رصيدًا قابلًا للإنفاق.",
    funds_heading: "الأموال",
    funds_help:
      "الأموال هي المدفوعات المرسلة إلى أحد سجلاتك، مُعاد توزيعها عشوائيًا حتى لا يتمكن المرسل من تتبعها. أنفق الأموال لنقل ADA إلى الخارج أو تدويرها إلى سجل جديد.",
  },
  pt: {
    registers_help:
      "Os registros são seus endereços furtivos — compartilhe o seedelf id deles com os remetentes. Não é um saldo para gastar.",
    funds_heading: "Fundos",
    funds_help:
      "Fundos são pagamentos enviados para um dos seus registros, re-randomizados para que o remetente não possa rastreá-los. Gaste fundos para enviar ADA para fora ou rotacionar para um registro novo.",
  },
  de: {
    registers_help:
      "Register sind deine Tarn-Adressen — teile ihre seedelf id mit Absendern. Sie sind kein Guthaben, das du ausgeben kannst.",
    funds_heading: "Guthaben",
    funds_help:
      "Guthaben sind Zahlungen, die an eines deiner Register gesendet wurden, neu randomisiert, damit der Absender sie nicht verfolgen kann. Gib Guthaben aus, um ADA herauszuschicken oder in ein neues Register zu rotieren.",
  },
  ja: {
    registers_help:
      "レジスタはあなたのステルスアドレスです — その seedelf id を送信者と共有してください。残高として使うものではありません。",
    funds_heading: "資金",
    funds_help:
      "資金はあなたのレジスタに送られた支払いで、送信者が追跡できないよう再ランダム化されています。資金を使って ADA を外部へ送るか、新しいレジスタへローテートしてください。",
  },
  ru: {
    registers_help:
      "Регистры — это ваши анонимные адреса. Делитесь их seedelf id с отправителями. Это не баланс для трат.",
    funds_heading: "Средства",
    funds_help:
      "Средства — это платежи, отправленные на один из ваших регистров, рерандомизированные, чтобы отправитель не мог их отследить. Расходуйте средства, чтобы вывести ADA или ротировать их в новый регистр.",
  },
  ko: {
    registers_help:
      "레지스터는 당신의 스텔스 주소입니다 — seedelf id를 송신자와 공유하세요. 사용할 수 있는 잔액이 아닙니다.",
    funds_heading: "자금",
    funds_help:
      "자금은 당신의 레지스터로 송금된 결제이며, 송신자가 추적할 수 없도록 재무작위화됩니다. 자금을 사용해 ADA를 외부로 보내거나 새 레지스터로 회전시키세요.",
  },
  it: {
    registers_help:
      "I registri sono i tuoi indirizzi stealth — condividi il loro seedelf id con i mittenti. Non sono un saldo da spendere.",
    funds_heading: "Fondi",
    funds_help:
      "I fondi sono pagamenti inviati a uno dei tuoi registri, ri-randomizzati per impedire al mittente di tracciarli. Spendi i fondi per inviare ADA fuori o ruotarli in un nuovo registro.",
  },
  pl: {
    registers_help:
      "Rejestry to twoje adresy stealth — udostępniaj ich seedelf id nadawcom. To nie jest saldo do wydania.",
    funds_heading: "Środki",
    funds_help:
      "Środki to płatności wysłane do jednego z twoich rejestrów, ponownie zrandomizowane, aby nadawca nie mógł ich śledzić. Wydaj środki, aby przesłać ADA na zewnątrz lub przenieść je do nowego rejestru.",
  },
  tr: {
    registers_help:
      "Kayıtlar gizli adreslerinizdir — seedelf id'lerini göndericilere paylaşın. Harcanabilir bir bakiye değildir.",
    funds_heading: "Bakiye",
    funds_help:
      "Bakiye, kayıtlarınızdan birine gönderilen ödemelerdir; gönderici takip edemesin diye yeniden rastgele şifrelenmiştir. ADA'yı dışarı göndermek veya yeni bir kayda döndürmek için bakiye harcayın.",
  },
  vi: {
    registers_help:
      "Đăng ký là các địa chỉ tàng hình của bạn — chia sẻ seedelf id của chúng với người gửi. Đây không phải là số dư bạn có thể chi tiêu.",
    funds_heading: "Quỹ",
    funds_help:
      "Quỹ là các khoản thanh toán được gửi đến một trong các đăng ký của bạn, được ngẫu nhiên hóa lại để người gửi không thể theo dõi. Chi tiêu quỹ để chuyển ADA ra ngoài hoặc luân chuyển sang đăng ký mới.",
  },
  id: {
    registers_help:
      "Register adalah alamat siluman Anda — bagikan seedelf id-nya kepada pengirim. Ini bukan saldo yang dapat dibelanjakan.",
    funds_heading: "Dana",
    funds_help:
      "Dana adalah pembayaran yang dikirim ke salah satu register Anda, diacak ulang agar pengirim tidak dapat melacaknya. Belanjakan dana untuk mengirim ADA ke luar atau memutarnya ke register baru.",
  },
  th: {
    registers_help:
      "รีจิสเตอร์คือที่อยู่ล่องหนของคุณ — แชร์ seedelf id ของพวกมันกับผู้ส่ง พวกมันไม่ใช่ยอดเงินที่ใช้จ่ายได้",
    funds_heading: "เงินทุน",
    funds_help:
      "เงินทุนคือการชำระเงินที่ส่งไปยังรีจิสเตอร์ของคุณและสุ่มใหม่เพื่อให้ผู้ส่งติดตามไม่ได้ ใช้จ่ายเงินทุนเพื่อโอน ADA ออกหรือหมุนเวียนไปยังรีจิสเตอร์ใหม่",
  },
  bn: {
    registers_help:
      "রেজিস্টার আপনার গোপন ঠিকানা — তাদের seedelf id প্রেরকদের সাথে শেয়ার করুন। এটি খরচ করার মতো ব্যালেন্স নয়।",
    funds_heading: "তহবিল",
    funds_help:
      "তহবিল হলো আপনার রেজিস্টারের কোনো একটিতে পাঠানো পেমেন্ট, যা প্রেরক যেন ট্র্যাক করতে না পারেন সে জন্য পুনরায় র‍্যান্ডমাইজ করা হয়েছে। ADA বাইরে পাঠাতে বা একটি নতুন রেজিস্টারে রোটেট করতে তহবিল খরচ করুন।",
  },
  fa: {
    registers_help:
      "ثبت‌ها آدرس‌های مخفی شما هستند — seedelf id آن‌ها را با فرستندگان به اشتراک بگذارید. این موجودی قابل خرج کردن نیست.",
    funds_heading: "موجودی",
    funds_help:
      "موجودی پرداخت‌هایی است که به یکی از ثبت‌های شما ارسال شده و دوباره تصادفی‌سازی شده تا فرستنده نتواند آن را ردیابی کند. برای ارسال ADA به بیرون یا چرخش به یک ثبت تازه از موجودی خرج کنید.",
  },
  ur: {
    registers_help:
      "رجسٹرز آپ کے خفیہ پتے ہیں — ان کی seedelf id بھیجنے والوں کے ساتھ شیئر کریں۔ یہ خرچ کرنے والا بیلنس نہیں ہے۔",
    funds_heading: "فنڈز",
    funds_help:
      "فنڈز وہ ادائیگیاں ہیں جو آپ کے کسی رجسٹر کو بھیجی گئیں، بھیجنے والے کے ٹریک نہ کر سکنے کے لیے دوبارہ رینڈمائز کی گئیں۔ ADA باہر بھیجنے یا کسی نئے رجسٹر میں منتقل کرنے کے لیے فنڈز خرچ کریں۔",
  },
};

async function patchOne(code) {
  const path = `${LOCALES_DIR}/${code}.json`;
  const raw = await readFile(path, "utf8");
  const data = JSON.parse(raw);
  data.vault = data.vault ?? {};
  data.vault.seedelf = { ...data.vault.seedelf, ...TRANSLATIONS[code] };
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  for (const code of Object.keys(TRANSLATIONS)) {
    await patchOne(code);
    process.stdout.write(`  updated ${code}.json\n`);
  }
}

await main();
