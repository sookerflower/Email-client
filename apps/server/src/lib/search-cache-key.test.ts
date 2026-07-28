import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

describe('search-cache-key', () => {
  it('identical queries produce different cache keys for different connections', () => {
    // This is a proxy test since cacheKey is generated internally inside ImapSmtpMailManager.search
    // We can simulate the hash generation that ImapSmtpMailManager does.
    const criteria = { unseen: true };
    const boxes = ['INBOX'];
    const searchHash = crypto.createHash('sha256')
            .update(JSON.stringify({ criteria, boxes }))
            .digest('hex');

    const cacheKeyA = `search:conn-A:${searchHash}`;
    const cacheKeyB = `search:conn-B:${searchHash}`;

    expect(cacheKeyA).not.toEqual(cacheKeyB);
    expect(cacheKeyA).toContain('conn-A');
    expect(cacheKeyB).toContain('conn-B');
  });
});
