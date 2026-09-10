import { describe, expect, it } from 'vitest';
import { statementAtOffset, statementRangeAtOffset } from '../src/renderer/editor/sql-selection';

describe('statementAtOffset', () => {
  it('selects the statement containing the cursor', () => {
    const sql = 'select 1;\nselect 2;\nselect 3';
    expect(statementAtOffset(sql, sql.indexOf('2'))).toBe('select 2;');
  });

  it('does not split at semicolons inside strings and comments', () => {
    const sql = "select ';' as value /* ; */ from dual;\nselect 2 from dual;";
    expect(statementAtOffset(sql, sql.indexOf('value'))).toBe("select ';' as value /* ; */ from dual;");
    expect(statementAtOffset(sql, sql.lastIndexOf('2'))).toBe('select 2 from dual;');
  });

  it('understands PostgreSQL dollar quoted bodies', () => {
    const sql = 'select $$one;two$$ as value;\nselect 2;';
    expect(statementAtOffset(sql, sql.indexOf('two'))).toBe('select $$one;two$$ as value;');
  });

  it('keeps an Oracle procedural block intact', () => {
    const sql = `declare
  value number := 1;
begin
  value := value + 1;
end;
/`;
    expect(statementRangeAtOffset(sql, sql.indexOf('value +'))).toEqual([0, sql.length]);
  });
});
