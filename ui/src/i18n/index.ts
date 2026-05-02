import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";
import { isSupportedLang, langMeta, SUPPORTED_LANG_CODES, type LangCode } from "./languages.js";

const STORAGE_KEY = "lovejoin/lang/v1";

// Only English ships eagerly — it's the canonical fallback and the
// initial UI text for ~half of visitors. The other 19 locales ride in
// their own per-language chunks emitted by Vite, fetched only when the
// user actively switches (or has previously persisted a non-EN choice).
//
// Earlier this file imported all 20 JSON bundles eagerly, which dropped
// ~600 KB of locale data into the initial JS chunk and showed up as
// "Reduce unused JavaScript" in PageSpeed. Per-locale chunks land in
// well under 100ms each, so the language change feels instant once the
// app is interactive.
//
// `import.meta.glob` matches every JSON in the directory (Vite globs
// don't support negative patterns), so en.json shows up here too. We
// never call its loader — `loadedLocales` starts seeded with "en" so
// the resource bundle for English is the one statically imported. The
// duplicate static-and-dynamic match emits a Vite build warning that
// the dynamic import won't move EN into its own chunk; that's exactly
// what we want, since EN is already in the entry chunk for free.
const lazyLocaleLoaders = import.meta.glob<{ default: Record<string, unknown> }>(
  "./locales/*.json",
);

const loadedLocales: Set<LangCode> = new Set(["en"]);

async function loadLocaleResource(code: LangCode): Promise<void> {
  if (loadedLocales.has(code)) return;
  const path = `./locales/${code}.json`;
  const loader = lazyLocaleLoaders[path];
  if (!loader) return;
  const mod = await loader();
  i18n.addResourceBundle(code, "translation", mod.default, true, true);
  loadedLocales.add(code);
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

// i18next is initialized synchronously with English only so the first
// React render has a working `t()` immediately — no flash of empty
// strings. If the user's preferred language isn't English, we kick off
// its bundle load below and switch when it lands. The hero is also
// inlined as static English HTML in index.html, so non-EN users see
// EN → preferred-lang exactly once on first paint and never again.
void i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: [...SUPPORTED_LANG_CODES],
  interpolation: {
    escapeValue: false,
  },
});

applyDocumentLangDir("en");

if (initialLang !== "en") {
  // Don't block module init on the per-locale fetch — let the EN render
  // happen first, then swap. `changeLanguage` no-ops the resource load
  // because we add it via `addResourceBundle` ourselves.
  void loadLocaleResource(initialLang).then(() => i18n.changeLanguage(initialLang));
}

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

/**
 * Switch the active language, fetching its bundle on demand. Used by
 * the LanguageSwitcher; ensures the resource is registered with i18next
 * before the language change fires so the first render in the new
 * locale already has every key.
 */
export async function changeLanguage(code: string): Promise<void> {
  if (!isSupportedLang(code)) return;
  await loadLocaleResource(code);
  await i18n.changeLanguage(code);
}

export default i18n;
