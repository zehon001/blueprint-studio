import { useRef } from 'react'
import { useAppStore } from '../appStore'

const EXT_ICONS: Record<string, string> = {
  md: '📝',
  log: '📄',
  txt: '📄',
  json: '🧾',
  csv: '📊',
  png: '🖼️',
  jpg: '🖼️',
  jpeg: '🖼️',
  gif: '🖼️',
  svg: '🖼️',
}

function humanSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function AssetPanel() {
  const assets = useAppStore((s) => s.assets)
  const refreshAssets = useAppStore((s) => s.refreshAssets)
  const uploadAsset = useAppStore((s) => s.uploadAsset)
  const log = useAppStore((s) => s.log)
  const fileRef = useRef<HTMLInputElement>(null)

  const onPick = async (file: File) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result)
        resolve(result.slice(result.indexOf(',') + 1))
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    const res = await uploadAsset(file.name, base64)
    log(res.ok ? 'system' : 'error', res.message)
  }

  return (
    <div className="assetpanel">
      <div className="asset-actions">
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onPick(f)
            e.target.value = ''
          }}
        />
        <button className="btn" onClick={() => fileRef.current?.click()}>
          ⬆ 上传资产
        </button>
        <button className="btn" onClick={() => void refreshAssets()}>
          ↻ 刷新清单
        </button>
      </div>
      <div className="asset-hint">资产存放在后端静态目录，通过清单序列化显示；日志文件可被「日志文件」节点引用。</div>
      <div className="asset-list">
        {assets.length === 0 && <div className="inspector-empty">资产库为空</div>}
        {assets.map((a) => (
          <div className="asset-row" key={a.name}>
            <span className="asset-icon">{EXT_ICONS[a.ext] ?? '📦'}</span>
            <div className="asset-meta">
              <div className="asset-name">{a.name}</div>
              <div className="asset-sub">
                {a.ext || 'file'} · {humanSize(a.size)} ·{' '}
                {new Date(a.updatedAt).toLocaleString('zh-CN', { hour12: false })}
              </div>
            </div>
            <a className="btn" href={`/assets/uploads/${encodeURIComponent(a.name)}`} target="_blank" rel="noreferrer">
              查看
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}
