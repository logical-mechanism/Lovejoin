import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./i18n/index.js";
import "./styles/tailwind.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
