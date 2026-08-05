/**
 * Draft-save state policy for the email composer — MANUAL model.
 *
 * Drafts are saved only when the user explicitly asks (Save draft button,
 * Cmd/Ctrl+S, the send path, or the close guard's "Save draft" choice).
 * There is deliberately NO timer and NO automatic retry: every draft save
 * is an IMAP APPEND against the mail server, this project has a fail2ban
 * history, and with a manual button the user retries by clicking.
 *
 * What survives from the autosave era is the invariant that predates the
 * model change (it was the whole point of the b39e2348 fix, and it still
 * applies): a FAILED save must NOT clear the unsaved state. The compose is
 * clean only after a save actually succeeds. The failure count is kept so
 * the UI can tell a first failure from a repeating one.
 */

export interface DraftSaveState {
  /** True when the compose holds changes not yet persisted anywhere. */
  dirty: boolean;
  /** Consecutive failed save attempts since the last edit or success. */
  failures: number;
}

export const initialDraftSaveState: DraftSaveState = {
  dirty: false,
  failures: 0,
};

export type DraftSaveEvent =
  | { type: 'edit' }
  | { type: 'save-success' }
  | { type: 'save-failure' };

export function reduceDraftSave(state: DraftSaveState, event: DraftSaveEvent): DraftSaveState {
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
