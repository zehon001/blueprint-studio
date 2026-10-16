import { useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useAppStore } from './appStore'
import { useGraphStore } from './store'
import { Home } from './components/Home'
import { Toolbar } from './components/Toolbar'
import { Palette } from './components/Palette'
import { Canvas } from './components/Canvas'
import { Inspector } from './components/Inspector'
import { VarPanel } from './components/VarPanel'
import { AssetPanel } from './components/AssetPanel'
import { ConsolePanel } from './components/ConsolePanel'
import { ScriptView } from './components/ScriptView'
import { RuntimeView } from './widgets/RuntimeView'

const TABS = [
  { key: 'inspector', label: '属性' },
  { key: 'vars', label: '变量' },
  { key: 'assets', label: '资产' },
  { key: 'console', label: '控制台' },
] as const

type TabKey = (typeof TABS)[number]['key']

function Editor() {
  const [tab, setTab] = useState<TabKey>('inspector')
  return (
    <div className="app">
      <ReactFlowProvider>
        <Toolbar />
        <div className="app-body">
          <Palette />
          <div className="canvas-stack">
            <Canvas />
            <ScriptView />
          </div>
          <aside className="side">
            <div className="side-tabs">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  className={`side-tab${tab === t.key ? ' active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="side-panel">
              {tab === 'inspector' && <Inspector />}
              {tab === 'vars' && <VarPanel />}
              {tab === 'assets' && <AssetPanel />}
              {tab === 'console' && <ConsolePanel />}
            </div>
          </aside>
        </div>
        <RuntimeView />
      </ReactFlowProvider>
    </div>
  )
}

export default function App() {
  const screen = useAppStore((s) => s.screen)
  const bootstrap = useAppStore((s) => s.bootstrap)

  useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  // 编辑器视图需要已绑定的插件；未绑定时回退到首页
  const bound = useGraphStore((s) => s.bound)
  if (screen === 'editor' && bound) return <Editor />
  return <Home />
}
