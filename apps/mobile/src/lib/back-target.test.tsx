// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { backTargetOf, clearBackTargets, useBackLink } from './back-target'

/**
 * 「返回目标只算一处」的两条守卫（D-105）。
 *
 * ## 为什么要有"扫源码"这种测试
 *
 * 这套改动把两件事绑到了一起：**页面上那颗「← 返回」的目标**与**系统返回键的目标**，
 * 必须是同一个值（现在靠 `useBackLink` 一处登记做到）。而它的失效方式恰恰是最难发现的那种：
 *
 * - 新加一个页面，作者照着旁边老页面抄了 `readBackLink(...)` 自己算——
 *   箭头工工整整，**按返回键却去了别处**（或掉进兜底）；
 * - 或者哪天有人为了让返回键"能退"把 `window.history.back()` 加回来——
 *   用户报的那两条怪行为（连点菜单一路退、退进刚离开的详情）**原样复发**。
 *
 * 这两种都不会让任何现有用例变红。所以这里直接扫源码，把它们钉死
 * （与 `page-turn.test.ts`、`back-link.test.ts` 同一族做法：判据能写成断言就别靠人眼）。
 */

const SRC = join(process.cwd(), 'src')

/** 允许直接调 `readBackLink` 的地方：它自己的实现、它的守卫测试、以及登记表（它调的入口） */
const READ_BACK_LINK_ALLOWED = new Set([
  'pages/back-link.ts',
  'pages/back-link.test.ts',
  'lib/back-target.ts',
  'lib/back-target.test.tsx',
])

/** 允许出现 `history.back()` 的地方：兜底路径那一处，以及本文件（它自己就写着这个名字） */
const HISTORY_BACK_ALLOWED = new Set([
  'lib/back-go.ts',
  'lib/back-go.test.ts',
  'lib/back-target.test.tsx',
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/** 只扫生产代码：测试文件里出现这些名字是正常的（它们正是在验证这件事） */
function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file)
}

/** 逐行扫描，回报"哪些文件命中"（用于断言消息里能说清是哪一个文件） */
function grep(needle: string, allowed: Set<string>): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    if (allowed.has(rel)) continue
    const text = readFileSync(file, 'utf8')
    // 注释里提到那个名字不算：只看真正的调用形状
    const lines = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    if (lines.some((line) => line.includes(needle))) hits.push(rel)
  }
  return hits.sort()
}

afterEach(cleanup)

describe('守卫：返回目标只算一处', () => {
  it('页面上不许再直接调 readBackLink（要经过 useBackLink，否则返回键与箭头会分叉）', () => {
    expect(grep('readBackLink(', READ_BACK_LINK_ALLOWED)).toEqual([])
  })

  it('生产代码里不许再出现 window.history.back（返回不再是"退浏览器历史"，见 back-policy）', () => {
    expect(grep('history.back(', HISTORY_BACK_ALLOWED)).toEqual([])
  })

  it('页面不许再自己写「← 返回」的链接（要走 BackLink，否则那颗箭头不接返回键）', () => {
    const pages = sourceFiles(join(SRC, 'pages')).filter((file) => !isTestFile(file))
    // 迁移之后页面里只会出现 `<BackLink …>`；`page-back` 这个类名只该活在组件与样式里
    const handRolled = pages.filter((file) => readFileSync(file, 'utf8').includes('page-back'))
    expect(handRolled.map((file) => relative(SRC, file))).toEqual([])

    // 前提检查：确实有页面在用那个组件（扫到 0 个说明扫错了地方，别静默通过）
    const wired = pages.filter((file) => readFileSync(file, 'utf8').includes('<BackLink'))
    expect(wired.length).toBeGreaterThan(10)
  })
})

describe('useBackLink', () => {
  it('渲染期间就把目标登记好（返回键那一层读的就是它）', () => {
    function Detail() {
      const back = useBackLink({ from: '/recipes?category=汤' }, '/recipes')
      return <span data-testid="label">{back.label}</span>
    }
    render(
      <MemoryRouter initialEntries={['/recipes/r1']}>
        <Routes>
          <Route path="/recipes/:id" element={<Detail />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByTestId('label').textContent).toBe('返回菜谱小书')
    // 带查询串的来源原样登记（品类要保住，D-100）
    expect(backTargetOf('/recipes/r1')).toBe('/recipes?category=汤')
    clearBackTargets()
  })

  it('来源认不出来时登记的是兜底，不是那个不认识的值', () => {
    function Detail() {
      useBackLink({ from: '/nope' }, '/mine')
      return null
    }
    render(
      <MemoryRouter initialEntries={['/taste']}>
        <Routes>
          <Route path="/taste" element={<Detail />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(backTargetOf('/taste')).toBe('/mine')
    clearBackTargets()
  })
})
