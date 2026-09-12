import { describe, expect, it } from 'vitest';
import type {
  CatalogColumn,
  CatalogObjectSummary,
  SqlCompletionRequest,
  SqlDialect,
} from '../src/shared/contracts';
import type { CompletionCatalog } from '../src/main/completion-service';
import { CompletionService, MAX_COMPLETION_ITEMS } from '../src/main/completion-service';
import { SessionContextCache } from '../src/main/session-context';

const employeeColumns: CatalogColumn[] = [
  { name: 'EMPLOYEE_ID', dataType: 'NUMBER(10)', nullable: false, position: 1 },
  { name: 'FULL_NAME', dataType: 'VARCHAR2(120)', nullable: false, position: 2 },
];

const oracleObjects: Record<string, CatalogObjectSummary[]> = {
  SQLX: [
    { kind: 'table', schema: 'SQLX', name: 'EMPLOYEES' },
    { kind: 'view', schema: 'SQLX', name: 'EMPLOYEE_DETAILS' },
    { kind: 'package', schema: 'SQLX', name: 'DEMO_PKG' },
    { kind: 'synonym', schema: 'SQLX', name: 'STAFF' },
    { kind: 'sequence', schema: 'SQLX', name: 'EMPLOYEE_ID_SEQ' },
  ],
  PUBLIC: [{ kind: 'synonym', schema: 'PUBLIC', name: 'DUAL' }],
  SYS: [
    { kind: 'view', schema: 'SYS', name: 'USER_TABLES' },
    { kind: 'view', schema: 'SYS', name: 'USER_OBJECTS' },
  ],
};

const postgresObjects: Record<string, CatalogObjectSummary[]> = {
  app: [{ kind: 'table', schema: 'app', name: 'employees' }],
  public: [
    { kind: 'table', schema: 'public', name: 'employees' },
    { kind: 'table', schema: 'public', name: 'departments' },
    { kind: 'table', schema: 'public', name: 'EmployeeData' },
  ],
};

const catalog: CompletionCatalog = {
  resolveSchema: (connectionId, name, caseSensitive) => {
    const names = connectionId === 'ora' ? ['SQLX', 'PUBLIC', 'SYS'] : ['app', 'public'];
    return caseSensitive
      ? names.find((candidate) => candidate === name)
      : names.find((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase());
  },
  objects: (connectionId, schema, options) => Promise.resolve((() => {
    const source = connectionId === 'ora' ? oracleObjects : postgresObjects;
    const prefix = options.prefix ?? '';
    const fold = (value: string) => connectionId === 'ora' ? value.toUpperCase() : value.toLocaleLowerCase();
    const matched = (source[schema] ?? []).filter((object) => !prefix
      || (options.caseSensitive ? object.name.startsWith(prefix) : fold(object.name).startsWith(fold(prefix))));
    const limit = options.limit ?? matched.length;
    return {
      objects: matched.slice(0, limit),
      hasMore: matched.length > limit,
      source: 'cache' as const,
    };
  })()),
  columns: (_connectionId, _schema, object) => Promise.resolve({
    columns: object.toUpperCase() === 'EMPLOYEES' ? employeeColumns : [],
    source: 'cache' as const,
  }),
};

function contexts(): SessionContextCache {
  const cache = new SessionContextCache();
  cache.setSession('ora', 'doc-ora', { userName: 'SQLX', currentSchema: 'SQLX', searchPath: [] });
  cache.setSession('pg', 'doc-pg', {
    userName: 'app',
    currentSchema: 'app',
    searchPath: ['app', 'public'],
  });
  return cache;
}

function request(connectionId: string, dialect: SqlDialect, documentId: string, sqlWithCursor: string): SqlCompletionRequest {
  const offset = sqlWithCursor.indexOf('|');
  if (offset < 0) throw new Error('Cursor marker | is missing');
  return {
    connectionId,
    documentId,
    dialect,
    textWindow: sqlWithCursor.replace('|', ''),
    cursorOffset: offset,
  };
}

describe('CompletionService', () => {
  it('offers current schema objects for an unqualified prefix', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request('ora', 'oracle', 'doc-ora', 'select * from EMP|'));
    expect(result.items.map((item) => item.text)).toContain('EMPLOYEES');
    expect(result.items.map((item) => item.text)).not.toContain('USER_TABLES');
  });

  it('adds PUBLIC synonyms for Oracle without a qualifier', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request('ora', 'oracle', 'doc-ora', 'select * from |'));
    const dual = result.items.find((item) => item.text === 'DUAL');
    expect(dual).toMatchObject({ kind: 'synonym', sortText: '2-dual' });
  });

  it('resolves sys. as a schema qualifier', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request('ora', 'oracle', 'doc-ora', 'select * from SYS.|'));
    expect(result.items.map((item) => item.text)).toEqual(['USER_TABLES', 'USER_OBJECTS']);
  });

  it('resolves alias columns from the FROM clause', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request('ora', 'oracle', 'doc-ora', 'select e.| from employees e'));
    expect(result.items.map((item) => item.text)).toEqual(['EMPLOYEE_ID', 'FULL_NAME']);
    expect(result.items[0].sortText.startsWith('0-')).toBe(true);
  });

  it('resolves CTE columns', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request(
      'ora', 'oracle', 'doc-ora',
      'with recent as (select id, name from employees) select recent.|',
    ));
    expect(result.items.map((item) => item.text)).toEqual(['id', 'name']);
  });

  it('deduplicates PostgreSQL search_path sources', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request('pg', 'postgres', 'doc-pg', 'select * from emp|'));
    expect(result.items.filter((item) => item.text === 'employees')).toHaveLength(1);
  });

  it('respects quoted prefixes for PostgreSQL identifiers', async () => {
    const service = new CompletionService(catalog, contexts());
    const quoted = await service.complete(request('pg', 'postgres', 'doc-pg', 'select * from "Emp|'));
    expect(quoted.items.map((item) => item.text)).toEqual(['EmployeeData']);
    const unquoted = await service.complete(request('pg', 'postgres', 'doc-pg', 'select * from emp|'));
    expect(unquoted.items.map((item) => item.text).sort()).toEqual(['EmployeeData', 'employees']);
  });

  it('falls back to object columns of the current schema', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request('ora', 'oracle', 'doc-ora', 'select employees.|'));
    expect(result.items.map((item) => item.text)).toEqual(['EMPLOYEE_ID', 'FULL_NAME']);
  });

  it('marks truncated responses as incomplete', async () => {
    const many: CatalogObjectSummary[] = Array.from({ length: MAX_COMPLETION_ITEMS + 20 }, (_, index) => ({
      kind: 'table',
      schema: 'SQLX',
      name: `T_${index.toString().padStart(4, '0')}`,
    }));
    const crowded: CompletionCatalog = {
      ...catalog,
      objects: (_connectionId, schema, options) => Promise.resolve({
        objects: schema === 'SQLX' ? many.slice(0, options.limit ?? many.length) : [],
        hasMore: schema === 'SQLX',
        source: 'cache' as const,
      }),
    };
    const service = new CompletionService(crowded, contexts());
    const result = await service.complete(request('ora', 'oracle', 'doc-ora', 'select * from T_|'));
    expect(result.incomplete).toBe(true);
    expect(result.items.some((item) => item.text === '…')).toBe(true);
  });

  it('returns keywords without a connection', async () => {
    const service = new CompletionService(catalog, contexts());
    const result = await service.complete(request('', 'sql', 'doc-none', 'sel|'));
    expect(result.items.map((item) => item.text)).toContain('select');
    expect(result.items.every((item) => item.kind === 'keyword')).toBe(true);
  });

  it('limits the result set on cache overflow', async () => {
    const many: CatalogObjectSummary[] = Array.from({ length: MAX_COMPLETION_ITEMS + 5 }, (_, index) => ({
      kind: 'table', schema: 'SQLX', name: `X_${index.toString().padStart(4, '0')}`,
    }));
    const crowded: CompletionCatalog = {
      ...catalog,
      objects: (_connectionId, schema, options) => Promise.resolve({
        objects: schema === 'SQLX' ? many.slice(0, options.limit ?? many.length) : [],
        hasMore: false,
        source: 'cache' as const,
      }),
    };
    const service = new CompletionService(crowded, contexts());
    const result = await service.complete(request('ora', 'oracle', 'doc-ora', 'select * from X_|'));
    expect(result.items.length).toBeLessThanOrEqual(MAX_COMPLETION_ITEMS);
    expect(result.incomplete).toBe(true);
  });
});
