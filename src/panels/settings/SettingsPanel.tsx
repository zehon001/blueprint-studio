/**
 * 设置面板（T7.1 · PLAN §15「快捷键：对齐 Godot/UE 习惯，设置内可查可改，冲突检测」）
 *
 * 快捷键区块：
 *  - 数据源：keymap registry 的 listShortcuts()（每次渲染拉取；改键 / 恢复默认后
 *    经版本计数器触发重渲染——注册表无订阅通道，条目量小，拉取即够）；
 *  - 分组展示：id 前缀 → 中文分类（文件 / 编辑 / 运行 / 设置 / 其它），组内按注册序；
 *  - 改键：行内「修改」进入监听态，window 捕获阶段（capture）收 keydown——
 *    捕获先于全局派发（attachKeyboard 挂在 bubble），stopPropagation 防止改键
 *    过程误触发撤销 / 保存 / F5 等；纯修饰键继续等待，Esc 取消（Esc 不可绑）；
 *  - 校验链：isBindableCombo（防劫持文本录入）→ checkConflicts（复用 registry
 *    冲突检测，含上下文键占位保护）→ 任一不过红色提示且拒绝保存（不落盘）；
 *  - 通过项经 rebindAndPersist 写注册表 + localStorage（bps.keymap.v1）；
 *    「恢复默认」经 restoreDefaultsAndPersist 一键清空改键回默认表。
 *
 * 注意：本文件不 import .css（node:test 需直接加载本文件做挂载冒烟）；
 * 样式由 index.ts（注册入口）引入 styles.css，全部引用 theme.css token。
 */
import { useEffect, useState } from 'react'
import {
  comboFromEvent,
  getShortcut,
  listShortcuts,
  type ShortcutGroup,
} from '@/shell/keymap/registry'
import { isBindableCombo, rebindAndPersist, restoreDefaultsAndPersist } from '@/shell/keymap/customize'

/** 分类名映射（id 首段前缀 → 中文分组；未收录前缀归「其它」） */
export const SHORTCUT_GROUP_LABELS: Record<string, string> = {
  file: '文件',
  edit: '编辑',
  run: '运行',
  settings: '设置',
}

/** 分类展示顺序（不在表中的分组排最后，按「其它」合并） */
const GROUP_ORDER = ['文件', '编辑', '运行', '设置', '其它']

/** 快捷键 id → 分类名（设置界面分组展示用，纯函数） */
export function shortcutGroupLabel(id: string): string {
  const dot = id.indexOf('.')
  const prefix = dot > 0 ? id.slice(0, dot) : id
  return SHORTCUT_GROUP_LABELS[prefix] ?? '其它'
}

/** 冲突提示文案（占用者 id 列表 → 命令名列表，红字展示） */
function conflictText(conflicts: string[]): string {
  const labels = conflicts.map((cid) => getShortcut(cid)?.label ?? cid).join('、')
  return `与「${labels}」冲突，已拒绝保存`
}

/** 设置面板（dock 注册组件；id 'settings'） */
export function SettingsPanel() {
  /** 改键后的重渲染触发器（注册表无订阅通道，见文件头说明） */
  const [, setVersion] = useState(0)
  /** 当前监听改键的快捷键 id（null = 无监听态） */
  const [capturingId, setCapturingId] = useState<string | null>(null)
  /** 监听态下的红色错误提示（不可捕获 / 冲突拒绝） */
  const [captureError, setCaptureError] = useState<string | null>(null)

  // 改键捕获：window 捕获阶段收 keydown（先于 attachKeyboard 的 bubble 派发，
  // stopPropagation 保证监听期间全局快捷键不触发、F5 不刷新）
  useEffect(() => {
    if (capturingId === null) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const combo = comboFromEvent(e)
      if (combo === null) return // 纯修饰键按下：继续等待完整组合
      if (combo === 'Escape') {
        // Esc 取消监听（Esc 本身不作为可绑键——取消惯例，见 isBindableCombo）
        setCapturingId(null)
        setCaptureError(null)
        return
      }
      if (!isBindableCombo(combo)) {
        setCaptureError('该组合键不可绑：需含 Ctrl / Alt 修饰，或为 F 功能键 / 导航键（防止劫持文本录入）')
        return
      }
      const r = rebindAndPersist(capturingId, combo)
      if (!r.ok) {
        setCaptureError(conflictText(r.conflicts)) // 冲突：红字提示，保持监听态可重按
        return
      }
      setCapturingId(null)
      setCaptureError(null)
      setVersion((v) => v + 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturingId])

  /** 全表快照分组（注册序 → 分类序） */
  const groups = listShortcuts().reduce<Array<{ label: string; items: ShortcutGroup[] }>>((acc, item) => {
    const label = shortcutGroupLabel(item.id)
    let bucket = acc.find((g) => g.label === label)
    if (!bucket) {
      bucket = { label, items: [] }
      acc.push(bucket)
    }
    bucket.items.push(item)
    return acc
  }, []).sort((a, b) => GROUP_ORDER.indexOf(a.label) - GROUP_ORDER.indexOf(b.label))

  /** 进入监听态（清上一轮错误提示） */
  const startCapture = (id: string): void => {
    setCaptureError(null)
    setCapturingId(id)
  }

  /** 恢复默认：清空自定义改键 + 注册表重建为默认表（含入口级默认项回放） */
  const onRestore = (): void => {
    restoreDefaultsAndPersist()
    setCapturingId(null)
    setCaptureError(null)
    setVersion((v) => v + 1)
  }

  return (
    <div className="bps-settings">
      <div className="bps-settings-toolbar">
        <span className="bps-settings-title">设置</span>
        <span className="bps-settings-hint">
          {capturingId === null ? '快捷键 · 点「修改」后按下新组合键（Esc 取消）' : '正在监听按键…'}
        </span>
        <button
          type="button"
          className="bps-settings-reset"
          onClick={onRestore}
          title="清空全部自定义改键，恢复默认键位表"
        >
          恢复默认
        </button>
      </div>

      <div className="bps-settings-body">
        <div className="bps-settings-section">快捷键</div>
        {groups.map((g) => (
          <div key={g.label}>
            <div className="bps-settings-group-title">{g.label}</div>
            {g.items.map((item) => (
              <div key={item.id}>
                <div className="bps-settings-row">
                  <span className="bps-settings-name" title={item.id}>
                    {item.label}
                  </span>
                  {item.contextual ? (
                    <span
                      className="bps-settings-badge"
                      title="画布上下文键：当前由画布内部处理（自动避开文本编辑区）；改键已保存，编辑上下文接线后生效"
                    >
                      上下文
                    </span>
                  ) : null}
                  <span className="bps-settings-keys">
                    {capturingId === item.id ? (
                      <span className="bps-settings-capturing">按下新组合键…（Esc 取消）</span>
                    ) : (
                      item.bindings.map((k) => (
                        <kbd key={k} className="bps-settings-kbd">
                          {k}
                        </kbd>
                      ))
                    )}
                  </span>
                  <button
                    type="button"
                    className="bps-settings-edit"
                    disabled={capturingId !== null}
                    onClick={() => startCapture(item.id)}
                    title={`修改「${item.label}」的快捷键`}
                  >
                    {capturingId === item.id ? '监听中…' : '修改'}
                  </button>
                </div>
                {capturingId === item.id && captureError ? (
                  <div className="bps-settings-error">{captureError}</div>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        <div className="bps-settings-note">
          改键持久化于本浏览器（bps.keymap.v1），启动时自动加载并做冲突校验；
          「恢复默认」一键还原默认表。画布上下文键的改键在编辑上下文接线后生效。
        </div>
      </div>
    </div>
  )
}
