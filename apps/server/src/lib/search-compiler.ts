import type { SearchASTNode } from './search-parser';

export interface CompiledSearch {
  folders: { include: string[]; exclude: string[] };
  postgresLabelIds: string[];
  imapCriteria: Record<string, any>;
}

export function compileSearch(ast: SearchASTNode | null, baseFolder?: string): CompiledSearch {
  const folders: { include: string[]; exclude: string[] } = { include: [], exclude: [] };
  const postgresLabelIds: string[] = [];
  let includesTrashOrSpam = false;

  function walk(node: SearchASTNode | null): any {
    if (!node) return null;
    switch (node.op) {
      case 'AND': {
        const children = node.children.map(walk).filter(Boolean);
        if (children.length === 0) return null;
        if (children.length === 1) return children[0];
        let merged: any = {};
        for (const c of children) {
          for (const [k, v] of Object.entries(c)) {
            merged[k] = v;
          }
        }
        return merged;
      }
      case 'OR': {
        const children = node.children.map(walk).filter(Boolean);
        if (children.length === 0) return null;
        if (children.length === 1) return children[0];
        return { or: children };
      }
      case 'NOT': {
        const child = walk(node.child);
        if (!child) return null;
        return { not: child };
      }
      case 'from':
        return { from: node.value };
      case 'to':
        return { to: node.value };
      case 'cc':
        return { cc: node.value };
      case 'subject':
        return { subject: node.value };
      case 'text':
        return { text: node.value };
      case 'after':
        return { since: new Date(node.date!) };
      case 'before':
        return { before: new Date(node.date!) };
      case 'is': {
        const val = node.value.toLowerCase();
        if (val === 'unread') return { unseen: true };
        if (val === 'read') return { seen: true };
        if (val === 'important' || val === 'starred') return { flagged: true };
        if (['inbox', 'sent', 'draft', 'trash', 'spam'].includes(val)) {
          folders.include.push(val);
          if (val === 'trash' || val === 'spam') includesTrashOrSpam = true;
          return null;
        }
        throw new Error(`Unsupported is: value - ${val}`);
      }
      case 'has': {
        const val = node.value.toLowerCase();
        if (val === 'attachment') {
          return { header: { 'Content-Type': 'multipart/mixed' } };
        }
        throw new Error(`Unsupported has: value - ${val}`);
      }
      case 'label':
        postgresLabelIds.push(node.value);
        return null;
      case 'in': {
        const val = node.value.toLowerCase();
        if (val === 'anywhere') {
          folders.include.push('anywhere');
          includesTrashOrSpam = true;
          return null;
        }
        folders.include.push(val);
        if (val === 'trash' || val === 'spam') includesTrashOrSpam = true;
        return null;
      }
      case 'unknown':
        throw new Error(`Unsupported operator: ${node.operator}`);
    }
    throw new Error(`Unhandled AST node op: ${(node as any).op}`);
  }

  function walkForExclusions(node: SearchASTNode | null, isNegated = false) {
    if (!node) return;
    if (node.op === 'NOT') {
      walkForExclusions(node.child, !isNegated);
      return;
    }
    if (node.op === 'AND' || node.op === 'OR') {
      for (const child of node.children) {
        walkForExclusions(child, isNegated);
      }
      return;
    }
    if (isNegated) {
      if (node.op === 'is' && ['inbox', 'sent', 'draft', 'trash', 'spam'].includes(node.value.toLowerCase())) {
        folders.exclude.push(node.value.toLowerCase());
      }
      if (node.op === 'in' && node.value.toLowerCase() !== 'anywhere') {
        folders.exclude.push(node.value.toLowerCase());
      }
    }
  }

  walkForExclusions(ast);
  const imapCriteria = walk(ast) || {};

  if (folders.include.length === 0) {
    if (baseFolder) {
      folders.include.push(baseFolder);
    } else {
      folders.include.push('inbox');
    }
  }

  if (!includesTrashOrSpam && !folders.include.includes('anywhere')) {
    if (!folders.exclude.includes('trash')) folders.exclude.push('trash');
    if (!folders.exclude.includes('spam')) folders.exclude.push('spam');
    if (!folders.exclude.includes('drafts')) folders.exclude.push('drafts');
  }

  return { folders, postgresLabelIds, imapCriteria };
}
