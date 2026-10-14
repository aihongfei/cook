import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  FRIDGE_SCAN_TEXT,
  RECOMMEND_MAX,
  RECOMMEND_MIN,
  buildChatPrompt,
  buildFridgeScanPrompt,
  buildHintsPrompt,
  buildRecommendPrompt,
} from '../src/modules/ai/ai.prompts'
import { OCR_MAX_ITEMS } from '../src/modules/ai/fridge-scan.rules'
import { PROMPTS_EXAMPLES_MAX, PROMPTS_HINTS_MAX, SUGGEST_PICKS_MAX, SUGGEST_PICKS_MIN } from '../src/modules/ai/ai.rules'
import { TOOL_PREVIEW_MEAL_SHOPPING, TOOL_SEARCH_DISHES } from '../src/modules/ai/ai.tools'

/**
 * 提示词模板库（F16-03）。要盯住的四件事：
 *
 * ① **内置文案里没有漏填的占位符**（`{{...}}` 漏一个是字面上的花括号跑到模型眼前，
 *    而且不报错——这类"静默脏数据"正是本项目最怕的）；
 * ② **接线是代码给的、不是文案给的**：条数上限、工具名、工具数都要与常量对得上，
 *    且在覆盖之后**仍然对得上**（覆盖的是文案，不是接线）；
 * ③ **覆盖的四种情况都有确定行为**：正常覆盖 / 没配目录 / 文件空 / 文件缺占位符
 *    ——后三种一律回落内置，且**功能仍然可用**；
 * ④ **主对话那套不可覆盖**（它整体上是一份接线，见 `ai.prompts` 文件头）。
 */

const cleanups: string[] = []
afterEach(() => {
  delete process.env.AI_PROMPTS_DIR
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 建一个临时提示词目录，写进给定的文件 */
function promptDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cook-prompts-'))
  cleanups.push(dir)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, `${name}.md`), content)
  process.env.AI_PROMPTS_DIR = dir
  return dir
}

const recommendInput = {
  min: SUGGEST_PICKS_MIN,
  max: SUGGEST_PICKS_MAX,
  candidates: '- id=r1 名称=番茄炒蛋',
  meal: '今天晚餐',
  note: '三口人，孩子 5 岁',
  hint: '清淡点',
}

describe('内置文案', () => {
  it('推荐：没有漏填的占位符，且条数就是那组常量（不是另抄一遍的数字）', () => {
    const prompt = buildRecommendPrompt(recommendInput)
    assert.doesNotMatch(prompt, /\{\{/, '内置文案里还留着没填的占位符')
    assert.match(prompt, new RegExp(`挑 ${SUGGEST_PICKS_MIN}～${SUGGEST_PICKS_MAX} 道`))
    // 导出给调用方的那两个数与规则文件里的必须是同一个（否则调用方与文案会各说一套）
    assert.equal(RECOMMEND_MIN, SUGGEST_PICKS_MIN)
    assert.equal(RECOMMEND_MAX, SUGGEST_PICKS_MAX)
  })

  it('推荐：接线在里面——JSON 契约、候选清单、这一餐、家里情况、用户那句话', () => {
    const prompt = buildRecommendPrompt(recommendInput)
    assert.match(prompt, /按 picks 数组回/)
    assert.match(prompt, /- id=r1 名称=番茄炒蛋/)
    assert.match(prompt, /要安排的这一餐：今天晚餐/)
    assert.match(prompt, /家里情况：三口人，孩子 5 岁/)
    assert.match(prompt, /用户说：清淡点/)
  })

  it('推荐：没有 hint 时用那句兜底（不是留一个空的"用户说："）', () => {
    const prompt = buildRecommendPrompt({ ...recommendInput, hint: null })
    assert.match(prompt, /用户没有特别说明/)
    assert.doesNotMatch(prompt, /用户说：\s*$/m)
  })

  it('快问：两组上限都插进文案，且没有漏填的占位符', () => {
    const prompt = buildHintsPrompt({ hintMax: 12, exampleMax: 24, context: '三口人' })
    assert.doesNotMatch(prompt, /\{\{/)
    assert.match(prompt, /12 字以内/)
    assert.match(prompt, /24 字以内/)
    assert.match(prompt, /三口人/)
    assert.match(prompt, /\{"hints": \["\.\.\."\], "examples"/)
  })

  it('冰箱识别：JSON 示例的字段是从 schema 现算的（改 schema 不会漏掉这里）', () => {
    const prompt = buildFridgeScanPrompt({ maxItems: OCR_MAX_ITEMS })
    assert.doesNotMatch(prompt, /\{\{/)
    assert.match(prompt, new RegExp(`最多 ${OCR_MAX_ITEMS} 样`))
    // 四个字段名都出现在示例里——少一个，模型就不知道该给什么
    for (const key of ['name', 'amount', 'zone', 'note']) {
      assert.match(prompt, new RegExp(`"${key}":`), `示例里缺字段 ${key}`)
    }
  })
})

describe('覆盖：文案可以换，接线不能换', () => {
  it('正常覆盖：文件里的文案生效、里面的占位符也填上了', () => {
    promptDir({ recommend: '挑 {{min}} 到 {{max}} 道就好。\n\n换个说法：要好吃的。' })
    const prompt = buildRecommendPrompt(recommendInput)
    assert.match(prompt, new RegExp(`挑 ${SUGGEST_PICKS_MIN} 到 ${SUGGEST_PICKS_MAX} 道就好`))
    assert.doesNotMatch(prompt, /\{\{/)
    // 覆盖掉的是文案，接线照旧由代码拼在后面
    assert.match(prompt, /按 picks 数组回/)
    assert.match(prompt, /- id=r1 名称=番茄炒蛋/)
  })

  it('没配 AI_PROMPTS_DIR：内置文案（不是空串）', () => {
    delete process.env.AI_PROMPTS_DIR
    const prompt = buildRecommendPrompt(recommendInput)
    assert.match(prompt, /你是家庭厨房的掌勺参谋/)
  })

  it('目录配了但这套没写：回落内置，别的几套互不影响', () => {
    // 覆盖文件要**含必需占位符**才生效（少了 `{{max}}` 属于"写坏了"，另一条在测）
    promptDir({ 'fridge-scan': '只看照片，别猜。最多 {{max}} 样。' })
    assert.match(buildFridgeScanPrompt({ maxItems: OCR_MAX_ITEMS }), /只看照片，别猜。/)
    // 同一份配置下，没给文件的推荐那套仍然是内置
    assert.match(buildRecommendPrompt(recommendInput), /你是家庭厨房的掌勺参谋/)
  })

  it('覆盖文件是空的：回落内置（空文案会让模型完全失去约束）', () => {
    promptDir({ recommend: '   \n\n  ' })
    assert.match(buildRecommendPrompt(recommendInput), /你是家庭厨房的掌勺参谋/)
  })

  it('**缺占位符就回落**：少了 {{max}} 的话模型不知道该写几道，而没人看得出是文件的问题', () => {
    promptDir({ recommend: '随便挑几道，好吃就行。' })
    const prompt = buildRecommendPrompt(recommendInput)
    assert.match(prompt, /你是家庭厨房的掌勺参谋/, '缺占位符时该用内置文案')
    assert.match(prompt, new RegExp(`挑 ${SUGGEST_PICKS_MIN}～${SUGGEST_PICKS_MAX} 道`))
  })

  it('占位符写得松一点也认（`{{ max }}` 是人手写时最容易多打的形式）', () => {
    // 必需占位符要齐（`min` 与 `max` 都声明为必需，缺哪个都算"写坏了"）
    promptDir({ recommend: '挑 {{ min }}～{{ max }} 道以内即可。' })
    assert.match(
      buildRecommendPrompt(recommendInput),
      new RegExp(`挑 ${SUGGEST_PICKS_MIN}～${SUGGEST_PICKS_MAX} 道以内即可`),
    )
  })

  it('覆盖之后**接线仍然来自代码**：条数上限、工具名一个不差', () => {
    promptDir({ hints: '随便写几句。\n{{hints}} {{examples}} {{hintMax}} {{exampleMax}}' })
    const prompt = buildHintsPrompt({ hintMax: 9, exampleMax: 18, context: '四口人' })
    assert.match(prompt, new RegExp(`^随便写几句。\\n${PROMPTS_HINTS_MAX} ${PROMPTS_EXAMPLES_MAX} 9 18$`, 'm'),
      '占位符该被换成代码里的值')
    assert.match(prompt, /按 JSON 回：\{"hints"/, 'JSON 契约必须还在（它是接线）')
    assert.match(prompt, /四口人/, '家里的数据必须还在（它是接线）')
  })
})

describe('主对话那套刻意不可覆盖', () => {
  const input = { summary: '今天晚餐：番茄炒蛋', note: '三口人', today: '2026-10-15', taste: '妈妈不吃辣' }

  it('即使放了 chat.md 也不生效（改错一句的表现是"说已经加好了而库里没动"）', () => {
    promptDir({ chat: '随便聊。' })
    const prompt = buildChatPrompt(input)
    assert.doesNotMatch(prompt, /随便聊/)
    assert.match(prompt, /你是这个家庭的厨房助手/)
  })

  it('接线在里面：工具名、忌口、清单与菜单的界线、不许谎报', () => {
    const prompt = buildChatPrompt(input)
    // 工具名由 ai.tools 的常量给（不是文案里手写的字符串）
    assert.match(prompt, new RegExp(TOOL_SEARCH_DISHES))
    assert.match(prompt, new RegExp(TOOL_PREVIEW_MEAL_SHOPPING))
    assert.match(prompt, /妈妈不吃辣/)
    assert.match(prompt, /分清清单与菜单/)
    assert.match(prompt, /绝不要说"已经加好了/)
    assert.match(prompt, /今天是 2026-10-15/)
  })

  it('没有口味档案时不出现那两段（不是留下"这家人的口味与忌口：无"）', () => {
    const prompt = buildChatPrompt({ ...input, taste: null })
    assert.doesNotMatch(prompt, /这家人的口味与忌口/)
    // 但人设与工具接线照旧
    assert.match(prompt, /你是这个家庭的厨房助手/)
    assert.match(prompt, new RegExp(TOOL_SEARCH_DISHES))
  })

  it('家里还没有安排时给的是那句兜底，不是一段空白', () => {
    const prompt = buildChatPrompt({ ...input, summary: '' })
    assert.match(prompt, /（今天还没有安排）/)
  })
})

describe('冰箱识别文案的硬要求（每一条都对应一次真实教训）', () => {
  const text = buildFridgeScanPrompt({ maxItems: OCR_MAX_ITEMS })

  it('明说"看不清的不要猜"（多一条假的比少一条真的更糟）', () => {
    assert.match(text, /看不清、认不准的东西一律不要写/)
  })

  it('明说不许编保质期（它看不到日期，而这个值驱动"今日先吃"）', () => {
    assert.match(text, /不要编造保质期/)
  })

  it('明说备注只写包装上读得到的字（2026-10-13 抓到的静默通道）', () => {
    assert.match(FRIDGE_SCAN_TEXT.builtin, /备注只写包装上\*\*读得到的字/)
  })
})
