import { Plus, RotateCcw, X } from 'lucide-react';
import type { SqlDocument } from '../../shared/contracts';

interface DocumentTabsProps {
  activeDocumentId: string;
  canRestore: boolean;
  documents: SqlDocument[];
  onAdd(): void;
  onClose(documentId: string): void;
  onRestore(): void;
  onSelect(documentId: string): void;
}

export function DocumentTabs({
  activeDocumentId,
  canRestore,
  documents,
  onAdd,
  onClose,
  onRestore,
  onSelect,
}: DocumentTabsProps) {
  return (
    <div className="document-tabs" role="tablist" aria-label="SQL-документы">
      <div className="document-tabs-scroll">
        {documents.map((document) => (
          <div
            className={`document-tab ${document.id === activeDocumentId ? 'is-active' : ''}`}
            key={document.id}
            role="tab"
            aria-selected={document.id === activeDocumentId}
          >
            <button className="tab-select" type="button" onClick={() => onSelect(document.id)}>
              <span className={`dialect-badge ${document.dialect}`}>
                {document.dialect === 'oracle' ? 'O' : 'P'}
              </span>
              <span className="tab-title">{document.title}</span>
              {document.dirty && <span className="dirty-dot" aria-label="Есть изменения">•</span>}
            </button>
            <button
              className="tab-close"
              type="button"
              onClick={() => onClose(document.id)}
              aria-label={`Закрыть ${document.title}`}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <button className="tab-action" type="button" onClick={onAdd} title="Новый SQL-документ">
        <Plus size={17} />
      </button>
      {canRestore && (
        <button
          className="tab-action"
          type="button"
          onClick={onRestore}
          title="Вернуть закрытый документ"
        >
          <RotateCcw size={15} />
        </button>
      )}
    </div>
  );
}
