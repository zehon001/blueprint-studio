/**
 * 本地 .env 加载（零依赖）：服务启动时读取仓库根 .env（KEY=VALUE，# 注释），
 * 仅对未设置的环境变量生效（真实环境变量优先）。.env 已在 .gitignore 中，用于
 * 存放 BP_DSH_URL / BP_DSH_TOKEN 等本地配置（可选；默认 127.0.0.1:49301 与
 * profile cordis.patch.yml 的插件 apiToken）。
 */
import fs from 'node:fs'
import path from 'node:path'

export function loadDotEnv(file: string = path.join(process.cwd(), '.env')): void {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}
