/**
 * About widget — build identity and help, mountable on a dashboard or a panel.
 *
 * Renders the shared AboutPanel. Everything it shows comes from harness/about.ts
 * via GET /api/about, so this file holds no content of its own.
 */

import AboutPanel from "../components/AboutPanel";
import type { WidgetProps } from "./types";

export default function AboutWidget(_props: WidgetProps) {
  return <AboutPanel />;
}
