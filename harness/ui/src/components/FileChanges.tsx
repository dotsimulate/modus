import { memo, useEffect, useState } from "react";
import type { ToolCall } from "../../../sdk/index";
import { ticketedRawFileUrl, ticketedShareableFileUrl } from "../rawFileUrl";
import { useFileViewer } from "../providers/FileViewerContext";
import { canonicalToolName, toolFamily, toolInputPath, toolWriteContent } from "../tool-names";

export type FileEdit = {
  filePath: string;
  type: "edit" | "write";
  oldString?: string;
  newString?: string;
  content?: string;
};

/** Extract file edits from an array of tool calls (recurses into sub-agents) */
export function extractFileEdits(toolCalls: ToolCall[]): FileEdit[] {
  const edits: FileEdit[] = [];
  for (const tc of toolCalls) {
    if (tc.status !== "completed") continue;

    const family = toolFamily(tc.name ?? "");
    const name = canonicalToolName(tc.name ?? "");
    const fp = toolInputPath(tc.input);
    const hasBatchEdits = Array.isArray(tc.input.edits);
    const hasSingleEdit = typeof tc.input.old_string === "string" || typeof tc.input.new_string === "string";
    const writeContent = toolWriteContent(tc.input);
    const hasWrite = writeContent != null;

    // Codex pre-fix format: Edit with { files: string[] } — emit one entry per file
    if ((family === "edit" || family === "write") && Array.isArray(tc.input.files) && !fp) {
      for (const filePath of tc.input.files as string[]) {
        edits.push({ filePath, type: family === "write" ? "write" : "edit" });
      }
      continue;
    }
    // Codex file-change event format: FileChange with { file_path, change_kind }
    if (name === "filechange") {
      if (!fp) continue;
      edits.push({
        filePath: fp,
        type: "edit",
      });
      continue;
    }

    if (family === "edit" || hasBatchEdits || hasSingleEdit) {
      if (!fp) continue;

      if ((name === "multiedit" || hasBatchEdits) && Array.isArray(tc.input.edits)) {
        for (const edit of tc.input.edits as Array<{ old_string?: string; new_string?: string }>) {
          edits.push({
            filePath: fp,
            type: "edit",
            oldString: edit.old_string ?? "",
            newString: edit.new_string ?? "",
          });
        }
      } else {
        edits.push({
          filePath: fp,
          type: "edit",
          oldString: tc.input.old_string as string ?? "",
          newString: tc.input.new_string as string ?? "",
        });
      }
    } else if (family === "write" || hasWrite) {
      if (!fp) continue;
      edits.push({
        filePath: fp,
        type: "write",
        content: writeContent ?? "",
      });
    }

    // Recurse into sub-agent messages
    if (tc.subMessages) {
      for (const sub of tc.subMessages) {
        if (sub.toolCalls) {
          edits.push(...extractFileEdits(sub.toolCalls));
        }
      }
    }
  }

  return edits;
}

/** Group edits by file path */
export function groupByFile(edits: FileEdit[]): Map<string, FileEdit[]> {
  const map = new Map<string, FileEdit[]>();
  for (const edit of edits) {
    const list = map.get(edit.filePath) ?? [];
    list.push(edit);
    map.set(edit.filePath, list);
  }
  return map;
}

/** Count additions and deletions from edit strings */
export function countChanges(edits: FileEdit[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const edit of edits) {
    if (edit.type === "write") {
      // Trace-backed writes know that the file was written but intentionally
      // do not carry the full file body. Do not invent a +1 line for those.
      if (edit.content != null) additions += edit.content.split("\n").length;
    } else {
      const oldLines = (edit.oldString ?? "").split("\n").filter(Boolean).length;
      const newLines = (edit.newString ?? "").split("\n").filter(Boolean).length;
      additions += newLines;
      deletions += oldLines;
    }
  }
  return { additions, deletions };
}

function shortPath(p: string): string {
  return p
    .replace(/^\/home\/[^/]+\//, "~/")
    .replace(/^[A-Z]:\\Users\\[^\\]+\\/, "~/")
    .replace(/\\/g, "/");
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** Render a single edit as a table hunk — reuses git diff CSS */
export function EditHunk({ edit, idx }: { edit: FileEdit; idx: number }) {
  if (edit.type === "write") {
    if (edit.content == null) {
      return (
        <tbody className="diff-hunk-block">
          <tr className="diff-hunk-header">
            <td className="diff-gutter" colSpan={3}></td>
            <td className="diff-hunk-range">file written</td>
          </tr>
        </tbody>
      );
    }

    const lines = edit.content.split("\n");
    const show = lines.slice(0, 30);
    return (
      <tbody className="diff-hunk-block">
        <tr className="diff-hunk-header">
          <td className="diff-gutter" colSpan={3}></td>
          <td className="diff-hunk-range">file written</td>
        </tr>
        {show.map((l, i) => (
          <tr key={i} className="diff-line diff-line--add">
            <td className="diff-gutter diff-gutter--old"></td>
            <td className="diff-gutter diff-gutter--new">{i + 1}</td>
            <td className="diff-gutter diff-gutter--marker">+</td>
            <td className="diff-code"><span>{l}</span></td>
          </tr>
        ))}
        {lines.length > 30 && (
          <tr className="diff-hunk-header">
            <td className="diff-gutter" colSpan={3}></td>
            <td className="diff-hunk-range">… {lines.length - 30} more lines</td>
          </tr>
        )}
      </tbody>
    );
  }

  const ol = (edit.oldString ?? "").split("\n");
  const nl = (edit.newString ?? "").split("\n");

  // No diff content available (e.g. provider only reports which files changed)
  if (!edit.oldString && !edit.newString) {
    return (
      <tbody className="diff-hunk-block">
        <tr className="diff-hunk-header">
          <td className="diff-gutter" colSpan={3}></td>
          <td className="diff-hunk-range">file modified</td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody className="diff-hunk-block">
      {idx > 0 && (
        <tr className="diff-hunk-header">
          <td className="diff-gutter" colSpan={3}></td>
          <td className="diff-hunk-range"></td>
        </tr>
      )}
      {ol.map((l, i) => (
        <tr key={`d${i}`} className="diff-line diff-line--del">
          <td className="diff-gutter diff-gutter--old">{i + 1}</td>
          <td className="diff-gutter diff-gutter--new"></td>
          <td className="diff-gutter diff-gutter--marker">-</td>
          <td className="diff-code"><span>{l}</span></td>
        </tr>
      ))}
      {nl.map((l, i) => (
        <tr key={`a${i}`} className="diff-line diff-line--add">
          <td className="diff-gutter diff-gutter--old"></td>
          <td className="diff-gutter diff-gutter--new">{i + 1}</td>
          <td className="diff-gutter diff-gutter--marker">+</td>
          <td className="diff-code"><span>{l}</span></td>
        </tr>
      ))}
    </tbody>
  );
}

const BROWSER_EXTS = new Set([
  ".html", ".htm", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf",
]);

const IMAGE_EXTS = new Set([
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp",
]);

function isImage(filePath: string): boolean {
  const ext = filePath.replace(/\\/g, "/").split("/").pop()?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return !!ext && IMAGE_EXTS.has(ext);
}

function isBrowserPreviewable(filePath: string): boolean {
  const ext = filePath.replace(/\\/g, "/").split("/").pop()?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return !!ext && BROWSER_EXTS.has(ext);
}

/**
 * Hand a link to the platform, preferring the native share sheet.
 *
 * "Open in a new tab" is unreachable in a home-screen web app on iOS: no address
 * bar, no tabs, and nothing that lets the user recover the URL. `navigator.share`
 * is the way out — the iOS sheet offers both Copy and Open in Safari — and it
 * degrades to the clipboard everywhere it does not exist.
 *
 * Returns what actually happened so the caller can confirm it on screen; a copy
 * that silently succeeded is indistinguishable from one that silently failed.
 */
export async function shareLink(
  url: string,
  title: string,
  nav: { share?: (data: { title?: string; url: string }) => Promise<void>; clipboard?: { writeText(text: string): Promise<void> } } = navigator,
): Promise<"shared" | "copied" | "failed"> {
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title, url });
      return "shared";
    } catch (err) {
      // A cancelled share sheet rejects with AbortError. That is the user saying
      // no, so falling back to a silent clipboard write would override them.
      if ((err as { name?: string } | null)?.name === "AbortError") return "failed";
    }
  }
  try {
    await nav.clipboard?.writeText(url);
    return nav.clipboard ? "copied" : "failed";
  } catch {
    return "failed";
  }
}

/** A single file card with collapsible edits */
export function FileCard({
  filePath,
  edits,
}: {
  filePath: string;
  edits: FileEdit[];
}) {
  const [expanded, setExpanded] = useState(false);
  const { openFile } = useFileViewer();
  const { additions, deletions } = countChanges(edits);
  const name = basename(filePath);
  const dir = shortPath(filePath).replace(/\/?[^/]+$/, "");
  const previewable = isBrowserPreviewable(filePath);
  const [shareState, setShareState] = useState<"idle" | "shared" | "copied" | "failed">("idle");

  // An <img> cannot send an Authorization header, so its src needs a ticket —
  // minted only once the row is actually expanded, so a long file list does not
  // mint one per image nobody looked at.
  const [imageUrl, setImageUrl] = useState("");
  const showImage = expanded && isImage(filePath);
  useEffect(() => {
    if (!showImage) return;
    let cancelled = false;
    void ticketedRawFileUrl(filePath).then((url) => {
      if (!cancelled) setImageUrl(url);
    });
    return () => { cancelled = true; };
  }, [showImage, filePath]);

  const handlePreview = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Open the tab synchronously, before awaiting the ticket. A `window.open`
    // after an await has lost the user gesture and is blocked as a popup.
    const opened = window.open("", "_blank");
    if (opened) opened.opener = null;
    const url = await ticketedRawFileUrl(filePath);
    if (!url) {
      opened?.close();
      return;
    }
    if (opened) opened.location.href = url;
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = await ticketedShareableFileUrl(filePath);
    if (!url) {
      setShareState("failed");
      setTimeout(() => setShareState("idle"), 2000);
      return;
    }
    const result = await shareLink(url, name);
    setShareState(result);
    // Confirm on the button itself. There are no devtools in the packaged
    // desktop and no console at all on a phone, so an unconfirmed clipboard
    // write is indistinguishable from one that failed.
    setTimeout(() => setShareState("idle"), 2000);
  };

  const handleViewFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    openFile(filePath, { source: "file-change" });
  };

  return (
    <div className="fc-file">
      <div className="fc-file-header" onClick={() => setExpanded(!expanded)}>
        <span className="diff-file-toggle">{expanded ? "v" : ">"}</span>
        <span className="fc-file-name">{name}</span>
        <span className="fc-file-dir">{dir}</span>
        <span className="fc-file-stats">
          {additions > 0 && <span className="diff-stat diff-stat--add">+{additions}</span>}
          {deletions > 0 && <span className="diff-stat diff-stat--del">-{deletions}</span>}
        </span>
        {previewable && (
          <button className="fc-open-btn" onClick={handlePreview} title="Open in browser">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
              <ellipse cx="6" cy="6" rx="2.2" ry="5" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
        )}
        {previewable && (
          // Sits next to "open in browser" because that button cannot work in a
          // home-screen web app, where there is no tab to open and no address bar
          // to read the URL back out of.
          <button
            className={`fc-open-btn${shareState !== "idle" ? ` fc-open-btn--${shareState}` : ""}`}
            onClick={handleShare}
            title="Copy or share link (opens in Safari from the share sheet)"
          >
            {shareState === "idle" ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4.8 7.2 7.2 4.8" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M6.2 3.4 7.4 2.2a1.7 1.7 0 0 1 2.4 2.4L8.6 5.8" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M5.8 8.6 4.6 9.8a1.7 1.7 0 0 1-2.4-2.4l1.2-1.2" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            ) : (
              <span className="fc-share-note">
                {shareState === "failed" ? "!" : "ok"}
              </span>
            )}
          </button>
        )}
        <button className="fc-open-btn" onClick={handleViewFile} title="View in side panel">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 6s1.8-3 5-3 5 3 5 3-1.8 3-5 3-5-3-5-3Z" stroke="currentColor" strokeWidth="1.1"/>
            <circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.1"/>
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="fc-file-body">
          {showImage && imageUrl && (
            <div className={`fc-image-preview${filePath.toLowerCase().endsWith(".svg") ? " fc-image-preview--svg" : ""}`}>
              <img src={imageUrl} alt={name} />
            </div>
          )}
          <table className="diff-table">
            {edits.map((edit, i) => (
              <EditHunk key={i} edit={edit} idx={i} />
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

type Props = {
  toolCalls: ToolCall[];
};

export const FileChanges = memo(function FileChanges({ toolCalls }: Props) {
  const edits = extractFileEdits(toolCalls);
  if (edits.length === 0) return null;

  const grouped = groupByFile(edits);
  const totalChanges = countChanges(edits);
  const fileCount = grouped.size;
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="fc-container">
      <div className="fc-container-inner">
        <div
          className="fc-header fc-header--toggle"
          onClick={() => setCollapsed((c) => !c)}
          role="button"
          aria-expanded={!collapsed}
        >
          <span className="diff-file-toggle">{collapsed ? ">" : "v"}</span>
          <span className="fc-header-label">
            {fileCount} file{fileCount !== 1 ? "s" : ""} changed
          </span>
          <span className="fc-header-stats">
            {totalChanges.additions > 0 && (
              <span className="diff-stat diff-stat--add">+{totalChanges.additions}</span>
            )}
            {totalChanges.deletions > 0 && (
              <span className="diff-stat diff-stat--del">-{totalChanges.deletions}</span>
            )}
          </span>
        </div>
        {!collapsed && (
          <div className="fc-files">
            {[...grouped.entries()].map(([fp, edits]) => (
              <FileCard key={fp} filePath={fp} edits={edits} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
