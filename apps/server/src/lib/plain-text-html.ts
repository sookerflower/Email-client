/**
 * Plain-text → HTML conversion for outgoing mail bodies.
 *
 * The chat agent's sendEmail tool produces prose with \n line breaks. That
 * body used to be placed verbatim into nodemailer's `html:` slot, where a
 * newline is just whitespace — every paragraph break collapsed and the mail
 * arrived as one continuous block. The conversion lives here, in code, so it
 * is deterministic and testable; the model keeps emitting prose (never HTML).
 *
 * Escaping happens BEFORE markup is added: the body is untrusted model/user
 * text, and a literal `<` or `&` must arrive as a visible character, not as
 * markup (or worse, an injected element).
 */

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Blank line = paragraph boundary; single newline = line break. */
export const plainTextToHtml = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');

/**
 * The single seam deciding what nodemailer gets for a message body.
 *
 * 'text'          → multipart: the original prose in `text:` (plain-text
 *                   clients read it correctly) plus the derived HTML.
 * 'html' / absent → `html:` verbatim, exactly as before this seam existed —
 *                   the composer's TipTap output and every legacy caller
 *                   (including stored outbox payloads) are untouched.
 */
export const messageBodyParts = (
  message: string,
  bodyType?: 'html' | 'text',
): { html: string; text?: string } =>
  bodyType === 'text' ? { text: message, html: plainTextToHtml(message) } : { html: message };
