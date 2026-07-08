import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ command }) => ({
  base: "/",
  plugins: [
    react(),
  ],
  clearScreen: false,
  server: {
    port: 1925,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1926,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  optimizeDeps: {
    force: command === "serve",
  },
  build: {
    modulePreload: false,
  },
}));
