import { useState, type ReactNode } from "react";

type Props = {
  label: string;
  summary: string;
  children: ReactNode;
  defaultExpanded?: boolean;
  className?: string;
};

/** Neutral compact disclosure shared by inline chat metadata surfaces. */
export function CompactDisclosure({
  label,
  summary,
  children,
  defaultExpanded = false,
  className,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className={`compact-disclosure${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="compact-disclosure__header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="compact-disclosure__label">{label}</span>
        <span className="compact-disclosure__summary">{summary}</span>
        <span className="compact-disclosure__toggle" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>
      <div className={`panel-collapse${expanded ? " panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          <div className="compact-disclosure__detail message-content">{children}</div>
        </div>
      </div>
    </div>
  );
}
