// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import CornerArt from './CornerArt'

// 角落插画（用户 2026-10-12：「除了首页每个页的右上角都有点空」）。
// 这一块是**纯装饰**，所以它坏了不会报错、只会静默地难看或者挡住按钮——用测试把这两条钉住：
// ① 名字必须真的有图可加载（写错一个字母 → 页面上是个破图标，只有肉眼能发现）；
// ② 它绝不能吃掉点击（`pointer-events: none` 在 scss 里，改样式的人不一定记得这条）。

// vitest 在 jsdom 环境下 `import.meta.url` 不是 file: URL，从包根拼（vitest 的 cwd 就是包根）
const srcDir = join(process.cwd(), 'src')
const cornerDir = join(process.cwd(), 'public/img/corner')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : []
  })
}

it('每个用到的插画名都有对应的图（否则页面上是破图标）', () => {
  const referenced = new Set<string>()
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bart="([^"]+)"/g)) referenced.add(match[1])
    for (const match of text.matchAll(/<CornerArt\s+name="([^"]+)"/g)) referenced.add(match[1])
  }
  // 空集会让这个用例"绿得毫无意义"——先确认真的扫到了东西
  expect(referenced.size).toBeGreaterThan(0)

  const onDisk = new Set(readdirSync(cornerDir))
  for (const name of referenced) {
    expect(onDisk.has(`${name}.png`), `缺少 public/img/corner/${name}.png`).toBe(true)
  }
})

it('插画不吃点击、不被读屏念出来（纯装饰）', () => {
  const css = readFileSync(join(srcDir, 'components/ui/ui.scss'), 'utf8')
  const block = css.match(/\.corner-art\s*\{[^}]*\}/)?.[0] ?? ''
  expect(block).toContain('pointer-events: none')
})

// 这条是插画最容易翻车的地方（真翻过两次）：插画锚在页头里，于是要么探下去压住「改家庭名」
// 「只看我的」这类真按钮，要么把页头撑高、把卡片推下去（用户说「间隙太大」）。
// 现在的位置契约是：**锚在页面容器上、页头不参与定位**。写成断言，改样式的人绕不过去。
it('插画锚在页面容器上，页头不参与定位（否则要么压按钮、要么撑高页头）', () => {
  const uiCss = readFileSync(join(srcDir, 'components/ui/ui.scss'), 'utf8')
  const head = uiCss.match(/\.page-head\s*\{[^}]*\}/)?.[0] ?? ''
  const art = uiCss.match(/\.corner-art\s*\{[^}]*\}/)?.[0] ?? ''

  expect(art, '没读到 .corner-art 规则').toBeTruthy()
  expect(art, '插画必须绝对定位').toContain('position: absolute')
  expect(art, '插画不能带 min-height 之类的占位（它不该影响布局）').not.toContain('min-height')
  // 页头一旦有定位就成了插画的锚点，这条路已经证明是错的（见 ui.scss 文件头那段）
  expect(head, '.page-head 不能有 position —— 它会被当成插画的锚点').not.toMatch(/position\s*:/)
  // 页头也不该给自己撑高：没有副标题的页会因此多出空档
  expect(head).not.toContain('min-height')

  // 锚点必须是**页面容器**，两个版式各自都要挂上
  const shared = readFileSync(join(srcDir, 'pages/shared.scss'), 'utf8')
  const pscreen = shared.match(/\.pscreen\s*\{[^}]*\}/)?.[0] ?? ''
  expect(pscreen, '.pscreen 是插画的锚点，必须是定位元素').toContain('position: relative')

  const recipes = readFileSync(join(srcDir, 'pages/recipes/recipes.scss'), 'utf8')
  const page = recipes.match(/\.recipes-page\s*\{[^}]*\}/)?.[0] ?? ''
  expect(page, '.recipes-page 是菜谱页插画的锚点，必须是定位元素').toContain('position: relative')
  const heading = recipes.match(/\.recipes-heading\s*\{[^}]*\}/)?.[0] ?? ''
  expect(heading, '.recipes-heading 不能有 position（同 .page-head 的道理）').not.toMatch(/position\s*:/)
})

it('渲染出来的图是装饰性的：alt 为空、aria-hidden', () => {
  const { container } = render(<CornerArt name="recipes" />)
  const img = container.querySelector('img')
  expect(img?.getAttribute('src')).toBe('/img/corner/recipes.png')
  expect(img?.getAttribute('alt')).toBe('')
  expect(img?.getAttribute('aria-hidden')).toBe('true')
  expect(img?.className).toBe('corner-art')
})

it('withAction 只是加一个类，不动图本身', () => {
  const { container } = render(<CornerArt name="recipes" withAction />)
  expect(container.querySelector('img')?.className).toBe('corner-art corner-art--shifted')
})
