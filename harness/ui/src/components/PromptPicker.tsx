/**
 * PromptPicker — dropdown for injecting prompt templates into the chat input.
 *
 * Shows a "/" button. Clicking it opens a dropdown of available prompt templates.
 * Picking one shows an inline form for its inputs, then renders the template
 * and injects the result into the chat textarea.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { Markdown } from "./Markdown";
import { estimateTokens } from "../utils/tokens";
import type { PromptListItem, RenderResult, MoveListItem, ActivateMoveResult, ProviderSlashCommand, SkillListItem } from "../../../sdk/index";
import {
  MoveInputFields,
  buildMoveInputs,
  isMoveInputReady,
  stringifyDefault,
  useMoveInputResolver,
} from "./MoveInputFields";

export type PromptSettings = RenderResult["config"]["settings"];

/**
 * A skill offered in the picker, from either of two systems that coexist:
 *
 * - `native` — the user's own `.claude/skills/`, read by the provider itself.
 *   Only listed when the session's provider actually reads them; selecting one
 *   types `/name` and lets the provider load it. Modus never touches these.
 * - `modus` — installed under `.modus/skills/`, works on every provider.
 *   Selecting one injects the SKILL.md text, since the harness is the loader.
 */
type SkillItem = {
  name: string;
  filename: string;
  path: string;
  source: "native" | "modus";
  description?: string;
  origin?: SkillListItem["origin"];
};
type SelectedItem =
  | { kind: "prompt"; item: PromptListItem }
  | { kind: "move"; item: MoveListItem }
  | null;

type Props = {
  onInject: (text: string, settings?: PromptSettings) => void;
  onAutoSend?: (text: string, settings?: PromptSettings) => void;
  onMoveActivated?: (result: ActivateMoveResult) => void;
  onMoveAttach?: (move: MoveListItem, inputs: Record<string, unknown>) => void;
  /** Stage a Modus skill on the composer. Falls back to raw injection when absent. */
  onSkillAttach?: (name: string, text: string) => void;
  /** "up" (default, chat input) or "down" (dashboard) */
  direction?: "up" | "down";
  /** Filter prompts by tag */
  tags?: string[];
  /** Active session context — optional for project-scoped branch/background moves */
  sessionId?: string;
  projectCwd?: string;
  userProfile?: string;
  provider?: string;
  /** External control: increment to force the picker open */
  forceOpen?: number;
  /** Notify parent when open state changes */
  onOpenChange?: (open: boolean) => void;
};

export function PromptPicker({
  onInject, onAutoSend, onMoveActivated, onMoveAttach, onSkillAttach, direction = "up", tags,
  sessionId, projectCwd, userProfile, provider, forceOpen, onOpenChange,
}: Props) {
  const { activeUP, activeUserProfile, profiles, providerCapabilities } = useProfiles();
  const [open, setOpen] = useState(false);
  const lastForceOpen = useRef(0);

  // Notify parent on open state changes
  const setOpenAndNotify = useCallback((v: boolean) => {
    setOpen(v);
    onOpenChange?.(v);
  }, [onOpenChange]);

  // Sync forceOpen prop → open the picker
  useEffect(() => {
    if (forceOpen && forceOpen !== lastForceOpen.current) {
      lastForceOpen.current = forceOpen;
      setOpenAndNotify(true);
    }
  }, [forceOpen, setOpenAndNotify]);
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [moves, setMoves] = useState<MoveListItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [selected, setSelected] = useState<SelectedItem>(null);
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
  const estimateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenAndNotify(false);
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
    modus.listPrompts(tags ? { tags } : undefined).then(setPrompts).catch(() => {});
    if (projectCwd) {
      modus.listMoves(projectCwd).then(setMoves).catch(() => setMoves([]));
    } else {
      setMoves([]);
    }

    // Skills come from two systems. Native skills are only listed when this
    // session's provider actually reads them — on codex, cursor and the rest
    // they would be dead entries. Modus skills work on every provider.
    const paths = activeUP?.projects ?? [];
    const nativeRoot = paths.length > 0 ? `${paths[0]}/.claude/skills` : null;
    // Hide native skills only when we positively know this provider ignores
    // them. With no session provider (the dashboard picker) or capabilities not
    // loaded yet, keep listing them rather than silently dropping entries.
    const caps = provider ? providerCapabilities[provider] : undefined;
    const wantsNative = nativeRoot !== null && (caps ? caps.readsNativeSkills !== false : true);

    Promise.all([
      wantsNative
        ? modus.browse(nativeRoot).then(result => (result?.dirs ?? [])
            .filter(name => !name.startsWith("."))
            .map((name): SkillItem => ({
              filename: name,
              name: name.replace(/-/g, " "),
              path: `${nativeRoot}/${name}/SKILL.md`,
              source: "native",
            }))).catch(() => [])
        : Promise.resolve([] as SkillItem[]),
      projectCwd
        ? modus.listSkills(projectCwd).then(items => items.map((skill): SkillItem => ({
            filename: skill.name,
            name: skill.name.replace(/-/g, " "),
            path: `${skill.dir}/SKILL.md`,
            source: "modus",
            description: skill.description,
            origin: skill.origin,
          }))).catch(() => [])
        : Promise.resolve([] as SkillItem[]),
    ]).then(([native, modusSkills]) => {
      // One list, one namespace. A native skill wins its name so a user's own
      // file is never shadowed by an installed one — the same rule PI applies.
      const taken = new Set(native.map(skill => skill.filename));
      setSkills([...native, ...modusSkills.filter(skill => !taken.has(skill.filename))]);
    });
  }, [open, activeUP, projectCwd, sessionId, tags, provider, providerCapabilities]);

  // Focus search on open
  useEffect(() => {
    if (open && !selected) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open, selected]);

  // Debounced token estimate when form values change
  useEffect(() => {
    if (!selected || selected.kind !== "prompt") { setTokenEstimate(null); return; }
    if (estimateTimer.current) clearTimeout(estimateTimer.current);
    setEstimating(true);
    estimateTimer.current = setTimeout(async () => {
      const slug = activeUserProfile ?? "";
      const paths = activeUP?.projects ?? [];
      try {
        const { rendered } = await modus.renderPrompt(selected.item.name, {
          inputs: { ...inputValues, text: freeText.trim() || undefined },
          project: {
            name: activeUP?.displayName || slug || "project",
            slug,
            paths,
          },
        });
        setTokenEstimate(estimateTokens(rendered));
      } catch {
        setTokenEstimate(null);
      }
      setEstimating(false);
    }, 600);
    return () => { if (estimateTimer.current) clearTimeout(estimateTimer.current); };
  }, [selected, inputValues, freeText, activeUserProfile, activeUP]);

  const resolveProfileNames = useCallback(() => {
    const names = activeUP?.agentProfiles?.length
      ? activeUP.agentProfiles
      : profiles.map((profile) => profile.name);
    return ["Current profile", ...names];
  }, [activeUP?.agentProfiles, profiles]);

  const handlePromptSelect = useCallback((p: PromptListItem) => {
    setSelected({ kind: "prompt", item: p });
    const defaults: Record<string, string> = {};
    for (const inp of p.inputs ?? []) {
      if (inp.default !== undefined) defaults[inp.name] = stringifyDefault(inp.default);
    }
    setInputValues(defaults);
    setFreeText("");
    setError("");
    setSearch("");
    setTokenEstimate(null);
  }, []);

  const handleMoveSelect = useCallback((move: MoveListItem) => {
    setSelected({ kind: "move", item: move });
    const defaults: Record<string, string> = {};
    for (const input of move.inputs ?? []) {
      if (input.default !== undefined) defaults[input.name] = stringifyDefault(input.default);
    }
    setInputValues(defaults);
    setFreeText("");
    setError("");
    setSearch("");
    setTokenEstimate(null);
  }, []);

  const handleSkillSelect = useCallback(async (skill: SkillItem) => {
    setOpenAndNotify(false);
    setSelected(null);
    setPreviewSkill(null);
    setSearch("");
    if (skill.source === "native") {
      // The provider owns discovery for its own skills; typing the command is
      // exactly what a user would do outside Modus.
      onInject(`/${skill.filename}`);
      return;
    }
    // No provider will resolve `/name` for a Modus skill, so the harness loads
    // it. The user choosing it is the disclosure decision, so send the whole
    // thing rather than announcing it and hoping the model asks. It is staged
    // as a chip instead of dropped into the textarea — the user did not type
    // it, and several skills need to stack.
    const loaded = projectCwd ? await modus.getSkill(skill.filename, projectCwd) : null;
    if (!loaded) {
      setError(`could not load skill "${skill.filename}"`);
      return;
    }
    if (onSkillAttach) onSkillAttach(skill.filename, loaded.text);
    else onInject(loaded.text);
  }, [onInject, onSkillAttach, projectCwd, setOpenAndNotify]);

  const handleSkillPreview = useCallback(async (skill: SkillItem) => {
    setPreviewSkill(skill);
    setPreviewContent(null);
    setPreviewLoading(true);
    setSearch("");
    const content = await modus.readFile(skill.path);
    setPreviewContent(content ?? "could not load skill file");
    setPreviewLoading(false);
  }, []);

  const handleSlashCommandSelect = useCallback((command: ProviderSlashCommand) => {
    const text = command.requiresArgument ? `${command.command} ` : command.command;
    setOpenAndNotify(false);
    setSelected(null);
    setPreviewSkill(null);
    setSearch("");
    if (command.requiresArgument || !onAutoSend) {
      onInject(text);
    } else {
      onAutoSend(text);
    }
  }, [onAutoSend, onInject, setOpenAndNotify]);

  const sendRawSlashCommand = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const cmd = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    setOpenAndNotify(false);
    setSelected(null);
    setSearch("");
    if (onAutoSend) onAutoSend(cmd);
    else onInject(cmd);
  }, [onAutoSend, onInject, setOpenAndNotify]);

  const selectedPrompt = selected?.kind === "prompt" ? selected.item : null;
  const selectedMove = selected?.kind === "move" ? selected.item : null;
  const selectedPromptInputs = (selectedPrompt?.inputs ?? []).map((input) => ({
    ...input,
    type: input.type ?? "text",
  }));
  const { resolveInputOptions, dynamicLoading } = useMoveInputResolver({
    inputs: selectedMove?.inputs,
    values: inputValues,
    profileNames: resolveProfileNames(),
    projectCwd,
    userProfile: userProfile ?? activeUserProfile ?? undefined,
    allowedProjectPaths: activeUP?.projects,
  });
  const moveReady = selectedMove
    ? isMoveInputReady(selectedMove, inputValues, resolveInputOptions, dynamicLoading)
    : false;

  const handleRender = useCallback(async (mode: "inject" | "send") => {
    if (!selected || selected.kind !== "prompt") return;
    setRendering(true);
    setError("");

    const slug = activeUserProfile ?? "";
    const paths = activeUP?.projects ?? [];

    try {
      const { rendered, config } = await modus.renderPrompt(selected.item.name, {
        inputs: { ...inputValues, text: freeText.trim() || undefined },
        project: {
          name: activeUP?.displayName || slug || "project",
          slug,
          paths,
        },
      });

      const settings = config?.settings;
      if (mode === "send" && onAutoSend) {
        onAutoSend(rendered, settings);
      } else {
        onInject(rendered, settings);
      }
      setOpenAndNotify(false);
      setSelected(null);
      setSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "render failed");
    }
    setRendering(false);
  }, [selected, freeText, inputValues, activeUserProfile, activeUP, onInject, onAutoSend]);

  const handleActivateMove = useCallback(async () => {
    if (!selected || selected.kind !== "move" || !projectCwd) return;
    setRendering(true);
    setError("");
    try {
      const body = {
        moveName: selected.item.name,
        inputs: buildMoveInputs(selected.item, inputValues, resolveInputOptions),
        cwd: projectCwd,
        userProfile: userProfile ?? activeUserProfile ?? undefined,
      };
      const result = sessionId
        ? await modus.activateMove(sessionId, body)
        : await modus.activateProjectMove({ ...body, forceNewSession: true });
      onMoveActivated?.(result);
      setOpenAndNotify(false);
      setSelected(null);
      setSearch("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "move activation failed");
    }
    setRendering(false);
  }, [
    activeUserProfile,
    inputValues,
    onMoveActivated,
    projectCwd,
    resolveInputOptions,
    selected,
    sessionId,
    setOpenAndNotify,
    userProfile,
  ]);


  const handleAttachMove = useCallback(() => {
    if (!selected || selected.kind !== "move") return;
    const inputs = buildMoveInputs(selected.item, inputValues, resolveInputOptions);
    onMoveAttach?.(selected.item, inputs);
    setOpenAndNotify(false);
    setSelected(null);
    setSearch("");
  }, [selected, inputValues, resolveInputOptions, onMoveAttach, setOpenAndNotify]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (selected?.kind === "move") { if (selected.item.persistent) handleActivateMove(); else if (onMoveAttach) handleAttachMove(); else handleActivateMove(); }
      else handleRender("inject");
    }
    if (e.key === "Escape") {
      setOpenAndNotify(false);
      setSelected(null);
      setSearch("");
    }
  };

  // Filter prompts + skills by search
  const q = search.toLowerCase().trim();
  const effectiveProvider = provider ?? activeUP?.provider;
  const slashCommands = effectiveProvider
    ? (providerCapabilities[effectiveProvider]?.slashCommands ?? [])
    : [];
  const filteredSlashCommands = open && q
    ? slashCommands.filter((command) =>
        command.command.toLowerCase().includes(q)
        || command.label.toLowerCase().includes(q)
        || command.argumentHint?.toLowerCase().includes(q)
        || command.description?.toLowerCase().includes(q)
      )
    : slashCommands;
  const filteredMoves = open && q
    ? moves.filter((move) =>
        move.label.toLowerCase().includes(q)
        || move.name.toLowerCase().includes(q)
        || move.description.toLowerCase().includes(q)
      )
    : moves;
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
        onClick={() => setOpenAndNotify(true)}
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
                setOpenAndNotify(false);
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
                  if (e.key === "Escape") { setOpenAndNotify(false); setSearch(""); }
                  if (e.key === "Enter" && !e.shiftKey && search.trim() && filteredSlashCommands.length === 0 && filteredMoves.length === 0 && filteredPrompts.length === 0 && filteredSkills.length === 0) {
                    e.preventDefault();
                    sendRawSlashCommand(search);
                  }
                }}
                placeholder="search..."
                spellCheck={false}
              />
              <button
                className="prompt-picker-close"
                onClick={() => setOpenAndNotify(false)}
              >
                cancel
              </button>
            </div>
          )}
          {filteredSlashCommands.length === 0 && filteredMoves.length === 0 && filteredPrompts.length === 0 && filteredSkills.length === 0 && (
            <div className="prompt-picker-empty">
              {q ? <>no matches - <kbd>enter</kbd> to send {search.trim().startsWith("/") ? search.trim() : `/${search.trim()}`}</> : "no commands, prompts, or moves available"}
            </div>
          )}
          {filteredSlashCommands.length > 0 && (
            <div className="prompt-picker-section-label">commands</div>
          )}
          {filteredSlashCommands.map(command => (
            <button
              key={`${effectiveProvider ?? "provider"}:${command.label}:${command.command}`}
              className="prompt-picker-item"
              onClick={() => handleSlashCommandSelect(command)}
            >
              <span className="prompt-picker-item-row">
                <span className="prompt-picker-item-label">
                  {command.label}{command.argumentHint ? ` ${command.argumentHint}` : ""}
                </span>
                <span className="prompt-picker-item-meta">{command.source ?? "provider"}</span>
              </span>
              {command.description && (
                <span className="prompt-picker-item-desc">{command.description}</span>
              )}
            </button>
          ))}
          {filteredSlashCommands.length > 0 && (filteredMoves.length > 0 || filteredSkills.length > 0 || filteredPrompts.length > 0) && (
            <div className="prompt-picker-divider" />
          )}
          {filteredMoves.length > 0 && (
            <div className="prompt-picker-section-label">moves</div>
          )}
          {filteredMoves.map(move => (
            <button
              key={move.name}
              className="prompt-picker-item"
              onClick={() => handleMoveSelect(move)}
            >
              <span className="prompt-picker-item-row">
                <span className="prompt-picker-item-label">{move.label}</span>
                <span className="prompt-picker-item-meta">{move.mode ?? "inline"}</span>
              </span>
              <span className="prompt-picker-item-desc">{move.description}</span>
            </button>
          ))}
          {filteredMoves.length > 0 && (filteredSkills.length > 0 || filteredPrompts.length > 0) && (
            <div className="prompt-picker-divider" />
          )}
          {filteredSkills.length > 0 && (
            <div className="prompt-picker-section-label">skills</div>
          )}
          {filteredSkills.map(s => (
            <div key={s.filename} className="prompt-picker-item prompt-picker-item--skill">
              <button
                className="prompt-picker-item-main"
                onClick={() => handleSkillSelect(s)}
              >
                <span className="prompt-picker-item-label">
                  /{s.filename}
                  {s.source === "modus" && (
                    <span className="prompt-picker-item-meta">{s.origin}</span>
                  )}
                </span>
                {s.description && (
                  <span className="prompt-picker-item-desc">{s.description}</span>
                )}
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
          {filteredPrompts.length > 0 && (
            <div className="prompt-picker-section-label">prompts</div>
          )}
          {filteredPrompts.map(p => (
            <button
              key={p.name}
              className="prompt-picker-item"
              onClick={() => handlePromptSelect(p)}
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
                  if (e.key === "Escape") { setOpenAndNotify(false); setSearch(""); }
                  if (e.key === "Enter" && !e.shiftKey && search.trim() && filteredSlashCommands.length === 0 && filteredMoves.length === 0 && filteredPrompts.length === 0 && filteredSkills.length === 0) {
                    e.preventDefault();
                    sendRawSlashCommand(search);
                  }
                }}
                placeholder="search..."
                spellCheck={false}
              />
              <button
                className="prompt-picker-close"
                onClick={() => setOpenAndNotify(false)}
              >
                cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        /* ── Input form for selected prompt or move ── */
        <div className="prompt-picker-form">
          <div className="prompt-picker-header">{selectedPrompt?.label ?? selectedMove?.label}</div>
          {(selectedPrompt?.description || selectedMove?.description) && (
            <div className="prompt-picker-desc">{selectedPrompt?.description ?? selectedMove?.description}</div>
          )}

          {selectedMove && (
            <MoveInputFields
              inputs={selectedMove.inputs ?? []}
              values={inputValues}
              profileNames={resolveProfileNames()}
              projectCwd={projectCwd}
              userProfile={userProfile ?? activeUserProfile ?? undefined}
              allowedProjectPaths={activeUP?.projects}
              onChange={(name, value) => setInputValues(prev => ({ ...prev, [name]: value }))}
              variant="prompt-picker"
              autoFocusFirst={true}
              onKeyDown={handleKeyDown}
            />
          )}

          {selectedPrompt && selectedPromptInputs.length > 0 && (
            <MoveInputFields
              inputs={selectedPromptInputs}
              values={inputValues}
              profileNames={resolveProfileNames()}
              onChange={(name, value) => setInputValues(prev => ({ ...prev, [name]: value }))}
              variant="prompt-picker"
              autoFocusFirst={true}
              onKeyDown={handleKeyDown}
            />
          )}

          {selectedPrompt && (
            <textarea
              className="prompt-picker-textarea"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="additional context..."
              rows={2}
              spellCheck={false}
              autoFocus={selectedPromptInputs.length === 0}
            />
          )}

          {error && <div className="prompt-picker-error">{error}</div>}

          <div className="prompt-picker-actions">
            {selectedPrompt ? (
              <>
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
              </>
            ) : (
              <button
                className="prompt-picker-btn prompt-picker-btn--send"
                onClick={selected?.kind === "move" && selected.item.persistent ? handleActivateMove : onMoveAttach ? handleAttachMove : handleActivateMove}
                disabled={rendering || !moveReady}
              >
                {rendering ? "..." : selected?.kind === "move" && selected.item.persistent ? "activate" : onMoveAttach ? "attach" : "run move"}
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
