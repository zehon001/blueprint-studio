import type { WidgetKind } from '../types'

export type LogEntry = {
  id: string
  time: string
  text: string
  tag: string
  color: string
  mergeKey: string
  count: number
  /** 合并前的原始行（展开时显示） */
  lines: string[]
}

export type LogRound = { id: string; label: string; entries: LogEntry[] }
export type LogSession = { id: string; label: string; rounds: LogRound[] }

export type LogTreeState = {
  seq: number
  sessions: LogSession[]
  currentSessionId: string | null
  currentRoundId: string | null
}

export type MarkdownState = { content: string }

export type FlowState = {
  nodes: { id: string; label: string }[]
  edges: { from: string; to: string }[]
  activeId: string | null
}

export type AnyWidgetState = LogTreeState | MarkdownState | FlowState

export function initialWidgetState(kind: WidgetKind): AnyWidgetState {
  switch (kind) {
    case 'logTree':
      return { seq: 0, sessions: [], currentSessionId: null, currentRoundId: null }
    case 'markdown':
      return { content: '' }
    case 'flow':
      return { nodes: [], edges: [], activeId: null }
  }
}

export function reduceWidget(
  kind: WidgetKind,
  state: AnyWidgetState,
  op: string,
  payload: Record<string, unknown>,
): AnyWidgetState {
  if (kind === 'logTree') return reduceLogTree(state as LogTreeState, op, payload)
  if (kind === 'markdown') {
    const md = state as MarkdownState
    if (op === 'set') return { content: String(payload.content ?? '') }
    if (op === 'clear') return { content: '' }
    return md
  }
  // flow
  const flow = state as FlowState
  switch (op) {
    case 'addNode': {
      const id = String(payload.id ?? '')
      if (!id || flow.nodes.some((n) => n.id === id)) return flow
      return { ...flow, nodes: [...flow.nodes, { id, label: String(payload.label ?? id) }] }
    }
    case 'addEdge': {
      const from = String(payload.from ?? '')
      const to = String(payload.to ?? '')
      if (!from || !to) return flow
      return { ...flow, edges: [...flow.edges, { from, to }] }
    }
    case 'setActive':
      return { ...flow, activeId: String(payload.id ?? '') || null }
    case 'clear':
      return { nodes: [], edges: [], activeId: null }
    default:
      return flow
  }
}

function reduceLogTree(
  state: LogTreeState,
  op: string,
  payload: Record<string, unknown>,
): LogTreeState {
  const next: LogTreeState = {
    ...state,
    sessions: state.sessions.map((s) => ({
      ...s,
      rounds: s.rounds.map((r) => ({ ...r, entries: [...r.entries] })),
    })),
  }
  const ensureSession = (): LogSession => {
    if (next.currentSessionId) {
      const found = next.sessions.find((s) => s.id === next.currentSessionId)
      if (found) return found
    }
    const created: LogSession = {
      id: `s${++next.seq}`,
      label: `会话 ${next.seq}`,
      rounds: [],
    }
    next.sessions.push(created)
    next.currentSessionId = created.id
    next.currentRoundId = null
    return created
  }
  const ensureRound = (): LogRound => {
    const session = ensureSession()
    if (next.currentRoundId) {
      const found = session.rounds.find((r) => r.id === next.currentRoundId)
      if (found) return found
    }
    const created: LogRound = {
      id: `r${++next.seq}`,
      label: `第 ${session.rounds.length + 1} 轮`,
      entries: [],
    }
    session.rounds.push(created)
    next.currentRoundId = created.id
    return created
  }

  switch (op) {
    case 'session': {
      const created: LogSession = {
        id: `s${++next.seq}`,
        label: String(payload.label ?? '') || `会话 ${next.seq}`,
        rounds: [],
      }
      next.sessions.push(created)
      next.currentSessionId = created.id
      next.currentRoundId = null
      return next
    }
    case 'round': {
      const session = ensureSession()
      const created: LogRound = {
        id: `r${++next.seq}`,
        label: String(payload.label ?? '') || `第 ${session.rounds.length + 1} 轮`,
        entries: [],
      }
      session.rounds.push(created)
      next.currentRoundId = created.id
      return next
    }
    case 'entry': {
      const round = ensureRound()
      const text = String(payload.text ?? '')
      const mergeKey = String(payload.mergeKey ?? '')
      const last = round.entries[round.entries.length - 1]
      if (mergeKey && last && last.mergeKey === mergeKey) {
        last.count++
        last.lines.push(text)
      } else {
        round.entries.push({
          id: `e${++next.seq}`,
          time: String(payload.time ?? ''),
          text,
          tag: String(payload.tag ?? ''),
          color: String(payload.color ?? ''),
          mergeKey,
          count: 1,
          lines: [text],
        })
      }
      return next
    }
    case 'clear':
      return { seq: 0, sessions: [], currentSessionId: null, currentRoundId: null }
    default:
      return state
  }
}
