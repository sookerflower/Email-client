export type Token =
  | { type: 'LPAREN' | 'RPAREN' | 'NOT' | 'OR' | 'AND' }
  | { type: 'TERM'; operator?: string; value: string };

export type SearchASTNode =
  | { op: 'AND' | 'OR'; children: SearchASTNode[] }
  | { op: 'NOT'; child: SearchASTNode }
  | { op: 'text'; value: string }
  | { op: 'is' | 'has'; value: string }
  | { op: 'after' | 'before'; date: string }
  | { op: 'from' | 'to' | 'cc' | 'subject' | 'label' | 'in'; value: string }
  | { op: 'unknown'; operator: string; value: string };

export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) {
      i++;
      continue;
    }
    if (query[i] === '(') {
      tokens.push({ type: 'LPAREN' });
      i++;
      continue;
    }
    if (query[i] === ')') {
      tokens.push({ type: 'RPAREN' });
      i++;
      continue;
    }
    const upperQuery = query.slice(i).toUpperCase();
    if (upperQuery.startsWith('NOT ') || upperQuery.startsWith('NOT(') || query[i] === '-') {
      tokens.push({ type: 'NOT' });
      i += query[i] === '-' ? 1 : 3;
      continue;
    }
    if (upperQuery.startsWith('OR ') || upperQuery.startsWith('OR(')) {
      tokens.push({ type: 'OR' });
      i += 2;
      continue;
    }
    if (upperQuery.startsWith('AND ') || upperQuery.startsWith('AND(')) {
      tokens.push({ type: 'AND' });
      i += 3;
      continue;
    }

    let operator: string | undefined;
    let value = '';
    const colonIdx = query.indexOf(':', i);
    let spaceIdx = query.indexOf(' ', i);
    let parenIdx = query.indexOf('(', i);
    let rparenIdx = query.indexOf(')', i);
    
    let endOfWord = query.length;
    if (spaceIdx !== -1) endOfWord = Math.min(endOfWord, spaceIdx);
    if (parenIdx !== -1) endOfWord = Math.min(endOfWord, parenIdx);
    if (rparenIdx !== -1) endOfWord = Math.min(endOfWord, rparenIdx);

    if (colonIdx !== -1 && colonIdx < endOfWord) {
      const slice = query.slice(i, colonIdx);
      if (/^[a-zA-Z_]+$/.test(slice)) {
        operator = slice.toLowerCase();
        i = colonIdx + 1;
      }
    }

    if (i < query.length && query[i] === '"') {
      i++;
      let start = i;
      while (i < query.length && query[i] !== '"') {
        if (query[i] === '\\' && i + 1 < query.length) {
          i += 2;
        } else {
          i++;
        }
      }
      value = query.slice(start, i).replace(/\\"/g, '"');
      if (i < query.length) i++;
    } else {
      let start = i;
      while (i < query.length && !/\s/.test(query[i]) && query[i] !== '(' && query[i] !== ')') {
        i++;
      }
      value = query.slice(start, i);
    }

    if (value || operator) {
      const upperValue = value.toUpperCase();
      if (!operator && upperValue === 'OR') {
        tokens.push({ type: 'OR' });
      } else if (!operator && upperValue === 'AND') {
        tokens.push({ type: 'AND' });
      } else if (!operator && upperValue === 'NOT') {
        tokens.push({ type: 'NOT' });
      } else {
        tokens.push({ type: 'TERM', operator, value });
      }
    }
  }
  return tokens;
}

export function parseSearch(query: string): SearchASTNode | null {
  const tokens = tokenize(query);
  let pos = 0;

  function parseExpression(): SearchASTNode | null {
    let nodes: SearchASTNode[] = [];
    while (pos < tokens.length && tokens[pos].type !== 'RPAREN') {
      const token = tokens[pos];
      if (token.type === 'OR') {
        pos++;
        const right = parseTerm();
        if (right) {
          const left = nodes.length > 0 ? nodes.pop() : null;
          if (left) {
            if (left.op === 'OR') {
              left.children.push(right);
              nodes.push(left);
            } else {
              nodes.push({ op: 'OR', children: [left, right] });
            }
          } else {
            nodes.push(right);
          }
        }
      } else if (token.type === 'AND') {
        pos++;
      } else {
        const term = parseTerm();
        if (term) nodes.push(term);
      }
    }
    if (nodes.length === 0) return null;
    if (nodes.length === 1) return nodes[0];
    const andChildren: SearchASTNode[] = [];
    for (const node of nodes) {
      if (node.op === 'AND') {
        andChildren.push(...node.children);
      } else {
        andChildren.push(node);
      }
    }
    return { op: 'AND', children: andChildren };
  }

  function parseTerm(): SearchASTNode | null {
    if (pos >= tokens.length) return null;
    const token = tokens[pos];
    if (token.type === 'LPAREN') {
      pos++;
      const expr = parseExpression();
      if (pos < tokens.length && tokens[pos].type === 'RPAREN') {
        pos++;
      }
      return expr;
    }
    if (token.type === 'NOT') {
      pos++;
      const expr = parseTerm();
      if (!expr) return null;
      if (expr.op === 'NOT') return expr.child;
      return { op: 'NOT', child: expr };
    }
    if (token.type === 'TERM') {
      pos++;
      const { operator, value } = token;
      if (!operator || operator === 'intext') {
        return { op: 'text', value: value! };
      }
      switch (operator) {
        case 'filename':
        case 'bcc':
          return { op: 'unknown', operator, value: value! };
        case 'from':
        case 'to':
        case 'cc':
        case 'subject':
        case 'label':
        case 'in':
          return { op: operator, value: value! };
        case 'is':
          return { op: 'is', value: value! };
        case 'has':
          return { op: 'has', value: value! };
        case 'after':
        case 'newer_than':
          return { op: 'after', date: value! };
        case 'before':
        case 'older_than':
          return { op: 'before', date: value! };
        default:
          return { op: 'unknown', operator, value: value! };
      }
    }
    pos++;
    return null;
  }

  return parseExpression();
}
