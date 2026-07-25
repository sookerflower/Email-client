/**
 * Leaf module for StandardizedError so drivers can import it without pulling
 * in the rest of ./utils (which transitively imports server-utils, the DB,
 * and other workerd-bound modules). Kept dependency-free so the IMAP driver
 * can also run under plain Node in the sidecar.
 */
export class StandardizedError extends Error {
  code: string;
  operation: string;
  context?: Record<string, unknown>;
  originalError: unknown;
  constructor(error: Error & { code: string }, operation: string, context?: Record<string, unknown>) {
    super(error?.message || 'An unknown error occurred');
    this.name = 'StandardizedError';
    this.code = error?.code || 'UNKNOWN_ERROR';
    this.operation = operation;
    this.context = context;
    this.originalError = error;
  }
}
