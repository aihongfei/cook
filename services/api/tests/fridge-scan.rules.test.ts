import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OCR_MAX_ITEMS, parseFridgeScan } from '../src/modules/ai/fridge-scan.rules'
import { FRIDGE_AMOUNT_MAX, FRIDGE_NAME_MAX, FRIDGE_NOTE_MAX } from '../src/modules/fridge/fridge.rules'

/**
 * 冰箱拍照识别的解析（F16-04）。**这块此前一条单测都没有**（F16-03 顺带补上，
 * 因为要动它的提示词，动之前先得有个网）。
 *
 * 它守的是一个**会写库的**功能的入口——虽然产物是草稿（写库要用户逐项确认），
 * 但草稿里多一条假的，用户是会照着它去买的。所以这里的判据是：
 * **宁可少收，不可错收**；而"整批丢掉"又要避免（照片可能是在超市冷柜前拍的，重拍不了）。
 */

function scan(items: unknown[], summary = '冰箱里有几样东西') {
  return parseFridgeScan(JSON.stringify({ summary, items }))
}

describe('解析：能救的救，该丢的丢', () => {
  it('正常的几条都收下', () => {
    const result = scan([
      { name: '牛奶', amount: '一盒', zone: '冷藏', note: '高钙' },
      { name: '土豆', amount: '三颗', zone: '常温' },
    ])
    assert.equal(result.items.length, 2)
    assert.deepEqual(result.items[0], { name: '牛奶', amount: '一盒', zone: '冷藏', zoneGuessed: false, note: '高钙' })
    assert.equal(result.items[1].note, null, '没给的备注是 null，不是空串')
  })

  it('**一条坏了不带走整批**（8 条里 2 条没名字 → 留住 6 条）', () => {
    const result = scan([
      { name: '牛奶' },
      { name: '' },
      { name: '   ' },
      { name: 123 },
      { name: '鸡蛋' },
      null,
      { name: '青菜', zone: '保鲜' },
    ])
    assert.deepEqual(result.items.map((item) => item.name), ['牛奶', '鸡蛋', '青菜'])
  })

  it('名字长得离谱的丢掉（60 字以上那是模型在胡说，不是食材名）', () => {
    const result = scan([{ name: '这是一个非常非常长的描述'.repeat(6) }, { name: '鸡蛋' }])
    assert.deepEqual(result.items.map((item) => item.name), ['鸡蛋'])
  })

  it('名字里的多余空白压掉（模型有时会带回车与连续空格）', () => {
    const result = scan([{ name: '  牛   奶  ' }])
    assert.equal(result.items[0].name, '牛 奶')
  })

  it('同名只留第一条（模型常把同一样写两遍）', () => {
    const result = scan([{ name: '牛奶' }, { name: '牛奶' }, { name: '牛奶', amount: '两盒' }])
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].amount, null, '留的是第一条')
  })

  it(`一次最多 ${OCR_MAX_ITEMS} 样（再多用户核对到烦，照片里也放不下）`, () => {
    const many = Array.from({ length: OCR_MAX_ITEMS + 5 }, (_, i) => ({ name: `食材${i}` }))
    assert.equal(scan(many).items.length, OCR_MAX_ITEMS)
  })

  it('回包根本不是 JSON：报一句能读的话（不是崩溃）', () => {
    for (const bad of ['我不知道这是什么。', '看不太清，能再拍一张吗']) {
      assert.throws(() => parseFridgeScan(bad), /换一张清楚点的|没认出/, `${bad.slice(0, 20)} 该被拒`)
    }
  })

  it('**"一样都没认出来"是正常结果、不是错误**（空数组，不抛）', () => {
    /*
     * 这两种回包（`{}` 与只有 summary 没有 items）代表模型**看了但没敢认**
     * ——它按要求"看不清的不要写"，这正是我们要的行为。
     *
     * 所以这里**刻意不抛**：前端拿到空数组会给用户一条下一步
     * （「这张照片里没认出食材，换一张清楚点的，或者手动记一样」，见 `FridgeScanSheet`），
     * 而抛异常会把它换成一句错误提示、并退出拍照界面——把"没认出来"变成"坏了"。
     */
    for (const empty of ['```json\n{}\n```', '{"summary":"上层好像有两盒东西，看不清是什么","items":[]}']) {
      const result = parseFridgeScan(empty)
      assert.deepEqual(result.items, [], `${empty.slice(0, 20)} 该回空数组`)
    }
    // summary 照旧带出来（界面上那一行"大概有什么"仍然有意义）
    assert.equal(parseFridgeScan('{"summary":"看不清","items":[]}').summary, '看不清')
  })

  it('```json 包裹的那种回包也认（实测真实网关两种都给过）', () => {
    const result = parseFridgeScan('```json\n{"summary":"上层两盒奶","items":[{"name":"牛奶"}]}\n```')
    assert.equal(result.items.length, 1)
    assert.equal(result.summary, '上层两盒奶')
  })
})

describe('存放区：认不出就落冷藏并**标记为猜的**', () => {
  it('四个合法区原样用，且不标"猜的"', () => {
    for (const zone of ['常温', '保鲜', '冷藏', '冷冻']) {
      const item = scan([{ name: '东西', zone }]).items[0]
      assert.equal(item.zone, zone)
      assert.equal(item.zoneGuessed, false, `${zone} 是照片里读出来的，不该标猜`)
    }
  })

  it('模型自创的说法（"冰箱里""保鲜层"）落冷藏并标记（界面上让用户改）', () => {
    for (const zone of ['冰箱里', '保鲜层', '上层', '', undefined, 42]) {
      const item = scan([{ name: '东西', zone }]).items[0]
      assert.equal(item.zone, '冷藏', `${JSON.stringify(zone)} 该落冷藏`)
      assert.equal(item.zoneGuessed, true, `${JSON.stringify(zone)} 该标记为猜的`)
    }
  })
})

describe('数量与备注：截断而不是丢弃', () => {
  it('超长的数量/备注截断（识别结果不该因为一个字太多就整张照片报废）', () => {
    const item = scan([{ name: '牛奶', amount: 'x'.repeat(FRIDGE_AMOUNT_MAX + 10), note: 'y'.repeat(FRIDGE_NOTE_MAX + 10) }]).items[0]
    assert.equal(item.amount?.length, FRIDGE_AMOUNT_MAX)
    assert.equal(item.note?.length, FRIDGE_NOTE_MAX)
  })

  it('数量/备注不是字符串时给 null（不是把数字或对象塞进库里）', () => {
    const item = scan([{ name: '牛奶', amount: 400, note: { a: 1 } }]).items[0]
    assert.equal(item.amount, null)
    assert.equal(item.note, null)
  })

  it('超长的名字截到冰箱的上限（与手填同一个口径）', () => {
    const long = '长'.repeat(FRIDGE_NAME_MAX + 10)
    const item = scan([{ name: long }]).items[0]
    assert.equal(item.name.length, FRIDGE_NAME_MAX)
  })
})

describe('summary', () => {
  it('有就给，超长截断', () => {
    assert.equal(scan([{ name: '牛奶' }], '上层两盒奶').summary, '上层两盒奶')
    assert.equal(scan([{ name: '牛奶' }], 'x'.repeat(200)).summary.length, 120)
  })

  it('没给或不是字符串时是空串（界面据此不显示那一行）', () => {
    assert.equal(parseFridgeScan('{"items":[{"name":"牛奶"}]}').summary, '')
    assert.equal(parseFridgeScan('{"summary":42,"items":[]}').summary, '')
  })
})

describe('保质期**一律不填**（照片里看不到，填了就是编的）', () => {
  it('模型给了也丢掉——这个值驱动"今日先吃"', () => {
    const item = scan([{ name: '牛奶', expiresOn: '2026-10-20', expiry: '2026-10-20' }]).items[0]
    assert.deepEqual(Object.keys(item).sort(), ['amount', 'name', 'note', 'zone', 'zoneGuessed'])
  })
})
