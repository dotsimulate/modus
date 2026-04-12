/**
 * Trace Viewer widget — 3D file-touch trace visualization as a page-embeddable widget.
 *
 * Config: { "type": "trace-viewer", "id": "tv-1" }
 *
 * Wraps the existing TraceView component. Self-contained — fetches its own
 * data from the modus API. No session binding needed.
 */

import { TraceView } from "../components/TraceView";
import type { WidgetBase, WidgetProps } from "./types";

type TraceViewerConfig = WidgetBase & {
  type: "trace-viewer";
};

export default function TraceViewerWidget(_props: WidgetProps<TraceViewerConfig>) {
  return (
    <div className="trace-viewer-widget" style={{ height: "100%", overflow: "hidden" }}>
      <TraceView />
    </div>
  );
}
