/**
 * 页面里的东西不能拖着走（用户 2026-10-16：「图片现在能拖动，不要能拖动」，
 * 随后又补「现在能拖出链接来，这个也不行」）。
 *
 * ## 为什么这在本应用里不是"小毛病"
 *
 * 浏览器默认把 `<img>` 与 `<a>` 当成**可拖拽的东西**（HTML5 拖放），于是按住菜图或卡片一拖，
 * 系统就接管这一趟手势：出现半透明拖影、指针变成禁止符，松手可能把图/链接拖到别的应用里去
 * （桌面上会真的落下一个链接或图片文件）。
 *
 * 更要紧的是它与**我们自己的手势打架**：原生拖放一开始，浏览器就发 `pointercancel`
 * ——正在跟手的那一下（`SwipePager` 翻页、卡片长按、抽屉下拖）被当场收走，
 * 表现成"按住卡片左右划，页面不跟手，只拖出来一个影子"。
 * 这正是 R-081 记的那一类坑：看着像动画坏了，其实是手势被别人抢了。
 *
 * ## 规则：**除了输入框里的文字，什么都不拖**
 *
 * 一开始只拦了 `img`（"图片不能拖"的字面意思），然后立刻就露了下一半：
 * 卡片整张是 `<Link>`（`.dish-card` / `.order-card` 都是），在图片旁边的空白处起手，
 * 拖出来的是那个链接——用户下一句就是「现在能拖出链接来，这个也不行」。
 * 所以干脆按本应用的**本质**来定：这是个手机 App，不是网页。
 * 全站本来就关着文字选中（见 styles/index.scss 那段，用户 2026-10-13 要求的），
 * 那么"能拖走的东西"一个都不该有；唯一要留的是**输入框里拖动选中的文字**
 * （那是编辑文本的正常操作：选中一段再拖到别处）。
 *
 * 判据用**祖先**而不是标签本身：卡片整张是链接、图片在里面，
 * 从图片上按下去时 `event.target` 是那个 `<img>`，从卡片边角按下去时是 `<a>`——
 * `closest` 一次把两种情况都盖住（写成 `tagName === 'IMG'` 就只治一半，
 * 这正是这一条被用户连报两次的原因）。
 *
 * ## 为什么不只在 CSS 里关
 *
 * `-webkit-user-drag: none`（见 styles/index.scss）在 Chromium/WebKit 里就够——
 * 也就是本应用真正跑的那个引擎（Capacitor 安卓 WebView、开发期的 Chrome/Safari）。
 * 但那条属性**不是标准**，Firefox 不认，而且它只写在一处、将来换壳重排时容易整块丢掉。
 * 所以在**根上**再拦一次 `dragstart`：一次覆盖所有元素（现在与以后新增的、
 * 以及弹层那种挂在 React 根外面的——它们不走组件树，只在 document 这一层拦得住）。
 */
export function installNoImageDrag(): () => void {
  const onDragStart = (event: DragEvent) => {
    const target = event.target as Element | null
    // 输入框里的拖拽留着（拖动选中的文字去改它），其余一律不拖
    if (target?.closest?.('input, textarea')) return
    event.preventDefault()
  }
  /*
   * 挂 `document` 且**不用 capture**：这一层要的就是"最后一个说话"——
   * 任何组件（包括弹层里那些）自己写的 dragstart 都不该把这件事翻过来。
   */
  document.addEventListener('dragstart', onDragStart)
  return () => document.removeEventListener('dragstart', onDragStart)
}
