import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const __dirname = fileURLToPath(new URL(".", import.meta.url));

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
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        aiPanel: resolve(__dirname, "ai-panel.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // Konva 标注引擎单独成块：体积最大，业务代码改动不应使其缓存失效
            if (id.includes("/konva") || id.includes("react-konva")) {
              return "vendor-konva";
            }
            // React 框架层：几乎不变，长期缓存
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
          }
        },
      },
    },
  },
}));
