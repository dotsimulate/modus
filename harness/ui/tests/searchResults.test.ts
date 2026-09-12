import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchResults } from "../src/components/sidebar/SearchResults";

const props = {
  results: [], searching: false, error: null, hasMore: false,
  activeSessionId: null, onSelectSession: () => {}, onLoadMore: () => {}, onRetry: () => {},
};

test("search failure is visible with retry and is not reported as no matches", () => {
  const html = renderToStaticMarkup(createElement(SearchResults, { ...props, error: "offline" }));
  expect(html).toContain('role="alert"');
  expect(html).toContain("Retry");
  expect(html).not.toContain("no results");
});

test("results are keyboard buttons with safe snippets and Windows project labels", () => {
  const html = renderToStaticMarkup(createElement(SearchResults, {
    ...props, hasMore: true,
    results: [{ session_id: "example", preview: "Example", snippet: "<script>bad()</script>", profile: "helper", model: null, cwd: "C:\\projects\\example\\", last_message_at: 1000, total_cost_usd: 0 }],
  }));
  expect(html).toContain('class="session-item search-result-item');
  expect(html).toContain('<button type="button"');
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain('class="session-project-tag">example</span>');
  expect(html).toContain("Show more");
});
