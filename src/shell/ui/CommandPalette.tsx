/**
 * 命令面板（UI-REDESIGN P2 · cmdk）
 *
 * Ctrl/Cmd+K 呼出：居中 560px 浮层，分组展示
 *   刚使用 / 节点 / 文件 / 命令
 * 节点项复用蓝图现有 addNode 流程（与 NodeSearchMenu 同一 store 动作，位置取当前图中心）；
 * 文件项打开 dock 中已打开的资产；命令项只读调用现有 keymap / dock / runtime 入口。
 *
 * 行为：cmdk 负责过滤与 ↑↓ Enter；Esc / 点遮罩关闭。
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Command } from 'cmdk'
import { create } from 'zustand'
import {
  Boxes,
  FilePlus2,
  LayoutDashboard,
  Play,
  PlayCircle,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Settings,
  Undo2,
} from 'lucide-react'
import { getBindings } from '@/shell/keymap/registry'
import { undo, redo } from '@/shell/commands'
import { launchRuntimeCurrent, launchRuntimeMain } from '@/shell/runtime-launch'
import { usePanels } from '@/shell/dock/registry'
import { useDockStore } from '@/shell/dock/store'
import { findTabsByPanel, type DockNode } from '@/shell/dock/tree'
import {
  assetPanelTitle,
  openAssetPanel,
  parseAssetPanelId,
  requestClosePanel,
  type AssetPanelKind,
} from '@/shell/dock/assetPanelModel'
import { openSettings } from '@/shell/settings'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { Icon } from './Icon'
import { assetIconFor, nodeCategoryColor, nodeCategoryIcon } from './icons'
import './ui.css'
import './command-palette.css'

interface PaletteState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useCommandPalette = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** 打开命令面板（keymap / 顶栏按钮共用） */
export function openCommandPalette(): void {
  useCommandPalette.getState().setOpen(true)
}

/** 关闭命令面板 */
export function closeCommandPalette(): void {
  useCommandPalette.getState().setOpen(false)
}

interface OpenAsset {
  kind: AssetPanelKind
  path: string
}

/** 收集 dock 树中已打开的资产面板 */
function collectOpenAssets(root: DockNode | null): OpenAsset[] {
  const out: OpenAsset[] = []
  const walk = (node: DockNode): void => {
    if (node.kind === 'tabs') {
      for (const panelId of node.panels) {
        const ref = parseAssetPanelId(panelId)
        if (ref) out.push({ kind: ref.kind, path: ref.path })
      }
      return
    }
    for (const child of node.children) walk(child)
  }
  if (root) walk(root)
  return out
}

/** 当前蓝图图中心（新增节点落点；空图回退原点） */
function currentGraphCenter(): { x: number; y: number } {
  const st = useBlueprintStore.getState()
  const graph = st.asset?.graphs[st.graphName]
  const nodes = graph?.nodes ?? []
  if (nodes.length === 0) return { x: 0, y: 0 }
  let sx = 0
  let sy = 0
  for (const n of nodes) {
    sx += n.position.x
    sy += n.position.y
  }
  return { x: Math.round(sx / nodes.length) + 40, y: Math.round(sy / nodes.length) + 40 }
}

/** 节点项：直接走蓝图 store.addNode（命令栈可撤销） */
function addNodeFromPalette(specId: string): void {
  const st = useBlueprintStore.getState()
  if (!st.asset) return
  st.addNode(specId, currentGraphCenter())
}

interface PaletteEntry {
  id: string
  label: string
  hint?: string
  value: string
  icon: ReactNode
  onSelect: () => void
}

export function CommandPalette() {
  const open = useCommandPalette((s) => s.open)
  const setOpen = useCommandPalette((s) => s.setOpen)
  const panels = usePanels()
  const root = useDockStore((s) => s.root)
  const blueprintAsset = useBlueprintStore((s) => s.asset)
  const specs = useBlueprintStore((s) => s.specs)
  const recentSpecIds = useBlueprintStore((s) => s.recentSpecIds)
  const graphName = useBlueprintStore((s) => s.graphName)

  // 打开时锁定背景滚动；Esc 关闭
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const openAssets = useMemo(() => collectOpenAssets(root), [root])

  const recentNodes = useMemo(() => {
    if (!blueprintAsset) return []
    return recentSpecIds
      .map((id) => specs.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .slice(0, 4)
  }, [blueprintAsset, recentSpecIds, specs])

  const commandEntries: PaletteEntry[] = useMemo(
    () => [
      {
        id: 'cmd.run.main',
        label: '运行（主 UI）',
        hint: 'F5',
        value: '运行 主 UI run main F5',
        icon: <Icon icon={Play} size={14} />,
        onSelect: () => launchRuntimeMain(),
      },
      {
        id: 'cmd.run.current',
        label: '运行当前',
        hint: 'F6',
        value: '运行 当前 run current F6',
        icon: <Icon icon={PlayCircle} size={14} />,
        onSelect: () => launchRuntimeCurrent(),
      },
      {
        id: 'cmd.save',
        label: '保存',
        hint: 'Ctrl+S',
        value: '保存 save Ctrl+S',
        icon: <Icon icon={Save} size={14} />,
        onSelect: () => getBindings('file.save')[0]?.handler(),
      },
      {
        id: 'cmd.undo',
        label: '撤销',
        hint: 'Ctrl+Z',
        value: '撤销 undo Ctrl+Z',
        icon: <Icon icon={Undo2} size={14} />,
        onSelect: () => undo(),
      },
      {
        id: 'cmd.redo',
        label: '重做',
        hint: 'Ctrl+Shift+Z',
        value: '重做 redo Ctrl+Shift+Z',
        icon: <Icon icon={Redo2} size={14} />,
        onSelect: () => redo(),
      },
      {
        id: 'cmd.reset-layout',
        label: '重置布局',
        value: '重置 布局 reset layout',
        icon: <Icon icon={RotateCcw} size={14} />,
        onSelect: () => useDockStore.getState().resetLayout(),
      },
      {
        id: 'cmd.settings',
        label: '设置',
        hint: 'Ctrl+,',
        value: '设置 settings preferences Ctrl+,',
        icon: <Icon icon={Settings} size={14} />,
        onSelect: () => openSettings(),
      },
      ...panels.map((p): PaletteEntry => {
        const isOpen = findTabsByPanel(useDockStore.getState().root, p.id) !== null
        return {
          id: `cmd.panel.${p.id}`,
          label: `${isOpen ? '关闭' : '打开'}面板：${p.title}`,
          value: `面板 panel ${p.title} ${isOpen ? '关闭' : '打开'}`,
          icon: <Icon icon={LayoutDashboard} size={14} />,
          onSelect: () => {
            if (isOpen) requestClosePanel(p.id)
            else useDockStore.getState().openPanel(p.id, p.defaultArea)
          },
        }
      }),
    ],
    [panels, root],
  )

  if (!open) return null

  const hasNodes = blueprintAsset !== null
  const graphLabel = graphName

  return createPortal(
    <div
      className="cmdk-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      <Command
        className="cmdk"
        label="命令面板"
        loop
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
          }
        }}
      >
        <div className="cmdk-search">
          <Icon icon={Search} size={15} />
          <Command.Input className="cmdk-input" placeholder="搜索节点、文件或命令…" autoFocus />
          <kbd className="cmdk-esc">Esc</kbd>
        </div>
        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">没有匹配结果</Command.Empty>

          {recentNodes.length > 0 ? (
            <Command.Group heading="刚使用" className="cmdk-group">
              {recentNodes.map((spec) => (
                <Command.Item
                  key={`recent:${spec.id}`}
                  className="cmdk-item"
                  value={`最近 ${spec.title} ${spec.id} ${spec.keywords?.join(' ') ?? ''}`}
                  onSelect={() => {
                    addNodeFromPalette(spec.id)
                    setOpen(false)
                  }}
                >
                  <span className="cmdk-item-icon" style={{ color: nodeCategoryColor(spec.category) }}>
                    <Icon icon={nodeCategoryIcon(spec.category)} size={14} />
                  </span>
                  <span className="cmdk-item-label">{spec.title}</span>
                  <span className="cmdk-item-hint">节点</span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {hasNodes ? (
            <Command.Group heading={`节点 · ${graphLabel}`} className="cmdk-group">
              {[...specs.values()].map((spec) => (
                <Command.Item
                  key={`node:${spec.id}`}
                  className="cmdk-item"
                  value={`节点 ${spec.title} ${spec.id} ${spec.category} ${spec.keywords?.join(' ') ?? ''}`}
                  onSelect={() => {
                    addNodeFromPalette(spec.id)
                    setOpen(false)
                  }}
                >
                  <span className="cmdk-item-icon" style={{ color: nodeCategoryColor(spec.category) }}>
                    <Icon icon={nodeCategoryIcon(spec.category)} size={14} />
                  </span>
                  <span className="cmdk-item-label">{spec.title}</span>
                  <span className="cmdk-item-hint">{spec.category}</span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {openAssets.length > 0 ? (
            <Command.Group heading="文件" className="cmdk-group">
              {openAssets.map((asset) => {
                const spec = assetIconFor(asset.kind)
                const label = assetPanelTitle(asset.kind, asset.path)
                return (
                  <Command.Item
                    key={`file:${asset.kind}:${asset.path}`}
                    className="cmdk-item"
                    value={`文件 ${label} ${asset.path}`}
                    onSelect={() => {
                      openAssetPanel(asset.kind, asset.path)
                      setOpen(false)
                    }}
                  >
                    <span className="cmdk-item-icon" style={{ color: spec.color }}>
                      <Icon icon={spec.icon} size={14} />
                    </span>
                    <span className="cmdk-item-label">{label}</span>
                    <span className="cmdk-item-hint">{asset.path}</span>
                  </Command.Item>
                )
              })}
            </Command.Group>
          ) : null}

          <Command.Group heading="命令" className="cmdk-group">
            {commandEntries.map((entry) => (
              <Command.Item
                key={entry.id}
                className="cmdk-item"
                value={entry.value}
                onSelect={() => {
                  entry.onSelect()
                  setOpen(false)
                }}
              >
                <span className="cmdk-item-icon">{entry.icon}</span>
                <span className="cmdk-item-label">{entry.label}</span>
                {entry.hint ? <kbd className="cmdk-item-hint">{entry.hint}</kbd> : null}
              </Command.Item>
            ))}
          </Command.Group>

          {!hasNodes ? (
            <div className="cmdk-footnote">
              <Icon icon={Boxes} size={13} /> 打开蓝图后可直接在此搜索并添加节点
              <Icon icon={FilePlus2} size={13} />
            </div>
          ) : null}
        </Command.List>
      </Command>
    </div>,
    document.body,
  )
}
