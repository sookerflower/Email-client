/**
 * Draft-autosave state policy for the email composer.
 *
 * Exists because the composer's inline handling cleared `hasUnsavedChanges`
 * in saveDraft's catch/finally — a FAILED save marked the compose clean, so
 * autosave never retried and the user's text survived only if the send
 * succeeded. One network blip silently lost the email.
 *
 * The policy is a pure reducer so the invariant lives in tested code:
 *   - an edit marks the compose dirty and resets the failure count;
 *   - a successful save is the ONLY thing that marks it clean;
 *   - a failed save keeps it dirty and counts the failure.
 *
 * Retry discipline (deliberately bounded — every draft save is an IMAP
 * APPEND against the mail server, and this project has a fail2ban history;
 * hammering a failing server is how that started):
 *   - first save after an edit waits the base debounce (3s);
 *   - after failures the delay backs off exponentially: 6s, 12s, 24s;
 *   - after MAX_DRAFT_SAVE_ATTEMPTS consecutive failures (4) autosave
 *     STOPS scheduling entirely — the failure is surfaced to the user, and
 *     only the next edit (which resets the count) re-arms it.
 */

export const DRAFT_AUTOSAVE_DELAY_MS = 3_000;
export const MAX_DRAFT_SAVE_ATTEMPTS = 4;
export const MAX_DRAFT_SAVE_DELAY_MS = 24_000;

export interface DraftAutosaveState {
  /** True when the compose holds changes not yet persisted anywhere. */
  dirty: boolean;
  /** Consecutive failed save attempts since the last edit or success. */
  failures: number;
}

export const initialDraftAutosaveState: DraftAutosaveState = {
  dirty: false,
  failures: 0,
};

export type DraftAutosaveEvent =
  | { type: 'edit' }
  | { type: 'save-success' }
  | { type: 'save-failure' };

export function reduceDraftAutosave(
  state: DraftAutosaveState,
  event: DraftAutosaveEvent,
): DraftAutosaveState {
  switch (event.type) {
    case 'edit':
      return { dirty: true, failures: 0 };
    case 'save-success':
      return { dirty: false, failures: 0 };
    case 'save-failure':
      // THE invariant this module exists for: failure keeps the compose
      // dirty. Clearing here is what silently lost user mail.
      return { dirty: true, failures: state.failures + 1 };
  }
}

/** Whether the autosave timer should be armed at all. */
export function shouldScheduleDraftSave(state: DraftAutosaveState): boolean {
  return state.dirty && state.failures < MAX_DRAFT_SAVE_ATTEMPTS;
}

/** Delay before the next save attempt: base debounce, then capped backoff. */
export function nextDraftSaveDelayMs(state: DraftAutosaveState): number {
  if (state.failures === 0) return DRAFT_AUTOSAVE_DELAY_MS;
  return Math.min(DRAFT_AUTOSAVE_DELAY_MS * 2 ** state.failures, MAX_DRAFT_SAVE_DELAY_MS);
}
