/**
 * 工作区目录内部设置（创建 Agent 会话）：文本框 + 「选择目录」弹窗。
 *
 * 取值约定（服务端 handler 解析）：空 = 当前蓝图项目目录；绝对路径原样；
 * 相对路径相对项目目录。弹窗内可浏览项目子目录（GET /api/tree）或手填任意路径。
 */
import { useEffect, useState } from 'react'
import { Dialog } from '../../shell/ui/Dialog'
import { useWorkspaceStore } from '../../shell/workspace-store'

interface TreeNodeLike {
  name?: string
  type?: string
  children?: TreeNodeLike[]
}

/** 列出某目录下的子目录（GET /api/tree；失败返回空数组） */
async function listDirs(path: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/tree?path=${encodeURIComponent(path)}`)
    const body = (await res.json()) as { ok?: boolean; tree?: { children?: TreeNodeLike[] } }
    if (!body.ok) return []
    return (body.tree?.children ?? [])
      .filter((c) => c.type === 'dir' && typeof c.name === 'string' && !c.name.startsWith('.'))
      .map((c) => c.name!)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  } catch {
    return []
  }
}

/** 工作区目录选择弹窗：浏览项目子目录 + 手填绝对/相对路径 */
function DirectoryPicker(props: {
  project: string
  initialRel: string
  onCancel: () => void
  onPick: (value: string) => void
}) {
  const [rel, setRel] = useState(props.initialRel)
  const [dirs, setDirs] = useState<string[]>([])
  const [manual, setManual] = useState('')

  useEffect(() => {
    let alive = true
    void listDirs(props.project ? `${props.project}/${rel}` : rel).then((d) => {
      if (alive) setDirs(d)
    })
    return () => {
      alive = false
    }
  }, [props.project, rel])

  const enter = (name: string): void => setRel((cur) => (cur ? `${cur}/${name}` : name))
  const up = (): void => setRel((cur) => (cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : ''))

  return (
    <Dialog title="选择工作区目录" width={460} onClose={props.onCancel}
      footer={
        <>
          <button type="button" className="toolbar-btn" onClick={props.onCancel}>取消</button>
          <button
            type="button"
            className="toolbar-btn toolbar-primary"
            onClick={() => props.onPick(manual.trim() || rel)}
          >
            使用此目录
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
        <div>
          当前：<strong>{props.project ? `${props.project}/${rel || ''}` : rel || '（未选择）'}</strong>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
          {rel ? (
            <button type="button" className="toolbar-btn" style={{ textAlign: 'left' }} onClick={up}>↩ 上一级</button>
          ) : null}
          {dirs.map((d) => (
            <button key={d} type="button" className="toolbar-btn" style={{ textAlign: 'left' }} onClick={() => enter(d)}>
              📁 {d}
            </button>
          ))}
          {!props.project ? <div style={{ color: 'var(--text-dim)' }}>未打开项目：请直接输入绝对路径。</div> : null}
          {props.project && dirs.length === 0 ? <div style={{ color: 'var(--text-dim)' }}>(无子目录)</div> : null}
        </div>
        <input
          className="bp-det-input"
          value={manual}
          placeholder="或输入路径：绝对路径 / 项目内相对路径（留空 = 使用上方当前目录）"
          onChange={(e) => setManual(e.target.value)}
        />
        <div style={{ color: 'var(--text-dim)' }}>
          留空并确认 = 使用当前蓝图项目目录（{props.project || '未打开项目'}）。
        </div>
      </div>
    </Dialog>
  )
}

/** 目录内部设置编辑器：路径输入 + 选择目录按钮 */
export function DirectoryValueEditor(props: {
  value: unknown;
  onCommit: (value: string) => void;
}) {
  const project = useWorkspaceStore((s) => s.currentProject?.path ?? '')
  const current = typeof props.value === 'string' ? props.value : '';
  const [draft, setDraft] = useState(current);
  const [picking, setPicking] = useState(false);
  useEffect(() => setDraft(current), [current]);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', width: '100%' }}>
      <input
        type="text"
        className="bp-det-input"
        style={{ flex: 1, minWidth: 0 }}
        value={draft}
        placeholder="（默认项目目录）"
        title={current || '（默认项目目录）'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== current) props.onCommit(draft);
        }}
      />
      <button
        type="button"
        className="toolbar-btn"
        style={{ flex: 'none' }}
        title="选择目录"
        onClick={() => setPicking(true)}
      >
        选择目录
      </button>
      {picking ? (
        <DirectoryPicker
          project={project}
          initialRel={current && !current.includes('/') ? '' : current}
          onCancel={() => setPicking(false)}
          onPick={(value) => {
            setPicking(false);
            setDraft(value);
            props.onCommit(value);
          }}
        />
      ) : null}
    </div>
  );
}
