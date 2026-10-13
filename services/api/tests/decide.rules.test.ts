import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideReason,
  excludeSeen,
  parseExclude,
  pickOne,
  preferFresh,
  rankDecide,
  tierOf,
  EXCLUDE_MAX,
  PICK_WINDOW,
  type DecideCandidate,
} from '../src/modules/discover/decide.rules'

/**
 * 「帮我决定」（M5 / F5-05）的规则单测。
 *
 * 要盯住的四件事：
 * ① **分档是真的**（一样都不用买的排在"差一样"和"家里常做"前面）——这是这个功能
 *    与「摇一道」的全部区别，档位错了它就退化成随机；
 * ② **每次不一样**（在窗口里随机，且窗口有上限）——永远给第一名的话按钮看起来是坏的；
 * ③ **不编理由**（没有信号时明说"库里挑的"）；
 * ④ **排除/去重都不会把结果掏空**（宁可重复给一道，也不回"没有了"）。
 */

function candidate(over: Partial<DecideCandidate> & { recipeId: string; name: string }): DecideCandidate {
  return { have: [], missing: [], soon: [], cooked: 0, favorites: 0, lastCookedOn: null, ...over }
}

test('一样都不用买的排最前（`ready`），哪怕它没被做过、也没人收藏', () => {
  const ready = candidate({ recipeId: 'r1', name: '清炒时蔬', have: ['青菜'], missing: [] })
  const favorite = candidate({ recipeId: 'r2', name: '红烧肉', have: [], missing: [], cooked: 9, favorites: 3 })
  const ranked = rankDecide([favorite, ready])
  assert.equal(ranked[0].recipeId, 'r1')
  assert.equal(tierOf(ready), 'ready')
})

test('差一样的（`near`）排在"家里常做但不一定做得了"（`favorite`）前面', () => {
  const near = candidate({ recipeId: 'r1', name: '豆腐汤', have: ['豆腐'], missing: ['小葱'] })
  const favorite = candidate({ recipeId: 'r2', name: '红烧肉', have: [], missing: [], cooked: 9 })
  assert.equal(rankDecide([favorite, near])[0].recipeId, 'r1')
})

test('差两样以上**不算** near（那是白跑一趟，不该由这个按钮替用户拍板）', () => {
  const far = candidate({ recipeId: 'r1', name: '佛跳墙', have: ['豆腐'], missing: ['鲍鱼', '海参'] })
  assert.equal(tierOf(far), 'any')
})

test('「用上冰箱」必须是**真用上**：一样都没有时不能进 ready', () => {
  // 空 have + 空 missing 是"算不出用得上什么"（配料表全是调料），不是"全都有"
  const nothing = candidate({ recipeId: 'r1', name: '蘸水' })
  assert.equal(tierOf(nothing), 'any')
})

test('冰箱里该先吃的排最前（同一档里，`soon` 是唯一的排序主角）', () => {
  const fresh = candidate({ recipeId: 'r1', name: '炒青菜', have: ['青菜'], missing: [] })
  const soon = candidate({ recipeId: 'r2', name: '豆腐汤', have: ['豆腐'], missing: [], soon: ['豆腐'] })
  assert.equal(rankDecide([fresh, soon])[0].recipeId, 'r2')
})

test('同一档里用上得多的在前（清库存这个用途的落点）', () => {
  const one = candidate({ recipeId: 'r1', name: 'A', have: ['鸡蛋'], missing: [] })
  const two = candidate({ recipeId: 'r2', name: 'B', have: ['鸡蛋', '番茄'], missing: [] })
  assert.equal(rankDecide([one, two])[0].recipeId, 'r2')
})

test('同分时顺序确定（两次排序给出同一个顺序，界面不会看着像在跳）', () => {
  const rows = [
    candidate({ recipeId: 'r2', name: '乙', have: ['豆腐'], missing: [] }),
    candidate({ recipeId: 'r1', name: '甲', have: ['豆腐'], missing: [] }),
  ]
  const first = rankDecide(rows).map((row) => row.recipeId)
  const second = rankDecide([...rows].reverse()).map((row) => row.recipeId)
  assert.deepEqual(first, second)
})

test('同名菜只留一道（库里 33 行重名：不去重时两次点可能给出同名两道，看着像"它没换"）', () => {
  const rows = [
    candidate({ recipeId: 'r1', name: '番茄炒蛋', have: ['鸡蛋'], missing: [] }),
    candidate({ recipeId: 'r2', name: '番茄炒蛋', have: [], missing: [], cooked: 5 }),
  ]
  const ranked = rankDecide(rows)
  assert.equal(ranked.length, 1)
  // 留排序后第一个：更好做的那一份（ready 那一版），不是做过 5 次的那一版
  assert.equal(ranked[0].recipeId, 'r1')
})

test('「换一道」真能换掉：排除过的不会再出现', () => {
  const rows = [
    candidate({ recipeId: 'r1', name: 'A', have: ['豆腐'], missing: [] }),
    candidate({ recipeId: 'r2', name: 'B', have: ['豆腐'], missing: [] }),
  ]
  const left = excludeSeen(rankDecide(rows), ['r1'])
  assert.deepEqual(left.map((row) => row.recipeId), ['r2'])
})

test('**排空了就退回全部**：宁可重复给一道，也不回一句"没有了"（那对用户毫无用处）', () => {
  const rows = [candidate({ recipeId: 'r1', name: 'A', have: ['豆腐'], missing: [] })]
  assert.equal(excludeSeen(rankDecide(rows), ['r1']).length, 1)
})

test('最近做过的**往后放**（不是删掉：刚做过的那道可能正是"冰箱里刚好够"的那道）', () => {
  const rows = [
    candidate({ recipeId: 'r1', name: '昨天吃过的', have: ['豆腐'], missing: [], lastCookedOn: '2026-10-11' }),
    candidate({ recipeId: 'r2', name: '新鲜的', have: ['豆腐'], missing: [] }),
  ]
  const ranked = preferFresh(rankDecide(rows), ['2026-10-11', '2026-10-12'])
  assert.equal(ranked[0].recipeId, 'r2')
  // 不是删掉：它还在，只是排在后面（第一版实现真的删了，这条用例当场红）
  assert.equal(ranked.length, 2)
  assert.equal(ranked[1].recipeId, 'r1')
})

test('全部都是最近做过的：顺序与不筛时一致（刚起步的家庭只做过那几顿）', () => {
  const rows = [
    candidate({ recipeId: 'r1', name: 'A', have: ['豆腐'], missing: [], lastCookedOn: '2026-10-11' }),
    candidate({ recipeId: 'r2', name: 'B', have: ['豆腐'], missing: [], lastCookedOn: '2026-10-12' }),
  ]
  const ranked = rankDecide(rows)
  assert.deepEqual(
    preferFresh(ranked, ['2026-10-11', '2026-10-12']).map((row) => row.recipeId),
    ranked.map((row) => row.recipeId),
  )
})

test('抽签只在**前几名**里随机：roll=0 取第一、roll 接近 1 取窗口最后一个', () => {
  const rows = Array.from({ length: 9 }, (_, index) =>
    candidate({ recipeId: `r${index}`, name: `第${index}道`, have: ['豆腐'], missing: [] }),
  )
  const ranked = rankDecide(rows)
  // roll=0.999 如果是在整张表里随机，取到的会是 r8；只在窗口里随机则最多到第 PICK_WINDOW 名
  assert.equal(pickOne(ranked, 0)?.recipeId, ranked[0].recipeId)
  assert.equal(pickOne(ranked, 0.999_999)?.recipeId, ranked[PICK_WINDOW - 1].recipeId)
  // 窗口有上限：前 5 名之外的菜永远抽不到（不然就退回成「摇一道」了）
  const picked = new Set(
    Array.from({ length: 200 }, (_, index) => pickOne(ranked, index / 200)?.recipeId),
  )
  assert.equal(picked.size, PICK_WINDOW)
  assert.ok(!picked.has('r8'), '第 9 名不该被抽到')
})

test('空候选给出 null（服务层据此说清"为什么没有"，而不是编一道菜）', () => {
  assert.equal(pickOne([], 0.5), null)
})

test('那句话里**只写真事**：一样都没用上、也没信号的，明说"库里挑的"，不编理由', () => {
  const nothing = candidate({ recipeId: 'r1', name: '某道菜' })
  assert.equal(decideReason(nothing), '库里挑的，今天换换口味')
})

test('那句话说出**用上了什么**（用户要能核对是不是他冰箱里的东西）', () => {
  const ready = candidate({ recipeId: 'r1', name: '番茄炒蛋', have: ['番茄', '鸡蛋'], missing: [] })
  assert.match(decideReason(ready), /冰箱里的 番茄、鸡蛋/)
  assert.match(decideReason(ready), /正好能做这道/)
})

test('**差一样时绝不说"能做"**（验收脚本抓到的现场：缺"干海木耳"却说"鸡蛋正好能做这道"）', () => {
  const near = candidate({ recipeId: 'r1', name: '海木耳蛋花汤', have: ['鸡蛋'], missing: ['干海木耳'] })
  const reason = decideReason(near)
  // 前半句与后半句自相矛盾的话，用户只看前半句就会以为现在就能下锅
  assert.doesNotMatch(reason, /正好能做这道/)
  assert.match(reason, /冰箱里的 鸡蛋能用上/)
  assert.match(reason, /只差 干海木耳/)
})

test('差一样时说清**差哪一样**（顺不顺路买由用户判断）', () => {
  const near = candidate({ recipeId: 'r1', name: '豆腐汤', have: ['豆腐'], missing: ['小葱'] })
  const reason = decideReason(near)
  assert.match(reason, /只差 小葱/)
})

test('没做过就不提"做过"；只有收藏才提收藏', () => {
  const fav = candidate({ recipeId: 'r1', name: 'A', favorites: 2 })
  const reason = decideReason(fav)
  assert.match(reason, /2 人收着/)
  assert.doesNotMatch(reason, /做过/)
})

test('该先吃的那句只提**真在冰箱里且用上了**的（不能拿别的菜的临期食材来当理由）', () => {
  const ready = candidate({ recipeId: 'r1', name: '豆腐汤', have: ['豆腐'], missing: [], soon: ['豆腐'] })
  assert.match(decideReason(ready), /豆腐 也该先吃了/)
})

test('食材名字太多时那句话会截断（点七八样的句子没人读）', () => {
  const many = candidate({
    recipeId: 'r1',
    name: '乱炖',
    have: ['番茄', '鸡蛋', '豆腐', '青菜', '土豆'],
    missing: [],
  })
  const reason = decideReason(many)
  assert.match(reason, /等/)
  assert.doesNotMatch(reason, /土豆/)
})

test('exclude 参数：逗号分隔、去重、上限（给多了影响不了结果，限一下免得被塞爆）', () => {
  assert.deepEqual(parseExclude('r1,r2,r1'), ['r1', 'r2'])
  assert.deepEqual(parseExclude(''), [])
  assert.deepEqual(parseExclude(undefined), [])
  assert.deepEqual(parseExclude(['r1', 'r2']), ['r1', 'r2'])
  assert.throws(
    () => parseExclude(Array.from({ length: EXCLUDE_MAX + 1 }, (_, index) => `r${index}`).join(',')),
    /排除得太多/,
  )
})
