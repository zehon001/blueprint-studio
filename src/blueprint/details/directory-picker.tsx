/**
 * 工作区目录内部设置（创建 Agent 会话）：
 * 「选择目录」按钮 → 服务端 /api/dialog/select-directory（macOS osascript）拉起
 * 系统原生目录选择窗口，选中即写入；留空 = 当前蓝图项目目录。
 */
import { useState } from 'react'
import { useWorkspaceStore } from '../../shell/workspace-store'

export function DirectoryValueEditor(props: {
  value: unknown;
  onCommit: (value: string) => void;
}) {
  const project = useWorkspaceStore((s) => s.currentProject?.path ?? '')
  const current = typeof props.value === 'string' ? props.value : '';
  const [picking, setPicking] = useState(false);

  const pick = async (): Promise<void> => {
    setPicking(true);
    try {
      const res = await fetch('/api/dialog/select-directory', { method: 'POST' });
      const body = (await res.json()) as { ok?: boolean; path?: string; canceled?: boolean };
      if (body.ok && body.path) props.onCommit(body.path);
    } catch {
      /* 服务不可达：保持原值 */
    } finally {
      setPicking(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', width: '100%' }}>
      <span
        className="bp-det-input bp-det-readonly"
        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={current || `（默认项目目录：${project || '未打开项目'}）`}
      >
        {current || `（默认项目目录：${project || '未打开项目'}）`}
      </span>
      <button
        type="button"
        className="toolbar-btn"
        style={{ flex: 'none' }}
        disabled={picking}
        title="拉起系统目录选择窗口"
        onClick={() => void pick()}
      >
        {picking ? '选择中…' : '选择目录'}
      </button>
      {current ? (
        <button
          type="button"
          className="toolbar-btn"
          style={{ flex: 'none' }}
          title="清除，恢复默认项目目录"
          onClick={() => props.onCommit('')}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
