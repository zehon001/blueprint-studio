import { useEffect, useState } from 'react'
import { useAppStore } from '../appStore'
import { TEMPLATES, type TemplateId } from '../templates'

function NewPluginDialog({
  middlewareId,
  onClose,
}: {
  middlewareId: string
  onClose: () => void
}) {
  const createPlugin = useAppStore((s) => s.createPlugin)
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<TemplateId>('logviewer')

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">新建可视化插件</div>
        <label className="home-field">
          插件名称
          <input
            className="bp-input"
            autoFocus
            value={name}
            placeholder="如：日志查看器"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                void createPlugin(middlewareId, name, template)
                onClose()
              }
            }}
          />
        </label>
        <div className="home-field">
          从模板开始
          {TEMPLATES.map((t) => (
            <label key={t.id} className={`template-card${template === t.id ? ' selected' : ''}`}>
              <input
                type="radio"
                name="template"
                checked={template === t.id}
                onChange={() => setTemplate(t.id)}
              />
              <div>
                <div className="template-name">{t.name}</div>
                <div className="template-desc">{t.description}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => {
              void createPlugin(middlewareId, name, template)
              onClose()
            }}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )
}

export function Home() {
  const middlewares = useAppStore((s) => s.middlewares)
  const plugins = useAppStore((s) => s.plugins)
  const addMiddleware = useAppStore((s) => s.addMiddleware)
  const removeMiddleware = useAppStore((s) => s.removeMiddleware)
  const deletePlugin = useAppStore((s) => s.deletePlugin)
  const openPlugin = useAppStore((s) => s.openPlugin)
  const startRuntime = useAppStore((s) => s.startRuntime)
  const wsStatus = useAppStore((s) => s.wsStatus)
  const [selectedMw, setSelectedMw] = useState<string | null>(null)
  const [dialogMw, setDialogMw] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedMw && middlewares.length > 0) setSelectedMw(middlewares[0].id)
  }, [middlewares, selectedMw])

  const current = middlewares.find((m) => m.id === selectedMw) ?? null
  const currentPlugins = current ? plugins.filter((p) => p.middlewareId === current.id) : []

  return (
    <div className="home">
      <header className="home-header">
        <span className="brand">
          <span className="brand-bolt">⚡</span> Blueprint Studio
        </span>
        <span className="home-sub">可视化插件引擎 · 用蓝图定制中间件的观测与报表</span>
        <span className={`badge ${wsStatus === 'online' ? 'running' : 'stopped'}`}>
          {wsStatus === 'online' ? '后端在线' : '后端离线'}
        </span>
      </header>
      <div className="home-body">
        <aside className="home-mws">
          <div className="panel-title">中间件</div>
          {middlewares.map((m) => (
            <div
              key={m.id}
              className={`home-mw${selectedMw === m.id ? ' selected' : ''}`}
              onClick={() => setSelectedMw(m.id)}
            >
              <span className="home-mw-dot" />
              <span className="home-mw-name">{m.name}</span>
              <span className="lt-meta">{plugins.filter((p) => p.middlewareId === m.id).length}</span>
              <button
                className="btn danger-ghost small"
                title="删除中间件及其插件"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm(`删除中间件「${m.name}」及其全部插件？`)) {
                    void removeMiddleware(m.id)
                  }
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn home-add-mw"
            onClick={() => {
              const name = window.prompt('中间件名称：')
              if (name) void addMiddleware(name)
            }}
          >
            ＋ 添加中间件
          </button>
        </aside>
        <main className="home-plugins">
          {!current ? (
            <div className="home-empty">先添加一个中间件（如 Dolphin、Flash…）</div>
          ) : (
            <>
              <div className="home-plugins-head">
                <span>{current.name} · 可视化插件</span>
                <button className="btn primary" onClick={() => setDialogMw(current.id)}>
                  ＋ 新建插件
                </button>
              </div>
              <div className="home-plugin-grid">
                {currentPlugins.length === 0 && (
                  <div className="home-empty">还没有插件，从模板创建一个吧</div>
                )}
                {currentPlugins.map((p) => (
                  <div className="home-plugin" key={p.id}>
                    <div className="home-plugin-name">{p.name}</div>
                    <div className="home-plugin-sub">
                      {p.graph.nodes.length} 节点 · {p.vars.length} 变量 ·{' '}
                      {new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                    <div className="home-plugin-actions">
                      <button className="btn primary" onClick={() => openPlugin(p.id)}>
                        ✎ 编辑
                      </button>
                      <button
                        className="btn run"
                        onClick={() => {
                          openPlugin(p.id)
                          window.setTimeout(() => startRuntime(), 100)
                        }}
                      >
                        ▶ 运行
                      </button>
                      <button
                        className="btn danger-ghost"
                        onClick={() => {
                          if (window.confirm(`删除插件「${p.name}」？`)) void deletePlugin(p.id)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      </div>
      {dialogMw && <NewPluginDialog middlewareId={dialogMw} onClose={() => setDialogMw(null)} />}
    </div>
  )
}
