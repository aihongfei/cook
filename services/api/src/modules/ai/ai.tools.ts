import { MealSlot, OrderStatus } from '@prisma/client'
import { MEAL_LABEL, ORDER_DAY_SPAN, ORDER_STATUSES } from '../orders/orders.rules'

/**
 * AI 的**内置工具**（用户 2026-10-12 第③项需求）。口径见 D-026 第三次补充。
 *
 * 用户原话：「写几个内置的工具，比如说我在对话中可以直接插入点菜什么的，然后每句话的最后，
 * 或者说如果有菜的情况下的每句话的后面，询问我一下是否需要点击加入菜单这种」。
 *
 * 因此这里有两条铁律，都由本文件设计保证：
 * 1. **模型不许自己造 id**：要推荐菜就得先 `search_dishes` 拿真实 id，`propose_menu_items`
 *    里的 id 一律再拿库核对一遍——对不上就丢掉。模型编一个 id 就等于界面上凭空多出一道没的菜。
 * 2. **工具只"提名"，不"下单"**：`propose_menu_items` 一个字节都不写库，它只把建议回给界面，
 *    **用户点了"加入菜单"才真的写入**（走与手点同一套 `/orders/items`）。
 *    让模型直接改用户家的菜单是不可接受的——它可能理解错"今晚想吃鱼"里的"鱼"。
 *
 * 这个文件**不碰网络也不碰数据库**（拿库核对的部分由调用方把数据查好传进来），
 * 所以校验逻辑可以直接单测，不用起 MySQL 也不用真模型。
 */

/** 工具名常量：字符串散在各处迟早拼错（拼错的表现是模型收到一个不存在的工具，静默不调） */
export const TOOL_SEARCH_DISHES = 'search_dishes'
export const TOOL_PROPOSE_MENU_ITEMS = 'propose_menu_items'
export const TOOL_READ_PLAN = 'read_plan'
/** 冰箱四件（F16-10 / D-052 的 **A 档**：真的写库，但每笔都带撤销） */
export const TOOL_READ_FRIDGE = 'read_fridge'
export const TOOL_ADD_FRIDGE_ITEMS = 'add_fridge_items'
export const TOOL_UPDATE_FRIDGE_ITEM = 'update_fridge_item'
export const TOOL_REMOVE_FRIDGE_ITEM = 'remove_fridge_item'
/** 自建菜谱与收藏（F1-11/F1-12/F1-09；用户 2026-10-13：「软件的 CRUD ai 都可以操作」） */
export const TOOL_READ_RECIPES = 'read_recipes'
export const TOOL_CREATE_RECIPE = 'create_recipe'
export const TOOL_UPDATE_RECIPE = 'update_recipe'
export const TOOL_DELETE_RECIPE = 'delete_recipe'
export const TOOL_TOGGLE_FAVORITE = 'toggle_favorite'
/**
 * 菜单、餐次与组合（用户 2026-10-13 的「软件的 CRUD ai 都可以操作」）。
 *
 * 菜单为什么也放 A 档（真的写库）：它和冰箱是同一层——**自家这一餐的事**，
 * 而且每笔都留了反向动作（撤菜 / 放回去 / 改回去），用户点一下就能回到原样。
 * 状态流转是唯一的例外：状态机本身单向（见 orders.rules），撤销在数据上不成立，
 * 所以那个工具的回执上没有「撤」，且提示词要求只在用户明说时才动它。
 */
export const TOOL_READ_MENU = 'read_menu'
export const TOOL_ADD_MENU_ITEMS = 'add_menu_items'
export const TOOL_REMOVE_MENU_ITEM = 'remove_menu_item'
export const TOOL_SET_DINERS = 'set_diners'
export const TOOL_SET_MEAL_STATUS = 'set_meal_status'
export const TOOL_REPEAT_MEAL = 'repeat_meal'
export const TOOL_READ_COMBOS = 'read_combos'
export const TOOL_CREATE_COMBO = 'create_combo'
export const TOOL_UPDATE_COMBO = 'update_combo'
export const TOOL_DELETE_COMBO = 'delete_combo'
export const TOOL_ADD_COMBO_TO_MEAL = 'add_combo_to_meal'

/** 一次最多往冰箱里记几样（模型会一口气倒出十几条，见 D-052 的护栏） */
export const FRIDGE_ADD_MAX = 8
/** 一次最多往菜单里加几道（同上：模型偶尔会把整周菜单一口气倒出来） */
export const MENU_ADD_MAX = 8

/** 一轮里最多核几个提议（模型偶尔会把整周的菜一次性倒出来） */
export const PROPOSALS_MAX = 6
/** 搜索一次最多回几道（回太多模型挑花眼，也吃掉上下文） */
export const SEARCH_RESULTS_MAX = 8
/** 工具循环最多几轮。3 轮够"搜→提→收尾"；再多就是模型在原地打转，烧时间也烧额度 */
export const TOOL_ROUNDS_MAX = 3

/** OpenAI 兼容的工具声明。`additionalProperties:false` + `required` 是为了让参数形状确定 */
export const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: TOOL_SEARCH_DISHES,
      description: '在家庭菜谱库里按关键词搜菜，返回真实的菜名与 id。想给用户推荐菜、或要往菜单里加菜时，必须先调用它拿到真实 id，不要凭记忆写菜名。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，如「番茄」「清淡」「快手」「汤」' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_PROPOSE_MENU_ITEMS,
      description: '把挑好的菜作为「要加进菜单」的建议提给用户，界面上会出现确认按钮，用户点了才会真的加。你必须先调 search_dishes 拿到真实 id 再来调这个。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: `要提给用户确认的菜，最多 ${PROPOSALS_MAX} 道`,
            items: {
              type: 'object',
              properties: {
                recipeId: { type: 'string', description: 'search_dishes 返回的真实 id' },
                mealDate: { type: 'string', description: '日期，YYYY-MM-DD。用户没说就用今天' },
                meal: { type: 'string', enum: ['LUNCH', 'DINNER'], description: '午餐还是晚餐' },
                note: { type: 'string', description: '可选的备注，如「少放辣」' },
              },
              required: ['recipeId', 'mealDate', 'meal'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_READ_PLAN,
      description: '读这个家最近的菜单安排（哪一天哪一餐已经点了什么），用来避免重复推荐。',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '往后看几天，默认 3' } },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_READ_FRIDGE,
      description: '读家里冰箱现在有什么（分区、数量、保质期）。要改或要删冰箱里的东西之前**必须先调它**，'
        + '拿到准确的名字与 id——凭记忆操作会删错东西。',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_ADD_FRIDGE_ITEMS,
      description: '把食材记进冰箱。**这个工具会真的写库**（用户已经同意），所以只在他明确说了要记什么的时候调，'
        + `一次最多 ${FRIDGE_ADD_MAX} 样。用户说"买了鸡蛋和牛奶"就是一次调用传两样，不要一样调一次。`
        + '写完界面会给用户一张可撤销的回执卡，所以你**可以说"记好了"**，但不能编造没记成的东西。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: `要记的食材，最多 ${FRIDGE_ADD_MAX} 样`,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '食材名，如「鸡蛋」' },
                amount: { type: 'string', description: '数量，可空，如「一盒」「约 500g」' },
                zone: { type: 'string', enum: ['常温', '保鲜', '冷藏', '冷冻'], description: '放哪儿。不确定就按食材常识，冷藏是常见默认' },
                expiresOn: { type: 'string', description: '保质期 YYYY-MM-DD，可空。**用户没说的不要编**，编了他会以为那天真的坏' },
                note: { type: 'string', description: '备注，可空，如「给奶奶买的」' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_UPDATE_FRIDGE_ITEM,
      description: '改冰箱里已有的一样东西（数量、位置、保质期、名字）。**会真的写库**。'
        + `必须先调 ${TOOL_READ_FRIDGE} 拿到它的 id；只传要改的字段，不传的保持原样。`,
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: `${TOOL_READ_FRIDGE} 返回的 id` },
          name: { type: 'string', description: '新名字（改名时才传）' },
          amount: { type: 'string', description: '新数量' },
          zone: { type: 'string', enum: ['常温', '保鲜', '冷藏', '冷冻'], description: '新存放区' },
          expiresOn: { type: 'string', description: '新保质期 YYYY-MM-DD' },
          note: { type: 'string', description: '新备注' },
        },
        required: ['itemId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_REMOVE_FRIDGE_ITEM,
      description: '把冰箱里的一样东西拿掉（吃完了/扔了）。**会真的写库**。'
        + `必须先调 ${TOOL_READ_FRIDGE} 拿到 id，且要能对上用户说的那一样——`
        + '用户没点名具体哪样时先问清，不要替他挑一个。',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: `${TOOL_READ_FRIDGE} 返回的 id` },
        },
        required: ['itemId'],
        additionalProperties: false,
      },
    },
  },
  /*
   * ---------- 自建菜谱（F1-11 / F1-12；用户 2026-10-13：
   *            「自己上传的…这块也可以用 ai 直接添加进去」）----------
   *
   * 与冰箱同一档（A 档：真的写库 + 回执卡 + 可撤），但有**一条独有的边界**：
   * 只能动**这个家自己上传的**菜谱。库里的公共菜谱（极速/jumdata 那些）是外部数据的镜像，
   * 谁都不许改——用户想调整就让他复制一份成自己的（写库服务会拒，并把这句话回给模型）。
   * 这道边界**不靠提示词里让模型自觉**，而是硬拦在服务层（与"AI 走用户自己那套服务"同一原则）。
   */
  {
    type: 'function',
    function: {
      name: TOOL_READ_RECIPES,
      description: '按名字或关键词找菜谱，并给出它是不是**用户自己上传的**。'
        + `要改或要删菜谱之前必须先调它拿到 id（与 ${TOOL_READ_FRIDGE} 同一条规矩：不许凭记忆操作）。`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '菜名或关键词，如「番茄炒蛋」「番茄」' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_CREATE_RECIPE,
      description: '把一道菜谱存进「我家的菜谱」。**会真的写库**。'
        + '用户口述自家做法（"我家的红烧肉是这么做的…"）时用它。'
        + '**名字、品类、菜系、至少一步做法是必填的**；配料与用量用户没说的不要编'
        + '（编了他会照着买错东西），宁可留空等他补。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '菜名' },
          category: { type: 'string', description: '品类，如「荤菜」「汤」「主食」；拿不准用「家常」' },
          cuisine: { type: 'string', description: '菜系，如「家常」「川菜」；拿不准用「家常」' },
          ingredients: {
            type: 'array',
            description: '配料。用量不确定就留空，不要编一个数',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '配料名，如「五花肉」' },
                amount: { type: 'string', description: '用量，可空，如「500g」' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
          steps: { type: 'array', items: { type: 'string' }, description: '做法步骤，一步一句，至少一步' },
          notes: { type: 'array', items: { type: 'string' }, description: '小窍门/注意事项，可空' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，可空，如「快手」「下饭」' },
          calories: { type: 'number', description: '热量（千卡/份），可空；不确定就不要填' },
        },
        required: ['name', 'category', 'cuisine', 'steps'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_UPDATE_RECIPE,
      description: '改一道**自己上传的**菜谱（做法、配料、名字等）。**会真的写库**。'
        + `必须先调 ${TOOL_READ_RECIPES} 拿到 id；公共菜谱改不了（工具结果会说明原因）。`
        + '**只传要改的那些字段**——没传的保持原样，不要把整份菜谱重写一遍。',
      parameters: {
        type: 'object',
        properties: {
          recipeId: { type: 'string', description: `${TOOL_READ_RECIPES} 返回的 id` },
          name: { type: 'string', description: '新菜名（改名时才传）' },
          category: { type: 'string' },
          cuisine: { type: 'string' },
          ingredients: {
            type: 'array',
            description: '新的完整配料表（改配料时才传；传了就是整表替换）',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, amount: { type: 'string' } },
              required: ['name'],
              additionalProperties: false,
            },
          },
          steps: { type: 'array', items: { type: 'string' }, description: '新的完整步骤（改步骤时才传）' },
          notes: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          calories: { type: 'number' },
        },
        required: ['recipeId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_DELETE_RECIPE,
      description: '删掉一道**自己上传的**菜谱。**会真的写库**（删错了能撤回来）。'
        + `必须先调 ${TOOL_READ_RECIPES} 拿到 id，且要能对上用户说的那道——`
        + '用户没点名时先问清，不要替他挑一个。公共菜谱删不了。',
      parameters: {
        type: 'object',
        properties: {
          recipeId: { type: 'string', description: `${TOOL_READ_RECIPES} 返回的 id` },
        },
        required: ['recipeId'],
        additionalProperties: false,
      },
    },
  },
  /*
   * ---------- 收藏（F1-09，A 档）----------
   * 收藏**按人存**（"我爱吃这个"），只影响自己，所以与冰箱同档：直接改 + 回执可撤。
   */
  {
    type: 'function',
    function: {
      name: TOOL_TOGGLE_FAVORITE,
      description: '收藏或取消收藏一道菜（同一个开关：已经收藏了就取消）。**会真的写库**。'
        + `必须先调 ${TOOL_SEARCH_DISHES} 或 ${TOOL_READ_RECIPES} 拿到真实 id。`,
      parameters: {
        type: 'object',
        properties: {
          recipeId: { type: 'string', description: '菜谱 id' },
        },
        required: ['recipeId'],
        additionalProperties: false,
      },
    },
  },
  /*
   * ---------- 菜单、餐次与组合（A 档）----------
   * 与冰箱同一档：真的写库 + 回执可撤。**唯一的例外是状态流转**（没撤销，见上面说明）。
   */
  {
    type: 'function',
    function: {
      name: TOOL_READ_MENU,
      description: '读这个家最近的菜单安排：每一天午/晚餐的状态、就餐人数、已经点了哪些菜，'
        + '每道带 **itemId**。要撤菜、改人数、改状态、或照抄某一餐之前**必须先调它**。',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer', description: '往后看几天，默认 3，最多 7' } },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_ADD_MENU_ITEMS,
      description: '把菜加进某一天某一餐。**会真的写库**（每道一张回执，可以撤）。'
        + `用户明确说"加进去/点上/来一道"时用它；只是想要推荐、还没定的时候用 ${TOOL_PROPOSE_MENU_ITEMS}。`
        + `菜谱里的菜传 recipeId（先 ${TOOL_SEARCH_DISHES} 拿真实 id），用户口述的菜传 dishName。`
        + `一次最多 ${MENU_ADD_MAX} 道。`,
      parameters: {
        type: 'object',
        properties: {
          mealDate: { type: 'string', description: 'YYYY-MM-DD，用户没说就用今天' },
          meal: { type: 'string', enum: ['LUNCH', 'DINNER'], description: '午餐还是晚餐' },
          items: {
            type: 'array',
            description: '要加的菜，每道传 recipeId 或 dishName 之一',
            items: {
              type: 'object',
              properties: {
                recipeId: { type: 'string', description: '菜谱 id（与 dishName 二选一）' },
                dishName: { type: 'string', description: '用户口述的菜名，如「我妈教的糖醋排骨」（与 recipeId 二选一）' },
                note: { type: 'string', description: '可选的备注，如「少放辣」' },
              },
              required: [],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_REMOVE_MENU_ITEM,
      description: '从菜单里撤掉一道菜（吃不了了/不想吃了）。**会真的写库**（能放回去）。'
        + `必须先调 ${TOOL_READ_MENU} 拿到 itemId，且要能对上用户说的那道——`
        + '用户没点名时先问清，不要替他挑。**只能撤用户自己点的菜**（别人点的撤不了）。',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string', description: `${TOOL_READ_MENU} 返回的 itemId` },
        },
        required: ['itemId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_SET_DINERS,
      description: '设定某一餐的就餐人数（掌勺人才有权限）。**会真的写库**（能改回去）。'
        + `必须先调 ${TOOL_READ_MENU} 拿到 mealKey。用户说"今晚 4 个人吃"就是它。`,
      parameters: {
        type: 'object',
        properties: {
          mealKey: { type: 'string', description: `${TOOL_READ_MENU} 返回的 mealKey，形如 2026-10-13-DINNER` },
          count: { type: 'integer', description: '人数（1～30）；传 0 或 null = 清除设定' },
        },
        required: ['mealKey'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_SET_MEAL_STATUS,
      description: '改一餐的状态：选好了(PLANNED) / 开始做(COOKING) / 做好了(DONE) / 取消这餐(CANCELED)。'
        + '**会真的写库，而且没有撤销**（状态是往前走的，见应用里的状态机）。'
        + '所以**只在用户明确说出要改到哪个状态时才调**（"今晚这餐就这么定了"/"做好了"/"晚餐取消"）。'
        + `不确定就先问他。必须先调 ${TOOL_READ_MENU} 拿 mealKey 与当前状态。`,
      parameters: {
        type: 'object',
        properties: {
          mealKey: { type: 'string', description: `${TOOL_READ_MENU} 返回的 mealKey` },
          status: { type: 'string', enum: ['PENDING', 'PLANNED', 'COOKING', 'DONE', 'CANCELED'], description: '目标状态' },
        },
        required: ['mealKey', 'status'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_REPEAT_MEAL,
      description: '再点一次：把某一餐整桌照抄到另一天某一餐（已有的菜跳过）。**会真的写库**（每道可撤）。'
        + `只适用于**已经定局**的那一餐（做好了/已取消/日子已过），还在收集中的那一餐直接加菜就行。`
        + `必须先调 ${TOOL_READ_MENU} 拿来源的 mealKey 与目标日期。`,
      parameters: {
        type: 'object',
        properties: {
          mealKey: { type: 'string', description: '来源那一餐的 mealKey' },
          mealDate: { type: 'string', description: '照到哪一天（YYYY-MM-DD）' },
          meal: { type: 'string', enum: ['LUNCH', 'DINNER'], description: '照到哪一餐' },
        },
        required: ['mealKey', 'mealDate', 'meal'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_READ_COMBOS,
      description: '读这个家存了哪些常用组合（每组里有哪些菜、菜 id 是多少）。'
        + `要改组合、删组合、或用组合加菜之前必须先调它，也可以用来回答"我们家那组快手菜是啥"。`,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_CREATE_COMBO,
      description: '把几道菜存成一个常用组合（"以后点这几道就省事了"）。**会真的写库**（能撤）。'
        + `菜要传真实 id（先 ${TOOL_SEARCH_DISHES} 或 ${TOOL_READ_RECIPES}）；同一家不能重名。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '组合名，如「快手三菜一汤」（最多 24 字）' },
          note: { type: 'string', description: '一句话说明，可空，如「工作日的晚上」' },
          recipeIds: { type: 'array', items: { type: 'string' }, description: '组里的菜 id，至少一道（最多 12 道）' },
        },
        required: ['name', 'recipeIds'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_UPDATE_COMBO,
      description: '改一个组合：改名、改说明，或**整组换菜**。**会真的写库**（能改回去）。'
        + `必须先调 ${TOOL_READ_COMBOS} 拿 comboId。只传要改的部分——菜传了就是整组替换（要发完整列表）。`,
      parameters: {
        type: 'object',
        properties: {
          comboId: { type: 'string', description: `${TOOL_READ_COMBOS} 返回的 id` },
          name: { type: 'string', description: '新名字（改名时才传）' },
          note: { type: 'string', description: '新说明（改说明时才传）' },
          recipeIds: { type: 'array', items: { type: 'string' }, description: '新的完整菜列表（换菜时才传）' },
        },
        required: ['comboId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_DELETE_COMBO,
      description: '删掉一个常用组合（只删组合，菜谱与已点的菜单都不受影响）。**会真的写库**（能放回来）。'
        + `必须先调 ${TOOL_READ_COMBOS} 拿 comboId，且要能对上用户说的那个。`,
      parameters: {
        type: 'object',
        properties: {
          comboId: { type: 'string', description: `${TOOL_READ_COMBOS} 返回的 id` },
        },
        required: ['comboId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: TOOL_ADD_COMBO_TO_MEAL,
      description: '一键把某个常用组合整组加进某一天某一餐（已有的菜跳过，不叠加）。**会真的写库**（每道可撤）。'
        + `必须先调 ${TOOL_READ_COMBOS} 拿 comboId。用户说"把那组快手菜加进明天晚饭"就是它。`,
      parameters: {
        type: 'object',
        properties: {
          comboId: { type: 'string', description: `${TOOL_READ_COMBOS} 返回的 id` },
          mealDate: { type: 'string', description: 'YYYY-MM-DD，用户没说就用今天' },
          meal: { type: 'string', enum: ['LUNCH', 'DINNER'], description: '午餐还是晚餐' },
        },
        required: ['comboId', 'mealDate', 'meal'],
        additionalProperties: false,
      },
    },
  },
] as const

/** 模型要求调用的一个工具（从回包里摘出来的形状） */
export interface ToolCall {
  id: string
  name: string
  /** 原始 JSON 字符串（模型可能给非法 JSON，解析失败要当成"这次调用无效"而不是崩掉） */
  arguments: string
}

/** 一条待用户确认的"加菜"建议 */
export interface MenuProposal {
  recipeId: string
  name: string
  mealDate: string
  meal: MealSlot
  note: string
  /** 界面按钮上的人话，如「今天晚餐」 */
  when: string
}

const MEAL_VALUES: MealSlot[] = ['LUNCH', 'DINNER']

/**
 * 把模型给的日期收敛到点菜窗口（今天起 `ORDER_DAY_SPAN` 天）里。
 *
 * 为什么要收敛而不是照单全收：模型会写出 `2026-13-45`、去年的日期、或干脆不写。
 * 超出窗口的建议即使提给用户，点下去也会被接口拒（400），不如在会合处就对齐到最近的可选日期。
 */
export function clampMealDate(raw: unknown, todayKey: string, span = ORDER_DAY_SPAN): string {
  const allowed = allowedDates(todayKey, span)
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (allowed.includes(text)) return text
  return allowed[0]
}

/** 允许的日期键（`YYYY-MM-DD`），从今天起 span 天。按 UTC 半夜存，与库里的日期口径一致 */
export function allowedDates(todayKey: string, span = ORDER_DAY_SPAN): string[] {
  const [year, month, day] = todayKey.split('-').map(Number)
  const base = Date.UTC(year, (month ?? 1) - 1, day ?? 1)
  return Array.from({ length: span }, (_, index) => {
    const date = new Date(base + index * 86_400_000)
    return date.toISOString().slice(0, 10)
  })
}

/**
 * 解析 `propose_menu_items` 的参数，并用**库里的真实菜**核对。
 *
 * `known` 是调用方按 id 查出来的菜（`Map<id, name>`）。对不上的 id **整条丢掉**，
 * 理由与推荐那条路一样：模型会编 id，放行就等于在界面上造一道不存在的菜。
 * 丢掉之后在 tool 结果里**告诉模型**丢了哪些，让它有机会换个真实 id 重来
 * （静默丢掉的话它会以为一切顺利，然后跟用户说"已经帮你加好了"）。
 */
export function readProposals(
  rawArguments: string,
  known: Map<string, string>,
  todayKey: string,
  span = ORDER_DAY_SPAN,
): { proposals: MenuProposal[]; rejected: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return { proposals: [], rejected: ['（参数不是合法 JSON）'] }
  }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return { proposals: [], rejected: ['（缺少 items 数组）'] }

  const proposals: MenuProposal[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (proposals.length >= PROPOSALS_MAX) break
    const recipeId = typeof (item as { recipeId?: unknown })?.recipeId === 'string'
      ? (item as { recipeId: string }).recipeId.trim() : ''
    const name = known.get(recipeId)
    if (!name) {
      rejected.push(recipeId || '(空 id)')
      continue
    }
    const mealRaw = (item as { meal?: unknown })?.meal
    const meal = MEAL_VALUES.includes(mealRaw as MealSlot) ? (mealRaw as MealSlot) : 'DINNER'
    const mealDate = clampMealDate((item as { mealDate?: unknown })?.mealDate, todayKey, span)
    const note = typeof (item as { note?: unknown })?.note === 'string'
      ? (item as { note: string }).note.trim().slice(0, 60) : ''
    // 同一道菜同一个餐次只提一次（模型偶尔重复输出）
    const key = `${recipeId}|${mealDate}|${meal}`
    if (seen.has(key)) continue
    seen.add(key)
    proposals.push({ recipeId, name, mealDate, meal, note, when: describeWhen(mealDate, todayKey, meal) })
  }
  return { proposals, rejected }
}

/** 「今天晚餐」「明天午餐」「10-15 晚餐」——按钮上要给用户看的人话 */
export function describeWhen(mealDate: string, todayKey: string, meal: MealSlot): string {
  // 用与点菜窗口同一个数（而不是写死 7）：改了窗口这里不会说错话
  const dates = allowedDates(todayKey, ORDER_DAY_SPAN)
  const offset = dates.indexOf(mealDate)
  const day = offset === 0 ? '今天' : offset === 1 ? '明天' : offset === 2 ? '后天' : mealDate.slice(5)
  return `${day}${MEAL_LABEL[meal]}`
}

/** 当天日期键（服务器本地日历，与点单口径一致——见 RISKS R-18 的时区假设） */
export function todayKey(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 给模型看的 tool 结果一律是**紧凑 JSON 字符串**：模型对 JSON 的服从度比散文高，
 * 而且字段名能当"用法说明"用（`recipeId` 这个词会提醒它下一个工具要传什么）。
 */
export function toolResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}

export interface DishHit {
  id: string
  name: string
  category: string
  tags: string[]
}

/** 搜索结果的回包形状：只给模型用得上的字段（多余的会挤掉上下文） */
export function searchResult(hits: DishHit[], query: string): string {
  if (hits.length === 0) {
    return toolResult({ query, dishes: [], hint: '库里没有匹配的菜，换个关键词再搜，或者直接告诉用户没找到' })
  }
  return toolResult({
    query,
    dishes: hits.slice(0, SEARCH_RESULTS_MAX).map((dish) => ({
      recipeId: dish.id,
      name: dish.name,
      category: dish.category,
      tags: dish.tags.slice(0, 4),
    })),
  })
}

// ---------- 冰箱四件（A 档：真的写库，但每笔都记下来可撤）----------

/**
 * 模型给的"要记进冰箱"的一张条。
 *
 * 刻意**只做形状收敛，不做业务校验**（名字长度/数量上限/日期是否存在那些在
 * `fridge.rules` 里，写库时再走一遍）：这一层的职责是"别让模型给的畸形状掉进写库路径"，
 * 而业务规则只能有一份——两处各写一套必然分叉（那边改了校验，这边还是旧口径）。
 *
 * `zone` 落到四个合法值之外时**退回"冷藏"而不是拒绝整条**：模型偶尔会把"冰箱"
 * 当成存放区写进来，为这个丢掉用户说的一样东西不值得。**但 expiresOn 不猜**——
 * 写一个错的保质期会让用户以为那天真的坏，宁可当没写（用户之后可以自己补）。
 */
export interface FridgeDraft {
  name: string
  amount?: string
  zone?: string
  expiresOn?: string
  note?: string
}

/**
 * 模型给的保质期能不能收。
 *
 * 光看形状（`\d{4}-\d{2}-\d{2}`）是不够的——实测模型会写出 `2026-13-45` 这种
 * "形状对、日子不存在"的东西。这里**反查一遍**（同 `fridge.rules.parseExpiry` 的手法），
 * 不存在的日期就当没写：存进去会让用户以为那天真的坏，而"没写"他随时能自己补。
 */
function readableDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const [year, month, day] = text.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  const real = date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
  return real ? text : null
}

export function readAddItems(rawArguments: string): { drafts: FridgeDraft[]; rejected: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return { drafts: [], rejected: ['（参数不是合法 JSON）'] }
  }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return { drafts: [], rejected: ['（缺少 items 数组）'] }

  const drafts: FridgeDraft[] = []
  const rejected: string[] = []
  for (const item of items) {
    if (drafts.length >= FRIDGE_ADD_MAX) {
      rejected.push('（超过一次能记的上限，剩下的请分下一批）')
      break
    }
    const record = item as Record<string, unknown>
    const name = typeof record?.name === 'string' ? record.name.trim() : ''
    if (!name) {
      rejected.push('(空名字)')
      continue
    }
    const draft: FridgeDraft = { name }
    if (typeof record.amount === 'string' && record.amount.trim()) draft.amount = record.amount.trim()
    if (typeof record.zone === 'string' && record.zone.trim()) draft.zone = record.zone.trim()
    const expiresOn = readableDate(record.expiresOn)
    if (expiresOn) draft.expiresOn = expiresOn
    if (typeof record.note === 'string' && record.note.trim()) draft.note = record.note.trim()
    drafts.push(draft)
  }
  return { drafts, rejected }
}

/**
 * 解析"要改哪条 + 改成什么"。
 *
 * 返回的 `patch` **只含模型真的传了的字段**——没传的保持原样。
 * 这一条很重要：模型经常把"只改数量"写成把名字也带一遍，若把那当成"改名字"，
 * 用户会看到菜名莫名其妙变了（而它恰好和原名一样时又看不出来，问题更隐蔽）。
 */
export function readUpdateItem(rawArguments: string): { itemId: string; patch: Partial<FridgeDraft> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown>
  const itemId = typeof record?.itemId === 'string' ? record.itemId.trim() : ''
  if (!itemId) return null

  /*
   * 逐个"传了才带上"地拼，而不是先放一个默认值再 delete：
   * `patch` 的字段是可选的，`delete` 只对可选属性合法（默认值那种写法 TS 会拦）。
   * 语义上也更直白——**只带模型真的传了的字段**（见函数说明里"只改数量"那个坑）。
   */
  const patch: Partial<FridgeDraft> = {}
  if (typeof record.name === 'string' && record.name.trim()) patch.name = record.name.trim()
  if (typeof record.amount === 'string') patch.amount = record.amount.trim()
  if (typeof record.zone === 'string' && record.zone.trim()) patch.zone = record.zone.trim()
  const expiresOn = readableDate(record.expiresOn)
  if (expiresOn) patch.expiresOn = expiresOn
  if (typeof record.note === 'string') patch.note = record.note.trim()
  return { itemId, patch }
}

export function readRemoveItem(rawArguments: string): string | null {
  try {
    const parsed = JSON.parse(rawArguments) as { itemId?: unknown }
    const itemId = typeof parsed?.itemId === 'string' ? parsed.itemId.trim() : ''
    return itemId || null
  } catch {
    return null
  }
}

/** 给模型看的冰箱现状（紧凑文本：它只要知道"有什么、叫什么、id 是多少"） */
export function fridgeText(items: {
  id: string
  name: string
  amount: string | null
  zone: string
  expiryLabel: string | null
}[]): string {
  if (items.length === 0) return '（冰箱是空的）'
  return items
    .map((item) => {
      const parts = [item.name, item.amount, item.zone, item.expiryLabel].filter(Boolean)
      return `${parts.join(' · ')}（id: ${item.id}）`
    })
    .join('\n')
}

// ---------- 自建菜谱与收藏（F1-11 / F1-12 / F1-09）----------

/**
 * 从参数里取一个 id 字段（`recipeId` 等）。
 *
 * 抽出来是因为这几个工具的"取 id"部分**必须完全一样**：任何一处取错
 * （比如 trim 漏了、或把空串当有效）都是"操作了另一条"或者"操作了一条空的"。
 */
export function readIdArg(rawArguments: string, key: string): string | null {
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>
    const value = typeof parsed?.[key] === 'string' ? parsed[key].trim() : ''
    return value || null
  } catch {
    return null
  }
}

/**
 * 新建菜谱的参数整理。
 *
 * **只做"能不能当草稿用"的判断，不做业务校验**：名字长度、步骤条数上限、
 * 配料名长度这些全在 `recipe.rules` 里（`parseRecipeCreate` 会再走一遍）。
 * 两处各写一套必然分叉——那边放宽了这边还在拦，或者反过来，写进去一条超长的。
 *
 * 返回 `null` 表示"连草稿都拼不出来"（参数不是 JSON、或没有名字/步骤），
 * 这时调用方回一句"没解析出来，请按字段重试"，而不是拿半份数据去写库。
 */
export function readRecipeDraft(rawArguments: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (typeof record?.name !== 'string' || !record.name.trim()) return null
  if (!Array.isArray(record.steps) || record.steps.length === 0) return null
  /*
   * 品类/菜系**给兜底值**（"家常"）：模型经常不填这两项，而它们是数据库里的必填列。
   * 这里兜底而不是报错，是因为"用户就想记下自家做法"这件事不该被一个分类问题挡住——
   * 兜底值是可辨的（不是编造信息），用户之后随手就能改。
   */
  return {
    ...record,
    category: typeof record.category === 'string' && record.category.trim() ? record.category.trim() : '家常',
    cuisine: typeof record.cuisine === 'string' && record.cuisine.trim() ? record.cuisine.trim() : '家常',
  }
}

/**
 * 改菜谱的参数：**把 `recipeId` 摘出来，其余原样交给 `parseRecipePatch`**。
 *
 * 为什么不在这里挑字段：`parseRecipePatch` 已经是"只认出现过的字段"的实现
 * （那是它与 `parseRecipeCreate` 的关键区别，也是"AI 改一句话不该清掉别的字段"的保证）。
 * 在这里再挑一遍等于把那条规则复制一份，将来加字段时两边不同步就会出现"AI 说改了、其实没改"。
 */
export function readRecipePatch(rawArguments: string): { recipeId: string; patch: Record<string, unknown> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown>
  const recipeId = typeof record?.recipeId === 'string' ? record.recipeId.trim() : ''
  if (!recipeId) return null
  const { recipeId: _ignored, ...patch } = record
  return { recipeId, patch }
}

/**
 * 给模型看的菜谱搜索结果（紧凑文本）。
 *
 * **每一项都带"是不是自己传的"与能不能改**：模型要据此决定"这道能改/那道只能复制"，
 * 少了这个它会对公共菜谱调 update，然后拿到一句拒绝、再跟用户解释一遍——
 * 那一次往返是白花的（用户的额度）。
 */
export function recipeText(hits: {
  id: string
  name: string
  category: string
  cuisine: string
  mine: boolean
  sourceLabel: string
}[]): { recipes: string; hint: string } {
  if (hits.length === 0) return { recipes: '（没找到）', hint: '换个关键词再搜，或问用户菜名' }
  return {
    recipes: hits.map((hit) => {
      // 「可改」/「公共」这两个词是给模型看的判据，它据此选工具
      const flag = hit.mine ? '可改' : '公共，不可改'
      return `${hit.name}（${hit.category}/${hit.cuisine}）[${hit.sourceLabel}，${flag}]（id: ${hit.id}）`
    }).join('\n'),
    hint: '只有标了「可改」的才是自己上传的；公共菜谱要改成自己的就新建一道',
  }
}

// ---------- 菜单、餐次与组合 ----------

/**
 * 解析 `add_menu_items` 的参数。
 *
 * 日期用 `clampMealDate` 收敛到点菜窗口（与提议那条同一个手法：模型会写去年的日期，
 * 收敛到最近的可选日比让它拿着一个必然 400 的日期去调接口好）。
 * 每道菜要求 `recipeId` 或 `dishName` **至少有一个**——两个都没有的条目直接丢掉并告诉模型，
 * 否则写库时会撞上一句它没法解释的校验错误。
 */
export function readMenuAdds(
  rawArguments: string,
  todayKey: string,
  span = ORDER_DAY_SPAN,
): { mealDate: string; meal: MealSlot; items: { recipeId?: string; dishName?: string; note?: string }[]; rejected: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return { mealDate: todayKey, meal: 'DINNER', items: [], rejected: ['（参数不是合法 JSON）'] }
  }
  const record = parsed as Record<string, unknown>
  const mealRaw = record?.meal
  const meal = MEAL_VALUES.includes(mealRaw as MealSlot) ? (mealRaw as MealSlot) : 'DINNER'
  const mealDate = clampMealDate(record?.mealDate, todayKey, span)

  const rawItems = Array.isArray(record?.items) ? record.items : []
  const items: { recipeId?: string; dishName?: string; note?: string }[] = []
  const rejected: string[] = []
  for (const raw of rawItems) {
    if (items.length >= MENU_ADD_MAX) {
      rejected.push('（超过一次能加的上限，剩下的请分下一批）')
      break
    }
    const item = raw as Record<string, unknown>
    const recipeId = typeof item?.recipeId === 'string' ? item.recipeId.trim() : ''
    const dishName = typeof item?.dishName === 'string' ? item.dishName.trim() : ''
    if (!recipeId && !dishName) {
      rejected.push('(既没有 recipeId 也没有 dishName)')
      continue
    }
    const entry: { recipeId?: string; dishName?: string; note?: string } = {}
    if (recipeId) entry.recipeId = recipeId
    else entry.dishName = dishName
    if (typeof item?.note === 'string' && item.note.trim()) entry.note = item.note.trim().slice(0, 120)
    items.push(entry)
  }
  if (!Array.isArray(record?.items)) rejected.push('（缺少 items 数组）')
  return { mealDate, meal, items, rejected }
}

/** 改人数：`{ mealKey, count }`。`count` 为 0/null/缺省都当作"清除设定"（与 parseDinerCount 同口径） */
export function readDiners(rawArguments: string): { mealKey: string; count: number | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown>
  const mealKey = typeof record?.mealKey === 'string' ? record.mealKey.trim() : ''
  if (!mealKey) return null
  const raw = record?.count
  if (raw === null || raw === undefined || raw === '' || raw === 0) return { mealKey, count: null }
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return null
  return { mealKey, count: Math.round(value) }
}

/** 改状态：`{ mealKey, status }`。状态不在枚举里就当"没解析出来"（不猜一个最像的） */
export function readMealStatus(rawArguments: string): { mealKey: string; status: OrderStatus } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown>
  const mealKey = typeof record?.mealKey === 'string' ? record.mealKey.trim() : ''
  const status = typeof record?.status === 'string' ? record.status.trim().toUpperCase() : ''
  if (!mealKey || !ORDER_STATUSES.includes(status as OrderStatus)) return null
  return { mealKey, status: status as OrderStatus }
}

/** 再点一次 / 组合加菜要的"照到哪一天哪一餐" */
export function readMealTarget(
  rawArguments: string,
  todayKey: string,
  span = ORDER_DAY_SPAN,
): { mealKey: string; mealDate: string; meal: MealSlot } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  const record = parsed as Record<string, unknown>
  const mealKey = typeof record?.mealKey === 'string' ? record.mealKey.trim() : ''
  const mealRaw = record?.meal
  if (!mealKey || !MEAL_VALUES.includes(mealRaw as MealSlot)) return null
  return { mealKey, mealDate: clampMealDate(record?.mealDate, todayKey, span), meal: mealRaw as MealSlot }
}

/**
 * 组合的新建/修改参数。
 *
 * `name`/`note`/`recipeIds` 都**原样交给 `CombosService`**（`combos.rules` 里的
 * `parseComboName` 等是唯一的业务校验），这里只做"是不是一个对象"的形状判断。
 * `keep` 让修改时可以只传一部分：没传的字段不进 patch（`undefined` = 保持原样）。
 */
export function readComboDraft(rawArguments: string): { name?: unknown; note?: unknown; recipeIds?: unknown } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  return { name: record.name, note: record.note, recipeIds: record.recipeIds }
}

/** 给模型看的菜单现状。**每道菜带 itemId**——撤菜靠它，少了它模型只能凭菜名猜 */
export function menuText(rows: {
  mealKey: string
  date: string
  meal: MealSlot
  statusLabel: string
  dinerCount: number | null
  dishes: { itemId: string; name: string; who: string; mine: boolean; note: string | null }[]
}[]): string {
  if (rows.length === 0) return '（这几天还没有安排）'
  return rows.flatMap((row) => {
    const head = `${row.date} ${MEAL_LABEL[row.meal]} · ${row.statusLabel}`
      + (row.dinerCount ? ` · ${row.dinerCount} 人` : '')
      + `（mealKey: ${row.mealKey}）`
    if (row.dishes.length === 0) return [head, '  （还没点菜）']
    return [head, ...row.dishes.map((dish) => {
      const who = dish.mine ? '我点的' : `${dish.who}点的`
      const note = dish.note ? `，备注：${dish.note}` : ''
      return `  - ${dish.name}（${who}${note}）（itemId: ${dish.itemId}）`
    })]
  }).join('\n')
}

/** 给模型看的组合列表：每组带 id 与菜 id（改组合、用组合加菜都要这两样） */
export function comboText(combos: { id: string; name: string; note: string | null; dishes: { recipeId: string; name: string }[] }[]): string {
  if (combos.length === 0) return '（还没有存过常用组合）'
  return combos.map((combo) => {
    const note = combo.note ? `（${combo.note}）` : ''
    const dishes = combo.dishes.map((dish) => `${dish.name}[${dish.recipeId}]`).join('、')
    return `${combo.name}${note}（comboId: ${combo.id}）：${dishes}`
  }).join('\n')
}
