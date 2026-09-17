import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ブラウザからは 5173 だけ見えればよい。
// マイクは安全なコンテキストでしか使えないので、リモートからは `tailscale serve` の HTTPS か SSH の転送で開く
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [".ts.net"],
    proxy: {
      "/audio": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787" },
    },
  },
});
