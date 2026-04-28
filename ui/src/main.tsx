import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/polyfill.js";
import { App } from "./App.js";
import "./i18n/index.js";
// Self-hosted fonts (SIL OFL) — replaces the Google Fonts CDN link
// that previously sat in index.html. CLAUDE.md is loud about no
// telemetry / no cookies; loading fonts from googleapis.com leaked
// every visitor's IP on first paint.
import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/tailwind.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
