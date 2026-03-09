import { useState, useEffect } from "react";

export function MoLogo({ size = 24, className = "", activeCount = 0 }: { size?: number; className?: string; activeCount?: number }) {
  const w = Math.round(size * 2.5);
  const capped = Math.min(activeCount, 5);
  const [visible, setVisible] = useState(0);
  const [absorbing, setAbsorbing] = useState(false);

  useEffect(() => {
    if (capped >= visible) {
      setVisible(capped);
    } else {
      // Keep departing dots rendered for exit animation
      setAbsorbing(true);
      const t = setTimeout(() => {
        setVisible(capped);
        setAbsorbing(false);
      }, 2100);
      return () => clearTimeout(t);
    }
  }, [capped]); // eslint-disable-line react-hooks/exhaustive-deps

  const dotCount = Math.max(visible, capped);

  return (
    <svg
      width={w}
      height={size}
      viewBox="0 0 120 48"
      fill="none"
      className={`mo-logo ${className}`}
    >
      <defs>
        <mask id="mo-mask-o">
          <circle cx="88" cy="24" r="19" stroke="white" strokeWidth="6" />
          <circle
            className="mo-gap-o"
            cx="88" cy="24" r="19"
            stroke="black"
            strokeWidth="6"
          />
        </mask>
      </defs>

      {/* M — plain, no mask */}
      <path
        d="M8 42 L8 6 L30 30 L52 6 L52 42"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* O — masked by traveling gap */}
      <circle
        cx="88"
        cy="24"
        r="19"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        mask="url(#mo-mask-o)"
      />

      {/* Absorption pulse — ring flash when dots collapse */}
      {absorbing && (
        <circle
          className="mo-ring-pulse"
          cx="88" cy="24" r="19"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      )}

      {/* Eyes — one per active agent, rotated around O center for different paths */}
      {Array.from({ length: dotCount }, (_, i) => {
        const exiting = i >= capped;
        const rotation = 70 * i;
        return (
          <g key={i} transform={`rotate(${rotation} 88 24)`}>
            <circle
              className={`mo-eye${exiting ? " mo-eye--exit" : ""}`}
              cx="88"
              cy="24"
              r="3"
              fill="currentColor"
              style={
                exiting
                  ? { animationDelay: `1s, 1.5s, ${(i - capped) * 0.15}s` }
                  : i > 0
                    ? { animationDelay: `${1 + i * 0.15}s, ${1.5 - (20 * i / dotCount)}s` }
                    : undefined
              }
            />
          </g>
        );
      })}
    </svg>
  );
}
