/**
 * 设置模态基础单测（v3 T8.3）
 *
 * 覆盖纯逻辑：设置解析/持久化、库路径前端校验、上次分区记忆。
 * 不挂载 SettingsModal（会拉入各面板 CSS，node:test 不加载 CSS）。
 */
import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  isSettingsSection,
  loadLastSection,
  loadSettings,
  parseSettings,
  saveLastSection,
  saveSettings,
  validateLibraryRoot,
} from './store'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

before(() => {
  ;(globalThis as Record<string, unknown>).localStorage = new MemoryStorage()
})

describe('设置解析 / 持久化', () => {
  it('默认值：库根空（服务端默认）+ 自动重跑开', () => {
    assert.deepEqual(DEFAULT_SETTINGS, { libraryRoot: '', autoRerun: true })
    assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS)
    assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS)
  })

  it('未知字段忽略、类型不符回落默认', () => {
    assert.deepEqual(parseSettings({ libraryRoot: 42, autoRerun: 'yes', extra: 1 }), DEFAULT_SETTINGS)
    assert.deepEqual(parseSettings({ libraryRoot: 'D:/lib', autoRerun: false }), {
      libraryRoot: 'D:/lib',
      autoRerun: false,
    })
  })

  it('saveSettings → loadSettings 往返；坏 JSON 回落默认', () => {
    const value = { libraryRoot: 'D:/tools/lib', autoRerun: false }
    saveSettings(value)
    assert.deepEqual(loadSettings(), value)
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{broken')
    assert.deepEqual(loadSettings(), DEFAULT_SETTINGS)
  })
})

describe('库路径前端校验（M8 范围）', () => {
  it('空 = 使用默认（通过）', () => {
    assert.equal(validateLibraryRoot(''), null)
    assert.equal(validateLibraryRoot('   '), null)
  })

  it('绝对路径通过（Windows 盘符 / UNC / POSIX）', () => {
    assert.equal(validateLibraryRoot('C:\\Users\\me\\.blueprint-studio\\library'), null)
    assert.equal(validateLibraryRoot('\\\\server\\share\\lib'), null)
    assert.equal(validateLibraryRoot('/home/me/.blueprint-studio/library'), null)
  })

  it('相对路径 / 控制字符 / 与项目重叠 → 中文错误', () => {
    assert.match(validateLibraryRoot('relative/lib') ?? '', /绝对路径/)
    assert.match(validateLibraryRoot('C:\\bad\u0001path') ?? '', /控制字符/)
    assert.match(validateLibraryRoot('C:\\work\\proj\\lib', 'C:\\work\\proj') ?? '', /重叠/)
    assert.match(validateLibraryRoot('C:\\work', 'C:\\work\\proj') ?? '', /重叠/)
    assert.match(validateLibraryRoot('C:\\work\\proj', 'C:\\work\\proj\\sub') ?? '', /重叠/)
    // 同盘但不同目录：允许
    assert.equal(validateLibraryRoot('C:\\lib', 'C:\\work\\proj'), null)
  })
})

describe('上次分区记忆', () => {
  it('非法值 / 空 → general；合法值可往返', () => {
    assert.equal(loadLastSection(), 'general')
    saveLastSection('plugins')
    assert.equal(loadLastSection(), 'plugins')
    localStorage.setItem('bps.settings.section', 'weird')
    assert.equal(loadLastSection(), 'general')
    assert.equal(isSettingsSection('about'), true)
    assert.equal(isSettingsSection('weird'), false)
  })
})
