import { describe, expect, test } from "bun:test";
import { createElement } from "../../ui/node_modules/react";
import { renderToStaticMarkup } from "../../ui/node_modules/react-dom/server";
import { setActiveInputSession, useInputPastes } from "../../ui/src/inputStore";

function renderDraft(sessionId: string) {
  let draft!: ReturnType<typeof useInputPastes>;
  function Composer() {
    draft = useInputPastes(sessionId);
    return createElement("span", null, draft[0].map((paste) => paste.text).join("\n"));
  }
  renderToStaticMarkup(createElement(Composer));
  return draft;
}

describe("composer paste drafts", () => {
  test("switching chats isolates chips and returning restores them after remount", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const paste = { id: "paste-a", text: "large pasted content\n".repeat(30) };
    renderDraft(a)[1]([paste]);

    expect(renderDraft(b)[0]).toEqual([]);
    renderDraft(b)[1]([{ id: "paste-b", text: "another chat's content" }]);
    expect(renderDraft(a)[0]).toEqual([paste]);
    expect(renderDraft(b)[0].map((entry) => entry.id)).toEqual(["paste-b"]);
    renderDraft(a)[1]([]);
    renderDraft(b)[1]([]);
  });

  test("an in-flight send clears its own chips even after the active chat changes", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const [, finishSendA] = renderDraft(a);
    finishSendA([{ id: "a", text: "send from A" }]);
    const pasteB = { id: "b", text: "keep in B" };
    renderDraft(b)[1]([pasteB]);
    setActiveInputSession(b);

    finishSendA([]);

    expect(renderDraft(a)[0]).toEqual([]);
    expect(renderDraft(b)[0]).toEqual([pasteB]);
    renderDraft(b)[1]([]);
    setActiveInputSession(null);
  });

  test("appending and removing chips uses the latest draft and preserves exact text", () => {
    const id = crypto.randomUUID();
    const [, setPastes] = renderDraft(id);
    const first = { id: "first", text: "<xml> & whitespace\n\n" };
    const second = { id: "second", text: "second paste" };
    setPastes((previous) => [...previous, first]);
    setPastes((previous) => [...previous, second]);
    expect(renderDraft(id)[0]).toEqual([first, second]);

    // Both the X and "insert as text" remove only the selected chip.
    setPastes((previous) => previous.filter((paste) => paste.id !== first.id));
    expect(renderDraft(id)[0]).toEqual([second]);
    setPastes([]);
    expect(renderDraft(id)[0]).toEqual([]);
  });
});
