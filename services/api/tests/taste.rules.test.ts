import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  judgeDish,
  hitsKeyword,
  isFilled,
  missingProfiles,
  parseDiet,
  parseSpicyLevel,
  parseTasteProfile,
  judgementForOne,
  type TasteProfile,
} from '../src/modules/taste/taste.rules'

/**
 * 口味与健康档案的判据（M8 / F8-01、F8-02）。
 *
 * 这一组盯的是**判据的边界**，因为这里错了后果不对等：
 * 过敏漏报可能让人进医院，误报只是用户看一眼就忽略。所以规则刻意保守，
 * 而"保守"必须是**能被验证的**，不能只是注释里的一句话。
 */

function profile(over: Partial<TasteProfile> = {}): TasteProfile {
  return { spicyLevel: null, flavors: [], diet: null, allergies: [], dislikes: [], note: null, ...over }
}

const dish = (name: string, ingredients: string[], spiciness = 0) => ({
  name,
  spiciness,
  ingredients: ingredients.map((item) => ({ name: item, amount: '适量' })),
})

describe('关键词匹配：只做子串包含', () => {
  it('命中更长的配料名（"花生"要找得到"花生米"、"去皮花生"）', () => {
    assert.equal(hitsKeyword('花生米', '花生'), true)
    assert.equal(hitsKeyword('去皮花生', '花生'), true)
    assert.equal(hitsKeyword('花生', '花生'), true)
    // 反向不成立：关键词比配料长时不该命中（"花生酱"不该被"花生"以外的词捞出来）
    assert.equal(hitsKeyword('花生', '花生酱'), false)
  })

  it('大小写与空白无关（英文过敏原与用户多打的空格）', () => {
    assert.equal(hitsKeyword('  Peanut Butter ', 'peanut'), true)
  })

  it('空关键词一律不命中（否则空档案会拦住所有菜）', () => {
    assert.equal(hitsKeyword('花生', '   '), false)
    assert.equal(hitsKeyword('', '花生'), false)
  })
})

describe('判据：过敏硬拦、忌口软提醒', () => {
  it('有人对它过敏 → block，并且说清是谁、因为哪样配料', () => {
    const result = judgeDish(dish('宫保鸡丁', ['鸡胸肉', '花生米', '干辣椒']), [
      { userId: 'u1', nickname: '爸爸', profile: profile({ allergies: ['花生'] }) },
    ])

    assert.equal(result.verdict, 'block')
    assert.equal(result.blocked.length, 1)
    // 说清"谁 + 过敏原 + 命中哪样配料"：只说"有不合适的菜"用户没法判断
    assert.equal(result.blocked[0].nickname, '爸爸')
    assert.equal(result.blocked[0].keyword, '花生')
    assert.equal(result.blocked[0].ingredient, '花生米')
    assert.match(result.text, /爸爸对「花生」过敏，这道菜里有花生米/)
  })

  it('**菜名不算数**：鱼香肉丝不因为名字里有"鱼"而拦下对鱼过敏的人', () => {
    // 这是按菜名匹配会犯的错：鱼香肉丝里没有鱼。判据只读配料表。
    const result = judgeDish(dish('鱼香肉丝', ['猪里脊', '木耳', '胡萝卜']), [
      { userId: 'u1', nickname: '妈妈', profile: profile({ allergies: ['鱼'] }) },
    ])
    assert.equal(result.verdict, 'ok')

    // 反过来：蚂蚁上树里也没有蚂蚁，但真有鱼的那种菜（名字里不带"鱼"）也要被拦住
    const real = judgeDish(dish('开水白菜', ['白菜心', '鲫鱼', '火腿']), [
      { userId: 'u1', nickname: '妈妈', profile: profile({ allergies: ['鱼'] }) },
    ])
    assert.equal(real.verdict, 'block')
  })

  it('忌口只是 warn（不是不能吃，是提醒一下）', () => {
    const result = judgeDish(dish('香菜拌牛肉', ['牛腱', '香菜']), [
      { userId: 'u1', nickname: '我', profile: profile({ dislikes: ['香菜'] }) },
    ])
    assert.equal(result.verdict, 'warn')
    assert.equal(result.blocked.length, 0)
    assert.equal(result.warned.length, 1)
    assert.match(result.text, /我不吃香菜/)
  })

  it('过敏比忌口重：两者都命中时结论是 block', () => {
    const result = judgeDish(dish('花生香菜拌菜', ['花生米', '香菜']), [
      { userId: 'u1', nickname: '我', profile: profile({ allergies: ['花生'], dislikes: ['香菜'] }) },
    ])
    assert.equal(result.verdict, 'block')
    assert.equal(result.blocked.length, 1)
    assert.equal(result.warned.length, 1)
  })

  it('同一个人同一道菜只报一次（他有多个过敏词命中同一样配料时）', () => {
    // "花生"与"花生米"都在他的过敏清单里：不该出现两行"爸爸对…过敏"
    const result = judgeDish(dish('宫保鸡丁', ['花生米']), [
      { userId: 'u1', nickname: '爸爸', profile: profile({ allergies: ['花生', '花生米'] }) },
    ])
    assert.equal(result.blocked.length, 1)
  })

  it('多人命中时每个人都说到（不能只报第一个）', () => {
    const result = judgeDish(dish('宫保鸡丁', ['花生米']), [
      { userId: 'u1', nickname: '爸爸', profile: profile({ allergies: ['花生'] }) },
      { userId: 'u2', nickname: '奶奶', profile: profile({ dislikes: ['花生'] }) },
    ])
    assert.equal(result.blocked.length, 1)
    assert.equal(result.warned.length, 1)
    assert.match(result.text, /爸爸/)
    assert.match(result.text, /奶奶/)
  })
})

describe('辣度：只分得出"辣/不辣"，不假装能分清微辣重辣', () => {
  it('不吃辣的人遇上辣菜 → warn', () => {
    const result = judgeDish(dish('麻婆豆腐', ['豆腐'], 1), [
      { userId: 'u1', nickname: '妈妈', profile: profile({ spicyLevel: 0 }) },
    ])
    assert.equal(result.verdict, 'warn')
    assert.equal(result.spicyConflict?.nickname, '妈妈')
  })

  it('**微辣（1）的人遇上辣菜（1）不算冲突**：库里只有 0/1 两档', () => {
    // 这一条钉的是"不假装"：数据分不出微辣与重辣，所以 1 对 1 必须放行。
    // 若哪天库里的辣度真做了多档，这条会被改——那时它是"实现变了"的证据，不是假红。
    const result = judgeDish(dish('麻婆豆腐', ['豆腐'], 1), [
      { userId: 'u1', nickname: '爸爸', profile: profile({ spicyLevel: 1 }) },
    ])
    assert.equal(result.verdict, 'ok')
    assert.equal(result.spicyConflict, null)
  })

  it('没写过辣度的人不参与辣度判断（"没说过"不是"不能吃辣"）', () => {
    const result = judgeDish(dish('水煮鱼', ['草鱼', '豆芽'], 1), [
      { userId: 'u1', nickname: '我', profile: profile() },
    ])
    assert.equal(result.verdict, 'ok')
  })

  it('不辣的菜对所有档位都放行', () => {
    const result = judgeDish(dish('清蒸鲈鱼', ['鲈鱼', '姜'], 0), [
      { userId: 'u1', nickname: '我', profile: profile({ spicyLevel: 0 }) },
    ])
    assert.equal(result.verdict, 'ok')
  })
})

describe('荤素倾向**不做硬过滤**（它不是禁忌，是偏好）', () => {
  it('"全素"的人看红烧肉不会 block/warn——他有权今天就想吃', () => {
    // 这条是刻意的：硬拦会把一整排肉菜从他的推荐里抽掉，而"全素"是一种倾向，
    // 不是"不能吃"。荤素只作为推荐提示词里的偏好与排序偏置（见 taste.rules 文件头 ④）。
    const result = judgeDish(dish('红烧肉', ['五花肉', '冰糖']), [
      { userId: 'u1', nickname: '我', profile: profile({ diet: '全素' }) },
    ])
    assert.equal(result.verdict, 'ok')
    assert.equal(result.text, '')
  })
})

describe('解析：部分更新与"说过了"的边界', () => {
  it('只传一个字段就只改那一个（不把别的冲掉）', () => {
    const patch = parseTasteProfile({ dislikes: ['香菜'] })
    assert.deepEqual(patch, { dislikes: ['香菜'] })
    // 没提的字段不在 patch 里 —— service 据此保留库里的旧值
    assert.equal('spicyLevel' in patch, false)
    assert.equal('allergies' in patch, false)
  })

  it('传空数组是**有意义的**（明确表示"这些都没有了"），与不传不是一回事', () => {
    // 空数组进了 patch（service 会把库里的那列清空）
    assert.deepEqual(parseTasteProfile({ allergies: [] }), { allergies: [] })
    // 而"没提这个字段"时它不在 patch 里，service 据此保留旧值
    assert.equal('allergies' in parseTasteProfile({ dislikes: ['香菜'] }), false)
  })

  it('一个字段都没传 → 400（不能拿一次空请求去建一条空记录）', () => {
    assert.throws(() => parseTasteProfile({}), /没有要改的内容/)
  })

  it('辣度："不限"与空都当没说过（不默认成"不吃辣"，那会凭空排掉一堆菜）', () => {
    assert.equal(parseSpicyLevel(null), null)
    assert.equal(parseSpicyLevel(''), null)
    assert.equal(parseSpicyLevel('不限'), null)
    assert.equal(parseSpicyLevel('都可以'), null)
    assert.equal(parseSpicyLevel('0'), 0)
    assert.equal(parseSpicyLevel(3), 3)
    assert.throws(() => parseSpicyLevel('4'), /辣度只能是/)
    assert.throws(() => parseSpicyLevel('很辣'), /辣度只能是/)
  })

  it('荤素："无偏好"等价于没说过', () => {
    assert.equal(parseDiet('无偏好'), null)
    assert.equal(parseDiet(null), null)
    assert.equal(parseDiet('全素'), '全素')
    assert.throws(() => parseDiet('吃素'), /荤素倾向只能是/)
  })

  it('词表：去空白、去重、限量、限长', () => {
    assert.deepEqual(parseTasteProfile({ dislikes: [' 香菜 ', '香菜', '芹菜'] }).dislikes, ['香菜', '芹菜'])
    // 去重忽略大小写（Peanut 与 peanut 是同一个过敏原）
    assert.deepEqual(parseTasteProfile({ allergies: ['Peanut', 'peanut'] }).allergies, ['Peanut'])
    assert.throws(() => parseTasteProfile({ allergies: ['这是一个特别特别长的过敏原名字'] }), /太长了/)
    const many = Array.from({ length: 14 }, (_, index) => `东西${index}`)
    assert.throws(() => parseTasteProfile({ allergies: many }), /最多 12 条/)
  })

  it('全空的词表被丢掉（[null, "", "  "] 不该变成三个空关键词）', () => {
    assert.deepEqual(parseTasteProfile({ dislikes: ['', '  ', null] }).dislikes, [])
  })
})

describe('"还没写"与"写了"', () => {
  it('全空 = 还没写；任何一项有值 = 写了', () => {
    assert.equal(isFilled(profile()), false)
    assert.equal(isFilled(profile({ spicyLevel: 0 })), true)   // 0 是"不吃辣"，不是"没写"
    assert.equal(isFilled(profile({ dislikes: ['香菜'] })), true)
    assert.equal(isFilled(profile({ note: '医生说要少盐' })), true)
  })

  it('还没写的人要**点名**（"妈妈、爸爸还没写"而不是"还有 2 人没写"）', () => {
    // 用户看到具体名字才会去催；看到"还有 2 人"通常只会想"哦"
    const missing = missingProfiles([
      { userId: 'u1', nickname: '妈妈', profile: profile({ allergies: ['花生'] }) },
      { userId: 'u2', nickname: '爸爸', profile: null },
      { userId: 'u3', nickname: '奶奶', profile: profile() },
    ])
    assert.deepEqual(missing, ['爸爸', '奶奶'])
  })
})

describe('一个人的判据（自己点菜时提醒自己）', () => {
  it('不吃辣的人自己点辣菜：warn 而不是静默通过', () => {
    const result = judgementForOne(dish('辣子鸡', ['鸡腿肉', '干辣椒'], 1), {
      userId: 'u1', nickname: '我', profile: profile({ spicyLevel: 0 }),
    })
    assert.equal(result.verdict, 'warn')
    assert.match(result.text, /吃不了辣/)
  })
})

describe('名字带它、其实不含它（真机验收抓出来的误报）', () => {
  it('「鱼香汁」不该命中"鱼"——那是味型，不是鱼', () => {
    /*
     * 这条是**验收脚本跑出来的真问题**：对鱼过敏的人被「鱼香大虾」拦住了，
     * 理由是配料里的「鱼香汁」。鱼是最常见的过敏原之一、鱼香菜是最常见的一类菜，
     * 于是这个人会系统地看不到一整类本该能吃的菜——不是"偶尔误报"。
     */
    assert.equal(hitsKeyword('鱼香汁', '鱼'), false)
    assert.equal(hitsKeyword('鱼香肉丝料', '鱼'), false)
  })

  it('同一道菜里真有的鱼照样命中（挖掉的是"鱼香"两个字，不是"鱼"）', () => {
    // 挖错的话，真正含鱼的菜会漏报——那是比误报严重得多的后果
    assert.equal(hitsKeyword('草鱼', '鱼'), true)
    assert.equal(hitsKeyword('鲫鱼', '鱼'), true)
    assert.equal(hitsKeyword('鱼片', '鱼'), true)
    // 同一条配料里两者都有：挖掉鱼香之后剩下的"草鱼"仍要命中
    assert.equal(hitsKeyword('鱼香草鱼', '鱼'), true)
  })

  it('判据层面同样成立：鱼香肉丝不再拦住对鱼过敏的人', () => {
    const result = judgeDish(dish('鱼香肉丝', ['猪里脊', '鱼香汁', '木耳']), [
      { userId: 'u1', nickname: '妈妈', profile: profile({ allergies: ['鱼'] }) },
    ])
    assert.equal(result.verdict, 'ok')
  })
})
