import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import { isSupportedLang, langMeta, SUPPORTED_LANG_CODES, type LangCode } from "./languages.js";

const STORAGE_KEY = "lovejoin/lang/v1";

// Locale bundles are loaded eagerly via Vite's glob import. Each locale is
// JSON, so this adds a couple of KB per language to the bundle. That's
// acceptable for ten languages and avoids the loading-state churn that
// async locale fetching would introduce on every route mount. If the
// bundle ever feels heavy, swap to `import.meta.glob(..., { eager: false })`
// and lazy-load on language change.
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "./locales/*.json",
  { eager: true },
);

const resources: Record<string, { translation: Record<string, unknown> }> = {
  en: { translation: en },
};
for (const [path, mod] of Object.entries(localeModules)) {
  const match = /\/([a-z]{2})\.json$/.exec(path);
  if (!match) continue;
  const code = match[1];
  if (!isSupportedLang(code)) continue;
  if (code === "en") continue;
  resources[code] = { translation: mod.default };
}

function detectInitialLang(): LangCode {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && isSupportedLang(stored)) return stored;
  } catch {
    /* localStorage may be unavailable; fall back to navigator */
  }
  const nav = window.navigator?.language?.toLowerCase().split("-")[0];
  if (nav && isSupportedLang(nav)) return nav;
  return "en";
}

const initialLang = detectInitialLang();

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLang,
  fallbackLng: "en",
  supportedLngs: [...SUPPORTED_LANG_CODES],
  interpolation: {
    escapeValue: false,
  },
});

applyDocumentLangDir(initialLang);

i18n.on("languageChanged", (lng: string) => {
  if (!isSupportedLang(lng)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore storage failures */
  }
  applyDocumentLangDir(lng);
});

function applyDocumentLangDir(code: LangCode) {
  if (typeof document === "undefined") return;
  const meta = langMeta(code);
  document.documentElement.lang = code;
  document.documentElement.dir = meta.dir;
}

export default i18n;
