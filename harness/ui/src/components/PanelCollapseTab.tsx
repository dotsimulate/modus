/**
 * PanelCollapseTab — the thin hover-reveal tab that collapses/opens a side panel.
 *
 * Renders the .panel-tab button with the correct chevron direction for its side.
 */

type Props = {
  side: "left" | "right";
  open: boolean;
  onToggle: () => void;
  openTitle?: string;
  closeTitle?: string;
};

export function PanelCollapseTab({ side, open, onToggle, openTitle, closeTitle }: Props) {
  // Left panel: open=chevron-right, closed=chevron-left (chevron points toward panel)
  // Right panel: open=chevron-left, closed=chevron-right
  const showRightChevron = side === "left" ? !open : open;

  return (
    <button
      className={`panel-tab panel-tab--${side}`}
      onClick={onToggle}
      title={open ? (closeTitle ?? "Collapse panel") : (openTitle ?? "Open panel")}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        {showRightChevron ? (
          <path d="M4 2l4 3.5L4 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        ) : (
          <path d="M6 2L2 5.5 6 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        )}
      </svg>
    </button>
  );
}
