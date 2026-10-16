// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installNoImageDrag } from './no-image-drag'

/**
 * 「页面里的东西不能拖着走」（用户 2026-10-16 连报两次：
 * 「图片现在能拖动，不要能拖动」→「现在能拖出链接来，这个也不行」）。
 *
 * 判据是**祖先**不是标签本身：卡片整张是 `<a>`、图片在里面，
 * 从图片上按下去拖的是图片、从卡片边角按下去拖的是链接——`closest` 一次都盖住。
 * 只写 `img` 就会漏掉第二种，用户报的第二次正是它。
 */

let uninstall: () => void

beforeEach(() => {
  uninstall = installNoImageDrag()
})

afterEach(() => {
  uninstall()
})

/** 派一次 `dragstart`，返回它有没有被拦下（用户看到的就是"拖不拖得动"） */
function dragstart(target: Element): boolean {
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

describe('installNoImageDrag', () => {
  it('图片拖不动', () => {
    document.body.innerHTML = '<img src="/img/hero.png" alt="">'
    expect(dragstart(document.querySelector('img')!)).toBe(true)
  })

  it('图片外面的链接也拖不动（卡片整张是 <a>，图片在旁边起手就是它）', () => {
    document.body.innerHTML = '<a href="/recipes/x"><img src="/x.png" alt="">一道菜</a>'
    const link = document.querySelector('a')!
    expect(dragstart(link)).toBe(true)
    // 从图片上起手也是它（同一个处理，target 是 img）
    expect(dragstart(document.querySelector('img')!)).toBe(true)
  })

  it('普通文字/卡片上的拖拽一律拦掉（全站本来就关着选中）', () => {
    document.body.innerHTML = '<div class="order-card"><p>今天的晚餐</p></div>'
    expect(dragstart(document.querySelector('p')!)).toBe(true)
  })

  it('输入框里拖动选中的文字**留着**（那是编辑文本的正常操作）', () => {
    document.body.innerHTML = '<input value="红烧肉"><textarea>备注</textarea>'
    expect(dragstart(document.querySelector('input')!)).toBe(false)
    expect(dragstart(document.querySelector('textarea')!)).toBe(false)
  })

  it('卸掉之后不再拦（它是个可卸载的安装器，和 android-back 同一写法）', () => {
    document.body.innerHTML = '<img src="/x.png" alt="">'
    const img = document.querySelector('img')!
    uninstall()
    expect(dragstart(img)).toBe(false)
  })
})
