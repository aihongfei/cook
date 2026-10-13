# history/ 索引

存放有价值的过程归档，需要追溯时先搜索本索引再读对应文件。

## 归档规则

- 只归档有追溯价值的过程（如被替代的方案、重要的调研原始数据），**不复制聊天记录、不记流水账**。
- 当前状态一律直接修订到权威文件（`NOW.md` / `DECISIONS.md` / `PLAN.md` 等），归档仅保留被替代的旧版本。
- 命名：`YYYY-MM-DD-主题.md`。

## 条目

| 日期 | 文件 | 内容 |
| --- | --- | --- |
| 2026-10-11 | `package-lock.mobile.pre-pnpm.json` | 前端迁到 pnpm 前保留的 npm 锁文件（`apps/mobile`，lockfileVersion 3，包名 `mobile`）。仅用于回溯迁移前的依赖树，不再是活动锁文件（活动锁为 `apps/mobile/pnpm-lock.yaml`）。 |
| 2026-10-14 | `brand/2026-10-14-icon-master-house-1024.png` | 应用图标的**第一版母图**（手绘水粉房子 + 烟囱爱心）。装机后用户说「不好看」、要求改动画风，已换成卡通厨房场景，故归档。要回退：换回 `docs/brand/icon-master-1024.png` 并重跑 `apps/mobile/scripts/build-brand-assets.sh`，**但 `FG_ART_DP` / `LEGACY_ART_RATIO` 这两个尺寸参数是按新母图的宽高比重量的，必须按 R-060 重算**。 |
