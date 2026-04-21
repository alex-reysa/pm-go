import { useInput, type Key } from "ink";
import { useEffect, useRef } from "react";

/**
 * All actions the TUI can fire. Worker 2 consumes the navigation /
 * selection ones; Worker 3 wires the seven operator-action variants
 * to confirm modals + apiClient calls. Keeping the full set in one
 * table means the footer cheatsheet is always in sync with what's
 * actually bound.
 */
export type TuiAction =
  | { kind: "select-next" }
  | { kind: "select-prev" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "run-task" }
  | { kind: "review-task" }
  | { kind: "fix-task" }
  | { kind: "integrate-phase" }
  | { kind: "audit-phase" }
  | { kind: "complete-plan" }
  | { kind: "release-plan" }
  // Phase 7 — operator approve action. Disabled when no pending
  // approval_requests row exists for the selected task.
  | { kind: "approve-task" };

/**
 * Each binding is a space-separated sequence of tokens. A token is
 * either a printable character (`j`, `R`, `?`) or a named key
 * (`enter`, `esc`). Multi-token chords start with a prefix key
 * (today always `g`) and fire when the sequence completes.
 *
 * The label is what the footer renders; the chord is what's typed.
 */
export interface KeyBinding {
  chord: string;
  action: TuiAction;
  label: string;
}

export const KEYBINDS: readonly KeyBinding[] = [
  { chord: "j",      action: { kind: "select-next" },       label: "j/↓ down" },
  { chord: "down",   action: { kind: "select-next" },       label: "" },
  { chord: "k",      action: { kind: "select-prev" },       label: "k/↑ up" },
  { chord: "up",     action: { kind: "select-prev" },       label: "" },
  { chord: "enter",  action: { kind: "confirm" },           label: "enter select" },
  { chord: "esc",    action: { kind: "cancel" },            label: "esc back" },
  { chord: "?",      action: { kind: "help" },              label: "? help" },
  { chord: "q",      action: { kind: "quit" },              label: "q quit" },
  { chord: "g r",    action: { kind: "run-task" },          label: "gr run" },
  { chord: "g v",    action: { kind: "review-task" },       label: "gv review" },
  { chord: "g f",    action: { kind: "fix-task" },          label: "gf fix" },
  { chord: "g i",    action: { kind: "integrate-phase" },   label: "gi integrate" },
  { chord: "g a",    action: { kind: "audit-phase" },       label: "ga audit" },
  { chord: "g c",    action: { kind: "complete-plan" },     label: "gc complete" },
  { chord: "g R",    action: { kind: "release-plan" },      label: "gR release" },
  // Phase 7 — operator approve. Capital `A` deliberately distinct
  // from the lowercase `a` audit chord so a typo doesn't fire the
  // wrong action mid-merge.
  { chord: "g A",    action: { kind: "approve-task" },      label: "gA approve" },
];

/**
 * Chord timeout — after this many ms with no follow-up, a pending
 * prefix is cleared. 500ms is comfortable for muscle-memory vim-style
 * chords without feeling laggy on a single-keystroke `j`/`k`.
 */
export const CHORD_TIMEOUT_MS = 500;

type MatchResult =
  | { kind: "exact"; binding: KeyBinding }
  | { kind: "prefix" }
  | { kind: "none" };

/**
 * Pure chord-matcher. Given the current buffer (array of typed
 * tokens) and the binding table, return whether it's a full match,
 * a live prefix, or dead. Exposed for unit testing.
 */
export function matchChord(
  buffer: readonly string[],
  bindings: readonly KeyBinding[] = KEYBINDS,
): MatchResult {
  const current = buffer.join(" ");
  for (const binding of bindings) {
    if (binding.chord === current) return { kind: "exact", binding };
  }
  for (const binding of bindings) {
    if (binding.chord.startsWith(`${current} `) && current.length > 0) {
      return { kind: "prefix" };
    }
  }
  return { kind: "none" };
}

/**
 * Normalise an Ink key event into a single chord token. Returns `null`
 * for key events we ignore (e.g. raw modifier presses, `ctrl`+anything
 * outside our reserved bindings). Exposed for unit testing.
 */
export function keyEventToToken(input: string, key: Key): string | null {
  if (key.escape) return "esc";
  if (key.return) return "enter";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  // No chord uses tab/backspace today; reserve them for future inline
  // editors without the current bindings eating them.
  if (key.tab || key.backspace || key.delete) return null;
  if (key.ctrl || key.meta) return null;
  if (input.length === 0) return null;
  return input;
}

/**
 * React hook: subscribe to stdin via Ink's `useInput` and dispatch
 * `TuiAction`s as chords complete. Chord buffer resets after
 * `CHORD_TIMEOUT_MS` of inactivity so a lone `g` doesn't wedge the
 * dispatcher.
 */
export function useKeybinds(
  dispatch: (action: TuiAction) => void,
  bindings: readonly KeyBinding[] = KEYBINDS,
): void {
  const bufferRef = useRef<string[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const clearBuffer = () => {
    bufferRef.current = [];
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => () => clearBuffer(), []);

  useInput((input, key) => {
    const token = keyEventToToken(input, key);
    if (token === null) return;

    bufferRef.current = [...bufferRef.current, token];
    if (timerRef.current !== null) clearTimeout(timerRef.current);

    const result = matchChord(bufferRef.current, bindings);
    if (result.kind === "exact") {
      dispatch(result.binding.action);
      clearBuffer();
      return;
    }
    if (result.kind === "prefix") {
      timerRef.current = setTimeout(() => {
        bufferRef.current = [];
        timerRef.current = null;
      }, CHORD_TIMEOUT_MS);
      return;
    }
    // No match and no prefix — drop the buffer. Most real-world typos
    // (e.g. `g x`) land here; the user just re-types.
    clearBuffer();
  });
}
