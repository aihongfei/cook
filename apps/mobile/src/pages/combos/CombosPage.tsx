import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { apiErrorMessage } from '@/api/client'
import { useCombos, useDeleteCombo, type Combo } from '@/api/combos'
import { useFamily } from '@/api/family'
import ConfirmDialog from '@/components/ui/ConfirmDialog'
import EmptyState from '@/components/ui/EmptyState'
import Page from '@/components/ui/Page'
import PageHeader from '@/components/ui/PageHeader'
import { toast } from '@/components/ui/toast'
import { readBackLink } from '@/pages/back-link'
import RecipeStatus from '@/pages/recipes/components/RecipeStatus'
import ComboAddSheet from './components/ComboAddSheet'
import '../shared.scss'
import './combos.scss'

/**
 * 常用组合（M4 / F4-04）：家里常一起点的那几组菜，一键整组加进某一餐。
 *
 * 为什么值得有：家庭点菜是**成组**发生的（"工作日的三菜一汤"、"周末硬菜"），
 * 每次都逐个翻菜谱再加，四五道菜就是四五次搜索与点选。存成组合之后一次点完。
 *
 * 三件事是刻意的：
 * - **组合是家庭共用的**：谁组的都能用；改/删只给组它的人与掌勺人/帮厨
 *   （`canEdit` 来自后端，前端不复刻这套判定）；
 * - **组里的菜名与图来自真实的菜谱记录**：菜谱被删时那一组里的引用也跟着没了
 *   （库层是级联删除，见 schema 里 ComboItem 的说明），所以不会出现"加进去发现这道菜不存在"；
 * - **空状态要说清怎么来**：这一页自己不能凭空造组合（组合从"这一餐存下来"或菜谱里挑），
 *   所以空的时候指路，而不是给一个点了没反应的按钮。
 */
export default function CombosPage() {
  const location = useLocation()
  const family = useFamily()
  const combos = useCombos({ enabled: Boolean(family.data) })
  const remove = useDeleteCombo()
  const back = readBackLink(location.state, '/discover')

  // 正在一键加入的那一组（抽屉关着时是 null）
  const [adding, setAdding] = useState<Combo | null>(null)
  // 待确认删除的那一组：删组合影响全家人用，所以先问一句
  const [pendingDelete, setPendingDelete] = useState<Combo | null>(null)

  const list = combos.data?.combos ?? []

  const confirmDelete = () => {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    remove.mutate(target.id, {
      onSuccess: () => toast.success(`已删掉「${target.name}」`),
      onError: (error) => toast.error(apiErrorMessage(error)),
    })
  }

  return (
    <Page>
      <div className="pscreen combos-page">
        <Link className="page-back" to={back.to}>← {back.label}</Link>
        <PageHeader title="常用组合" subtitle="常一起点的那几组菜，一键加进某一餐" art="recipes" />

        {!family.isPending && !family.data ? (
          <section className="card">
            <p className="combos__tip">
              组合是家里人一起用的。先创建家庭或用邀请码加入，再回来把常点的几组存下来。
            </p>
            <Link className="combos__link" to="/family" state={{ from: location.pathname }}>
              去创建或加入家庭 →
            </Link>
          </section>
        ) : (
          <>
            {combos.isPending && (
              <div className="card combos__status">
                <RecipeStatus title="正在看家里的组合…" loading />
              </div>
            )}
            {combos.isError && (
              <div className="card combos__status">
                <RecipeStatus title="组合暂时打不开" onRetry={() => { void combos.refetch() }} />
              </div>
            )}

            {combos.data && list.length === 0 && (
              <EmptyState
                title="还没有常用组合"
                desc="在点菜单里把这一餐的菜存成组合，或者到菜谱小书里挑几道——下次一键就能点到。"
              />
            )}

            {list.map((combo) => (
              <section className="card combo" key={combo.id}>
                <div className="combo__head">
                  <div className="combo__title">
                    {combo.name}
                    <span className="combo__count">{combo.dishCount} 道</span>
                  </div>
                  {combo.canEdit && (
                    <button
                      type="button"
                      className="combo__del"
                      disabled={remove.isPending}
                      onClick={() => setPendingDelete(combo)}
                    >
                      删除
                    </button>
                  )}
                </div>
                {combo.note && <p className="combo__note">{combo.note}</p>}
                <p className="combo__dishes">{combo.dishes.map((dish) => dish.name).join(' · ')}</p>
                <div className="combo__foot">
                  <span className="combo__by">{combo.createdBy} 组的</span>
                  <button type="button" className="btn-ghost combo__add" onClick={() => setAdding(combo)}>
                    加进某一餐
                  </button>
                </div>
              </section>
            ))}

            {combos.data && list.length > 0 && (
              <p className="combos__hint">
                组合从哪儿来？在点菜单里点「存成常用组合」，或者到菜谱小书挑几道 ——
                <Link className="combos__inline-link" to="/recipes" state={{ from: location.pathname }}>
                  去菜谱小书
                </Link>
              </p>
            )}
          </>
        )}
      </div>

      {adding && (
        <ComboAddSheet key={adding.id} combo={adding} onClose={() => setAdding(null)} />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删掉这个组合"
        message={
          pendingDelete
            ? `把「${pendingDelete.name}」删掉？家里人都不能再一键加它了（已经加进菜单的菜不受影响）。`
            : ''
        }
        confirmText="删掉"
        tone="danger"
        pending={remove.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Page>
  )
}
