/**
 * HtmlPreview — sandboxed iframe preview for HTML files.
 *
 * Renders the file header (name, actions) and an iframe with srcDoc.
 * Used by RightPanel when viewing an HTML file in preview mode.
 */

import type { ReactNode } from "react";
import { SandboxedHtmlFrame } from "./SandboxedHtmlFrame";

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

type Props = {
  filePath: string;
  content: string;
  nameActions?: ReactNode;
  actions?: ReactNode;
};

export function HtmlPreview({ filePath, content, nameActions, actions }: Props) {
  return (
    <div className="right-panel-file right-panel-canvas">
      <div className="fcv-head">
        <div className="fcv-meta">
          <div className="fcv-name-row">
            {nameActions && <div className="fcv-name-actions">{nameActions}</div>}
            <span className="fcv-name">{basename(filePath)}</span>
          </div>
        </div>
        <div className="fcv-head-side">
          <span className="fcv-count">preview</span>
          {actions && <div className="fcv-actions">{actions}</div>}
        </div>
      </div>
      <SandboxedHtmlFrame
        className="right-panel-iframe"
        html={content}
        title="HTML Preview"
      />
    </div>
  );
}
