import { useEffect, useRef, useState } from 'react';
import {
  Boxes, Braces, Clock3, Database, Eye, FunctionSquare, KeyRound, Package, Pencil, Plus,
  RefreshCw, Search, Settings2, Table2,
} from 'lucide-react';
import type {
  CatalogListRequest,
  CatalogListResult,
  CatalogObjectKind,
  CatalogObjectSummary,
  CatalogSchemaSummary,
  PublicConnectionProfile,
  SessionState,
} from '../../shared/contracts';

interface ExplorerProps {
  catalogList(request: CatalogListRequest): Promise<CatalogListResult>;
  connections: PublicConnectionProfile[];
  nativeMenus: boolean;
  onAddConnection(): void;
  onConnectionAction(connectionId: string, action: 'newDocument' | 'test' | 'edit' | 'reconnect' | 'disconnect' | 'delete'): void;
  onConnectionMenu(connectionId: string): void;
  onEditConnection(connectionId: string): void;
  onOpenSettings(): void;
  onRefresh(schema?: string): void;
  onSelectConnection(connectionId: string): void;
  refreshing: boolean;
  selectedConnectionId: string | null;
  sessionStates: SessionState[];
}

const kindMeta: Record<CatalogObjectKind, { icon: typeof Table2; label: string }> = {
  table: { icon: Table2, label: 'таблица' },
  view: { icon: Eye, label: 'представление' },
  matview: { icon: Eye, label: 'мат. представление' },
  package: { icon: Package, label: 'пакет' },
  function: { icon: FunctionSquare, label: 'функция' },
  procedure: { icon: FunctionSquare, label: 'процедура' },
  synonym: { icon: Boxes, label: 'синоним' },
  sequence: { icon: Braces, label: 'последовательность' },
  type: { icon: Braces, label: 'тип' },
};

function aggregateStatus(connectionId: string, states: SessionState[]) {
  const relevant = states.filter((state) => state.connectionId === connectionId && state.status !== 'disconnected');
  const lost = relevant.filter((state) => state.status === 'lost' || state.status === 'error').length;
  const connected = relevant.filter((state) => state.status === 'connected').length;
  const outdated = relevant.filter((state) => state.status === 'outdated').length;
  if (lost) return { className: 'lost', label: `Потеряно сессий: ${lost}` };
  if (outdated) return { className: 'outdated', label: `Нужно переподключить: ${outdated}` };
  if (connected) return { className: 'connected', label: `Подключено · ${connected} вклад.` };
  if (relevant.some((state) => state.status === 'connecting')) return { className: 'connecting', label: 'Подключение…' };
  return { className: 'disconnected', label: 'Не подключено' };
}

export function Explorer({
  catalogList,
  connections,
  nativeMenus,
  onAddConnection,
  onConnectionMenu,
  onConnectionAction,
  onEditConnection,
  onOpenSettings,
  onRefresh,
  onSelectConnection,
  refreshing,
  selectedConnectionId,
  sessionStates,
}: ExplorerProps) {
  const [schemaData, setSchemaData] = useState<{ key: string; schemas: CatalogSchemaSummary[] }>({
    key: '',
    schemas: [],
  });
  const [selectedSchema, setSelectedSchema] = useState<string>();
  const [search, setSearch] = useState('');
  const [objectData, setObjectData] = useState<{
    hasMore: boolean;
    key: string;
    objects: CatalogObjectSummary[];
  }>({ hasMore: false, key: '', objects: [] });
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [fallbackConnectionMenu, setFallbackConnectionMenu] = useState<string>();
  const loadToken = useRef(0);

  useEffect(() => {
    if (!selectedConnectionId || refreshing) return;
    let active = true;
    void catalogList({ connectionId: selectedConnectionId, kind: 'schemas', limit: 500 })
      .then((result) => {
        if (!active) return;
        const next = result.schemas ?? [];
        setSchemaData({ key: selectedConnectionId, schemas: next });
        setCatalogError(undefined);
        setSelectedSchema((current) => {
          if (current && next.some((schema) => schema.name === current)) return current;
          return next.find((schema) => schema.isDefault)?.name ?? next[0]?.name;
        });
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [catalogList, refreshing, selectedConnectionId]);

  const activeSchemas = selectedConnectionId && schemaData.key === selectedConnectionId
    ? schemaData.schemas
    : [];
  const objectKey = selectedConnectionId && selectedSchema
    ? `${selectedConnectionId}\u0000${selectedSchema}\u0000${search.trim()}`
    : '';
  const activeObjects = objectData.key === objectKey ? objectData.objects : [];
  const activeHasMore = objectData.key === objectKey && objectData.hasMore;
  const objectsLoading = loading && objectData.key !== objectKey;

  useEffect(() => {
    if (!objectKey || !selectedConnectionId || !selectedSchema || refreshing) return;
    const token = ++loadToken.current;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      void catalogList({
        connectionId: selectedConnectionId,
        kind: 'objects',
        schema: selectedSchema,
        search: search.trim() || undefined,
        limit: 200,
      }).then((result) => {
        if (token !== loadToken.current) return;
        setObjectData({ key: objectKey, objects: result.objects ?? [], hasMore: result.hasMore });
        setCatalogError(undefined);
      }).catch((error: unknown) => {
        if (token === loadToken.current) setCatalogError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (token === loadToken.current) setLoading(false);
      });
    }, search ? 250 : 0);
    return () => window.clearTimeout(timeout);
  }, [catalogList, objectKey, refreshing, search, selectedConnectionId, selectedSchema]);

  const loadMore = () => {
    if (!selectedConnectionId || !selectedSchema || loading || !objectKey) return;
    const token = loadToken.current;
    setLoading(true);
    void catalogList({
      connectionId: selectedConnectionId,
      kind: 'objects',
      schema: selectedSchema,
      search: search.trim() || undefined,
      limit: 200,
      offset: activeObjects.length,
    }).then((result) => {
      if (token !== loadToken.current) return;
      setObjectData((current) => ({
        key: objectKey,
        objects: [...(current.key === objectKey ? current.objects : []), ...(result.objects ?? [])],
        hasMore: result.hasMore,
      }));
      setCatalogError(undefined);
    }).catch((error: unknown) => {
      if (token === loadToken.current) setCatalogError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (token === loadToken.current) setLoading(false);
    });
  };

  return (
    <aside className="explorer" aria-label="Проводник соединений и объектов">
      <div className="explorer-heading"><strong>Проводник</strong><div className="explorer-heading-actions"><button className="icon-button compact" type="button" title="Добавить соединение" aria-label="Добавить соединение" onClick={onAddConnection}><Plus size={16} /></button><button className="icon-button compact" type="button" title="Настройки Oracle" aria-label="Настройки Oracle" onClick={onOpenSettings}><Settings2 size={15} /></button></div></div>
      <div className="connection-list">
        {connections.map((connection) => {
          const runtime = aggregateStatus(connection.id, sessionStates);
          return <div className={`connection-card ${connection.id === selectedConnectionId ? 'is-selected' : ''}`} key={connection.id} onContextMenu={(event) => { event.preventDefault(); if (nativeMenus) onConnectionMenu(connection.id); else setFallbackConnectionMenu(connection.id); }}>
            <button className="connection-main" type="button" onClick={() => onSelectConnection(connection.id)}>
              <span className={`dialect-badge ${connection.kind}`} style={{ '--connection-color': connection.color } as React.CSSProperties}>{connection.kind === 'oracle' ? 'O' : 'P'}</span>
              <span className="connection-copy"><strong>{connection.name}{connection.privilege === 'sysdba' && <b className="sysdba-mini">SYSDBA</b>}</strong><small>{connection.username || 'учётная запись'} · {connection.database || 'адрес не задан'}</small><em className={`connection-runtime ${runtime.className}`}><i />{runtime.label}{connection.driverMode ? ` · ${connection.driverMode}` : ''}</em></span>
              {connection.credentialState === 'missing' && <KeyRound className="credential-warning" size={14} aria-label="Нужен пароль" />}
            </button>
            <button className="connection-edit" type="button" onClick={() => onEditConnection(connection.id)} title="Изменить соединение" aria-label={`Изменить ${connection.name}`}><Pencil size={13} /></button>
            {fallbackConnectionMenu === connection.id && <div className="connection-context-menu" role="menu">
              {([
                ['newDocument', 'Новая SQL-вкладка'],
                ['test', 'Проверить соединение'],
                ['edit', 'Изменить…'],
                ['reconnect', 'Переподключить сессии'],
                ['disconnect', 'Отключить сессии'],
                ['delete', 'Удалить'],
              ] as const).map(([action, label]) => <button role="menuitem" type="button" key={action} onClick={() => { setFallbackConnectionMenu(undefined); onConnectionAction(connection.id, action); }}>{label}</button>)}
            </div>}
          </div>;
        })}
        {connections.length === 0 && <button className="empty-connections" type="button" onClick={onAddConnection}><Database size={20} /><strong>Нет соединений</strong><span>Добавить Oracle или PostgreSQL</span></button>}
      </div>
      <div className="catalog-section">
        <div className="schema-line"><span className="schema-name"><Database size={14} /> Схемы</span><span>{activeSchemas.length}</span><button className="icon-button compact" type="button" onClick={() => onRefresh()} disabled={refreshing || !selectedConnectionId} title="Обновить каталог"><RefreshCw className={refreshing ? 'spin' : ''} size={14} /></button></div>
        <div className="schema-list">
          {activeSchemas.map((schema) => <div key={schema.name} className={`schema-row ${schema.name === selectedSchema ? 'is-selected' : ''}`}>
            <button className="schema-row-main" type="button" onClick={() => setSelectedSchema(schema.name)} title={schema.name}>
              <span className="schema-row-name">{schema.name}{schema.isDefault && <b className="default-schema">по умолчанию</b>}</span>
              <small>{schema.loaded ? `${schema.objectCount} объектов` : 'загрузка по запросу'}{schema.stale ? ' · устарело' : ''}</small>
            </button>
            <button className="icon-button compact" type="button" onClick={() => onRefresh(schema.name)} disabled={refreshing} title={`Обновить схему ${schema.name}`} aria-label={`Обновить схему ${schema.name}`}><RefreshCw size={12} /></button>
          </div>)}
          {selectedConnectionId && activeSchemas.length === 0 && !catalogError && <div className="empty-tree">Схемы не найдены</div>}
        </div>
        <label className="object-filter"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти объект…" aria-label="Найти объект" disabled={!selectedSchema} /></label>
        <div className="object-list">
          {activeObjects.map((object) => {
            const meta = kindMeta[object.kind];
            const Icon = meta.icon;
            return <div className="object-row-mini" key={`${object.schema}.${object.kind}.${object.name}`} title={`${meta.label} ${object.schema}.${object.name}`}>
              <Icon size={13} />
              <span>{object.name}</span>
              <small>{object.kind}</small>
            </div>;
          })}
          {activeHasMore && <button className="load-more" type="button" onClick={loadMore} disabled={objectsLoading}>{objectsLoading ? 'Загрузка…' : 'Показать ещё'}</button>}
          {selectedSchema && activeObjects.length === 0 && !objectsLoading && <div className="empty-tree">{search.trim() ? 'Объекты не найдены' : 'В схеме нет объектов'}</div>}
          {!selectedSchema && <div className="empty-tree">Выберите схему</div>}
        </div>
        {catalogError && <div className="catalog-error">{catalogError}</div>}
      </div>
      <button className="history-button" type="button"><Clock3 size={15} /> История запросов</button>
    </aside>
  );
}
