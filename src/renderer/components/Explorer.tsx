import { useMemo, useState } from 'react';
import {
  Boxes,
  Braces,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  Eye,
  FunctionSquare,
  Package,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Table2,
} from 'lucide-react';
import type {
  MetadataObject,
  MetadataSnapshot,
  PublicConnectionProfile,
} from '../../shared/contracts';

interface ExplorerProps {
  connections: PublicConnectionProfile[];
  metadata?: MetadataSnapshot;
  onRefresh(): void;
  onSelectConnection(connectionId: string): void;
  refreshing: boolean;
  selectedConnectionId: string;
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

export function Explorer({
  connections,
  metadata,
  onRefresh,
  onSelectConnection,
  refreshing,
  selectedConnectionId,
}: ExplorerProps) {
  const [filter, setFilter] = useState('');
  const [expandedGroups, setExpandedGroups] = useState(() => new Set(['table']));
  const [expandedObjects, setExpandedObjects] = useState(() => new Set<string>(['EMPLOYEES']));

  const groups = useMemo(() => {
    const value = filter.trim().toLocaleLowerCase();
    return groupDefinitions
      .map((definition) => ({
        ...definition,
        objects: (metadata?.objects ?? []).filter(
          (object) =>
            object.kind === definition.kind &&
            (!value ||
              object.name.toLocaleLowerCase().includes(value) ||
              object.columns?.some((column) =>
                column.name.toLocaleLowerCase().includes(value),
              )),
        ),
      }))
      .filter((group) => group.objects.length > 0);
  }, [filter, metadata]);

  const toggleGroup = (kind: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleObject = (name: string) => {
    setExpandedObjects((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <aside className="explorer" aria-label="Проводник соединений и объектов">
      <div className="explorer-heading">
        <strong>Проводник</strong>
        <button className="icon-button compact" type="button" title="Настройки проводника">
          <SlidersHorizontal size={15} />
        </button>
      </div>
      <div className="connection-list">
        {connections.map((connection) => (
          <button
            className={`connection-card ${connection.id === selectedConnectionId ? 'is-selected' : ''}`}
            key={connection.id}
            type="button"
            onClick={() => onSelectConnection(connection.id)}
          >
            <span
              className={`dialect-badge ${connection.kind}`}
              style={{ '--connection-color': connection.color } as React.CSSProperties}
            >
              {connection.kind === 'oracle' ? 'O' : 'P'}
            </span>
            <span className="connection-copy">
              <strong>{connection.name}</strong>
              <small>{connection.username || 'учётная запись'} · {connection.database}</small>
            </span>
            <span
              className={`connection-state ${connection.status}`}
              title={connection.status === 'configured' ? 'Настроено' : 'Нужны реквизиты'}
            />
          </button>
        ))}
      </div>
      <label className="object-filter">
        <Search size={15} />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Найти объект…"
          aria-label="Найти объект"
        />
      </label>
      <div className="schema-line">
        <span className="schema-name"><Database size={14} /> {metadata?.schema ?? '—'}</span>
        <span>{metadata?.objects.length ?? 0} объектов</span>
        <button
          className="icon-button compact"
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="Обновить метаданные"
        >
          <RefreshCw className={refreshing ? 'spin' : ''} size={14} />
        </button>
      </div>
      <div className="object-tree">
        {groups.map((group) => {
          const expanded = expandedGroups.has(group.kind);
          const Icon = group.icon;
          return (
            <div className="object-group" key={group.kind}>
              <button className="tree-row group-row" type="button" onClick={() => toggleGroup(group.kind)}>
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Icon size={14} />
                <strong>{group.label}</strong>
                <span>{group.objects.length}</span>
              </button>
              {expanded && group.objects.map((object) => {
                const objectExpanded = expandedObjects.has(object.name);
                return (
                  <div key={`${object.schema}.${object.name}`}>
                    <button
                      className={`tree-row object-row ${objectExpanded ? 'is-selected' : ''}`}
                      type="button"
                      onClick={() => toggleObject(object.name)}
                    >
                      {object.columns?.length
                        ? objectExpanded
                          ? <ChevronDown size={12} />
                          : <ChevronRight size={12} />
                        : <span className="tree-spacer" />}
                      <Icon size={14} />
                      <span>{object.name}</span>
                    </button>
                    {objectExpanded && object.columns?.map((column) => (
                      <div className="tree-row column-row" key={column.name}>
                        <span className="column-name">{column.name}</span>
                        <span className="column-type">{column.dataType}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
        {groups.length === 0 && <div className="empty-tree">Объекты не найдены</div>}
      </div>
      <button className="history-button" type="button">
        <Clock3 size={15} /> История запросов
      </button>
    </aside>
  );
}
