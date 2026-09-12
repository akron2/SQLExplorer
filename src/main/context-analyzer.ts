export interface SqlScopeEntry {
  alias: string;
  aliasQuoted: boolean;
  cteColumns?: string[];
  object: string;
  objectQuoted: boolean;
  schema?: string;
  schemaQuoted: boolean;
  source: 'cte' | 'table';
}

export interface SqlQualifier {
  name: string;
  quoted: boolean;
  schema?: string;
  schemaQuoted: boolean;
}

export interface AnalyzedSqlContext {
  cteNames: string[];
  inFromClause: boolean;
  prefix: string;
  prefixQuoted: boolean;
  qualifier?: SqlQualifier;
  replaceEnd: number;
  replaceStart: number;
  scopes: SqlScopeEntry[];
}

interface Token {
  end: number;
  kind: 'dot' | 'ident' | 'other' | 'quoted';
  start: number;
  value: string;
}

const IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$#]*)';

const SQL_KEYWORDS = new Set([
  'and', 'as', 'asc', 'begin', 'between', 'by', 'case', 'connect', 'cross', 'current',
  'declare', 'delete', 'desc', 'distinct', 'else', 'end', 'except', 'exists', 'fetch',
  'for', 'from', 'full', 'group', 'having', 'in', 'inner', 'insert', 'intersect', 'into',
  'is', 'join', 'left', 'like', 'limit', 'lock', 'merge', 'minus', 'natural', 'not',
  'null', 'offset', 'on', 'or', 'order', 'outer', 'over', 'partition', 'returning',
  'right', 'row', 'select', 'set', 'start', 'then', 'union', 'update', 'using', 'values',
  'when', 'where', 'with',
]);

export function unquoteIdentifier(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('""', '"');
  }
  return value;
}

function maskSql(text: string): { depth: number[]; masked: string } {
  const masked = text.split('');
  const depth: number[] = new Array<number>(text.length).fill(0);
  let level = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '-' && next === '-') {
      while (index < text.length && text[index] !== '\n') {
        masked[index] = ' ';
        depth[index] = level;
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      depth[index] = level;
      depth[index + 1] = level;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        masked[index] = text[index] === '\n' ? '\n' : ' ';
        depth[index] = level;
        index += 1;
      }
      if (index < text.length) {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        depth[index] = level;
        depth[index + 1] = level;
        index += 2;
      }
      continue;
    }
    if (character === "'") {
      masked[index] = ' ';
      depth[index] = level;
      index += 1;
      while (index < text.length) {
        const quote = text[index] === "'";
        masked[index] = text[index] === '\n' ? '\n' : ' ';
        depth[index] = level;
        if (quote && text[index + 1] === "'") {
          masked[index + 1] = ' ';
          depth[index + 1] = level;
          index += 2;
          continue;
        }
        index += 1;
        if (quote) break;
      }
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < text.length) {
        const quote = text[index] === '"';
        if (quote && text[index + 1] === '"') {
          index += 2;
          continue;
        }
        index += 1;
        if (quote) break;
      }
      continue;
    }
    const dollar = text.slice(index).match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/iu);
    if (dollar) {
      const tag = dollar[0];
      let end = index;
      while (end < text.length) {
        masked[end] = text[end] === '\n' ? '\n' : ' ';
        depth[end] = level;
        end += 1;
      }
      index += tag.length;
      while (index < text.length && !text.startsWith(tag, index)) {
        masked[index] = text[index] === '\n' ? '\n' : ' ';
        depth[index] = level;
        index += 1;
      }
      if (index < text.length) {
        for (let offset = 0; offset < tag.length && index + offset < text.length; offset += 1) {
          masked[index + offset] = ' ';
          depth[index + offset] = level;
        }
        index += tag.length;
      }
      continue;
    }
    if (character === '(') {
      depth[index] = level;
      level += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      level = Math.max(0, level - 1);
      depth[index] = level;
      index += 1;
      continue;
    }
    depth[index] = level;
    index += 1;
  }
  return { masked: masked.join(''), depth };
}

function tokenizePrefix(text: string, offset: number): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < offset) {
    const character = text[index];
    const next = text[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      while (index < offset && text[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < offset && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index = Math.min(offset, index + 2);
      continue;
    }
    if (character === "'") {
      index += 1;
      while (index < offset) {
        if (text[index] === "'" && text[index + 1] === "'") {
          index += 2;
          continue;
        }
        index += 1;
        if (text[index - 1] === "'") break;
      }
      continue;
    }
    if (character === '"') {
      const start = index;
      let closed = false;
      index += 1;
      while (index < offset) {
        if (text[index] === '"' && text[index + 1] === '"') {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      const raw = text.slice(start, index);
      tokens.push({
        kind: 'quoted',
        start,
        end: index,
        value: closed ? raw.slice(1, -1).replaceAll('""', '"') : text.slice(start + 1),
      });
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < offset && /[A-Za-z0-9_$#]/u.test(text[index])) index += 1;
      tokens.push({ kind: 'ident', start, end: index, value: text.slice(start, index) });
      continue;
    }
    if (character === '.') {
      tokens.push({ kind: 'dot', start: index, end: index + 1, value: '.' });
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < offset && !/[\s"'A-Za-z_.]/u.test(text[index]) && text[index] !== '-') index += 1;
    tokens.push({ kind: 'other', start, end: index, value: text.slice(start, index) });
  }
  return tokens;
}

function splitTopLevel(text: string, depth: number[], start: number, end: number): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  let segmentStart = start;
  const baseDepth = depth[start] ?? 0;
  for (let index = start; index < end; index += 1) {
    const character = text[index];
    if (character === '(') continue;
    if (character === ')' && (depth[index] ?? 0) < baseDepth) break;
    if (character === ',' && (depth[index] ?? 0) <= baseDepth) {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }
  segments.push([segmentStart, end]);
  return segments;
}

function parseSelectList(body: string): string[] {
  const selectMatch = /\bselect\b/iu.exec(body);
  if (!selectMatch) return [];
  const fromMatch = /\bfrom\b/iu.exec(body.slice(selectMatch.index + selectMatch[0].length));
  const listStart = selectMatch.index + selectMatch[0].length;
  const listEnd = fromMatch ? listStart + fromMatch.index : body.length;
  const list = body.slice(listStart, listEnd);
  const { depth } = maskSql(list);
  const result: string[] = [];
  for (const [start, end] of splitTopLevel(list, depth, 0, list.length)) {
    const value = list.slice(start, end).trim();
    if (!value || value === '*') continue;
    const aliasMatch = new RegExp(
      `(?:\\s+as\\s+|\\s+)(${IDENTIFIER})\\s*$`,
      'iu',
    ).exec(value);
    if (aliasMatch && !/\s(?:as)$/iu.test(value.slice(0, aliasMatch.index))) {
      const alias = unquoteIdentifier(aliasMatch[1]);
      if (!SQL_KEYWORDS.has(alias.toLocaleLowerCase())) {
        result.push(alias);
        continue;
      }
    }
    const dotted = new RegExp(`(?:^|\\.)(${IDENTIFIER})\\s*$`, 'u').exec(value);
    if (dotted) {
      result.push(unquoteIdentifier(dotted[1]));
      continue;
    }
    if (new RegExp(`^${IDENTIFIER}$`, 'u').test(value)) result.push(unquoteIdentifier(value));
  }
  return result;
}

function extractCtes(text: string, masked: string): SqlScopeEntry[] {
  const scopes: SqlScopeEntry[] = [];
  const pattern = new RegExp(
    `\\b(?:with|,)\\s*(${IDENTIFIER})\\s*(?:\\(([^)]*)\\))?\\s+as\\s*\\(`,
    'giu',
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    const openParen = match.index + match[0].length - 1;
    let level = 1;
    let cursor = openParen + 1;
    while (cursor < text.length && level > 0) {
      const character = text[cursor];
      if (character === '(' && /[^\s]/u.test(masked[cursor] ?? '')) level += 1;
      else if (character === ')' && /[^\s]/u.test(masked[cursor] ?? '')) level -= 1;
      cursor += 1;
    }
    if (level > 0) continue;
    const body = text.slice(openParen + 1, cursor - 1);
    const name = unquoteIdentifier(match[1]);
    const explicit = match[2]
      ? match[2].split(',').map((entry) => unquoteIdentifier(entry.trim())).filter(Boolean)
      : [];
    scopes.push({
      alias: name,
      aliasQuoted: match[1].startsWith('"'),
      object: name,
      objectQuoted: match[1].startsWith('"'),
      schema: undefined,
      schemaQuoted: false,
      source: 'cte',
      cteColumns: explicit.length ? explicit : parseSelectList(body),
    });
  }
  return scopes;
}

function extractTableScopes(text: string, masked: string, depth: number[]): SqlScopeEntry[] {
  const scopes: SqlScopeEntry[] = [];
  const itemPattern = new RegExp(
    `^\\s*(${IDENTIFIER})(?:\\s*\\.\\s*(${IDENTIFIER}))?(?:\\s+(?:as\\s+)?(${IDENTIFIER}))?`,
    'iu',
  );
  const terminator = /\b(?:where|group|order|having|union|intersect|minus|except|start|connect|for|returning|values|set|on|using|join|left|right|inner|full|cross|natural|select)\b/giu;

  const addScope = (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('(')) {
      const aliasMatch = new RegExp(`\\)\\s*(?:as\\s+)?(${IDENTIFIER})`, 'iu').exec(trimmed);
      if (aliasMatch) {
        const alias = unquoteIdentifier(aliasMatch[1]);
        scopes.push({
          alias,
          aliasQuoted: aliasMatch[1].startsWith('"'),
          object: '',
          objectQuoted: false,
          schema: undefined,
          schemaQuoted: false,
          source: 'table',
        });
      }
      return;
    }
    const item = itemPattern.exec(trimmed);
    if (!item) return;
    let object = unquoteIdentifier(item[2] ?? item[1]);
    let objectQuoted = (item[2] ?? item[1]).startsWith('"');
    let schema = item[2] ? unquoteIdentifier(item[1]) : undefined;
    let schemaQuoted = Boolean(item[2] && item[1].startsWith('"'));
    if (!object || SQL_KEYWORDS.has(object.toLocaleLowerCase())) return;
    let alias = item[3] ? unquoteIdentifier(item[3]) : object;
    let aliasQuoted = item[3] ? item[3].startsWith('"') : objectQuoted;
    const remainder = trimmed.slice(item[0].length).trimStart();
    if (remainder.startsWith('.') && !item[3]) return;
    if (remainder.startsWith('(')) {
      let level = 0;
      let cursor = 0;
      while (cursor < remainder.length) {
        if (remainder[cursor] === '(') level += 1;
        else if (remainder[cursor] === ')') {
          level -= 1;
          if (level === 0) break;
        }
        cursor += 1;
      }
      const aliasMatch = new RegExp(`^\\s*(?:as\\s+)?(${IDENTIFIER})`, 'iu')
        .exec(remainder.slice(cursor + 1));
      object = '';
      objectQuoted = false;
      schema = undefined;
      schemaQuoted = false;
      alias = aliasMatch ? unquoteIdentifier(aliasMatch[1]) : '';
      aliasQuoted = Boolean(aliasMatch?.[1].startsWith('"'));
      if (!alias) return;
    } else if (item[3] && SQL_KEYWORDS.has(alias.toLocaleLowerCase())) {
      alias = object;
      aliasQuoted = objectQuoted;
    }
    scopes.push({
      alias,
      aliasQuoted,
      object,
      objectQuoted,
      schema,
      schemaQuoted,
      source: 'table',
    });
  };

  const fromPattern = /\bfrom\b/giu;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(masked))) {
    const base = depth[match.index] ?? 0;
    let end = masked.length;
    terminator.lastIndex = match.index + match[0].length;
    let terminatorMatch: RegExpExecArray | null;
    while ((terminatorMatch = terminator.exec(masked))) {
      if ((depth[terminatorMatch.index] ?? 0) <= base) {
        end = terminatorMatch.index;
        break;
      }
    }
    for (const [start, stop] of splitTopLevel(masked, depth, match.index + match[0].length, end)) {
      addScope(text.slice(start, stop));
    }
  }

  const joinPattern = /\bjoin\b/giu;
  while ((match = joinPattern.exec(masked))) {
    const base = depth[match.index] ?? 0;
    let end = masked.length;
    terminator.lastIndex = match.index + match[0].length;
    let terminatorMatch: RegExpExecArray | null;
    while ((terminatorMatch = terminator.exec(masked))) {
      if ((depth[terminatorMatch.index] ?? 0) <= base) {
        end = terminatorMatch.index;
        break;
      }
    }
    addScope(text.slice(match.index + match[0].length, end));
  }
  return scopes;
}

function dedupeScopes(scopes: SqlScopeEntry[]): SqlScopeEntry[] {
  const result: SqlScopeEntry[] = [];
  const seen = new Set<string>();
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index];
    const key = scope.alias.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.unshift(scope);
  }
  return result;
}

function endsInFromClause(structure: string): boolean {
  const pattern = /\b(from|join|update|into)\b/giu;
  let last = -1;
  let lastKeyword = '';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(structure))) {
    last = match.index;
    lastKeyword = match[1].toLocaleLowerCase();
  }
  if (last < 0) return false;
  const after = structure.slice(last + lastKeyword.length);
  return !/\b(?:where|group|order|having|on|using|set|values|returning|select)\b/iu.test(after);
}

export function analyzeSqlContext(text: string, offset: number): AnalyzedSqlContext {
  const safeOffset = Math.max(0, Math.min(text.length, offset));
  const { depth, masked } = maskSql(text);
  const tokens = tokenizePrefix(text, safeOffset);
  const last = tokens.at(-1);
  const gap = last ? safeOffset - last.end : 0;
  let prefix = '';
  let prefixQuoted = false;
  let replaceStart = safeOffset;
  let tokenIndex = tokens.length - 1;
  if (last && gap === 0 && (last.kind === 'ident' || last.kind === 'quoted')) {
    prefix = last.value;
    prefixQuoted = last.kind === 'quoted';
    replaceStart = last.start;
    tokenIndex = tokens.length - 2;
  }
  const chain: Token[] = [];
  while (
    tokenIndex >= 1
    && tokens[tokenIndex].kind === 'dot'
    && (tokens[tokenIndex - 1].kind === 'ident' || tokens[tokenIndex - 1].kind === 'quoted')
  ) {
    chain.unshift(tokens[tokenIndex - 1]);
    tokenIndex -= 2;
  }
  const qualifier = chain.length
    ? {
        schema: chain.length > 1 ? chain[0].value : undefined,
        schemaQuoted: chain.length > 1 ? chain[0].kind === 'quoted' : false,
        name: chain.at(-1)?.value ?? '',
        quoted: chain.at(-1)?.kind === 'quoted',
      }
    : undefined;

  const ctes = extractCtes(text, masked);
  const tables = extractTableScopes(text, masked, depth);
  const scopes = dedupeScopes([...tables, ...ctes]);
  const structure = masked.slice(0, replaceStart).trimEnd();
  const inFromClause = endsInFromClause(structure);
  return {
    prefix,
    prefixQuoted,
    replaceStart,
    replaceEnd: safeOffset,
    qualifier,
    scopes,
    cteNames: ctes.map((cte) => cte.alias),
    inFromClause,
  };
}
