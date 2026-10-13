/**
 * 「可以自己写、也有现成词可选」的一格输入（品类 / 菜系用）。
 *
 * 为什么不是原生 `<datalist>`（原来就是它，用户 2026-10-13：「不要用原生的，
 * 要好看的符合软件风格的」）：`datalist` 在不同浏览器/WebView 里长得完全不一样，
 * 手机上多数会弹出一个系统级的白色列表，与这套手绘水彩风是两张皮；而且它在
 * Android WebView 里行为不一致（有的只做前缀匹配、有的干脆不弹）。
 * 这里改成**输入框 + 可点的词**：既保住了"可以自己写"（后端不收固定枚举，
 * 家里的糊辣汤想算什么菜系就算什么），又有看得见、点得到的常用词。
 *
 * 建议词的三个来源与顺序**是有讲究的**：
 * 1. 内几个常用词（`common`）——大多数家常菜都落在这里，先给最可能点的；
 * 2. 库里实际存在的值（`options`）——用它们才能与筛选口径对齐（点了就能筛出来）；
 * 3. 当前输入的子串匹配（有输入时**只留匹配的**，这时它就是个自动补全）。
 * 上限 12 个：再多会把表单撑成一屏的按钮，反而找不到想点的那个。
 */
const SUGGEST_MAX = 12

export default function SuggestField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  common,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  maxLength: number
  /** 常用词（内几个，排在最前） */
  common: string[]
  /** 库里实际存在的值 */
  options: string[]
}) {
  const typed = value.trim().toLowerCase()
  const pool: string[] = []
  for (const item of [...common, ...options]) {
    const word = item.trim()
    if (word && !pool.includes(word)) pool.push(word)
  }
  const list = (typed ? pool.filter((word) => word.toLowerCase().includes(typed)) : pool).slice(0, SUGGEST_MAX)

  return (
    <div className="recipe-form__field">
      {/*
       * `htmlFor` + `id` 而不是把输入框套进 `<label>` 里：建议词与输入框在同一个字段块内，
       * 若整块都是 label，输入框的可访问名字会变成"品类 家常 素菜 荤菜…"（把词也算进去），
       * 读屏与测试里都认不出"品类"这个框。显式关联两边就都干净了。
       */}
      <label htmlFor={`recipe-field-${label}`}>{label}</label>
      <input
        id={`recipe-field-${label}`}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {list.length > 0 && (
        <div className="recipe-form__suggest" role="group" aria-label={`${label}常用词`}>
          {list.map((word) => (
            <button
              key={word}
              type="button"
              className={`recipe-form__suggest-item${word === value ? ' is-active' : ''}`}
              // 点自己那一项再点一次 = 取消选择（选错了不用手动删字）
              onClick={() => onChange(word === value ? '' : word)}
            >
              {word}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
