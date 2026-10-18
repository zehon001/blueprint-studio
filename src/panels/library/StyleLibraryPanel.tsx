/**
 * UI 编辑器左栏「样式库」（v3 T11.7 最小版）
 *
 * 展示本资产已应用样式表的类；选中节点后点类 → 挂载/移除 classes（命令栈可撤销）；
 * 「查找引用」统计全树挂该类的节点数。样式表文件的编辑/新建随资源库面板（T11.5）接入。
 */
import { useMemo } from 'react'
import { runUICommand, useSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import type { UINode } from '@/ir/types'

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
        {styleSheets.length === 0 ? (
          <div className="element-library-empty">
            本资产未声明 styles。可在 .ui.json 的 styles 数组中添加项目样式表（ui/styles/*.uss.json）。
          </div>
        ) : (
          <div className="style-library-sheets">
            {styleSheets.map((s, i) => (
              <div key={i} className="style-library-sheet">
                表 {i + 1} · {Object.keys(s.classes).length} 类
              </div>
            ))}
          </div>
        )}
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
