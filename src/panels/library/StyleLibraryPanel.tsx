/**
 * UI 编辑器左栏「样式库」（v3 T11.7 最小版）
 *
 * 展示本资产已应用样式表的类；选中节点后点类 → 挂载/移除 classes（命令栈可撤销）；
 * 「查找引用」统计全树挂该类的节点数。样式表文件的编辑/新建随资源库面板（T11.5）接入。
 */
import { useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { runUICommand, useSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import { Icon } from '@/shell/ui/Icon'
import type { UIAsset, UINode } from '@/ir/types'

function collectClassRefs(root: UINode, className: string, out: string[] = []): string[] {
  if ((root.classes ?? []).includes(className)) out.push(root.id)
  for (const c of root.children ?? []) collectClassRefs(c, className, out)
  return out
}

function findNode(root: UINode, id: string): UINode | null {
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

export function StyleLibraryPanel() {
  const { asset } = useSceneTreeDomain()
  const styleSheets = useUIEditorStore((s) => s.styleSheets)
  const selection = useUIEditorStore((s) => s.selection)
  const [newRef, setNewRef] = useState('')

  const addSheet = (): void => {
    const ref = newRef.trim()
    if (!ref || !asset) return
    runUICommand(`样式库：应用样式表 ${ref}`, (draft) => {
      const a = draft as UIAsset
      a.styles = [...(a.styles ?? []), ref]
    })
    setNewRef('')
    void useUIEditorStore.getState().refreshStyleSheets()
  }

  const removeSheet = (ref: string): void => {
    if (!asset) return
    runUICommand(`样式库：移除样式表 ${ref}`, (draft) => {
      const a = draft as UIAsset
      a.styles = (a.styles ?? []).filter((s) => s !== ref)
    })
    void useUIEditorStore.getState().refreshStyleSheets()
  }

  const classes = useMemo(() => {
    const out: Array<{ name: string; sheet: number }> = []
    styleSheets.forEach((sheet, i) => {
      for (const name of Object.keys(sheet.classes)) out.push({ name, sheet: i })
    })
    return out
  }, [styleSheets])

  const toggle = (name: string): void => {
    if (!asset || selection.length === 0) return
    const selected = new Set(selection)
    const add = !selection.every((id) => {
      const n = findNode(asset.root, id)
      return n?.classes?.includes(name) ?? false
    })
    runUICommand(`${add ? '挂载' : '移除'}样式类 ${name}`, (draft) => {
      const root = (draft as { root: UINode }).root
      for (const id of selected) {
        const n = findNode(root, id)
        if (!n) continue
        const cur = new Set(n.classes ?? [])
        if (add) cur.add(name)
        else cur.delete(name)
        n.classes = [...cur]
      }
    })
  }

  return (
    <div className="style-library">
      <div className="element-library-group">
        <div className="element-library-title">应用样式表（{styleSheets.length}）</div>
        {(asset?.styles ?? []).length === 0 ? (
          <div className="element-library-empty">本资产未声明 styles。</div>
        ) : (
          <div className="style-library-sheets">
            {(asset?.styles ?? []).map((ref, i) => (
              <div key={`${ref}-${i}`} className="style-library-sheet">
                <span title={ref}>{ref}</span>
                <span className="style-library-refs">
                  {styleSheets[i] ? Object.keys(styleSheets[i]!.classes).length : 0} 类
                </span>
                <button
                  type="button"
                  className="insp-btn"
                  title="移除该样式表引用"
                  onClick={() => removeSheet(ref)}
                >
                  <Icon icon={X} size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="insp-flex-row" style={{ padding: '4px 0' }}>
          <input
            className="insp-flex-text"
            placeholder="ui/styles/app.uss.json 或 @library/styles/base"
            value={newRef}
            onChange={(e) => setNewRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addSheet()
            }}
          />
          <button type="button" className="insp-btn" onClick={addSheet} title="应用样式表">
            <Icon icon={Plus} size={12} />
          </button>
        </div>
      </div>
      <div className="element-library-group">
        <div className="element-library-title">类（{classes.length}）</div>
        {classes.length === 0 ? (
          <div className="element-library-empty">暂无可选样式类。</div>
        ) : (
          <div className="style-library-list">
            {classes.map(({ name }) => {
              const refs = asset ? collectClassRefs(asset.root, name) : []
              const active = selection.length > 0 && selection.every((id) => {
                const n = asset ? findNode(asset.root, id) : null
                return n?.classes?.includes(name) ?? false
              })
              return (
                <div key={name} className={`style-library-row${active ? ' active' : ''}`}>
                  <button
                    type="button"
                    className="style-library-name"
                    title={selection.length > 0 ? '点击挂载/移除到选中节点' : '先在 UI 树/画布中选择节点'}
                    onClick={() => toggle(name)}
                  >
                    .{name}
                  </button>
                  <span className="style-library-refs" title={`引用 ${refs.length} 个节点`}>
                    {refs.length}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {selection.length > 0 ? (
        <div className="element-library-empty">已选中 {selection.length} 个节点：点类名挂载/移除。</div>
      ) : null}
    </div>
  )
}
