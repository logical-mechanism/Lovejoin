// Language picker — a native `<select>` so a11y, keyboard, mobile, and
// long native names all just work. Native names render in their own
// scripts (中文, हिन्दी, العربية, …) so users find their language without
// needing to know the English label first.
//
// The selected code is persisted by the i18n loader (see
// ../i18n/index.ts), which also flips the document `lang` + `dir` so RTL
// scripts (Arabic, Urdu) render correctly.

import { useTranslation } from "react-i18next";

import { LANGUAGES, isSupportedLang } from "../i18n/languages.js";
import { changeLanguage } from "../i18n/index.js";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = isSupportedLang(i18n.resolvedLanguage ?? "")
    ? i18n.resolvedLanguage!
    : "en";

  return (
    <label className="lj-lang">
      <span className="sr-only">{t("language.aria_label")}</span>
      <select
        className="lj-lang__select"
        value={current}
        onChange={(e) => {
          const next = e.target.value;
          if (isSupportedLang(next)) void changeLanguage(next);
        }}
        aria-label={t("language.aria_label")}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.nativeName}
          </option>
        ))}
      </select>
    </label>
  );
}
