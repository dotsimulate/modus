import type { SearchHit } from "../../../../sdk/index";
import { timeAgo } from "../../utils/format";

type Props = {
  results: SearchHit[];
  searching: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
};

export function SearchResults({ results, searching, error, hasMore, onLoadMore, onRetry, activeSessionId, onSelectSession }: Props) {
  return (
    <div className="search-results" aria-busy={searching}>
      {searching && (
        <div className="search-empty" role="status">searching...</div>
      )}
      {error && <div className="search-empty" role="alert">{error} <button type="button" onClick={onRetry}>Retry</button></div>}
      {!searching && !error && results.length === 0 && (
        <div className="search-empty" role="status">no results — try fewer words or a shorter prefix</div>
      )}
      {!searching && results.length > 0 && <div className="search-count" role="status">{results.length} sessions{hasMore ? " shown" : ""}</div>}
      {results.map((hit) => (
        <button
          type="button"
          key={hit.session_id}
          className={`session-item search-result-item ${hit.session_id === activeSessionId ? "active" : ""}`}
          aria-current={hit.session_id === activeSessionId ? "true" : undefined}
          onClick={() => onSelectSession(hit.session_id)}
        >
          <div className="session-item-preview">
            <span className="session-item-text">{hit.preview}</span>
          </div>
          <div className="search-hit-snippet">{hit.snippet}</div>
          <div className="session-item-meta">
            {hit.cwd && (
              <span className="session-project-tag">
                {hit.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}
              </span>
            )}
            {hit.profile && (
              <span className="session-profile-tag">{hit.profile}</span>
            )}
            <span title={new Date(hit.last_message_at).toLocaleString()}>{timeAgo(hit.last_message_at)}</span>
          </div>
        </button>
      ))}
      {hasMore && !error && <button type="button" className="search-more" disabled={searching} onClick={onLoadMore}>Show more</button>}
    </div>
  );
}
