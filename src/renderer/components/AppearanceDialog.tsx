import { Minus, Plus, Type, X } from 'lucide-react';
import type { InterfaceScale } from '../../shared/contracts';
import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN, UI_SCALE_STEPS } from '../../shared/contracts';

interface AppearanceDialogProps {
  editorFontSize: number;
  interfaceScale: InterfaceScale;
  onChangeEditorFontSize(fontSize: number): void;
  onChangeInterfaceScale(scale: InterfaceScale): void;
  onClose(): void;
}

const previewCode = `select
  e.employee_id,
  e.full_name
from employees e
where e.salary > :min_salary
order by e.employee_id;`;

export function AppearanceDialog({
  editorFontSize,
  interfaceScale,
  onChangeEditorFontSize,
  onChangeInterfaceScale,
  onClose,
}: AppearanceDialogProps) {
  const basePx = Math.round(14 * interfaceScale);
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog-card appearance-dialog" role="dialog" aria-modal="true" aria-label="Вид и шрифт">
      <header className="dialog-header"><span className="dialog-icon"><Type size={18} /></span><div><strong>Вид и шрифт</strong><small>Размер текста интерфейса и SQL-редактора</small></div><button className="icon-button compact" type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button></header>
      <div className="settings-content">
        <fieldset>
          <legend>Интерфейс</legend>
          <div className="scale-options" role="radiogroup" aria-label="Масштаб интерфейса">
            {UI_SCALE_STEPS.map((step) => <button
              aria-checked={step === interfaceScale}
              className={`scale-option ${step === interfaceScale ? 'is-active' : ''}`}
              key={step}
              onClick={() => onChangeInterfaceScale(step)}
              role="radio"
              type="button"
            >{Math.round(step * 100)}%</button>)}
          </div>
          <p className="appearance-hint">Базовый текст интерфейса — {basePx}px. Масштаб приложения умножается на масштаб Windows.</p>
        </fieldset>
        <fieldset>
          <legend>Редактор</legend>
          <div className="font-size-row">
            <button className="icon-button compact" type="button" onClick={() => onChangeEditorFontSize(editorFontSize - 1)} disabled={editorFontSize <= EDITOR_FONT_SIZE_MIN} title="Уменьшить шрифт" aria-label="Уменьшить шрифт редактора"><Minus size={14} /></button>
            <output className="font-size-value" aria-live="polite">{editorFontSize}px</output>
            <button className="icon-button compact" type="button" onClick={() => onChangeEditorFontSize(editorFontSize + 1)} disabled={editorFontSize >= EDITOR_FONT_SIZE_MAX} title="Увеличить шрифт" aria-label="Увеличить шрифт редактора"><Plus size={14} /></button>
            <span className="appearance-hint">Ctrl+колесо мыши в редакторе меняет размер шрифта.</span>
          </div>
          <pre className="font-preview" style={{ fontSize: `${editorFontSize}px` }} aria-label="Предпросмотр кода">{previewCode}</pre>
        </fieldset>
      </div>
      <footer className="dialog-actions"><button className="primary-button" type="button" onClick={onClose}>Готово</button></footer>
    </section>
  </div>;
}
