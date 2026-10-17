/**
 * T6.5 自测 —— 手机日志插件执行器（node:test）
 *
 * 运行：npx tsx --test server/plugins/phone-log.test.ts
 *
 * 覆盖（DoD 逐条，不依赖真机）：
 *  - 双模式取值对齐（清单 options value device/file + 中文 label 兼容；未知模式中文报错）
 *  - 文件模式：3 份乱序样本（logcat -v time + epoch 两种格式混合 + 解析失败行）→
 *    多文件时间稳定归并（时间 → 文件序 → 行序 tie-break 全序确定）+ 包名过滤
 *  - 设备模式：mock adb（.cmd 批处理 + type 样本，经 args.__adbPath 测试钩子）→
 *    dump 解析 / 过滤；adb 不存在 → ok:false 中文提示
 *  - 持续流 phoneLog.onLine：mock adb 输出 3 行后退出 → 3 条 plugin.push + 1 条
 *    plugin.close（stub WS 订阅）；stop 停止；无 adb 报错；订阅归零自动停流
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildLogcatCommand,
  invokePhoneLogNode,
  mergeSortLogEntries,
  normalizePhoneLogMode,
  parseLogFileText,
  type LogEntry,
} from './phone-log'
import { handleInvoke, PluginPushHub, PluginStreamManager } from './executor'
import type { WebSocket } from 'ws'
import type { LogRow } from '../../src/nodes/convert'

/* ============================================================
 * 工具
 * ============================================================ */

/** 建临时目录跑一个用例，结束后清理 */
async function withTemp(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-phonelog-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等待条件成立（超时抛错） */
async function waitFor(cond: () => boolean, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await delay(stepMs)
  }
}

/** stub WS 连接（PluginPushHub 只依赖 readyState / send / EventEmitter 事件） */
class StubWs extends EventEmitter {
  readyState = 1
  sent: Record<string, unknown>[] = []
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  pushes(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === 'plugin.push')
  }
  closes(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === 'plugin.close')
  }
}

/** 断言 rows 顺序（msg 序列；解析失败行 msg 为空 → 用 raw 展示） */
function msgs(rows: LogRow[]): string[] {
  return rows.map((r) => (r.msg === '' ? r.raw : r.msg))
}

/* ============================================================
 * 双模式取值 / 命令构造（纯函数）
 * ============================================================ */

describe('normalizePhoneLogMode（与清单 options value 对齐）', () => {
  test('device/file 与中文 label 均接受；未知 → null', () => {
    assert.equal(normalizePhoneLogMode('device'), 'device')
    assert.equal(normalizePhoneLogMode('file'), 'file')
    assert.equal(normalizePhoneLogMode('手机读取'), 'device')
    assert.equal(normalizePhoneLogMode('文件读取'), 'file')
    assert.equal(normalizePhoneLogMode(' both '), null)
    assert.equal(normalizePhoneLogMode('xyz'), null)
    assert.equal(normalizePhoneLogMode(123), null)
  })
})

describe('buildLogcatCommand', () => {
  test('dump：adb [-s serial] logcat -d -v time；follow 无 -d', () => {
    assert.equal(buildLogcatCommand({ follow: false }), 'adb logcat -d -v time')
    assert.equal(buildLogcatCommand({ follow: true }), 'adb logcat -v time')
    assert.equal(buildLogcatCommand({ serial: 'emulator-5554', follow: false }), 'adb -s "emulator-5554" logcat -d -v time')
  })

  test('adbPath / serial 含空格时引号包裹', () => {
    assert.equal(
      buildLogcatCommand({ adbPath: 'C:\\Program Files\\adb.exe', follow: true }),
      '"C:\\Program Files\\adb.exe" logcat -v time',
    )
    assert.equal(
      buildLogcatCommand({ adbPath: 'C:\\tmp\\mock adb.cmd', serial: 'X 1', follow: false }),
      '"C:\\tmp\\mock adb.cmd" -s "X 1" logcat -d -v time',
    )
  })
})

/* ============================================================
 * 多文件时间稳定归并（纯函数，含两种格式 + 解析失败行）
 * ============================================================ */

describe('多文件时间稳定归并 mergeSortLogEntries（纯函数）', () => {
  /** 3 份乱序样本：logcat -v time / epoch 两种格式混合 + 解析失败行；时间跨文件交错 */
  function buildSamples(now: Date): LogEntry[] {
    const texts: string[] = [
      // 文件 0：乱序（晚行在前）+ 解析失败行
      [
        '10-17 12:00:03.000 I/F0( 1): f0-late',
        '10-17 12:00:01.000 D/F0( 1): f0-early',
        'garbage in f0',
      ].join('\n'),
      // 文件 1：开头空行（跳过），与文件 0 同时间戳（tie-break 用文件序）
      [
        '',
        '10-17 12:00:01.000 D/F1( 2): f1-same-ts',
        '10-17 12:00:02.000 W/F1( 2): f1-mid',
      ].join('\n'),
      // 文件 2：与文件 1 同时间戳（文件序晚于文件 1）+ epoch 格式
      [
        '10-17 12:00:02.000 W/F2( 3): f2-same-ts',
        '1699999999000 E/F2( 3): f2-epoch',
      ].join('\n'),
    ]
    const entries: LogEntry[] = []
    texts.forEach((text, fi) => entries.push(...parseLogFileText(text, fi, now)))
    return entries
  }

  test('全序确定：时间升序；同时间戳按 文件序 → 行序 tie-break；失败行 ts=0 排最前', () => {
    const now = new Date('2026-01-15T10:00:00')
    const rows = mergeSortLogEntries(buildSamples(now))
    // 期望全序：
    //  1. garbage in f0      —— ts=0（解析失败，保留 raw）最小
    //  2. f2-epoch           —— epoch 1699999999000 = 2023-11-14，早于 2026 年的 time 格式行
    //  3. f0-early           —— 12:00:01.000（文件 0）
    //  4. f1-same-ts         —— 12:00:01.000（时间同 → 文件序：f1 晚于 f0）
    //  5. f1-mid             —— 12:00:02.000（文件 1）
    //  6. f2-same-ts         —— 12:00:02.000（时间同 → 文件序：f2 晚于 f1）
    //  7. f0-late            —— 12:00:03.000
    assert.deepEqual(msgs(rows), [
      'garbage in f0',
      'f2-epoch',
      'f0-early',
      'f1-same-ts',
      'f1-mid',
      'f2-same-ts',
      'f0-late',
    ])
    // ts 非严格递增（tie 存在），且解析失败行字段正确
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].ts <= rows[i].ts, `第 ${i} 行应非降序`)
    assert.equal(rows[0].ts, 0)
    assert.equal(rows[0].raw, 'garbage in f0')
    assert.equal(rows[0].level, '')
    // 两种格式字段解析正确
    const epochRow = rows.find((r) => r.msg === 'f2-epoch')
    assert.equal(epochRow?.level, 'E')
    assert.equal(epochRow?.tag, 'F2')
    assert.equal(epochRow?.pid, 3)
    const timeRow = rows.find((r) => r.msg === 'f0-early')
    assert.equal(timeRow?.level, 'D')
    assert.equal(timeRow?.tag, 'F0')
    assert.equal(timeRow?.pid, 1)
    assert.ok((timeRow?.ts ?? 0) > 0)
  })

  test('输入乱序不影响结果（全序键唯一，排序确定）', () => {
    const now = new Date('2026-01-15T10:00:00')
    const a = mergeSortLogEntries(buildSamples(now))
    const shuffled = buildSamples(now).reverse() // 倒序输入
    const b = mergeSortLogEntries(shuffled)
    assert.deepEqual(msgs(b), msgs(a))
  })
})

/* ============================================================
 * phoneLog.read 文件模式（经 invoke 全链路）
 * ============================================================ */

describe('phoneLog.read 文件模式（invoke 全链路，3 份乱序样本）', () => {
  function writeSamples(dir: string): { files: string[]; root: string } {
    const f0 = ['10-17 12:00:03.000 I/F0( 1): f0-late', '10-17 12:00:01.000 D/F0( 1): f0-early', 'garbage in f0'].join('\n')
    const f1 = ['', '10-17 12:00:01.000 D/F1( 2): f1-same-ts', '10-17 12:00:02.000 W/F1( 2): f1-mid'].join('\n')
    const f2 = ['10-17 12:00:02.000 W/F2( 3): f2-same-ts', '1699999999000 E/F2( 3): f2-epoch'].join('\n')
    const files = [path.join(dir, 'a.log'), path.join(dir, 'b.log'), path.join(dir, 'c.log')]
    fs.writeFileSync(files[0], f0)
    fs.writeFileSync(files[1], f1)
    fs.writeFileSync(files[2], f2)
    return { files, root: fs.mkdtempSync(path.join(os.tmpdir(), 'bps-phonelog-root-')) }
  }

  test('全序 + count（outputs 键 rows/count 与清单输出脚一致）', async () => {
    await withTemp(async (dir) => {
      const { files, root } = writeSamples(dir)
      try {
        const r = await handleInvoke(
          { plugin: 'phone-log', node: 'phoneLog.read', args: { mode: 'file', files } },
          { projectsRoot: root },
        )
        assert.equal(r.status, 200)
        assert.equal(r.payload.ok, true)
        const outputs = r.payload.outputs as { rows: LogRow[]; count: number }
        assert.deepEqual(msgs(outputs.rows), [
          'garbage in f0',
          'f2-epoch',
          'f0-early',
          'f1-same-ts',
          'f1-mid',
          'f2-same-ts',
          'f0-late',
        ])
        assert.equal(outputs.count, 7)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })

  test('中文 label 模式别名（文件读取）+ 包名过滤', async () => {
    await withTemp(async (dir) => {
      const { files, root } = writeSamples(dir)
      try {
        const r = await handleInvoke(
          { plugin: 'phone-log', node: 'phoneLog.read', args: { mode: '文件读取', files, packageFilter: 'F1' } },
          { projectsRoot: root },
        )
        assert.equal(r.payload.ok, true)
        const outputs = r.payload.outputs as { rows: LogRow[]; count: number }
        assert.deepEqual(msgs(outputs.rows), ['f1-same-ts', 'f1-mid'])
        assert.equal(outputs.count, 2)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })

  test('异常路径：缺 files / 文件不存在 / 未知模式（均中文 message）', async () => {
    await withTemp(async (dir) => {
      const { root } = writeSamples(dir)
      try {
        const noFiles = await handleInvoke(
          { plugin: 'phone-log', node: 'phoneLog.read', args: { mode: 'file', files: [] } },
          { projectsRoot: root },
        )
        assert.equal(noFiles.payload.ok, false)
        assert.ok(noFiles.payload.message?.includes('文件'))

        const missing = await handleInvoke(
          { plugin: 'phone-log', node: 'phoneLog.read', args: { mode: 'file', files: [path.join(dir, 'nope.log')] } },
          { projectsRoot: root },
        )
        assert.equal(missing.payload.ok, false)
        assert.ok(missing.payload.message?.includes('日志文件读取失败'))

        const badMode = await handleInvoke(
          { plugin: 'phone-log', node: 'phoneLog.read', args: { mode: 'magic' } },
          { projectsRoot: root },
        )
        assert.equal(badMode.payload.ok, false)
        assert.ok(badMode.payload.message?.includes('未知读取模式'))
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })
})

/* ============================================================
 * phoneLog.read 设备模式（mock adb，经 __adbPath 测试钩子）
 * ============================================================ */

describe('phoneLog.read 设备模式（mock adb）', () => {
  /** 写 mock adb：.cmd 批处理 type 一个固定 dump 样本（batch 无视 logcat 参数） */
  function writeMockAdb(dir: string): { adbPath: string } {
    const dump = [
      '--------- beginning of main',
      '10-17 12:00:01.100 D/Widget( 123): com.example.app started',
      '10-17 12:00:02.200 I/Net( 456): unrelated traffic',
      '1699999999000 W/Pkg( 789): com.example.app heartbeat',
      'broken garbage line',
    ].join('\r\n')
    fs.writeFileSync(path.join(dir, 'mock-dump.txt'), dump, 'utf8')
    const adbPath = path.join(dir, 'mock-adb.cmd')
    fs.writeFileSync(adbPath, ['@echo off', 'type "%~dp0mock-dump.txt"'].join('\r\n'), 'utf8')
    return { adbPath }
  }

  test('dump 解析：解析失败行保留 raw（ts=0）、保持 dump 原生顺序', async () => {
    await withTemp(async (dir) => {
      const { adbPath } = writeMockAdb(dir)
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-phonelog-root-'))
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.read',
          { mode: 'device', __adbPath: adbPath },
          { project: '', streams: new PluginStreamManager(new PluginPushHub()) },
        )
        assert.equal(r.ok, true)
        const outputs = r.outputs as { rows: LogRow[]; count: number }
        assert.equal(outputs.count, 5)
        // dump 原生顺序（不做重排）：失败行原位保留（ts=0）
        assert.equal(outputs.rows[0].ts, 0)
        assert.equal(outputs.rows[0].raw, '--------- beginning of main')
        assert.equal(outputs.rows[1].msg, 'com.example.app started')
        assert.equal(outputs.rows[1].level, 'D')
        assert.equal(outputs.rows[1].pid, 123)
        assert.equal(outputs.rows[3].level, 'W') // epoch 格式行
        assert.equal(outputs.rows[4].ts, 0)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })

  test('packageFilter 启发式过滤（msg/raw 包含包名即保留）', async () => {
    await withTemp(async (dir) => {
      const { adbPath } = writeMockAdb(dir)
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-phonelog-root-'))
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.read',
          { mode: 'device', packageFilter: 'com.example', __adbPath: adbPath },
          { project: '', streams: new PluginStreamManager(new PluginPushHub()) },
        )
        const outputs = r.outputs as { rows: LogRow[]; count: number }
        assert.deepEqual(msgs(outputs.rows), ['com.example.app started', 'com.example.app heartbeat'])
        assert.equal(outputs.count, 2)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })

  test('adb 不存在（不存在的路径）→ ok:false 中文提示', async () => {
    await withTemp(async (dir) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-phonelog-root-'))
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.read',
          { mode: 'device', __adbPath: path.join(dir, 'no-such-adb.exe') },
          { project: '', streams: new PluginStreamManager(new PluginPushHub()) },
        )
        assert.equal(r.ok, false)
        assert.ok(r.message?.includes('adb 未安装或不在 PATH'), `实际 message：${r.message}`)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  })
})

/* ============================================================
 * phoneLog.onLine 持续流（mock adb + stub WS 订阅）
 * ============================================================ */

describe('phoneLog.onLine 持续流（流管理器 + plugin.push 广播）', () => {
  /** 写输出 3 行后自然退出的 mock adb（40ms 间隔，无 cmd 元字符） */
  function writeStreamMock(dir: string, name: string, script: string): string {
    const adbPath = path.join(dir, name)
    fs.writeFileSync(adbPath, ['@echo off', `node -e "${script}"`].join('\r\n'), 'utf8')
    return adbPath
  }

/** stub WS → ws WebSocket 类型（测试替身只实现 readyState / send / 事件） */
const asWs = (ws: StubWs): WebSocket => ws as unknown as WebSocket

/** 搭一套隔离的 hub + 流管理器 + stub 订阅连接 */
function setup(project: string): { hub: PluginPushHub; streams: PluginStreamManager; ws: StubWs } {
  const hub = new PluginPushHub()
  const streams = new PluginStreamManager(hub)
  const ws = new StubWs()
  hub.register(asWs(ws))
  hub.subscribe(asWs(ws), project)
  return { hub, streams, ws }
}

  test('3 行后自然退出：3 条 plugin.push + 1 条 plugin.close；streamId 返回', async () => {
    await withTemp(async (dir) => {
      // 120ms 间隔 × 3 行：总时长 > 早退探测窗口（250ms），不会误判为启动失败
      const adbPath = writeStreamMock(dir, 'mock-stream.cmd', "var n=0;var t=setInterval(function(){n=n+1;console.log('stream-line-'+n);if(n===3){clearInterval(t);process.exit(0)}},120)")
      const project = 'proj-stream'
      const { hub, streams, ws } = setup(project)
      hub.idleStopMs = 0 // 本用例不做订阅归零停流（stub 全程在线）
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.onLine',
          { action: 'start', __adbPath: adbPath },
          { project, streams },
        )
        assert.equal(r.ok, true, `应启动成功：${r.message}`)
        const streamId = r.streamId ?? ''
        assert.ok(streamId !== '')
        await waitFor(() => ws.closes().length >= 1, 8000)
        const pushes = ws.pushes()
        assert.equal(pushes.length, 3, `应收到 3 条推送（实际 ${pushes.length}）`)
        assert.deepEqual(pushes.map((p) => p.line), ['stream-line-1', 'stream-line-2', 'stream-line-3'])
        assert.equal(pushes[0].plugin, 'phone-log')
        assert.equal(pushes[0].streamId, streamId)
        assert.equal(pushes[0].project, project)
        const close = ws.closes()[0]
        assert.equal(close.streamId, streamId)
        assert.equal(streams.size, 0) // 进程结束：登记清理
      } finally {
        hub.dispose()
      }
    })
  })

  test('packageFilter 行过滤（不匹配的行不推送）', async () => {
    await withTemp(async (dir) => {
      // 120ms 间隔（避开 250ms 早退探测窗口误判）
      const adbPath = writeStreamMock(dir, 'mock-filter.cmd', "var n=0;var t=setInterval(function(){n=n+1;console.log('pkg hit-'+n);console.log('miss-'+n);if(n===2){clearInterval(t);process.exit(0)}},120)")
      const { hub, streams, ws } = setup('proj-filter')
      hub.idleStopMs = 0
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.onLine',
          { action: 'start', packageFilter: 'pkg', __adbPath: adbPath },
          { project: 'proj-filter', streams },
        )
        assert.equal(r.ok, true)
        await waitFor(() => ws.closes().length >= 1, 8000)
        // mock 每轮输出 'pkg hit-N' + 'miss-N' 两行：过滤后只剩含包名（'pkg'）的行
        assert.deepEqual(ws.pushes().map((p) => p.line), ['pkg hit-1', 'pkg hit-2'])
        assert.ok(ws.pushes().every((p) => String(p.line).includes('pkg')))
      } finally {
        hub.dispose()
      }
    })
  })

  test('stop：杀死长跑 mock（不再有新行）+ close 广播', async () => {
    await withTemp(async (dir) => {
      const adbPath = writeStreamMock(dir, 'mock-hang.cmd', "setInterval(function(){console.log('tick')},40)")
      const { hub, streams, ws } = setup('proj-stop')
      hub.idleStopMs = 0
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.onLine',
          { action: 'start', __adbPath: adbPath },
          { project: 'proj-stop', streams },
        )
        assert.equal(r.ok, true)
        const streamId = r.streamId ?? ''
        await waitFor(() => ws.pushes().length >= 1, 8000)
        const stop = await invokePhoneLogNode(
          'phoneLog.onLine',
          { action: 'stop', streamId },
          { project: 'proj-stop', streams },
        )
        assert.equal(stop.ok, true)
        await waitFor(() => ws.closes().length >= 1, 8000)
        assert.equal(ws.closes()[0].streamId, streamId)
        const atClose = ws.pushes().length
        await delay(300)
        assert.equal(ws.pushes().length, atClose, '停止后不应再有新行')
        // 重复 stop：流已清理 → ok:false
        const again = await invokePhoneLogNode(
          'phoneLog.onLine',
          { action: 'stop', streamId },
          { project: 'proj-stop', streams },
        )
        assert.equal(again.ok, false)
        assert.ok(again.message?.includes('不存在或已结束'))
      } finally {
        hub.dispose()
      }
    })
  })

  test('无 adb（不存在的路径）→ ok:false 中文提示（早退探测）', async () => {
    await withTemp(async (dir) => {
      const { hub, streams } = setup('proj-noadb')
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.onLine',
          { action: 'start', __adbPath: path.join(dir, 'no-such-adb.exe') },
          { project: 'proj-noadb', streams },
        )
        assert.equal(r.ok, false)
        assert.ok(r.message?.includes('adb 未安装或不在 PATH'), `实际 message：${r.message}`)
        assert.equal(r.streamId, undefined)
      } finally {
        hub.dispose()
      }
    })
  })

  test('订阅归零自动停流：最后一名订阅者离开后（idle 延迟）流被停掉', async () => {
    await withTemp(async (dir) => {
      const adbPath = writeStreamMock(dir, 'mock-idle.cmd', "setInterval(function(){console.log('tick')},40)")
      const hub = new PluginPushHub()
      hub.idleStopMs = 100 // 测试用小延迟
      const streams = new PluginStreamManager(hub)
      const ws = new StubWs()
      hub.register(asWs(ws))
      hub.subscribe(asWs(ws), 'proj-idle')
      try {
        const r = await invokePhoneLogNode(
          'phoneLog.onLine',
          { action: 'start', __adbPath: adbPath },
          { project: 'proj-idle', streams },
        )
        assert.equal(r.ok, true)
        await waitFor(() => ws.pushes().length >= 1, 8000)
        assert.equal(streams.size, 1)
        hub.unsubscribe(asWs(ws), 'proj-idle') // 最后一名订阅者离开
        await waitFor(() => streams.size === 0, 5000)
        // 流记录被清理 = close 事件已发生 = 进程确被杀死（close 广播此时已无订阅者，无法送达，跳过断言）
      } finally {
        hub.dispose()
      }
    })
  })

  test('未知节点走未实现提示（中文）', async () => {
    const { streams } = setup('proj-other')
    const r = await invokePhoneLogNode('phoneLog.unknown', {}, { project: 'proj-other', streams })
    assert.equal(r.ok, false)
    assert.ok(r.message?.includes('未实现'))
    streams.hub.dispose()
  })
})
