import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSearchText,
  canReadRecipe,
  canWriteRecipe,
  parseRecipeCreate,
  parseRecipePatch,
  sourceLabel,
  writeRefusal,
} from '../src/modules/recipes/recipe.rules'

/*
 * 自建菜谱的读/写权限（F1-11 / F1-12）。
 *
 * 为什么这一组必须有：这两条判据决定"谁能看见我家的菜"与"谁能改它"，
 * **错了不会报错、只会静静地漏数据**。上一轮交付时它们一条测试都没有，
 * 于是"还没建家庭的人建的菜谱会漏给所有人看、他自己反而改不了"这个 bug
 * 一路走到了浏览器实证里才被发现（见 RISKS）。
 *
 * 库里的菜有三种归属，任何一种的判据改动都必须在这里被钉住：
 * - 全局库：`familyId=null` **且** `createdById=null`；
 * - 个人菜谱：`familyId=null` 但 `createdById=某人`（没建家庭时先记下的）；
 * - 家庭菜谱：`familyId` 有值。
 */

const publicDish = { familyId: null, createdById: null }
const mine = { familyId: null, createdById: 'u-me' }
const myFamilyDish = { familyId: 'fam-1', createdById: 'u-me' }
const otherFamilyDish = { familyId: 'fam-2', createdById: 'u-them' }

const me = { userId: 'u-me', familyId: 'fam-1' }
const myWife = { userId: 'u-wife', familyId: 'fam-1' }
const stranger = { userId: 'u-x', familyId: 'fam-9' }
/** 还没加入任何家庭的人 */
const solo = { userId: 'u-me', familyId: null }

// ---------- 能不能改 ----------

test('公共菜谱（两个归属字段都空）谁都改不了', () => {
  for (const actor of [me, myWife, stranger, solo]) {
    assert.equal(canWriteRecipe(publicDish, actor), false, `${actor.userId} 不该能改公共菜谱`)
  }
  assert.match(writeRefusal(publicDish), /公共菜谱/)
})

test('家庭菜谱：**只有同一个家**能改（精确相等，不是"有家庭就行"）', () => {
  assert.equal(canWriteRecipe(myFamilyDish, me), true)
  assert.equal(canWriteRecipe(myFamilyDish, myWife), true, '同一个家的其他成员也能改（这就是"家里共享"）')
  assert.equal(canWriteRecipe(myFamilyDish, stranger), false, '别家人不能改')
  assert.equal(canWriteRecipe(myFamilyDish, solo), false, '自己没家庭时也不能改别家的')
  assert.match(writeRefusal(otherFamilyDish), /不是你们家的/)
})

test('**个人菜谱**（还没建家庭时先记下的）：只有本人能改——这条曾经整条是错的', () => {
  assert.equal(canWriteRecipe(mine, solo), true, '本人没家庭时也要能改自己写的那道')
  assert.equal(canWriteRecipe(mine, { userId: 'u-me', familyId: 'fam-1' }), true, '后来建了家庭，原来那道还是自己的')
  assert.equal(
    canWriteRecipe(mine, { userId: 'u-me', familyId: 'fam-2' }),
    true,
    '换了家庭也还是自己的（判据看 createdById，不是"当前家庭"）',
  )
  assert.equal(canWriteRecipe(mine, stranger), false, '别人不能改')
  // 旧写法只看 familyId：个人菜谱会被判成"公共菜谱"，主人自己收到的是"公共菜谱改不了"
  assert.doesNotMatch(writeRefusal(mine), /公共菜谱/, '给主人的拒绝话里不该说这是公共菜谱')
})

// ---------- 能不能看 ----------

test('公共菜谱：谁都看得见（登录与否都一样）', () => {
  assert.equal(canReadRecipe(publicDish, me), true)
  assert.equal(canReadRecipe(publicDish, solo), true)
  assert.equal(canReadRecipe(publicDish, null), true, '没登录也看得见（菜谱库是门面）')
})

test('家庭菜谱：自家人看得见，别人一律看不见（含未登录）', () => {
  assert.equal(canReadRecipe(myFamilyDish, me), true)
  assert.equal(canReadRecipe(myFamilyDish, myWife), true)
  assert.equal(canReadRecipe(myFamilyDish, stranger), false)
  assert.equal(canReadRecipe(myFamilyDish, solo), false)
  assert.equal(canReadRecipe(myFamilyDish, null), false)
})

test('**个人菜谱只给主人看**——漏掉这条，一个人的私人笔记会变成全站可见', () => {
  assert.equal(canReadRecipe(mine, solo), true, '本人看得见')
  assert.equal(canReadRecipe(mine, { userId: 'u-me', familyId: 'fam-1' }), true, '建了家庭之后仍看得见')
  assert.equal(canReadRecipe(mine, stranger), false, '⚠️ 陌生人看不见——这正是曾经漏掉的那一条')
  assert.equal(canReadRecipe(mine, myWife), false, '同家人也不行：它挂在个人名下，不在家庭名下')
  assert.equal(canReadRecipe(mine, null), false, '未登录看不见')
})

test('看与改是同一条边界：能改的必然能看（分叉了就说明两处判据不一致）', () => {
  const recipes = [publicDish, mine, myFamilyDish, otherFamilyDish]
  const viewers = [me, myWife, stranger, solo]
  for (const recipe of recipes) {
    for (const viewer of viewers) {
      if (canWriteRecipe(recipe, viewer)) {
        assert.equal(canReadRecipe(recipe, viewer), true, `${recipe.familyId}/${recipe.createdById} 能改却看不见`)
      }
    }
  }
})

// ---------- 字段解析 ----------

const base = {
  name: '外婆的红烧肉',
  category: '荤菜',
  cuisine: '家常',
  tags: ['下饭'],
  ingredients: [{ name: '五花肉', amount: '500g' }],
  steps: ['切块焯水'],
  notes: [],
  calories: 480,
  aliases: [],
}

test('新建：必填项缺一个就拒（名字/品类/菜系/至少一步）', () => {
  assert.equal(parseRecipeCreate(base).name, '外婆的红烧肉')
  for (const broken of [
    { ...base, name: '' },
    { ...base, category: '' },
    { ...base, cuisine: '' },
    { ...base, steps: [] },
  ]) {
    assert.throws(() => parseRecipeCreate(broken), /不能为空|至少写一步/)
  }
})

test('新建：配料只有名字是必填的（"盐适量"是常态，逼人编个用量更糟）', () => {
  const parsed = parseRecipeCreate({ ...base, ingredients: [{ name: '盐', amount: '' }] })
  assert.deepEqual(parsed.ingredients, [{ name: '盐', amount: '' }])
  assert.throws(() => parseRecipeCreate({ ...base, ingredients: [{ name: '', amount: '一把' }] }), /配料名不能为空/)
})

test('更新：只处理请求里出现的字段（undefined = 没提就保持原样）', () => {
  const patch = parseRecipePatch({ name: '新名字' })
  assert.deepEqual(Object.keys(patch), ['name'])
  assert.equal(patch.category, undefined, '没提的字段不该出现在 patch 里——出现就会覆盖掉别处写的内容')
})

test('更新：`notes: []` 是明确的"清空"，要真的发出去（不能被当成"没提"）', () => {
  const patch = parseRecipePatch({ notes: [] })
  assert.deepEqual(patch.notes, [])
})

test('更新：一个字段都没提、又没带图 → 400（空 PATCH 是客户端 bug，不是"成功地什么都没改"）', () => {
  assert.throws(() => parseRecipePatch({}), /没有要改的内容/)
  // 但"这次只换了张图"是**有效**的改动：配图不走这个 patch，靠 allowEmpty 放行
  assert.deepEqual(parseRecipePatch({}, { allowEmpty: true }), {})
})

// ---------- 搜索文本与来源标签 ----------

test('搜索文本的拼法与导入器逐字一致（换了顺序或分隔符，同一句话在两类菜上表现会不同）', () => {
  assert.equal(
    buildSearchText({ name: '番茄炒蛋', aliases: ['西红柿炒蛋'], tags: ['快手'], ingredients: [{ name: '番茄' }] }),
    '番茄炒蛋\n西红柿炒蛋\n快手\n番茄',
  )
})

test('来源标签给人话（前端直接显示它，不自己查表）', () => {
  assert.equal(sourceLabel('user'), '自己上传')
  assert.equal(sourceLabel('jisu'), '极速数据')
  // 将来加了新源，前端也不用改（不改就会把新源显示成一个空白或英文串）
  assert.equal(sourceLabel('brand-new-source'), 'brand-new-source')
})
