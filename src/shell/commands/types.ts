/**
 * 统一命令栈 —— 类型契约（T0.5 · PLAN §6.3 命令栈设计 / §3.2 技术栈）
 *
 * 术语遵守 PLAN §2：UI 节点树域定名 scene-tree（UI 树，不叫场景）；
 * 信号一律叫「事件」。四个命令域覆盖 PLAN §6.3 的撤销重做范围。
 */
import type { Draft, Patch } from 'immer'

/** 命令域：undo/redo 按条目携带的域路由重放补丁，面板按域订阅刷新 */
export type CommandDomain = 'blueprint' | 'scene-tree' | 'inspector' | 'filesystem'

/** 命令域中文展示名（历史面板 / 状态栏 / 快捷键设置分组用） */
export const COMMAND_DOMAIN_LABELS: Record<CommandDomain, string> = {
  blueprint: '蓝图',
  'scene-tree': 'UI 树',
  inspector: '检视器',
  filesystem: '文件系统',
}

/**
 * 命令定义（PLAN §6.3 契约：命令 = { label, do, undo(immer patch), domain }）
 * 本实现以 immer recipe（apply 直接改 draft）描述变更；执行时经
 * produceWithPatches 生成 patches / inversePatches 入栈，undo 重放
 * inversePatches、redo 重放 patches，无需命令自带 undo 函数。
 */
export interface Command<S = unknown> {
  /** 命令名（撤销/重做菜单展示，如「添加节点」） */
  label: string
  /** 所属命令域 */
  domain: CommandDomain
  /** 变更配方：直接修改 draft（immer recipe，Draft 为可写草稿视图） */
  apply: (draft: Draft<S>) => void
  /** 可选：生成历史补充说明（命令执行后以变更后状态求值，存入条目 detail） */
  describe?: (stateAfter: S) => string
}

/** 一条已入栈的历史命令（含重放所需的正/逆补丁） */
export interface CommandEntry {
  label: string
  domain: CommandDomain
  /** 正向补丁（redo 重放用） */
  patches: Patch[]
  /** 逆补丁（undo 重放用） */
  inversePatches: Patch[]
  /** describe 求值结果（可选，历史面板展示） */
  detail?: string
}

/** 历史条目摘要（getHistory / peekUndo / peekRedo 返回） */
export interface HistoryMeta {
  label: string
  domain: CommandDomain
  detail?: string
}

/** undo/redo 重放报告：domains 为本次重放影响的命令域列表（刷新对应面板用） */
export interface ReplayNotice {
  op: 'undo' | 'redo'
  /** 受影响命令域（当前每条命令单域，数组为将来的组合命令预留） */
  domains: CommandDomain[]
  /** 被撤销/重做的命令 label */
  label: string
}

/** runCommand 结果：changed=false 表示配方未产生任何变更（不入栈） */
export interface RunCommandResult {
  domain: CommandDomain
  changed: boolean
}
