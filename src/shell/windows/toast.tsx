/**
 * 轻量 toast（T0.4 · 拆出失败 / 弹窗失联等提示）
 *
 * 模块级事件源 + ToastHost 组件订阅（useSyncExternalStore）；
 * 不依赖 DOM 环境（node:test 可直接断言条目列表）。
 */
import { useSyncExternalStore } from 'react'

export interface ToastItem {
  id: number
  message: string
}

const DEFAULT_DURATION_MS = 3200
const MAX_VISIBLE = 4

let seq = 0
const items: ToastItem[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 弹出提示（auto 自动消失；无计时器环境（极端）仅入列不自动清除） */
export function showToast(message: string, durationMs = DEFAULT_DURATION_MS): void {
  seq += 1
  items.push({ id: seq, message })
  if (items.length > MAX_VISIBLE) items.splice(0, items.length - MAX_VISIBLE)
  emit()
  if (typeof setTimeout === 'function') {
    const id = seq
    setTimeout(() => {
      const idx = items.findIndex((t) => t.id === id)
      if (idx >= 0) {
        items.splice(idx, 1)
        emit()
      }
    }, durationMs)
  }
}

/** 订阅（ToastHost 用；返回解绑函数） */
export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 快照版本号：items 数组原地变更，React 以版本号驱动重渲染 */
export function getToastVersion(): number {
  return seq
}

/** 当前条目（只读；ToastHost 渲染用） */
export function getToastItems(): readonly ToastItem[] {
  return items
}

/** 提示容器（主窗 DockShell 与弹窗 PopoutApp 各挂一个） */
export function ToastHost() {
  useSyncExternalStore(subscribeToasts, getToastVersion)
  return (
    <div className="bps-toast-stack" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="bps-toast">
          {t.message}
        </div>
      ))}
    </div>
  )
}
