#!/usr/bin/env node
// One-shot maintenance: inject the `vault.seedelf.*` translations into
// every non-EN locale for issue #135. Run from ui/ with:
//
//   node scripts/add-seedelf-i18n.mjs
//
// Idempotent — re-running overwrites the seedelf block with the values
// below. Drafted by an LLM; native-speaker review welcome.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCALES_DIR = resolve(__dirname, "..", "src", "i18n", "locales");

const TRANSLATIONS = {
  zh: {
    eyebrow: "隐身钱包",
    title: "Seedelf",
    lede: "由与解锁 Lovejoin 金库相同的钱包签名派生的隐身钱包注册。每个注册都是一个可接收 ADA 的私密地址；只有你才能花费。这是你通过 seedelf-cli 使用的同一链上 Seedelf 协议。",
    scanning: "扫描中…",
    rescan: "重新扫描",
    scan_failed: "Seedelf 扫描失败：{{message}}",
    empty_title: "尚无 Seedelf",
    empty_hint: "你可以使用 seedelf-cli 铸造第一个隐身注册，或等待应用内铸造流程上线。",
    registers_label: "注册",
    funds_label: "已存入的 UTxO",
    balance_label: "总余额",
    registers_heading: "你的注册",
    index_label: "索引 {{i}}",
    actions_coming_soon:
      "铸造、发送和支出流程将在后续更新中上线。目前请通过 seedelf-cli 管理你的隐身钱包。",
  },
  hi: {
    eyebrow: "स्टेल्थ वॉलेट",
    title: "Seedelf",
    lede: "वही वॉलेट सिग्नेचर जो आपकी Lovejoin वॉल्ट खोलता है, उसी से प्राप्त स्टेल्थ-वॉलेट रजिस्टर। प्रत्येक रजिस्टर एक निजी पता है जिस पर आप ADA प्राप्त कर सकते हैं; केवल आप ही खर्च कर सकते हैं। वही ऑन-चेन Seedelf प्रोटोकॉल जिसे आप seedelf-cli के माध्यम से उपयोग करते हैं।",
    scanning: "स्कैन हो रहा है…",
    rescan: "फिर से स्कैन करें",
    scan_failed: "Seedelf स्कैन विफल: {{message}}",
    empty_title: "अभी कोई Seedelf नहीं",
    empty_hint:
      "अपना पहला स्टेल्थ रजिस्टर seedelf-cli से बना सकते हैं या इन-ऐप मिंट फ्लो की प्रतीक्षा कर सकते हैं।",
    registers_label: "रजिस्टर",
    funds_label: "फंडेड UTxO",
    balance_label: "कुल शेष",
    registers_heading: "आपके रजिस्टर",
    index_label: "इंडेक्स {{i}}",
    actions_coming_soon:
      "मिंट, सेंड और स्पेंड फ्लो एक अनुवर्ती अपडेट में आ रहे हैं। फिलहाल, अपने स्टेल्थ वॉलेट को seedelf-cli से प्रबंधित करें।",
  },
  es: {
    eyebrow: "Billetera sigilosa",
    title: "Seedelf",
    lede: "Registros de billetera sigilosa derivados de la misma firma de billetera que desbloquea tu bóveda Lovejoin. Cada registro es una dirección privada en la que puedes recibir ADA; solo tú puedes gastarlo. El mismo protocolo Seedelf en cadena que usas con seedelf-cli.",
    scanning: "Escaneando…",
    rescan: "Volver a escanear",
    scan_failed: "Escaneo de Seedelf falló: {{message}}",
    empty_title: "Aún no hay Seedelf",
    empty_hint:
      "Puedes acuñar tu primer registro sigiloso con seedelf-cli o esperar el flujo de acuñación en la app.",
    registers_label: "Registros",
    funds_label: "UTxO con fondos",
    balance_label: "Saldo total",
    registers_heading: "Tus registros",
    index_label: "índice {{i}}",
    actions_coming_soon:
      "Los flujos de acuñar, enviar y gastar llegarán en una actualización posterior. Por ahora, administra tu billetera sigilosa con seedelf-cli.",
  },
  fr: {
    eyebrow: "Portefeuille furtif",
    title: "Seedelf",
    lede: "Registres de portefeuille furtif dérivés de la même signature de portefeuille qui déverrouille votre coffre Lovejoin. Chaque registre est une adresse privée pour recevoir des ADA ; vous seul pouvez la dépenser. Le même protocole Seedelf on-chain que vous utilisez via seedelf-cli.",
    scanning: "Analyse…",
    rescan: "Relancer l'analyse",
    scan_failed: "Échec de l'analyse Seedelf : {{message}}",
    empty_title: "Pas encore de Seedelf",
    empty_hint:
      "Vous pouvez frapper votre premier registre furtif depuis seedelf-cli ou attendre le flux de frappe dans l'app.",
    registers_label: "Registres",
    funds_label: "UTxO financés",
    balance_label: "Solde total",
    registers_heading: "Vos registres",
    index_label: "index {{i}}",
    actions_coming_soon:
      "Les flux de frappe, d'envoi et de dépense arriveront dans une mise à jour ultérieure. En attendant, gérez votre portefeuille furtif depuis seedelf-cli.",
  },
  ar: {
    eyebrow: "محفظة خفية",
    title: "Seedelf",
    lede: "سجلات محفظة خفية مشتقة من نفس توقيع المحفظة الذي يفتح خزينة Lovejoin. كل سجل هو عنوان خاص يمكنك تلقي ADA عليه؛ أنت وحدك من يمكنه إنفاقه. نفس بروتوكول Seedelf على السلسلة الذي تستخدمه عبر seedelf-cli.",
    scanning: "جارٍ المسح…",
    rescan: "إعادة المسح",
    scan_failed: "فشل مسح Seedelf: {{message}}",
    empty_title: "لا يوجد Seedelf بعد",
    empty_hint: "يمكنك سك أول سجل خفي من seedelf-cli أو انتظار تدفق السك داخل التطبيق.",
    registers_label: "السجلات",
    funds_label: "UTxO الممولة",
    balance_label: "الرصيد الإجمالي",
    registers_heading: "سجلاتك",
    index_label: "الفهرس {{i}}",
    actions_coming_soon:
      "ستصل تدفقات السك والإرسال والإنفاق في تحديث لاحق. في الوقت الحالي، أدر محفظتك الخفية من seedelf-cli.",
  },
  bn: {
    eyebrow: "স্টেলথ ওয়ালেট",
    title: "Seedelf",
    lede: "একই ওয়ালেট স্বাক্ষর থেকে নেওয়া স্টেলথ-ওয়ালেট রেজিস্টার যা আপনার Lovejoin ভল্ট আনলক করে। প্রতিটি রেজিস্টার একটি ব্যক্তিগত ঠিকানা যেখানে আপনি ADA পেতে পারেন; শুধুমাত্র আপনি ব্যয় করতে পারেন। একই অন-চেইন Seedelf প্রোটোকল যা আপনি seedelf-cli দিয়ে ব্যবহার করেন।",
    scanning: "স্ক্যান হচ্ছে…",
    rescan: "পুনরায় স্ক্যান",
    scan_failed: "Seedelf স্ক্যান ব্যর্থ: {{message}}",
    empty_title: "এখনও কোনও Seedelf নেই",
    empty_hint:
      "আপনি seedelf-cli থেকে আপনার প্রথম স্টেলথ রেজিস্টার মিন্ট করতে পারেন বা ইন-অ্যাপ মিন্ট ফ্লোর জন্য অপেক্ষা করতে পারেন।",
    registers_label: "রেজিস্টার",
    funds_label: "তহবিলযুক্ত UTxO",
    balance_label: "মোট ব্যালেন্স",
    registers_heading: "আপনার রেজিস্টার",
    index_label: "ইনডেক্স {{i}}",
    actions_coming_soon:
      "মিন্ট, সেন্ড এবং স্পেন্ড ফ্লো পরবর্তী আপডেটে আসবে। এখন আপনার স্টেলথ ওয়ালেটটি seedelf-cli দিয়ে পরিচালনা করুন।",
  },
  ru: {
    eyebrow: "Невидимый кошелёк",
    title: "Seedelf",
    lede: "Регистры невидимого кошелька, выведенные из той же подписи кошелька, что разблокирует ваше хранилище Lovejoin. Каждый регистр — это приватный адрес для приёма ADA; только вы можете его потратить. Тот же ончейн-протокол Seedelf, который вы используете через seedelf-cli.",
    scanning: "Сканирование…",
    rescan: "Сканировать снова",
    scan_failed: "Сбой сканирования Seedelf: {{message}}",
    empty_title: "Seedelf пока нет",
    empty_hint:
      "Вы можете создать первый невидимый регистр через seedelf-cli или дождаться внутреннего потока создания.",
    registers_label: "Регистры",
    funds_label: "Финансированные UTxO",
    balance_label: "Общий баланс",
    registers_heading: "Ваши регистры",
    index_label: "индекс {{i}}",
    actions_coming_soon:
      "Потоки создания, отправки и расходования появятся в следующем обновлении. Пока управляйте невидимым кошельком через seedelf-cli.",
  },
  pt: {
    eyebrow: "Carteira furtiva",
    title: "Seedelf",
    lede: "Registros de carteira furtiva derivados da mesma assinatura de carteira que destrava seu cofre Lovejoin. Cada registro é um endereço privado para receber ADA; só você pode gastar. O mesmo protocolo Seedelf on-chain que você usa via seedelf-cli.",
    scanning: "Escaneando…",
    rescan: "Reescanear",
    scan_failed: "Falha na varredura Seedelf: {{message}}",
    empty_title: "Ainda não há Seedelf",
    empty_hint:
      "Você pode cunhar seu primeiro registro furtivo no seedelf-cli ou aguardar o fluxo de cunhagem no app.",
    registers_label: "Registros",
    funds_label: "UTxOs com fundos",
    balance_label: "Saldo total",
    registers_heading: "Seus registros",
    index_label: "índice {{i}}",
    actions_coming_soon:
      "Os fluxos de cunhar, enviar e gastar chegarão em uma atualização futura. Por enquanto, gerencie sua carteira furtiva pelo seedelf-cli.",
  },
  ur: {
    eyebrow: "خفیہ والیٹ",
    title: "Seedelf",
    lede: "وہی والیٹ سائن جو آپ کا Lovejoin والٹ کھولتا ہے، اسی سے اخذ کردہ خفیہ والیٹ رجسٹرز۔ ہر رجسٹر ایک نجی پتہ ہے جس پر آپ ADA وصول کر سکتے ہیں؛ صرف آپ خرچ کر سکتے ہیں۔ وہی آن-چین Seedelf پروٹوکول جو آپ seedelf-cli کے ذریعے استعمال کرتے ہیں۔",
    scanning: "اسکین جاری ہے…",
    rescan: "دوبارہ اسکین",
    scan_failed: "Seedelf اسکین ناکام: {{message}}",
    empty_title: "ابھی تک کوئی Seedelf نہیں",
    empty_hint:
      "آپ اپنا پہلا خفیہ رجسٹر seedelf-cli سے بنا سکتے ہیں یا ایپ کے اندر مِنٹ فلو کا انتظار کر سکتے ہیں۔",
    registers_label: "رجسٹرز",
    funds_label: "فنڈڈ UTxOs",
    balance_label: "کل بیلنس",
    registers_heading: "آپ کے رجسٹرز",
    index_label: "انڈیکس {{i}}",
    actions_coming_soon:
      "مِنٹ، سینڈ اور اسپینڈ فلو بعد کی اپڈیٹ میں آئیں گے۔ ابھی اپنا خفیہ والیٹ seedelf-cli سے منظم کریں۔",
  },
  ja: {
    eyebrow: "ステルスウォレット",
    title: "Seedelf",
    lede: "Lovejoin ボールトを解除するのと同じウォレット署名から派生したステルスウォレットのレジスタ。各レジスタは ADA を受け取るためのプライベートアドレスで、使用できるのはあなただけです。seedelf-cli から使うのと同じオンチェーンの Seedelf プロトコルです。",
    scanning: "スキャン中…",
    rescan: "再スキャン",
    scan_failed: "Seedelf のスキャンに失敗しました: {{message}}",
    empty_title: "Seedelf はまだありません",
    empty_hint:
      "最初のステルスレジスタは seedelf-cli から鋳造するか、アプリ内の鋳造フローを待ってください。",
    registers_label: "レジスタ",
    funds_label: "資金付き UTxO",
    balance_label: "総残高",
    registers_heading: "あなたのレジスタ",
    index_label: "インデックス {{i}}",
    actions_coming_soon:
      "鋳造、送信、支払いのフローは次回のアップデートで提供します。当面はステルスウォレットを seedelf-cli から管理してください。",
  },
  ko: {
    eyebrow: "스텔스 지갑",
    title: "Seedelf",
    lede: "Lovejoin 볼트를 잠금 해제하는 것과 동일한 지갑 서명에서 파생된 스텔스 지갑 레지스터. 각 레지스터는 ADA를 받을 수 있는 개인 주소이며, 사용은 본인만 가능합니다. seedelf-cli로 사용하는 것과 동일한 온체인 Seedelf 프로토콜입니다.",
    scanning: "스캔 중…",
    rescan: "다시 스캔",
    scan_failed: "Seedelf 스캔 실패: {{message}}",
    empty_title: "아직 Seedelf 없음",
    empty_hint: "첫 스텔스 레지스터는 seedelf-cli에서 발행하거나 인앱 발행 흐름을 기다리세요.",
    registers_label: "레지스터",
    funds_label: "자금 있는 UTxO",
    balance_label: "총 잔액",
    registers_heading: "당신의 레지스터",
    index_label: "인덱스 {{i}}",
    actions_coming_soon:
      "발행, 전송, 지출 흐름은 후속 업데이트에서 제공됩니다. 지금은 seedelf-cli에서 스텔스 지갑을 관리하세요.",
  },
  tr: {
    eyebrow: "Gizli cüzdan",
    title: "Seedelf",
    lede: "Lovejoin kasanızın kilidini açan aynı cüzdan imzasından türetilen gizli cüzdan kayıtları. Her kayıt, ADA alabileceğiniz özel bir adrestir; yalnızca siz harcayabilirsiniz. seedelf-cli ile kullandığınız aynı zincir üstü Seedelf protokolü.",
    scanning: "Taranıyor…",
    rescan: "Yeniden tara",
    scan_failed: "Seedelf taraması başarısız: {{message}}",
    empty_title: "Henüz Seedelf yok",
    empty_hint:
      "İlk gizli kaydınızı seedelf-cli ile basabilir veya uygulama içi basım akışını bekleyebilirsiniz.",
    registers_label: "Kayıtlar",
    funds_label: "Bakiyeli UTxO'lar",
    balance_label: "Toplam bakiye",
    registers_heading: "Kayıtlarınız",
    index_label: "indeks {{i}}",
    actions_coming_soon:
      "Basma, gönderme ve harcama akışları sonraki bir güncellemede gelecek. Şimdilik gizli cüzdanınızı seedelf-cli ile yönetin.",
  },
  vi: {
    eyebrow: "Ví ẩn danh",
    title: "Seedelf",
    lede: "Các register ví ẩn danh dẫn xuất từ cùng chữ ký ví mở khóa vault Lovejoin của bạn. Mỗi register là một địa chỉ riêng để nhận ADA; chỉ bạn mới có thể tiêu. Cùng giao thức Seedelf on-chain mà bạn dùng qua seedelf-cli.",
    scanning: "Đang quét…",
    rescan: "Quét lại",
    scan_failed: "Quét Seedelf thất bại: {{message}}",
    empty_title: "Chưa có Seedelf",
    empty_hint:
      "Bạn có thể mint register ẩn danh đầu tiên từ seedelf-cli hoặc đợi luồng mint trong ứng dụng.",
    registers_label: "Register",
    funds_label: "UTxO đã nạp",
    balance_label: "Tổng số dư",
    registers_heading: "Các register của bạn",
    index_label: "chỉ số {{i}}",
    actions_coming_soon:
      "Các luồng mint, gửi và chi sẽ ra mắt trong bản cập nhật sau. Hiện tại hãy quản lý ví ẩn danh bằng seedelf-cli.",
  },
  id: {
    eyebrow: "Dompet siluman",
    title: "Seedelf",
    lede: "Register dompet siluman yang diturunkan dari tanda tangan dompet yang sama yang membuka vault Lovejoin Anda. Setiap register adalah alamat pribadi untuk menerima ADA; hanya Anda yang dapat membelanjakannya. Protokol Seedelf on-chain yang sama yang Anda gunakan melalui seedelf-cli.",
    scanning: "Memindai…",
    rescan: "Pindai ulang",
    scan_failed: "Pemindaian Seedelf gagal: {{message}}",
    empty_title: "Belum ada Seedelf",
    empty_hint:
      "Anda dapat mencetak register siluman pertama dari seedelf-cli atau menunggu alur cetak dalam aplikasi.",
    registers_label: "Register",
    funds_label: "UTxO yang didanai",
    balance_label: "Saldo total",
    registers_heading: "Register Anda",
    index_label: "indeks {{i}}",
    actions_coming_soon:
      "Alur cetak, kirim, dan belanja hadir di pembaruan berikutnya. Untuk saat ini, kelola dompet siluman Anda dari seedelf-cli.",
  },
  de: {
    eyebrow: "Stealth-Wallet",
    title: "Seedelf",
    lede: "Stealth-Wallet-Register, abgeleitet aus derselben Wallet-Signatur, die Ihre Lovejoin-Vault entsperrt. Jedes Register ist eine private Adresse, an die Sie ADA empfangen können; nur Sie können sie ausgeben. Dasselbe On-Chain-Seedelf-Protokoll, das Sie über seedelf-cli verwenden.",
    scanning: "Scannen…",
    rescan: "Neu scannen",
    scan_failed: "Seedelf-Scan fehlgeschlagen: {{message}}",
    empty_title: "Noch kein Seedelf",
    empty_hint:
      "Sie können Ihr erstes Stealth-Register über seedelf-cli prägen oder auf den In-App-Mint-Flow warten.",
    registers_label: "Register",
    funds_label: "Finanzierte UTxOs",
    balance_label: "Gesamtguthaben",
    registers_heading: "Ihre Register",
    index_label: "Index {{i}}",
    actions_coming_soon:
      "Mint-, Send- und Spend-Flows kommen in einem nachfolgenden Update. Verwalten Sie Ihre Stealth-Wallet vorerst über seedelf-cli.",
  },
  pl: {
    eyebrow: "Ukryty portfel",
    title: "Seedelf",
    lede: "Rejestry ukrytego portfela wyprowadzone z tego samego podpisu portfela, który odblokowuje twój sejf Lovejoin. Każdy rejestr to prywatny adres do odbioru ADA; tylko ty możesz wydać. Ten sam protokół Seedelf on-chain, którego używasz przez seedelf-cli.",
    scanning: "Skanowanie…",
    rescan: "Skanuj ponownie",
    scan_failed: "Skanowanie Seedelf nie powiodło się: {{message}}",
    empty_title: "Brak Seedelfów",
    empty_hint:
      "Pierwszy rejestr ukryty możesz wykuć przez seedelf-cli lub poczekać na proces wykuwania w aplikacji.",
    registers_label: "Rejestry",
    funds_label: "Zasilone UTxO",
    balance_label: "Łączne saldo",
    registers_heading: "Twoje rejestry",
    index_label: "indeks {{i}}",
    balance_ada: "{{amount}} ADA",
    actions_coming_soon:
      "Procesy wykuwania, wysyłania i wydawania pojawią się w kolejnej aktualizacji. Na razie zarządzaj ukrytym portfelem przez seedelf-cli.",
  },
  it: {
    eyebrow: "Portafoglio stealth",
    title: "Seedelf",
    lede: "Registri di portafoglio stealth derivati dalla stessa firma del wallet che sblocca il tuo caveau Lovejoin. Ogni registro è un indirizzo privato per ricevere ADA; solo tu puoi spenderlo. Lo stesso protocollo Seedelf on-chain che usi tramite seedelf-cli.",
    scanning: "Scansione…",
    rescan: "Riscansiona",
    scan_failed: "Scansione Seedelf fallita: {{message}}",
    empty_title: "Ancora nessun Seedelf",
    empty_hint:
      "Puoi coniare il tuo primo registro stealth da seedelf-cli o attendere il flusso di conio in-app.",
    registers_label: "Registri",
    funds_label: "UTxO con fondi",
    balance_label: "Saldo totale",
    registers_heading: "I tuoi registri",
    index_label: "indice {{i}}",
    actions_coming_soon:
      "I flussi di conio, invio e spesa arriveranno in un aggiornamento successivo. Per ora, gestisci il portafoglio stealth da seedelf-cli.",
  },
  fa: {
    eyebrow: "کیف پول مخفی",
    title: "Seedelf",
    lede: "ثبت‌های کیف پول مخفی که از همان امضای کیف پولی که قفل صندوق Lovejoin شما را باز می‌کند مشتق شده‌اند. هر ثبت یک آدرس خصوصی برای دریافت ADA است؛ فقط شما می‌توانید خرج کنید. همان پروتکل آن‌چین Seedelf که از طریق seedelf-cli استفاده می‌کنید.",
    scanning: "در حال اسکن…",
    rescan: "اسکن مجدد",
    scan_failed: "اسکن Seedelf ناموفق بود: {{message}}",
    empty_title: "هنوز Seedelf ندارید",
    empty_hint:
      "می‌توانید اولین ثبت مخفی خود را از seedelf-cli ضرب کنید یا منتظر جریان ضرب درون برنامه‌ای بمانید.",
    registers_label: "ثبت‌ها",
    funds_label: "UTxO های دارای موجودی",
    balance_label: "مانده کل",
    registers_heading: "ثبت‌های شما",
    index_label: "اندیس {{i}}",
    actions_coming_soon:
      "جریان‌های ضرب، ارسال و خرج در به‌روزرسانی بعدی منتشر می‌شوند. در حال حاضر کیف پول مخفی خود را با seedelf-cli مدیریت کنید.",
  },
  th: {
    eyebrow: "กระเป๋าล่องหน",
    title: "Seedelf",
    lede: "รีจิสเตอร์กระเป๋าล่องหนที่ได้จากลายเซ็นกระเป๋าเดียวกันกับที่ปลดล็อกห้องเก็บ Lovejoin ของคุณ แต่ละรีจิสเตอร์เป็นที่อยู่ส่วนตัวสำหรับรับ ADA; เฉพาะคุณเท่านั้นที่ใช้จ่ายได้ โปรโตคอล Seedelf บนเชนเดียวกับที่คุณใช้ผ่าน seedelf-cli",
    scanning: "กำลังสแกน…",
    rescan: "สแกนอีกครั้ง",
    scan_failed: "สแกน Seedelf ล้มเหลว: {{message}}",
    empty_title: "ยังไม่มี Seedelf",
    empty_hint: "คุณสามารถสร้างรีจิสเตอร์ล่องหนแรกจาก seedelf-cli หรือรอขั้นตอนสร้างในแอป",
    registers_label: "รีจิสเตอร์",
    funds_label: "UTxO ที่มีเงิน",
    balance_label: "ยอดรวม",
    registers_heading: "รีจิสเตอร์ของคุณ",
    index_label: "ดัชนี {{i}}",
    actions_coming_soon:
      "ขั้นตอนสร้าง ส่ง และใช้จ่ายจะมาในอัปเดตถัดไป ขณะนี้ให้จัดการกระเป๋าล่องหนผ่าน seedelf-cli",
  },
};

const SUPPORTED = Object.keys(TRANSLATIONS);

// "ADA" is the canonical ticker; keep verbatim across every locale.
const COMMON = {
  balance_ada: "{{amount}} ADA",
};

async function patchOne(code) {
  const path = `${LOCALES_DIR}/${code}.json`;
  const raw = await readFile(path, "utf8");
  const data = JSON.parse(raw);
  data.vault = data.vault ?? {};
  data.vault.seedelf = { ...TRANSLATIONS[code], ...COMMON };
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  for (const code of SUPPORTED) {
    await patchOne(code);
    process.stdout.write(`  updated ${code}.json\n`);
  }
}

await main();
