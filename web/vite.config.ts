import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ブラウザからは 5173 だけ見えればよい。
// リモートからは Tailscale の IP で開く。http の IP はマイクが使えないので、
// Chrome の unsafely-treat-insecure-origin-as-secure にその origin を登録する（README 参照）
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      "/audio": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787" },
    },
  },
});
