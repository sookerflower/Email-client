/**
 * Regression spec for the composer draft-save policy
 * (apps/mail/lib/draft-autosave.ts) — MANUAL-save model.
 *
 * History this spec guards:
 *  - b39e2348: saveDraft's catch AND finally both cleared the unsaved flag,
 *    so ONE rejected drafts.create marked the compose clean and the user's
 *    text was silently lost unless the send succeeded. The invariant —
 *    only a SUCCESSFUL save cleans — predates the manual model and still
 *    applies to it.
 *  - Manual model (this iteration): drafts persist only on explicit user
 *    action. There is NO timer and NO automatic retry (draft saves are IMAP
 *    APPENDs; this project has a fail2ban history — the user retries by
 *    clicking), so the policy exposes no scheduling: just the dirty/failure
 *    bookkeeping the composer and its close guard rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  initialDraftSaveState,
  reduceDraftSave,
  type DraftSaveState,
} from '../../apps/mail/lib/draft-autosave';

const afterEvents = (
  events: Parameters<typeof reduceDraftSave>[1][],
  from: DraftSaveState = initialDraftSaveState,
) => events.reduce(reduceDraftSave, from);

describe('draft save policy (manual model)', () => {
  it('starts clean', () => {
    expect(initialDraftSaveState).toEqual({ dirty: false, failures: 0 });
  });

  it('an edit marks the compose dirty', () => {
    expect(afterEvents([{ type: 'edit' }])).toEqual({ dirty: true, failures: 0 });
  });

  it('only success cleans; a FAILED save keeps the compose dirty', () => {
    // THE b39e2348 regression: the pre-fix composer cleared the flag on
    // failure, so the close guard would have let unsaved content vanish.
    const failed = afterEvents([{ type: 'edit' }, { type: 'save-failure' }]);
    expect(failed.dirty).toBe(true);

    const succeeded = afterEvents([{ type: 'edit' }, { type: 'save-success' }]);
    expect(succeeded).toEqual({ dirty: false, failures: 0 });
  });

  it('repeated failures stay dirty and are counted (first vs repeat is visible to the UI)', () => {
    let s = afterEvents([{ type: 'edit' }]);
    for (let i = 1; i <= 3; i++) {
      s = reduceDraftSave(s, { type: 'save-failure' });
      expect(s.dirty).toBe(true);
      expect(s.failures).toBe(i);
    }
  });

  it('an edit after failures resets the failure count but stays dirty', () => {
    const s = afterEvents([
      { type: 'edit' },
      { type: 'save-failure' },
      { type: 'save-failure' },
      { type: 'edit' },
    ]);
    expect(s).toEqual({ dirty: true, failures: 0 });
  });

  it('success after failures fully resets', () => {
    const s = afterEvents([
      { type: 'edit' },
      { type: 'save-failure' },
      { type: 'save-failure' },
      { type: 'save-success' },
    ]);
    expect(s).toEqual({ dirty: false, failures: 0 });
  });

  it('editing after a successful save re-dirties (close guard must re-arm)', () => {
    const s = afterEvents([
      { type: 'edit' },
      { type: 'save-success' },
      { type: 'edit' },
    ]);
    expect(s).toEqual({ dirty: true, failures: 0 });
  });
});
