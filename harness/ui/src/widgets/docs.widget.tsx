/**
 * Docs widget — in-app reader for the built-in documentation set.
 *
 * Left: search box + audience filter + doc list (or search hits).
 * Right: selected doc rendered as markdown.
 * Data: GET /api/docs (index), GET /api/docs/<id> (content),
 *       POST /api/docs/search ({ queries: [q] } — batch API, single query here).
 */

import { useCallback, useEffect, useState } from "react";
import { API_BASE, authHeaders } from "../modusClient";
import { Markdown } from "../components/Markdown";
import type { WidgetProps } from "./types";

type DocEntry = {
  id: string;
  title: string;
  summary: string;
  audience: "user" | "dev" | "agent";
  lastUpdated?: string;
  generated?: boolean;
};

type DocSearchHit = {
  id: string;
  title: string;
  score: number;
  snippets: Array<{ line: number; text: string }>;
};

type Audience = "all" | "user" | "dev" | "agent";

const AUDIENCE_TABS: Audience[] = ["all", "user", "dev", "agent"];

function docPath(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/");
}

export default function DocsWidget(_props: WidgetProps) {
  const [entries, setEntries] = useState<DocEntry[]>([]);
  const [audience, setAudience] = useState<Audience>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ id: string; title: string; content: string } | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/docs`, { headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (active && Array.isArray(data)) setEntries(data);
      })
      .catch((err) => {
        if (active) setError(`failed to load docs: ${err?.message ?? err}`);
      });
    return () => { active = false; };
  }, []);

  const openDoc = useCallback((id: string) => {
    setSelectedId(id);
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/docs/${docPath(id)}`, { headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) => setDoc(data))
      .catch((err) => setError(`failed to load doc: ${err?.message ?? err}`))
      .finally(() => setLoading(false));
  }, []);

  const runSearch = useCallback(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/api/docs/search`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ queries: [q], limit: 10, audience }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) => setHits(data?.results?.[0]?.results ?? []))
      .catch((err) => setError(`search failed: ${err?.message ?? err}`))
      .finally(() => setLoading(false));
  }, [query, audience]);

  const visible = audience === "all" ? entries : entries.filter((e) => e.audience === audience);

  return (
    <div className="docs-widget">
      <div className="docs-widget-sidebar">
        <input
          className="docs-widget-search"
          type="text"
          value={query}
          placeholder="search docs..."
          onChange={(e) => {
            setQuery(e.target.value);
            if (!e.target.value.trim()) setHits(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") runSearch();
          }}
        />
        <div className="docs-widget-audiences">
          {AUDIENCE_TABS.map((a) => (
            <button
              key={a}
              className={`docs-widget-audience ${audience === a ? "docs-widget-audience--active" : ""}`}
              onClick={() => setAudience(a)}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="docs-widget-list">
          {hits !== null ? (
            hits.length === 0 ? (
              <div className="docs-widget-empty">no matches</div>
            ) : (
              hits.map((hit) => (
                <button
                  key={hit.id}
                  className={`docs-widget-item ${selectedId === hit.id ? "docs-widget-item--active" : ""}`}
                  onClick={() => openDoc(hit.id)}
                >
                  <span className="docs-widget-item-title">{hit.title}</span>
                  {hit.snippets[0] && (
                    <span className="docs-widget-item-summary">{hit.snippets[0].text}</span>
                  )}
                </button>
              ))
            )
          ) : (
            visible.map((entry) => (
              <button
                key={entry.id}
                className={`docs-widget-item ${selectedId === entry.id ? "docs-widget-item--active" : ""}`}
                onClick={() => openDoc(entry.id)}
              >
                <span className="docs-widget-item-title">
                  {entry.title}
                  {entry.generated && <span className="docs-widget-item-badge">generated</span>}
                </span>
                {entry.summary && (
                  <span className="docs-widget-item-summary">{entry.summary}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
      <div className="docs-widget-reader">
        {error && <div className="docs-widget-error">{error}</div>}
        {loading && <div className="docs-widget-empty">loading...</div>}
        {!loading && !doc && !error && (
          <div className="docs-widget-empty">select a doc to read</div>
        )}
        {!loading && doc && <Markdown content={doc.content} />}
      </div>
    </div>
  );
}
