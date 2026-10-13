/**
 * 手边食材 × 菜谱配料 的匹配规则（F5-04 手边食材选菜 / F6-07 库存↔推荐 / F7-02 只买缺的）。
 *
 * 三个功能是**同一个判断**的三个用法：用户手里有几样东西，一道菜还差几样。
 * 所以规则只在这里写一遍，三处都调它——各写一套的话，"辣椒算不算有"在三个页面会给出三个答案。
 *
 * 判断的误差方向是这一节的全部要害（与 `shopping.rules` 拒绝合并同义词是同一条线）：
 * 说错"你有了"的代价是用户**少买一样**、站到灶台前才发现做不成菜；说错"你没有"只是多买一根葱。
 * 所以宁可漏认，不可错认——凡是需要**品类推断**的地方一律不认（见下 ②）。
 *
 * 三条刻意的规则：
 *
 * ① **调料不算数**。菜谱库里 827 个配料名、出现次数里 **56.9% 是油盐酱醋糖料酒葱姜蒜水淀粉鸡精**
 *    （盐 400 次、油 239 次、姜 147 次……）。它们要是算进"还差几样"，**每一道菜都差三五样**，
 *    这个功能就废了——用户每次看到的都是"买盐、买油"。所以调料在**两边都跳过**：
 *    既不算"还差"，也不算"用上了"（"用上了冰箱里的盐"是句废话）。
 *    代价是**默认用户厨房里有这些**，所以界面上必须把这句话说出来（不能默默假设）。
 *
 * ② **匹配只做三件事：等值、别名、切法**，其余一律不认。
 *    - **切法**（`猪肉` 满足 `猪肉末`／`猪肉丝`／`去皮土豆`）：末/丝/丁/片/块/馅/去皮/水发 这些是
 *      "怎么切"，不影响买不买，认得；
 *    - **别名**（`番茄` = `西红柿`、`马铃薯` = `土豆`）：下面那张表是**人工列的、短的**，
 *      只收"确定是同一样东西"的；
 *    - **不做品类推断**：`五花肉` **不**满足 `猪肉`，`老抽` **不**满足 `生抽`，`糯米` **不**满足 `大米`。
 *      这是一条**有意的拒绝**——判断"五花肉算不算猪肉"需要一张菜市场品类树，而猜错了就是
 *      少买一样肉。用户看到"还差五花肉"只会去买；看到"你有猪肉就够了"却做不出那道菜才叫坑。
 *
 * ③ **"全都有"是最高级别的话**，只在真全有的时候说：missing 为空才叫齐。
 *    差几样就**把名字列出来**（不是只说"差两样"）——用户要拿这份清单去决定做什么。
 */

import { BadRequestException } from '@nestjs/common'

/**
 * 调料（**两边都跳过**，见文件头 ①）。
 *
 * 收进来的判据只有一条：**少了它会让任何中国家庭觉得"这不算缺"的东西**。
 * 葱姜蒜在列（几乎每家都有）但**红枣/枸杞/桂圆不在列**——它们是甜品和汤的**主角**
 * （"红枣银耳羹"少红枣就不是那道菜了），把主角当调料等于骗用户"你有银耳就能做"。
 * 同理 芝麻/白芝麻/黑芝麻 只作撒面用，在列；而 花椒/干辣椒 这些香辛料在列。
 */
export const SEASONINGS: readonly string[] = [
  // 油
  '油', '食用油', '植物油', '色拉油', '橄榄油', '菜籽油', '玉米油', '花生油', '调和油', '猪油', '黄油', '豆油', '菜油', '茶油', '葵花籽油', '芝麻油', '香油', '麻油', '花椒油', '辣椒油', '红油', '藤椒油', '葱油',
  // 盐糖
  '盐', '精盐', '食盐', '糖', '白糖', '白砂糖', '砂糖', '绵白糖', '冰糖', '红糖', '蜂蜜',
  // 酱醋酒
  '生抽', '老抽', '酱油', '蒸鱼豉油', '味极鲜', '醋', '香醋', '陈醋', '白醋', '米醋', '白米醋', '醋精',
  '料酒', '黄酒', '老酒', '白酒', '米酒', '花雕酒', '啤酒', '红酒', '豆瓣酱', '郫县豆瓣酱', '甜面酱', '黄豆酱', '番茄酱', '沙拉酱', '芝麻酱', '花生酱', '蚝油', '豆豉', '剁椒', '剁辣椒', '泡椒', '老干妈',
  // 增鲜
  '鸡精', '味精', '鸡粉', '高汤', '高汤精', '鸡汤', '骨头汤', '清汤',
  // 水
  '水', '清水', '温水', '开水', '热水', '凉水', '凉开水', '纯净水', '冰水', '淡盐水',
  // 粉类
  '淀粉', '生粉', '玉米淀粉', '土豆淀粉', '水淀粉', '红薯淀粉', '木薯粉', '豌豆淀粉', '面粉用淀粉',
  // 香辛料
  '胡椒粉', '白胡椒粉', '黑胡椒粉', '花椒粉', '五香粉', '十三香', '孜然', '孜然粉', '辣椒粉', '咖喱粉', '黑胡椒', '白胡椒',
  '花椒', '花椒粒', '八角', '桂皮', '香叶', '草果', '陈皮', '丁香', '小茴香', '干辣椒', '小米椒', '小米辣', '辣椒段', '干辣椒段',
  '白芝麻', '黑芝麻', '熟白芝麻', '熟黑芝麻', '芝麻',
  // 葱姜蒜
  '葱', '小葱', '大葱', '香葱', '小香葱', '葱白', '姜', '生姜', '老姜', '蒜', '大蒜', '蒜子', '蒜头', '蒜瓣', '大蒜瓣', '姜汁', '蒜汁',
  /*
   * 葱姜蒜的**形态要一个个写出来**，不能靠剥词（与下面 PREP_SUFFIX 不收「花/清/黄」同一件事）：
   * 这些是数据里真实出现的写法（葱花 29 次、蒜末 10 次、姜末 8 次……），漏一个它就被当成
   * "要买的东西"——用户看到"还差葱花"只会觉得这功能在胡闹。
   */
  '葱花', '葱末', '葱丝', '葱段', '大葱段', '小葱花', '葱蒜', '葱蒜末',
  '姜末', '姜丝', '姜片', '生姜末', '生姜片', '姜蓉', '姜块',
  '蒜末', '蒜片', '蒜蓉', '蒜碎', '蒜泥', '大蒜末', '蒜米',
  // 发酵/膨松
  '酵母', '酵母粉', '泡打粉', '小苏打', '食用碱', '碱面',
  // 香菜（常见到"没有就不算缺"，但确实有人不吃——那是口味档案的事，不是库存的事）
  '香菜', '芫荽',
]

const SEASONING_SET = new Set(SEASONINGS)

/**
 * 别名分组：**每组第一个是代表名**，其余都当成同一样东西。
 *
 * 收录标准只有一个：**这两样在"要不要买"这件事上完全等价**。所以：
 * - `面粉` 一组收中筋/高筋/低筋/小麦面粉（做菜时家里有什么用什么）；
 * - `葱` 一组收小葱/大葱/香葱，但**不收洋葱**（不同物种，别搞成"你有葱就能做洋葱炒蛋"）；
 * - `木耳`＝黑木耳/云耳，`银耳`＝白木耳/雪耳，**两者不合并**（一个凉拌一个炖甜汤）；
 * - `白菜`＝大白菜，**不收娃娃菜**，也不跟`小白菜`（青菜/油菜/上海青）合并；
 * - `豆腐`＝嫩豆腐/老豆腐/北豆腐/南豆腐/内酯豆腐，**不收豆腐皮/豆腐干/腐竹**（那是另一样东西）；
 * - `蛋` 不在别名表里，只有 `鸡蛋`；`鹌鹑蛋`/`皮蛋`/`咸蛋` 各自独立。
 *
 * 与 D-039 拒绝合并"生抽/酱油"同一个理由：**合并错了用户就少买一样**。
 */
export const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['番茄', '西红柿'],
  ['土豆', '马铃薯', '洋芋'],
  ['红薯', '地瓜', '番薯', '山芋', '甘薯'],
  ['面粉', '小麦面粉', '中筋面粉', '高筋面粉', '低筋面粉', '普通面粉', '饺子粉'],
  ['木耳', '黑木耳', '云耳', '秋木耳'],
  ['银耳', '白木耳', '雪耳'],
  ['葱', '小葱', '大葱', '香葱', '小香葱', '葱白'],
  ['姜', '生姜', '老姜', '嫩姜', '子姜'],
  ['蒜', '大蒜', '蒜子', '蒜头', '蒜瓣', '大蒜瓣'],
  ['白菜', '大白菜'],
  ['小白菜', '青菜', '油菜', '上海青'],
  ['香菜', '芫荽'],
  ['虾', '大虾', '鲜虾', '海虾', '基围虾', '对虾', '河虾', '青虾'],
  ['里脊', '猪里脊', '里脊肉'],
  ['瘦肉', '猪瘦肉'],
  ['豆腐', '嫩豆腐', '老豆腐', '北豆腐', '南豆腐', '内酯豆腐'],
  ['玉米', '玉米粒', '甜玉米', '嫩玉米'],
  ['豌豆', '青豆'],
  ['花菜', '菜花'],
  ['包菜', '卷心菜', '圆白菜', '莲花白', '疙瘩白'],
  ['猕猴桃', '奇异果'],
  ['南瓜', '倭瓜'],
  ['米粉', '米线'],
  ['五花肉', '猪五花肉', '五花肉末', '五花肉片', '五花肉丝'],
  ['鸡胸肉', '鸡胸', '鸡脯肉'],
  ['花生', '花生米', '花生仁', '生花生'],
  ['挂面', '面条', '鲜面条', '湿面条', '龙须面', '细面条'],
]

const ALIAS = new Map<string, string>()
for (const group of ALIAS_GROUPS) {
  for (const name of group) ALIAS.set(name, group[0])
}

/**
 * 切法/处理（**认，因为不影响买不买**）。
 *
 * 分两处出现（`去皮土豆` / `土豆块`），所以两端都要剥；剥完再比。
 *
 * 三个**刻意不收**的，都是同一个理由——**它不是"切法"而是"另一样东西"**：
 * - `皮`：`豆腐皮` 剥成 `豆腐` 就变成"有豆腐就算有豆腐皮"（这是最典型的错认）；
 * - `清`/`黄`：`鸡蛋清` 剥成 `鸡蛋` 会让"只有蛋清"的人以为够做要整蛋的菜。
 *   这是**有方向**的事：有整蛋确实能出蛋清，反过来不行，而匹配是无方向的等值比较，
 *   那就两个方向都不认（少说一句"你有"而已，代价是 4 道要蛋清的菜会显示差一样）；
 * - `花`：`韭菜花`≠`韭菜`、`西兰花` 会被剥成没有意义的 `西兰`。葱姜蒜的形态改用
 *   调料表逐条列（见 SEASONINGS）——**列举比剥词准**，代价是漏一个新写法，而漏了只是多列一行。
 * - 也不收 `大/小/鲜/生/熟/猪/鸡`：`小白菜`≠`白菜`、`鲜虾`≠`虾`。
 */
const PREP_PREFIX = ['去皮', '去壳', '去骨', '去蒂', '去核', '去头', '去尾', '去籽', '去筋', '洗净', '沥干', '冲净', '水发', '泡发', '焯水', '焯过水', '切好', '剁碎', '新鲜']
const PREP_SUFFIX = ['末', '碎', '沫', '丝', '丁', '片', '块', '段', '条', '粒', '蓉', '泥', '馅', '肉']

/**
 * 剥掉切法词，直到剥不动或只剩一个字。
 *
 * 留一个字的底线：`葱花` → `葱`（对），但不能再往前剥（否则 `蒜末` 会剥成空）。
 * 这条底线同时也是**长度 2 的名字保护**：`粉丝`/`面条`/`肉丝`/`蛋清` 都不会被剥
 * （剥了会变成 `粉`/`面`/`肉`/`蛋` 这些别的意思）。
 */
function stripPrep(raw: string): string {
  let text = raw
  for (let round = 0; round < 4; round += 1) {
    const before = text
    for (const prefix of PREP_PREFIX) {
      if (text.length > prefix.length + 1 && text.startsWith(prefix)) {
        text = text.slice(prefix.length)
        break
      }
    }
    for (const suffix of PREP_SUFFIX) {
      if (text.length > suffix.length + 1 && text.endsWith(suffix)) {
        text = text.slice(0, -suffix.length)
        break
      }
    }
    if (text === before) break
  }
  return text
}

/**
 * 配料名 → 干净的词。
 *
 * 库里的名字是从公开菜谱导入的，脏得过：`鸡蛋1个`、`000面粉`、`生姜 少许`、`盐 少许`、
 * `五花肉（带皮）`。这些不清理，匹配会大面积落空（而且落空是**静默**的——功能看起来在跑，
 * 只是永远说"还差"）。所以依次去掉：括号注释 → 数量与标点 → 空白后的尾巴 → 切法词。
 */
export function baseName(raw: string): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, '')
    /*
     * 数字**连它后面的单位一起删**（`鸡蛋1个`、`番茄2个`、`面粉500g`）：
     * 只删数字会剩个孤零零的「个」——`鸡蛋1个` 变成 `鸡蛋个`，匹配不上任何东西。
     * 单位表不必全：删不掉的尾字在 `stripPrep` 那里还有机会被剥掉。
     */
    .replace(/[0-9０-９]+\s*[个只条根颗棵克gG斤两片块袋盒包把勺碗杯升毫升mlML寸朵瓣头束]*/g, '')
    // 去掉尾巴上的"少许/适量"这类**整词**，不是去掉这些字：按字去会把「豆干」剥成「豆」
    .replace(/(少许|适量|若干|些许|多点|一点点|一斤|半斤)$/g, '')
    .split(/[\s　]+/)[0]
    .replace(/[、,，。.\-—/／+＋*＊:：;；"'"'`~～!！?？]/g, '')
    .trim()
}

/**
 * 代表名：**先查别名表，再剥切法，剥完再查一次**。
 *
 * 顺序不能反过来。`猪五花肉` 先剥就成了 `猪五花`（`肉` 被剥掉），再去查别名表已经查不到了——
 * 而别名表里明明写着它是 `五花肉`。**已知的名字优先于机械剥词**：
 * 表里收的都是人工确认过的同一样东西，机械剥词只是兜底。
 */
export function canonicalName(raw: string): string {
  const base = baseName(raw)
  const known = ALIAS.get(base)
  if (known) return known
  const stripped = stripPrep(base)
  return ALIAS.get(stripped) ?? stripped
}

/**
 * 这个名字算不算调料（**只看配料表这一侧**——冰箱里的东西不看这个）。
 *
 * 判在 `canonicalName` 之后：这样 `精盐`（别名表没有但调料表里有）、`生姜`、`蒜末` 都能命中。
 * 剥完查不到就再查一次剥之前的原词：`熟白芝麻`→剥成`白芝麻`在表里；`十三香` 剥不动，也在表里。
 */
export function isSeasoning(raw: string): boolean {
  const canonical = canonicalName(raw)
  if (SEASONING_SET.has(canonical)) return true
  return SEASONING_SET.has(baseName(raw))
}

/**
 * 手边有 `pantry`，够不够做需要 `ingredient` 的那一步？
 *
 * 只有代表名相同才算——**没有包含、没有模糊、没有品类**（文件头 ②）。
 */
export function satisfies(pantry: string, ingredient: string): boolean {
  const a = canonicalName(pantry)
  const b = canonicalName(ingredient)
  return a !== '' && a === b
}

/** 一道菜的配料比对结果 */
export interface DishMatch {
  /** 用上了手边的哪几样（**按用户自己的说法**回显："用上了五花肉"，不是"猪肉"） */
  have: string[]
  /** 还差哪几样（不含调料；已经归一到代表名，界面上不会同时出现"番茄"和"西红柿"） */
  missing: string[]
  /** 这道菜**要买**的样数（不含调料）——`missing.length + have.length` */
  needed: number
}

/**
 * 比一道菜。
 *
 * 返回 `null` 表示**这道菜不该出现在结果里**：配料表是空的，或者剥掉调料之后一样都不剩
 * （纯调料的做法，比如一碟蘸水）。这种菜说什么都不对——说"全都有"是骗人（我们并不知道
 * 用户有没有那些调料），说"缺三样"又是在让他去买盐。干脆不提。
 */
export function matchDish(
  ingredients: readonly { name: string }[],
  pantry: readonly string[],
): DishMatch | null {
  const have: string[] = []
  const missing: string[] = []
  const pantryKeys = new Map(pantry.map((name) => [canonicalName(name), name]))

  for (const item of ingredients) {
    const name = baseName(item.name)
    if (!name || isSeasoning(item.name)) continue
    const key = canonicalName(item.name)
    if (!key) continue
    const hit = pantryKeys.get(key)
    if (hit) {
      // 同一样东西在菜里写了两遍（"猪肉"与"猪肉末"）只算一次
      if (!have.includes(hit)) have.push(hit)
    } else if (!missing.includes(key)) {
      missing.push(key)
    }
  }

  if (have.length === 0 && missing.length === 0) return null
  return { have, missing, needed: have.length + missing.length }
}

/** 排好序的一行（服务层补菜名/图之后就是接口的 `items`） */
export interface RankedMatch extends DishMatch {
  recipeId: string
  /** 菜名：**排序与同名去重都要用它**（库里允许重名，见 `rankMatches`） */
  name: string
  /** 还差几样（= `missing.length`，单独给一个字段：前端排序/分组不必数数组） */
  missingCount: number
}

/** 一页最多几道（选了食材之后要"扫一眼决定做什么"，不是又给一个菜谱列表） */
export const COOKABLE_LIMIT_DEFAULT = 12
export const COOKABLE_LIMIT_MAX = 30
/**
 * 从第几道开始（0 基）。给「看全部」那一页翻页用。
 *
 * 上限存在的意义只是别让人拿 `offset=999999` 来探边界：菜谱库一共几百道，
 * 1000 已经远超任何真实结果集，超了就是参数写错了——明说，不静默截断。
 */
export const COOKABLE_OFFSET_MAX = 1000
/** 默认容忍差几样：差 1 样是"顺路买一下"，差 2 样以上就不叫"手边食材能做的"了 */
export const MAX_MISSING_DEFAULT = 1
export const MAX_MISSING_MAX = 3

export function parseCookableLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return COOKABLE_LIMIT_DEFAULT
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(value) || value < 1 || value > COOKABLE_LIMIT_MAX) {
    throw new BadRequestException(`一页要在 1～${COOKABLE_LIMIT_MAX} 道之间`)
  }
  return value
}

export function parseCookableOffset(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(value) || value < 0 || value > COOKABLE_OFFSET_MAX) {
    throw new BadRequestException(`从第几道开始要在 0～${COOKABLE_OFFSET_MAX} 之间`)
  }
  return value
}

export function parseMaxMissing(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return MAX_MISSING_DEFAULT
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(value) || value < 0 || value > MAX_MISSING_MAX) {
    throw new BadRequestException(`最多只能容忍差 ${MAX_MISSING_MAX} 样`)
  }
  return value
}

/**
 * 排序 + 两个筛选：**只留有"用上你的东西"的** → **同名菜只留一道** → 差得少的在前
 * → 用上自己东西多的在前 → 用料少的在前 → 名字。
 *
 * 第一条（`have.length > 0`）不是排序而是**筛选**，而且是这个功能成不成立的关键：
 * 不留它，一页里会挤满"只需要一样东西"的菜（凉拌黄瓜差一样黄瓜、蒸蛋差一样鸡蛋）——
 * 而你手边**一样都没有**。那已经不是"手边食材选菜"，是"用料最少的菜"。
 *
 * 第二条（同名去重）是浏览器验收看出来的真问题：库里 **579 个不同的名字占了 612 行、
 * 33 行是重名**（「番茄炒蛋」3 份、「苹果燕麦粥」5 份、「麻婆豆腐」4 份——来自不同来源的
 * 同一道菜）。不去重时 12 个格子里连着三行「番茄炒蛋」，用户看到的是**列表坏了**，
 * 而不是"这道菜有好几个版本"。
 *
 * 留哪一道：**排序后留第一个**，也就是"更少要买、更用得上你冰箱"的那个版本——
 * 两个同名菜里让他先看到最好做的那一份。这是**有意的取舍**：同一道菜的不同版本
 * 只在做法细节上有差别，而用户此刻要决定的是"今晚做不做这道菜"，不是"跟哪个版本做"。
 * 想看别的版本，菜谱大全里搜得到（那里按菜谱收录，不去重）。
 *
 * 第三条（用上得多）是"清库存"这个用途的落点：同样是"不用买就能做"，
 * 用掉冰箱里三样的那道人更愿意做（冰箱里的东西在往坏的方向走）。
 * 最后两层是为了**同分有确定顺序**：没有它，两次请求可能给出不同的顺序（与 `rankPicks` 同一条理由）。
 */
export function rankMatches(rows: readonly { recipeId: string; name: string; match: DishMatch }[], maxMissing: number): RankedMatch[] {
  const ranked = rows
    .filter((row) => row.match.have.length > 0 && row.match.missing.length <= maxMissing)
    .map((row) => ({ recipeId: row.recipeId, name: row.name, missingCount: row.match.missing.length, ...row.match }))
    .sort(
      (a, b) =>
        a.missingCount - b.missingCount ||
        b.have.length - a.have.length ||
        a.needed - b.needed ||
        a.name.localeCompare(b.name, 'zh') ||
        a.recipeId.localeCompare(b.recipeId),
    )

  const seen = new Set<string>()
  return ranked.filter((row) => {
    if (seen.has(row.name)) return false
    seen.add(row.name)
    return true
  })
}

/** 一次最多比几样手边食材：再多也匹配不到新菜，而请求体是用户手打的 */
export const PANTRY_MAX = 200

/**
 * 解析前端传来的食材清单（`?ingredients=鸡蛋,土豆` 或数组）。
 *
 * 去空、去重（按代表名）、限量。**不校验是不是"真的食材"**：用户手打"我妈腌的咸菜"也是他的食材，
 * 拿它去比自然比不中任何菜，那是对的（我们不认识它，就不该假装认识）。
 */
export function parsePantry(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,，、\n]/) : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const name = typeof item === 'string' ? item.trim().slice(0, 40) : ''
    if (!name) continue
    const key = canonicalName(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= PANTRY_MAX) break
  }
  return out
}
