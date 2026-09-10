import { Moon, PanelLeft, Sun } from 'lucide-react';

interface TitleBarProps {
  explorerVisible: boolean;
  onToggleExplorer(): void;
  onToggleTheme(): void;
  theme: 'light' | 'dark';
}

export function TitleBar({ explorerVisible, onToggleExplorer, onToggleTheme, theme }: TitleBarProps) {
  return (
    <header className="title-bar">
      <div className="app-mark" aria-hidden="true">›_</div>
      <strong className="app-name">SQLExplorer</strong>
      <span className="title-divider" />
      <span className="workspace-label">Рабочая область</span>
      <div className="title-actions">
        <button
          className={`icon-button ${explorerVisible ? 'is-active' : ''}`}
          type="button"
          onClick={onToggleExplorer}
          title={explorerVisible ? 'Скрыть проводник' : 'Показать проводник'}
          aria-label={explorerVisible ? 'Скрыть проводник' : 'Показать проводник'}
        >
          <PanelLeft size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
    </header>
  );
}
