import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ブラウザからは 5173 だけ見えればよい。
// リモートからは Tailscale の IP で開く。http の IP はマイクが使えないので、
// Chrome の unsafely-treat-insecure-origin-as-secure にその origin を登録する（README 参照）

// server/src/index.ts と同じ PORT を見る。プロキシ先とサーバの実際の起動ポートが
// ずれると繋がらないので一致させる必要がある。既定の 8787 は他プロジェクトの
// wrangler dev が掴んでいることがあるので、その場合は両方を別ポートにずらす
const PORT = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: [".ts.net"],
    proxy: {
      "/audio": { target: `ws://localhost:${PORT}`, ws: true },
      "/api": { target: `http://localhost:${PORT}` },
    },
  },
});
