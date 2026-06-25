import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js pulls in `buffer`, which expects Node's `global`.
  define: {
    global: "globalThis",
  },
  server: {
    port: 5173,
    open: true,
  },
});
