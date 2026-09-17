import { useState } from 'react';
import { Braces, X } from 'lucide-react';
import type { BindValue, BindValueType } from '../../shared/contracts';
import { type SqlParameterOccurrence, parseBindValue } from '../../shared/sql-binds';

export interface BindDialogParameter extends SqlParameterOccurrence {
  initial?: BindValue;
}

interface BindParametersDialogProps {
  onCancel(): void;
  onConfirm(values: Record<string, BindValue>): void;
  parameters: BindDialogParameter[];
}

interface BindRowState {
  error?: string;
  isNull: boolean;
  type: Exclude<BindValueType, 'null'>;
  value: string;
}

function initialRow(parameter: BindDialogParameter): BindRowState {
  const initial = parameter.initial;
  if (initial && initial.type === 'null') {
    return { type: 'string', value: '', isNull: true };
  }
  return {
    type: initial && initial.type !== 'null' ? initial.type : 'string',
    value: initial ? initial.value : '',
    isNull: false,
  };
}

export function BindParametersDialog({ onCancel, onConfirm, parameters }: BindParametersDialogProps) {
  const [rows, setRows] = useState<Record<string, BindRowState>>(() =>
    Object.fromEntries(parameters.map((parameter) => [parameter.key, initialRow(parameter)])));

  const updateRow = (key: string, patch: Partial<BindRowState>) => {
    setRows((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  };

  const handleSubmit = () => {
    const values: Record<string, BindValue> = {};
    let valid = true;
    const next: Record<string, BindRowState> = { ...rows };
    for (const parameter of parameters) {
      const row = rows[parameter.key];
      if (row.isNull) {
        values[parameter.key] = { type: 'null', value: '' };
        continue;
      }
      const parsed = parseBindValue(row.type, row.value);
      if (!parsed.ok) {
        next[parameter.key] = { ...row, error: parsed.message };
        valid = false;
        continue;
      }
      values[parameter.key] = { type: row.type, value: row.value };
    }
    if (!valid) {
      setRows(next);
      return;
    }
    onConfirm(values);
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <form
        className="dialog-card bind-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Параметры запроса"
        onSubmit={(event) => { event.preventDefault(); handleSubmit(); }}
      >
        <header className="dialog-header">
          <span className="dialog-icon"><Braces size={18} /></span>
          <div>
            <strong>Параметры запроса</strong>
            <small>Значения остаются только в памяти этой вкладки</small>
          </div>
          <button className="icon-button compact" type="button" onClick={onCancel} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <div className="bind-grid" role="grid">
          <div className="bind-head">Параметр</div>
          <div className="bind-head">Тип</div>
          <div className="bind-head">Значение</div>
          <div className="bind-head">NULL</div>
          {parameters.map((parameter) => {
            const row = rows[parameter.key];
            return (
              <div className="bind-row" role="row" key={parameter.key}>
                <div className="bind-name" title={parameter.name}><code>{parameter.name}</code></div>
                <select
                  aria-label={`Тип параметра ${parameter.name}`}
                  value={row.type}
                  disabled={row.isNull}
                  onChange={(event) => updateRow(parameter.key, {
                    type: event.target.value as Exclude<BindValueType, 'null'>, error: undefined,
                  })}
                >
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                </select>
                <div className="bind-value">
                  <input
                    aria-label={`Значение параметра ${parameter.name}`}
                    type="text"
                    spellCheck={false}
                    value={row.value}
                    disabled={row.isNull}
                    onChange={(event) => updateRow(parameter.key, { value: event.target.value, error: undefined })}
                  />
                  {row.error && <small className="bind-error">{row.error}</small>}
                </div>
                <label className="check-label bind-null">
                  <input
                    type="checkbox"
                    checked={row.isNull}
                    aria-label={`NULL для параметра ${parameter.name}`}
                    onChange={(event) => updateRow(parameter.key, { isNull: event.target.checked, error: undefined })}
                  />
                </label>
              </div>
            );
          })}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>Отмена</button>
          <button className="primary-button" type="submit">Выполнить</button>
        </footer>
      </form>
    </div>
  );
}
