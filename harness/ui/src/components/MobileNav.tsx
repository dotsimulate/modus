import type { View } from "../views";

type NavLink = { view: View; label: string };

type Props = {
  open: boolean;
  onClose: () => void;
  navLinks: NavLink[];
  currentView: View;
  onNavigate: (view: View) => void;
};

export function MobileNav({ open, onClose, navLinks, currentView, onNavigate }: Props) {
  return (
    <>
      {open && <div className="mobile-nav-overlay" onClick={onClose} />}
      <div className={`mobile-nav${open ? " open" : ""}`}>
        <nav className="mobile-nav-links">
          {navLinks.map((nv) => (
            <button
              key={nv.view}
              className={`mobile-nav-link${currentView === nv.view ? " active" : ""}`}
              onClick={() => { onNavigate(nv.view); onClose(); }}
            >
              {nv.label}
            </button>
          ))}
        </nav>
      </div>
    </>
  );
}
