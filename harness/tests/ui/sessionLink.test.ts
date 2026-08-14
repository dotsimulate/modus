import { describe, expect, it } from "bun:test";
import { buildSessionLink } from "../../ui/src/sessionLink";

const ID = "2f3c9a10-4b7e-4c81-9d55-0e1a2b3c4d5e";

describe("buildSessionLink", () => {
  it("emits the registered scheme on the desktop, with no project", () => {
    // The deep-link grammar rejects a project on a session link because the id
    // already determines one — see desktop/src-tauri/src/deep_link.rs.
    expect(buildSessionLink({ sessionId: ID, project: "modus", desktop: true }))
      .toBe(`modus://session/${ID}`);
  });

  it("emits a fragment URL in the browser, where modus:// is not registered", () => {
    expect(buildSessionLink({
      sessionId: ID,
      project: "modus",
      desktop: false,
      base: "http://localhost:3777/",
    })).toBe(`http://localhost:3777/#modus/${ID}`);
  });

  it("keeps a tailnet origin intact so the link works off this machine", () => {
    expect(buildSessionLink({
      sessionId: ID,
      project: "modus",
      desktop: false,
      base: "https://box.tailnet.ts.net/",
    })).toBe(`https://box.tailnet.ts.net/#modus/${ID}`);
  });

  it("drops the profile segment when there is no project, matching buildHash", () => {
    expect(buildSessionLink({ sessionId: ID, project: null, desktop: false, base: "http://x/" }))
      .toBe(`http://x/#${ID}`);
  });

  it("does not stack fragments when the current URL already has one", () => {
    expect(buildSessionLink({
      sessionId: ID,
      project: "modus",
      desktop: false,
      base: "http://localhost:3777/#other/old-session",
    })).toBe(`http://localhost:3777/#modus/${ID}`);
  });
});
