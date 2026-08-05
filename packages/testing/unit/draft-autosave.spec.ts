/**
 * Regression spec for the composer draft-autosave policy
 * (apps/mail/lib/draft-autosave.ts).
 *
 * The original bug (browser red-proof, 2026-08-05): saveDraft's catch AND
 * finally both cleared hasUnsavedChanges, so ONE rejected drafts.create
 * marked the compose clean — autosave never retried even after the network
 * recovered, and the user's text was silently lost unless the send
 * succeeded. The policy now lives in this module and the composer routes
 * every dirty/failure transition through it.
 *
 * The retry discipline is part of the contract, not an implementation
 * detail: draft saves are IMAP APPENDs against the mail server, and this
 * project has a fail2ban history — retries must back off and stop at a cap
 * until the user edits again.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAFT_AUTOSAVE_DELAY_MS,
  MAX_DRAFT_SAVE_ATTEMPTS,
  MAX_DRAFT_SAVE_DELAY_MS,
  initialDraftAutosaveState,
  nextDraftSaveDelayMs,
  reduceDraftAutosave,
  shouldScheduleDraftSave,
  type DraftAutosaveState,
} from '../../apps/mail/lib/draft-autosave';

const afterEvents = (
  events: Parameters<typeof reduceDraftAutosave>[1][],
  from: DraftAutosaveState = initialDraftAutosaveState,
) => events.reduce(reduceDraftAutosave, from);

describe('draft autosave policy', () => {
  it('starts clean and unscheduled', () => {
    expect(initialDraftAutosaveState.dirty).toBe(false);
    expect(shouldScheduleDraftSave(initialDraftAutosaveState)).toBe(false);
  });

  it('an edit marks dirty and schedules at the base debounce', () => {
    const s = afterEvents([{ type: 'edit' }]);
    expect(s.dirty).toBe(true);
    expect(shouldScheduleDraftSave(s)).toBe(true);
    expect(nextDraftSaveDelayMs(s)).toBe(DRAFT_AUTOSAVE_DELAY_MS);
  });

  it('only success cleans; a FAILED save keeps the compose dirty', () => {
    // THE regression: the pre-fix composer cleared the flag on failure.
    const failed = afterEvents([{ type: 'edit' }, { type: 'save-failure' }]);
    expect(failed.dirty).toBe(true);

    const succeeded = afterEvents([{ type: 'edit' }, { type: 'save-success' }]);
    expect(succeeded.dirty).toBe(false);
    expect(shouldScheduleDraftSave(succeeded)).toBe(false);
  });

  it('failures back off exponentially and are capped', () => {
    let s = afterEvents([{ type: 'edit' }]);
    const delays: number[] = [];
    for (let i = 0; i < MAX_DRAFT_SAVE_ATTEMPTS - 1; i++) {
      s = reduceDraftAutosave(s, { type: 'save-failure' });
      delays.push(nextDraftSaveDelayMs(s));
    }
    expect(delays).toEqual([6_000, 12_000, 24_000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_DRAFT_SAVE_DELAY_MS);
  });

  it('stops scheduling at the attempt cap — no unbounded hammering', () => {
    let s = afterEvents([{ type: 'edit' }]);
    for (let i = 0; i < MAX_DRAFT_SAVE_ATTEMPTS; i++) {
      expect(shouldScheduleDraftSave(s)).toBe(true); // still allowed to try
      s = reduceDraftAutosave(s, { type: 'save-failure' });
    }
    // Cap reached: dirty (content is NOT saved) but no further scheduling.
    expect(s.dirty).toBe(true);
    expect(s.failures).toBe(MAX_DRAFT_SAVE_ATTEMPTS);
    expect(shouldScheduleDraftSave(s)).toBe(false);
  });

  it('the next edit resets the failure count and re-arms autosave', () => {
    const capped = afterEvents([
      { type: 'edit' },
      ...Array.from({ length: MAX_DRAFT_SAVE_ATTEMPTS }, () => ({ type: 'save-failure' as const })),
    ]);
    expect(shouldScheduleDraftSave(capped)).toBe(false);

    const edited = reduceDraftAutosave(capped, { type: 'edit' });
    expect(edited).toEqual({ dirty: true, failures: 0 });
    expect(shouldScheduleDraftSave(edited)).toBe(true);
    expect(nextDraftSaveDelayMs(edited)).toBe(DRAFT_AUTOSAVE_DELAY_MS);
  });

  it('success after failures fully resets', () => {
    const s = afterEvents([
      { type: 'edit' },
      { type: 'save-failure' },
      { type: 'save-failure' },
      { type: 'save-success' },
    ]);
    expect(s).toEqual({ dirty: false, failures: 0 });
    expect(shouldScheduleDraftSave(s)).toBe(false);
  });
});
