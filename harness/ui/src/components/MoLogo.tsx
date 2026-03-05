export function MoLogo({ size = 24, className = "" }: { size?: number; className?: string }) {
  const w = Math.round(size * 2.5);
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

      {/* Eye */}
      <circle className="mo-eye" cx="88" cy="24" r="3" fill="currentColor" />
    </svg>
  );
}
