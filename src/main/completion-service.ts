import type {
  CatalogAccessContext,
  CatalogColumn,
  CatalogObjectKind,
  SqlCompletionItem,
  SqlCompletionRequest,
  SqlCompletionResult,
} from '../shared/contracts';
import { analyzeSqlContext, type AnalyzedSqlContext, type SqlScopeEntry } from './context-analyzer';
import type { CatalogColumnsResult, CatalogObjectsOptions, CatalogObjectsResult } from './catalog-loader';
import type { SessionContextCache } from './session-context';

export const MAX_COMPLETION_ITEMS = 200;
const MAX_WINDOW_CHARS = 65_536;

export interface CompletionCatalog {
  columns(connectionId: string, schema: string, object: string): Promise<CatalogColumnsResult>;
  objects(connectionId: string, schema: string, options: CatalogObjectsOptions): Promise<CatalogObjectsResult>;
  resolveSchema(connectionId: string, name: string, caseSensitive: boolean): string | undefined;
}

const KEYWORDS = [
  'select', 'from', 'where', 'join', 'left join', 'right join', 'inner join', 'outer join',
  'cross join', 'full join', 'on', 'using', 'group by', 'order by', 'having', 'union', 'union all',
  'intersect', 'minus', 'except', 'distinct', 'insert into', 'update', 'delete from', 'merge into',
  'values', 'set', 'returning', 'with', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'between',
  'like', 'exists', 'case', 'when', 'then', 'else', 'end', 'commit', 'rollback', 'begin', 'declare',
  'for update', 'fetch first', 'offset', 'limit', 'asc', 'desc', 'count', 'sum', 'min', 'max', 'avg',
];

class ItemCollector {
  readonly #items: SqlCompletionItem[] = [];
  readonly #seen = new Set<string>();
  #overflow = false;

  constructor(private readonly limit: number) {}

  add(item: SqlCompletionItem): void {
    const key = `${item.kind}\u0000${item.text.toLocaleLowerCase()}`;
    if (this.#seen.has(key)) return;
    if (this.#items.length >= this.limit) {
      this.#overflow = true;
      return;
    }
    this.#seen.add(key);
    this.#items.push(item);
  }

  get overflow(): boolean {
    return this.#overflow || this.#items.length >= this.limit;
  }

  get size(): number {
    return this.#items.length;
  }

  items(): SqlCompletionItem[] {
    return this.#items;
  }
}

function normalize(value: string, dialect: 'oracle' | 'postgres', quoted: boolean): string {
  if (quoted) return value;
  return dialect === 'oracle' ? value.toUpperCase() : value.toLowerCase();
}

function matchesPrefix(name: string, prefix: string, dialect: 'oracle' | 'postgres', quoted: boolean): boolean {
  if (!prefix) return true;
  if (quoted) return name.startsWith(prefix);
  return normalize(name, dialect, false).startsWith(normalize(prefix, dialect, false));
}

function objectKind(kind: CatalogObjectKind): SqlCompletionItem['kind'] {
  return kind;
}

function findScope(analyzed: AnalyzedSqlContext, dialect: 'oracle' | 'postgres'): SqlScopeEntry | undefined {
  const qualifier = analyzed.qualifier;
  if (!qualifier) return undefined;
  const target = normalize(qualifier.name, dialect, qualifier.quoted);
  for (let index = analyzed.scopes.length - 1; index >= 0; index -= 1) {
    const scope = analyzed.scopes[index];
    if (normalize(scope.alias, dialect, scope.aliasQuoted) === target) return scope;
  }
  return undefined;
}

function replaceRange(analyzed: AnalyzedSqlContext): Pick<SqlCompletionItem, 'replaceEnd' | 'replaceStart'> {
  return { replaceStart: analyzed.replaceStart, replaceEnd: analyzed.replaceEnd };
}

export class CompletionService {
  constructor(
    private readonly catalog: CompletionCatalog,
    private readonly contexts: SessionContextCache,
  ) {}

  async complete(request: SqlCompletionRequest, fallback?: CatalogAccessContext): Promise<SqlCompletionResult> {
    const truncated = request.textWindow.length > MAX_WINDOW_CHARS;
    const text = truncated ? request.textWindow.slice(-MAX_WINDOW_CHARS) : request.textWindow;
    const offset = truncated ? request.cursorOffset - (request.textWindow.length - MAX_WINDOW_CHARS) : request.cursorOffset;
    const analyzed = analyzeSqlContext(text, offset);
    const collector = new ItemCollector(MAX_COMPLETION_ITEMS);
    const dialect = request.dialect === 'oracle' || request.dialect === 'postgres' ? request.dialect : undefined;
    const context = (request.connectionId
      ? this.contexts.get(request.connectionId, request.documentId)
      : undefined)
      ?? (fallback && fallback.connectionId === request.connectionId ? fallback : undefined);
    let databaseSource = false;
    let incomplete = false;

    if (request.connectionId && dialect && context) {
      if (analyzed.qualifier) {
        const outcome = await this.#completeQualified(
          collector, request.connectionId, analyzed, dialect,
          context.currentSchema, context.userName,
        );
        databaseSource = outcome.database;
        incomplete = outcome.incomplete;
      } else if (analyzed.prefix.length > 0 || analyzed.inFromClause) {
        const schemas = dialect === 'postgres' && context.searchPath.length
          ? context.searchPath.map((entry) => entry === '$user' ? context.userName : entry).filter(Boolean)
          : [context.currentSchema];
        const seen = new Set<string>();
        const primary = await this.#addSchemaObjects(
          collector, request.connectionId, schemas, analyzed, dialect, '1-', seen,
        );
        databaseSource = primary.database || databaseSource;
        incomplete = primary.hasMore || incomplete;
        if (dialect === 'oracle') {
          const publicSynonyms = await this.#addSchemaObjects(
            collector, request.connectionId, ['PUBLIC'], analyzed, dialect, '2-', seen,
          );
          databaseSource = publicSynonyms.database || databaseSource;
          incomplete = publicSynonyms.hasMore || incomplete;
        }
      }
    }

    if (!analyzed.qualifier && collector.size < MAX_COMPLETION_ITEMS) {
      for (const keyword of KEYWORDS) {
        if (!matchesPrefix(keyword, analyzed.prefix, 'oracle', analyzed.prefixQuoted)) continue;
        collector.add({
          ...replaceRange(analyzed),
          text: keyword,
          kind: 'keyword',
          sortText: `9-${keyword}`,
        });
      }
    }

    const items = collector.items();
    return {
      items,
      incomplete: incomplete || collector.overflow,
      source: databaseSource ? 'database' : items.length ? 'cache' : 'none',
    };
  }

  async #completeQualified(
    collector: ItemCollector,
    connectionId: string,
    analyzed: AnalyzedSqlContext,
    dialect: 'oracle' | 'postgres',
    currentSchema: string,
    userName: string,
  ): Promise<{ database: boolean; incomplete: boolean }> {
    const qualifier = analyzed.qualifier;
    if (!qualifier) return { database: false, incomplete: false };
    const scope = findScope(analyzed, dialect);
    if (scope) {
      if (scope.source === 'cte') {
        this.#addColumns(collector, analyzed, dialect, scope.object, (scope.cteColumns ?? [])
          .map((name, index) => ({ name, dataType: 'CTE-колонка', nullable: true, position: index + 1 })));
        return { database: false, incomplete: false };
      }
      const schema = this.#resolveSchema(connectionId, scope.schema ?? currentSchema, scope.schemaQuoted, dialect);
      const result = await this.catalog.columns(connectionId, schema, scope.object);
      if (!result.columns.length) return { database: result.source === 'database', incomplete: true };
      this.#addColumns(collector, analyzed, dialect, scope.object, result.columns);
      return { database: result.source === 'database', incomplete: false };
    }
    if (qualifier.schema) {
      const schema = this.#resolveSchema(connectionId, qualifier.schema, qualifier.schemaQuoted, dialect);
      const result = await this.catalog.columns(connectionId, schema, qualifier.name);
      if (!result.columns.length) return { database: result.source === 'database', incomplete: true };
      this.#addColumns(collector, analyzed, dialect, qualifier.name, result.columns);
      return { database: result.source === 'database', incomplete: false };
    }

    const resolved = this.catalog.resolveSchema(connectionId, qualifier.name, qualifier.quoted);
    const normalized = normalize(qualifier.name, dialect, qualifier.quoted).toLocaleLowerCase();
    const isCurrent = normalized === currentSchema.toLocaleLowerCase()
      || normalized === userName.toLocaleLowerCase();
    if (resolved || isCurrent) {
      const schemas = resolved ? [resolved] : [currentSchema];
      const page = await this.#addSchemaObjects(
        collector, connectionId, schemas, analyzed, dialect, '1-',
      );
      return { database: page.database, incomplete: page.hasMore };
    }

    const candidates: Array<[string, string]> = [[currentSchema, qualifier.name]];
    if (dialect === 'oracle') candidates.push(['PUBLIC', qualifier.name]);
    for (const [schema, object] of candidates) {
      const result = await this.catalog.columns(connectionId, schema, object);
      if (result.columns.length) {
        this.#addColumns(collector, analyzed, dialect, object, result.columns);
        return { database: result.source === 'database', incomplete: false };
      }
    }
    return { database: false, incomplete: true };
  }

  async #addSchemaObjects(
    collector: ItemCollector,
    connectionId: string,
    schemas: string[],
    analyzed: AnalyzedSqlContext,
    dialect: 'oracle' | 'postgres',
    sortPrefix = '1-',
    seenNames = new Set<string>(),
  ): Promise<{ database: boolean; hasMore: boolean }> {
    let databaseSource = false;
    let hasMore = false;
    for (const schemaName of schemas) {
      if (!schemaName || collector.size >= MAX_COMPLETION_ITEMS) break;
      const canonical = this.catalog.resolveSchema(connectionId, schemaName, false) ?? schemaName;
      const result = await this.catalog.objects(connectionId, canonical, {
        prefix: analyzed.prefix,
        caseSensitive: analyzed.prefixQuoted,
        limit: MAX_COMPLETION_ITEMS,
      });
      if (result.source === 'database') databaseSource = true;
      if (result.hasMore) {
        hasMore = true;
        collector.add(this.#overflowMarker(analyzed, sortPrefix));
      }
      for (const object of result.objects) {
        const key = object.name.toLocaleLowerCase();
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        collector.add({
          ...replaceRange(analyzed),
          text: object.name,
          kind: objectKind(object.kind),
          detail: `${object.kind} · ${object.schema}`,
          sortText: `${sortPrefix}${object.name.toLocaleLowerCase()}`,
        });
      }
    }
    return { database: databaseSource, hasMore };
  }

  #addColumns(
    collector: ItemCollector,
    analyzed: AnalyzedSqlContext,
    dialect: 'oracle' | 'postgres',
    objectName: string,
    columns: CatalogColumn[],
  ): void {
    for (const column of columns) {
      if (!matchesPrefix(column.name, analyzed.prefix, dialect, analyzed.prefixQuoted)) continue;
      collector.add({
        ...replaceRange(analyzed),
        text: column.name,
        kind: 'column',
        detail: `${column.dataType} · ${objectName}`,
        sortText: `0-${column.position.toString().padStart(5, '0')}-${column.name}`,
      });
    }
  }

  #overflowMarker(analyzed: AnalyzedSqlContext, sortPrefix: string): SqlCompletionItem {
    return {
      ...replaceRange(analyzed),
      text: '…',
      kind: 'keyword',
      detail: 'Показаны не все совпадения, уточните ввод',
      sortText: `${sortPrefix}9-~`,
    };
  }

  #resolveSchema(
    connectionId: string,
    name: string,
    quoted: boolean,
    dialect: 'oracle' | 'postgres',
  ): string {
    return this.catalog.resolveSchema(connectionId, name, quoted)
      ?? normalize(name, dialect, quoted);
  }
}
