import { describe, expect, it } from 'vitest';
import {
  extractSqlParameters,
  parseBindValue,
  rewritePostgresSql,
  uniqueSqlParameters,
} from '../src/shared/sql-binds';

describe('extractSqlParameters · Oracle', () => {
  it('finds named parameters and keeps first-occurrence order', () => {
    const result = extractSqlParameters('select * from t where a = :x and b = :y', 'oracle');
    expect(result.error).toBeUndefined();
    expect(result.occurrences.map((item) => item.name)).toEqual(['X', 'Y']);
  });

  it('normalizes names to upper case and merges :X with :x', () => {
    const result = extractSqlParameters('select :X, :x, :A from dual', 'oracle');
    const unique = uniqueSqlParameters(result.occurrences);
    expect(unique.map((item) => item.key)).toEqual(['X', 'A']);
  });

  it('skips strings, q-strings, quoted identifiers and comments', () => {
    const sql = `select ':a' as one, q'[it's :b]' as two, ":c" as three, :d -- :e
      /* :f */ from dual`;
    const result = extractSqlParameters(sql, 'oracle');
    expect(result.occurrences.map((item) => item.name)).toEqual(['D']);
  });

  it('skips the assignment operator but keeps the right-hand bind', () => {
    const sql = 'declare n number := :v; begin n := :v + 1; end;';
    const result = extractSqlParameters(sql, 'oracle');
    expect(result.occurrences.map((item) => item.name)).toEqual(['V', 'V']);
  });

  it('rejects Oracle positional binds with a clear error', () => {
    const result = extractSqlParameters('select * from t where a = :1', 'oracle');
    expect(result.error).toMatch(/позиционные/i);
  });

  it('allows $ and # inside bind names', () => {
    const result = extractSqlParameters('select :emp$no#, :emp_no from dual', 'oracle');
    expect(uniqueSqlParameters(result.occurrences).map((item) => item.key)).toEqual(['EMP$NO#', 'EMP_NO']);
  });
});

describe('extractSqlParameters · PostgreSQL', () => {
  it('finds named and native parameters', () => {
    const result = extractSqlParameters('select :a, $2, :a from t where x = $1', 'postgres');
    expect(result.occurrences.map((item) => item.name)).toEqual(['a', '$2', 'a', '$1']);
  });

  it('skips :: casts and dollar quoted bodies with assignments', () => {
    const result = extractSqlParameters(
      "do $$ declare x int; begin x := 1; raise notice '%', :v; end $$; select '1'::int as one, :b",
      'postgres',
    );
    expect(result.occurrences.map((item) => item.name)).toEqual(['b']);
  });

  it('skips dollar quoted bodies entirely', () => {
    const result = extractSqlParameters('select $tag$ :x $1 ::int $tag$ as body, :y', 'postgres');
    expect(result.occurrences.map((item) => item.name)).toEqual(['y']);
  });

  it('keeps named parameters case sensitive', () => {
    const result = extractSqlParameters('select :a, :A from t', 'postgres');
    expect(uniqueSqlParameters(result.occurrences).map((item) => item.key)).toEqual(['a', 'A']);
  });

  it('skips escaped quotes in E-strings', () => {
    const result = extractSqlParameters("select E'it\\'s :a' as one, :b", 'postgres');
    expect(result.occurrences.map((item) => item.name)).toEqual(['b']);
  });
});

describe('rewritePostgresSql', () => {
  it('numbers parameters by first occurrence and reuses positions', () => {
    const rewrite = rewritePostgresSql('where a = :x and b = $1 and c = :x');
    if ('error' in rewrite) throw new Error(rewrite.error);
    expect(rewrite.sql).toBe('where a = $1 and b = $2 and c = $1');
    expect(rewrite.order.map((item) => item.key)).toEqual(['x', '$1']);
  });

  it('keeps SQL with no parameters unchanged', () => {
    const rewrite = rewritePostgresSql('select 1');
    if ('error' in rewrite) throw new Error(rewrite.error);
    expect(rewrite.sql).toBe('select 1');
    expect(rewrite.order).toEqual([]);
  });

  it('does not rewrite inside strings, comments and dollar quotes', () => {
    const rewrite = rewritePostgresSql("select 'a :x $1' as one, /* :y */ $2, $$:z$$ as body, :q");
    if ('error' in rewrite) throw new Error(rewrite.error);
    expect(rewrite.sql).toBe("select 'a :x $1' as one, /* :y */ $1, $$:z$$ as body, $2");
  });
});

describe('parseBindValue', () => {
  it('parses strings verbatim including empty ones', () => {
    expect(parseBindValue('string', '')).toEqual({ ok: true, value: '' });
    expect(parseBindValue('string', '  x ')).toEqual({ ok: true, value: '  x ' });
  });

  it('parses strict numbers', () => {
    expect(parseBindValue('number', '42')).toEqual({ ok: true, value: 42 });
    expect(parseBindValue('number', '-1.5e3')).toEqual({ ok: true, value: -1500 });
    expect(parseBindValue('number', '.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseBindValue('number', '0x10').ok).toBe(false);
    expect(parseBindValue('number', '').ok).toBe(false);
    expect(parseBindValue('number', '1e999').ok).toBe(false);
  });

  it('parses ISO dates', () => {
    const parsed = parseBindValue('date', '2026-09-17');
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value instanceof Date) {
      expect(parsed.value.getFullYear()).toBe(2026);
      expect(parsed.value.getMonth()).toBe(8);
      expect(parsed.value.getDate()).toBe(17);
    }
    const full = parseBindValue('date', '2026-09-17 14:05:06.5');
    expect(full.ok).toBe(true);
    if (full.ok && full.value instanceof Date) expect(full.value.getMinutes()).toBe(5);
  });

  it('rejects invalid dates', () => {
    expect(parseBindValue('date', '2026-13-01').ok).toBe(false);
    expect(parseBindValue('date', '2026-02-30').ok).toBe(false);
    expect(parseBindValue('date', '17.09.2026').ok).toBe(false);
    expect(parseBindValue('date', '').ok).toBe(false);
  });

  it('maps null type to null value', () => {
    expect(parseBindValue('null', 'ignored')).toEqual({ ok: true, value: null });
  });
});
