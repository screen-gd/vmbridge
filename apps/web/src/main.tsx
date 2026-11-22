import "@fontsource-variable/mona-sans";
import "@fontsource/fragment-mono";
import { NuqsAdapter } from "nuqs/adapters/react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <NuqsAdapter>
    <App />
  </NuqsAdapter>,
);
