import type { DeepAnalyticsBucket } from "../../../sdk/index";

function labelFor(ts: number, bucketCount: number): string {
  const date = new Date(ts);
  return bucketCount <= 12
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
}

export function TimeAxis({
  buckets,
  width,
  markers = 6,
}: {
  buckets: DeepAnalyticsBucket[];
  width: number;
  markers?: number;
}) {
  if (buckets.length === 0) return null;

  const items = Array.from({ length: markers }, (_, index) => {
    const pos = markers <= 1 ? 0 : index / (markers - 1);
    const bucket = buckets[Math.min(buckets.length - 1, Math.round(pos * (buckets.length - 1)))];
    return {
      key: `${bucket.start}-${index}`,
      label: labelFor(bucket.start, buckets.length),
      left: `${pos * 100}%`,
      edge: index === 0 ? "left" : index === markers - 1 ? "right" : "mid",
    };
  });

  return (
    <div className="time-axis" style={{ width }}>
      {items.map((item) => (
        <span
          key={item.key}
          className={`time-axis-label time-axis-label--${item.edge}`}
          style={{ left: item.left }}
        >
          {item.label}
        </span>
      ))}
    </div>
  );
}
