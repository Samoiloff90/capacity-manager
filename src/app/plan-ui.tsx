import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatScreenHours } from "../domain/capacity/input-format";

/** Hours on screen: «2 248 ч», «4,60 ч». */
export const hours = formatScreenHours;
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

const iconProps = {
  width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false
} as const;

export function WarnIcon() {
  return <svg {...iconProps}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4" /><path d="M12 17v.5" /></svg>;
}
export function CheckIcon() {
  return <svg {...iconProps}><path d="m5 12 4 4 10-10" /></svg>;
}
export function QuestionIcon() {
  return <svg {...iconProps}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" /><path d="M12 17v.5" /></svg>;
}
export function ChevronIcon() {
  return <svg {...iconProps}><path d="m9 6 6 6-6 6" /></svg>;
}
export function BackIcon() {
  return <svg {...iconProps}><path d="M15 6 9 12l6 6" /></svg>;
}
export function CloseIcon() {
  return <svg {...iconProps}><path d="M6 6l12 12M18 6 6 18" /></svg>;
}
export function DotsIcon() {
  return <svg {...iconProps}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></svg>;
}
export function TriangleIcon({ open }: { open: boolean }) {
  return <svg {...iconProps} width={12} height={12}>{open ? <path d="m6 9 6 6 6-6" /> : <path d="m9 6 6 6-6 6" />}</svg>;
}

/**
 * A state named by an icon and a word, never by colour alone: over (red), unknown (amber),
 * fits (green), plain (blue).
 */
export function Sign({ tone, children }: { tone: "over" | "unknown" | "fits" | "plain"; children: ReactNode }) {
  const icon = tone === "over" || tone === "unknown" ? <WarnIcon /> : tone === "fits" ? <CheckIcon /> : <CheckIcon />;
  return <span className={`pp-sign ${tone}`}>{icon}{children}</span>;
}

export function FillBar({ percent, over }: { percent: number | null; over: boolean }) {
  return <span className={`pp-bar${over ? " over" : ""}`} aria-hidden="true">
    <span style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} /></span>;
}

const KEYS = {
  save: isMac ? "⌘S" : "Ctrl+S",
  submit: isMac ? "⌘↩" : "Ctrl+Enter",
  enter: isMac ? "↩" : "Enter",
  esc: "Esc"
} as const;

export function Kbd({ name }: { name: keyof typeof KEYS }) {
  return <span className="pp-kbd">{KEYS[name]}</span>;
}

export const saveShortcut = KEYS.save;

/** Moves focus to the input of the same column in the next or previous row of a table. */
export function focusSibling(input: HTMLElement, column: string, step: 1 | -1): boolean {
  const row = input.closest("tr");
  let next = step === 1 ? row?.nextElementSibling : row?.previousElementSibling;
  while (next) {
    const target = next.querySelector<HTMLElement>(`[data-col="${column}"]`);
    if (target && !target.matches(":disabled")) { target.focus(); if (target instanceof HTMLInputElement) target.select(); return true; }
    next = step === 1 ? next.nextElementSibling : next.previousElementSibling;
  }
  return false;
}

/**
 * A text field whose value reaches the quarter only when it is understood. Until then the
 * typed text stays in the field and a pending key tells the controller that saving must
 * wait (setPending). Esc returns the value the field had when it got focus; Enter moves to
 * the same column of the next row.
 */
export function useCommittedText<T>(options: {
  value: T;
  show: (value: T) => string;
  parse: (text: string) => { ok: true; value: T } | { ok: false; message: string };
  commit: (value: T) => void;
  setPending: (message: string | null) => void;
  column: string;
  /** Committed while the text is not understood, so it does not count meanwhile (an unreadable share). */
  invalid?: { value: T };
}) {
  const { value, show, parse, commit, setPending, column, invalid } = options;
  const [text, setText] = useState(() => show(value));
  const [error, setError] = useState("");
  const focused = useRef(false);
  const atFocus = useRef(text);
  const pending = useRef(setPending);
  pending.current = setPending;

  // The draft changed elsewhere (undo, another field): show it unless the user is typing here.
  useEffect(() => {
    if (!focused.current && !error) setText(show(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // A field that disappears with unparsed text must not keep blocking the save.
  useEffect(() => () => pending.current(null), []);

  function change(next: string) {
    setText(next);
    const parsed = parse(next);
    if (parsed.ok) {
      setError("");
      setPending(null);
      commit(parsed.value);
    } else {
      setError(parsed.message);
      setPending(parsed.message);
      if (invalid) commit(invalid.value);
    }
  }

  return {
    text, error,
    inputProps: {
      value: text,
      "data-col": column,
      "aria-invalid": Boolean(error),
      // Focus coming back to a field with an error (after a refused save) keeps the value to return to.
      onFocus: () => { focused.current = true; if (!error) atFocus.current = text; },
      onBlur: () => {
        focused.current = false;
        const parsed = parse(text);
        if (parsed.ok) setText(show(parsed.value));
      },
      onChange: (event: { target: { value: string } }) => change(event.target.value),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          change(atFocus.current);
        } else if (event.key === "Enter") {
          event.preventDefault();
          focusSibling(event.currentTarget, column, event.shiftKey ? -1 : 1);
        }
      }
    }
  };
}
