import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FilePlus2, FolderOpen, Moon, PanelLeft, Save, Sun } from 'lucide-react';
import type { FileCommand, RecentSqlFile } from '../../shared/contracts';

interface TitleBarProps {
  explorerVisible: boolean;
  onFileCommand(command: FileCommand): void;
  onOpenRecent(filePath: string): void;
  onRequestRecent(): void;
  onToggleExplorer(): void;
  onToggleTheme(): void;
  recentFiles: RecentSqlFile[];
  theme: 'light' | 'dark';
}

export function TitleBar({
  explorerVisible,
  onFileCommand,
  onOpenRecent,
  onRequestRecent,
  onToggleExplorer,
  onToggleTheme,
  recentFiles,
  theme,
}: TitleBarProps) {
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fileMenuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFileMenuOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (!fileMenuRef.current?.contains(event.target as Node)) setFileMenuOpen(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', outside);
    };
  }, [fileMenuOpen]);
  const command = (value: FileCommand) => {
    setFileMenuOpen(false);
    onFileCommand(value);
  };
  return (
    <header className="title-bar">
      <div className="app-mark" aria-hidden="true">›_</div>
      <strong className="app-name">SQLExplorer</strong>
      <span className="title-divider" />
      <div className="file-menu-wrap" ref={fileMenuRef}>
        <button className={`title-menu-button ${fileMenuOpen ? 'is-open' : ''}`} type="button" onClick={() => {
          const next = !fileMenuOpen;
          setFileMenuOpen(next);
          if (next) onRequestRecent();
        }}>Файл <ChevronDown size={12} /></button>
        {fileMenuOpen && <div className="file-menu" role="menu">
          <button role="menuitem" type="button" onClick={() => command('new')}><FilePlus2 size={14} /><span>Новый SQL</span><kbd>Ctrl+N</kbd></button>
          <button role="menuitem" type="button" onClick={() => command('open')}><FolderOpen size={14} /><span>Открыть…</span><kbd>Ctrl+O</kbd></button>
          {recentFiles.length > 0 && <div className="recent-file-group"><small>Недавние файлы</small>{recentFiles.slice(0, 8).map((file) => <button role="menuitem" type="button" key={file.filePath} title={file.filePath} onClick={() => { setFileMenuOpen(false); onOpenRecent(file.filePath); }}><span className="recent-file-title">{file.title}</span></button>)}</div>}
          <span className="menu-separator" />
          <button role="menuitem" type="button" onClick={() => command('save')}><Save size={14} /><span>Сохранить</span><kbd>Ctrl+S</kbd></button>
          <button role="menuitem" type="button" onClick={() => command('saveAs')}><span className="menu-icon-placeholder" /><span>Сохранить как…</span><kbd>Ctrl+Shift+S</kbd></button>
          <button role="menuitem" type="button" onClick={() => command('saveAll')}><span className="menu-icon-placeholder" /><span>Сохранить все</span></button>
          <span className="menu-separator" />
          <button role="menuitem" type="button" onClick={() => command('close')}><span className="menu-icon-placeholder" /><span>Закрыть вкладку</span><kbd>Ctrl+W</kbd></button>
        </div>}
      </div>
      <span className="workspace-label">Рабочая область</span>
      <div className="title-actions">
        <button className={`icon-button ${explorerVisible ? 'is-active' : ''}`} type="button" onClick={onToggleExplorer} title={explorerVisible ? 'Скрыть проводник' : 'Показать проводник'} aria-label={explorerVisible ? 'Скрыть проводник' : 'Показать проводник'}><PanelLeft size={16} /></button>
        <button className="icon-button" type="button" onClick={onToggleTheme} title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
      </div>
    </header>
  );
}
