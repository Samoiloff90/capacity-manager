import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { INFO_TEXTS, type InfoKey } from "./info-texts";

const iconProps = {
  width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false
} as const;

export function PencilIcon() {
  return <svg {...iconProps}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
}

export function TrashIcon() {
  return <svg {...iconProps}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>;
}

function InfoIcon() {
  return <svg {...iconProps} width={15} height={15}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5v.5" /></svg>;
}

/**
 * Icon-only delete: the word stays for screen readers and the tooltip, aria-label names the row.
 * `blocked` keeps the button focusable and says why deleting is not possible (describedBy).
 */
export function DeleteButton({ label, onClick, disabled, title, blocked, describedBy }: {
  label: string; onClick: () => void; disabled?: boolean; title?: string; blocked?: boolean; describedBy?: string;
}) {
  return <button type="button" className={`project-icon-button danger${blocked ? " blocked" : ""}`} aria-label={label} title={title ?? "Удалить"}
    disabled={disabled} aria-disabled={blocked || undefined} aria-describedby={describedBy} onClick={onClick}><TrashIcon /><span className="visually-hidden">Удалить</span></button>;
}

type PopoverPosition = { top: number; left: number };
const POPOVER_WIDTH = 330;

/**
 * An (i) button with a short explanation. Fixed positioning keeps the note visible inside
 * scrolling tables; Esc, a click elsewhere, scrolling or resizing close it.
 */
export function InfoHint({ info }: { info: InfoKey }) {
  const text = INFO_TEXTS[info];
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = position !== null;

  useLayoutEffect(() => {
    if (!position || !popover.current) return;
    const height = popover.current.offsetHeight;
    const anchor = button.current?.getBoundingClientRect();
    if (!anchor) return;
    const below = anchor.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - 6 - height) : below;
    if (top !== position.top) setPosition({ ...position, top });
  }, [position]);

  useEffect(() => {
    if (!open) return;
    const close = () => setPosition(null);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !popover.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
      button.current?.focus();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !popover.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function toggle() {
    if (open) { setPosition(null); return; }
    const anchor = button.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
    const left = Math.min(Math.max(8, anchor.left - 8), window.innerWidth - width - 8);
    setPosition({ top: anchor.bottom + 6, left });
  }

  return <>
    <button ref={button} type="button" className={`project-info-button${open ? " open" : ""}`}
      aria-label={`Пояснение: ${text.title}`} title={`Пояснение: ${text.title}`}
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}><InfoIcon /></button>
    {position && <span ref={popover} id={id} role="note" className="project-info-popover"
      style={{ top: position.top, left: position.left, width: Math.min(POPOVER_WIDTH, window.innerWidth - 16) }}>
      <strong>{text.title}</strong>
      {text.lines.map((line) => <span key={line}>{line}</span>)}
      {"example" in text && <span className="project-info-example">{text.example}</span>}
    </span>}
  </>;
}

/** Focus an element again once it is enabled; the page is busy for a moment after a dialog or a save. */
export function restoreFocus(element: HTMLElement | null) {
  let attempts = 0;
  const retry = () => {
    if (!element?.isConnected || document.activeElement !== document.body && document.activeElement !== null) return;
    if (!element.matches(":disabled")) { element.focus(); return; }
    if (++attempts < 40) window.setTimeout(retry, 50);
  };
  window.setTimeout(retry, 0);
}

/** Modal focus: start on `initial`, keep Tab inside, Esc answers `onEscape`, restore focus after. */
export function useDialogFocus(dialog: RefObject<HTMLElement>, initial: RefObject<HTMLElement>, onEscape: () => void) {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initial.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); escape.current(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const items = Array.from(dialog.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"))
        .filter((element) => !element.matches(":disabled"));
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index === items.length - 1 ? 0 : index + 1);
      event.preventDefault();
      items[next].focus();
    };
    const node = dialog.current;
    node?.addEventListener("keydown", onKey);
    return () => {
      node?.removeEventListener("keydown", onKey);
      restoreFocus(previous);
    };
  }, [dialog, initial]);
}

/** Id of the layer next to the page: while a dialog is open there, the page behind it is inert. */
export const DIALOG_ROOT_ID = "project-dialog-root";

/** A dialog opened from inside a tab is rendered outside the page, so inert does not reach it. */
export function DialogPortal({ children }: { children: ReactNode }) {
  const root = typeof document === "undefined" ? null : document.getElementById(DIALOG_ROOT_ID);
  return root ? createPortal(children, root) : <>{children}</>;
}
