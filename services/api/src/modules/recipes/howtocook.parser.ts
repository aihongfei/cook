import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { Ingredient, SeedRecipe } from './recipe.types'

export const HOWTOCOOK_REPOSITORY = 'https://github.com/Anduin2017/HowToCook'
export const HOWTOCOOK_COMMIT = '3dfa950f6daf0a5b311fc46619f1b559bac980c4'

const toolsPattern = /^(?:(?:电饭煲|电饭锅|炒锅|平底锅|煮锅|砂锅|铁锅|锅|锅铲|炒菜勺|菜刀|刀|砧板|案板|盆|碗|小碗|大碗|盘|漏勺|滤网|烤箱|微波炉|空气炸锅|蒸锅|蒸箱|高压锅|压力锅|保鲜膜|烘焙纸|锡纸|电子秤|量杯|打蛋器|搅拌器|料理机|擀面杖|筷子)(?:$|[（(：:\s\d]|若干)|直径[^，。]*的盆)/u

function readable(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, '').replace(/\*\*|__/g, '').trim()
}

function stripBullet(line: string): string {
  return line.trim().replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, '')
}

// Group nested bullets/continuations with their parent, rather than losing step warnings.
function blocks(lines: string[]): string[] {
  const result: string[] = []
  let current = ''
  for (const line of lines) {
    if (!line.trim()) continue
    if (current && (/^\S/.test(line) || /^\s{0,1}(?:[-*+]\s|\d+[.)、]\s)/.test(line))) {
      result.push(current.trim())
      current = ''
    }
    current += (current ? '\n' : '') + line.trimEnd()
  }
  if (current) result.push(current.trim())
  return result
}

function sections(markdown: string): { title: string; level: number; lines: string[] }[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const result = [{ title: '介绍', level: 0, lines: [] as string[] }]
  let current = result[0]
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    const atx = !fenced ? line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/) : null
    const setext = !fenced && line.trim() && /^\s*(?:=+|-+)\s*$/.test(lines[i + 1] ?? '')
    if (atx || setext) {
      current = { title: readable(atx ? atx[1] : line), level: atx ? (line.match(/^\s*(#+)/)?.[1].length ?? 2) : (/=/.test(lines[i + 1]) ? 1 : 2), lines: [] }
      result.push(current)
      if (setext) i++
    } else current.lines.push(line)
  }
  return result
}

function ingredientLine(line: string): Ingredient {
  const text = readable(stripBullet(line))
  const equals = text.match(/^(.+?)\s*[=＝:：]\s*(.+)$/)
  if (equals) return { name: equals[1].trim(), amount: equals[2].trim() }
  const numberFirst = text.match(/^((?:\d+(?:\.\d+)?\s*(?:g|kg|ml|毫升|克|千克|个|片|瓣)|[一二三四五六七八九十两]+[个片瓣勺])\s*(?:的)?)([^，。；（(]+)(.*)$/i)
  if (numberFirst) return { name: numberFirst[2].trim(), amount: `${numberFirst[1].trim()}${numberFirst[3]}` }
  const nameFirst = text.match(/^(.+?)\s+(?=\d|[一二三四五六七八九十两]+[个片瓣勺]|适量|少许)(.+)$/)
  if (nameFirst) return { name: nameFirst[1].trim(), amount: nameFirst[2].trim() }
  const parenthesized = text.match(/^([^（(]+)[（(](.+)[）)]$/)
  if (parenthesized) return { name: parenthesized[1].trim(), amount: parenthesized[2].trim() }
  return { name: text, amount: '原文未注明用量' }
}

export function parseHowToCook(markdown: string, sourcePath: string, commit = HOWTOCOOK_COMMIT): SeedRecipe {
  const parsed = sections(markdown)
  const heading = parsed.find(s => /的做法$/.test(s.title))?.title
  const name = (heading ?? posix.basename(sourcePath, '.md')).replace(/的做法$/, '')
  const ingredients: Ingredient[] = []
  const tools: string[] = []
  const notes: string[] = []
  const steps: string[] = []
  let sectionKind = 'notes'
  let kindLevel = 0
  for (const section of parsed) {
    const title = section.title
    if (section.level <= kindLevel || sectionKind === 'notes') {
      kindLevel = section.level
      if (/原料|食材|材料|配料|工具|厨具/.test(title)) sectionKind = /^(?:工具|厨具|器具)$/.test(title) ? 'tools' : 'ingredients'
      else if (/计算|用量|数量|份量|分量/.test(title)) sectionKind = 'quantities'
      else if (/操作|步骤|制作方法|烹饪方法|做法$/.test(title) && !title.endsWith('的做法')) sectionKind = 'steps'
      else sectionKind = 'notes'
    }
    // Retain headings too: they explain units, serving counts and step subgroups.
    const content = section.lines.join('\n').trim()
    if (!content) continue
    if (sectionKind === 'steps') {
      if (section.level > kindLevel) steps.push(`【${title}】`)
      for (const block of blocks(section.lines)) steps.push(stripBullet(block))
    } else {
      notes.push(`【${title}】\n${content}`)
      if (sectionKind === 'ingredients' || sectionKind === 'tools') {
        for (const line of section.lines.filter(l => /^\s*[-*+]\s+/.test(l))) {
          const value = ingredientLine(line)
          if (sectionKind === 'tools' || toolsPattern.test(value.name) || toolsPattern.test(readable(stripBullet(line)))) tools.push(readable(stripBullet(line)))
          else if (!ingredients.some(i => i.name === value.name)) ingredients.push(value)
        }
      } else if (sectionKind === 'quantities') {
        for (const line of section.lines.filter(l => /^\s*[-*+]\s+/.test(l))) {
          const text = readable(stripBullet(line))
          if (toolsPattern.test(text)) { tools.push(text); continue }
          const existing = [...ingredients].sort((a, b) => b.name.length - a.name.length).find(i => text.startsWith(i.name) && text.length > i.name.length)
          if (existing) {
            const amount = text.slice(existing.name.length).replace(/^\s*[=＝:：]?\s*/, '').trim()
            existing.amount = existing.amount === '原文未注明用量' ? amount : `${existing.amount}；${amount}`
          } else {
            const value = ingredientLine(line)
            if (value.amount !== '原文未注明用量' && value.name.length < 20 && !/[，。；]/.test(value.name)) {
              const match = ingredients.find(i => i.name === value.name)
              if (match) match.amount = match.amount === '原文未注明用量' ? value.amount : `${match.amount}；${value.amount}`
              else ingredients.push(value)
            }
          }
        }
      }
    }
  }
  if (!ingredients.length || !steps.length) throw new Error(`Missing ingredients or steps: ${sourcePath}`)
  const category = sourcePath.includes('/meat_dish/') ? '荤菜' : sourcePath.includes('/vegetable_dish/') ? '素菜' : sourcePath.includes('/staple/') ? '主食' : sourcePath.includes('/soup/') ? '汤' : '家常'
  const calorie = markdown.match(/(预估|估算)?(?:卡路里|热量)\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:大卡|千卡|kcal)/i)
  if (calorie) notes.push('热量按原文记录；原文未明确每人份时，不代表每人热量。')
  const aliases = name.includes('西红柿') ? [name.replace(/西红柿/g, '番茄')] : []
  const tags = [category, '家常', ...['酸甜', '咸甜', '清淡', '香辣', '麻辣'].filter(t => markdown.includes(t))]
  return {
    id: `htc-${createHash('sha256').update(sourcePath).digest('hex').slice(0, 20)}`,
    name, aliases, image: null, category, cuisine: '家常', tags,
    spiciness: /辣椒|小米辣|干辣椒|花椒/.test(ingredients.map(i => i.name).join(' ')) ? 1 : 0,
    calories: calorie ? Number(calorie[2]) : null,
    caloriesEstimated: Boolean(calorie), ingredients, steps, notes, videoUrl: null,
    source: { name: 'HowToCook', url: `${HOWTOCOOK_REPOSITORY}/blob/${commit}/${sourcePath}`, license: 'Unlicense', commit },
    tools: [...new Set(tools)], rawMarkdown: markdown, sourcePath,
  }
}
