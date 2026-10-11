# RESEARCH —— 立项调研结论

> 调研时间：2026-10-11。结论变化时修订本文件，其他位置只放摘要 + 链接。

## 一、要做什么（来自参考图解析）

参考图 `参考图片/` 共 13 张，是**同一「御膳」品牌（兔子主厨 IP）下的两套产品形态**：

| | A 组：家庭小厨房（暖橙） | B 组：御膳私房菜（清新绿） |
| --- | --- | --- |
| Tab | 厨房 / 订单 / 发现 / 我的（4） | 厨房 / 订单 / 发现 / 冰箱 / 我的（5）；另有「找灵感 / 菜谱 / 备菜 / 我的菜谱」4 Tab 变体 |
| 核心 | 一家人协作点菜，掌勺人看单回应（状态流转） | 个人私房菜工具：菜谱大全、未来 7 天备菜、冰箱库存、积分养成 |
| 结论 | 强协作、弱工具 | 强工具 + 养成、弱协作 |

用户已确认：**以 A 为主干，B 的冰箱/备菜/菜谱库作增强**（见 `DECISIONS.md` D-001）。

## 二、GitHub 同类项目调研

按 star 数 + 最近提交时间评估参考价值。

### 菜谱类

| 项目 | Star | 最近提交 | 许可 | 结论 |
| --- | --- | --- | --- | --- |
| PeOS-China/CookMan | 206 | 2017-03 | — | Android 单机查菜谱，停更 8 年，无参考价值 |
| small-bears/food | 69 | 2026-04 | 无 | SpringBoot+Vue 协同过滤推荐（毕设级），仅可看推荐思路 |
| nature924/No101...recipe-recommendation | 56 | 2024-10 | 无 | 同上，毕设级管理与推荐 |
| 666bears/delicious / menu / diet | 47/37/35 | 2024 | 无 | 同一作者的毕设系列，无许可，不宜作基座 |
| Sorosliu1029/recipe-crawler | 28 | 2018 | MIT | 下厨房爬虫，已归档；**数据获取思路可参考** |
| uimeis/python-spider-cookbook-meishij | 13 | 2018 | 无 | 美食杰 4.6 万菜谱爬取，仅数据思路 |
| 其余（guixueting/food、xujiaji/CookBook 等） | 10–25 | 2016–2020 | 多为无 | Android/uni-app 课程作业，无参考价值 |

### 家庭备菜类

| 项目 | Star | 最近提交 | 结论 |
| --- | --- | --- | --- |
| keenwilson/WhatsForDinner-WeeklyMealPlanner | 40 | 2018-10 | 家庭周菜单规划，概念接近但停更 |
| byronwall/recipe-app、recipes-modern | 3 / 1 | 2024–2026 | React/Next 家庭菜谱+备菜，规模太小 |
| Jcode-11/FamilyMealPicker | 1 | 2026-09 | 协作家庭备菜 PWA，概念贴近但极早期 |
| lvzhoujing/MenuListOfFamily | 1 | 2026-05 | 小程序家庭菜单管理，规模极小 |
| veronicaharringtonarraez-hue/Familymeal | 1 | 2026-06 | 备菜+采购+营养追踪，早期 |

### 关键结论

**没有任何一个成熟项目实现了本产品的核心组合**：「家人点菜 → 掌勺人回应并流转状态 → 按家庭口味/忌口过滤 → 冰箱库存在手食材推荐 → 按最终菜单自动生成采购清单」。最接近的只是「家庭周菜单 + 采购清单」的早期小项目。

## 三、菜谱数据源调研

用户要求：内置菜谱，同时最好能接口获取（图片、配料、制作视频），数据越全越好。

| 来源 | 内容 | 许可/成本 | 结论 |
| --- | --- | --- | --- |
| **Anduin2017/HowToCook** | 10.27 万 star，活跃（2026-10 仍在提交）；含「必备原料和工具 / 计算 / 操作」结构化步骤 | **Unlicense（公有领域）** | ✅ **选作内置种子库基座** |
| 第三方菜谱 API（聚合数据 / 极速数据 / 万维易源 showapi 等） | 菜名、图片、配料、步骤 | 免费额度小、需实名、条款各异 | 🟡 作为 Provider 增量接入，需核实配额与条款 |
| 下厨房 / 美食杰 爬虫类 | 全量菜谱含图 | 无官方 API，版权风险 | ❌ 不作为数据来源 |
| 制作视频 | 全量视频 | **无免费公开来源** | 🟡 列 P2，先保留字段与播放位 |

**缺口**：HowToCook 无成品图、无卡路里。→ 成品图用 AI 生成/SVG 占位，卡路里用估算值并标注。

## 四、图片生成能力验证（已实测）

- 端点：`https://api.ymeng.cc/v1/images/generations`（OpenAI 兼容 image-generation）
- 模型：`gpt-image-2`（另有 `gpt-image-2.5-flare` 可用）
- **实测结果：HTTP 200，约 20s/张，返回 `b64_json`（1024×1024，约 1.2MB PNG）**
- 实测产出：一张扁平矢量风「兔子主厨」IP 图标，风格与本项目需求高度契合。
- 备注：用户首次提供的密钥字符串有 1 个字符（`l/I` 类）书写差异导致 401，修正后正常。密钥只放 `.env`，不入库。

## 五、推荐路线

**走向 ③：从零开发**（无可直接使用的成熟项目）。

- 只借鉴两处设计思路：①「家庭点菜状态机」；②「冰箱库存 → 菜谱推荐 → 采购清单」的数据闭环。
- 内置种子库采用 HowToCook（Unlicense，可商用改造），第三方 API 走适配层增量补充。
- 技术路线见 `docs/context/PLAN.md`。

## 六、AI 能力选型调研（2026-10-11 追加）

需求：拍照识别冰箱食材并自动入库存；拍照识别菜品并给出配料、营养。

### 实测结论：用户现有网关不支持识图

| 探测 | 结果 |
| --- | --- |
| `GET /v1/models` | 仅 4 个模型：`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`z-image`，`supported_endpoint_types` 全为 `["image-generation","openai"]` |
| `POST /v1/chat/completions` | 不返回文本，而是返回一张 base64 图片（被代理到出图模型） |

→ **该网关只能生成图片，不能看图理解**。识图必须另配多模态模型。

### 可选多模态（vision）provider（均为"用户自配"候选）

| 方向 | 代表模型 | 备注 |
| --- | --- | --- |
| 国内云 API | 通义千问 VL（qwen-vl / qwen3-vl）、智谱 GLM-4V、豆包 vision、混元 vision、文心 ERNIE-VL | 中文场景好、单价低、有免费额度；需实名 |
| 海外 API | OpenAI gpt-4o/gpt-5 vision、Google Gemini、Claude | 识图强；网络与合规成本高 |
| 本地部署 | Qwen-VL 等开源权重自部署 | 无 API 成本、数据不出内网；但需 GPU 与运维，首版不建议 |

### 设计结论（用户已指定）

- **不锁定任何厂商**：provider/baseURL/model 全部走**配置文件**，用户自己填。
- 我方交付：**内置提示词模板库** + **调用 harness**（pi-agent）。
- 提示词需覆盖：冰箱食材识别（输出结构化食材+数量+置信度）、菜品识别、营养与配料分析、菜谱草稿生成、配餐建议。

### harness 选型：pi-agent（用户指定，已核实）

| 包 | 最新版本 | 作用 | 授权 |
| --- | --- | --- | --- |
| `@earendil-works/pi-agent-core` | 1.1.0 | Agent 运行时：工具调用、状态管理、**图片附件（attachment）支持** | MIT |
| `@earendil-works/pi-ai` | 1.1.0 | 统一 LLM API + 自动模型发现 + provider 配置 | MIT |

- 归属：`github.com/earendil-works/pi`（monorepo，`packages/agent`、`packages/ai`）。Pi 自我定位为"minimal, extensible agent harness"，提供 TypeScript SDK（`pi-agent-core` 即 Agent runtime），并支持 extensions / **skills** / **prompt templates** —— 与"内置提示词"的需求天然契合。
- **硬性要求：Node ≥ 22.19**（本机尚未安装 Node，见 `DECISIONS.md` D-012）。
- `pi-ai` 的 provider 出口覆盖：OpenAI（Responses / Completions）、Azure OpenAI、Anthropic、Google / Vertex、Mistral、Amazon Bedrock、OpenRouter 等 —— 足以支撑"用户自己配模型"，也能指向任意 OpenAI 兼容网关。
- **待实现时确认**：`pi-agent-core` 的具体 API（创建 agent、传图片附件、结构化输出/流式）需读 `packages/agent` 文档后再落地。
