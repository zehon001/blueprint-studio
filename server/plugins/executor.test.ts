/**
 * T6.3 自测 —— 插件 CLI 执行器（node:test）
 *
 * 运行：npx tsx --test server/plugins/executor.test.ts
 *
 * 覆盖（DoD 逐条）：
 *  - 版本比较：semver 逐段（数字段数值比 / 非数字段字符串比 / 不可比 → updatable:false）
 *  - detect：假命令（node -e）成功提取版本 / 退出非 0 = 未安装 / 超时 = 未安装 /
 *    cmdOverride 覆盖 / 无 detect 清单按已安装
 *  - install/update：四策略命令构造（winget / npm-global / download-zip 占位 /
 *    custom-cmd）、并发锁（同 id 单飞行）、事件流序列、1MB 截断、done 附 re-detect
 *  - invoke：__cmd 通用透传（30s 超时、stdout 尾部 100KB）、无 __cmd 无执行器 →
 *    ok:false 中文、未知插件 404、feishu-cli 命令模板构造与执行捕获（T6.6）
 *  - 真实 server 冒烟（临时端口）：detect HTTP + install SSE 流 + invoke 文件模式
 *    3 份乱序样本全序（真实输出见测试内注释与交卡汇报）
 */
import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  COMMAND_NOT_FOUND_RE,
  buildFeishuSendCommand,
  buildInstallCommand,
  compareVersions,
  decodeCmdOverride,
  detectPlugin,
  handleExecutorRequest,
  handleInvoke,
  isCommandNotFound,
  runInstall,
  type DetectResult,
  type InstallStreamEvent,
  type InvokePayload,
} from './executor'
import { handlePluginsRequest, validateManifest } from './registry'
import type { PluginManifest } from '../../src/ir/types'

/* ============================================================
 * 工具
 * ============================================================ */

/** 建临时目录跑一个用例，结束后清理 */
async function withTemp(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-executor-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 挂起命令（测试超时 / 取消 / 停止场景；cmd.exe 双引号安全，无元字符） */
const HANG_CMD = 'node -e "setInterval(function(){},1000)"'

/** 断言事件流以 error 收尾并返回 message（避免联合类型窄化的重复索引表达式） */
function lastError(events: InstallStreamEvent[]): string {
  const last = events[events.length - 1]
  assert.equal(last.type, 'error')
  return (last as Extract<InstallStreamEvent, { type: 'error' }>).message
}

/** 最小 manifest（可覆盖各字段） */
function makeManifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: `插件 ${id}`,
    kind: 'cli',
    description: '',
    nodes: [],
    ...extra,
  }
}

/* ============================================================
 * 版本比较 / cmdOverride
 * ============================================================ */

describe('compareVersions（semver 逐段比较）', () => {
  test('数字段逐段数值比较，段数不齐补 0', () => {
    assert.equal(compareVersions('1.2.3', '1.2.4'), -1)
    assert.equal(compareVersions('1.2.10', '1.2.9'), 1) // 数值比，非字典序
    assert.equal(compareVersions('35.0', '35'), 0) // 补 0 后相等
    assert.equal(compareVersions('35.0', '35.0.2'), -1)
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
    assert.equal(compareVersions('2.0', '10.0'), -1)
  })

  test('非数字段按字符串比', () => {
    assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha'), 1)
    assert.equal(compareVersions('1.0.a', '1.0.b'), -1)
  })

  test('解析失败不可比 → null（updatable 判为 false）', () => {
    assert.equal(compareVersions(undefined, '1.0.0'), null)
    assert.equal(compareVersions('1.0.0', ''), null)
    assert.equal(compareVersions('', ''), null)
  })
})

describe('decodeCmdOverride / isCommandNotFound', () => {
  test('base64url 解码；空缺省 → undefined', () => {
    const cmd = 'node -e "console.log(1)"'
    assert.equal(decodeCmdOverride(Buffer.from(cmd, 'utf8').toString('base64url')), cmd)
    assert.equal(decodeCmdOverride(null), undefined)
    assert.equal(decodeCmdOverride(''), undefined)
  })

  test('命令不存在判定：9009 / 127 / 中英文报文', () => {
    assert.equal(isCommandNotFound({ code: 9009, stdout: '', stderr: '', timedOut: false, truncated: false }), true)
    assert.equal(isCommandNotFound({ code: 127, stdout: '', stderr: '', timedOut: false, truncated: false }), true)
    assert.equal(
      isCommandNotFound({ code: 1, stdout: '', stderr: "'x' is not recognized as an internal or external command", timedOut: false, truncated: false }),
      true,
    )
    assert.equal(
      isCommandNotFound({ code: 1, stdout: '', stderr: "'x' 不是内部或外部命令，也不是可运行的程序", timedOut: false, truncated: false }),
      true,
    )
    assert.ok(COMMAND_NOT_FOUND_RE.test('系统找不到指定的文件'))
    assert.equal(isCommandNotFound({ code: 1, stdout: '', stderr: '普通失败', timedOut: false, truncated: false }), false)
  })
})

/* ============================================================
 * 安装命令构造（四策略）
 * ============================================================ */

describe('buildInstallCommand（四策略 + cmdOverride）', () => {
  test('winget：install / upgrade 动作与包 id', () => {
    const m = makeManifest('w', { install: { strategy: 'winget', args: ['Google.PlatformTools'] } })
    assert.equal(
      buildInstallCommand(m, 'install')?.ok === true ? (buildInstallCommand(m, 'install') as { cmd: string }).cmd : '',
      'winget install -e --id Google.PlatformTools --accept-source-agreements --accept-package-agreements',
    )
    assert.equal(
      buildInstallCommand(m, 'update')?.ok === true ? (buildInstallCommand(m, 'update') as { cmd: string }).cmd : '',
      'winget upgrade -e --id Google.PlatformTools --accept-source-agreements --accept-package-agreements',
    )
  })

  test('npm-global：update 追加 @latest；缺包名报中文', () => {
    const m = makeManifest('n', { install: { strategy: 'npm-global', args: ['@scope/pkg'] } })
    const up = buildInstallCommand(m, 'update')
    assert.ok(up.ok && up.cmd === 'npm install -g @scope/pkg@latest')
    const bad = buildInstallCommand(makeManifest('n2', { install: { strategy: 'npm-global' } }), 'install')
    assert.ok(!bad.ok && bad.message.includes('包名'))
  })

  test('download-zip：占位说明（不自动安装）', () => {
    const m = makeManifest('d', { install: { strategy: 'download-zip', args: ['https://example.com/x.zip'] } })
    const r = buildInstallCommand(m, 'install')
    assert.ok(!r.ok && r.message.includes('占位') && r.message.includes('https://example.com/x.zip'))
  })

  test('custom-cmd 使用 install.cmd；cmdOverride 优先于一切策略', () => {
    const m = makeManifest('c', { install: { strategy: 'custom-cmd', cmd: 'echo custom' } })
    const r = buildInstallCommand(m, 'update')
    assert.ok(r.ok && r.cmd === 'echo custom')
    const r2 = buildInstallCommand(m, 'install', 'node -e "process.exit(0)"')
    assert.ok(r2.ok && r2.cmd === 'node -e "process.exit(0)"')
  })

  test('无 install 清单 → 中文错误', () => {
    const r = buildInstallCommand(makeManifest('x'), 'install')
    assert.ok(!r.ok && r.message.includes('未声明安装命令'))
  })
})

/* ============================================================
 * detect
 * ============================================================ */

describe('detectPlugin（假命令，不依赖真实 CLI）', () => {
  test('成功：versionRegex 提取 + updatable 判定（latest 更高 → true）', async () => {
    const m = makeManifest('d1', {
      detect: { cmd: 'tool version', versionRegex: 'Tool version ([\\d.]+)' },
      update: { latestVersion: '2.0.0', source: 'registry' },
    })
    const r = await detectPlugin(m, {
      cmdOverride: 'node -e "console.log(\'Tool version 1.0.41\')"',
      timeoutMs: 10_000,
    })
    assert.equal(r.ok, true)
    assert.equal(r.installed, true)
    assert.equal(r.version, '1.0.41')
    assert.equal(r.latest, '2.0.0')
    assert.equal(r.updatable, true)
  })

  test('已是最新 → updatable:false；版本不可比 → updatable:false', async () => {
    const m = makeManifest('d2', {
      detect: { cmd: 'tool version', versionRegex: 'Tool version ([\\d.]+)' },
      update: { latestVersion: '1.0.0', source: 'registry' },
    })
    const r = await detectPlugin(m, { cmdOverride: 'node -e "console.log(\'Tool version 1.0.0\')"', timeoutMs: 10_000 })
    assert.equal(r.updatable, false)
    // versionRegex 不命中 → version undefined → 不可比
    const r2 = await detectPlugin(m, { cmdOverride: 'node -e "console.log(\'nothing useful\')"', timeoutMs: 10_000 })
    assert.equal(r2.installed, true)
    assert.equal(r2.version, undefined)
    assert.equal(r2.updatable, false)
  })

  test('退出非 0 = 未安装（中文 message）', async () => {
    const m = makeManifest('d3', { detect: { cmd: 'tool version' }, update: { latestVersion: '1.0.0', source: 'registry' } })
    const r = await detectPlugin(m, { cmdOverride: 'node -e "process.exit(3)"', timeoutMs: 10_000 })
    assert.equal(r.ok, true)
    assert.equal(r.installed, false)
    assert.equal(r.updatable, false)
    assert.ok(r.message?.includes('未安装'))
  })

  test('超时 = 未安装', async () => {
    const m = makeManifest('d4', { detect: { cmd: 'tool version' }, update: { latestVersion: '1.0.0', source: 'registry' } })
    const r = await detectPlugin(m, { cmdOverride: HANG_CMD, timeoutMs: 500 })
    assert.equal(r.installed, false)
    assert.ok(r.message?.includes('超时'))
  })

  test('无 detect 清单：按已安装处理', async () => {
    const r = await detectPlugin(makeManifest('d5', { update: { latestVersion: '1.0.0', source: 'registry' } }), {})
    assert.equal(r.ok, true)
    assert.equal(r.installed, true)
    assert.equal(r.updatable, false)
    assert.ok(r.message?.includes('未声明检测命令'))
  })
})

/* ============================================================
 * install / update（SSE 事件回调 + 并发锁 + 截断）
 * ============================================================ */

describe('runInstall（custom-cmd 假命令全链路）', () => {
  test('成功：log 流 → done + 自动重 detect 附结果（重 detect 用清单 detect 命令）', async () => {
    const events: InstallStreamEvent[] = []
    const m = makeManifest('i1', {
      // detect 命令本身就是可执行的 mock（node -e 打印版本行）
      detect: { cmd: 'node -e "console.log(\'Tool version 9.9.9\')"', versionRegex: 'Tool version ([\\d.]+)' },
      install: { strategy: 'custom-cmd', cmd: 'node -e "console.log(\'M1\');console.log(\'M2\');process.exit(0)"' },
      update: { latestVersion: '10.0', source: 'registry' },
    })
    await runInstall(m, { action: 'install', onEvent: (e) => events.push(e) })
    const types = events.map((e) => e.type)
    assert.deepEqual(types[0], 'log')
    assert.ok(events.some((e) => e.type === 'log' && e.line === 'M1'))
    assert.ok(events.some((e) => e.type === 'log' && e.line === 'M2'))
    assert.equal(types[types.length - 1], 'done')
    const done = events[events.length - 1] as Extract<InstallStreamEvent, { type: 'done' }>
    const detect = done.detect as DetectResult
    assert.equal(detect.installed, true)
    assert.equal(detect.version, '9.9.9')
    assert.equal(detect.updatable, true) // 9.9.9 < 10.0
  })

  test('命令失败 → error 事件（中文）', async () => {
    const events: InstallStreamEvent[] = []
    const m = makeManifest('i2', {
      detect: { cmd: 'tool version' },
      install: { strategy: 'custom-cmd', cmd: 'node -e "process.exit(3)"' },
    })
    await runInstall(m, { action: 'install', onEvent: (e) => events.push(e) })
    const last = events[events.length - 1]
    assert.equal(last.type, 'error')
    assert.ok((last as Extract<InstallStreamEvent, { type: 'error' }>).message.includes('失败'))
  })

  test('并发锁：同 id 单飞行（第二个立即 error），不同 id 不受影响', async () => {
    const m1 = makeManifest('lock-a', { install: { strategy: 'custom-cmd', cmd: HANG_CMD } })
    const evts1: InstallStreamEvent[] = []
    const p1 = runInstall(m1, { action: 'install', cmdOverride: HANG_CMD, onEvent: (e) => evts1.push(e), timeoutMs: 700 })
    // 第一个已持有锁（runInstall 同步段完成 check+set）：第二个同 id 立即被拒
    const evts2: InstallStreamEvent[] = []
    await runInstall(m1, { action: 'install', cmdOverride: 'node -e "process.exit(0)"', onEvent: (e) => evts2.push(e) })
    assert.equal(evts2.length, 1)
    assert.equal(evts2[0].type, 'error')
    assert.ok(lastError(evts2).includes('在进行中'))
    // 不同 id 不受影响
    const m2 = makeManifest('lock-b', { install: { strategy: 'custom-cmd', cmd: 'node -e "process.exit(0)"' } })
    const evts3: InstallStreamEvent[] = []
    await runInstall(m2, { action: 'install', onEvent: (e) => evts3.push(e) })
    assert.equal(evts3[evts3.length - 1].type, 'done')
    await p1 // 第一个在 timeoutMs 后收尾（error：超时）
    assert.equal(evts1[evts1.length - 1].type, 'error')
  })

  test('1MB 输出截断：截断提示 + 事件数受控 + done 收尾', async () => {
    const events: InstallStreamEvent[] = []
    const m = makeManifest('i3', {
      detect: { cmd: 'tool version' },
      install: { strategy: 'custom-cmd', cmd: 'node -e "var s=new Array(200).join(\'x\');for(var i=0;i<6000;i++)console.log(s)"' },
    })
    await runInstall(m, { action: 'install', onEvent: (e) => events.push(e) })
    const logLines = events.filter((e): e is Extract<InstallStreamEvent, { type: 'log' }> => e.type === 'log')
    assert.ok(logLines.some((e) => e.line.includes('已截断')), '应有截断提示')
    assert.ok(events.length < 5600, `事件数应远小于 6000（实际 ${events.length}）`)
    assert.equal(events[events.length - 1].type, 'done')
  })

  test('download-zip 策略：error 事件带占位说明', async () => {
    const events: InstallStreamEvent[] = []
    const m = makeManifest('i4', { install: { strategy: 'download-zip', args: ['https://example.com/x.zip'] } })
    await runInstall(m, { action: 'install', onEvent: (e) => events.push(e) })
    assert.equal(events[events.length - 1].type, 'error')
    assert.ok(lastError(events).includes('占位'))
  })

  test('cmdOverride 传播：覆盖安装命令（日志含命令回显）', async () => {
    const events: InstallStreamEvent[] = []
    const m = makeManifest('i5', { install: { strategy: 'custom-cmd', cmd: 'echo should-not-run' } })
    const override = 'node -e "console.log(\'OVERRIDE-MARK\');process.exit(0)"'
    await runInstall(m, { action: 'install', cmdOverride: override, onEvent: (e) => events.push(e) })
    assert.ok(events.some((e) => e.type === 'log' && e.line === `> ${override}`))
    assert.ok(events.some((e) => e.type === 'log' && e.line === 'OVERRIDE-MARK'))
    assert.ok(!events.some((e) => e.type === 'log' && e.line.includes('should-not-run')))
    assert.equal(events[events.length - 1].type, 'done')
  })
})

/* ============================================================
 * invoke（通用通道 + feishu-cli T6.6）
 * ============================================================ */

describe('handleInvoke 通用通道（__cmd 透传）', () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-invoke-root-'))
  after(() => fs.rmSync(projectsRoot, { recursive: true, force: true }))

  test('缺 plugin / node → 400', async () => {
    const r = await handleInvoke({}, { projectsRoot })
    assert.equal(r.status, 400)
    assert.ok((r.payload.message ?? '').includes('plugin'))
  })

  test('未知插件 → 404 中文', async () => {
    const r = await handleInvoke({ plugin: 'nope', node: 'x.y' }, { projectsRoot })
    assert.equal(r.status, 404)
    assert.ok((r.payload.message ?? '').includes('插件不存在'))
  })

  test('__cmd 透传执行：ok / stdout；失败带退出码 message', async () => {
    const r = await handleInvoke(
      { plugin: 'any-cli', node: 'any.run', args: { __cmd: 'node -e "console.log(\'GEN-OUT\')"' } },
      { projectsRoot },
    )
    assert.equal(r.status, 200)
    assert.equal(r.payload.ok, true)
    assert.ok(r.payload.stdout?.includes('GEN-OUT'))

    const r2 = await handleInvoke(
      { plugin: 'any-cli', node: 'any.run', args: { __cmd: 'node -e "process.exit(5)"' } },
      { projectsRoot },
    )
    assert.equal(r2.payload.ok, false)
    assert.ok(r2.payload.message?.includes('退出码 5'))
  })

  test('__cmd 30s 缺省超时可注入调小；返回尾部 100KB', async () => {
    // 超时（600ms 注入）
    const r = await handleInvoke(
      { plugin: 'any-cli', node: 'any.run', args: { __cmd: HANG_CMD } },
      { projectsRoot, invokeTimeoutMs: 600 },
    )
    assert.equal(r.payload.ok, false)
    assert.ok(r.payload.message?.includes('超时'))

    // 输出 ~125KB → 尾部 100KB（保留尾部内容、长度受控）
    const big = 'node -e "var s=new Array(120).join(\'y\');for(var i=0;i<1000;i++)console.log(s+\'-\'+i)"'
    const r2 = await handleInvoke({ plugin: 'any-cli', node: 'any.run', args: { __cmd: big } }, { projectsRoot })
    assert.equal(r2.payload.ok, true)
    const out = r2.payload.stdout ?? ''
    assert.ok(out.length <= 100 * 1024, `应 ≤100KB（实际 ${out.length}）`)
    assert.ok(out.trimEnd().endsWith('-999'), '应保留 stdout 尾部（最后一行）')
  })

  test('无 __cmd 且已注册插件无执行器 → ok:false 中文说明；未注册插件 → 404', async () => {
    // 播种一个项目级清单（已注册但无专属执行器、无 __cmd）
    const proj = path.join(projectsRoot, 'MyTool')
    fs.mkdirSync(path.join(proj, 'plugins'), { recursive: true })
    fs.writeFileSync(
      path.join(proj, 'project.json'),
      JSON.stringify({ name: 'MyTool', mainUI: 'ui/main.ui.json', engineVersion: '0.2.0', plugins: {} }),
      'utf8',
    )
    fs.writeFileSync(
      path.join(proj, 'plugins', 'has-no-exec.json'),
      JSON.stringify({
        id: 'has-no-exec',
        name: '无执行器插件',
        kind: 'custom',
        nodes: [{ id: 'hasNoExec.do', title: 'Do', inputs: [{ id: 'exec', type: 'exec' }], outputs: [{ id: 'exec', type: 'exec' }] }],
      }),
      'utf8',
    )
    const r = await handleInvoke(
      { plugin: 'has-no-exec', node: 'hasNoExec.do', args: {}, project: 'MyTool' },
      { projectsRoot },
    )
    assert.equal(r.status, 200)
    assert.equal(r.payload.ok, false)
    assert.ok((r.payload.message ?? '').includes('未实现') && (r.payload.message ?? '').includes('__cmd'))

    const unknown = await handleInvoke({ plugin: 'not-registered', node: 'x.y', args: {} }, { projectsRoot })
    assert.equal(unknown.status, 404)
    assert.ok((unknown.payload.message ?? '').includes('插件不存在'))
  })
})

describe('feishu-cli（T6.6：命令构造 + 透传执行捕获）', () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-feishu-root-'))
  after(() => fs.rmSync(projectsRoot, { recursive: true, force: true }))

  /** invoke 字段校验用最小 raw 清单（节点 id 带 feishu-cli 规范前缀） */
  function validManifestForInvoke(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'feishu-cli',
      name: '飞书 CLI',
      kind: 'cli',
      description: '',
      nodes: [
        {
          id: 'feishuCli.send',
          title: '发送消息',
          inputs: [{ id: 'exec', type: 'exec' }],
          outputs: [
            { id: 'exec', type: 'exec' },
            { id: 'text', type: 'string' },
          ],
        },
      ],
      ...extra,
    }
  }

  test('清单校验通过（真实内置 feishu-cli.json，invoke.cmdTemplate 扩展字段保留）', () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '../../plugins-registry/feishu-cli.json'), 'utf8'),
    ) as unknown
    const v = validateManifest(raw)
    assert.ok(v.ok, `清单应通过校验：${v.ok ? '' : v.errors.join('；')}`)
    assert.ok(v.ok && v.manifest.detect?.versionRegex !== undefined)
    // T6.6：invoke 扩展字段（ADR-004 待 PM 追认）校验后必须保留（服务端模板构造消费）
    assert.equal(v.ok && v.manifest.invoke?.cmdTemplate, 'feishu send --text {message}')
  })

  test('invoke 字段校验：非对象 / 空 cmdTemplate 各报中文错；合法则保留', () => {
    const v1 = validateManifest(validManifestForInvoke({ invoke: 'nope' }))
    assert.ok(!v1.ok && v1.errors.some((e) => e.includes('invoke 必须为对象')), v1.ok ? '' : v1.errors.join('；'))
    const v2 = validateManifest(validManifestForInvoke({ invoke: { cmdTemplate: '  ' } }))
    assert.ok(!v2.ok && v2.errors.some((e) => e.includes('invoke.cmdTemplate')), v2.ok ? '' : v2.errors.join('；'))
    const v3 = validateManifest(validManifestForInvoke({ invoke: { cmdTemplate: 'feishu send --text {message}' } }))
    assert.ok(v3.ok && v3.manifest.invoke?.cmdTemplate === 'feishu send --text {message}')
  })

  test('命令构造：message 必填、target 非空用 --to 模板、值引号包裹', () => {
    const r = buildFeishuSendCommand({ message: 'hello world' })
    assert.ok(r.ok && r.cmd === 'feishu send --text "hello world"')
    const r2 = buildFeishuSendCommand({ message: 'hi', target: 'ou-123' })
    assert.ok(r2.ok && r2.cmd === 'feishu send --to "ou-123" --text "hi"')
    const bad = buildFeishuSendCommand({ target: 'x' })
    assert.ok(!bad.ok && bad.message.includes('message'))
  })

  test('命令构造：清单模板优先（无 {target} 占位 → 首个 --text 前插 --to；有占位 → 直接替换）', () => {
    const baseManifest = makeManifest('feishu-cli', {
      invoke: { cmdTemplate: 'feishu send --text {message}' },
    })
    // 清单模板（无 {target}）+ target 非空 → 插入 --to（与真实内置 feishu-cli.json 同形）
    const r = buildFeishuSendCommand({ message: 'build ok', target: 'ou-abc' }, baseManifest)
    assert.ok(r.ok && r.cmd === 'feishu send --to "ou-abc" --text "build ok"')
    // 清单模板自带 {target} 占位 → 直接替换
    const m2 = makeManifest('feishu-cli', {
      invoke: { cmdTemplate: 'feishu-cli send-msg -t {target} -m {message}' },
    })
    const r2 = buildFeishuSendCommand({ message: 'hi there', target: 'ou-9' }, m2)
    assert.ok(r2.ok && r2.cmd === 'feishu-cli send-msg -t "ou-9" -m "hi there"')
    // 清单模板 + 无 target → 不插 --to
    const r3 = buildFeishuSendCommand({ message: 'solo' }, baseManifest)
    assert.ok(r3.ok && r3.cmd === 'feishu send --text "solo"')
    // 模板无 --text 标记 → --to 追加尾部
    const m4 = makeManifest('feishu-cli', { invoke: { cmdTemplate: 'feishu push {message}' } })
    const r4 = buildFeishuSendCommand({ message: 'm', target: 't' }, m4)
    assert.ok(r4.ok && r4.cmd === 'feishu push "m" --to "t"')
  })

  test('invoke feishuCli.send：构造的命令串正确（mock 执行捕获）+ outputs.text', async () => {
    const captured: string[] = []
    const r = await handleInvoke(
      { plugin: 'feishu-cli', node: 'feishuCli.send', args: { message: 'build ok', target: 'ou-abc' } },
      {
        projectsRoot,
        runCmd: async (cmd) => {
          captured.push(cmd)
          return { code: 0, stdout: 'sent: build ok\n', stderr: '', timedOut: false, truncated: false }
        },
      },
    )
    assert.equal(r.status, 200)
    assert.deepEqual(captured, ['feishu send --to "ou-abc" --text "build ok"'])
    assert.equal(r.payload.ok, true)
    assert.equal(r.payload.outputs?.text, 'sent: build ok\n')
  })

  test('invoke feishuCli.send 缺 message → ok:false 中文', async () => {
    const r = await handleInvoke({ plugin: 'feishu-cli', node: 'feishuCli.send', args: {} }, { projectsRoot })
    assert.equal(r.payload.ok, false)
    assert.ok(r.payload.message?.includes('message'))
  })

  test('项目级清单 invoke.cmdTemplate 端到端：字段经注册表保留并被构造消费', async () => {
    const proj = path.join(projectsRoot, 'FeishuProj')
    fs.mkdirSync(path.join(proj, 'plugins'), { recursive: true })
    fs.writeFileSync(
      path.join(proj, 'project.json'),
      JSON.stringify({ name: 'FeishuProj', mainUI: 'ui/main.ui.json', engineVersion: '0.2.0', plugins: {} }),
      'utf8',
    )
    // 项目级覆盖清单：自定义命令模板（含 {target} 占位符）
    fs.writeFileSync(
      path.join(proj, 'plugins', 'feishu-cli.json'),
      JSON.stringify({
        id: 'feishu-cli',
        name: '飞书 CLI（项目覆盖）',
        kind: 'cli',
        nodes: [],
        invoke: { cmdTemplate: 'feishu-cli send-msg -t {target} -m {message}' },
      }),
      'utf8',
    )
    const captured: string[] = []
    const r = await handleInvoke(
      {
        plugin: 'feishu-cli',
        node: 'feishuCli.send',
        args: { message: 'deploy done', target: 'chat-77' },
        project: 'FeishuProj',
      },
      {
        projectsRoot,
        runCmd: async (cmd) => {
          captured.push(cmd)
          return { code: 0, stdout: 'ok\n', stderr: '', timedOut: false, truncated: false }
        },
      },
    )
    assert.equal(r.status, 200)
    assert.deepEqual(captured, ['feishu-cli send-msg -t "chat-77" -m "deploy done"'])
    assert.equal(r.payload.ok, true)
    assert.equal(r.payload.outputs?.text, 'ok\n')
  })

  test('feishu-cli 其它节点走 __cmd 通用通道或未实现提示', async () => {
    const r = await handleInvoke(
      { plugin: 'feishu-cli', node: 'feishuCli.other', args: { __cmd: 'node -e "console.log(1)"' } },
      { projectsRoot },
    )
    assert.equal(r.payload.ok, true)
    const r2 = await handleInvoke({ plugin: 'feishu-cli', node: 'feishuCli.other', args: {} }, { projectsRoot })
    assert.equal(r2.payload.ok, false)
    assert.ok(r2.payload.message?.includes('未实现'))
  })
})

/* ============================================================
 * 真实 server 冒烟（临时端口：真实 HTTP + SSE over the wire）
 * ============================================================ */

describe('真实 server 冒烟（临时端口）', () => {
  /** 起一个与 index.ts 同构的测试服务（执行器路由 + 注册表路由），端口随机 */
  async function startServer(projectsRoot: string): Promise<{ url: string; close: () => Promise<void> }> {
    const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }
    const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {}
    }
    const server = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        try {
          const handled = await handleExecutorRequest({
            req,
            res,
            pathname: url.pathname,
            query: url.searchParams,
            projectsRoot,
            readJson,
            sendJson,
          })
          if (handled) return
          const reg = await handlePluginsRequest(req.method ?? 'GET', url.pathname, url.searchParams, projectsRoot)
          if (reg) {
            sendJson(res, reg.status, reg.payload)
            return
          }
          sendJson(res, 404, { ok: false, message: `未知 API：${req.method} ${url.pathname}` })
        } catch (err) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, message: err instanceof Error ? err.message : String(err) })
          else res.destroy()
        }
      })()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('监听失败')
    return {
      url: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((resolve, reject) => server.close(() => resolve()).on('error', reject)),
    }
  }

  /** SSE 文本 → data 帧列表（与消费方 sse.ts 解析规则一致的最小实现） */
  function parseSse(text: string): Record<string, unknown>[] {
    return text
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .filter((s) => s.trim() !== '')
      .map((s) => JSON.parse(s) as Record<string, unknown>)
  }

  test('detect：HTTP + cmdOverride 假命令 → installed/version/updatable', async () => {
    await withTemp(async (root) => {
      const { url, close } = await startServer(root)
      try {
        const cmd = "node -e \"console.log('Android Debug Bridge version 1.0.41')\""
        const q = `cmdOverride=${Buffer.from(cmd, 'utf8').toString('base64url')}`
        const res = await fetch(`${url}/api/plugins/phone-log/detect?${q}`, { method: 'POST' })
        assert.equal(res.status, 200)
        const body = (await res.json()) as DetectResult
        assert.equal(body.ok, true)
        assert.equal(body.installed, true)
        assert.equal(body.version, '1.0.41')
        assert.equal(body.latest, '35.0') // 真实内置清单 update.latestVersion
        assert.equal(body.updatable, true) // 1.0.41 < 35.0
        // 未知插件 404；非法 action 400
        const miss = await fetch(`${url}/api/plugins/nope/detect`, { method: 'POST' })
        assert.equal(miss.status, 404)
        const bad = await fetch(`${url}/api/plugins/phone-log/install?action=bad`)
        assert.equal(bad.status, 400)
      } finally {
        await close()
      }
    })
  })

  test('install：真实 SSE 流（log 逐行 → done 附 re-detect 结果）', async () => {
    await withTemp(async (root) => {
      const { url, close } = await startServer(root)
      try {
        // cmdOverride：打印 3 行后成功退出（真实安装命令的替身）
        const cmd = "node -e \"console.log('S1');console.log('S2');console.log('S3');process.exit(0)\""
        const q = `action=install&cmdOverride=${Buffer.from(cmd, 'utf8').toString('base64url')}`
        const res = await fetch(`${url}/api/plugins/feishu-cli/install?${q}`)
        assert.equal(res.status, 200)
        assert.ok((res.headers.get('content-type') ?? '').includes('text/event-stream'))
        const frames = parseSse(await res.text())
        const types = frames.map((f) => f.type)
        assert.deepEqual(types[0], 'log')
        for (const line of ['S1', 'S2', 'S3']) {
          assert.ok(frames.some((f) => f.type === 'log' && f.line === line), `应有日志行 ${line}`)
        }
        assert.equal(types[types.length - 1], 'done')
        const done = frames[frames.length - 1]
        assert.ok(done.detect && typeof (done.detect as DetectResult).installed === 'boolean')
      } finally {
        await close()
      }
    })
  })

  test('invoke：文件模式 3 份乱序样本 → 多文件时间稳定归并（真实输出）', async () => {
    await withTemp(async (root) => {
      const { url, close } = await startServer(root)
      try {
        // 3 份乱序样本（两种格式混合 + 解析失败行），时间跨文件交错
        const now = new Date('2026-01-15T10:00:00')
        void now
        const f0 = [
          '10-17 12:00:03.000 I/F0( 1): f0-late',
          '10-17 12:00:01.000 D/F0( 1): f0-early',
          'garbage in f0',
        ].join('\n')
        const f1 = ['', '10-17 12:00:01.000 D/F1( 2): f1-same-ts', '10-17 12:00:02.000 W/F1( 2): f1-mid'].join('\n')
        const f2 = ['10-17 12:00:02.000 W/F2( 3): f2-same-ts', '1699999999000 E/F2( 3): f2-epoch'].join('\n')
        const fa = path.join(root, 'a.log')
        const fb = path.join(root, 'b.log')
        const fc = path.join(root, 'c.log')
        fs.writeFileSync(fa, f0)
        fs.writeFileSync(fb, f1)
        fs.writeFileSync(fc, f2)

        const res = await fetch(`${url}/api/plugins/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            plugin: 'phone-log',
            node: 'phoneLog.read',
            args: { mode: 'file', files: [fa, fb, fc] },
          }),
        })
        assert.equal(res.status, 200)
        const body = (await res.json()) as InvokePayload & { outputs?: { rows: { msg: string; ts: number; raw: string }[]; count: number } }
        assert.equal(body.ok, true)
        assert.equal(body.outputs?.count, 7)
        // 真实输出（本机实测）：全序 = 时间升序，同时间戳按 文件序→行序 tie-break
        // （解析失败行 msg 为空，断言用 raw 展示）
        assert.deepEqual(
          body.outputs?.rows.map((r) => (r as { msg: string; raw: string; level?: string }).level === '' || r.msg === '' ? r.raw : r.msg),
          ['garbage in f0', 'f2-epoch', 'f0-early', 'f1-same-ts', 'f1-mid', 'f2-same-ts', 'f0-late'],
        )
        // 解析失败行保留 raw、ts=0
        assert.equal(body.outputs?.rows[0]?.ts, 0)
        assert.equal(body.outputs?.rows[0]?.raw, 'garbage in f0')
      } finally {
        await close()
      }
    })
  })
})
