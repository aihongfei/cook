import { useState } from 'react'
import Chips from '@/components/ui/Chips'
import Page from '@/components/ui/Page'
import { orderFilters, orderRecords } from '@/data/demo'
import '../shared.scss'

/** 订单：家庭点菜单（状态流转见 FEATURES.md M3） */
export default function OrderPage() {
  const [scope, setScope] = useState<'family' | 'mine'>('family')
  const [filter, setFilter] = useState('all')

  const records = orderRecords.filter((r) => filter === 'all' || r.status === filter)

  return (
    <Page>
      <div className="pscreen">
        <div className="ptitle">家宴点菜单</div>
        <div className="psub">记录大家想吃什么，也记录每顿饭的回应</div>

        <div className="segmented">
          <button
            type="button"
            className={`segmented__item${scope === 'family' ? ' is-active' : ''}`}
            onClick={() => setScope('family')}
          >
            全家点菜单
          </button>
          <button
            type="button"
            className={`segmented__item${scope === 'mine' ? ' is-active' : ''}`}
            onClick={() => setScope('mine')}
          >
            只看我的
          </button>
        </div>

        <Chips items={orderFilters} value={filter} onChange={setFilter} />

        {records.map((record) => (
          <article className="order-card" key={record.id}>
            <div className="order-card__head">
              <div>
                <div className="order-card__date">
                  {record.date} · {record.meal}
                </div>
                <div className="order-card__who">{record.orderers}</div>
              </div>
              <span className={`stamp${record.status === 'done' ? '' : ' stamp--wait'}`}>
                {record.statusText}
              </span>
            </div>

            <div className="order-card__dishes">
              {record.dishes.slice(0, 2).join(' · ')}
              {record.dishes.length > 2 && (
                <>
                  <br />
                  {record.dishes.slice(2).join(' · ')}
                </>
              )}
              <br />
              <span className="order-card__total">{record.total}</span>
            </div>

            {record.note && <div className="order-card__note">{record.note}</div>}

            <div className="order-card__foot">
              <span>{record.submittedAt}</span>
              <button type="button" className="btn-ghost">
                再点一次
              </button>
            </div>
          </article>
        ))}
      </div>
    </Page>
  )
}
