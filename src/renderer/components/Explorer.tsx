import { useMemo, useState } from 'react';
import {
  Boxes, Braces, ChevronDown, ChevronRight, Clock3, Database, Eye, FunctionSquare,
  KeyRound, Package, Pencil, Plus, RefreshCw, Search, Settings2, Table2,
} from 'lucide-react';
import type {
  MetadataObject,
  MetadataSnapshot,
  PublicConnectionProfile,
  SessionState,
} from '../../shared/contracts';

interface ExplorerProps {
  connections: PublicConnectionProfile[];
  metadata?: MetadataSnapshot;
  nativeMenus: boolean;
  onAddConnection(): void;
  onConnectionMenu(connectionId: string): void;
  onConnectionAction(connectionId: string, action: 'newDocument' | 'test' | 'edit' | 'reconnect' | 'disconnect' | 'delete'): void;
  onEditConnection(connectionId: string): void;
  onOpenSettings(): void;
  onRefresh(): void;
  onSelectConnection(connectionId: string): void;
  refreshing: boolean;
  selectedConnectionId: string | null;
  sessionStates: SessionState[];
}

const groupDefinitions: Array<{
  icon: typeof Table2;
  kind: MetadataObject['kind'];
  label: string;
}> = [
  { kind: 'table', label: 'Таблицы', icon: Table2 },
  { kind: 'view', label: 'Представления', icon: Eye },
  { kind: 'package', label: 'Пакеты', icon: Package },
  { kind: 'function', label: 'Функции', icon: FunctionSquare },
  { kind: 'synonym', label: 'Синонимы', icon: Boxes },
  { kind: 'sequence', label: 'Последовательности', icon: Braces },
];

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
  connections,
  metadata,
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
  const [filter, setFilter] = useState('');
  const [expandedGroups, setExpandedGroups] = useState(() => new Set(['table']));
  const [expandedObjects, setExpandedObjects] = useState(() => new Set<string>());
  const [fallbackConnectionMenu, setFallbackConnectionMenu] = useState<string>();
  const groups = useMemo(() => {
    const value = filter.trim().toLocaleLowerCase();
    return groupDefinitions.map((definition) => ({
      ...definition,
      objects: (metadata?.objects ?? []).filter((object) =>
        object.kind === definition.kind && (!value || object.name.toLocaleLowerCase().includes(value)
          || object.columns?.some((column) => column.name.toLocaleLowerCase().includes(value)))),
    })).filter((group) => group.objects.length > 0);
  }, [filter, metadata]);

  const toggleGroup = (kind: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  });
  const toggleObject = (name: string) => setExpandedObjects((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });

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
      <label className="object-filter"><Search size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Найти объект…" aria-label="Найти объект" disabled={!selectedConnectionId} /></label>
      <div className="schema-line"><span className="schema-name"><Database size={14} /> {metadata?.schema ?? 'Нет метаданных'}</span><span>{metadata?.objects.length ?? 0} объектов{metadata?.stale ? ' · кэш' : ''}</span><button className="icon-button compact" type="button" onClick={onRefresh} disabled={refreshing || !selectedConnectionId} title="Получить метаданные из БД"><RefreshCw className={refreshing ? 'spin' : ''} size={14} /></button></div>
      <div className="object-tree">
        {groups.map((group) => {
          const expanded = expandedGroups.has(group.kind);
          const Icon = group.icon;
          return <div className="object-group" key={group.kind}><button className="tree-row group-row" type="button" onClick={() => toggleGroup(group.kind)}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Icon size={14} /><strong>{group.label}</strong><span>{group.objects.length}</span></button>{expanded && group.objects.map((object) => {
            const objectExpanded = expandedObjects.has(`${object.schema}.${object.name}`);
            return <div key={`${object.schema}.${object.name}`}><button className={`tree-row object-row ${objectExpanded ? 'is-selected' : ''}`} type="button" onClick={() => toggleObject(`${object.schema}.${object.name}`)}>{object.columns?.length ? objectExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="tree-spacer" />}<Icon size={14} /><span>{object.name}</span></button>{objectExpanded && object.columns?.map((column) => <div className="tree-row column-row" key={column.name}><span className="column-name">{column.name}</span><span className="column-type">{column.dataType}</span></div>)}</div>;
          })}</div>;
        })}
        {selectedConnectionId && groups.length === 0 && <div className="empty-tree">{metadata ? 'Объекты не найдены' : 'Подключитесь и обновите метаданные'}</div>}
      </div>
      <button className="history-button" type="button"><Clock3 size={15} /> История запросов</button>
    </aside>
  );
}
