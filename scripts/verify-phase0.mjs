// Phase 0 の検証。ヘッドレス Chromium に 440Hz のサイン波を偽マイクとして流す。
//
// 前提
// - `npm run dev:web` が起動している（:5173）
// - `npm run dev:server` は止めておく。サーバはこのスクリプトが起動し、途中で落とす
// - ffmpeg と Playwright の Chromium がある（CHROME_PATH で上書き可）
//
// 実行: npm run verify:phase0

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(import.meta.dirname, "..");
const APP_URL = "http://localhost:5173/";
const TONE_HZ = 440;
const RECORD_SEC = 3;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const chromePath = process.env.CHROME_PATH ?? findPlaywrightChromium();
const workDir = mkdtempSync(join(tmpdir(), "verify-phase0-"));
const tone = join(workDir, "tone.wav");
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${TONE_HZ}:sample_rate=48000:duration=10`, "-ac", "1", tone]);

let server = startServer();
await waitForPort();

const browser = await chromium.launch({
  executablePath: chromePath,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${tone}`],
});
const page = await browser.newPage();
page.setDefaultTimeout(5000);
const status = () => page.textContent("[data-testid=status]");
const waitStatus = (s, timeout = 5000) =>
  page.waitForSelector(`[data-testid=status]:text-is("${s}")`, { timeout }).then(() => true, () => false);

try {
  await page.goto(APP_URL);

  // 1. 正常系: 録音してサーバに wav が保存される
  const before = listRecordings();
  await page.click("text=Start");
  check("Start で ready になる", await waitStatus("ready"), `status=${await status()}`);
  await page.waitForTimeout(RECORD_SEC * 1000);
  const frames = Number(await page.textContent("[data-testid=frames]"));
  check(`${RECORD_SEC} 秒で約 ${RECORD_SEC * 50} フレーム送る`, Math.abs(frames - RECORD_SEC * 50) <= 20, `frames=${frames}`);
  await page.click("text=Stop");
  check("Stop で idle に戻る", await waitStatus("idle"), `status=${await status()}`);

  await page.waitForTimeout(500);
  const created = listRecordings().filter((f) => !before.includes(f));
  check("wav が 1 つ保存される", created.length === 1, `new=${created.length}`);
  if (created.length === 1) {
    const wav = parseWav(readFileSync(join(ROOT, "recordings", created[0])));
    check("16000Hz / mono / 16bit", wav.sampleRate === 16000 && wav.channels === 1 && wav.bits === 16, JSON.stringify({ ...wav, samples: undefined }));
    check(`長さが約 ${RECORD_SEC} 秒`, Math.abs(wav.durationSec - RECORD_SEC) < 0.5, `${wav.durationSec.toFixed(2)}s`);
    const hz = estimateFrequency(wav.samples, wav.sampleRate);
    check(`音程が ${TONE_HZ}Hz 付近（サンプルレートの取り違えがない）`, Math.abs(hz - TONE_HZ) < 20, `${hz.toFixed(1)}Hz`);
  }

  // 2. 異常系: 送信中にサーバが落ちたら failed になる
  await page.click("text=Start");
  await waitStatus("ready");
  server.kill();
  check("サーバ停止で failed になる", await waitStatus("failed"), `status=${await status()}`);
  const reason = await page.textContent(".error").catch(() => null);
  check("失敗理由が表示される", !!reason?.trim(), reason ?? "no .error element");
} catch (e) {
  // UI が未実装などで操作自体ができない場合、そこで打ち切って FAIL として報告する
  check("検証を最後まで実行できる", false, e instanceof Error ? e.message.split("\n")[0] : String(e));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

function startServer() {
  const child = spawn("node", ["src/index.ts"], { cwd: join(ROOT, "server"), stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) console.error(`server exited with ${code}. dev:server が :8787 を使っていないか確認する`);
  });
  return child;
}

async function waitForPort() {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch("http://localhost:8787/");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start on :8787");
}

function listRecordings() {
  const dir = join(ROOT, "recordings");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wav")) : [];
}

function parseWav(buf) {
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  const samples = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);
  return { sampleRate, channels, bits, durationSec: samples.length / sampleRate, samples };
}

// ゼロ交差の回数から周波数を推定する。サイン波なら 1 周期に 2 回交差する
function estimateFrequency(samples, sampleRate) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 !== samples[i] < 0) crossings++;
  return crossings / 2 / (samples.length / sampleRate);
}

function findPlaywrightChromium() {
  const cache = join(process.env.HOME, ".cache/ms-playwright");
  const dir = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  if (!dir) throw new Error("Playwright の Chromium が見つからない。CHROME_PATH を指定する");
  return join(cache, dir, "chrome-linux64/chrome");
}
