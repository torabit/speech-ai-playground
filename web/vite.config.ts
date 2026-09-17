import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ブラウザからは 5173 だけ見えればよい。SSH の転送も 1 ポートで済む
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/audio": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787" },
    },
  },
});
