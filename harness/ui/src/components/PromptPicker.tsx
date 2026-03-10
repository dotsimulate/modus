/**
 * PromptPicker — dropdown for injecting prompt templates into the chat input.
 *
 * Shows a "/" button. Clicking it opens a dropdown of available prompt templates.
 * Picking one shows an inline form for its inputs, then renders the template
 * and injects the result into the chat textarea.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchPrompts, renderPromptApi, browsePath, readFileContent } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import { Markdown } from "./Markdown";
import type { PromptListItem, RenderResult } from "../api";

export type PromptSettings = RenderResult["config"]["settings"];

type SkillItem = { name: string; filename: string; path: string };

type Props = {
  onInject: (text: string, settings?: PromptSettings) => void;
  onAutoSend?: (text: string, settings?: PromptSettings) => void;
  /** "up" (default, chat input) or "down" (dashboard) */
  direction?: "up" | "down";
  /** Filter prompts by tag */
  tags?: string[];
};

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(text: string): string {
  const count = Math.ceil(text.length / 4);
  if (count < 1000) return `~${count} tok`;
  return `~${(count / 1000).toFixed(1)}k tok`;
}

export function PromptPicker({ onInject, onAutoSend, direction = "up", tags }: Props) {
  const { activeUP, activeUserProfile } = useProfiles();
  const [open, setOpen] = useState(false);
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selected, setSelected] = useState<PromptListItem | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [tokenEstimate, setTokenEstimate] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [previewSkill, setPreviewSkill] = useState<SkillItem | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const estimateTimer = useRef<ReturnType<typeof setTimeout>>();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSelected(null);
        setPreviewSkill(null);
        setPreviewContent(null);
        setError("");
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Load prompts + skills on open
  useEffect(() => {
    if (!open) return;
    fetchPrompts(tags ? { tags } : undefined).then(setPrompts).catch(() => {});

    // Load skills from project's .claude/skills/
    const paths = activeUP?.projects ?? [];
    if (paths.length > 0) {
      const skillsPath = `${paths[0]}/.claude/skills`;
      browsePath(skillsPath).then(result => {
        if (result?.dirs?.length) {
          const items: SkillItem[] = result.dirs
            .filter(name => !name.startsWith("."))
            .map(name => ({
              filename: name,
              name: name.replace(/-/g, " "),
              path: `${skillsPath}/${name}/SKILL.md`,
            }));
          setSkills(items);
        }
      }).catch(() => setSkills([]));
    }
  }, [open, activeUP]);

  // Focus search on open
  useEffect(() => {
    if (open && !selected) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, selected]);

  // Debounced token estimate when form values change
  useEffect(() => {
    if (!selected) { setTokenEstimate(null); return; }
    if (estimateTimer.current) clearTimeout(estimateTimer.current);
    setEstimating(true);
    estimateTimer.current = setTimeout(async () => {
      const slug = activeUserProfile ?? "";
      const paths = activeUP?.projects ?? [];
      try {
        const { rendered } = await renderPromptApi(selected.name, {
          input: freeText.trim() || undefined,
          project: {
            name: activeUP?.displayName || slug || "project",
            slug,
            paths,
          },
          ...inputValues,
        });
        setTokenEstimate(estimateTokens(rendered));
      } catch {
        setTokenEstimate(null);
      }
      setEstimating(false);
    }, 600);
    return () => { if (estimateTimer.current) clearTimeout(estimateTimer.current); };
  }, [selected, inputValues, freeText, activeUserProfile, activeUP]);

  const handleSelect = useCallback((p: PromptListItem) => {
    setSelected(p);
    const defaults: Record<string, string> = {};
    for (const inp of p.inputs ?? []) {
      if (inp.default) defaults[inp.name] = inp.default;
    }
    setInputValues(defaults);
    setFreeText("");
    setError("");
    setSearch("");
    setTokenEstimate(null);
  }, []);

  const handleSkillSelect = useCallback((skill: SkillItem) => {
    onInject(`/${skill.filename}`);
    setOpen(false);
    setSelected(null);
    setPreviewSkill(null);
    setSearch("");
  }, [onInject]);

  const handleSkillPreview = useCallback(async (skill: SkillItem) => {
    setPreviewSkill(skill);
    setPreviewContent(null);
    setPreviewLoading(true);
    setSearch("");
    const content = await readFileContent(skill.path);
    setPreviewContent(content ?? "could not load skill file");
    setPreviewLoading(false);
  }, []);

  const handleRender = useCallback(async (mode: "inject" | "send") => {
    if (!selected) return;
    setRendering(true);
    setError("");

    const slug = activeUserProfile ?? "";
    const paths = activeUP?.projects ?? [];

    try {
      const { rendered, config } = await renderPromptApi(selected.name, {
        input: freeText.trim() || undefined,
        project: {
          name: activeUP?.displayName || slug || "project",
          slug,
          paths,
        },
        ...inputValues,
      });

      const settings = config?.settings;
      if (mode === "send" && onAutoSend) {
        onAutoSend(rendered, settings);
      } else {
        onInject(rendered, settings);
      }
      setOpen(false);
      setSelected(null);
      setSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "render failed");
    }
    setRendering(false);
  }, [selected, freeText, inputValues, activeUserProfile, activeUP, onInject, onAutoSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleRender("inject");
    }
    if (e.key === "Escape") {
      setOpen(false);
      setSelected(null);
      setSearch("");
    }
  };

  // Filter prompts + skills by search
  const q = search.toLowerCase().trim();
  const filteredPrompts = open && q
    ? prompts.filter(p =>
        p.label.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q))
      )
    : prompts;
  const filteredSkills = open && q
    ? skills.filter(s => s.filename.toLowerCase().includes(q))
    : skills;

  return (
    <div className="prompt-picker-wrap" ref={dropdownRef}>
      <button
        className={`prompt-picker-trigger${open ? " prompt-picker-trigger--hidden" : ""}`}
        onClick={() => setOpen(true)}
        title="Insert prompt template"
      >
        /
      </button>
      {open && (
    <div className={`prompt-picker ${direction === "down" ? "prompt-picker--down" : ""}`}>
      {previewSkill ? (
        /* ── Skill preview ── */
        <div className="prompt-picker-preview">
          <div className="prompt-picker-header">/{previewSkill.filename}</div>
          <div className="prompt-picker-preview-content message-content">
            {previewLoading ? "loading..." : previewContent ? <Markdown content={previewContent} /> : null}
          </div>
          <div className="prompt-picker-actions">
            <button
              className="prompt-picker-btn"
              onClick={() => {
                if (previewContent) onInject(previewContent);
                setOpen(false);
                setPreviewSkill(null);
                setPreviewContent(null);
              }}
            >
              insert content
            </button>
            <span className="prompt-picker-tokens">
              {previewContent ? estimateTokens(previewContent) : ""}
            </span>
            <button
              className="prompt-picker-close"
              onClick={() => { setPreviewSkill(null); setPreviewContent(null); }}
            >
              back
            </button>
          </div>
        </div>
      ) : !selected ? (
        /* ── Prompt + skills list ── */
        <div className="prompt-picker-list">
          {direction === "down" && (
            <div className="prompt-picker-footer prompt-picker-footer--top">
              <input
                ref={searchRef}
                className="prompt-picker-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setOpen(false); setSearch(""); }
                }}
                placeholder="search..."
                spellCheck={false}
              />
              <button
                className="prompt-picker-close"
                onClick={() => setOpen(false)}
              >
                cancel
              </button>
            </div>
          )}
          {filteredPrompts.length === 0 && filteredSkills.length === 0 && (
            <div className="prompt-picker-empty">
              {q ? "no matches" : "no prompts available"}
            </div>
          )}
          {filteredSkills.map(s => (
            <div key={s.filename} className="prompt-picker-item prompt-picker-item--skill">
              <button
                className="prompt-picker-item-main"
                onClick={() => handleSkillSelect(s)}
              >
                <span className="prompt-picker-item-label">/{s.filename}</span>
              </button>
              <button
                className="prompt-picker-preview-btn"
                onClick={() => handleSkillPreview(s)}
                title="Preview skill content"
              >
                preview
              </button>
            </div>
          ))}
          {filteredSkills.length > 0 && filteredPrompts.length > 0 && (
            <div className="prompt-picker-divider" />
          )}
          {filteredPrompts.map(p => (
            <button
              key={p.name}
              className="prompt-picker-item"
              onClick={() => handleSelect(p)}
            >
              <span className="prompt-picker-item-label">{p.label}</span>
              {p.description && (
                <span className="prompt-picker-item-desc">{p.description}</span>
              )}
            </button>
          ))}
          {direction !== "down" && (
            <div className="prompt-picker-footer">
              <input
                ref={searchRef}
                className="prompt-picker-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setOpen(false); setSearch(""); }
                }}
                placeholder="search..."
                spellCheck={false}
              />
              <button
                className="prompt-picker-close"
                onClick={() => setOpen(false)}
              >
                cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        /* ── Input form for selected prompt ── */
        <div className="prompt-picker-form">
          <div className="prompt-picker-header">{selected.label}</div>
          {selected.description && (
            <div className="prompt-picker-desc">{selected.description}</div>
          )}

          {(selected.inputs ?? []).map(inp => {
            const isToggle = inp.type === "toggle" || inp.placeholder?.includes("yes/no");
            const isSelect = inp.type === "select" && inp.options?.length;

            if (isSelect) {
              const current = inputValues[inp.name] ?? inp.default ?? inp.options![0];
              const label = inp.placeholder ?? inp.name;
              return (
                <div key={inp.name} className="prompt-picker-select">
                  <span className="prompt-picker-select-label">{label}</span>
                  <div className="prompt-picker-select-row">
                    {inp.options!.map(opt => (
                      <button
                        key={opt}
                        className={`prompt-picker-select-btn${current === opt ? " active" : ""}`}
                        onClick={() => setInputValues(prev => ({ ...prev, [inp.name]: opt }))}
                        type="button"
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              );
            }

            if (isToggle) {
              const checked = (inputValues[inp.name] ?? inp.default ?? "no") === "yes";
              const label = inp.placeholder?.replace(/\s*\(yes\/no\)\s*/i, "") ?? inp.name;
              return (
                <label key={inp.name} className="prompt-picker-toggle">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setInputValues(prev => ({
                      ...prev,
                      [inp.name]: e.target.checked ? "yes" : "",
                    }))}
                  />
                  <span>{label}</span>
                </label>
              );
            }

            return (
              <input
                key={inp.name}
                className="prompt-picker-input"
                value={inputValues[inp.name] ?? ""}
                onChange={(e) => setInputValues(prev => ({ ...prev, [inp.name]: e.target.value }))}
                onKeyDown={handleKeyDown}
                placeholder={inp.placeholder ?? inp.name}
                autoFocus={selected.inputs?.[0]?.name === inp.name}
                spellCheck={false}
              />
            );
          })}

          <textarea
            className="prompt-picker-textarea"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="additional context..."
            rows={2}
            spellCheck={false}
            autoFocus={!selected.inputs?.length}
          />

          {error && <div className="prompt-picker-error">{error}</div>}

          <div className="prompt-picker-actions">
            <button
              className="prompt-picker-btn"
              onClick={() => handleRender("inject")}
              disabled={rendering}
            >
              {rendering ? "..." : "insert"}
            </button>
            <span className="prompt-picker-tokens">
              {estimating ? "..." : tokenEstimate ?? ""}
            </span>
            {onAutoSend && (
              <button
                className="prompt-picker-btn prompt-picker-btn--send"
                onClick={() => handleRender("send")}
                disabled={rendering}
              >
                {rendering ? "..." : "send"}
              </button>
            )}
            <button
              className="prompt-picker-close"
              onClick={() => { setSelected(null); setError(""); setTokenEstimate(null); }}
            >
              back
            </button>
          </div>
        </div>
      )}
    </div>
      )}
    </div>
  );
}
