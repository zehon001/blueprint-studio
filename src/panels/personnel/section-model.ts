/** 分节文本模型：角色卡用【标题】，规范同时兼容 Markdown ## 标题。 */

export interface TextSection {
  id: string
  title: string
  text: string
}

export type SectionStyle = 'bracket' | 'markdown'

let sectionSeq = 0

function newSectionId(): string {
  sectionSeq += 1
  return `sec_${Date.now().toString(36)}_${sectionSeq.toString(36)}`
}

function trimSection(section: TextSection): TextSection {
  return {
    ...section,
    text: section.text.replace(/^\n+/, '').replace(/\s+$/, ''),
  }
}

export function splitBracketSections(content: string): TextSection[] {
  const sections: TextSection[] = [{ id: newSectionId(), title: '', text: '' }]
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^【([^】\n]{1,30})】\s*$/.exec(rawLine.trim())
    if (match) {
      sections.push({ id: newSectionId(), title: match[1]!.trim(), text: '' })
      continue
    }
    sections[sections.length - 1]!.text += `${rawLine}\n`
  }
  return sections.map(trimSection)
}

export function joinBracketSections(sections: TextSection[]): string {
  return sections
    .map((section) =>
      section.title.trim()
        ? `【${section.title.trim()}】\n${section.text.trim()}`
        : section.text.trim(),
    )
    .filter(Boolean)
    .join('\n\n')
}

export function splitMarkdownSections(content: string): TextSection[] {
  const sections: TextSection[] = [{ id: newSectionId(), title: '', text: '' }]
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(rawLine)
    if (match) {
      sections.push({ id: newSectionId(), title: match[1]!.trim(), text: '' })
      continue
    }
    sections[sections.length - 1]!.text += `${rawLine}\n`
  }
  return sections.map(trimSection)
}

export function joinMarkdownSections(sections: TextSection[]): string {
  return sections
    .map((section) =>
      section.title.trim()
        ? `## ${section.title.trim()}\n${section.text.trim()}`
        : section.text.trim(),
    )
    .filter(Boolean)
    .join('\n\n')
}

export function detectNormsStyle(content: string): SectionStyle {
  if (/^【[^】\n]{1,30}】\s*$/m.test(content)) return 'bracket'
  if (/^##\s+/m.test(content)) return 'markdown'
  return 'bracket'
}

export function splitSections(content: string, style: SectionStyle): TextSection[] {
  return style === 'markdown' ? splitMarkdownSections(content) : splitBracketSections(content)
}

export function joinSections(sections: TextSection[], style: SectionStyle): string {
  return style === 'markdown' ? joinMarkdownSections(sections) : joinBracketSections(sections)
}
