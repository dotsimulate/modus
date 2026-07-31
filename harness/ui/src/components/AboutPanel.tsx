/**
 * AboutPanel — the one rendering of build identity and help content.
 *
 * Mounted by three surfaces: the `about` dashboard widget, the docs page, and
 * user settings. All of them render this component against GET /api/about, so
 * adding a help topic or a link in harness/about.ts reaches every surface at
 * once and none of them can drift.
 */

import { useEffect, useState } from "react";
import { API_BASE, authHeaders } from "../modusClient";

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

export default function AboutPanel({ onOpenDoc }: { onOpenDoc?: (docId: string) => void }) {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

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
            {topic.docId && onOpenDoc && (
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
            {link.href.startsWith("https://") ? (
              <a
                className="about-link"
                href={link.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                {link.label}
              </a>
            ) : (
              <span className="about-link about-link--inert">{link.label}</span>
            )}
            <span className="about-link-description">{link.description}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
