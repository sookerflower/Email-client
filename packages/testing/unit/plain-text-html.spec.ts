import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  messageBodyParts,
  plainTextToHtml,
} from '../../apps/server/src/lib/plain-text-html';

describe('escapeHtml', () => {
  it('escapes &, <, > — & first so entities are not double-escaped', () => {
    expect(escapeHtml('if x < 5 & y > 2')).toBe('if x &lt; 5 &amp; y &gt; 2');
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('plainTextToHtml', () => {
  it('blank line = paragraph, single newline = line break', () => {
    expect(plainTextToHtml('Hi there,\n\nSecond paragraph.\n\nBest regards,\nRabi')).toBe(
      '<p>Hi there,</p><p>Second paragraph.</p><p>Best regards,<br>Rabi</p>',
    );
  });

  it('normalizes CRLF and collapses 3+ newlines into one paragraph break', () => {
    expect(plainTextToHtml('a\r\n\r\nb\n\n\n\nc')).toBe('<p>a</p><p>b</p><p>c</p>');
  });

  it('escapes BEFORE wrapping — markup in prose arrives as text, not elements', () => {
    expect(plainTextToHtml('a <b> tag & more\n\nnext')).toBe(
      '<p>a &lt;b&gt; tag &amp; more</p><p>next</p>',
    );
  });
});

describe('messageBodyParts', () => {
  it("'text' produces multipart: original prose in text, derived HTML", () => {
    const prose = 'Hi,\n\nBye.';
    expect(messageBodyParts(prose, 'text')).toEqual({
      text: prose,
      html: '<p>Hi,</p><p>Bye.</p>',
    });
  });

  it("'html' is byte-identical passthrough with NO text part (composer path)", () => {
    const html = '<p>Hi <b>there</b></p><p style="color: #666;">Sent via AxMail</p>';
    const parts = messageBodyParts(html, 'html');
    expect(parts).toEqual({ html });
    expect(parts.html).toBe(html); // same string, not a transformed copy
    expect('text' in parts).toBe(false);
  });

  it('absent flag = legacy html behavior (stored outbox payloads, old callers)', () => {
    const html = '<p>legacy</p>';
    expect(messageBodyParts(html, undefined)).toEqual({ html });
  });
});
