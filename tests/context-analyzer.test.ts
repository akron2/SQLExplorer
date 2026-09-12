import { describe, expect, it } from 'vitest';
import { analyzeSqlContext } from '../src/main/context-analyzer';

function analyze(sqlWithCursor: string) {
  const offset = sqlWithCursor.indexOf('|');
  if (offset < 0) throw new Error('Cursor marker | is missing');
  return analyzeSqlContext(sqlWithCursor.replace('|', ''), offset);
}

describe('analyzeSqlContext', () => {
  it('extracts an unqualified prefix before an operator', () => {
    const context = analyze('select * from employees where full_n|');
    expect(context.prefix).toBe('full_n');
    expect(context.qualifier).toBeUndefined();
    expect(context.inFromClause).toBe(false);
  });

  it('resolves a table alias declared in FROM', () => {
    const context = analyze('select e.| from employees e');
    expect(context.qualifier).toMatchObject({ name: 'e', quoted: false });
    expect(context.scopes).toEqual([
      expect.objectContaining({ alias: 'e', object: 'employees', source: 'table' }),
    ]);
  });

  it('keeps the schema of a qualified source', () => {
    const context = analyze('select * from sqlx.employees e where e.|');
    expect(context.scopes[0]).toMatchObject({ alias: 'e', object: 'employees', schema: 'sqlx' });
  });

  it('resolves a SELECT list alias back to the source table', () => {
    const context = analyze('select emp.| from departments emp, employees e');
    expect(context.qualifier).toMatchObject({ name: 'emp' });
    expect(context.scopes.map((scope) => scope.object)).toEqual(['departments', 'employees']);
  });

  it('understands quoted identifiers and unclosed quotes', () => {
    const quoted = analyze('select "MyTable".| from "MyTable"');
    expect(quoted.qualifier).toMatchObject({ name: 'MyTable', quoted: true, schema: undefined });
    expect(quoted.scopes[0]).toMatchObject({ alias: 'MyTable', aliasQuoted: true, object: 'MyTable' });
    const unclosed = analyze('select "EMPL|');
    expect(unclosed.prefix).toBe('EMPL');
    expect(unclosed.prefixQuoted).toBe(true);
  });

  it('treats a schema qualifier like sys. as a qualifier', () => {
    const context = analyze('select * from sys.|');
    expect(context.qualifier).toMatchObject({ name: 'sys' });
    expect(context.prefix).toBe('');
  });

  it('resolves schema-qualified column access', () => {
    const context = analyze('select * from sys.user_tab|');
    expect(context.qualifier).toMatchObject({ name: 'sys' });
    expect(context.prefix).toBe('user_tab');
  });

  it('collects CTE names with derived columns', () => {
    const context = analyze('with recent as (select id, name from employees) select recent.| from recent');
    expect(context.cteNames).toEqual(['recent']);
    const cte = context.scopes.find((scope) => scope.alias === 'recent');
    expect(cte).toMatchObject({ source: 'cte', cteColumns: ['id', 'name'] });
  });

  it('collects explicit CTE column lists', () => {
    const context = analyze('with recent(a, b) as (select 1, 2 from dual) select recent.|');
    const cte = context.scopes.find((scope) => scope.alias === 'recent');
    expect(cte?.cteColumns).toEqual(['a', 'b']);
  });

  it('marks incomplete SQL without breaking the prefix', () => {
    const context = analyze('select * from emp where sal > 10 and jo|');
    expect(context.prefix).toBe('jo');
  });

  it('ignores function calls as table aliases', () => {
    const context = analyze('select * from generate_series(1, 10) g where g.|');
    expect(context.scopes).toEqual([
      expect.objectContaining({ alias: 'g', object: '', source: 'table' }),
    ]);
  });

  it('handles semicolons inside strings and comments', () => {
    const context = analyze("select ';' as value -- ;\nfrom employees e where e.|");
    expect(context.qualifier).toMatchObject({ name: 'e' });
  });
});
