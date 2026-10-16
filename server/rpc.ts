import fs from 'node:fs'
import path from 'node:path'
import { uploadsDir } from './assets'

/**
 * 后端 RPC：报表数据（RDS mock）与飞书推送。
 * 真实接入点：
 * - report.getStats 换成调用 RDS 埋点平台 API
 * - feishu.pushDoc 配置 FEISHU_WEBHOOK 环境变量后走 webhook，否则生成本地文件存根
 */

export async function rpcDispatch(method: string, args: unknown): Promise<unknown> {
  if (method === 'report.getStats') return getStats(args as { dateRange?: string })
  if (method === 'feishu.pushDoc') return pushDoc(args as { title?: string; md?: string })
  throw new Error(`未知 RPC: ${method}`)
}

function getStats(args: { dateRange?: string }) {
  const dateRange = args?.dateRange || '昨天'
  return {
    dateRange,
    crashFreeRate: '99.72%',
    affectedSessions: 1284,
    totalEvents: 358,
    topErrors: [
      {
        name: 'NullPointerException @ com.dolphin.audio.Mixer.init',
        count: 187,
        rate: '52.4%',
        lastSeen: '10-16 09:41',
      },
      { name: 'TimeoutException @ retrofit2.Api.execute', count: 92, rate: '25.7%', lastSeen: '10-16 09:12' },
      { name: 'SQLiteFullException @ db.session.Store', count: 41, rate: '11.5%', lastSeen: '10-15 22:03' },
      { name: 'UnsatisfiedLinkError @ native.mixer', count: 23, rate: '6.4%', lastSeen: '10-15 18:47' },
      { name: 'ANR in com.dolphin.round', count: 15, rate: '4.2%', lastSeen: '10-14 21:30' },
    ],
  }
}

async function pushDoc(args: { title?: string; md?: string }) {
  const title = String(args?.title ?? '报表')
  const md = String(args?.md ?? '')
  const webhook = process.env.FEISHU_WEBHOOK
  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: `【${title}】\n${md.slice(0, 3000)}` } }),
      })
      if (res.ok) return { ok: true, detail: `已推送飞书：${title}` }
      return { ok: false, detail: `飞书 webhook 返回 ${res.status}` }
    } catch (err) {
      return { ok: false, detail: `飞书 webhook 调用失败：${String(err)}` }
    }
  }
  // 存根：写入资产目录，可在「资产」面板查看产物
  fs.mkdirSync(uploadsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = `报表-${title}-${stamp}.md`
  fs.writeFileSync(path.join(uploadsDir, file), md, 'utf8')
  return {
    ok: true,
    detail: `已生成报表文件「${file}」（未配置 FEISHU_WEBHOOK，走本地存根；文件已入资产库）`,
  }
}
