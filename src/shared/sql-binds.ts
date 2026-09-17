import type { BindValueType, SqlDialect } from './contracts';

export type BindDialect = Extract<SqlDialect, 'oracle' | 'postgres'>;

export interface SqlParameterOccurrence {
  key: string;
  kind: 'named' | 'positional';
  length: number;
  name: string;
  offset: number;
}

export interface SqlParametersResult {
  error?: string;
  occurrences: SqlParameterOccurrence[];
}

type ScanState =
  | 'normal'
  | 'single-quote'
  | 'double-quote'
  | 'line-comment'
  | 'block-comment'
  | 'dollar-quote'
  | 'q-quote';

const NAMED_PARAMETER_RE = /^[A-Za-z_][A-Za-z0-9_$#]*/u;

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$#]/u.test(character);
}

function qQuoteDelimiter(sql: string, quoteIndex: number): string | undefined {
  const first = sql[quoteIndex - 1];
  if (first === 'q' || first === 'Q') return isIdentifierCharacter(sql[quoteIndex - 2]) ? undefined : 'q';
  if (first === 'n' || first === 'N') {
    const second = sql[quoteIndex - 2];
    if ((second === 'q' || second === 'Q') && !isIdentifierCharacter(sql[quoteIndex - 3])) return 'nq';
  }
  return undefined;
}

function qQuoteClose(openDelimiter: string | undefined): string {
  switch (openDelimiter) {
    case '[': return "]'";
    case '{': return "}'";
    case '(': return ")'";
    case '<': return ">'";
    default: return `${openDelimiter ?? ''}'`;
  }
}

function escapeStringKind(sql: string, quoteIndex: number): boolean {
  const prefix = sql[quoteIndex - 1];
  if (prefix !== 'e' && prefix !== 'E') return false;
  return !isIdentifierCharacter(sql[quoteIndex - 2]);
}

export function extractSqlParameters(sql: string, dialect: BindDialect): SqlParametersResult {
  const occurrences: SqlParameterOccurrence[] = [];
  let state: ScanState = 'normal';
  let dollarTag = '';
  let qClose = '';
  let escapeString = false;

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
      if (escapeString && character === '\\') {
        index += 1;
        continue;
      }
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
    if (state === 'q-quote') {
      if (sql.startsWith(qClose, index)) {
        index += qClose.length - 1;
        state = 'normal';
      }
      continue;
    }

    if (character === '-' && next === '-') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (character === "'") {
      if (dialect === 'oracle') {
        const qPrefix = qQuoteDelimiter(sql, index);
        if (qPrefix) {
          qClose = qQuoteClose(sql[index + 1]);
          state = 'q-quote';
          index += 2;
          continue;
        }
      }
      escapeString = dialect === 'postgres' && escapeStringKind(sql, index);
      state = 'single-quote';
      continue;
    }
    if (character === '"') {
      state = 'double-quote';
      continue;
    }

    if (character === ':') {
      if (next === '=') {
        index += 1;
        continue;
      }
      if (next === ':') {
        index += 2;
        continue;
      }
      if (next !== undefined && /[A-Za-z_]/u.test(next)) {
        const match = NAMED_PARAMETER_RE.exec(sql.slice(index + 1));
        const rawName = match?.[0] ?? next;
        const name = dialect === 'oracle' ? rawName.toUpperCase() : rawName;
        occurrences.push({ key: name, kind: 'named', name, offset: index, length: rawName.length + 1 });
        index += rawName.length;
        continue;
      }
      if (dialect === 'oracle' && next !== undefined && /\d/u.test(next)) {
        return {
          occurrences,
          error: 'Позиционные bind-параметры Oracle (:1, :2, …) не поддерживаются; используйте именованные :name',
        };
      }
      continue;
    }

    if (dialect === 'postgres' && character === '$') {
      if (next !== undefined && /\d/u.test(next)) {
        const match = /^\d+/u.exec(sql.slice(index + 1));
        const number = match?.[0] ?? next;
        occurrences.push({
          key: `$${number}`, kind: 'positional', name: `$${number}`, offset: index, length: number.length + 1,
        });
        index += number.length;
        continue;
      }
      if (next === '$') {
        dollarTag = '$$';
        state = 'dollar-quote';
        index += 1;
        continue;
      }
      if (next !== undefined && /[A-Za-z_]/u.test(next)) {
        const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$/u.exec(sql.slice(index));
        if (match) {
          dollarTag = match[0];
          state = 'dollar-quote';
          index += match[0].length - 1;
        }
      }
    }
  }

  return { occurrences };
}

export function uniqueSqlParameters(occurrences: SqlParameterOccurrence[]): SqlParameterOccurrence[] {
  const seen = new Set<string>();
  const unique: SqlParameterOccurrence[] = [];
  for (const occurrence of occurrences) {
    if (seen.has(occurrence.key)) continue;
    seen.add(occurrence.key);
    unique.push(occurrence);
  }
  return unique;
}

export type PostgresRewrite = { order: SqlParameterOccurrence[]; sql: string } | { error: string };

export function rewritePostgresSql(sql: string): PostgresRewrite {
  const extraction = extractSqlParameters(sql, 'postgres');
  if (extraction.error) return { error: extraction.error };
  const order = uniqueSqlParameters(extraction.occurrences);
  const position = new Map(order.map((occurrence, index) => [occurrence.key, index + 1]));
  const parts: string[] = [];
  let cursor = 0;
  for (const occurrence of extraction.occurrences) {
    parts.push(sql.slice(cursor, occurrence.offset));
    parts.push(`$${position.get(occurrence.key)}`);
    cursor = occurrence.offset + occurrence.length;
  }
  parts.push(sql.slice(cursor));
  return { sql: parts.join(''), order };
}

export type BindPrimitive = Date | number | string | null;

export type BindParseResult =
  | { ok: true; value: BindPrimitive }
  | { ok: false; message: string };

const NUMBER_VALUE_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

const DATE_VALUE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/u;

function parseNumberValue(value: string): BindParseResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: 'пустое значение: введите число или отметьте NULL' };
  if (!NUMBER_VALUE_RE.test(trimmed)) return { ok: false, message: 'неверный формат числа' };
  const number = Number(trimmed);
  if (!Number.isFinite(number)) return { ok: false, message: 'число вне допустимого диапазона' };
  return { ok: true, value: number };
}

function parseDateValue(value: string): BindParseResult {
  const trimmed = value.trim();
  const match = DATE_VALUE_RE.exec(trimmed);
  if (!match) {
    return { ok: false, message: 'неверный формат даты: ожидается ГГГГ-ММ-ДД[ ЧЧ:ММ[:СС]]' };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = match[4] === undefined ? 0 : Number(match[4]);
  const minutes = match[5] === undefined ? 0 : Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, '0'));
  const date = new Date(year, month - 1, day, hours, minutes, seconds, millis);
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hours || date.getMinutes() !== minutes || date.getSeconds() !== seconds
  ) {
    return { ok: false, message: 'несуществующая дата' };
  }
  return { ok: true, value: date };
}

export function parseBindValue(type: BindValueType, value: string): BindParseResult {
  if (type === 'null') return { ok: true, value: null };
  if (type === 'string') return { ok: true, value };
  if (type === 'number') return parseNumberValue(value);
  return parseDateValue(value);
}
