import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.API_TARGET || "http://localhost:8787";

  const proxy = {
    "/api": { target: apiTarget, changeOrigin: true },
    "/ws": { target: apiTarget, ws: true, changeOrigin: true },
  };

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy,
    },
    preview: {
      port: 4173,
      proxy,
    },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
