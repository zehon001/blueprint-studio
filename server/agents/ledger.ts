/**
 * Agent 会话台账（服务端本地持久化）
 *
 * dsh-plugin-orchestrator 的 REST API 不暴露会话归档状态（工作区列表 / 全量列表 /
 * 会话状态都包含已归档会话，prompt 也照常受理）——复用搜索无法从宿主侧识别归档。
 * 因此「删除 Agent 会话」归档时在本地台账登记 sessionId；创建会话的复用搜索
 * 跳出台账中的已归档会话。
 *
 * 存储：~/.blueprint-studio/agent-session-ledger.json（{ archived: string[] }）。
 * 局限：在 DSH 界面内直接归档的会话无法被识别（编排接口无信号），doc 已注明。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LEDGER_DIR = path.join(os.homedir(), '.blueprint-studio')
const LEDGER_FILE = path.join(LEDGER_DIR, 'agent-session-ledger.json')

function load(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) as { archived?: unknown }
    // 不做进程内缓存：台账可能被多个进程（server / CLI 工具）写入，每次读盘保证一致
    return new Set(
      Array.isArray(raw.archived) ? raw.archived.filter((v): v is string => typeof v === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

function save(set: Set<string>): void {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true })
    fs.writeFileSync(LEDGER_FILE, JSON.stringify({ archived: [...set], updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch {
    /* 持久化失败不阻塞主流程（进程内仍生效） */
  }
}

/** 会话是否已在本应用内归档过 */
export function isSessionArchived(sessionId: string): boolean {
  return load().has(sessionId)
}

/** 全部已归档会话 id（复用搜索跳过用） */
export function getArchivedSessionIds(): string[] {
  return [...load()]
}

/** 归档登记（删除 Agent 会话成功后调用；幂等 + 持久化） */
export function markSessionArchived(sessionId: string): void {
  const set = load()
  set.add(sessionId)
  save(set)
}
