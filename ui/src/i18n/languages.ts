// Registry of supported UI languages. Each entry pairs a BCP-47 code with
// the language's *native* name (what users actually scan for in a picker)
// and a `dir` flag so the document can flip to RTL when appropriate.
//
// We target the world's ten most-spoken languages. English is canonical
// (ui/src/i18n/locales/en.json); the others are translations that fall
// back to English for any missing keys.

export type LangCode =
  | "en"
  | "zh"
  | "hi"
  | "es"
  | "fr"
  | "ar"
  | "bn"
  | "ru"
  | "pt"
  | "ur"
  | "ja"
  | "ko"
  | "tr";

export interface LangMeta {
  code: LangCode;
  nativeName: string;
  englishName: string;
  dir: "ltr" | "rtl";
}

export const LANGUAGES: readonly LangMeta[] = [
  { code: "en", nativeName: "English",    englishName: "English",    dir: "ltr" },
  { code: "zh", nativeName: "中文",        englishName: "Chinese",    dir: "ltr" },
  { code: "hi", nativeName: "हिन्दी",       englishName: "Hindi",      dir: "ltr" },
  { code: "es", nativeName: "Español",    englishName: "Spanish",    dir: "ltr" },
  { code: "fr", nativeName: "Français",   englishName: "French",     dir: "ltr" },
  { code: "ar", nativeName: "العربية",     englishName: "Arabic",     dir: "rtl" },
  { code: "bn", nativeName: "বাংলা",       englishName: "Bengali",    dir: "ltr" },
  { code: "ru", nativeName: "Русский",    englishName: "Russian",    dir: "ltr" },
  { code: "pt", nativeName: "Português",  englishName: "Portuguese", dir: "ltr" },
  { code: "ur", nativeName: "اردو",        englishName: "Urdu",       dir: "rtl" },
  { code: "ja", nativeName: "日本語",      englishName: "Japanese",   dir: "ltr" },
  { code: "ko", nativeName: "한국어",      englishName: "Korean",     dir: "ltr" },
  { code: "tr", nativeName: "Türkçe",     englishName: "Turkish",    dir: "ltr" },
] as const;

export const SUPPORTED_LANG_CODES: readonly LangCode[] =
  LANGUAGES.map((l) => l.code);

export function isSupportedLang(code: string): code is LangCode {
  return (SUPPORTED_LANG_CODES as readonly string[]).includes(code);
}

export function langMeta(code: LangCode): LangMeta {
  const found = LANGUAGES.find((l) => l.code === code);
  if (!found) throw new Error(`unknown lang: ${code}`);
  return found;
}
