// Run only a dedicated smoke binary with a unique Tauri identifier and no URL
// scheme registration. See desktop/README.md. Playwright is loaded from a
// separate temporary tools install; it is not a product dependency.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  assert(index >= 0 && args[index + 1], `${name} is required`);
  return resolve(args[index + 1]);
};
const executable = option("--exe");
assert.equal(basename(executable), "modus-file-open-smoke.exe", "refusing a normal desktop executable");
assert(readFileSync(executable).includes(Buffer.from("com.modus.file-open-smoke")), "build the dedicated smoke identifier first; refusing a production identifier");
const repo = option("--repo");
const packaged = args.includes("--package") ? option("--package") : undefined;
const resources = packaged ? join(packaged, "modus") : join(repo, "harness");
const server = join(resources, packaged ? "server.js" : "index.ts");
assert(readFileSync(server).length > 0, "backend entry is missing or empty");
const bun = option("--bun");
const { chromium } = await import(pathToFileURL(option("--playwright")).href);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "modus-file-open-e2e-")));
console.log(`Test root: ${root}`);
const project = join(root, "project");
const nested = join(project, "nested");
const external = join(root, "external");
const home = join(root, "home");
for (const dir of [nested, external, join(home, "profiles", "users")]) mkdirSync(dir, { recursive: true });
mkdirSync(join(project, ".modus", "pages"), { recursive: true });
writeFileSync(join(project, ".modus", "pages", "without-editor.json"), JSON.stringify({
  id: "without-editor", title: "Without editor", fullscreen: true,
  layout: { kind: "widget", widget: { type: "docs" } },
}));
writeFileSync(join(home, "profiles", "_users.json"), JSON.stringify({ name: "File open test" }));
for (const [name, displayName, path] of [["project", "Project", project], ["nested", "Nested project", nested]]) {
  writeFileSync(join(home, "profiles", "users", `${name}.json`), JSON.stringify({ name, displayName, projects: [path] }));
}
const first = join(nested, "notes with spaces.MD");
const second = join(external, "outside.markdown");
const plain = join(external, "plain.txt");
writeFileSync(first, "# Desktop Markdown\n\n**Rendered preview**\n\n[Sibling](sibling.md)\n\n![Local image](pixel.png)\n\n```mermaid\nflowchart LR\n  File --> Preview\n```\n\n<script>window.fileOpenInjected = true</script>\n");
writeFileSync(join(nested, "sibling.md"), "# Sibling document\n");
writeFileSync(join(nested, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
writeFileSync(second, "# Outside project\n\nExternal Markdown document.\n");
writeFileSync(plain, "Plain text preview\n");
writeFileSync(join(external, "program.exe"), "not an executable");
writeFileSync(join(root, "fake-tailscale.cmd"), "@exit /b 1\r\n");

const portProbe = createServer();
portProbe.listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
const env = Object.fromEntries(["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]
  .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, {
  MODUS_HOME: home,
  HARNESS_SECRETS_FILE: join(root, "secrets.env"),
  MODUS_DESKTOP_SERVER: server,
  MODUS_DESKTOP_RESOURCES_DIR: resources,
  MODUS_DESKTOP_BUN: bun,
  MODUS_DESKTOP_MODE: "managed-local",
  MODUS_DESKTOP_SMOKE_QUIT_MS: "180000",
  MODUS_TAILSCALE_CLI: join(root, "fake-tailscale.cmd"),
  WEBVIEW2_USER_DATA_FOLDER: join(root, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  NODE_ENV: "test",
});
for (const [key, dir] of Object.entries({
  MODUS_CONFIG_DIR: "config", MODUS_DATA_DIR: "data", MODUS_LOGS_DIR: "logs",
  MODUS_RUNTIME_DIR: "runtime", MODUS_CACHE_DIR: "cache", XDG_CONFIG_HOME: "xdg-config",
  XDG_DATA_HOME: "xdg-data", XDG_CACHE_HOME: "xdg-cache",
})) env[key] = join(root, dir);

const desktop = spawn(executable, [first], { cwd: project, env, windowsHide: true });
let output = "";
desktop.stdout.on("data", (data) => { output += data; });
desktop.stderr.on("data", (data) => { output += data; });
let browser;
let page;
const waitFor = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert(Date.now() < deadline, `timed out: ${label}\n${output.slice(-3000)}`);
    await new Promise((done) => setTimeout(done, 100));
  }
};
const forward = async (...paths) => {
  const child = spawn(executable, paths, { cwd: external, env, windowsHide: true });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "second launch did not forward to the first instance");
};
try {
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
  }, "WebView2 debugging endpoint");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (error) => { output += `\npageerror: ${error.message}`; });
  const heading = (text) => page.locator(".fcv-markdown h1:visible").filter({ hasText: text });
  await heading("Desktop Markdown").waitFor({ timeout: 30000 });
  assert.equal(await page.locator(".fcv-markdown strong:visible").textContent(), "Rendered preview");
  await waitFor(async () => /Nested project/.test(await page.locator(".fcv-location:visible").textContent()), "project recognition");
  assert.equal(await page.evaluate(() => window.fileOpenInjected), undefined);
  await waitFor(() => page.locator('img[alt="Local image"]:visible').evaluate((image) => image.complete && image.naturalWidth > 0), "file-relative image");
  await page.locator('.fcv-markdown .mermaid-diagram svg:visible').waitFor();
  await page.screenshot({ path: join(root, "markdown-preview.png") });
  await page.locator('.fcv-markdown a:visible').filter({ hasText: "Sibling" }).click();
  await heading("Sibling document").waitFor();
  const sessionId = await page.evaluate(async (cwd) => {
    const params = new URLSearchParams(location.search);
    const token = localStorage.getItem(`harness_token:${encodeURIComponent(params.get("modusTargetId"))}`);
    const response = await fetch(`${params.get("modusTarget")}/api/sessions/empty`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cwd, userProfile: "project" }),
    });
    if (!response.ok) throw new Error(`empty session creation failed (${response.status})`);
    return (await response.json()).sessionId;
  }, project);
  const restored = page.waitForResponse((response) => response.url().endsWith(`/api/ui/sessions/${sessionId}/state`));
  await page.evaluate((id) => { location.hash = `project/${id}`; }, sessionId);
  await restored;
  const hash = await page.evaluate(() => location.hash);
  await forward(second);
  await heading("Outside project").waitFor();
  assert.match(await page.locator(".fcv-location:visible").textContent(), /External file/);
  assert.equal(await page.evaluate(() => location.hash), hash, "file open changed the route or session");
  await forward(second);
  assert.equal(await page.locator('.cw-tab-label:visible').filter({ hasText: "outside.markdown" }).count(), 1);
  await forward(first, plain);
  await page.locator('.cm-content:visible').filter({ hasText: "Plain text preview" }).waitFor();
  await forward(join(external, "program.exe"), join(external, "missing.md"));
  assert.equal(await page.locator('.cw-tab-label:visible').filter({ hasText: "program.exe" }).count(), 0);
  assert.equal(await page.locator('.cw-tab-label:visible').filter({ hasText: "missing.md" }).count(), 0);
  await forward(second);
  await heading("Outside project").waitFor();
  await page.locator('.fcv-actions button[title="Edit file"]:visible').click();
  const editor = page.locator('.right-panel-editor .cm-content:visible');
  await editor.waitFor();
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.insertText("\nSaved from desktop test");
  await waitFor(async () => (await editor.textContent()).includes("Saved from desktop test"), "editor input");
  await page.locator('.fcv-actions button[aria-label="Save file"]:visible').click();
  await waitFor(() => readFileSync(second, "utf8").includes("Saved from desktop test"), "saved edit");
  await page.locator('.fcv-actions button[title="Switch to view"]:visible').click();
  await heading("Outside project").waitFor();

  // Hold tab restoration while an OS request arrives during a webview reload.
  // A later hydration must not erase the newly opened file.
  await page.route(`**/api/ui/sessions/${sessionId}/state`, async (route) => {
    await new Promise((done) => setTimeout(done, 750));
    await route.continue();
  });
  const restoredAfterReload = page.waitForResponse((response) => response.url().endsWith(`/api/ui/sessions/${sessionId}/state`));
  await page.reload();
  await forward(first);
  await restoredAfterReload;
  await heading("Desktop Markdown").waitFor();
  assert.equal(await page.evaluate(() => location.hash), hash, "startup open changed the selected session");
  await page.unrouteAll({ behavior: "wait" });

  // A custom fullscreen page without an editor still gets a file surface.
  await page.evaluate((id) => { location.hash = `project/page:without-editor/${id}`; }, sessionId);
  await page.locator('.docs-widget:visible').waitFor();
  await forward("outside.markdown");
  await page.locator('.desktop-file-viewer-popup .fcv-markdown h1').filter({ hasText: "Outside project" }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#project/page:without-editor/${sessionId}`);
  await page.screenshot({ path: join(root, "floating-preview.png") });

  await page.reload();
  await page.locator('.app').waitFor();
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("desktop_has_pending_files")), false, "reload replayed a claimed file");
  await page.screenshot({ path: join(root, "desktop-file-open.png") });
  console.log("PASS: native cold start, second-instance forwarding, multiple files, duplicate tabs, project recognition, external Markdown, Mermaid rendering, relative links/images, script sanitization, unsupported/missing files, edit/save, selected-session preservation, delayed startup hydration, fullscreen fallback, relative launch paths, and no replay.");
} catch (error) {
  if (page) {
    writeFileSync(join(root, "failure.html"), await page.content().catch(() => ""));
    await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (page) await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_modus")).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (desktop.exitCode === null) await Promise.race([once(desktop, "exit"), new Promise((done) => setTimeout(done, 5000))]);
  if (desktop.exitCode === null) desktop.kill();
  writeFileSync(join(root, "desktop.log"), output);
  console.log(`Artifacts: ${root}`);
}
