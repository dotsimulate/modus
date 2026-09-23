/**
 * AboutPanel — the one rendering of build identity and help content.
 *
 * Mounted by three surfaces: the `about` dashboard widget, the docs page, and
 * user settings. All of them render this component against GET /api/about, so
 * adding a help topic or a link in harness/about.ts reaches every surface at
 * once and none of them can drift.
 */

import { useEffect, useState, type MouseEvent } from "react";
import { API_BASE, authHeaders } from "../modusClient";
import { Markdown } from "./Markdown";
import { customPageView } from "../views";
import { isSessionId } from "../sessionIds";

export type AboutLink = { label: string; href: string; description: string };
export type HelpTopic = { title: string; body: string; docId?: string };
export type AboutInfo = {
  name: string;
  version: string;
  versionSource: "desktop" | "unknown";
  license: string;
  links: AboutLink[];
  topics: HelpTopic[];
};

/**
 * The version line users are asked to quote in a bug report. A browser-only run
 * is not stamped by any build, so it says so instead of showing a number that
 * would point at the wrong build.
 */
export function versionLabel(info: Pick<AboutInfo, "version" | "versionSource">): string {
  return info.versionSource === "desktop" ? `Version ${info.version}` : "Development build";
}

/** Keep the active user profile when following the bundled docs page link. */
export function docsPageHash(currentHash: string): string {
  const path = currentHash.replace(/^#\/?/, "").split("?", 1)[0] ?? "";
  const first = path.split("/", 1)[0] ?? "";
  const profile = first && first !== "home" && first !== "chat"
    && !first.startsWith("page:") && !first.startsWith("move-page:") && !isSessionId(first)
    ? first : null;
  return `#${profile ? `${profile}/` : ""}${customPageView("docs")}`;
}

export async function loadAboutDoc(id: string, signal?: AbortSignal): Promise<{ id: string; title: string; content: string }> {
  const path = id.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${API_BASE}/api/docs/${path}`, { headers: authHeaders(), signal });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export function AboutPanelContent({ info, docsHref, onOpenDoc, onOpenDocs }: {
  info: AboutInfo;
  docsHref: string;
  onOpenDoc: (docId: string) => void;
  onOpenDocs?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <>
      <header className="about-header">
        <h2 className="about-title">{info.name}</h2>
        <span className="about-version">{versionLabel(info)}</span>
        <span className="about-license">{info.license}</span>
      </header>

      <section className="about-section">
        <h3 className="about-section-title">Help</h3>
        {info.topics.map((topic) => (
          <article key={topic.title} className="about-topic">
            <h4 className="about-topic-title">{topic.title}</h4>
            <p className="about-topic-body">{topic.body}</p>
            {topic.docId && (
              <button
                type="button"
                className="about-topic-link"
                onClick={() => onOpenDoc(topic.docId!)}
              >
                Read “{topic.docId}”
              </button>
            )}
          </article>
        ))}
      </section>

      <section className="about-section">
        <h3 className="about-section-title">Links</h3>
        {info.links.map((link) => (
          <div key={link.label} className="about-link-row">
            {link.href === "#docs" ? (
              <a className="about-link" href={docsHref} onClick={onOpenDocs}>
                {link.label}
              </a>
            ) : link.href.startsWith("https://") ? (
              <a className="about-link" href={link.href} target="_blank" rel="noreferrer noopener">
                {link.label}
              </a>
            ) : (
              <span className="about-link about-link--inert">{link.label}</span>
            )}
            <span className="about-link-description">{link.description}</span>
          </div>
        ))}
      </section>
    </>
  );
}

export default function AboutPanel({ onOpenDoc, onOpenDocs }: {
  onOpenDoc?: (docId: string) => void;
  onOpenDocs?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ id: string; title: string; content: string } | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedDocId || onOpenDoc) return;
    const controller = new AbortController();
    setDoc(null);
    setDocError(null);
    loadAboutDoc(selectedDocId, controller.signal)
      .then((data) => setDoc(data))
      .catch((err) => {
        if (!controller.signal.aborted) setDocError(`failed to load doc: ${err?.message ?? err}`);
      });
    return () => controller.abort();
  }, [selectedDocId, onOpenDoc]);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/about`, { headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) => { if (active) setInfo(data as AboutInfo); })
      .catch((err) => { if (active) setError(`failed to load: ${err?.message ?? err}`); });
    return () => { active = false; };
  }, []);

  if (error) return <div className="about-panel about-panel--error">{error}</div>;
  if (!info) return <div className="about-panel about-panel--loading">Loading…</div>;

  return (
    <div className="about-panel">
      {selectedDocId && !onOpenDoc ? (
        <div className="docs-widget-reader">
          <button type="button" className="about-topic-link" onClick={() => setSelectedDocId(null)}>Back to About</button>
          {docError && <div className="docs-widget-error">{docError}</div>}
          {!doc && !docError && <div className="docs-widget-empty">loading...</div>}
          {doc && <Markdown content={doc.content} />}
        </div>
      ) : (
        <AboutPanelContent
          info={info}
          docsHref={docsPageHash(window.location.hash)}
          onOpenDoc={onOpenDoc ?? setSelectedDocId}
          onOpenDocs={onOpenDocs}
        />
      )}
    </div>
  );
}
