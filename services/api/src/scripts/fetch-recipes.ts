import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { HOWTOCOOK_COMMIT, HOWTOCOOK_REPOSITORY, parseHowToCook } from '../modules/recipes/howtocook.parser'
import { SeedBundle } from '../modules/recipes/recipe.types'

const selected: Record<string, string[]> = {
  meat_dish: ['可乐鸡翅', '糖醋排骨', '鱼香肉丝', '宫保鸡丁', '回锅肉', '红烧鸡翅', '小炒肉'],
  vegetable_dish: ['西红柿炒鸡蛋', '凉拌黄瓜', '酸辣土豆丝', '蒜蓉西兰花', '清蒸南瓜', '蚝油生菜', '地三鲜'],
  staple: ['蛋炒饭', '葱油拌面', '炸酱面', '电饭煲蒸米饭', '汤面', '热干面', '手工水饺'],
  soup: ['紫菜蛋花汤', '西红柿鸡蛋汤', '玉米排骨汤', '金针菇汤', '小米粥', '罗宋汤', '皮蛋瘦肉粥'],
}

async function githubJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { 'User-Agent': 'yushan-recipe-import', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${url}`)
  return response.json()
}

async function sourceText(path: string): Promise<string> {
  const raw = `https://raw.githubusercontent.com/Anduin2017/HowToCook/${HOWTOCOOK_COMMIT}/${path}`
  try {
    const response = await fetch(raw, { signal: AbortSignal.timeout(2000) })
    if (response.ok) return await response.text()
  } catch { /* The Contents API returns the same commit-pinned original bytes. */ }
  try {
    const content = await githubJson(`https://api.github.com/repos/Anduin2017/HowToCook/contents/${encodeURI(path)}?ref=${HOWTOCOOK_COMMIT}`)
    if (content.encoding !== 'base64' || typeof content.content !== 'string') throw new Error(`Unsupported content: ${path}`)
    return Buffer.from(content.content, 'base64').toString('utf8')
  } catch (error) {
    // A completed local seed is a reproducible offline input for reruns after GitHub rate limits.
    try {
      const bundle = JSON.parse(await readFile('seeds/howtocook.json', 'utf8')) as { commit: string; licenseText: string; recipes: { sourcePath: string; rawMarkdown: string }[] }
      if (bundle.commit === HOWTOCOOK_COMMIT && path !== 'LICENSE') {
        const local = bundle.recipes.find(recipe => recipe.sourcePath === path)
        if (local) return local.rawMarkdown
      }
    } catch { /* Report the original GitHub failure below. */ }
    throw error
  }
}

async function main() {
  if (process.argv.includes('--offline')) {
    const bundle = JSON.parse(await readFile('seeds/howtocook.json', 'utf8')) as SeedBundle
    if (bundle.commit !== HOWTOCOOK_COMMIT || bundle.license !== 'Unlicense' || !bundle.licenseText.includes('This is free and unencumbered software released into the public domain.')) throw new Error('Offline provenance mismatch')
    bundle.recipes = bundle.recipes.map(recipe => parseHowToCook(recipe.rawMarkdown, recipe.sourcePath, bundle.commit))
    await writeFile('seeds/howtocook.json', JSON.stringify(bundle, null, 2) + '\n')
    console.log(`Reparsed ${bundle.recipes.length} original Markdown sources offline at ${bundle.commit}`)
    return
  }
  const tree = await githubJson(`https://api.github.com/repos/Anduin2017/HowToCook/git/trees/${HOWTOCOOK_COMMIT}?recursive=1`)
  if (tree.truncated) throw new Error('GitHub tree truncated')
  const licenseText = await sourceText('LICENSE')
  if (!licenseText.includes('This is free and unencumbered software released into the public domain.')) throw new Error('Unexpected license; import stopped')
  const bundle: SeedBundle = {
    version: 1, repository: HOWTOCOOK_REPOSITORY, commit: HOWTOCOOK_COMMIT,
    license: 'Unlicense', licenseUrl: `${HOWTOCOOK_REPOSITORY}/blob/${HOWTOCOOK_COMMIT}/LICENSE`, licenseText, recipes: [],
  }
  for (const [category, names] of Object.entries(selected)) {
    for (const name of names) {
      const match = tree.tree.find((entry: { path: string; type: string }) => entry.type === 'blob' && entry.path.startsWith(`dishes/${category}/`) && entry.path.endsWith(`/${name}.md`))
      if (!match) throw new Error(`Recipe not found in pinned tree: ${category}/${name}`)
      const markdown = await sourceText(match.path)
      bundle.recipes.push(parseHowToCook(markdown, match.path))
      console.log(`fetched ${name}`)
    }
  }
  await mkdir('seeds', { recursive: true })
  await writeFile('seeds/howtocook.json', JSON.stringify(bundle, null, 2) + '\n')
  console.log(`Saved ${bundle.recipes.length} recipes at commit ${bundle.commit}`)
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
