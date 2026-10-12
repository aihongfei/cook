/**
 * 品类 → 笔绘素材的对应表（F1-01）。
 *
 * 五个素材各有明确含义（见 `docs/ui-preview/handpainted/index.html` 的原始设计稿）：
 * `cat-1` 闪电 → 快手菜，`cat-2` 大厨帽 → 家常菜，`cat-3` 鱼 → 荤菜，`cat-4` 叶子 → 素菜，
 * `cat-5` 汤碗 → 汤羹。
 *
 * **所以不能按数组下标取图**：品类来自接口（`/recipes/filters`，当前按「主食 / 汤 / 素菜 / 荤菜」
 * 返回），下标一错就图文不符——出现过「素菜配了鱼、荤菜配了叶子」那种正好反过来的情况。
 * 这里按**名字**选图，接口顺序变化不影响图文对应。
 */

const CATEGORY_ICONS: Record<string, string> = {
  快手菜: '/img/cat-1.png',
  家常菜: '/img/cat-2.png',
  荤菜: '/img/cat-3.png',
  素菜: '/img/cat-4.png',
  汤: '/img/cat-5.png',
  汤羹: '/img/cat-5.png',
  // 主食没有专门的素材（设计稿里没有米饭/面条那张）：用中性的大厨帽，不会指向别的食材
  主食: '/img/cat-2.png',
}

/** 兜底：以后接口冒出没见过的品类时，用中性图而不是随便配一张食材图 */
const FALLBACK_ICON = '/img/cat-2.png'

export function categoryIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? FALLBACK_ICON
}
