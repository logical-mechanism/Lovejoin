#!/usr/bin/env node
// One-off translator for the unified-MixPanel intensity dial + the
// Vault page's fan-out entry-point card (issue #137 / PR #146). Patches
// each non-EN locale file with the new keys below; English remains
// canonical in `en.json` and is skipped.
//
// Run from ui/ with: node scripts/translate-mix-intensity.mjs
//
// Translation conventions (same as translate-fanout.mjs):
//   • {{var}} placeholders preserved verbatim.
//   • Protocol terms (Mix, ADA, fee shard, fan-out) preserved in their
//     canonical form or transliterated locally.
//   • Arithmetic notation `(1/3)^{{k}}` and `1/3` stays as-is.
//   • CJK / Arabic / Persian / Indic translations were drafted with
//     limited native-speaker input; happy to review with native input.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCALES_DIR = resolve(__dirname, "..", "src", "i18n", "locales");

const TRANSLATIONS = {
  es: {
    pool: {
      intensity_eyebrow: "Intensidad",
      intensity_option_single: "Sencillo",
      intensity_option_fanout: "Profundidad {{k}}",
      intensity_hint_single:
        "Una tx de Mix al pool compartido. Probabilidad de enlace 1/3 por ronda; la tx mantiene anonimato de billetera en modo fee shard.",
      intensity_hint_fanout:
        "Abanico de profundidad {{k}}: {{mixes}} txs de Mix en total, partiendo de una de tus cajas. Probabilidad de enlace (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "La bóveda está bloqueada. La profundidad ≥ 2 necesita una caja propia para enraizar el árbol; desbloquea la bóveda primero.",
    },
    vault: {
      fanout_entry_eyebrow: "Refuerzo de privacidad",
      fanout_entry_title: "Ejecutar mezcla en abanico",
      fanout_entry_lede:
        "Encadena varias txs de Mix en un árbol partiendo de una de tus cajas. Tu rama acaba siendo indistinguible de otras 9 o más.",
      fanout_entry_cta: "Ejecutar abanico",
    },
  },
  fr: {
    pool: {
      intensity_eyebrow: "Intensité",
      intensity_option_single: "Simple",
      intensity_option_fanout: "Profondeur {{k}}",
      intensity_hint_single:
        "Une tx de Mix vers le pool partagé. Probabilité de liaison 1/3 par tour ; la tx reste anonyme côté wallet en mode fee shard.",
      intensity_hint_fanout:
        "Éventail de profondeur {{k}} : {{mixes}} txs de Mix au total, à partir d'une de vos boxes. Probabilité de liaison (1/3)^{{k}} ≈ {{percent}} %.",
      vault_locked_at_depth:
        "Le coffre est verrouillé. La profondeur ≥ 2 a besoin d'une box que vous possédez pour enraciner l'arbre ; déverrouillez d'abord le coffre.",
    },
    vault: {
      fanout_entry_eyebrow: "Renforcement de confidentialité",
      fanout_entry_title: "Lancer un mix en éventail",
      fanout_entry_lede:
        "Enchaînez plusieurs txs de Mix en un arbre à partir d'une de vos boxes. Votre branche devient indistinguable parmi 9 autres ou plus.",
      fanout_entry_cta: "Lancer l'éventail",
    },
  },
  de: {
    pool: {
      intensity_eyebrow: "Intensität",
      intensity_option_single: "Einzeln",
      intensity_option_fanout: "Tiefe {{k}}",
      intensity_hint_single:
        "Eine Mix-tx in den gemeinsamen Pool. Verknüpfungswahrscheinlichkeit 1/3 pro Runde; im Fee-Shard-Modus bleibt die Wallet außerhalb der tx.",
      intensity_hint_fanout:
        "Fan-out der Tiefe {{k}}: insgesamt {{mixes}} Mix-txs, ausgehend von einer deiner Boxes. Verknüpfung (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "Der Vault ist gesperrt. Tiefe ≥ 2 braucht eine eigene Box als Wurzel des Baumes; entsperre zuerst den Vault.",
    },
    vault: {
      fanout_entry_eyebrow: "Privatsphären-Boost",
      fanout_entry_title: "Fan-out-Mix starten",
      fanout_entry_lede:
        "Verkettet mehrere Mix-txs zu einem Baum ausgehend von einer deiner Boxes. Dein Zweig wird ununterscheidbar von 9 oder mehr anderen.",
      fanout_entry_cta: "Fan-out starten",
    },
  },
  pt: {
    pool: {
      intensity_eyebrow: "Intensidade",
      intensity_option_single: "Único",
      intensity_option_fanout: "Profundidade {{k}}",
      intensity_hint_single:
        "Uma tx de Mix no pool partilhado. Probabilidade de ligação 1/3 por ronda; a tx mantém anonimato da carteira no modo fee shard.",
      intensity_hint_fanout:
        "Leque de profundidade {{k}}: {{mixes}} txs de Mix no total, a partir de uma das tuas caixas. Probabilidade de ligação (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "O cofre está bloqueado. A profundidade ≥ 2 precisa de uma caixa tua para raiz da árvore; desbloqueia primeiro o cofre.",
    },
    vault: {
      fanout_entry_eyebrow: "Reforço de privacidade",
      fanout_entry_title: "Executar mix em leque",
      fanout_entry_lede:
        "Encadeia várias txs de Mix numa árvore a partir de uma das tuas caixas. O teu ramo fica indistinguível entre 9 ou mais.",
      fanout_entry_cta: "Executar leque",
    },
  },
  it: {
    pool: {
      intensity_eyebrow: "Intensità",
      intensity_option_single: "Singolo",
      intensity_option_fanout: "Profondità {{k}}",
      intensity_hint_single:
        "Una tx di Mix nel pool condiviso. Probabilità di collegamento 1/3 per round; in modalità fee shard la tx resta anonima rispetto al wallet.",
      intensity_hint_fanout:
        "Ventaglio di profondità {{k}}: {{mixes}} tx di Mix in totale, partendo da una delle tue box. Probabilità di collegamento (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "Il vault è bloccato. La profondità ≥ 2 richiede una box di tua proprietà per radicare l'albero; sblocca prima il vault.",
    },
    vault: {
      fanout_entry_eyebrow: "Boost di privacy",
      fanout_entry_title: "Avvia mix a ventaglio",
      fanout_entry_lede:
        "Concatena diverse tx di Mix in un albero partendo da una delle tue box. Il tuo ramo diventa indistinguibile tra 9 o più altri.",
      fanout_entry_cta: "Avvia ventaglio",
    },
  },
  pl: {
    pool: {
      intensity_eyebrow: "Intensywność",
      intensity_option_single: "Pojedynczy",
      intensity_option_fanout: "Głębokość {{k}}",
      intensity_hint_single:
        "Pojedyncza tx Mix do wspólnej puli. Prawdopodobieństwo powiązania 1/3 na rundę; tx pozostaje anonimowa względem portfela w trybie fee shard.",
      intensity_hint_fanout:
        "Rozgałęzienie głębokości {{k}}: łącznie {{mixes}} tx Mix, startując od jednej z twoich box. Prawdopodobieństwo powiązania (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "Skarbiec jest zablokowany. Głębokość ≥ 2 wymaga własnej box jako korzenia drzewa; najpierw odblokuj skarbiec.",
    },
    vault: {
      fanout_entry_eyebrow: "Wzmocnienie prywatności",
      fanout_entry_title: "Uruchom mix rozgałęziony",
      fanout_entry_lede:
        "Łączy kilka tx Mix w drzewo startujące od jednej z twoich box. Twoja gałąź staje się nierozróżnialna spośród 9 lub więcej.",
      fanout_entry_cta: "Uruchom rozgałęzienie",
    },
  },
  tr: {
    pool: {
      intensity_eyebrow: "Yoğunluk",
      intensity_option_single: "Tekli",
      intensity_option_fanout: "Derinlik {{k}}",
      intensity_hint_single:
        "Paylaşılan havuza tek bir Mix tx'i. Tur başına bağlanma olasılığı 1/3; fee shard modunda tx cüzdan kimliği taşımaz.",
      intensity_hint_fanout:
        "{{k}} derinliğinde yelpaze: toplam {{mixes}} Mix tx, kendi box'larından biriyle başlar. Bağlanma olasılığı (1/3)^{{k}} ≈ %{{percent}}.",
      vault_locked_at_depth:
        "Vault kilitli. ≥ 2 derinlik için ağacın kökü olarak senin olan bir box gerekir; önce vault'u aç.",
    },
    vault: {
      fanout_entry_eyebrow: "Gizlilik takviyesi",
      fanout_entry_title: "Yelpaze karışım başlat",
      fanout_entry_lede:
        "Kendi box'larından birinden başlayan bir ağaçta birkaç Mix tx'ini zincirler. Kolun 9 veya daha fazlasından ayırt edilemez hale gelir.",
      fanout_entry_cta: "Yelpaze çalıştır",
    },
  },
  vi: {
    pool: {
      intensity_eyebrow: "Cường độ",
      intensity_option_single: "Đơn",
      intensity_option_fanout: "Độ sâu {{k}}",
      intensity_hint_single:
        "Một tx Mix vào pool dùng chung. Xác suất liên kết 1/3 mỗi vòng; ở chế độ fee shard, tx giữ ẩn danh ví.",
      intensity_hint_fanout:
        "Trộn theo cây độ sâu {{k}}: tổng {{mixes}} tx Mix, bắt đầu từ một box của bạn. Xác suất liên kết (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "Vault đang khoá. Độ sâu ≥ 2 cần một box của bạn để làm gốc cây; hãy mở khoá vault trước.",
    },
    vault: {
      fanout_entry_eyebrow: "Tăng cường riêng tư",
      fanout_entry_title: "Chạy trộn theo cây",
      fanout_entry_lede:
        "Liên kết nhiều tx Mix thành một cây bắt đầu từ một box của bạn. Nhánh của bạn trở nên không thể phân biệt giữa 9+ nhánh khác.",
      fanout_entry_cta: "Chạy trộn theo cây",
    },
  },
  id: {
    pool: {
      intensity_eyebrow: "Intensitas",
      intensity_option_single: "Tunggal",
      intensity_option_fanout: "Kedalaman {{k}}",
      intensity_hint_single:
        "Satu tx Mix ke pool bersama. Probabilitas keterhubungan 1/3 per ronde; di mode fee shard tx tetap anonim terhadap wallet.",
      intensity_hint_fanout:
        "Fan-out kedalaman {{k}}: total {{mixes}} tx Mix, dimulai dari salah satu box milikmu. Probabilitas keterhubungan (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "Vault terkunci. Kedalaman ≥ 2 perlu satu box milikmu untuk menjadi akar pohon; buka vault terlebih dahulu.",
    },
    vault: {
      fanout_entry_eyebrow: "Penguat privasi",
      fanout_entry_title: "Jalankan mix berbentuk kipas",
      fanout_entry_lede:
        "Merangkai beberapa tx Mix menjadi pohon yang dimulai dari salah satu box milikmu. Cabangmu menjadi tidak terbedakan di antara 9+ cabang lain.",
      fanout_entry_cta: "Jalankan kipas",
    },
  },
  ru: {
    pool: {
      intensity_eyebrow: "Интенсивность",
      intensity_option_single: "Одна",
      intensity_option_fanout: "Глубина {{k}}",
      intensity_hint_single:
        "Одна tx Mix в общий пул. Вероятность связки 1/3 за раунд; в режиме fee shard tx остаётся анонимной по отношению к кошельку.",
      intensity_hint_fanout:
        "Веер глубины {{k}}: всего {{mixes}} tx Mix, начиная с одной из ваших box. Вероятность связки (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "Vault заблокирован. Глубине ≥ 2 нужна ваша box как корень дерева; сначала разблокируйте vault.",
    },
    vault: {
      fanout_entry_eyebrow: "Усиление приватности",
      fanout_entry_title: "Запустить веерное смешивание",
      fanout_entry_lede:
        "Сцепляет несколько tx Mix в дерево, начиная с одной из ваших box. Ваша ветка становится неотличимой среди 9+ других.",
      fanout_entry_cta: "Запустить веер",
    },
  },
  zh: {
    pool: {
      intensity_eyebrow: "强度",
      intensity_option_single: "单次",
      intensity_option_fanout: "深度 {{k}}",
      intensity_hint_single:
        "向共享池发送一笔 Mix tx。每轮的关联概率为 1/3；在 fee shard 模式下 tx 不带钱包身份。",
      intensity_hint_fanout:
        "深度 {{k}} 扇出：共 {{mixes}} 笔 Mix tx，从你的一个 box 出发。完成后的关联概率为 (1/3)^{{k}} ≈ {{percent}}%。",
      vault_locked_at_depth: "vault 已锁定。深度 ≥ 2 需要你拥有的 box 作为树的根；请先解锁 vault。",
    },
    vault: {
      fanout_entry_eyebrow: "隐私增强",
      fanout_entry_title: "启动扇出混合",
      fanout_entry_lede:
        "把多笔 Mix tx 串成一棵从你拥有的 box 出发的树。你的分支最终在 9 个及以上分支中不可区分。",
      fanout_entry_cta: "启动扇出",
    },
  },
  ja: {
    pool: {
      intensity_eyebrow: "強度",
      intensity_option_single: "単発",
      intensity_option_fanout: "深さ {{k}}",
      intensity_hint_single:
        "共有プールへの単一の Mix tx。ラウンドあたりのリンク確率は 1/3。fee shard モードでは tx はウォレット匿名のままです。",
      intensity_hint_fanout:
        "深さ {{k}} のファンアウト：合計 {{mixes}} 件の Mix tx、あなたの box の 1 つから出発します。リンク確率 (1/3)^{{k}} ≈ {{percent}}%。",
      vault_locked_at_depth:
        "vault がロックされています。深さ ≥ 2 はあなたの box をツリーの根として必要とします。まず vault をアンロックしてください。",
    },
    vault: {
      fanout_entry_eyebrow: "プライバシー強化",
      fanout_entry_title: "ファンアウト・ミックスを実行",
      fanout_entry_lede:
        "あなたの box の 1 つから始まるツリーに、複数の Mix tx をチェーンします。あなたの枝は 9 本以上の中で見分けがつかなくなります。",
      fanout_entry_cta: "ファンアウトを実行",
    },
  },
  ko: {
    pool: {
      intensity_eyebrow: "강도",
      intensity_option_single: "단일",
      intensity_option_fanout: "깊이 {{k}}",
      intensity_hint_single:
        "공유 풀로 한 번의 Mix tx. 라운드당 연결 확률 1/3; fee shard 모드에서는 tx가 지갑 익명을 유지합니다.",
      intensity_hint_fanout:
        "깊이 {{k}} 팬아웃: 총 {{mixes}}건의 Mix tx, 내 box 중 하나에서 시작합니다. 연결 확률 (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "vault가 잠겨 있습니다. 깊이 ≥ 2는 트리의 루트로 사용할 본인 box가 필요합니다. 먼저 vault를 잠금 해제하세요.",
    },
    vault: {
      fanout_entry_eyebrow: "프라이버시 부스트",
      fanout_entry_title: "팬아웃 믹스 실행",
      fanout_entry_lede:
        "본인 box 중 하나에서 시작하는 트리로 여러 Mix tx를 연결합니다. 본인 분기가 9개 이상의 다른 분기와 구분되지 않습니다.",
      fanout_entry_cta: "팬아웃 실행",
    },
  },
  hi: {
    pool: {
      intensity_eyebrow: "तीव्रता",
      intensity_option_single: "एकल",
      intensity_option_fanout: "गहराई {{k}}",
      intensity_hint_single:
        "साझा pool में एक Mix tx। प्रति राउंड लिंकेज प्रायिकता 1/3; fee shard mode में tx wallet-anonymous रहती है।",
      intensity_hint_fanout:
        "गहराई {{k}} फैन-आउट: कुल {{mixes}} Mix tx, आपकी एक box से शुरू। पूरा होने के बाद लिंकेज प्रायिकता (1/3)^{{k}} ≈ {{percent}}%।",
      vault_locked_at_depth:
        "vault लॉक है। गहराई ≥ 2 के लिए पेड़ की जड़ हेतु आपकी अपनी box चाहिए; पहले vault अनलॉक करें।",
    },
    vault: {
      fanout_entry_eyebrow: "गोपनीयता बूस्ट",
      fanout_entry_title: "फैन-आउट मिक्स चलाएँ",
      fanout_entry_lede:
        "अपनी एक box से शुरू होकर कई Mix tx को एक पेड़ में जोड़ता है। आपकी शाखा 9 या उससे अधिक के बीच पहचानने योग्य नहीं रहती।",
      fanout_entry_cta: "फैन-आउट चलाएँ",
    },
  },
  bn: {
    pool: {
      intensity_eyebrow: "তীব্রতা",
      intensity_option_single: "একক",
      intensity_option_fanout: "গভীরতা {{k}}",
      intensity_hint_single:
        "শেয়ার করা pool-এ একটি Mix tx। প্রতি রাউন্ডে লিঙ্কেজ সম্ভাবনা 1/3; fee shard mode-এ tx wallet-anonymous থাকে।",
      intensity_hint_fanout:
        "গভীরতা {{k}} ফ্যান-আউট: মোট {{mixes}} Mix tx, আপনার একটি box থেকে শুরু। চলার পর লিঙ্কেজ সম্ভাবনা (1/3)^{{k}} ≈ {{percent}}%।",
      vault_locked_at_depth:
        "vault লকড। গভীরতা ≥ 2-এর জন্য গাছের মূল হিসাবে আপনার নিজস্ব একটি box লাগবে; আগে vault আনলক করুন।",
    },
    vault: {
      fanout_entry_eyebrow: "গোপনীয়তা বুস্ট",
      fanout_entry_title: "ফ্যান-আউট মিক্স চালান",
      fanout_entry_lede:
        "আপনার একটি box থেকে শুরু করে একাধিক Mix tx-কে একটি গাছে গাঁথে। আপনার শাখা ৯+ অন্যান্যের মধ্যে অভেদ্য হয়ে ওঠে।",
      fanout_entry_cta: "ফ্যান-আউট চালান",
    },
  },
  th: {
    pool: {
      intensity_eyebrow: "ความเข้ม",
      intensity_option_single: "ครั้งเดียว",
      intensity_option_fanout: "ความลึก {{k}}",
      intensity_hint_single:
        "Mix tx เดียวเข้าสู่ pool รวม. ความน่าจะเป็นการเชื่อมโยง 1/3 ต่อรอบ; ในโหมด fee shard tx ยังคงไม่ระบุ wallet.",
      intensity_hint_fanout:
        "Fan-out ความลึก {{k}}: ทั้งหมด {{mixes}} Mix tx เริ่มจาก box หนึ่งของคุณ. ความน่าจะเป็นการเชื่อมโยง (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "vault ถูกล็อก. ความลึก ≥ 2 ต้องใช้ box ของคุณเป็นรากของต้นไม้; กรุณาปลดล็อก vault ก่อน.",
    },
    vault: {
      fanout_entry_eyebrow: "เพิ่มความเป็นส่วนตัว",
      fanout_entry_title: "เริ่ม Mix แบบกระจาย",
      fanout_entry_lede:
        "เชื่อม Mix tx หลายรายการเป็นต้นไม้โดยเริ่มจาก box ของคุณ. สาขาของคุณจะกลายเป็นที่ไม่สามารถแยกออกจากอีก 9 สาขาขึ้นไป.",
      fanout_entry_cta: "เริ่มแบบกระจาย",
    },
  },
  ar: {
    pool: {
      intensity_eyebrow: "الشدة",
      intensity_option_single: "مرة واحدة",
      intensity_option_fanout: "العمق {{k}}",
      intensity_hint_single:
        "معاملة Mix واحدة إلى pool المشترك. احتمال الربط 1/3 في كل جولة؛ في وضع fee shard تبقى المعاملة مجهولة بالنسبة للمحفظة.",
      intensity_hint_fanout:
        "تشعب بعمق {{k}}: ما مجموعه {{mixes}} معاملة Mix، تبدأ من إحدى box الخاصة بك. احتمال الربط (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "الخزنة (vault) مقفلة. يحتاج العمق ≥ 2 إلى box تملكها لجذر الشجرة؛ افتح الخزنة أولاً.",
    },
    vault: {
      fanout_entry_eyebrow: "تعزيز الخصوصية",
      fanout_entry_title: "تشغيل تشعب الـ Mix",
      fanout_entry_lede:
        "يربط عدة معاملات Mix في شجرة تبدأ من إحدى box الخاصة بك. يصبح فرعك غير قابل للتمييز بين 9 فروع أو أكثر.",
      fanout_entry_cta: "تشغيل التشعب",
    },
  },
  fa: {
    pool: {
      intensity_eyebrow: "شدت",
      intensity_option_single: "تک‌تایی",
      intensity_option_fanout: "عمق {{k}}",
      intensity_hint_single:
        "یک تراکنش Mix به pool مشترک. احتمال پیوند 1/3 در هر دور؛ در حالت fee shard، تراکنش نسبت به کیف‌پول ناشناس می‌ماند.",
      intensity_hint_fanout:
        "فن‌اوت با عمق {{k}}: در مجموع {{mixes}} تراکنش Mix که از یکی از box‌های شما شروع می‌شود. احتمال پیوند (1/3)^{{k}} ≈ {{percent}}%.",
      vault_locked_at_depth:
        "vault قفل است. عمق ≥ 2 برای ریشهٔ درخت به یک box متعلق به شما نیاز دارد؛ ابتدا vault را باز کنید.",
    },
    vault: {
      fanout_entry_eyebrow: "تقویت حریم خصوصی",
      fanout_entry_title: "اجرای فن‌اوت Mix",
      fanout_entry_lede:
        "چند تراکنش Mix را در درختی به‌هم زنجیر می‌کند که از یکی از box‌های شما آغاز می‌شود. شاخهٔ شما در میان ۹ شاخه یا بیشتر غیرقابل تمایز می‌گردد.",
      fanout_entry_cta: "اجرای فن‌اوت",
    },
  },
  ur: {
    pool: {
      intensity_eyebrow: "شدت",
      intensity_option_single: "واحد",
      intensity_option_fanout: "گہرائی {{k}}",
      intensity_hint_single:
        "مشترکہ pool میں ایک Mix tx۔ ہر راؤنڈ میں ربط کا امکان 1/3؛ fee shard موڈ میں tx wallet کے لحاظ سے گمنام رہتی ہے۔",
      intensity_hint_fanout:
        "گہرائی {{k}} کا fan-out: کل {{mixes}} Mix tx، آپ کے کسی box سے شروع۔ مکمل ہونے پر ربط کا امکان (1/3)^{{k}} ≈ {{percent}}%۔",
      vault_locked_at_depth:
        "vault لاک ہے۔ گہرائی ≥ 2 کو درخت کی جڑ کے لیے آپ کا اپنا box درکار ہے؛ پہلے vault کھولیں۔",
    },
    vault: {
      fanout_entry_eyebrow: "رازداری کا فروغ",
      fanout_entry_title: "فین آؤٹ مکس چلائیں",
      fanout_entry_lede:
        "آپ کے کسی box سے شروع ہو کر کئی Mix tx کو ایک درخت میں جوڑتا ہے۔ آپ کی شاخ ۹ یا زائد شاخوں کے درمیان ناقابلِ تفریق ہو جاتی ہے۔",
      fanout_entry_cta: "فین آؤٹ چلائیں",
    },
  },
};

const LOCALES = Object.keys(TRANSLATIONS);

async function main() {
  for (const locale of LOCALES) {
    const path = resolve(LOCALES_DIR, `${locale}.json`);
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    const patch = TRANSLATIONS[locale];
    data.pool = { ...(data.pool ?? {}), ...patch.pool };
    data.vault = { ...(data.vault ?? {}), ...patch.vault };
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(`patched ${locale}.json`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
