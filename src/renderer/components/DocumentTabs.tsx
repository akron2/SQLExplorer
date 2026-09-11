import { ChevronDown, FolderOpen, Plus, RotateCcw, Save, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PublicConnectionProfile, SqlDocument } from '../../shared/contracts';

interface DocumentTabsProps {
  activeDocumentId: string;
  canRestore: boolean;
  connections: PublicConnectionProfile[];
  documents: SqlDocument[];
  nativeMenus: boolean;
  onAdd(): void;
  onAddConnection(): void;
  onAddForConnection(connectionId: string | null): void;
  onClose(documentId: string): void;
  onOpen(): void;
  onRestore(): void;
  onSave(): void;
  onSaveDocument(documentId: string, saveAs: boolean): void;
  onSelect(documentId: string): void;
  onShowAddMenu(): void;
}

export function DocumentTabs({
  activeDocumentId,
  canRestore,
  connections,
  documents,
  nativeMenus,
  onAdd,
  onAddConnection,
  onAddForConnection,
  onClose,
  onOpen,
  onRestore,
  onSave,
  onSaveDocument,
  onSelect,
  onShowAddMenu,
}: DocumentTabsProps) {
  const [fallbackMenu, setFallbackMenu] = useState(false);
  const [documentMenu, setDocumentMenu] = useState<{ documentId: string; x: number; y: number }>();
  const createMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fallbackMenu) return;
    const close = (event: PointerEvent) => {
      if (!createMenuRef.current?.contains(event.target as Node)) setFallbackMenu(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [fallbackMenu]);
  useEffect(() => {
    if (!documentMenu) return;
    const close = () => setDocumentMenu(undefined);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [documentMenu]);
  const showMenu = () => {
    if (nativeMenus) onShowAddMenu();
    else setFallbackMenu((current) => !current);
  };
  const connectionMap = new Map(connections.map((connection) => [connection.id, connection]));
  const active = documents.find((document) => document.id === activeDocumentId);
  return (
    <div className="document-tabs" role="tablist" aria-label="SQL-документы">
      <div className="document-tabs-scroll">
        {documents.map((document) => {
          const profile = document.connectionId ? connectionMap.get(document.connectionId) : undefined;
          return <div className={`document-tab ${document.id === activeDocumentId ? 'is-active' : ''}`} key={document.id} role="tab" aria-selected={document.id === activeDocumentId} title={document.filePath ?? document.title} onContextMenu={(event) => { event.preventDefault(); setDocumentMenu({ documentId: document.id, x: Math.min(event.clientX, window.innerWidth - 180), y: Math.min(event.clientY, window.innerHeight - 125) }); }}>
            <button className="tab-select" type="button" onClick={() => onSelect(document.id)}>
              <span className={`dialect-badge ${document.dialect}`}>{document.dialect === 'oracle' ? 'O' : document.dialect === 'postgres' ? 'P' : 'S'}</span>
              <span className="tab-title">{document.title}</span>
              {profile?.privilege === 'sysdba' && <span className="sysdba-mini">SYS</span>}
              {document.dirty && <span className="dirty-dot" aria-label="Есть изменения">•</span>}
            </button>
            <button className="tab-close" type="button" onClick={() => onClose(document.id)} aria-label={`Закрыть ${document.title}`}><X size={14} /></button>
          </div>;
        })}
      </div>
      <div className="tab-create-group" ref={createMenuRef}>
        <button className="tab-action add-main" type="button" onClick={onAdd} onContextMenu={(event) => { event.preventDefault(); showMenu(); }} title="Новый SQL-документ; правый клик — выбрать соединение" aria-label="Новый SQL-документ"><Plus size={17} /></button>
        <button className="tab-action add-menu" type="button" onClick={showMenu} title="Новый документ для другого соединения" aria-label="Выбрать соединение для новой вкладки"><ChevronDown size={12} /></button>
        {fallbackMenu && <div className="tab-connection-menu" role="menu">
          {connections.length ? connections.map((connection) => <button role="menuitem" type="button" key={connection.id} onClick={() => { setFallbackMenu(false); onAddForConnection(connection.id); }}><span className={`dialect-badge ${connection.kind}`}>{connection.kind === 'oracle' ? 'O' : 'P'}</span><span>{connection.name}</span>{connection.driverMode && <small>{connection.driverMode}</small>}{connection.privilege === 'sysdba' && <b>SYSDBA</b>}</button>) : <button role="menuitem" type="button" onClick={() => { setFallbackMenu(false); onAddForConnection(null); }}>SQL без соединения</button>}
          <span className="menu-separator" /><button role="menuitem" type="button" onClick={() => { setFallbackMenu(false); onAddConnection(); }}>Добавить соединение…</button>
        </div>}
      </div>
      <span className="tab-file-separator" />
      <button className="tab-action" type="button" onClick={onOpen} title="Открыть SQL-файл (Ctrl+O)" aria-label="Открыть SQL-файл"><FolderOpen size={16} /></button>
      <button className="tab-action" type="button" onClick={onSave} disabled={!active?.dirty} title="Сохранить SQL-файл (Ctrl+S)" aria-label="Сохранить SQL-файл"><Save size={15} /></button>
      {canRestore && <button className="tab-action" type="button" onClick={onRestore} title="Вернуть закрытый документ"><RotateCcw size={15} /></button>}
      {documentMenu && <div className="document-context-menu" role="menu" style={{ left: documentMenu.x, top: documentMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        <button role="menuitem" type="button" onClick={() => { onSaveDocument(documentMenu.documentId, false); setDocumentMenu(undefined); }}>Сохранить</button>
        <button role="menuitem" type="button" onClick={() => { onSaveDocument(documentMenu.documentId, true); setDocumentMenu(undefined); }}>Сохранить как…</button>
        <span className="menu-separator" />
        <button role="menuitem" type="button" onClick={() => { onClose(documentMenu.documentId); setDocumentMenu(undefined); }}>Закрыть</button>
      </div>}
    </div>
  );
}
