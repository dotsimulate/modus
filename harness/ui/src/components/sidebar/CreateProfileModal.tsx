import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { saveUserProfileApi } from "../../api";
import type { UserProfile, Profile } from "../../api";
import { FolderPicker } from "../FolderPicker";

type Props = {
  onClose: () => void;
  onCreated: (name: string) => void;
  agentProfiles: Profile[];
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function CreateProfileModal({ onClose, onCreated, agentProfiles }: Props) {
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  const handleDisplayNameChange = (v: string) => {
    setDisplayName(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  const handleSlugChange = (v: string) => {
    setSlugEdited(true);
    setSlug(slugify(v));
  };

  const toggleAgent = (name: string) => {
    setSelectedAgents((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };

  const removeProject = (path: string) => {
    setProjects((prev) => prev.filter((p) => p !== path));
  };

  const handleSave = async () => {
    if (!slug || !displayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const profile: Omit<UserProfile, "name"> = {
        displayName: displayName.trim(),
        projects,
        ...(selectedAgents.length > 0 ? { agentProfiles: selectedAgents } : {}),
      };
      await saveUserProfileApi(slug, profile);
      onCreated(slug);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && e.metaKey && slug && displayName.trim()) handleSave();
  };

  const canSave = slug.length > 0 && displayName.trim().length > 0;

  return createPortal(
    <div className="create-profile-backdrop">
      <div
        className="create-profile-modal"
        onKeyDown={handleKeyDown}
      >
        <div className="create-profile-header">
          <span className="create-profile-title">new profile</span>
          <button className="create-profile-close" onClick={onClose}>&times;</button>
        </div>

        <div className="create-profile-body">
          <label className="create-profile-label">display name</label>
          <input
            ref={nameRef}
            className="create-profile-input"
            value={displayName}
            onChange={(e) => handleDisplayNameChange(e.target.value)}
            placeholder="e.g. My Project"
            spellCheck={false}
          />

          <label className="create-profile-label">
            slug
            <span className="create-profile-hint">{slug ? `profiles/users/${slug}.json` : ""}</span>
          </label>
          <input
            className="create-profile-input create-profile-input--mono"
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
            placeholder="auto-generated"
            spellCheck={false}
          />

          <label className="create-profile-label">project paths</label>
          <div className="create-profile-paths">
            {projects.map((p) => (
              <div key={p} className="create-profile-path">
                <span className="create-profile-path-text">{p}</span>
                <button className="create-profile-path-remove" onClick={() => removeProject(p)}>x</button>
              </div>
            ))}
            {showFolderPicker ? (
              <div className="create-profile-folder-picker">
                <FolderPicker
                  onSelect={(path) => {
                    if (!projects.includes(path)) setProjects((prev) => [...prev, path]);
                    setShowFolderPicker(false);
                  }}
                  onCancel={() => setShowFolderPicker(false)}
                />
              </div>
            ) : (
              <button
                className="create-profile-add-path"
                onClick={() => setShowFolderPicker(true)}
              >
                + add path
              </button>
            )}
          </div>

          {agentProfiles.length > 0 && (
            <>
              <label className="create-profile-label">agent profiles</label>
              <div className="create-profile-agents">
                {agentProfiles.map((ap) => (
                  <button
                    key={ap.name}
                    className={`create-profile-agent${selectedAgents.includes(ap.name) ? " selected" : ""}`}
                    onClick={() => toggleAgent(ap.name)}
                  >
                    {ap.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {error && <div className="create-profile-error">{error}</div>}
        </div>

        <div className="create-profile-footer">
          <button className="create-profile-cancel" onClick={onClose}>cancel</button>
          <button
            className="create-profile-save"
            onClick={handleSave}
            disabled={!canSave || saving}
          >
            {saving ? "creating..." : "create profile"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
