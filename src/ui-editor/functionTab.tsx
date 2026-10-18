/**
 * 函数资产编辑器（v3 T12.2）
 *
 * .fn.json 是「单图 + 签名」资产，不是 IRAsset；本组件把它包装成蓝图编辑器可编辑的
 * IRAsset 视图（entry = 'main'），保存时写回 .fn.json（项目文件 / 内置库 REST）。
 * 项目路径示例：library/functions/fmt.fn.json；内置库：@library/functions/fmt。
 */
import { useEffect, useState } from 'react'
import { BlueprintEditorPanel } from '@/blueprint'
import type { IRAsset } from '@/ir/types'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { fnNameOf, functionIR, functionTextOf, isLibraryFunctionPath, type FnAsset } from './functionAsset'

export interface FunctionTabProps {
  path: string
  panelId?: string
}

export { functionIR, functionTextOf } from './functionAsset'

export function FunctionTab({ path, panelId }: FunctionTabProps) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; asset: IRAsset | null; message: string }>({
    status: 'loading',
    asset: null,
    message: '',
  })

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        let text = ''
        if (isLibraryFunctionPath(path)) {
          const name = fnNameOf(path)
          const r = await fetch(`/api/library/read?kind=functions&name=${encodeURIComponent(name)}`)
          const j = (await r.json()) as { ok?: boolean; content?: string; message?: string }
          if (!j.ok) throw new Error(j.message ?? '内置函数读取失败')
          text = String(j.content ?? '')
        } else {
          if (!project) throw new Error('未打开项目')
          const r = await fetch(`/api/file?path=${encodeURIComponent(`${project.path}/${path}`)}`)
          const j = (await r.json()) as { ok?: boolean; content?: string; message?: string }
          if (!j.ok) throw new Error(j.message ?? '函数文件读取失败')
          text = String(j.content ?? '')
        }
        const raw = JSON.parse(text) as FnAsset
        if (alive) setState({ status: 'ready', asset: functionIR(raw, fnNameOf(path)), message: '' })
      } catch (err) {
        if (alive) setState({ status: 'error', asset: null, message: err instanceof Error ? err.message : String(err) })
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [path, project?.path])

  const save = (ir: IRAsset): void => {
    const scope: 'global' | 'project' = isLibraryFunctionPath(path) ? 'global' : 'project'
    const text = functionTextOf(ir, path, scope)
    const p = isLibraryFunctionPath(path)
      ? fetch('/api/library/write', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'functions', name: fnNameOf(path), content: text }),
        })
      : project
        ? fetch('/api/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: `${project.path}/${path}`, content: text }),
          })
        : Promise.resolve(null)
    void p
      .then((r) => (r ? r.json() : null))
      .then((j: { ok?: boolean; message?: string } | null) => {
        if (j && j.ok === false) console.error('[函数保存失败]', j.message)
      })
      .catch((err: unknown) => console.error('[函数保存失败]', err))
  }

  if (state.status === 'loading') return <div className="workspace-tab-loading">加载中…</div>
  if (state.status === 'error' || !state.asset) {
    return <div className="workspace-tab-loading workspace-tab-error">{state.message || '函数加载失败'}</div>
  }
  return (
    <BlueprintEditorPanel
      asset={state.asset}
      assetPath={path}
      onSave={(ir) => save(ir)}
      className="workspace-bp-panel"
      key={panelId}
    />
  )
}
