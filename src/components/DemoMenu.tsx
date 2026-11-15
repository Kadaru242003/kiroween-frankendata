/**
 * "Load demo" dropdown for the compact toolbar (shown once tables are loaded).
 * A button that opens a small menu of the bundled demos. Closes on outside
 * click and Esc. Items already loaded are disabled.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import "./DemoMenu.css";

export interface DemoMenuItem {
  id: string;
  label: string;
  loaded: boolean;
}

export interface DemoMenuProps {
  items: readonly DemoMenuItem[];
  onSelect: (id: string) => void;
  disabled?: boolean;
}

export function DemoMenu({ items, onSelect, disabled = false }: DemoMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="demo-menu" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="demo-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        Load demo
        <span aria-hidden="true"> ▾</span>
      </button>
      {open ? (
        <ul className="demo-menu__list" role="menu" aria-label="Load demo">
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className="demo-menu__item"
                disabled={item.loaded || disabled}
                onClick={() => {
                  setOpen(false);
                  onSelect(item.id);
                }}
              >
                {item.label}
                {item.loaded ? " (loaded)" : ""}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default DemoMenu;
