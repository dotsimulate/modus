import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useId } from "react";
import type { SessionStatus, Attachment, MoveListItem, AmbientMoveInfo, AttachMoveResult, MoveBinding, ActivateMoveResult } from "../../../sdk/index";
import { modus } from "../modusClient";
import { PromptPicker } from "./PromptPicker";
import { AttachedMove, AttachedWidgetContent } from "./QueuedMessage";
import { ComposerMoveForm } from "./ComposerMoveForm";
import type { ComposerMoveFormSource } from "./ComposerMoveForm";
import { pendingProfileAsks, pendingProfileInjections } from "../composer-move-forms";
import type { PendingAsk } from "../composer-move-forms";
import { stageMove, type ComposerMoveAttachment } from "../composer-move-attachments";
import { PasteBlock } from "./PasteBlock";
import type { ComposerAttachResult } from "./MoveWidget";
import { activateComposer, registerComposer, useComposerActions, useComposerToggles } from "../client-extensions";
import { findCompletion, loadPromptCache, usePromptCache } from "../promptCache";
import { dispatchUiIntent, moveActivationResultToIntent, moveAttachResultToIntent } from "../widgets/intents";
import type { PageContextHandle } from "../widgets/types";
import { wrapSkillContext } from "../move-context";
import { useProfiles } from "../providers/ProfileContext";
import type { DeliverMode, SendOpts } from "../providers/SessionContext";

/** In-memory history of sent messages — survives re-renders, cleared on page reload */
const sentHistory: string[] = [];
const MAX_HISTORY = 50;

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const PASTE_CHAR_THRESHOLD = 400;
const PASTE_LINE_THRESHOLD = 6;

type StagedPaste = { id: string; text: string };

/**
 * A skill staged on the composer. The full SKILL.md is held here rather than
 * dropped into the textarea: the user picked it, so it should read as an
 * attachment, not as something they typed. Several can stack.
 */
type StagedSkill = { id: string; name: string; text: string };

/**
 * Skills reach the model as plain text, the same way provider-native skills do.
 * Wrapping each in the fold marker keeps the transcript readable and keeps the
 * copy button returning only what the user wrote.
 */
function serializeSkills(skills: StagedSkill[]): string {
  if (!skills.length) return "";
  return skills.map((s) => wrapSkillContext(s.name, s.text)).join("\n\n");
}

function serializePastes(pastes: StagedPaste[]): string {
  if (!pastes.length) return "";
  return pastes
    .map((p) => {
      const escaped = p.text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<pasted>\n${escaped}\n</pasted>`;
    })
    .join("\n\n");
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: (attachments: Attachment[], textOverride?: string, moves?: MoveBinding[], deliver?: DeliverMode, opts?: SendOpts) => void;
  onStop: () => void;
  sessionStatus: SessionStatus | null;
  disabled: boolean;
  placeholder?: string;
  sessionId?: string;
  projectCwd?: string;
  userProfile?: string;
  /** Agent profile driving this session — the source of its move bindings. */
  agentProfile?: string;
  /**
   * Whether this conversation already has a turn in it. Profile moves inject
   * into the message that starts the session, so the pending-attachment chips
   * are only truthful while this is false.
   */
  sessionHasMessages?: boolean;
  provider?: string;
  onMoveActivated?: (result: ActivateMoveResult) => void;
  /** Called when a mountOnAttach move is attached — widget should be mounted immediately */
  onMoveAttached?: (result: AttachMoveResult) => void;
  /** Called when a mountOnAttach move is detached — widget should be unmounted */
  onMoveDetached?: (apiToken: string) => void;
  pageContext?: PageContextHandle;
  autoFocus?: boolean;
};

/** Read a File as base64 (strip the data: prefix) */
function fileToBase64(file: File): Promise<{ data: string; mediaType: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const data = result.split(",")[1]; // strip "data:image/png;base64,"
      resolve({ data, mediaType: file.type || "image/png", name: file.name || "image" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function ComposerActionIcon({ icon }: { icon?: "mic" | "mic-handsfree" }) {
  if (icon === "mic") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M7 1.75a2 2 0 0 0-2 2v3.5a2 2 0 1 0 4 0v-3.5a2 2 0 0 0-2-2Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3.75 6.75a3.25 3.25 0 0 0 6.5 0M7 10.5v1.75M5.25 12.25h3.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (icon === "mic-handsfree") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        {/* Radio/signal waves — left */}
        <path d="M3.5 3.5c1.5-1.5 3-1.5 4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M1.5 1.5c2.5-2.5 5.5-2.5 7.5 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        {/* Radio/signal waves — right (mirrored) */}
        <path d="M10.5 3.5c-1.5-1.5-3-1.5-4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M12.5 1.5c-2.5-2.5-5.5-2.5-7.5 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        {/* Central dot — signal source */}
        <circle cx="7" cy="6" r="1.5" fill="currentColor" />
        {/* Stem */}
        <line x1="7" y1="7.5" x2="7" y2="11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        {/* Base */}
        <line x1="5" y1="11.5" x2="9" y2="11.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }

  return null;
}

export function ChatInput({
  value, onChange, onSend, onStop,
  sessionStatus, disabled, placeholder, sessionId, projectCwd, userProfile, agentProfile, sessionHasMessages = false, provider, onMoveActivated, onMoveAttached, onMoveDetached, pageContext, autoFocus = false,
}: Props) {
  const autoId = useId();
  const composerId = sessionId ? `composer:${sessionId}` : autoId;
  const ref = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const sessionIdRef = useRef(sessionId);
  const projectCwdRef = useRef(projectCwd);
  const userProfileRef = useRef(userProfile);
  const handleSendRef = useRef<(textOverride?: string) => void>(() => {});
  const composerActions = useComposerActions(composerId);
  const composerToggles = useComposerToggles(composerId);
  const historyIndex = useRef(-1);
  const draft = useRef("");
  const isActive = sessionStatus === "running" || sessionStatus === "starting" || sessionStatus === "interrupting";

  // Whether this provider can deliver a message into a turn already running.
  // Declared by the backend rather than guessed, so the affordance only appears
  // where it does something (see providers/provider-names.ts).
  const { providerCapabilities, activeUP, activeUserProfile, profiles } = useProfiles();
  const canSteer = !!provider && providerCapabilities[provider]?.messageDelivery === "steer";
  const canInterject = isActive && canSteer;

  // Prompt picker slash shortcut
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerForceOpen, setPickerForceOpen] = useState(0);

  // Ghost-text autocomplete against saved prompt cache
  usePromptCache();
  useEffect(() => { void loadPromptCache(); }, []);
  const [promptGhost, setPromptGhost] = useState<string | null>(null);
  const [extensionGhost, setExtensionGhost] = useState<string | null>(null);
  const ghost = extensionGhost ?? promptGhost;
  const ghostRef = useRef<HTMLDivElement>(null);

  const recomputeGhost = useCallback((val: string) => {
    const ta = ref.current;
    const atEnd = !ta || (ta.selectionStart === val.length && ta.selectionEnd === val.length);
    if (!atEnd || !val) { setPromptGhost(null); return; }
    setPromptGhost(findCompletion(val));
  }, []);

  useEffect(() => {
    recomputeGhost(value);
  }, [value, recomputeGhost]);

  const syncGhostScroll = useCallback(() => {
    const ta = ref.current;
    const g = ghostRef.current;
    if (ta && g) g.scrollTop = ta.scrollTop;
  }, []);

  // Attachment state
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pastes, setPastes] = useState<StagedPaste[]>([]);
  const [stagedSkills, setStagedSkills] = useState<StagedSkill[]>([]);
  const shiftHeldRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeldRef.current = true; };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === "Shift") shiftHeldRef.current = false; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
  const [attachedMoves, setAttachedMoves] = useState<ComposerMoveAttachment[]>([]);
  const [moveSendError, setMoveSendError] = useState<string | null>(null);
  const moveSendPending = useRef(false);
  const attachMove = useCallback((item: MoveListItem, inputs: Record<string, unknown>) => {
    setAttachedMoves((prev) => stageMove(prev, { item, inputs }));
    setMoveSendError(null);
  }, []);
  const [widgetContent, setWidgetContent] = useState<{
    moveName: string;
    label: string;
    data?: Record<string, unknown>;
    resolve: (result: ComposerAttachResult) => void;
    reject: (reason: Error) => void;
  } | null>(null);
  const widgetContentRef = useRef(widgetContent);
  widgetContentRef.current = widgetContent;
  const dragCounter = useRef(0);

  // Ambient (persistent) moves
  const [ambientMoves, setAmbientMoves] = useState<AmbientMoveInfo[]>([]);

  /**
   * A move whose inputs are being filled in, docked above the composer. The
   * picker hands moves here rather than rendering a form in its 360px popover.
   */
  const [formMove, setFormMove] = useState<{
    move: MoveListItem;
    source: ComposerMoveFormSource;
    initialValues?: Record<string, unknown>;
  } | null>(null);

  const dispatchMoveAttach = useCallback((result: AttachMoveResult, targetSessionId?: string) => {
    const intent = moveAttachResultToIntent(result, targetSessionId ?? sessionId ?? "");
    if (intent) dispatchUiIntent(pageContext, intent);
  }, [pageContext, sessionId]);

  const dispatchMoveActivation = useCallback((result: ActivateMoveResult) => {
    const intent = moveActivationResultToIntent(result, sessionId ?? "");
    if (intent) dispatchUiIntent(pageContext, intent);
  }, [pageContext, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    modus.listAmbientMoves(sessionId).then(setAmbientMoves).catch(() => {});
  }, [sessionId]);

  // Listen for attach-move events from sidebar moves widget
  useEffect(() => {
    const handler = async (e: Event) => {
      const { move, inputs } = (e as CustomEvent).detail as {
        move: MoveListItem;
        inputs: Record<string, unknown>;
      };
      if (move.widget?.mountOnAttach && projectCwd) {
        try {
          const result = await modus.attachMove({
            moveName: move.name,
            inputs,
            cwd: projectCwd,
            sessionId,
            userProfile,
          });
          onMoveAttached?.(result);
          dispatchMoveAttach(result, sessionId);
          window.dispatchEvent(new CustomEvent("modus:widgets-changed"));
        } catch (err) {
          console.error("[ChatInput] attach from sidebar failed:", err);
        }
      } else {
        attachMove(move, inputs);
      }
    };
    window.addEventListener("modus:attach-move", handler);
    return () => window.removeEventListener("modus:attach-move", handler);
  }, [projectCwd, sessionId, userProfile, onMoveAttached, dispatchMoveAttach, attachMove]);

  // Listen for widget-composer-attach events from move widgets
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        moveName: string;
        label: string;
        data?: Record<string, unknown>;
        resolve: (result: ComposerAttachResult) => void;
        reject: (reason: Error) => void;
        accept: () => void;
      };
      // Signal that a composer is available
      detail.accept();
      // Reject any existing widget content attachment
      widgetContentRef.current?.reject(new Error("replaced"));
      setWidgetContent({
        moveName: detail.moveName,
        label: detail.label,
        data: detail.data,
        resolve: detail.resolve,
        reject: detail.reject,
      });
      ref.current?.focus();
    };
    window.addEventListener("modus:widget-composer-attach", handler);
    return () => window.removeEventListener("modus:widget-composer-attach", handler);
  }, []);

  // Refresh ambient moves when a persistent move is activated
  const origOnMoveActivated = onMoveActivated;
  const handleMoveActivated = useCallback((result: ActivateMoveResult) => {
    origOnMoveActivated?.(result);
    dispatchMoveActivation(result);
    if (result.widget) {
      window.dispatchEvent(new CustomEvent("modus:widgets-changed"));
    }
    if (result.persistent && sessionId) {
      modus.listAmbientMoves(sessionId).then(setAmbientMoves).catch(() => {});
    }
  }, [origOnMoveActivated, dispatchMoveActivation, sessionId]);

  /**
   * The single place a chosen move + its inputs become real. Both the picker
   * (for input-less moves) and the docked form land here, so the three
   * destinations — persistent activation, widget mount, plain attachment —
   * cannot drift apart between the two entry points.
   */
  const commitMove = useCallback(async (move: MoveListItem, inputs: Record<string, unknown>) => {
    if (move.persistent) {
      if (!projectCwd) return;
      const body = { moveName: move.name, inputs, cwd: projectCwd, userProfile };
      try {
        const result = sessionId
          ? await modus.activateMove(sessionId, body)
          : await modus.activateProjectMove({ ...body, forceNewSession: true });
        handleMoveActivated(result);
      } catch (err) {
        console.error("[ChatInput] activate failed:", err);
      }
      return;
    }
    if (move.widget?.mountOnAttach && projectCwd) {
      // Widget-first: the widget IS the interface, so there is no chip to keep.
      try {
        const result = await modus.attachMove({
          moveName: move.name, inputs, cwd: projectCwd, sessionId, userProfile,
        });
        onMoveAttached?.(result);
        dispatchMoveAttach(result, sessionId);
        window.dispatchEvent(new CustomEvent("modus:widgets-changed"));
      } catch (err) {
        console.error("[ChatInput] attach failed:", err);
      }
      return;
    }
    attachMove(move, inputs);
  }, [projectCwd, sessionId, userProfile, handleMoveActivated, onMoveAttached, dispatchMoveAttach, attachMove]);

  /**
   * Move bindings on this session's agent profile that declared `ask: true`.
   * The harness skips these at session start, so the form below is the only
   * thing that runs them. Resolved (submitted or skipped) entries are tracked
   * per session so a form does not come back after the user dealt with it.
   */
  const [profileAsks, setProfileAsks] = useState<PendingAsk[]>([]);
  const [resolvedAsks, setResolvedAsks] = useState<Set<string>>(new Set());

  /**
   * The profile's inline moves, which will gather pre-spawn and be prepended to
   * the first message. Shown as pending attachments so the user can see what
   * the selected profile is about to inject before they send, and drop any of
   * it. Only meaningful until that first message exists.
   */
  const [profileInjections, setProfileInjections] = useState<MoveListItem[]>([]);
  const [skippedInjections, setSkippedInjections] = useState<Set<string>>(new Set());

  const askScope = `${sessionId ?? "new"}:${agentProfile ?? ""}`;
  useEffect(() => {
    setResolvedAsks(new Set());
    setSkippedInjections(new Set());
  }, [askScope]);

  useEffect(() => {
    const bindings = profiles.find((p) => p.name === agentProfile)?.moves ?? [];
    if (!bindings.length || !projectCwd) {
      setProfileAsks([]);
      setProfileInjections([]);
      return;
    }
    let cancelled = false;
    modus.listMoves(projectCwd).then((available) => {
      if (cancelled) return;
      setProfileAsks(pendingProfileAsks(bindings, available));
      setProfileInjections(pendingProfileInjections(bindings, available));
    }).catch(() => {
      if (cancelled) return;
      setProfileAsks([]);
      setProfileInjections([]);
    });
    return () => { cancelled = true; };
  }, [agentProfile, profiles, projectCwd]);

  /**
   * Profile injections only apply to the message that starts the session. Once
   * the conversation has a turn in it they have already fired, and
   * `skipPreviouslyInjectedForSession` stops them firing again — so showing
   * them past that point would claim something untrue.
   */
  const visibleInjections = useMemo(
    () => (sessionHasMessages ? [] : profileInjections),
    [profileInjections, sessionHasMessages],
  );

  const skipProfileMovesRef = useRef<string[]>([]);
  skipProfileMovesRef.current = visibleInjections.length
    ? [...skippedInjections]
    : [];

  /** Send-time opts. Self-clearing: once the session has a turn, there is
   *  nothing left to skip, so this goes back to undefined on its own. */
  const currentSendOpts = useCallback((): SendOpts | undefined => (
    skipProfileMovesRef.current.length
      ? { skipProfileMoves: [...skipProfileMovesRef.current] }
      : undefined
  ), []);

  /**
   * One form at a time: a picker form the user just opened outranks a profile
   * ask, and stacking several would bury the composer under its own chrome.
   */
  const activeForm = useMemo(() => {
    if (formMove) return formMove;
    const next = profileAsks.find((ask) => !resolvedAsks.has(ask.move.name));
    return next
      ? { move: next.move, source: "profile" as ComposerMoveFormSource, initialValues: next.initialValues }
      : null;
  }, [formMove, profileAsks, resolvedAsks]);

  const closeActiveForm = useCallback(() => {
    if (formMove) { setFormMove(null); return; }
    if (activeForm) {
      setResolvedAsks((prev) => new Set(prev).add(activeForm.move.name));
    }
  }, [activeForm, formMove]);

  /** Agent profile names offered to a move's `{{agentProfiles}}` picker. */
  const formProfileNames = useMemo(() => {
    const names = activeUP?.agentProfiles?.length
      ? activeUP.agentProfiles
      : profiles.map((profile) => profile.name);
    return ["Current profile", ...names];
  }, [activeUP?.agentProfiles, profiles]);

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    sessionIdRef.current = sessionId;
    projectCwdRef.current = projectCwd;
    userProfileRef.current = userProfile;
  }, [onChange, projectCwd, sessionId, userProfile, value]);

  // Resize after React applies any controlled value change. useLayoutEffect runs
  // before paint, so one measurement covers typing, history, and inserted text.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [value]);

  // Focus when the visible chat session changes or the chat view becomes active.
  useEffect(() => {
    if (autoFocus && !disabled && ref.current) {
      ref.current.focus();
    }
  }, [autoFocus, disabled, sessionId]);

  useEffect(() => {
    return registerComposer({
      id: composerId,
      getSnapshot: () => ({
        sessionId: sessionIdRef.current,
        cwd: projectCwdRef.current,
        userProfile: userProfileRef.current,
        draft: valueRef.current,
      }),
      focus: () => ref.current?.focus(),
      setDraft: (text: string) => {
        onChangeRef.current(text);
      },
      insertText: (text: string) => {
        const ta = ref.current;
        const current = valueRef.current;
        if (!ta) {
          onChangeRef.current(current + text);
          return;
        }
        const start = ta.selectionStart ?? current.length;
        const end = ta.selectionEnd ?? current.length;
        onChangeRef.current(current.slice(0, start) + text + current.slice(end));
        requestAnimationFrame(() => {
          ta.focus();
          const pos = start + text.length;
          ta.setSelectionRange(pos, pos);
        });
      },
      setGhostText: (text: string | null) => {
        setExtensionGhost(text);
      },
      submit: (text?: string) => {
        handleSendRef.current(text);
      },
      attachMove: (move: MoveListItem, inputs: Record<string, unknown>) => {
        // Mirrors the modus:attach-move window-event path, but delivered directly
        // to this composer by ID. Used by callers that just created a session and
        // need to avoid the event-dispatch race.
        if (move.widget?.mountOnAttach && projectCwdRef.current) {
          modus.attachMove({
            moveName: move.name,
            inputs,
            cwd: projectCwdRef.current,
            sessionId: sessionIdRef.current,
            userProfile: userProfileRef.current,
          }).then((result) => {
            onMoveAttached?.(result);
            dispatchMoveAttach(result, sessionIdRef.current);
            window.dispatchEvent(new CustomEvent("modus:widgets-changed"));
          }).catch((err) => console.error("[ChatInput] attachMove via registry failed:", err));
          return;
        }
        attachMove(move, inputs);
      },
    });
  }, [composerId, onMoveAttached, dispatchMoveAttach, attachMove]);

  // Global Escape to stop — works regardless of focus, but not when picker is open
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pickerOpen) { e.preventDefault(); onStop(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, onStop, pickerOpen]);

  // ── File processing ──

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type));
    if (imageFiles.length === 0) return;

    const results = await Promise.all(imageFiles.map(fileToBase64));
    setAttachments((prev) => [
      ...prev,
      ...results.map((r): Attachment => ({
        type: "image",
        mediaType: r.mediaType,
        data: r.data,
        name: r.name,
      })),
    ]);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Drag and Drop ──

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    addImageFiles(files);
  }, [addImageFiles]);

  // ── Clipboard paste ──

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageItems: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && ACCEPTED_IMAGE_TYPES.includes(item.type)) {
        const file = item.getAsFile();
        if (file) imageItems.push(file);
      }
    }
    if (imageItems.length > 0) {
      e.preventDefault(); // prevent default paste when we have images
      addImageFiles(imageItems);
      return;
    }
    // Large-text paste → stage as a collapsible chip (unless Shift bypass)
    if (!shiftHeldRef.current) {
      const text = e.clipboardData.getData("text/plain");
      if (text && (text.length >= PASTE_CHAR_THRESHOLD || text.split("\n").length >= PASTE_LINE_THRESHOLD)) {
        e.preventDefault();
        setPastes((prev) => [...prev, { id: crypto.randomUUID(), text }]);
        return;
      }
    }
    // Otherwise let the default text paste happen
  }, [addImageFiles]);

  // ── Send ──

  async function handleSend(textOverride?: string, deliver: DeliverMode = "queue") {
    if (moveSendPending.current) return;
    const text = (textOverride ?? value).trim();
    const pasteBlock = serializePastes(pastes);
    const authoredText = pasteBlock ? (text ? `${pasteBlock}\n\n${text}` : pasteBlock) : text;
    // Skills lead, so the model reads the instructions before the request.
    const skillBlock = serializeSkills(stagedSkills);
    const finalText = skillBlock
      ? (authoredText ? `${skillBlock}\n\n${authoredText}` : skillBlock)
      : authoredText;
    const hasText = !!finalText || attachments.length > 0;
    if (!attachedMoves.length && !widgetContent && !hasText) return;

    // Widget content attachment — resolve the promise and prepend label
    if (widgetContent) {
      const wc = widgetContent;
      setWidgetContent(null);
      wc.resolve({ sent: true, userText: text });
      // The widget's move is responsible for the actual message content;
      // we just send whatever the user typed (the widget label is informational).
      // Attached moves are gathered along with this message below.
    }

    const moveBindings: MoveBinding[] = [];
    const prompts: string[] = [];
    if (attachedMoves.length) {
      if (!projectCwd) {
        setMoveSendError("Select a project before sending attached moves.");
        return;
      }
      moveSendPending.current = true;
      setMoveSendError(null);
      try {
        for (const attachment of attachedMoves) {
          const { item, inputs, instanceId: attachInstanceId } = attachment;
          const mode = item.mode ?? "inline";
          // Both session creation and follow-up messages accept the whole array.
          if (mode === "inline" && !attachInstanceId) {
            moveBindings.push({ name: item.name, inputs });
            continue;
          }
          const moveInputs = attachInstanceId ? { ...inputs, instanceId: attachInstanceId } : inputs;
          const body = { moveName: item.name, inputs: moveInputs, cwd: projectCwd, userProfile };
          const result = sessionId
            ? await modus.activateMove(sessionId, body)
            : await modus.activateProjectMove(body);
          if (mode === "inline" && !result.persistent && result.prompt) prompts.push(result.prompt);
          handleMoveActivated(result);
          setAttachedMoves((prev) => prev.filter((entry) => entry !== attachment));
        }
      } catch (error) {
        setMoveSendError(error instanceof Error ? error.message : "Move activation failed. Try again.");
        return;
      } finally {
        moveSendPending.current = false;
      }
    }

    const combined = [...prompts, finalText].filter(Boolean).join("\n\n");
    if (hasText || combined || moveBindings.length) {
      if (text) {
        sentHistory.push(text);
        if (sentHistory.length > MAX_HISTORY) sentHistory.shift();
        historyIndex.current = -1;
        draft.current = "";
      }
      onSend(attachments, combined || " ", moveBindings.length ? moveBindings : undefined, deliver, currentSendOpts());
      setAttachedMoves((prev) => prev.filter((entry) => !attachedMoves.includes(entry)));
      setAttachments([]);
      setPastes([]);
      setStagedSkills([]);
    }
  }

  handleSendRef.current = (text) => { void handleSend(text); };

  // Catch "/" via beforeinput — works even when keyDown doesn't fire (IME, dead keys, etc.)
  const handleBeforeInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const ie = e.nativeEvent as InputEvent;
    if (ie.data === "/" && !value.trim()) {
      e.preventDefault();
      setPickerForceOpen((n) => n + 1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ghost-text acceptance: Tab always, ArrowRight only when caret is at end of value
    if (ghost && (e.key === "Tab" || e.key === "ArrowRight")) {
      const ta = ref.current;
      const atEnd = !ta || (ta.selectionStart === value.length && ta.selectionEnd === value.length);
      if (atEnd) {
        e.preventDefault();
        const next = value + ghost;
        setPromptGhost(null);
        setExtensionGhost(null);
        onChange(next);
        requestAnimationFrame(() => {
          const t = ref.current;
          if (t) { t.focus(); t.setSelectionRange(next.length, next.length); }
        });
        return;
      }
    }

    // Escape dismisses ghost (without stopping an active session)
    if (ghost && e.key === "Escape") {
      setPromptGhost(null);
      setExtensionGhost(null);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Alt+Enter interjects into the running turn instead of waiting for it.
      // Inert when the provider cannot steer, so the keystroke never silently
      // means something different than the button says.
      handleSend(undefined, e.altKey && canInterject ? "steer" : "queue");
      return;
    }

    // "/" opens the picker; provider slash commands are listed inside it.
    if (e.key === "/" && !value.trim()) {
      e.preventDefault();
      setPickerForceOpen((n) => n + 1);
      return;
    }

    // Up arrow at start of input — cycle back through history
    if (e.key === "ArrowUp" && sentHistory.length > 0) {
      const ta = ref.current;
      const atStart = !ta || ta.selectionStart === 0;
      if (atStart) {
        e.preventDefault();
        if (historyIndex.current === -1) draft.current = value;
        const next = historyIndex.current === -1
          ? sentHistory.length - 1
          : Math.max(0, historyIndex.current - 1);
        historyIndex.current = next;
        onChange(sentHistory[next]);
      }
    }

    // Down arrow — cycle forward through history, back to draft
    if (e.key === "ArrowDown" && historyIndex.current !== -1) {
      const ta = ref.current;
      const atEnd = !ta || ta.selectionStart === ta.value.length;
      if (atEnd) {
        e.preventDefault();
        if (historyIndex.current >= sentHistory.length - 1) {
          historyIndex.current = -1;
          onChange(draft.current);
        } else {
          historyIndex.current++;
          onChange(sentHistory[historyIndex.current]);
        }
      }
    }
  };

  const hasContent = value.trim() || attachments.length > 0 || attachedMoves.length > 0 || !!widgetContent;

  // Icon-only actions and compact toggles go to the top-left corner; labelled actions stay in the button row
  const iconActions = composerActions.filter((a) => a.icon && !a.label);
  const buttonActions = composerActions.filter((a) => !a.icon || !!a.label);
  const buttonStatuses = buttonActions.filter((a) => a.status?.label);
  const iconStatus = iconActions.find((a) => a.status?.label);

  const isRecording = composerActions.some((a) => a.status?.tone === "active");
  const isFinishing = composerActions.some((a) => a.status?.tone === "busy");
  const isGated = iconStatus?.status?.tone === "gated";
  // An extension reporting a failure outranks every healthy state. Without this
  // branch a status of tone "error" — the one tone that means something is
  // wrong — rendered no dot at all, which made it the quietest state on the
  // composer rather than the loudest. It is also the only failure channel an
  // extension has: the packaged desktop ships without devtools, so a console
  // line reaches nobody.
  const isErrored = composerActions.some((a) => a.status?.tone === "error");
  // Ranked below a real failure and above the healthy states: an advisory must
  // be visible without claiming something broke.
  const isWarning = composerActions.some((a) => a.status?.tone === "warning");
  const statusDotTone = isErrored
    ? "error"
    : isWarning ? "warning"
    : isRecording ? "active" : isFinishing ? "busy" : isGated ? "gated" : null;

  const wrapClass = [
    "chat-textarea-wrap",
    isRecording ? "is-recording" : "",
    isFinishing ? "is-finishing" : "",
    iconActions.length > 0 ? "has-icon-actions" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={`chat-input-area${isDragging ? " drag-active" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay">drop images here</div>
      )}

      {attachments.length > 0 && (
        <div className="attachment-strip">
          {attachments.map((att, i) => (
            <div key={i} className="attachment-thumb">
              <img
                src={`data:${att.mediaType};base64,${att.data}`}
                alt={att.name || "attachment"}
              />
              <button
                className="attachment-remove"
                onClick={() => removeAttachment(i)}
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {pastes.length > 0 && (
        <div className="paste-strip">
          {pastes.map((p) => (
            <PasteBlock
              key={p.id}
              text={p.text}
              onRemove={() => setPastes((prev) => prev.filter((x) => x.id !== p.id))}
              onInline={() => {
                const newVal = (value ? value + "\n\n" : "") + p.text;
                onChange(newVal);
                setPastes((prev) => prev.filter((x) => x.id !== p.id));
                requestAnimationFrame(() => {
                  const ta = ref.current;
                  if (ta) {
                    ta.style.height = "auto";
                    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
                    ta.focus();
                    ta.setSelectionRange(newVal.length, newVal.length);
                  }
                });
              }}
            />
          ))}
        </div>
      )}

      {stagedSkills.length > 0 && (
        <div className="skill-chips">
          {stagedSkills.map((s) => (
            <span key={s.id} className="skill-chip" title={`${s.name} — sent as text with your next message`}>
              <span className="skill-chip-glyph">/</span>
              {s.name}
              <button
                className="skill-chip-remove"
                onClick={() => setStagedSkills((prev) => prev.filter((x) => x.id !== s.id))}
                title={`Remove ${s.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {visibleInjections.length > 0 && (
        <div className="profile-move-injections">
          <span className="profile-move-injections-label">
            {agentProfile} attaches
          </span>
          {visibleInjections.map((move) => {
            const skipped = skippedInjections.has(move.name);
            return (
              <span
                key={move.name}
                className={`profile-move-chip${skipped ? " profile-move-chip--skipped" : ""}`}
                title={
                  skipped
                    ? `${move.name} will not run — click + to put it back`
                    : `${move.description || move.name} — gathered and prepended to your first message`
                }
              >
                <span className="profile-move-chip-dot" />
                {move.label}
                <button
                  className="profile-move-chip-toggle"
                  onClick={() => setSkippedInjections((prev) => {
                    const next = new Set(prev);
                    if (next.has(move.name)) next.delete(move.name);
                    else next.add(move.name);
                    return next;
                  })}
                  title={skipped ? `Attach ${move.label} again` : `Do not attach ${move.label}`}
                >
                  {skipped ? "+" : "×"}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {activeForm && (
        <ComposerMoveForm
          key={`${activeForm.source}:${activeForm.move.name}`}
          move={activeForm.move}
          source={activeForm.source}
          initialValues={activeForm.initialValues}
          profileNames={formProfileNames}
          projectCwd={projectCwd}
          userProfile={userProfile ?? activeUserProfile ?? undefined}
          allowedProjectPaths={activeUP?.projects}
          submitLabel={activeForm.move.persistent ? "activate" : "attach"}
          onSubmit={(move, inputs) => {
            closeActiveForm();
            void commitMove(move, inputs);
            ref.current?.focus();
          }}
          onDismiss={() => {
            closeActiveForm();
            ref.current?.focus();
          }}
        />
      )}

      {attachedMoves.map((attachedMove) => (
        <AttachedMove
          key={attachedMove.item.name}
          move={attachedMove.item}
          inputs={attachedMove.inputs}
          onDetach={() => {
            if (attachedMove.apiToken) {
              modus.detachMove(attachedMove.item.name, attachedMove.apiToken).catch(() => {});
              onMoveDetached?.(attachedMove.apiToken);
            }
            setAttachedMoves((prev) => prev.filter((entry) => entry !== attachedMove));
          }}
        />
      ))}
      {moveSendError && <div role="alert">{moveSendError}</div>}

      {widgetContent && (
        <AttachedWidgetContent
          label={widgetContent.label}
          moveName={widgetContent.moveName}
          onDetach={() => {
            widgetContent.reject(new Error("detached"));
            setWidgetContent(null);
          }}
        />
      )}

      {ambientMoves.length > 0 && (
        <div className="ambient-move-chips">
          {ambientMoves.map((m) => (
            <span key={m.moveName} className="ambient-chip">
              <span className="ambient-chip-dot" />
              {m.moveName}
              <button
                className="ambient-chip-remove"
                onClick={() => {
                  if (!sessionId) return;
                  modus.deactivateAmbient(sessionId, m.moveName).then(() => {
                    setAmbientMoves((prev) => prev.filter((x) => x.moveName !== m.moveName));
                  });
                }}
                title={`Deactivate ${m.moveName}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="input-row">
        <div className={wrapClass}>
          {iconActions.length > 0 && (
            <div className="composer-icon-actions">
              {iconActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className="composer-icon-btn"
                  onClick={() => { void action.perform(); }}
                  disabled={disabled || action.disabled}
                  title={action.title ?? action.extensionId}
                  aria-label={action.title ?? action.extensionId}
                >
                  <ComposerActionIcon icon={action.icon} />
                </button>
              ))}
            </div>
          )}
          {/* Status indicator: dot on right, text to its left */}
          {(statusDotTone || iconStatus) && (
            <div className="composer-status-area">
              {iconStatus && (
                <span className={`composer-status-text composer-status-text--${iconStatus.status?.tone ?? "default"}`}>
                  {iconStatus.status?.label}
                </span>
              )}
              {statusDotTone && (
                <div className={`composer-status-dot composer-status-dot--${statusDotTone}`} />
              )}
            </div>
          )}
          <textarea
            ref={ref}
            className="chat-textarea"
            placeholder={attachedMoves.length || widgetContent ? "add context... (optional)" : (placeholder ?? "message... (drop or paste images)")}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBeforeInput={handleBeforeInput}
            onPaste={handlePaste}
            onFocus={() => activateComposer(composerId)}
            onSelect={() => recomputeGhost(valueRef.current)}
            onScroll={syncGhostScroll}
            rows={1}
            disabled={disabled}
          />
          {ghost && (
            <div
              ref={ghostRef}
              className="chat-textarea-ghost"
              aria-hidden="true"
            >
              <span className="chat-textarea-ghost-typed">{value}</span>
              <span className="chat-textarea-ghost-suffix">{ghost}</span>
            </div>
          )}
          <div className="chat-picker">
            <PromptPicker
              forceOpen={pickerForceOpen}
              sessionId={sessionId}
              projectCwd={projectCwd}
              userProfile={userProfile}
              provider={provider}
              onMoveActivated={handleMoveActivated}
              onSkillAttach={(name, text) => {
                setStagedSkills((prev) =>
                  // Re-picking a staged skill is a no-op rather than a duplicate
                  // injection of the same text.
                  prev.some((s) => s.name === name)
                    ? prev
                    : [...prev, { id: crypto.randomUUID(), name, text }],
                );
              }}
              onMoveAttach={(move, inputs) => { void commitMove(move, inputs); }}
              onMoveForm={(move) => {
                setFormMove({ move, source: "picker" });
              }}
              onOpenChange={(isOpen) => {
                setPickerOpen(isOpen);
                if (!isOpen) {
                  ref.current?.focus();
                }
              }}
              onAutoSend={(text) => {
                handleSendRef.current?.(text);
              }}
              onInject={(text) => {
                const ta = ref.current;
                const existing = value;
                if (!existing.trim()) {
                  onChange(text);
                } else if (text.startsWith("/")) {
                  onChange(text + "\n" + existing);
                } else {
                  const pos = ta?.selectionStart ?? existing.length;
                  const before = existing.slice(0, pos);
                  const after = existing.slice(pos);
                  const sep = before && !before.endsWith("\n") ? "\n" : "";
                  onChange(before + sep + text + after);
                }
                ta?.focus();
              }}
            />
          </div>
          <div className="chat-controls">
            {buttonStatuses.length > 0 && (
              <div className="composer-status-row">
                {buttonStatuses.map((action) => (
                  <span
                    key={`${action.key}:status`}
                    className={`composer-status composer-status--${action.status?.tone ?? "default"}`}
                  >
                    {action.status?.label}
                  </span>
                ))}
              </div>
            )}
            <div className="composer-button-row">
              {composerToggles.map((toggle) => {
                const tone = toggle.busy ? "busy" : toggle.tone ?? (toggle.enabled ? "active" : "default");
                return (
                  <button
                    key={toggle.key}
                    type="button"
                    className={`composer-toggle composer-toggle--toolbar composer-toggle--${tone}${toggle.enabled ? " is-enabled" : ""}${toggle.busy ? " is-busy" : ""}`}
                    onClick={() => { void toggle.toggle(); }}
                    disabled={disabled || toggle.disabled}
                    title={toggle.title ?? toggle.extensionId}
                    aria-label={toggle.title ?? toggle.extensionId}
                    aria-pressed={!!toggle.enabled}
                  >
                    <span className="composer-toggle-label">{toggle.label}</span>
                  </button>
                );
              })}
              {buttonActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className={`composer-action-btn${action.label ? "" : " composer-action-btn--icon"}`}
                  onClick={() => { void action.perform(); }}
                  disabled={disabled || action.disabled}
                  title={action.title ?? action.label ?? action.extensionId}
                  aria-label={action.title ?? action.label ?? action.extensionId}
                >
                  <ComposerActionIcon icon={action.icon} />
                  {action.label ? <span>{action.label}</span> : null}
                </button>
              ))}
              {isActive ? (
                <>
                  {hasContent && (
                    <button
                      className={`send-btn${canSteer ? " send-btn--interject" : ""}`}
                      type="button"
                      onClick={() => handleSend(undefined, canSteer ? "steer" : "queue")}
                      disabled={disabled}
                      title={canSteer
                        ? "Interject into the running turn — the agent reads it at the next tool boundary (Alt+Enter)"
                        : `${provider ?? "This provider"} cannot deliver mid-turn — this waits until the current turn ends`}
                    >
                      {canSteer ? "interject" : "queue"}
                    </button>
                  )}
                  <button className="stop-btn" type="button" onClick={onStop}>
                    stop
                  </button>
                </>
              ) : (
                <button
                  className="send-btn"
                  type="button"
                  onClick={() => handleSend()}
                  disabled={!hasContent || disabled}
                >
                  send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
