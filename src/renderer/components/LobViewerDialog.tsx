import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Binary, FileDown, FileText, LoaderCircle, X } from 'lucide-react';
import type { LobProgress, LobSubtype } from '../../shared/contracts';
import {
  ENCODING_OPTIONS,
  LOB_BINARY_READ_STEP,
  LOB_HEX_BYTES_PER_LINE,
  LOB_READ_INITIAL,
  LOB_READ_STEP,
  LOB_VIEW_BINARY_CAP,
  LOB_VIEW_TEXT_CAP,
  formatByteSize,
  formatCharCount,
  isBinarySubtype,
  lobSuggestedFileName,
} from '../../shared/lob';
import { getApi } from '../mock-api';

export interface LobViewerTarget {
  available: boolean;
  columnIndex: number;
  columnName: string;
  executionId: string;
  rowIndex: number;
  size: number | null;
  sizeUnit: 'bytes' | 'chars';
  subtype: LobSubtype;
}

interface LobViewerDialogProps {
  cell: LobViewerTarget;
  onClose(): void;
}

function base64ToBytes(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

const DECODER_LABELS: Record<string, string> = {
  utf8: 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  cp866: 'ibm866',
  'koi8-r': 'koi8-r',
  'iso-8859-5': 'iso-8859-5',
  shift_jis: 'shift_jis',
  gb18030: 'gb18030',
  big5: 'big5',
  'euc-kr': 'euc-kr',
};

function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): string {
  const codePoints: number[] = [];
  for (let offset = 0; offset + 3 < bytes.byteLength; offset += 4) {
    const value = littleEndian
      ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
      : ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    codePoints.push(value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? value : 0xfffd);
  }
  let result = '';
  for (let index = 0; index < codePoints.length; index += 8192) {
    result += String.fromCodePoint(...codePoints.slice(index, index + 8192));
  }
  return result;
}

function decodeBinaryText(bytes: Uint8Array, encoding: string): string {
  if (encoding === 'utf32le' || encoding === 'utf32be') return decodeUtf32(bytes, encoding === 'utf32le');
  return new TextDecoder(DECODER_LABELS[encoding] ?? 'utf-8').decode(bytes);
}

export function LobViewerDialog({ cell, onClose }: LobViewerDialogProps) {
  const api = useMemo(() => getApi(), []);
  const binary = isBinarySubtype(cell.subtype);
  const [mode, setMode] = useState<'hex' | 'text'>(binary ? 'hex' : 'text');
  const [encoding, setEncoding] = useState('utf8');
  const [text, setText] = useState('');
  const [chunks, setChunks] = useState<Uint8Array[]>([]);
  const [eof, setEof] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<LobProgress>();
  const [savedPath, setSavedPath] = useState<string>();
  const offsetRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const length = offsetRef.current === 0
        ? LOB_READ_INITIAL
        : binary ? LOB_BINARY_READ_STEP : LOB_READ_STEP;
      const chunk = await api.readLob({
        executionId: cell.executionId,
        rowIndex: cell.rowIndex,
        columnIndex: cell.columnIndex,
        offset: offsetRef.current,
        length,
      });
      if (!mountedRef.current) return;
      setError(undefined);
      offsetRef.current = chunk.nextOffset;
      setEof(chunk.eof);
      if (chunk.encoding === 'base64') {
        const bytes = base64ToBytes(chunk.data);
        setChunks((current) => [...current, bytes]);
      } else {
        setText((current) => current + chunk.data);
      }
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api, binary, cell.columnIndex, cell.executionId, cell.rowIndex]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!saving) return;
    return api.onLobProgress((value) => {
      if (value.executionId !== cell.executionId
        || value.rowIndex !== cell.rowIndex
        || value.columnIndex !== cell.columnIndex) return;
      setProgress(value);
      if (value.phase !== 'running') setSaving(false);
    });
  }, [api, cell.columnIndex, cell.executionId, cell.rowIndex, saving]);

  const bytes = useMemo(() => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }, [chunks]);

  const decoded = useMemo(() => {
    if (!binary || mode !== 'text') return '';
    try {
      return decodeBinaryText(bytes, encoding);
    } catch (caught) {
      return `Не удалось декодировать: ${caught instanceof Error ? caught.message : String(caught)}`;
    }
  }, [binary, bytes, encoding, mode]);

  const hex = useMemo(() => {
    const lines: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += LOB_HEX_BYTES_PER_LINE) {
      const slice = bytes.subarray(offset, offset + LOB_HEX_BYTES_PER_LINE);
      const hexPart = [...slice].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
      const asciiPart = [...slice].map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('');
      lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexPart.padEnd(LOB_HEX_BYTES_PER_LINE * 3 - 1, ' ')}  ${asciiPart}`);
    }
    return lines.join('\n');
  }, [bytes]);

  const loaded = binary ? bytes.byteLength : text.length;
  const cap = binary ? LOB_VIEW_BINARY_CAP : LOB_VIEW_TEXT_CAP;
  const sizeLabel = cell.size === null
    ? 'размер неизвестен'
    : cell.sizeUnit === 'bytes' ? formatByteSize(cell.size) : formatCharCount(cell.size);
  const loadedLabel = binary
    ? `${formatByteSize(bytes.byteLength)} загружено`
    : `${formatCharCount(text.length)} загружено`;
  const preview = binary && mode === 'hex' ? hex : binary ? decoded : text;

  const save = async () => {
    setSaving(true);
    setProgress(undefined);
    setError(undefined);
    try {
      const result = await api.saveLob({
        executionId: cell.executionId,
        rowIndex: cell.rowIndex,
        columnIndex: cell.columnIndex,
        suggestedName: lobSuggestedFileName(cell.columnName, cell.rowIndex, cell.subtype),
      });
      if (result.status === 'unavailable') setError('Значение больше недоступно');
      if (result.status === 'saved') setSavedPath(result.filePath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const copyLoaded = () => {
    const value = binary ? decoded : text;
    void navigator.clipboard.writeText(value);
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog-card lob-viewer" role="dialog" aria-modal="true" aria-label="Просмотр значения">
        <header className="dialog-header">
          <span className="dialog-icon">{binary ? <Binary size={18} /> : <FileText size={18} />}</span>
          <div>
            <strong>{cell.subtype}</strong>
            <small>{cell.columnName} · строка {cell.rowIndex} · {sizeLabel}</small>
          </div>
          <button className="icon-button compact" type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>
        {binary && (
          <div className="lob-mode-tabs">
            <button className={mode === 'hex' ? 'is-active' : ''} type="button" onClick={() => setMode('hex')}>Hex</button>
            <button className={mode === 'text' ? 'is-active' : ''} type="button" onClick={() => setMode('text')}>Текст</button>
            {mode === 'text' && (
              <select aria-label="Кодировка" value={encoding} onChange={(event) => setEncoding(event.target.value)}>
                {ENCODING_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            )}
          </div>
        )}
        <div className="lob-content">
          {error && <div className="dialog-message error">{error}</div>}
          {savedPath && <div className="dialog-message success">Сохранено: {savedPath}</div>}
          <pre className={`lob-text${binary && mode === 'hex' ? ' lob-hex' : ''}`}>{preview}</pre>
          {loading && <div className="lob-loading"><LoaderCircle className="spin" size={16} /> Чтение…</div>}
        </div>
        <footer className="dialog-actions lob-actions">
          <span className="lob-status">
            {loadedLabel}
            {eof ? ' · конец значения' : loaded >= cap ? ' · достигнут предел просмотра' : ''}
            {saving && progress ? ` · записано ${formatByteSize(progress.bytesWritten)}` : ''}
          </span>
          <div className="lob-buttons">
            {!eof && loaded < cap && (
              <button className="secondary-button" type="button" disabled={loading || saving} onClick={() => { setLoading(true); void load(); }}>
                Показать ещё
              </button>
            )}
            {(!binary || mode === 'text') && (
              <button className="secondary-button" type="button" disabled={!loaded} onClick={copyLoaded}>
                Копировать загруженное
              </button>
            )}
            {saving ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => { if (progress?.operationId) void api.cancelLobSave(progress.operationId); }}
              >
                Отменить сохранение
              </button>
            ) : (
              <button className="primary-button" type="button" onClick={() => void save()}>
                <FileDown size={15} /> Сохранить в файл…
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
