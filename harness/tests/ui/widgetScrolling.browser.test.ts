import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

// Opt in with MODUS_TEST_BROWSER pointing to a Chromium executable. Uses only
// static fixtures and a temporary browser profile; never starts Modus.
const executablePath = process.env.MODUS_TEST_BROWSER;
const styles = ["theme.css", "components/panels.css", "components/widgets.css", "components/profile-panel.css", "components/processes-widget.css"]
  .map(file => readFileSync(resolve(import.meta.dir, "../../ui/src/styles", file), "utf8").replace(/^@import.*$/gm, ""))
  .join("\n");
const rows = `<div class="proc-widget">${Array.from({ length: 30 }, (_, i) =>
  `<div class="proc-row"><div class="proc-row-main">Process ${i + 1}<div class="proc-row-meta">Recent activity</div></div></div>`,
).join("")}</div>`;

function viewport(mode: "tabs" | "list" | "leaf", content = rows) {
  return `<div class="panel-surface-item-body panel-surface-item-body--${mode}"${mode === "list" ? ' style="height:220px"' : ""}>${content}</div>`;
}

describe.skipIf(!executablePath)("widget scroll layout in Chromium", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath, headless: true, timeout: 15_000 });
    page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
  }, 20_000);

  afterAll(async () => { await browser?.close(); });

  async function render(content: string) {
    await page.setContent(`<style>${styles}</style><div style="height:300px;width:360px;display:flex;flex-direction:column">${content}</div>`);
  }

  const layouts: Record<string, string> = {
    "right panel tab": `<div class="right-panel-body"><div class="right-panel-content">${viewport("tabs")}</div></div>`,
    "left panel tab": `<div class="left-panel-content"><div class="lp-tabs">Tabs</div>${viewport("tabs")}</div>`,
    "list card": `<div class="right-panel-content"><div class="widget"><button class="widget-header">Processes</button><div class="panel-collapse panel-collapse--open"><div class="panel-collapse-clip">${viewport("list")}</div></div></div></div>`,
    "standalone leaf": viewport("leaf"),
    "split leaf": `<div class="panel-split panel-split--vertical"><div class="panel-split-child" style="flex:1">${viewport("leaf")}</div></div>`,
    "grid leaf": `<div style="display:grid;height:100%;grid-template-rows:minmax(0,1fr)"><div style="min-height:0">${viewport("leaf")}</div></div>`,
    "overlay base leaf": `<div class="panel-overlay"><div class="panel-overlay-layer">${viewport("leaf")}</div></div>`,
  };

  for (const [name, content] of Object.entries(layouts)) {
    test(`${name} scrolls to the final process using the wheel`, async () => {
      await render(content);
      const box = await page.$eval(".panel-surface-item-body", element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, height: rect.height, overflow: getComputedStyle(element).overflowY };
      });
      expect(box.height).toBeLessThanOrEqual(300);
      expect(box.overflow).toBe("auto");
      await page.mouse.move(box.x, box.y);
      await page.mouse.wheel({ deltaY: 10_000 });
      await page.waitForFunction(() => {
        const element = document.querySelector(".panel-surface-item-body")!;
        return element.scrollTop > 0 && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
      }, { timeout: 3000 });
      const visible = await page.$eval(".proc-row:last-child", element => {
        const rect = element.getBoundingClientRect();
        const viewport = element.closest(".panel-surface-item-body")!.getBoundingClientRect();
        return rect.top >= viewport.top && rect.bottom <= viewport.bottom + 1;
      });
      expect(visible).toBe(true);
    });
  }

  test("plain authored content needs no overflow styles of its own", async () => {
    await render(viewport("leaf", `<div>${"<p>Authored content</p>".repeat(100)}</div>`));
    await page.$eval(".panel-surface-item-body", element => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
    expect(await page.$eval(".panel-surface-item-body", element => element.scrollTop)).toBeGreaterThan(0);
  });

  test("auto-sized split sections keep their content height", async () => {
    await render(`<div class="panel-split panel-split--vertical"><div class="panel-split-child panel-split-child--auto">${viewport("leaf", '<div style="height:48px">Controls</div>')}</div><div class="panel-split-child" style="flex:1">${viewport("leaf")}</div></div>`);
    expect(await page.$eval(".panel-split-child--auto", element => element.getBoundingClientRect().height)).toBe(48);
    expect(await page.$eval(".panel-split-child:last-child", element => element.getBoundingClientRect().height)).toBe(252);
  });

  for (const mode of ["tabs", "leaf"] as const) {
    test(`${mode} preserves an internal scroller and a fixed toolbar`, async () => {
      await render(viewport(mode, `<div style="display:flex;flex-direction:column;height:100%;overflow:hidden"><div id="toolbar" style="flex-shrink:0">Toolbar</div><div id="inner" style="flex:1;min-height:0;overflow:auto">${rows}</div></div>`));
      const toolbarTop = await page.$eval("#toolbar", element => element.getBoundingClientRect().top);
      await page.$eval("#inner", element => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
      expect(await page.$eval("#inner", element => element.scrollTop)).toBeGreaterThan(0);
      expect(await page.$eval(".panel-surface-item-body", element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      expect(await page.$eval("#toolbar", element => element.getBoundingClientRect().top)).toBe(toolbarTop);
    });
  }

  test("smooth scrolling respects both system and app reduced motion", async () => {
    await render(viewport("leaf"));
    const behavior = () => page.$eval(".panel-surface-item-body", element => getComputedStyle(element).scrollBehavior);
    expect(await behavior()).toBe("smooth");
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    expect(await behavior()).toBe("auto");
    await page.emulateMediaFeatures([]);
    await page.evaluate(() => { document.documentElement.dataset.reducedMotion = "true"; });
    expect(await behavior()).toBe("auto");
  });
});
