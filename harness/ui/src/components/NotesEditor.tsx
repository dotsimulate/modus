/**
 * NotesEditor — modular note-taking component.
 *
 * Supports:
 *   - List of notes with create/delete
 *   - Inline editing with auto-save
 *   - Speech-to-text dictation (Web Speech API or Whisper backend)
 *   - Markdown content
 *
 * Usable standalone, in sidebar widgets, or in full-page views.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { fetchNotes, fetchNote, createNote, updateNote, deleteNote } from "../api";
import type { NoteListItem } from "../api";
import { useSpeechToText } from "../hooks/useSpeechToText";

type NotesEditorProps = {
  cwd: string | null;
  /** Compact mode for sidebar widgets — hides editor, shows list only */
  compact?: boolean;
  /** Callback when a note is selected */
  onSelectNote?: (id: string) => void;
};

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function NotesEditor({ cwd, compact, onSelectNote }: NotesEditorProps) {
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const stt = useSpeechToText("whisper", (text) => {
    setContent((prev) => prev ? `${prev}\n\n${text}` : text);
  });

  // Load notes list
  const loadNotes = useCallback(async () => {
    if (!cwd) return;
    const list = await fetchNotes(cwd);
    setNotes(list);
  }, [cwd]);

  useEffect(() => { loadNotes(); }, [loadNotes]);

  // Load note content
  const loadNote = useCallback(async (id: string) => {
    if (!cwd) return;
    setLoading(true);
    const detail = await fetchNote(id, cwd);
    if (detail) {
      setActiveId(id);
      setTitle(detail.title);
      setContent(detail.content);
      onSelectNote?.(id);
    }
    setLoading(false);
  }, [cwd, onSelectNote]);

  // Auto-save on content/title change (debounced)
  useEffect(() => {
    if (!activeId || !cwd) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      await updateNote(activeId, cwd, { title, content });
      setSaving(false);
      loadNotes();
    }, 800);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [title, content]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create new note
  const handleCreate = useCallback(async () => {
    if (!cwd) return;
    const result = await createNote(cwd, { title: "untitled" });
    await loadNotes();
    loadNote(result.id);
  }, [cwd, loadNotes, loadNote]);

  // Delete note
  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!cwd) return;
    await deleteNote(id, cwd);
    if (activeId === id) {
      setActiveId(null);
      setTitle("");
      setContent("");
    }
    loadNotes();
  }, [cwd, activeId, loadNotes]);

  // Close editor
  const handleClose = useCallback(() => {
    setActiveId(null);
    setTitle("");
    setContent("");
  }, []);

  if (!cwd) {
    return <div className="notes-empty">no project selected</div>;
  }

  return (
    <div className={`notes-editor${compact ? " notes-editor--compact" : ""}`}>
      {/* Note list */}
      <div className="notes-list">
        <div className="notes-list-header">
          <span className="notes-list-count">{notes.length} note{notes.length !== 1 ? "s" : ""}</span>
          <button className="notes-btn notes-btn--create" onClick={handleCreate} title="New note">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="notes-list-items">
          {notes.map((note) => (
            <button
              key={note.id}
              className={`notes-list-item${activeId === note.id ? " active" : ""}`}
              onClick={() => loadNote(note.id)}
            >
              <span className="notes-list-item-title">{note.title}</span>
              <span className="notes-list-item-meta">
                <span className="notes-list-item-time">{timeAgo(note.updated || note.created)}</span>
                <button
                  className="notes-list-item-delete"
                  onClick={(e) => handleDelete(note.id, e)}
                  title="Delete note"
                >
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                    <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                </button>
              </span>
            </button>
          ))}
          {notes.length === 0 && (
            <div className="notes-empty-list">no notes yet</div>
          )}
        </div>
      </div>

      {/* Editor (hidden in compact mode unless a note is active) */}
      {(!compact || activeId) && activeId && (
        <div className="notes-edit">
          <div className="notes-edit-header">
            <input
              className="notes-edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="note title..."
              spellCheck={false}
            />
            <div className="notes-edit-actions">
              {saving && <span className="notes-edit-saving">saving</span>}
              <button
                className={`notes-btn notes-btn--mic${stt.listening ? " active" : ""}`}
                onClick={stt.listening ? stt.stop : stt.start}
                title={stt.listening ? "Stop recording" : "Start dictation"}
              >
                <svg width="10" height="12" viewBox="0 0 10 14" fill="none">
                  <rect x="3" y="0.5" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M1 6.5a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  <path d="M5 12.5v-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
              <button className="notes-btn" onClick={handleClose} title="Close editor">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>
          {stt.listening && (
            <div className="notes-stt-indicator">
              <span className="notes-stt-dot" />
              <span className="notes-stt-label">listening ({stt.mode})</span>
            </div>
          )}
          {stt.error && (
            <div className="notes-stt-error">{stt.error}</div>
          )}
          <textarea
            ref={textareaRef}
            className="notes-edit-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="start typing or use dictation..."
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}
