import { parseSearch, type SearchASTNode } from './search-parser';

/**
 * Guard for the AI search text fallback.
 *
 * `ai/search.ts` accepts a bare text answer when the model ignores the forced
 * tool call and returns the query as content. That is safe only if the content
 * really is a query. If the model narrates -- "Sure! Here are your unread
 * emails from Alice" -- an unguarded fallback turns the whole sentence into a
 * free-text search, which quietly returns nothing. The user sees a broken
 * feature rather than an error.
 */

/** Longest plausible generated query. Narration runs well past this. */
const MAX_QUERY_CHARS = 200;

/** A bare-keyword query is a few words, not a sentence. */
const MAX_BARE_KEYWORDS = 6;

const OPERATOR_OPS = new Set([
  'from',
  'to',
  'cc',
  'subject',
  'label',
  'in',
  'is',
  'has',
  'after',
  'before',
]);

const hasOperatorNode = (node: SearchASTNode | null): boolean => {
  if (!node) return false;
  if (node.op === 'AND' || node.op === 'OR') return node.children.some(hasOperatorNode);
  if (node.op === 'NOT') return hasOperatorNode(node.child);
  return OPERATOR_OPS.has(node.op);
};

export class InvalidGeneratedQueryError extends Error {
  constructor(reason: string, readonly raw: string) {
    super(`AI search could not produce a usable query (${reason})`);
    this.name = 'InvalidGeneratedQueryError';
  }
}

/**
 * Normalize and validate model output that is meant to BE a search query.
 * Throws InvalidGeneratedQueryError rather than letting narration through.
 */
export function coerceGeneratedQuery(raw: string): string {
  const text = (raw ?? '')
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/, '')
    .split('\n')[0]!
    .trim();

  if (!text) throw new InvalidGeneratedQueryError('empty response', raw);
  if (text.length > MAX_QUERY_CHARS) {
    throw new InvalidGeneratedQueryError(`response too long (${text.length} chars)`, raw);
  }

  let ast: SearchASTNode | null;
  try {
    ast = parseSearch(text);
  } catch (error) {
    throw new InvalidGeneratedQueryError(`unparseable: ${(error as Error).message}`, raw);
  }
  if (!ast) throw new InvalidGeneratedQueryError('parsed to nothing', raw);

  // An operator anywhere in the tree is proof this is a query, not prose.
  if (hasOperatorNode(ast)) return text;

  // No operator. A bare-keyword query is legitimate -- the prompt explicitly
  // tells the model to return bare keywords when no operator is needed
  // ("budget spreadsheet"), so requiring an operator would reject valid
  // searches. Distinguish keywords from narration by shape instead.
  if (/[.!?,;:]/.test(text)) {
    throw new InvalidGeneratedQueryError('reads as prose (sentence punctuation)', raw);
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > MAX_BARE_KEYWORDS) {
    throw new InvalidGeneratedQueryError(
      `reads as prose (${words.length} words, no operator)`,
      raw,
    );
  }

  return text;
}
