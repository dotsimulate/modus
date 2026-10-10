import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

// Opt in with MODUS_TEST_BROWSER pointing to a Chromium executable. Uses only
// static fixtures and a temporary browser profile; never starts Modus.
const executablePath = process.env.MODUS_TEST_BROWSER;
const styles = ["theme.css", "layout.css", "components/panels.css", "components/chat-scroll-spine.css"]
  .map(file => readFileSync(resolve(import.meta.dir, "../../ui/src/styles", file), "utf8").replace(/^@import.*$/gm, ""))
  .join("\n");

// The markup ChatView renders inside a scrolling layout leaf, with the spine's
// widest marker (the current turn's rung) drawn.
const chat = `<div class="panel-surface-item-body panel-surface-item-body--leaf">
  <div class="chat-scroll-wrapper">
    <div class="chat-scroll-row" data-indicator="spine">
      <div class="chat-messages"><div class="chat-messages-content">${"<p>Message</p>".repeat(80)}</div></div>
      <div class="chat-scroll-spine"><div class="chat-scroll-spine-axis"><div class="chat-scroll-rung is-current" style="top:50%"></div></div></div>
    </div>
    <div class="scroll-to-bottom visible"><div class="scroll-to-bottom-inner">v</div></div>
  </div>
</div>`;

describe.skipIf(!executablePath)("chat scroll spine in a layout leaf", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath, headless: true, timeout: 15_000 });
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
  }, 20_000);

  afterAll(async () => { await browser?.close(); });

  test("the spine's overhang does not give the leaf a horizontal scrollbar", async () => {
    await page.setContent(`<style>${styles}</style><div style="height:400px;width:600px;display:flex;flex-direction:column">${chat}</div>`);
    const leaf = await page.$eval(".panel-surface-item-body", element => ({
      overflowX: element.scrollWidth - element.clientWidth,
      scrollbar: element.getBoundingClientRect().height - element.clientHeight,
    }));
    expect(leaf.overflowX).toBe(0);
    expect(leaf.scrollbar).toBe(0);
    expect(await page.$eval(".chat-messages", element => element.scrollHeight > element.clientHeight)).toBe(true);
  });
});
