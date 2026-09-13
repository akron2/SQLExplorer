import { useState } from 'react';
import { FileCode2, X } from 'lucide-react';
import type { SqlDocument, TextFileBom } from '../../shared/contracts';
import { ENCODING_OPTIONS } from '../../shared/lob';

interface EncodingDialogProps {
  document: SqlDocument;
  onApply(encoding: string, bom: TextFileBom, reopen: boolean): void;
  onClose(): void;
  onPreview(encoding: string): Promise<string>;
}

export function EncodingDialog({ document, onApply, onClose, onPreview }: EncodingDialogProps) {
  const [encoding, setEncoding] = useState(document.encoding);
  const [bom, setBom] = useState(document.bom);
  const [preview, setPreview] = useState(document.text.slice(0, 4000));
  const [previewError, setPreviewError] = useState<string>();
  return <div className="dialog-backdrop" role="presentation"><section className="dialog-card encoding-dialog" role="dialog" aria-modal="true" aria-label="Кодировка файла">
    <header className="dialog-header"><span className="dialog-icon"><FileCode2 size={18} /></span><div><strong>Кодировка файла</strong><small>{document.filePath ?? 'Несохранённый документ'}</small></div><button className="icon-button compact" type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button></header>
    <div className="encoding-content"><label><span>Кодировка</span><div className="encoding-input-row"><input aria-label="Кодировка" list="sqlx-encodings" value={encoding} onChange={(event) => setEncoding(event.target.value)} /><button className="secondary-button" type="button" onClick={() => { setPreviewError(undefined); void onPreview(encoding).then((value) => setPreview(value.slice(0, 4000))).catch((error: unknown) => setPreviewError(error instanceof Error ? error.message : String(error))); }}>Предпросмотр</button></div><datalist id="sqlx-encodings">{ENCODING_OPTIONS.map((value) => <option key={value} value={value} />)}</datalist></label><label><span>BOM</span><select aria-label="BOM" value={bom} onChange={(event) => setBom(event.target.value as TextFileBom)}><option value="none">Без BOM</option><option value="utf8">UTF-8 BOM</option><option value="utf16le">UTF-16 LE BOM</option><option value="utf16be">UTF-16 BE BOM</option><option value="utf32le">UTF-32 LE BOM</option><option value="utf32be">UTF-32 BE BOM</option></select></label><p>Обычное сохранение использует выбранную кодировку. Для чистого файла можно перечитать исходные байты с диска.</p>{previewError && <div className="dialog-message error">{previewError}</div>}<pre className="encoding-preview">{preview}</pre></div>
    <footer className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Отмена</button>{document.filePath && !document.dirty && <button className="secondary-button" type="button" onClick={() => onApply(encoding, bom, true)}>Открыть повторно</button>}<button className="primary-button" type="button" onClick={() => onApply(encoding, bom, false)}>Использовать при сохранении</button></footer>
  </section></div>;
}
