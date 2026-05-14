#!/usr/bin/env node
// One-off translator for the issue #137 `fanout.*` keys. Patches each
// non-EN locale's JSON file with the keys below. English remains the
// canonical source (`en.json`); this script just keeps the rest of the
// 19 supported locales in sync so users don't see English fallbacks
// for the fan-out panel.
//
// Run from ui/ with: node scripts/translate-fanout.mjs
//
// Translation conventions (same as translate-i18n.mjs):
//   * {{var}} placeholders preserved verbatim.
//   * Protocol terms (Mix, Lovejoin, ADA, mix-box, fee shard) preserved
//     in their canonical form or transliterated locally.
//   * The arithmetic notation `(1/3)^{{d}}` stays as-is — it's universal.
//   * The CJK / Arabic / Persian / Indic translations were drafted with
//     limited native-speaker input and would benefit from review.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCALES_DIR = resolve(__dirname, "..", "src", "i18n", "locales");

// English values, kept for diffing only. NOT applied to en.json (which
// is the canonical source). The merger ignores any "en" entry.
const FANOUT = {
  es: {
    eyebrow: "Refuerzo de privacidad",
    section_title: "Mezcla en abanico",
    lede: "Encadena varias txs de Mix en un árbol de profundidad k que parte de una de tus cajas. Tras cada onda, cada caja que tocaste se re-mezcla con dos cajas frescas del pool. Tu rama queda como una de 3^k ramas indistinguibles, con probabilidad de enlace (1/3)^k.",
    depth_label: "Profundidad",
    depth_option: "k = {{d}}",
    depth_hint:
      "Profundidad {{d}} mezcla tu rama en 3^{{d}} ramas indistinguibles. Probabilidad de enlace tras la ejecución: {{percent}}%.",
    review_title: "Previsión del plan",
    review_total_mixes: "Mezclas totales",
    review_boxes_touched: "Cajas tocadas",
    review_linkage: "Probabilidad de enlace",
    review_linkage_value: "(1/3)^{{d}} tras la ejecución",
    review_total_fee: "Comisión total en el peor caso",
    review_total_fee_value: "Hasta {{ada}} ADA en todas las mezclas",
    review_pool: "Extracción del pool",
    review_pool_value: "{{have}} cajas frescas disponibles, {{need}} necesarias",
    disclosure_title: "Estás pagando por todos los del árbol",
    disclosure_body:
      "Re-mezclar solo tu propia caja dejaría que un observador siguiera tu cadena trivialmente. El abanico re-mezcla cada caja que tu onda anterior tocó, incluidas cajas que no son tuyas. Eso es lo que vuelve indistinguible tu rama. Pagas las comisiones y el coste de construcción de pruebas de todo el árbol.",
    gate_no_owned_boxes:
      "Desbloquea tu bóveda y deposita al menos una caja para ejecutar un abanico desde una caja tuya.",
    gate_pool_too_small:
      "Pool demasiado pequeño: {{have}} cajas frescas disponibles; este abanico necesita {{need}}.",
    run_button: "Ejecutar abanico de profundidad {{d}}",
    running: "Ejecutando abanico de profundidad {{d}}…",
    cancel_button: "Dejar de rastrear",
    confirm_eyebrow: "Verificación final",
    confirm_title: "Confirmar envío del abanico",
    confirm_lede:
      "Lovejoin enviará {{count}} txs de Mix tocando {{boxes}} mix-boxes en total, con una comisión en el peor caso de hasta {{ada}} ADA. Cada tx es anónima para la billetera en modo shard; el servicio de colateral firma cada tx.",
    confirm_submit: "Confirmar y enviar",
    progress_title: "Progreso del abanico",
    progress_summary:
      "{{done}} de {{total}} mezclas procesadas · {{submitted}} enviadas · {{failed}} descartadas",
    progress_current_wave: "Actualmente en la onda {{wave}}",
    progress_dropped: "{{count}} mezcla(s) descartada(s) porque su tx padre falló",
    toast_success: "Abanico completo — {{count}} mezcla(s) enviada(s)",
    toast_partial: "Abanico terminado con errores — {{submitted}} enviadas, {{failed}} descartadas",
    toast_failed: "Abanico fallido",
    gate_owned_in_flight:
      "Todas las cajas propias siguen en vuelo de una tx anterior. Espera al próximo bloque e inténtalo de nuevo.",
  },
  fr: {
    eyebrow: "Renforcement de confidentialité",
    section_title: "Mix en éventail",
    lede: "Enchaînez plusieurs txs de Mix en un arbre de profondeur k partant d'une de vos boxes. Après chaque vague, chaque box que vous avez touchée est re-mixée avec deux boxes fraîches du pool. Votre branche devient l'une de 3^k branches indistinguables avec une probabilité de liaison (1/3)^k.",
    depth_label: "Profondeur",
    depth_option: "k = {{d}}",
    depth_hint:
      "La profondeur {{d}} mixe votre branche dans 3^{{d}} branches indistinguables. Probabilité de liaison après l'exécution : {{percent}} %.",
    review_title: "Aperçu du plan",
    review_total_mixes: "Mix totaux",
    review_boxes_touched: "Boxes touchées",
    review_linkage: "Probabilité de liaison",
    review_linkage_value: "(1/3)^{{d}} après l'exécution",
    review_total_fee: "Frais totaux dans le pire cas",
    review_total_fee_value: "Jusqu'à {{ada}} ADA pour tous les mixs",
    review_pool: "Tirage du pool",
    review_pool_value: "{{have}} boxes fraîches disponibles, {{need}} nécessaires",
    disclosure_title: "Vous payez pour tout l'arbre",
    disclosure_body:
      "Re-mixer uniquement votre propre box laisserait un observateur suivre votre chaîne trivialement. L'éventail re-mixe chaque box touchée par votre vague précédente, y compris des boxes qui ne vous appartiennent pas. C'est ce qui rend votre branche indistinguable. Vous payez les frais + le coût de construction des preuves pour tout l'arbre.",
    gate_no_owned_boxes:
      "Déverrouillez votre coffre et déposez au moins une box pour lancer un éventail depuis une box que vous possédez.",
    gate_pool_too_small:
      "Pool trop petit : {{have}} boxes fraîches disponibles, l'éventail à cette profondeur en demande {{need}}.",
    run_button: "Lancer un éventail profondeur {{d}}",
    running: "Éventail profondeur {{d}} en cours…",
    cancel_button: "Arrêter le suivi",
    confirm_eyebrow: "Vérification finale",
    confirm_title: "Confirmer l'envoi de l'éventail",
    confirm_lede:
      "Lovejoin enverra {{count}} txs de Mix touchant {{boxes}} mix-boxes au total, avec des frais au pire cas allant jusqu'à {{ada}} ADA. Chaque tx est anonyme côté portefeuille en mode shard ; le service de collatéral signe chaque tx.",
    confirm_submit: "Confirmer et envoyer",
    progress_title: "Progression de l'éventail",
    progress_summary:
      "{{done}} sur {{total}} mixs traités · {{submitted}} envoyés · {{failed}} abandonnés",
    progress_current_wave: "Actuellement sur la vague {{wave}}",
    progress_dropped: "{{count}} mix(s) abandonné(s) car leur tx parente a échoué",
    toast_success: "Éventail terminé — {{count}} mix(s) envoyé(s)",
    toast_partial:
      "Éventail terminé avec des erreurs — {{submitted}} envoyés, {{failed}} abandonnés",
    toast_failed: "Éventail échoué",
    gate_owned_in_flight:
      "Toutes vos boxes sont encore en vol depuis une tx précédente. Attendez le prochain bloc et réessayez.",
  },
  de: {
    eyebrow: "Privatsphären-Boost",
    section_title: "Fan-out-Mix",
    lede: "Verkettet mehrere Mix-Txs zu einem Baum der Tiefe k, ausgehend von einer eigenen Box. Nach jeder Welle wird jede berührte Box mit zwei frischen Pool-Boxen neu gemischt. Dein Zweig wird einer von 3^k nicht unterscheidbaren Zweigen mit Verknüpfungswahrscheinlichkeit (1/3)^k.",
    depth_label: "Tiefe",
    depth_option: "k = {{d}}",
    depth_hint:
      "Tiefe {{d}} mischt deinen Zweig in 3^{{d}} nicht unterscheidbare Zweige. Verknüpfungswahrscheinlichkeit nach dem Lauf: {{percent}} %.",
    review_title: "Plan-Vorschau",
    review_total_mixes: "Mixe insgesamt",
    review_boxes_touched: "Berührte Boxen",
    review_linkage: "Verknüpfungswahrscheinlichkeit",
    review_linkage_value: "(1/3)^{{d}} nach dem Lauf",
    review_total_fee: "Worst-Case-Gesamtgebühr",
    review_total_fee_value: "Bis zu {{ada}} ADA über alle Mixe",
    review_pool: "Pool-Auswahl",
    review_pool_value: "{{have}} frische Boxen verfügbar, {{need}} benötigt",
    disclosure_title: "Du zahlst für alle in diesem Baum",
    disclosure_body:
      "Würde nur deine eigene Box neu gemischt, könnte ein Beobachter deiner Kette trivial folgen. Der Fan-out mischt jede Box deiner vorherigen Welle neu, auch Boxen, die dir nicht gehören. Genau das macht deinen Zweig ununterscheidbar. Du zahlst die Gebühren + die Beweis-Konstruktionskosten für den gesamten Baum.",
    gate_no_owned_boxes:
      "Entsperre deinen Vault und lege mindestens eine Box ab, um einen Fan-out aus einer eigenen Box zu starten.",
    gate_pool_too_small:
      "Pool zu klein: {{have}} frische Boxen verfügbar, der Fan-out auf dieser Tiefe braucht {{need}}.",
    run_button: "Fan-out Tiefe {{d}} starten",
    running: "Fan-out Tiefe {{d}} läuft…",
    cancel_button: "Verfolgung stoppen",
    confirm_eyebrow: "Letzte Prüfung",
    confirm_title: "Fan-out-Übermittlung bestätigen",
    confirm_lede:
      "Lovejoin sendet {{count}} Mix-Txs, die insgesamt {{boxes}} Mix-Boxen berühren, mit Gebühren im Worst-Case bis zu {{ada}} ADA. Jede Tx ist im Shard-Modus Wallet-anonym; der Collateral-Service signiert jede Tx.",
    confirm_submit: "Bestätigen und senden",
    progress_title: "Fan-out-Fortschritt",
    progress_summary:
      "{{done}} von {{total}} Mixen verarbeitet · {{submitted}} gesendet · {{failed}} verworfen",
    progress_current_wave: "Aktuell in Welle {{wave}}",
    progress_dropped: "{{count}} Mix(e) verworfen, weil die Eltern-Tx fehlschlug",
    toast_success: "Fan-out abgeschlossen — {{count}} Mix(e) gesendet",
    toast_partial: "Fan-out mit Fehlern beendet — {{submitted}} gesendet, {{failed}} verworfen",
    toast_failed: "Fan-out fehlgeschlagen",
    gate_owned_in_flight:
      "Jede eigene Box ist noch von einer vorherigen Tx im Umlauf. Warte auf den nächsten Block und versuch's erneut.",
  },
  pt: {
    eyebrow: "Reforço de privacidade",
    section_title: "Mix em leque",
    lede: "Encadeie várias txs de Mix em uma árvore de profundidade k partindo de uma das suas boxes. Após cada onda, cada box que você tocou é re-misturada com duas boxes frescas do pool. Seu ramo vira um entre 3^k ramos indistinguíveis com probabilidade de ligação (1/3)^k.",
    depth_label: "Profundidade",
    depth_option: "k = {{d}}",
    depth_hint:
      "Profundidade {{d}} mistura seu ramo em 3^{{d}} ramos indistinguíveis. Probabilidade de ligação após a execução: {{percent}}%.",
    review_title: "Prévia do plano",
    review_total_mixes: "Mixes totais",
    review_boxes_touched: "Boxes tocadas",
    review_linkage: "Probabilidade de ligação",
    review_linkage_value: "(1/3)^{{d}} após a execução",
    review_total_fee: "Taxa total no pior caso",
    review_total_fee_value: "Até {{ada}} ADA em todos os mixes",
    review_pool: "Sorteio do pool",
    review_pool_value: "{{have}} boxes frescas disponíveis, {{need}} necessárias",
    disclosure_title: "Você está pagando por todos nesta árvore",
    disclosure_body:
      "Re-misturar apenas sua própria box permitiria a um observador seguir trivialmente sua cadeia. O leque re-mistura cada box que sua onda anterior tocou, incluindo boxes que você não possui. É isso que torna seu ramo indistinguível. Você paga as taxas + o custo de construção de provas para a árvore inteira.",
    gate_no_owned_boxes:
      "Desbloqueie seu cofre e deposite pelo menos uma box para rodar um leque a partir de uma box sua.",
    gate_pool_too_small:
      "Pool pequeno demais: {{have}} boxes frescas disponíveis, este leque precisa de {{need}}.",
    run_button: "Rodar leque de profundidade {{d}}",
    running: "Rodando leque de profundidade {{d}}…",
    cancel_button: "Parar acompanhamento",
    confirm_eyebrow: "Verificação final",
    confirm_title: "Confirmar envio do leque",
    confirm_lede:
      "Lovejoin enviará {{count}} txs de Mix tocando {{boxes}} mix-boxes no total, com taxa no pior caso de até {{ada}} ADA. Cada tx é anônima para a carteira em modo shard; o serviço de colateral assina cada tx.",
    confirm_submit: "Confirmar e enviar",
    progress_title: "Progresso do leque",
    progress_summary:
      "{{done}} de {{total}} mixes processados · {{submitted}} enviados · {{failed}} descartados",
    progress_current_wave: "Atualmente na onda {{wave}}",
    progress_dropped: "{{count}} mix(es) descartado(s) porque sua tx pai falhou",
    toast_success: "Leque completo — {{count}} mix(es) enviado(s)",
    toast_partial: "Leque terminou com erros — {{submitted}} enviados, {{failed}} descartados",
    toast_failed: "Leque falhou",
    gate_owned_in_flight:
      "Todas as suas boxes ainda estão em trânsito de uma tx anterior. Aguarde o próximo bloco e tente de novo.",
  },
  it: {
    eyebrow: "Boost di privacy",
    section_title: "Mix a ventaglio",
    lede: "Concatena più txs di Mix in un albero di profondità k partendo da una delle tue box. Dopo ogni onda, ogni box che hai toccato viene rimescolata con due box fresche del pool. Il tuo ramo diventa uno di 3^k rami indistinguibili con probabilità di collegamento (1/3)^k.",
    depth_label: "Profondità",
    depth_option: "k = {{d}}",
    depth_hint:
      "La profondità {{d}} mescola il tuo ramo in 3^{{d}} rami indistinguibili. Probabilità di collegamento dopo l'esecuzione: {{percent}}%.",
    review_title: "Anteprima del piano",
    review_total_mixes: "Mix totali",
    review_boxes_touched: "Box toccate",
    review_linkage: "Probabilità di collegamento",
    review_linkage_value: "(1/3)^{{d}} dopo l'esecuzione",
    review_total_fee: "Commissione totale nel caso peggiore",
    review_total_fee_value: "Fino a {{ada}} ADA su tutti i mix",
    review_pool: "Estrazione dal pool",
    review_pool_value: "{{have}} box fresche disponibili, {{need}} necessarie",
    disclosure_title: "Stai pagando per tutti in questo albero",
    disclosure_body:
      "Rimescolare solo la tua box permetterebbe a un osservatore di seguire banalmente la tua catena. Il ventaglio rimescola ogni box che la tua onda precedente ha toccato, incluse box che non ti appartengono. È questo a rendere il tuo ramo indistinguibile. Paghi le commissioni + il costo di costruzione delle prove per l'intero albero.",
    gate_no_owned_boxes:
      "Sblocca il tuo vault e deposita almeno una box per avviare un ventaglio da una box che possiedi.",
    gate_pool_too_small:
      "Pool troppo piccolo: {{have}} box fresche disponibili, il ventaglio a questa profondità ne richiede {{need}}.",
    run_button: "Avvia ventaglio profondità {{d}}",
    running: "Ventaglio profondità {{d}} in corso…",
    cancel_button: "Smetti di seguire",
    confirm_eyebrow: "Controllo finale",
    confirm_title: "Conferma invio del ventaglio",
    confirm_lede:
      "Lovejoin invierà {{count}} txs di Mix toccando {{boxes}} mix-box in totale, con una commissione nel caso peggiore fino a {{ada}} ADA. Ogni tx è anonima per il wallet in modalità shard; il servizio di collaterale firma ogni tx.",
    confirm_submit: "Conferma e invia",
    progress_title: "Progresso del ventaglio",
    progress_summary:
      "{{done}} di {{total}} mix elaborati · {{submitted}} inviati · {{failed}} scartati",
    progress_current_wave: "Attualmente sull'onda {{wave}}",
    progress_dropped: "{{count}} mix scartati perché la tx padre è fallita",
    toast_success: "Ventaglio completato — {{count}} mix inviati",
    toast_partial: "Ventaglio terminato con errori — {{submitted}} inviati, {{failed}} scartati",
    toast_failed: "Ventaglio fallito",
    gate_owned_in_flight:
      "Ogni box è ancora in volo da una tx precedente. Attendi il prossimo blocco e riprova.",
  },
  pl: {
    eyebrow: "Wzmocnienie prywatności",
    section_title: "Mix rozgałęziony",
    lede: "Łączy kilka tx Mix w drzewo o głębokości k, startujące od jednej z twoich box. Po każdej fali każda dotknięta box jest ponownie mieszana z dwiema świeżymi box z poolu. Twoja gałąź staje się jedną z 3^k nieodróżnialnych gałęzi z prawdopodobieństwem powiązania (1/3)^k.",
    depth_label: "Głębokość",
    depth_option: "k = {{d}}",
    depth_hint:
      "Głębokość {{d}} miesza twoją gałąź w 3^{{d}} nieodróżnialnych gałęzi. Prawdopodobieństwo powiązania po wykonaniu: {{percent}}%.",
    review_title: "Podgląd planu",
    review_total_mixes: "Łączna liczba mixów",
    review_boxes_touched: "Dotknięte boxy",
    review_linkage: "Prawdopodobieństwo powiązania",
    review_linkage_value: "(1/3)^{{d}} po wykonaniu",
    review_total_fee: "Łączna opłata w najgorszym przypadku",
    review_total_fee_value: "Do {{ada}} ADA we wszystkich mixach",
    review_pool: "Pobranie z poolu",
    review_pool_value: "Dostępnych {{have}} świeżych box, potrzeba {{need}}",
    disclosure_title: "Płacisz za wszystkich w tym drzewie",
    disclosure_body:
      "Ponowne mieszanie tylko własnej box pozwoliłoby obserwatorowi trywialnie śledzić twój łańcuch. Rozgałęzienie ponownie miesza każdą box dotkniętą w poprzedniej fali, w tym box, które do ciebie nie należą. To właśnie sprawia, że twoja gałąź jest nieodróżnialna. Płacisz opłaty + koszt konstrukcji dowodów za całe drzewo.",
    gate_no_owned_boxes:
      "Odblokuj swój sejf i wpłać co najmniej jedną box, aby uruchomić rozgałęzienie z box, którą posiadasz.",
    gate_pool_too_small:
      "Pool za mały: {{have}} świeżych box dostępnych, rozgałęzienie na tej głębokości potrzebuje {{need}}.",
    run_button: "Uruchom rozgałęzienie głębokości {{d}}",
    running: "Trwa rozgałęzienie głębokości {{d}}…",
    cancel_button: "Zatrzymaj śledzenie",
    confirm_eyebrow: "Ostateczna kontrola",
    confirm_title: "Potwierdź wysyłkę rozgałęzienia",
    confirm_lede:
      "Lovejoin wyśle {{count}} tx Mix dotykając łącznie {{boxes}} mix-box, z opłatą w najgorszym przypadku do {{ada}} ADA. Każda tx jest anonimowa dla portfela w trybie shard; usługa kolateralu podpisuje każdą tx.",
    confirm_submit: "Potwierdź i wyślij",
    progress_title: "Postęp rozgałęzienia",
    progress_summary:
      "{{done}} z {{total}} mixów przetworzonych · {{submitted}} wysłanych · {{failed}} odrzuconych",
    progress_current_wave: "Obecnie na fali {{wave}}",
    progress_dropped: "{{count}} mix(ów) odrzuconych, bo ich tx nadrzędna nie powiodła się",
    toast_success: "Rozgałęzienie zakończone — wysłano {{count}} mix(ów)",
    toast_partial:
      "Rozgałęzienie zakończone z błędami — wysłano {{submitted}}, odrzucono {{failed}}",
    toast_failed: "Rozgałęzienie nieudane",
    gate_owned_in_flight:
      "Wszystkie twoje boxy są jeszcze w locie z poprzedniej tx. Poczekaj na następny blok i spróbuj ponownie.",
  },
  tr: {
    eyebrow: "Gizlilik takviyesi",
    section_title: "Yelpaze karışım",
    lede: "Sahip olduğunuz bir box'tan başlayan derinlik-k bir ağaca birden çok Mix tx'ini zincirler. Her dalgadan sonra, dokunduğunuz her box pool'dan iki taze box ile yeniden karıştırılır. Dalınız 3^k ayırt edilemez dalın biri olur; bağlantı olasılığı (1/3)^k.",
    depth_label: "Derinlik",
    depth_option: "k = {{d}}",
    depth_hint:
      "Derinlik {{d}} dalınızı 3^{{d}} ayırt edilemez dala karıştırır. Çalıştırma sonrası bağlantı olasılığı: %{{percent}}.",
    review_title: "Plan önizleme",
    review_total_mixes: "Toplam karışım",
    review_boxes_touched: "Dokunulan box'lar",
    review_linkage: "Bağlantı olasılığı",
    review_linkage_value: "Çalıştırma sonrası (1/3)^{{d}}",
    review_total_fee: "En kötü senaryoda toplam ücret",
    review_total_fee_value: "Tüm karışımlar boyunca en fazla {{ada}} ADA",
    review_pool: "Pool çekilişi",
    review_pool_value: "{{have}} taze box mevcut, {{need}} gerekiyor",
    disclosure_title: "Bu ağaçtaki herkes için ödüyorsunuz",
    disclosure_body:
      "Yalnızca kendi box'unuzu yeniden karıştırmak, bir gözlemcinin zincirinizi kolayca takip etmesine izin verir. Yelpaze, önceki dalganızın dokunduğu her box'u yeniden karıştırır; sahip olmadığınız box'lar dahil. Dalınızı ayırt edilemez kılan budur. Tüm ağacın ücretlerini + ispat oluşturma maliyetini siz ödersiniz.",
    gate_no_owned_boxes:
      "Kendi box'unuzdan yelpaze çalıştırmak için kasanızı açın ve en az bir box yatırın.",
    gate_pool_too_small:
      "Pool çok küçük: {{have}} taze box mevcut; bu derinlikteki yelpaze {{need}} gerektiriyor.",
    run_button: "Derinlik {{d}} yelpazesini çalıştır",
    running: "Derinlik {{d}} yelpazesi çalışıyor…",
    cancel_button: "Takibi durdur",
    confirm_eyebrow: "Son kontrol",
    confirm_title: "Yelpaze gönderimini onayla",
    confirm_lede:
      "Lovejoin toplam {{boxes}} mix-box'a dokunan {{count}} Mix tx'i gönderecek; en kötü ücret {{ada}} ADA'ya kadar. Her tx shard modunda cüzdana göre anonimdir; kolateral hizmeti her tx'i imzalar.",
    confirm_submit: "Onayla ve gönder",
    progress_title: "Yelpaze ilerlemesi",
    progress_summary:
      "{{total}} karışımdan {{done}} işlendi · {{submitted}} gönderildi · {{failed}} düşürüldü",
    progress_current_wave: "Şu an {{wave}}. dalgada",
    progress_dropped: "{{count}} karışım, üst tx başarısız olduğu için düşürüldü",
    toast_success: "Yelpaze tamamlandı — {{count}} karışım gönderildi",
    toast_partial: "Yelpaze hatalarla tamamlandı — {{submitted}} gönderildi, {{failed}} düşürüldü",
    toast_failed: "Yelpaze başarısız",
    gate_owned_in_flight:
      "Sahip olduğun her box hâlâ önceki bir tx'ten uçuyor. Bir sonraki bloğu bekle ve tekrar dene.",
  },
  vi: {
    eyebrow: "Tăng cường riêng tư",
    section_title: "Trộn theo cây",
    lede: "Nối nhiều tx Mix thành một cây sâu k bắt đầu từ một trong các box của bạn. Sau mỗi đợt, mọi box bạn đã chạm được trộn lại với hai box mới từ pool. Nhánh của bạn trở thành một trong 3^k nhánh không phân biệt được với xác suất liên kết (1/3)^k.",
    depth_label: "Độ sâu",
    depth_option: "k = {{d}}",
    depth_hint:
      "Độ sâu {{d}} trộn nhánh của bạn vào 3^{{d}} nhánh không phân biệt được. Xác suất liên kết sau khi chạy: {{percent}}%.",
    review_title: "Xem trước kế hoạch",
    review_total_mixes: "Tổng số trộn",
    review_boxes_touched: "Box đã chạm",
    review_linkage: "Xác suất liên kết",
    review_linkage_value: "(1/3)^{{d}} sau khi chạy",
    review_total_fee: "Phí tổng trường hợp xấu nhất",
    review_total_fee_value: "Tối đa {{ada}} ADA trên tất cả các trộn",
    review_pool: "Rút từ pool",
    review_pool_value: "{{have}} box mới sẵn có, cần {{need}}",
    disclosure_title: "Bạn đang trả cho tất cả mọi người trong cây này",
    disclosure_body:
      "Chỉ trộn lại box của riêng bạn cho phép người quan sát đi theo chuỗi của bạn một cách dễ dàng. Trộn theo cây trộn lại mỗi box mà đợt trước của bạn đã chạm, bao gồm cả box không thuộc về bạn. Đó là điều khiến nhánh của bạn không phân biệt được. Bạn trả phí + chi phí dựng bằng chứng cho toàn bộ cây.",
    gate_no_owned_boxes:
      "Mở khóa kho lưu trữ và gửi tối thiểu một box để chạy trộn theo cây từ một box thuộc về bạn.",
    gate_pool_too_small:
      "Pool quá nhỏ: {{have}} box mới sẵn có, trộn theo cây ở độ sâu này cần {{need}}.",
    run_button: "Chạy trộn cây độ sâu {{d}}",
    running: "Đang chạy trộn cây độ sâu {{d}}…",
    cancel_button: "Dừng theo dõi",
    confirm_eyebrow: "Kiểm tra cuối",
    confirm_title: "Xác nhận gửi trộn cây",
    confirm_lede:
      "Lovejoin sẽ gửi {{count}} tx Mix chạm tổng cộng {{boxes}} mix-box, với phí xấu nhất lên đến {{ada}} ADA. Mỗi tx ẩn danh với ví trong chế độ shard; dịch vụ collateral ký mỗi tx.",
    confirm_submit: "Xác nhận và gửi",
    progress_title: "Tiến độ trộn cây",
    progress_summary: "Đã xử lý {{done}} trên {{total}} · {{submitted}} đã gửi · {{failed}} bị hủy",
    progress_current_wave: "Đang ở đợt {{wave}}",
    progress_dropped: "{{count}} trộn bị hủy vì tx cha thất bại",
    toast_success: "Trộn cây hoàn tất — {{count}} trộn đã gửi",
    toast_partial: "Trộn cây kết thúc với lỗi — {{submitted}} đã gửi, {{failed}} bị hủy",
    toast_failed: "Trộn cây thất bại",
    gate_owned_in_flight:
      "Mọi box bạn sở hữu vẫn đang bay từ tx trước. Hãy đợi khối tiếp theo và thử lại.",
  },
  id: {
    eyebrow: "Penguat privasi",
    section_title: "Mix berbentuk kipas",
    lede: "Rangkai beberapa tx Mix menjadi pohon berkedalaman k mulai dari salah satu box milikmu. Setelah setiap gelombang, setiap box yang kamu sentuh dimix ulang dengan dua box segar dari pool. Cabangmu menjadi salah satu dari 3^k cabang yang tidak terbedakan dengan probabilitas keterkaitan (1/3)^k.",
    depth_label: "Kedalaman",
    depth_option: "k = {{d}}",
    depth_hint:
      "Kedalaman {{d}} mencampur cabangmu menjadi 3^{{d}} cabang tak terbedakan. Probabilitas keterkaitan setelah dijalankan: {{percent}}%.",
    review_title: "Pratinjau rencana",
    review_total_mixes: "Total mix",
    review_boxes_touched: "Box yang disentuh",
    review_linkage: "Probabilitas keterkaitan",
    review_linkage_value: "(1/3)^{{d}} setelah dijalankan",
    review_total_fee: "Total biaya kasus terburuk",
    review_total_fee_value: "Hingga {{ada}} ADA di seluruh mix",
    review_pool: "Pengambilan dari pool",
    review_pool_value: "{{have}} box segar tersedia, {{need}} dibutuhkan",
    disclosure_title: "Kamu membayar untuk semua di pohon ini",
    disclosure_body:
      "Mencampur ulang hanya box milikmu sendiri membuat pengamat dapat mengikuti rantaimu dengan mudah. Pencabangan kipas mencampur ulang setiap box yang gelombang sebelumnya sentuh, termasuk box yang bukan milikmu. Itulah yang membuat cabangmu tidak terbedakan. Kamu membayar biaya + biaya konstruksi bukti untuk seluruh pohon.",
    gate_no_owned_boxes:
      "Buka kunci vault-mu dan deposit setidaknya satu box untuk menjalankan kipas dari box milikmu.",
    gate_pool_too_small:
      "Pool terlalu kecil: {{have}} box segar tersedia, kipas pada kedalaman ini butuh {{need}}.",
    run_button: "Jalankan kipas kedalaman {{d}}",
    running: "Menjalankan kipas kedalaman {{d}}…",
    cancel_button: "Berhenti melacak",
    confirm_eyebrow: "Pemeriksaan akhir",
    confirm_title: "Konfirmasi pengiriman kipas",
    confirm_lede:
      "Lovejoin akan mengirim {{count}} tx Mix yang menyentuh total {{boxes}} mix-box, dengan biaya kasus terburuk hingga {{ada}} ADA. Setiap tx anonim terhadap dompet dalam mode shard; layanan collateral menandatangani setiap tx.",
    confirm_submit: "Konfirmasi dan kirim",
    progress_title: "Kemajuan kipas",
    progress_summary:
      "{{done}} dari {{total}} mix diproses · {{submitted}} terkirim · {{failed}} digugurkan",
    progress_current_wave: "Saat ini di gelombang {{wave}}",
    progress_dropped: "{{count}} mix digugurkan karena tx induknya gagal",
    toast_success: "Kipas selesai — {{count}} mix terkirim",
    toast_partial: "Kipas selesai dengan kesalahan — {{submitted}} terkirim, {{failed}} digugurkan",
    toast_failed: "Kipas gagal",
    gate_owned_in_flight:
      "Semua box kepunyaanmu masih dalam penerbangan dari tx sebelumnya. Tunggu blok berikutnya, lalu coba lagi.",
  },
  ru: {
    eyebrow: "Усиление приватности",
    section_title: "Веерное смешивание",
    lede: "Связывает несколько tx Mix в дерево глубины k, начиная с одной из ваших box. После каждой волны каждый затронутый box повторно смешивается с двумя свежими box из пула. Ваша ветвь становится одной из 3^k неразличимых ветвей с вероятностью связи (1/3)^k.",
    depth_label: "Глубина",
    depth_option: "k = {{d}}",
    depth_hint:
      "Глубина {{d}} смешивает вашу ветвь в 3^{{d}} неразличимых ветвей. Вероятность связи после запуска: {{percent}}%.",
    review_title: "Предпросмотр плана",
    review_total_mixes: "Всего смешиваний",
    review_boxes_touched: "Затронуто box",
    review_linkage: "Вероятность связи",
    review_linkage_value: "(1/3)^{{d}} после запуска",
    review_total_fee: "Худшая суммарная комиссия",
    review_total_fee_value: "До {{ada}} ADA на все смешивания",
    review_pool: "Выборка из пула",
    review_pool_value: "Доступно {{have}} свежих box, нужно {{need}}",
    disclosure_title: "Вы платите за всех в этом дереве",
    disclosure_body:
      "Если бы вы смешивали только свою box, наблюдатель тривиально проследил бы вашу цепочку. Веер пересмешивает каждый box, затронутый предыдущей волной, включая box, которые вам не принадлежат. Именно это делает вашу ветвь неразличимой. Вы платите комиссии + стоимость построения доказательств за всё дерево.",
    gate_no_owned_boxes:
      "Разблокируйте свой vault и положите хотя бы один box, чтобы запустить веер с собственного box.",
    gate_pool_too_small:
      "Пул слишком мал: доступно {{have}} свежих box, веер на этой глубине требует {{need}}.",
    run_button: "Запустить веер глубины {{d}}",
    running: "Идёт веер глубины {{d}}…",
    cancel_button: "Прекратить отслеживание",
    confirm_eyebrow: "Финальная проверка",
    confirm_title: "Подтвердить отправку веера",
    confirm_lede:
      "Lovejoin отправит {{count}} tx Mix, затронув в сумме {{boxes}} mix-box, с худшей комиссией до {{ada}} ADA. Каждая tx анонимна для кошелька в режиме shard; служба collateral подписывает каждую tx.",
    confirm_submit: "Подтвердить и отправить",
    progress_title: "Прогресс веера",
    progress_summary:
      "Обработано {{done}} из {{total}} · отправлено {{submitted}} · отброшено {{failed}}",
    progress_current_wave: "Сейчас на волне {{wave}}",
    progress_dropped: "{{count}} смешивание(й) отброшено, родительская tx не удалась",
    toast_success: "Веер завершён — отправлено {{count}} смешивание(й)",
    toast_partial: "Веер завершён с ошибками — отправлено {{submitted}}, отброшено {{failed}}",
    toast_failed: "Веер не удался",
    gate_owned_in_flight:
      "Все ваши box ещё в полёте после предыдущей tx. Подождите следующего блока и попробуйте снова.",
  },
  zh: {
    eyebrow: "隐私增强",
    section_title: "扇出混合",
    lede: "把多个 Mix 交易串成深度为 k 的树，从你拥有的一个 box 出发。每一轮过后，所有被触及的 box 都会和池中的两个新鲜 box 一起重新混合。你的分支变成 3^k 个不可区分分支之一，关联概率 (1/3)^k。",
    depth_label: "深度",
    depth_option: "k = {{d}}",
    depth_hint: "深度 {{d}} 把你的分支混入 3^{{d}} 个不可区分分支。运行后关联概率：{{percent}}%。",
    review_title: "方案预览",
    review_total_mixes: "总混合数",
    review_boxes_touched: "触及 box 数",
    review_linkage: "关联概率",
    review_linkage_value: "运行后 (1/3)^{{d}}",
    review_total_fee: "最坏情况总费用",
    review_total_fee_value: "全部混合最多 {{ada}} ADA",
    review_pool: "池中抽取",
    review_pool_value: "可用新鲜 box {{have}} 个，需要 {{need}} 个",
    disclosure_title: "你在为这棵树里的每个人买单",
    disclosure_body:
      "只重新混合你自己的 box，观察者可以轻易跟踪你的链。扇出会重新混合上一轮你触及的每一个 box，包括不属于你的 box。这就是让你的分支不可区分的原因。整棵树的费用 + 证明构造成本由你支付。",
    gate_no_owned_boxes: "请解锁你的 vault 并至少存入一个 box，才能从你拥有的 box 启动扇出。",
    gate_pool_too_small: "池太小：可用新鲜 box {{have}} 个，此深度扇出需要 {{need}} 个。",
    run_button: "运行深度 {{d}} 扇出",
    running: "正在运行深度 {{d}} 扇出…",
    cancel_button: "停止跟踪",
    confirm_eyebrow: "最终检查",
    confirm_title: "确认扇出提交",
    confirm_lede:
      "Lovejoin 将提交 {{count}} 个 Mix 交易，共触及 {{boxes}} 个 mix-box，最坏情况费用最高 {{ada}} ADA。在 shard 模式下每笔交易对钱包匿名；抵押服务为每笔交易签名。",
    confirm_submit: "确认并提交",
    progress_title: "扇出进度",
    progress_summary: "已处理 {{done}}/{{total}} 个混合 · 已提交 {{submitted}} · 已丢弃 {{failed}}",
    progress_current_wave: "目前在第 {{wave}} 轮",
    progress_dropped: "{{count}} 个混合因父交易失败而丢弃",
    toast_success: "扇出完成 — 已提交 {{count}} 个混合",
    toast_partial: "扇出有错误地完成 — 已提交 {{submitted}}，丢弃 {{failed}}",
    toast_failed: "扇出失败",
    gate_owned_in_flight: "你所有的 box 都还在前一笔交易的途中。等下一个区块后再试。",
  },
  ja: {
    eyebrow: "プライバシー強化",
    section_title: "ファンアウト・ミックス",
    lede: "あなたの所有する box の 1 つから始まる深さ k のツリーに複数の Mix tx を連鎖させます。各ウェーブの後、触れた box はそれぞれプール内の 2 つの新鮮な box と再ミックスされます。あなたのブランチは 3^k 個の見分けがつかないブランチの 1 つになり、リンク確率は (1/3)^k です。",
    depth_label: "深さ",
    depth_option: "k = {{d}}",
    depth_hint:
      "深さ {{d}} はあなたのブランチを 3^{{d}} 個の見分けがつかないブランチに混ぜます。実行後のリンク確率: {{percent}}%。",
    review_title: "プランのプレビュー",
    review_total_mixes: "総ミックス数",
    review_boxes_touched: "触れた box 数",
    review_linkage: "リンク確率",
    review_linkage_value: "実行後 (1/3)^{{d}}",
    review_total_fee: "最悪ケースの総手数料",
    review_total_fee_value: "全ミックスで最大 {{ada}} ADA",
    review_pool: "プールからの抽選",
    review_pool_value: "新鮮な box {{have}} 個が利用可能、{{need}} 個が必要",
    disclosure_title: "あなたはこのツリー全員の分を支払っています",
    disclosure_body:
      "自分の box だけを再ミックスすると、観察者はあなたのチェーンを簡単に追跡できます。ファンアウトは前のウェーブで触れたすべての box を再ミックスします。所有していない box も含みます。それがあなたのブランチを見分けがつかないものにする理由です。ツリー全体の手数料 + 証明構築コストはあなたが支払います。",
    gate_no_owned_boxes:
      "所有する box からファンアウトを実行するには、vault を解錠して少なくとも 1 つ box を入金してください。",
    gate_pool_too_small:
      "プールが小さすぎます: 新鮮な box {{have}} 個が利用可能、この深さのファンアウトには {{need}} 個必要です。",
    run_button: "深さ {{d}} のファンアウトを実行",
    running: "深さ {{d}} のファンアウトを実行中…",
    cancel_button: "追跡を停止",
    confirm_eyebrow: "最終確認",
    confirm_title: "ファンアウト送信の確認",
    confirm_lede:
      "Lovejoin は合計 {{boxes}} 個の mix-box に触れる {{count}} 個の Mix tx を送信します。最悪ケースの手数料は最大 {{ada}} ADA です。各 tx は shard モードでウォレットに対して匿名です。コラテラル・サービスが各 tx に署名します。",
    confirm_submit: "確認して送信",
    progress_title: "ファンアウトの進捗",
    progress_summary:
      "{{total}} 個のミックスのうち {{done}} 個を処理 · {{submitted}} 個を送信 · {{failed}} 個を破棄",
    progress_current_wave: "現在 {{wave}} 波目",
    progress_dropped: "{{count}} 個のミックスが親 tx の失敗により破棄されました",
    toast_success: "ファンアウト完了 — {{count}} 個のミックスを送信しました",
    toast_partial: "ファンアウトはエラーで終了しました — 送信 {{submitted}} 件、破棄 {{failed}} 件",
    toast_failed: "ファンアウトに失敗しました",
    gate_owned_in_flight:
      "所有するすべての box が前回の tx でまだ移動中です。次のブロックを待ってから再試行してください。",
  },
  ko: {
    eyebrow: "프라이버시 부스트",
    section_title: "팬아웃 믹스",
    lede: "당신이 소유한 box 중 하나에서 시작하는 깊이 k 트리로 여러 Mix tx를 연결합니다. 각 웨이브 후, 당신이 건드린 모든 box는 풀의 새 box 두 개와 함께 다시 믹스됩니다. 당신의 가지는 (1/3)^k 연결 확률을 가진 3^k 개의 구분 불가능한 가지 중 하나가 됩니다.",
    depth_label: "깊이",
    depth_option: "k = {{d}}",
    depth_hint:
      "깊이 {{d}}는 당신의 가지를 3^{{d}}개의 구분 불가능한 가지로 섞습니다. 실행 후 연결 확률: {{percent}}%.",
    review_title: "계획 미리보기",
    review_total_mixes: "총 믹스 수",
    review_boxes_touched: "건드린 box",
    review_linkage: "연결 확률",
    review_linkage_value: "실행 후 (1/3)^{{d}}",
    review_total_fee: "최악의 경우 총 수수료",
    review_total_fee_value: "모든 믹스에 걸쳐 최대 {{ada}} ADA",
    review_pool: "풀에서 추첨",
    review_pool_value: "사용 가능한 신선한 box {{have}}개, 필요 {{need}}개",
    disclosure_title: "이 트리의 모든 사람을 위해 비용을 지불하고 있습니다",
    disclosure_body:
      "자신의 box만 다시 믹스하면 관찰자가 당신의 체인을 사소하게 추적할 수 있습니다. 팬아웃은 이전 웨이브에서 건드린 모든 box를 다시 믹스합니다. 소유하지 않은 box도 포함됩니다. 이것이 당신의 가지를 구분 불가능하게 만드는 이유입니다. 전체 트리의 수수료 + 증명 구성 비용을 당신이 지불합니다.",
    gate_no_owned_boxes:
      "소유한 box에서 팬아웃을 실행하려면 vault를 잠금 해제하고 최소 한 개의 box를 예치하세요.",
    gate_pool_too_small:
      "풀이 너무 작습니다: 사용 가능한 신선한 box {{have}}개, 이 깊이의 팬아웃은 {{need}}개가 필요합니다.",
    run_button: "깊이 {{d}} 팬아웃 실행",
    running: "깊이 {{d}} 팬아웃 실행 중…",
    cancel_button: "추적 중지",
    confirm_eyebrow: "최종 확인",
    confirm_title: "팬아웃 제출 확인",
    confirm_lede:
      "Lovejoin은 총 {{boxes}}개의 mix-box를 건드리는 {{count}}개의 Mix tx를 제출하며, 최악의 경우 수수료는 최대 {{ada}} ADA입니다. 각 tx는 shard 모드에서 지갑에 대해 익명입니다. 담보 서비스가 각 tx에 서명합니다.",
    confirm_submit: "확인 후 제출",
    progress_title: "팬아웃 진행",
    progress_summary:
      "{{total}}개 믹스 중 {{done}}개 처리 · {{submitted}}개 제출 · {{failed}}개 폐기",
    progress_current_wave: "현재 {{wave}}번째 웨이브",
    progress_dropped: "{{count}}개의 믹스가 부모 tx 실패로 폐기됨",
    toast_success: "팬아웃 완료 — {{count}}개 믹스 제출됨",
    toast_partial: "오류와 함께 팬아웃 종료 — {{submitted}}개 제출, {{failed}}개 폐기",
    toast_failed: "팬아웃 실패",
    gate_owned_in_flight:
      "소유한 모든 box가 이전 tx에서 아직 전송 중입니다. 다음 블록을 기다린 후 다시 시도하세요.",
  },
  hi: {
    eyebrow: "गोपनीयता बूस्ट",
    section_title: "फैन-आउट मिक्स",
    lede: "अपनी एक box से शुरू होने वाले गहराई-k पेड़ में कई Mix tx जोड़ें। हर लहर के बाद, आपके छुए हर box को pool के दो ताज़े box के साथ फिर से मिक्स किया जाता है। आपकी शाखा 3^k अप्रभेद्य शाखाओं में से एक बन जाती है, लिंकेज प्रायिकता (1/3)^k।",
    depth_label: "गहराई",
    depth_option: "k = {{d}}",
    depth_hint:
      "गहराई {{d}} आपकी शाखा को 3^{{d}} अप्रभेद्य शाखाओं में मिलाती है। चलाने के बाद लिंकेज प्रायिकता: {{percent}}%।",
    review_title: "योजना पूर्वावलोकन",
    review_total_mixes: "कुल मिक्स",
    review_boxes_touched: "छुए गए box",
    review_linkage: "लिंकेज प्रायिकता",
    review_linkage_value: "चलाने के बाद (1/3)^{{d}}",
    review_total_fee: "सबसे खराब स्थिति का कुल शुल्क",
    review_total_fee_value: "सभी मिक्स पर अधिकतम {{ada}} ADA",
    review_pool: "pool से चयन",
    review_pool_value: "{{have}} ताज़े box उपलब्ध, {{need}} चाहिए",
    disclosure_title: "आप इस पेड़ के सबके लिए भुगतान कर रहे हैं",
    disclosure_body:
      "केवल अपनी box को फिर से मिक्स करने से एक पर्यवेक्षक आपकी श्रृंखला को सरलता से अनुगमन कर सकता है। फैन-आउट हर उस box को फिर से मिक्स करता है जिसे आपकी पिछली लहर ने छुआ, उन box सहित जिनके आप मालिक नहीं हैं। यही चीज़ आपकी शाखा को अप्रभेद्य बनाती है। पूरे पेड़ के शुल्क + प्रूफ निर्माण लागत आप देते हैं।",
    gate_no_owned_boxes:
      "अपनी box से फैन-आउट चलाने के लिए अपना vault खोलें और कम से कम एक box जमा करें।",
    gate_pool_too_small:
      "Pool बहुत छोटा है: {{have}} ताज़े box उपलब्ध, इस गहराई के फैन-आउट को {{need}} चाहिए।",
    run_button: "गहराई {{d}} फैन-आउट चलाएँ",
    running: "गहराई {{d}} फैन-आउट चल रहा है…",
    cancel_button: "ट्रैकिंग रोकें",
    confirm_eyebrow: "अंतिम जाँच",
    confirm_title: "फैन-आउट सबमिशन की पुष्टि करें",
    confirm_lede:
      "Lovejoin {{count}} Mix tx भेजेगा जो कुल {{boxes}} mix-box छूते हैं, सबसे खराब स्थिति में शुल्क {{ada}} ADA तक। हर tx shard मोड में वॉलेट के लिए अनाम है; collateral सेवा हर tx पर हस्ताक्षर करती है।",
    confirm_submit: "पुष्टि और सबमिट",
    progress_title: "फैन-आउट प्रगति",
    progress_summary:
      "{{total}} में से {{done}} मिक्स संसाधित · {{submitted}} सबमिट · {{failed}} छोड़ी गई",
    progress_current_wave: "इस समय लहर {{wave}}",
    progress_dropped: "{{count}} मिक्स छोड़ी गई क्योंकि उनकी मूल tx विफल रही",
    toast_success: "फैन-आउट पूर्ण — {{count}} मिक्स सबमिट",
    toast_partial: "फैन-आउट त्रुटियों के साथ समाप्त — {{submitted}} सबमिट, {{failed}} छोड़ी गई",
    toast_failed: "फैन-आउट विफल",
    gate_owned_in_flight:
      "आपकी सभी box पिछली tx से अभी भी उड़ान में हैं। अगले ब्लॉक की प्रतीक्षा करें, फिर पुनः प्रयास करें।",
  },
  bn: {
    eyebrow: "গোপনীয়তা বুস্ট",
    section_title: "ফ্যান-আউট মিক্স",
    lede: "আপনার নিজস্ব একটি box থেকে শুরু করে গভীরতা-k একটি গাছে একাধিক Mix tx শৃঙ্খলিত করুন। প্রতিটি wave-এর পরে, আপনি যে box-গুলো স্পর্শ করেছেন প্রতিটি box pool থেকে দুটি তাজা box-এর সাথে পুনরায় মিক্স করা হয়। আপনার শাখা 3^k টি অভেদ্য শাখার একটি হয়ে যায়, লিংকেজ সম্ভাব্যতা (1/3)^k।",
    depth_label: "গভীরতা",
    depth_option: "k = {{d}}",
    depth_hint:
      "গভীরতা {{d}} আপনার শাখাকে 3^{{d}} টি অভেদ্য শাখায় মিশায়। চালানোর পর লিংকেজ সম্ভাব্যতা: {{percent}}%।",
    review_title: "পরিকল্পনা প্রিভিউ",
    review_total_mixes: "মোট মিক্স",
    review_boxes_touched: "স্পর্শ করা box",
    review_linkage: "লিংকেজ সম্ভাব্যতা",
    review_linkage_value: "চালানোর পর (1/3)^{{d}}",
    review_total_fee: "সবচেয়ে খারাপ ক্ষেত্রের মোট ফি",
    review_total_fee_value: "সমস্ত মিক্স জুড়ে সর্বাধিক {{ada}} ADA",
    review_pool: "Pool থেকে নির্বাচন",
    review_pool_value: "{{have}} টি তাজা box উপলব্ধ, {{need}} টি দরকার",
    disclosure_title: "আপনি এই গাছের সবার জন্য পরিশোধ করছেন",
    disclosure_body:
      "শুধু নিজের box পুনরায় মিক্স করলে একজন পর্যবেক্ষক আপনার চেইনকে সহজেই অনুসরণ করতে পারে। ফ্যান-আউট আপনার আগের wave-এ স্পর্শ করা প্রতিটি box পুনরায় মিক্স করে, এমনকি যেগুলো আপনার নয়। এটিই আপনার শাখাকে অভেদ্য করে। পুরো গাছের ফি + প্রমাণ নির্মাণ খরচ আপনি দেন।",
    gate_no_owned_boxes:
      "আপনার নিজস্ব box থেকে ফ্যান-আউট চালানোর জন্য আপনার vault আনলক করুন এবং অন্তত একটি box জমা দিন।",
    gate_pool_too_small:
      "Pool খুব ছোট: {{have}} টি তাজা box উপলব্ধ, এই গভীরতার ফ্যান-আউটের {{need}} দরকার।",
    run_button: "গভীরতা {{d}} ফ্যান-আউট চালান",
    running: "গভীরতা {{d}} ফ্যান-আউট চলছে…",
    cancel_button: "ট্র্যাকিং বন্ধ করুন",
    confirm_eyebrow: "চূড়ান্ত পরীক্ষা",
    confirm_title: "ফ্যান-আউট জমা নিশ্চিত করুন",
    confirm_lede:
      "Lovejoin মোট {{boxes}} টি mix-box স্পর্শ করে {{count}} টি Mix tx পাঠাবে, সবচেয়ে খারাপ ক্ষেত্রে ফি {{ada}} ADA পর্যন্ত। প্রতিটি tx shard মোডে wallet-এর জন্য অনামী; collateral পরিষেবা প্রতিটি tx স্বাক্ষর করে।",
    confirm_submit: "নিশ্চিত এবং জমা",
    progress_title: "ফ্যান-আউট অগ্রগতি",
    progress_summary:
      "{{total}} টির মধ্যে {{done}} টি মিক্স প্রক্রিয়া করা · {{submitted}} জমা · {{failed}} বাদ",
    progress_current_wave: "এখন wave {{wave}}-এ",
    progress_dropped: "{{count}} টি মিক্স বাদ পড়েছে কারণ তাদের প্যারেন্ট tx ব্যর্থ হয়েছে",
    toast_success: "ফ্যান-আউট সম্পন্ন — {{count}} টি মিক্স জমা",
    toast_partial: "ফ্যান-আউট ত্রুটি সহ শেষ — {{submitted}} জমা, {{failed}} বাদ",
    toast_failed: "ফ্যান-আউট ব্যর্থ",
    gate_owned_in_flight:
      "আপনার সমস্ত box এখনও আগের tx থেকে উড়ন্ত অবস্থায় আছে। পরবর্তী ব্লকের জন্য অপেক্ষা করুন, তারপর আবার চেষ্টা করুন।",
  },
  th: {
    eyebrow: "เพิ่มความเป็นส่วนตัว",
    section_title: "Mix แบบกระจาย",
    lede: "เชื่อม Mix tx หลายรายการเป็นต้นไม้ลึก k โดยเริ่มจาก box ของคุณหนึ่งใบ หลังแต่ละคลื่น box ทุกใบที่คุณสัมผัสจะถูกผสมใหม่กับ box ใหม่จาก pool สองใบ สาขาของคุณกลายเป็นหนึ่งใน 3^k สาขาที่แยกแยะไม่ได้ โดยมีความน่าจะเป็นของการเชื่อมโยง (1/3)^k",
    depth_label: "ความลึก",
    depth_option: "k = {{d}}",
    depth_hint:
      "ความลึก {{d}} ผสมสาขาของคุณเข้ากับ 3^{{d}} สาขาที่แยกแยะไม่ได้ ความน่าจะเป็นการเชื่อมโยงหลังการรัน: {{percent}}%",
    review_title: "ตัวอย่างแผน",
    review_total_mixes: "Mix ทั้งหมด",
    review_boxes_touched: "Box ที่สัมผัส",
    review_linkage: "ความน่าจะเป็นการเชื่อมโยง",
    review_linkage_value: "(1/3)^{{d}} หลังการรัน",
    review_total_fee: "ค่าธรรมเนียมรวมกรณีแย่ที่สุด",
    review_total_fee_value: "ไม่เกิน {{ada}} ADA ตลอด mix ทั้งหมด",
    review_pool: "การจับฉลากจาก pool",
    review_pool_value: "Box ใหม่ใช้ได้ {{have}} ใบ ต้องการ {{need}}",
    disclosure_title: "คุณกำลังจ่ายให้ทุกคนในต้นไม้นี้",
    disclosure_body:
      "หากผสมเฉพาะ box ของคุณ ผู้สังเกตการณ์จะตามรอยห่วงโซ่ของคุณได้อย่างง่ายดาย Fan-out จะผสม box ทุกใบที่คลื่นก่อนหน้าสัมผัส รวมถึง box ที่ไม่ใช่ของคุณ นั่นคือสิ่งที่ทำให้สาขาของคุณแยกแยะไม่ได้ คุณจ่ายค่าธรรมเนียม + ต้นทุนการสร้างพิสูจน์สำหรับทั้งต้นไม้",
    gate_no_owned_boxes:
      "ปลดล็อก vault ของคุณและฝาก box อย่างน้อยหนึ่งใบเพื่อรัน fan-out จาก box ของคุณ",
    gate_pool_too_small:
      "Pool เล็กเกินไป: มี box ใหม่ {{have}} ใบ fan-out ที่ความลึกนี้ต้องการ {{need}}",
    run_button: "รัน fan-out ความลึก {{d}}",
    running: "กำลังรัน fan-out ความลึก {{d}}…",
    cancel_button: "หยุดติดตาม",
    confirm_eyebrow: "ตรวจสอบครั้งสุดท้าย",
    confirm_title: "ยืนยันการส่ง fan-out",
    confirm_lede:
      "Lovejoin จะส่ง Mix tx {{count}} รายการ สัมผัส mix-box ทั้งหมด {{boxes}} ใบ ค่าธรรมเนียมกรณีแย่ที่สุดสูงสุด {{ada}} ADA แต่ละ tx ไม่ระบุตัวตนต่อกระเป๋าในโหมด shard บริการ collateral เซ็นทุก tx",
    confirm_submit: "ยืนยันและส่ง",
    progress_title: "ความคืบหน้า fan-out",
    progress_summary: "ประมวล {{done}} จาก {{total}} mix · ส่งแล้ว {{submitted}} · ตก {{failed}}",
    progress_current_wave: "ขณะนี้คลื่นที่ {{wave}}",
    progress_dropped: "{{count}} mix ตกไปเพราะ tx แม่ล้มเหลว",
    toast_success: "Fan-out เสร็จ — ส่ง mix แล้ว {{count}} รายการ",
    toast_partial: "Fan-out จบพร้อมข้อผิดพลาด — ส่งแล้ว {{submitted}} ตก {{failed}}",
    toast_failed: "Fan-out ล้มเหลว",
    gate_owned_in_flight:
      "Box ทุกใบของคุณยังอยู่ระหว่างทางจาก tx ก่อนหน้า รอบล็อกถัดไปแล้วลองอีกครั้ง",
  },
  ar: {
    eyebrow: "تعزيز الخصوصية",
    section_title: "خلط بشكل مروحة",
    lede: "اربط عدة معاملات Mix في شجرة بعمق k تبدأ من إحدى صناديقك. بعد كل موجة، تُعاد خلط كل صندوق لمسته مع صندوقين جديدين من المسبح. يصبح فرعك واحدًا من 3^k فرعًا غير قابلة للتمييز باحتمال ارتباط (1/3)^k.",
    depth_label: "العمق",
    depth_option: "k = {{d}}",
    depth_hint:
      "العمق {{d}} يمزج فرعك في 3^{{d}} فرعًا غير قابلة للتمييز. احتمال الارتباط بعد التشغيل: {{percent}}%.",
    review_title: "معاينة الخطة",
    review_total_mixes: "إجمالي الخلطات",
    review_boxes_touched: "الصناديق التي لُمست",
    review_linkage: "احتمال الارتباط",
    review_linkage_value: "(1/3)^{{d}} بعد التشغيل",
    review_total_fee: "إجمالي الرسوم في أسوأ الحالات",
    review_total_fee_value: "حتى {{ada}} ADA عبر كل الخلطات",
    review_pool: "السحب من المسبح",
    review_pool_value: "{{have}} صندوقًا جديدًا متاحًا، نحتاج {{need}}",
    disclosure_title: "أنت تدفع عن الجميع في هذه الشجرة",
    disclosure_body:
      "إعادة خلط صندوقك فقط ستسمح للمراقب بتتبع سلسلتك بسهولة. المروحة تعيد خلط كل صندوق لمسته الموجة السابقة، بما في ذلك صناديق لا تمتلكها. هذا ما يجعل فرعك غير قابل للتمييز. أنت تدفع الرسوم + تكلفة بناء الإثبات للشجرة بأكملها.",
    gate_no_owned_boxes: "افتح خزينتك وأودِع صندوقًا واحدًا على الأقل لتشغيل مروحة من صندوق تملكه.",
    gate_pool_too_small:
      "المسبح صغير جدًا: {{have}} صندوق جديد متاح، المروحة بهذا العمق تحتاج {{need}}.",
    run_button: "تشغيل مروحة بعمق {{d}}",
    running: "جاري تشغيل مروحة بعمق {{d}}…",
    cancel_button: "إيقاف التتبع",
    confirm_eyebrow: "التحقق النهائي",
    confirm_title: "تأكيد إرسال المروحة",
    confirm_lede:
      "Lovejoin سيرسل {{count}} معاملة Mix تلمس {{boxes}} mix-box إجمالًا، برسوم في أسوأ الحالات تصل إلى {{ada}} ADA. كل معاملة مجهولة بالنسبة للمحفظة في وضع shard؛ خدمة الضمان توقّع كل معاملة.",
    confirm_submit: "تأكيد وإرسال",
    progress_title: "تقدم المروحة",
    progress_summary:
      "تمت معالجة {{done}} من {{total}} خلطة · {{submitted}} مُرسلة · {{failed}} مُسقطة",
    progress_current_wave: "حاليًا في الموجة {{wave}}",
    progress_dropped: "تم إسقاط {{count}} خلطة لأن معاملتها الأصلية فشلت",
    toast_success: "اكتملت المروحة — أُرسلت {{count}} خلطة",
    toast_partial: "انتهت المروحة بأخطاء — أُرسلت {{submitted}}، أُسقطت {{failed}}",
    toast_failed: "فشلت المروحة",
    gate_owned_in_flight:
      "كل صناديقك لا تزال في الطيران من معاملة سابقة. انتظر الكتلة التالية ثم حاول من جديد.",
  },
  ur: {
    eyebrow: "پرائیویسی بوسٹ",
    section_title: "پنکھے کی شکل میں مکس",
    lede: "اپنے ایک box سے شروع ہونے والے گہرائی-k درخت میں کئی Mix tx کو جوڑیں۔ ہر لہر کے بعد، آپ نے جس box کو چھوا اسے pool کے دو نئے box کے ساتھ دوبارہ مکس کیا جاتا ہے۔ آپ کی شاخ 3^k غیر امتیازی شاخوں میں سے ایک بن جاتی ہے، ربط احتمال (1/3)^k۔",
    depth_label: "گہرائی",
    depth_option: "k = {{d}}",
    depth_hint:
      "گہرائی {{d}} آپ کی شاخ کو 3^{{d}} غیر امتیازی شاخوں میں ملاتی ہے۔ چلانے کے بعد ربط احتمال: {{percent}}%۔",
    review_title: "منصوبہ پیش منظر",
    review_total_mixes: "کل مکس",
    review_boxes_touched: "چھوئے گئے box",
    review_linkage: "ربط احتمال",
    review_linkage_value: "چلانے کے بعد (1/3)^{{d}}",
    review_total_fee: "بدترین صورت کل فیس",
    review_total_fee_value: "تمام مکس میں زیادہ سے زیادہ {{ada}} ADA",
    review_pool: "pool سے انتخاب",
    review_pool_value: "{{have}} نئے box دستیاب، {{need}} درکار",
    disclosure_title: "آپ اس درخت میں سب کے لیے ادائیگی کر رہے ہیں",
    disclosure_body:
      "صرف اپنے box کو دوبارہ مکس کرنے سے ایک مبصر آپ کی زنجیر کو آسانی سے ٹریک کر سکتا ہے۔ پنکھا آپ کی پچھلی لہر میں چھوئے گئے ہر box کو دوبارہ مکس کرتا ہے، بشمول وہ box جو آپ کی ملکیت نہیں ہیں۔ یہی چیز آپ کی شاخ کو غیر امتیازی بناتی ہے۔ پورے درخت کی فیس + ثبوت کی تعمیر کی لاگت آپ ادا کرتے ہیں۔",
    gate_no_owned_boxes:
      "اپنے box سے پنکھا چلانے کے لیے اپنے vault کو غیر مقفل کریں اور کم از کم ایک box جمع کریں۔",
    gate_pool_too_small:
      "Pool بہت چھوٹا ہے: {{have}} نئے box دستیاب، اس گہرائی کے پنکھے کو {{need}} درکار ہیں۔",
    run_button: "گہرائی {{d}} کا پنکھا چلائیں",
    running: "گہرائی {{d}} کا پنکھا چل رہا ہے…",
    cancel_button: "ٹریکنگ روکیں",
    confirm_eyebrow: "حتمی جانچ",
    confirm_title: "پنکھے کی جمع آوری کی تصدیق کریں",
    confirm_lede:
      "Lovejoin مجموعی طور پر {{boxes}} mix-box کو چھونے والی {{count}} Mix tx بھیجے گا، بدترین صورت میں فیس {{ada}} ADA تک۔ ہر tx shard موڈ میں wallet کے لیے گمنام ہے؛ collateral سروس ہر tx پر دستخط کرتی ہے۔",
    confirm_submit: "تصدیق اور جمع",
    progress_title: "پنکھے کی پیش رفت",
    progress_summary:
      "{{total}} میں سے {{done}} مکس پروسیس · {{submitted}} جمع · {{failed}} گرائے گئے",
    progress_current_wave: "اس وقت لہر {{wave}} پر",
    progress_dropped: "{{count}} مکس گرائے گئے کیونکہ ان کا والد tx ناکام ہوا",
    toast_success: "پنکھا مکمل — {{count}} مکس جمع",
    toast_partial: "پنکھا غلطیوں کے ساتھ ختم — {{submitted}} جمع، {{failed}} گرائے گئے",
    toast_failed: "پنکھا ناکام",
    gate_owned_in_flight:
      "آپ کے تمام box پچھلی tx سے ابھی تک پرواز میں ہیں۔ اگلے بلاک کا انتظار کریں، پھر دوبارہ کوشش کریں۔",
  },
  fa: {
    eyebrow: "تقویت حریم خصوصی",
    section_title: "ترکیب پروانه‌ای",
    lede: "چند تراکنش Mix را در یک درخت با عمق k که از یکی از باکس‌های شما آغاز می‌شود زنجیر کنید. پس از هر موج، هر باکسی که لمس کرده‌اید با دو باکس تازه از استخر دوباره ترکیب می‌شود. شاخهٔ شما به یکی از 3^k شاخهٔ غیرقابل‌تشخیص با احتمال پیوند (1/3)^k تبدیل می‌شود.",
    depth_label: "عمق",
    depth_option: "k = {{d}}",
    depth_hint:
      "عمق {{d}} شاخهٔ شما را در 3^{{d}} شاخهٔ غیرقابل‌تشخیص ترکیب می‌کند. احتمال پیوند پس از اجرا: {{percent}}%.",
    review_title: "پیش‌نمایش طرح",
    review_total_mixes: "تعداد کل ترکیب‌ها",
    review_boxes_touched: "باکس‌های لمس‌شده",
    review_linkage: "احتمال پیوند",
    review_linkage_value: "پس از اجرا (1/3)^{{d}}",
    review_total_fee: "هزینهٔ کل در بدترین حالت",
    review_total_fee_value: "حداکثر {{ada}} ADA در کل ترکیب‌ها",
    review_pool: "قرعهٔ استخر",
    review_pool_value: "{{have}} باکس تازه در دسترس، {{need}} مورد نیاز",
    disclosure_title: "شما برای همه در این درخت می‌پردازید",
    disclosure_body:
      "اگر تنها باکس خود را دوباره ترکیب کنید، یک ناظر می‌تواند به‌سادگی زنجیرهٔ شما را دنبال کند. پروانه هر باکسی را که موج قبلی شما لمس کرده دوباره ترکیب می‌کند، از جمله باکس‌هایی که مال شما نیستند. همین چیز است که شاخهٔ شما را غیرقابل‌تشخیص می‌کند. هزینه‌ها و هزینهٔ ساخت اثبات‌ها برای کل درخت را شما می‌پردازید.",
    gate_no_owned_boxes:
      "برای اجرای پروانه از یک باکس متعلق به خود، گاوصندوقتان را باز کنید و حداقل یک باکس واریز کنید.",
    gate_pool_too_small:
      "استخر بسیار کوچک است: {{have}} باکس تازه در دسترس، پروانه در این عمق نیازمند {{need}} است.",
    run_button: "اجرای پروانه با عمق {{d}}",
    running: "در حال اجرای پروانه با عمق {{d}}…",
    cancel_button: "توقف ردیابی",
    confirm_eyebrow: "بررسی نهایی",
    confirm_title: "تأیید ارسال پروانه",
    confirm_lede:
      "Lovejoin مجموعاً {{count}} تراکنش Mix را که {{boxes}} mix-box را لمس می‌کنند ارسال خواهد کرد، با هزینهٔ بدترین حالت تا {{ada}} ADA. هر تراکنش در حالت shard نسبت به کیف پول ناشناس است؛ سرویس وثیقه هر تراکنش را امضا می‌کند.",
    confirm_submit: "تأیید و ارسال",
    progress_title: "پیشرفت پروانه",
    progress_summary:
      "{{done}} از {{total}} ترکیب پردازش‌شده · {{submitted}} ارسال‌شده · {{failed}} رهاشده",
    progress_current_wave: "اکنون در موج {{wave}}",
    progress_dropped: "{{count}} ترکیب رها شد زیرا تراکنش والد آن‌ها شکست خورد",
    toast_success: "پروانه کامل شد — {{count}} ترکیب ارسال شد",
    toast_partial: "پروانه با خطاها به پایان رسید — {{submitted}} ارسال، {{failed}} رهاشده",
    toast_failed: "پروانه شکست خورد",
    gate_owned_in_flight:
      "تمام جعبه‌های شما هنوز از یک تراکنش قبلی در پرواز هستند. منتظر بلاک بعدی بمانید و دوباره تلاش کنید.",
  },
};

const localeFiles = Object.keys(FANOUT).map((code) => ({
  code,
  path: resolve(LOCALES_DIR, `${code}.json`),
}));

let totalUpdates = 0;
for (const { code, path } of localeFiles) {
  const raw = await readFile(path, "utf8");
  const data = JSON.parse(raw);
  const before = JSON.stringify(data);
  data.fanout = { ...(data.fanout ?? {}), ...FANOUT[code] };
  const after = JSON.stringify(data);
  if (before !== after) {
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
    totalUpdates += 1;
    console.log(`translate-fanout: updated ${code}.json`);
  }
}

console.log(`translate-fanout: ${totalUpdates} locale(s) updated.`);
