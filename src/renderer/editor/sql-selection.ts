type ScannerState = 'normal' | 'single-quote' | 'double-quote' | 'line-comment' | 'block-comment' | 'dollar-quote';

function isProceduralBlock(sql: string): boolean {
  const cleaned = sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, '')
    .trimStart();
  return /^(?:declare|begin)\b/iu.test(cleaned);
}

export function statementRangeAtOffset(sql: string, offset: number): [number, number] {
  if (isProceduralBlock(sql)) return [0, sql.length];

  const boundaries = [0];
  let state: ScannerState = 'normal';
  let dollarTag = '';

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'normal';
        index += 1;
      }
      continue;
    }
    if (state === 'single-quote') {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") state = 'normal';
      continue;
    }
    if (state === 'double-quote') {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') state = 'normal';
      continue;
    }
    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        state = 'normal';
      }
      continue;
    }

    if (character === '-' && next === '-') {
      state = 'line-comment';
      index += 1;
    } else if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
    } else if (character === "'") {
      state = 'single-quote';
    } else if (character === '"') {
      state = 'double-quote';
    } else if (character === '$') {
      const match = sql.slice(index).match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/iu);
      if (match) {
        dollarTag = match[0];
        state = 'dollar-quote';
        index += dollarTag.length - 1;
      }
    } else if (character === ';') {
      boundaries.push(index + 1);
    }
  }
  if (boundaries.at(-1) !== sql.length) boundaries.push(sql.length);

  const safeOffset = Math.max(0, Math.min(sql.length, offset));
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    if (safeOffset < boundaries[index + 1]) return [boundaries[index], boundaries[index + 1]];
  }
  return [boundaries.at(-2) ?? 0, sql.length];
}

export function statementAtOffset(sql: string, offset: number): string {
  const [start, end] = statementRangeAtOffset(sql, offset);
  return sql.slice(start, end).trim();
}
