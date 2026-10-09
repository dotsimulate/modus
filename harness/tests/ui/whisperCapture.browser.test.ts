import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from "../../ui/extensions/whisper-transcribe.js";

// Opt in with MODUS_TEST_BROWSER pointing to a Chromium executable. Serves one
// static page from an ephemeral loopback port (AudioWorklet needs a secure
// context) and uses a temporary browser profile; never starts Modus.
const executablePath = process.env.MODUS_TEST_BROWSER;

describe.skipIf(!executablePath)("whisper capture in Chromium", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("<!doctype html><title>capture</title>", { headers: { "content-type": "text/html" } }),
    });
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      timeout: 15_000,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
  }, 20_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  test("worklet capture stays continuous while the page's main thread is blocked", async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const result = await page.evaluate(async (source: string, name: string) => {
      const context = new AudioContext();
      const rate = context.sampleRate;
      // A looping one-second ramp: every sample says where it is, so a dropped
      // or repeated stretch shows up as a step that is not 1/rate.
      const ramp = context.createBuffer(1, rate, rate);
      const data = ramp.getChannelData(0);
      for (let i = 0; i < rate; i++) data[i] = i / rate;
      const signal = context.createBufferSource();
      signal.buffer = ramp;
      signal.loop = true;

      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const worklet = new AudioWorkletNode(context, name, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: "explicit",
        processorOptions: { blockSize: 4096 },
      });
      const workletBlocks: Float32Array[] = [];
      let flushed: (() => void) | null = null;
      worklet.port.onmessage = (event) => {
        if (event.data?.flushed) return flushed?.();
        workletBlocks.push(event.data.channels[0]);
      };

      // The node the extension used before, on the same signal, for comparison.
      const script = context.createScriptProcessor(4096, 2, 1);
      const scriptBlocks: Float32Array[] = [];
      script.onaudioprocess = (event) => { scriptBlocks.push(event.inputBuffer.getChannelData(0).slice()); };

      signal.connect(worklet);
      signal.connect(script);
      worklet.connect(context.destination);
      script.connect(context.destination);
      await context.resume();
      signal.start();

      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      await sleep(500);
      const clockBefore = context.currentTime;
      // What a long render or a large tool result does to the page.
      const until = performance.now() + 1500;
      while (performance.now() < until) { /* busy */ }
      const clockAdvanced = context.currentTime - clockBefore;
      await sleep(600);
      await new Promise<void>((resolve) => {
        flushed = resolve;
        worklet.port.postMessage("flush");
      });
      await context.close();

      const breaks = (blocks: Float32Array[]) => {
        let count = 0;
        let previous: number | null = null;
        let samples = 0;
        for (const block of blocks) {
          for (const value of block) {
            samples++;
            if (previous !== null) {
              const step = value - previous;
              const wrapped = step < 0 ? step + 1 : step;
              if (Math.abs(wrapped - 1 / rate) > 1e-5) count++;
            }
            previous = value;
          }
        }
        return { count, samples };
      };
      return { rate, clockAdvanced, worklet: breaks(workletBlocks), scriptProcessor: breaks(scriptBlocks) };
    }, CAPTURE_WORKLET_SOURCE, CAPTURE_PROCESSOR);
    await page.close();

    // Reported, not asserted: how the old path fares is Chromium's business,
    // but it is what this capture path exists to beat.
    console.log(`[whisper capture] clock advanced ${result.clockAdvanced.toFixed(2)}s during the block; worklet ${result.worklet.count} breaks in ${result.worklet.samples} samples; scriptProcessor ${result.scriptProcessor.count} breaks in ${result.scriptProcessor.samples} samples`);
    // The audio clock ran through the block, so there was audio to lose.
    expect(result.clockAdvanced).toBeGreaterThan(1);
    expect(result.worklet.samples).toBeGreaterThan(result.rate * 2);
    expect(result.worklet.count).toBe(0);
  }, 30_000);
});
