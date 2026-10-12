/**
 * 演示数据（M0 阶段的占位）。
 * 正式数据在 M1 由后端 / 种子库提供，这里只保证 UI 有真实感的渲染。
 */

export interface Category {
  id: string
  name: string
  /** 笔绘图标（public/img/cat-*.png） */
  image: string
}

export interface Dish {
  id: string
  name: string
  tags: string[]
  kcal: number
  minutes: number
  likes: number
  image: string
  /** 谁爱吃 / 做过几次，如「爸爸爱吃 · 做过 8 次」 */
  note?: string
}

/** 注意：点单页（/order）在 M3、厨房页的今日安排在 M4 都已换成真实接口（api/orders.ts），
 *  订单示例数据与今日三餐的示例数据（OrderRecord / todayMeals）都已删除。 */

/** 分类（图标为笔绘水彩方块，顺序与 cat-1..5 对应） */
export const categories: Category[] = [
  { id: 'quick', name: '快手菜', image: '/img/cat-1.png' },
  { id: 'home', name: '家常菜', image: '/img/cat-2.png' },
  { id: 'meat', name: '荤菜', image: '/img/cat-3.png' },
  { id: 'veg', name: '素菜', image: '/img/cat-4.png' },
  { id: 'soup', name: '汤羹', image: '/img/cat-5.png' },
]

/** 今日推荐 */
export const recommendedDishes: Dish[] = [
  {
    id: 'd1',
    name: '番茄炒蛋',
    tags: ['家常', '微甜'],
    kcal: 220,
    minutes: 15,
    likes: 128,
    image: '/img/dish-tomato-egg.png',
    note: '3 位家人喜欢',
  },
  {
    id: 'd2',
    name: '红烧排骨',
    tags: ['家常', '下饭'],
    kcal: 310,
    minutes: 45,
    likes: 96,
    image: '/img/dish-ribs.png',
    note: '4 位家人喜欢',
  },
  {
    id: 'd3',
    name: '香菇炖鸡',
    tags: ['汤羹', '滋补'],
    kcal: 260,
    minutes: 60,
    likes: 74,
    image: '/img/dish-soup.png',
    note: '爸爸爱吃',
  },
]
