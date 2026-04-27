import { useTranslation } from "react-i18next";

export function App() {
  const { t } = useTranslation();
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <section className="max-w-xl text-center">
        <h1 className="text-4xl font-bold tracking-tight">{t("app.title")}</h1>
        <p className="mt-4 text-gray-600">{t("app.tagline")}</p>
        <p className="mt-8 text-sm text-gray-500">{t("app.status")}</p>
      </section>
    </main>
  );
}
