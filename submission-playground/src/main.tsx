import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { clearStaleDevCookies } from "./clearDevCookies";
import "./styles.css";

clearStaleDevCookies();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
