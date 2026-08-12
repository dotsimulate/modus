import type { SearchHit } from "../../../../sdk/index";
import { timeAgo } from "../../utils/format";

type Props = {
  results: SearchHit[];
  searching: boolean;
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
};

export function SearchResults({ results, searching, activeSessionId, onSelectSession }: Props) {
  return (
    <div className="search-results">
      {searching && results.length === 0 && (
        <div className="search-empty">searching...</div>
      )}
      {!searching && results.length === 0 && (
        <div className="search-empty">no results</div>
      )}
      {results.map((hit) => (
        <div
          key={hit.session_id}
          className={`session-item ${hit.session_id === activeSessionId ? "active" : ""}`}
          onClick={() => onSelectSession(hit.session_id)}
        >
          <div className="session-item-preview">
            <span className="session-item-text">{hit.preview}</span>
          </div>
          <div className="search-hit-snippet">{hit.snippet}</div>
          <div className="session-item-meta">
            {hit.cwd && (
              <span className="session-project-tag">
                {hit.cwd.replace(/\/+$/, "").split("/").pop()}
              </span>
            )}
            {hit.profile && (
              <span className="session-profile-tag">{hit.profile}</span>
            )}
            <span>{timeAgo(hit.last_message_at)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
