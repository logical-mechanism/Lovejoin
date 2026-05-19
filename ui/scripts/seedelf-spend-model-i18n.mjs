#!/usr/bin/env node
// One-shot maintenance: reflect the reworked Seedelf spend UI.
// The internal rotate/churn spend mode is gone; a spend now goes to a
// single destination (a Cardano address OR another Seedelf) with an
// optional amount, leftover becoming automatic change.
//
// Removes 3 stale keys (spend_mode_internal, spend_external_hint,
// spend_internal_hint) and adds 5 genuinely-new keys per locale.
// spend_mode_external already exists and is unchanged in EN, so its
// existing translation is left untouched.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCALES_DIR = resolve(__dirname, "..", "src", "i18n", "locales");

const STALE_KEYS = ["spend_mode_internal", "spend_external_hint", "spend_internal_hint"];

// EN reference for the 5 new keys (spend_mode_external excluded — unchanged):
//   spend_mode_seedelf:     "To another Seedelf"
//   spend_seedelf_label:    "Recipient seedelf id (32-byte hex)"
//   spend_amount_label:     "Amount (ADA) — leave blank to spend it all"
//   spend_amount_placeholder:"blank = spend all"
//   spend_all_hint:         "Spends the whole fund ({{amount}} ADA) minus the tx fee. No change."
//   spend_change_hint:      "Sends the entered amount; the rest comes back as change to a fresh register you own (if it clears the chain minimum)."
const TRANSLATIONS = {
  ar: {
    spend_mode_seedelf: "إلى Seedelf آخر",
    spend_seedelf_label: "seedelf id للمستلم (هكس 32 بايت)",
    spend_amount_label: "المبلغ (ADA) — اتركه فارغًا لإنفاقه بالكامل",
    spend_amount_placeholder: "فارغ = إنفاق الكل",
    spend_all_hint: "ينفق الأموال بالكامل ({{amount}} ADA) مطروحًا منها رسوم المعاملة. بلا فكة.",
    spend_change_hint:
      "يرسل المبلغ المُدخل؛ ويعود الباقي كفكة إلى سجل جديد تملكه (إن تجاوز الحد الأدنى للسلسلة).",
  },
  bn: {
    spend_mode_seedelf: "অন্য একটি Seedelf-এ",
    spend_seedelf_label: "প্রাপকের seedelf id (32-বাইট হেক্স)",
    spend_amount_label: "পরিমাণ (ADA) — পুরোটা খরচ করতে খালি রাখুন",
    spend_amount_placeholder: "খালি = সব খরচ",
    spend_all_hint: "পুরো তহবিল ({{amount}} ADA) খরচ করে, tx ফি বাদ দিয়ে। কোনো বাকি নেই।",
    spend_change_hint:
      "প্রবেশ করানো পরিমাণ পাঠায়; বাকিটা আপনার মালিকানাধীন একটি নতুন রেজিস্টারে বাকি হিসেবে ফিরে আসে (যদি চেইনের ন্যূনতম পার করে)।",
  },
  de: {
    spend_mode_seedelf: "An ein anderes Seedelf",
    spend_seedelf_label: "seedelf id des Empfängers (32-Byte-Hex)",
    spend_amount_label: "Betrag (ADA) — leer lassen, um alles auszugeben",
    spend_amount_placeholder: "leer = alles ausgeben",
    spend_all_hint:
      "Gibt das gesamte Guthaben ({{amount}} ADA) abzüglich Tx-Gebühr aus. Kein Wechselgeld.",
    spend_change_hint:
      "Sendet den eingegebenen Betrag; der Rest kommt als Wechselgeld zurück in ein frisches Register, das Ihnen gehört (sofern es das Chain-Minimum erreicht).",
  },
  es: {
    spend_mode_seedelf: "A otro Seedelf",
    spend_seedelf_label: "seedelf id del destinatario (hex de 32 bytes)",
    spend_amount_label: "Monto (ADA) — déjalo en blanco para gastarlo todo",
    spend_amount_placeholder: "en blanco = gastar todo",
    spend_all_hint: "Gasta todo el fondo ({{amount}} ADA) menos la comisión de tx. Sin cambio.",
    spend_change_hint:
      "Envía el monto introducido; el resto vuelve como cambio a un registro nuevo de tu propiedad (si supera el mínimo de la cadena).",
  },
  fa: {
    spend_mode_seedelf: "به یک Seedelf دیگر",
    spend_seedelf_label: "seedelf id گیرنده (هگز ۳۲ بایتی)",
    spend_amount_label: "مبلغ (ADA) — برای خرج کردن همه آن را خالی بگذارید",
    spend_amount_placeholder: "خالی = خرج همه",
    spend_all_hint: "کل موجودی ({{amount}} ADA) منهای کارمزد tx را خرج می‌کند. بدون باقی‌مانده.",
    spend_change_hint:
      "مبلغ واردشده را ارسال می‌کند؛ بقیه به‌عنوان باقی‌مانده به یک ثبت تازه که مالک آن هستید بازمی‌گردد (اگر از حداقل زنجیره عبور کند).",
  },
  fr: {
    spend_mode_seedelf: "Vers un autre Seedelf",
    spend_seedelf_label: "seedelf id du destinataire (hex 32 octets)",
    spend_amount_label: "Montant (ADA) — laissez vide pour tout dépenser",
    spend_amount_placeholder: "vide = tout dépenser",
    spend_all_hint:
      "Dépense la totalité du fonds ({{amount}} ADA) moins les frais de tx. Sans monnaie rendue.",
    spend_change_hint:
      "Envoie le montant saisi ; le reste revient en monnaie vers un nouveau registre vous appartenant (s'il dépasse le minimum de la chaîne).",
  },
  hi: {
    spend_mode_seedelf: "किसी अन्य Seedelf को",
    spend_seedelf_label: "प्राप्तकर्ता की seedelf id (32-बाइट हेक्स)",
    spend_amount_label: "राशि (ADA) — पूरा खर्च करने के लिए खाली छोड़ें",
    spend_amount_placeholder: "खाली = सब खर्च करें",
    spend_all_hint: "पूरा फंड ({{amount}} ADA) tx शुल्क घटाकर खर्च करता है। कोई बचत नहीं।",
    spend_change_hint:
      "दर्ज की गई राशि भेजता है; बाकी आपके स्वामित्व वाले एक नए रजिस्टर में बचत के रूप में लौटती है (यदि वह चेन न्यूनतम पार करे)।",
  },
  id: {
    spend_mode_seedelf: "Ke Seedelf lain",
    spend_seedelf_label: "seedelf id penerima (heks 32 byte)",
    spend_amount_label: "Jumlah (ADA) — kosongkan untuk membelanjakan semuanya",
    spend_amount_placeholder: "kosong = belanjakan semua",
    spend_all_hint:
      "Membelanjakan seluruh dana ({{amount}} ADA) dikurangi biaya tx. Tanpa kembalian.",
    spend_change_hint:
      "Mengirim jumlah yang dimasukkan; sisanya kembali sebagai kembalian ke register baru milik Anda (jika melewati minimum rantai).",
  },
  it: {
    spend_mode_seedelf: "A un altro Seedelf",
    spend_seedelf_label: "seedelf id del destinatario (hex da 32 byte)",
    spend_amount_label: "Importo (ADA) — lascia vuoto per spenderlo tutto",
    spend_amount_placeholder: "vuoto = spendi tutto",
    spend_all_hint:
      "Spende l'intero fondo ({{amount}} ADA) meno la commissione di tx. Senza resto.",
    spend_change_hint:
      "Invia l'importo inserito; il resto torna come resto a un nuovo registro di tua proprietà (se supera il minimo della catena).",
  },
  ja: {
    spend_mode_seedelf: "別の Seedelf へ",
    spend_seedelf_label: "受取人の seedelf id（32 バイト hex）",
    spend_amount_label: "金額（ADA）— 空欄にすると全額を支払います",
    spend_amount_placeholder: "空欄 = 全額支払う",
    spend_all_hint:
      "ファンド全額（{{amount}} ADA）から tx 手数料を引いた額を支払います。おつりはありません。",
    spend_change_hint:
      "入力した金額を送り、残りはあなたが所有する新しいレジスタへおつりとして戻ります（チェーンの最小額を超える場合）。",
  },
  ko: {
    spend_mode_seedelf: "다른 Seedelf로",
    spend_seedelf_label: "수신자 seedelf id (32바이트 hex)",
    spend_amount_label: "금액 (ADA) — 전부 사용하려면 비워 두세요",
    spend_amount_placeholder: "공백 = 전부 사용",
    spend_all_hint:
      "전체 자금({{amount}} ADA)에서 tx 수수료를 뺀 금액을 사용합니다. 거스름돈 없음.",
    spend_change_hint:
      "입력한 금액을 보내고, 나머지는 당신이 소유한 새 레지스터로 거스름돈으로 돌아옵니다 (체인 최소액을 넘는 경우).",
  },
  pl: {
    spend_mode_seedelf: "Do innego Seedelf",
    spend_seedelf_label: "seedelf id odbiorcy (32-bajtowy hex)",
    spend_amount_label: "Kwota (ADA) — zostaw puste, aby wydać wszystko",
    spend_amount_placeholder: "puste = wydaj wszystko",
    spend_all_hint: "Wydaje całe środki ({{amount}} ADA) pomniejszone o opłatę tx. Bez reszty.",
    spend_change_hint:
      "Wysyła wpisaną kwotę; reszta wraca jako reszta do nowego rejestru należącego do Ciebie (jeśli przekroczy minimum łańcucha).",
  },
  pt: {
    spend_mode_seedelf: "Para outro Seedelf",
    spend_seedelf_label: "seedelf id do destinatário (hex de 32 bytes)",
    spend_amount_label: "Valor (ADA) — deixe em branco para gastar tudo",
    spend_amount_placeholder: "em branco = gastar tudo",
    spend_all_hint: "Gasta todo o fundo ({{amount}} ADA) menos a taxa de tx. Sem troco.",
    spend_change_hint:
      "Envia o valor informado; o restante volta como troco para um registro novo de sua propriedade (se ultrapassar o mínimo da cadeia).",
  },
  ru: {
    spend_mode_seedelf: "На другой Seedelf",
    spend_seedelf_label: "seedelf id получателя (32-байтный hex)",
    spend_amount_label: "Сумма (ADA) — оставьте пустым, чтобы потратить всё",
    spend_amount_placeholder: "пусто = потратить всё",
    spend_all_hint: "Тратит все средства ({{amount}} ADA) за вычетом комиссии tx. Без сдачи.",
    spend_change_hint:
      "Отправляет введённую сумму; остаток возвращается как сдача в свежий регистр, которым вы владеете (если он превышает минимум сети).",
  },
  th: {
    spend_mode_seedelf: "ไปยัง Seedelf อื่น",
    spend_seedelf_label: "seedelf id ของผู้รับ (เลขฐานสิบหก 32 ไบต์)",
    spend_amount_label: "จำนวน (ADA) — เว้นว่างเพื่อใช้จ่ายทั้งหมด",
    spend_amount_placeholder: "เว้นว่าง = ใช้จ่ายทั้งหมด",
    spend_all_hint: "ใช้จ่ายเงินทุนทั้งก้อน ({{amount}} ADA) หักค่าธรรมเนียม tx ไม่มีเงินทอน",
    spend_change_hint:
      "ส่งจำนวนที่กรอก ส่วนที่เหลือกลับมาเป็นเงินทอนไปยังรีจิสเตอร์ใหม่ที่คุณเป็นเจ้าของ (หากเกินขั้นต่ำของเชน)",
  },
  tr: {
    spend_mode_seedelf: "Başka bir Seedelf'e",
    spend_seedelf_label: "Alıcının seedelf id'si (32 baytlık hex)",
    spend_amount_label: "Tutar (ADA) — hepsini harcamak için boş bırakın",
    spend_amount_placeholder: "boş = hepsini harca",
    spend_all_hint: "Tüm bakiyeyi ({{amount}} ADA) tx ücreti düşülerek harcar. Para üstü yok.",
    spend_change_hint:
      "Girilen tutarı gönderir; geri kalanı, sahip olduğunuz yeni bir kayda para üstü olarak döner (zincir minimumunu aşarsa).",
  },
  ur: {
    spend_mode_seedelf: "کسی دوسرے Seedelf کو",
    spend_seedelf_label: "وصول کنندہ کی seedelf id (32 بائٹ ہیکس)",
    spend_amount_label: "رقم (ADA) — سب خرچ کرنے کے لیے خالی چھوڑیں",
    spend_amount_placeholder: "خالی = سب خرچ کریں",
    spend_all_hint: "پورا فنڈ ({{amount}} ADA) tx فیس منہا کر کے خرچ کرتا ہے۔ کوئی بقایا نہیں۔",
    spend_change_hint:
      "درج کردہ رقم بھیجتا ہے؛ باقی آپ کے ملکیتی ایک نئے رجسٹر میں بقایا کے طور پر واپس آتی ہے (اگر چین کی کم از کم حد عبور کرے)۔",
  },
  vi: {
    spend_mode_seedelf: "Đến một Seedelf khác",
    spend_seedelf_label: "seedelf id của người nhận (hex 32 byte)",
    spend_amount_label: "Số tiền (ADA) — để trống để chi tiêu toàn bộ",
    spend_amount_placeholder: "trống = chi tiêu tất cả",
    spend_all_hint: "Chi tiêu toàn bộ quỹ ({{amount}} ADA) trừ phí tx. Không có tiền thừa.",
    spend_change_hint:
      "Gửi số tiền đã nhập; phần còn lại quay về dưới dạng tiền thừa vào một đăng ký mới do bạn sở hữu (nếu vượt mức tối thiểu của chuỗi).",
  },
  zh: {
    spend_mode_seedelf: "发送到另一个 Seedelf",
    spend_seedelf_label: "收款人 seedelf id（32 字节十六进制）",
    spend_amount_label: "金额（ADA）— 留空则全部花费",
    spend_amount_placeholder: "留空 = 全部花费",
    spend_all_hint: "花费整笔资金（{{amount}} ADA）减去交易费。没有找零。",
    spend_change_hint:
      "发送输入的金额；余下部分作为找零返回到你拥有的一个新注册（若超过链上最低额）。",
  },
};

async function patchOne(code) {
  const path = `${LOCALES_DIR}/${code}.json`;
  const raw = await readFile(path, "utf8");
  const data = JSON.parse(raw);
  data.vault = data.vault ?? {};
  const seedelf = { ...(data.vault.seedelf ?? {}) };
  for (const stale of STALE_KEYS) delete seedelf[stale];
  data.vault.seedelf = { ...seedelf, ...TRANSLATIONS[code] };
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  for (const code of Object.keys(TRANSLATIONS)) {
    await patchOne(code);
    process.stdout.write(`  updated ${code}.json\n`);
  }
}

await main();
