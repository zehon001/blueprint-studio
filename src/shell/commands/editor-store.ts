/**
 * 编辑器全局 store（zustand）—— 统一命令栈的状态载体（T0.5 · PLAN §3.2 / §6.3）
 *
 * 设计：单 store 持有各命令域的状态切片 + 全局统一 undo/redo 栈
 * （Godot 习惯：跨域命令按时间序统一入栈，而非每域独立栈）。
 * 各业务域（蓝图 / UI 树 / 检视器 / 文件系统）通过 registerDomainState 挂载状态；
 * 域状态只允许经命令栈 API（runCommand / undo / redo）变更，保证补丁可重放。
 *
 * 注： immer 的 patches 能力需显式开启（enablePatches，幂等），此处手工接入
 * produceWithPatches / applyPatches，不引入 immer 中间件依赖。
 */
import { create } from 'zustand'
import { enablePatches } from 'immer'
import type { CommandDomain, CommandEntry, ReplayNotice } from './types'

enablePatches()

export interface EditorShellState {
  /** 已挂载的域状态切片（键 = 命令域；未挂载的域执行命令会报错） */
  domains: Partial<Record<CommandDomain, unknown>>
  /** 统一撤销栈（时间序，跨域混排） */
  undoStack: CommandEntry[]
  /** 统一重做栈（新命令入栈时清空） */
  redoStack: CommandEntry[]
  /** 最近一次 undo/redo 的重放报告（React 侧可订阅；runCommand 不写此字段） */
  lastReplay: ReplayNotice | null
}

export const useEditorStore = create<EditorShellState>()(() => ({
  domains: {},
  undoStack: [],
  redoStack: [],
  lastReplay: null,
}))
