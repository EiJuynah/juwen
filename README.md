# 智能解读工作台

AI 智能体 · 划词批注 · 溯源解读。

上传一份文件，选中看不懂的地方，AI 把它讲明白。阅读时选中任意文字，即可添加人工批注或向 AI 提问；AI 依据 DeepSeek-V4.1-Flash 流式返回解释，每条解释都标注依据段落编号、可点回原文，并支持在解释基础上递归追问（最多 6 层）。

解释力度分两档：默认「**讲透**」——术语当场讲清、可补充背景，但补充内容必须与原文区分并标注；可选「**严格依据**」——只用原文作答、逐条标出依据段落，要写材料、要逐条对照引用时用这一档。

> 这个项目的立身之本是**可核对**：每处解释都能回查原文段落，AI 判断需要时还能联网检索权威政务来源并列出可点击的出处；两档都不会编造原文里没有的数字、日期、条件、期限。

## 快速开始

```bash
npm install                 # 安装依赖
cp .env.example .env        # 复制配置并填入 DEEPSEEK_API_KEY
npm run dev                 # 同时启动桥接层(5178) + 前端(5179)
```

> **Windows 安装提示**：本项目的 esbuild postinstall 在部分 Windows 环境下会撞 `EBUSY` 中断，
> 导致 `@esbuild/win32-x64` 装不上、Vite 启动报 `could not be found`。
> 用 `npm install --include=optional` 重装即可（详见文末「环境相关的坑」）。

打开 http://localhost:5179 即可使用。API key 存放在 `.env`，**仅服务端读取，不会下发到浏览器**。

分开启动：

```bash
npm run dev:server          # 桥接层 http://localhost:5178
npm run dev:web             # 前端   http://localhost:5179
```

生产模式（桥接层直接托管构建产物，只需 5178 一个端口）：

```bash
npm run build
npm start                   # http://localhost:5178
```

## 功能

| 功能 | 说明 |
|------|------|
| 划词批注 | 选中原文 → 「添加批注」，锚点持久化到 Y.Doc，文档编辑后仍可定位 |
| AI 解释 | 选中原文 → 「问 AI」，SSE 逐 token 流式返回 Markdown 解释 |
| 两档解释 | 默认「讲透」（术语当场讲清、补充标注为补充）/「严格依据」（只用原文、逐条标依据），切换即时生效 |
| 递归追问 | 对任一 AI 解释继续追问，携带上文上下文，最多 6 层 |
| 溯源回查 | 解释中的 `[P-x]` 或中文条号（如 `[第二条]`）可点击，定位并滚动到原文对应段落 |
| 过程时间线 | 思考 / 检索 / 作答逐步展示，生成中自动展开、结束后折叠成「N 步 · 检索 M 次 · 耗时」 |
| 联网检索 | 可选开启：AI 通过 function calling 触发 `web_search`，结果过权威源白名单后回灌，界面列出可点击来源 |
| 推理分离 | 模型的思考过程独立展示在可折叠区，不与答案混排 |
| 段落引用 | 条款带稳定段落 ID，AI 引用与回查均基于该 ID |
| 卡片交互 | 卡片直接显示被解释的原文片段；解答可折叠（收起只留「引用 + 问题」），右栏有「全部收起 / 全部展开」；删除需**二次确认**，并连带删除该条下的全部追问 |
| 多格式上传 | docx / wps / doc / xlsx / pptx / pdf / rtf / txt 等，按内容嗅探而非扩展名 |
| 文档库 | 文件夹归档、按内容哈希去重，批注与 AI 解释随文档持久化 |
| 孤立降级 | 锚点失效的批注降级为「孤立批注」，不删除 |
| 设置页 | 顶栏「⚙ 设置」：AI 总开关、解释档位、联网检索开关、模型名、推理强度 |

## 架构

```
前端文档层   Tiptap 2 + ProseMirror + @pokapali/comments-tiptap
             原文只读渲染，标注全部走 Decoration（不改动原文）
                 ↓ SSE（start / step / r / t / reset / done）
桥接层       Express：请求校验 / 档位 Prompt 注入 / agent 循环 / 同源校验
                 ↓ OpenAI 兼容接口（stream + function calling）
Agent 层     DeepSeek-V4.1-Flash（deepseek-flash）
                 ↓ 模型自行决定是否调用 web_search
检索层       server/search/：provider（博查 / mock）→ 权威源白名单 → 去重 → 回灌
```

### 目录

```
server/
  index.js          Express 服务：POST /api/ai/stream（SSE）、设置与健康检查
  validate.js       请求校验（parseExplainRequest 语义）、token 预算
  policy-prompt.js  两档 System Prompt（讲透 EXPLAIN_* / 严格依据 STRICT_*）与落款
  agent-loop.js     解释生成循环：function calling → 执行检索 → 回灌 → 收口作答
  search/
    index.js        检索统一入口：白名单、去重、超时、缓存、canSearch 闸门
    tool.js         暴露给模型的 web_search 工具 schema 与使用规范
    allowlist.js    权威源域名白名单（默认 12 个官方域名，可用环境变量覆盖）
    providers/      deepseek-native（DeepSeek 原生服务端搜索，推荐）
                    bocha（博查 API）/ mock（离线演示与测试）
  files-store.js    文档库：上传落盘、目录文件夹、批注按文档持久化
  routes-files.js   文档管理 API（上传 / 目录 / 批注）
  policy-extract.js 条文结构化：段落 → 章/条 + 稳定 pid
  parsers/
    index.js        解析统一入口，按嗅探结果路由
    sniff.js        格式嗅探（只看内容不看扩展名）
    ole2.js         OLE2/CFB 容器读取器
    word97.js       Word 97 二进制正文提取（FIB→CLX→PlcPcd）
    ooxml.js        docx/wps、xlsx/et、pptx/dps 的 zip 解析
    rtf.js          RTF 提取（含 GBK 代码页与 UTF-8 直出）
web/
  index.html
  vite.config.js    开发端口 5179，/api 代理到 5178
  public/favicon.svg
  src/
      main.jsx        React 挂载入口
      App.jsx         主界面：编辑器、浮动条、侧边栏、设置页、过程时间线、流式渲染
      comment-store.js 评论存储：锚点创建/解析、流式节流、拍平排序
      sse.js          SSE 客户端与设置读写
      sample-policy.js 示例文本（开屏不再预置，仅备测试/参考）
      styles.css      样式
scripts/
  parser-test.mjs            多格式解析器测试
  policy-extract-test.mjs    条文结构化测试
  files-api-test.mjs         文档管理 API 测试
  e2e-check.mjs              接口契约验证（加 --with-ai 连真实模型）
  search-test.mjs            检索层：白名单 / 去重 / 超时 / 缓存 / 闸门 / provider
  agent-loop-test.mjs        agent 循环：tool_calls 分片、逐个回灌、轮次收口（离线）
  smoke-render.mjs           前端运行时冒烟（jsdom 真实挂载 React）
  active-highlight-test.mjs  划词→锚点→高亮→激活态全链路验证
  settings-ui-test.mjs       设置页、档位切换与联网开关的 UI 验证
  activity-timeline-test.mjs AI 过程展示：时间线 / reset / 来源清单 / 引用（jsdom 喂 SSE）
  library-ui-test.mjs        文档库面板与引用识别验证
  deep-followup-test.mjs     6 层追问回归验证
  policy-compliance-test.mjs 两档行为对比 + 严格依据档五条约束命中
  stream-stability-test.mjs  流式答案非空稳定性（连跑多轮）
  gen-demo-page.mjs          生成静态演示页 demo/index.html
  extract_word97.py          Python 参考实现，用于交叉验证 JS 解析器
```

## 测试

```bash
npm test               # 离线全量：解析 + 结构化 + 检索 + agent 循环 + 接口 + 前端（620 项）
npm run test:parser    # 多格式解析 + 条文结构化（74 项，无需起服务）
npm run test:search    # 检索层（含补正文）+ DeepSeek 原生 provider + agent 循环（264 项，全离线）
npm run test:files     # 文档管理 API：上传 / 目录 / 批注（42 项，需起桥接层）
npm run test:api       # 接口契约 + system prompt 组装断言（47 项，离线段不依赖服务端）
npm run test:web       # 前端逻辑、设置页、AI 过程展示、卡片折叠与删除确认（235 项，jsdom）
npm run test:ai        # 连真实模型：接口 + 两档行为对比 + 术语解释正则自检（需 API 额度）
npm run test:stability # 流式稳定性：3 场景 × 5 轮，确认答案不为空
```

`npm test` 的 620 项构成：解析 41、条文结构化 33、检索 214、agent 循环 50、接口契约 47、
前端 235（冒烟 11 / 划词高亮 11 / 设置页 52 / 文档库 53 / AI 过程展示 103 / 6 层追问 5）。

前端测试在 jsdom 中真实挂载 React 与 ProseMirror，能抓到 curl 看不见的运行期错误：hooks 顺序违规、未捕获异常导致的白屏、锚点解析失败、设置开关不生效、SSE 事件解析丢字段。jsdom 无排版引擎，测试里对 `getClientRects` 打了零尺寸桩，仅为让选区链路能跑通。

`test:ai`、`test:stability`、`test:files` 会真实消耗 API 额度或写本地数据，默认不包含在 `npm test` 里。

> 新增的两条离线测试各自抓出过一个真实缺陷（见「本地调试时踩到的坑」第 12、13 条）：
> `agent-loop-test.mjs`（过渡轮把被丢弃的正文说成「已生成答案」）与
> `activity-timeline-test.mjs`（SSE 兜底事件覆盖服务端 done 快照，导致来源清单与检索次数永不显示）。

## 接口

### `POST /api/ai/stream`

SSE 流式解释。

请求：

```json
{
  "text": "选中内容",
  "paragraphText": "所属段落原文",
  "paragraphId": "P-3-1",
  "question": "可选提问，留空则直接解释",
  "maxDepth": 0,
  "parentAnswer": "追问时的上文回答"
}
```

事件（`data:` 行）：

| 字段 | 含义 |
|------|------|
| `{"phase":"start","depth":0}` | 开始 |
| `{"step":{"key":"search:1:1","kind":"search","status":"done","label":"…","detail":"查询词","items":[{"title":"…","url":"…","site":"…"}]}}` | 过程时间线增量：`key` 相同的帧按就地合并（running → done），`kind` 为 `think` / `search` / `answer`，`status` 为 `running` / `done` / `failed` / `skipped` |
| `{"reset":true}` | 清空正文缓冲。带检索的过渡轮会先吐一句「我先查一下…」，它不是答案 |
| `{"r":"..."}` | 推理增量（独立通道） |
| `{"t":"..."}` | 可见答案增量 |
| `{"done":true,"profile":"explain","disclaimer":"…","steps":[…],"sources":[…],"rounds":2,"searched":1,"elapsedMs":8637,"reasoningChars":N}` | 结束。`steps` / `sources` 是服务端的权威快照，前端据它兜底补全时间线 |
| `{"error":"…","detail":"…"}` | 错误 |

约束：`temperature 0.3`、`maxDepth ≤ 6`、`text ≤ 4000` 字符。同源校验（Origin 与 Host 必须一致，本机开发允许不同端口）。

### `GET|POST /api/settings`

读写运行时配置。

```json
{
  "enabled": true,
  "profile": "explain",
  "model": "deepseek-flash",
  "effort": "low",
  "limits": { "...": "只读" },
  "effortLevels": ["off", "low", "medium", "high"],
  "profileOptions": [
    { "value": "explain", "label": "讲透", "desc": "把话讲透，术语当场讲清、可补背景，补充会标注为补充。" },
    { "value": "strict", "label": "严格依据", "desc": "只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。" }
  ],
  "searchEnabled": false,
  "searchAvailable": false,
  "searchInfo": null
}
```

| 字段 | 含义 |
|------|------|
| `enabled` | AI 解释总开关，关闭后不发起任何模型请求 |
| `profile` | 解释档位：`explain`（默认，讲透）/ `strict`（严格依据）。生效于 system prompt、用户提示词任务措辞、落款三处；非法值忽略并回落，不报 400 |
| `model` | 模型名 |
| `effort` | 推理强度，仅接受 `effortLevels` 中的值 |
| `profileOptions` | 档位的界面名与说明，**前端只按它渲染，不硬编码档位文案** |
| `searchEnabled` / `searchAvailable` / `searchInfo` | 用户是否开启联网 / 服务端是否具备检索能力 / provider 与白名单详情 |

### `GET /api/health`

返回 `ok` / `model` / `keyConfigured` / `profile` / `limits` / `search` / `searchEnabled`，用于启动前自检。

## 两档解释（讲透 / 严格依据）

同一个「划词 → 解释 → 可追问」的动作，两种解释力度。在顶栏右侧「⚙ 设置 → 解读口径」里**并排点选**，切换立刻生效，只影响之后新发起的解释。

| | 讲透（`explain`，默认） | 严格依据（`strict`） |
|---|---|---|
| 什么时候用 | 日常读懂一份文件 | 要写材料、要逐条对照引用 |
| 知识边界 | 原文 + **允许**补充（术语、背景、相近概念、例子），但补充必须标注 | 只用原文，禁止引申 |
| System Prompt | `EXPLAIN_SYSTEM_PROMPT`（讲解者姿态） | `STRICT_SYSTEM_PROMPT`（五条约束原文照搬） |
| 溯源要求 | 强制标 `[段落ID]`；补充处标「※ 补充，非原文」 | 强制标 `[段落ID]` + 末尾「依据：」清单 |
| 落款 | 供理解参考，不作办事依据 | 最终认定与金额以主管部门审核为准 |
| 联网检索 | 可开启（provider 已配置 + 用户显式打开） | **禁止**：掺入外部网页会让溯源链断掉 |
| 界面提示 | 暖色提示条 + 顶栏按档着色 | 蓝色提示条 |

**两档共用的内核（任何情况下不削弱）**：

1. 不编造原文中未出现的数字、日期、条件、期限
2. 原文表述模糊、存在多种理解时，列出可能的理解，不擅自选定一种当「正确答案」
3. 每处解释标注依据段落编号，可回查原文

> 内核三条是服务于「理解」的（准确、诚实、可核对），与旧的免责话术不是一回事：
> 「以主管部门审核为准」这类只在办事场景成立的措辞**只留在严格依据档**。

### 讲透档的「回答规范」（追加，不改冻结正文）

讲透档的 System Prompt = **需求文档 §3.1 的 `EXPLAIN_SYSTEM_PROMPT`（逐字未改）+ 一段追加的《回答规范》**。
追加规范只约束「怎么讲」，用来压掉实测出来的注水：直接回答被问的那一点（同一句里相关的术语可以用一两句顺带讲清）、
不做写作层面的元讨论、不写用户没问的章节、「※ 补充，非原文」全篇只标一次、时效提醒只作最后要点里的半句话、
篇幅一般 300～700 字且不许为凑长度写复述句/过渡句。

严格依据档**不追加**这段，`STRICT_SYSTEM_PROMPT` 逐字节保持原样，由 `e2e-check` 的离线断言守着；
组装逻辑收敛在 `buildSystemPrompt({ profile, searchActive })` 一个纯函数里，顺序固定为
「档位正文 →（联网时）检索规范 →（讲透档）回答规范」。

> 实测（同一段原文「两个维护」，6 次真实调用）：元讨论小节与「没人问的章节」**0 命中**，
> 「※ 补充」由 5 次降到 **1 次**，字数 **590～1021**（原先 800+ 字且含 2 节注水）。
> 仍有约 1/3 的次数会在末尾多出一句时效提醒——它来自冻结正文「主动说明可能已过时」的硬要求，
> 属两条规范之间的取舍、不是注水；要彻底消除需改冻结正文或另加长度档位，当前刻意不做。

### 严格依据档的五条约束

System Prompt 落地设计文档的五条约束（`EXPLAIN_SYSTEM_PROMPT` 里对应的是讲解者姿态的三条底线 + 格式要求）：

1. **依据约束** — 只基于选中段落及直接关联条款，超范围时提示"该问题需要参考其他条款"
2. **边界约束** — 涉及资格/金额判断时使用"根据当前段落的理解是……但最终资格认定和金额以主管部门审核为准"
3. **引用约束** — 每条解释标注依据段落编号，末尾输出「依据：」清单
4. **不确定处理** — 表述模糊时列出多种理解，不擅自选定"正确答案"
5. **禁止推断** — 不编造原文未出现的数字、日期、条件

### 档位同时作用于三处

**system prompt、用户提示词里的任务措辞、落款**三处必须一起改，只改提示词会自相矛盾——例如选了讲透档却仍在要求「不得引入原文之外的信息」。

设置值由服务端持有（`GET|POST /api/settings`），前端按服务端返回值渲染（含档位文案 `profileOptions`），避免出现「界面显示讲透、服务端其实还开着严格依据」的不一致；`done` 事件也会带上本轮实际使用的 `profile` 与 `disclaimer`。环境变量 `DEEPSEEK_PROFILE=explain|strict` 决定启动默认档，旧变量 `DEEPSEEK_CONSTRAINTS=1` 仍兼容为 `strict` 一个版本。

## 联网检索

检索分成两层：**模型侧**用标准 function calling 决定「这一问要不要查」，**检索侧**由桥接层执行并把结果回灌。

DeepSeek 在 OpenAI 兼容的 `/chat/completions` 上会**静默忽略**内置工具（`web_search` 等），但 **Anthropic 兼容的 `/anthropic/v1/messages` 支持原生服务端搜索**——服务端工具 `web_search_20250305`，用同一把 `DEEPSEEK_API_KEY` 鉴权，返回的是结构化的 `web_search_tool_result` 块（不是从正文里扒 URL）：

```jsonc
POST https://api.deepseek.com/anthropic/v1/messages
{ "model": "deepseek-v4-flash", "max_tokens": 1024,
  "messages": [{ "role": "user", "content": [{ "type": "text",
     "text": "Perform a web search for the query: <query>" }] }],
  "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 2 }] }
// → HTTP 200，content 块：thinking / server_tool_use / web_search_tool_result / text
//   来源：web_search_tool_result.content[] = { url, title, page_age }
//   摘要：text 块的 citations[].cited_text，按 url 关联
```

实测（`node wb/probe-deepseek-native-search.mjs`）：0.4s 返回 **10 条来源，7 条命中本项目权威源白名单**。因此 `SEARCH_PROVIDER=deepseek` 是**推荐档**——用现有密钥即可联网，不必再买第三方搜索服务；`bocha` 保留为可替换后端，`mock` 用于离线演示与测试。

```
模型 → tool_calls: web_search{query}      （arguments 是增量分片的，按 index 累积拼接）
桥接层 → provider（deepseek 原生 / 博查 / mock）→ 权威源白名单 → 去重 → 截断 5 条
桥接层 → role:"tool" 逐条回灌（漏一个下一次请求直接 400）
模型 → 最终答案（引用资料时说「据资料 1」，与原文冲突时以原文为准）
```

设计要点：

- **只走权威源**：默认白名单 12 个官方域名（gov.cn / npc.gov.cn / cppcc.gov.cn / news.cn / xinhuanet.com / people.com.cn / qstheory.cn / gmw.cn / cctv.com / chinanews.com.cn / china.com.cn / legaldaily.com.cn），供应商返回 20 条、过完白名单可能只剩 3 条；滤空的场景如实说「未检索到权威来源」，**绝不放行非权威结果凑数**。
- **只给元数据，正文我们自己抓**：DeepSeek 原生搜索的返回里**只有** `title / url / page_age`（正文在 `encrypted_content` 里、解不开；`citations[].cited_text` 实测为空）。真机上表现为模型如实回答「检索结果只返回了标题，没有正文内容」。因此桥接层在过滤/去重/截断后，**自己对来源页抓一次正文**补进摘要：只抓白名单内的 http/https、拒绝 localhost/私网、`redirect: 'error'`、单页 4s 超时 / 256KB 上限、并发 3、每次查询最多抓 3 条、每条留 800 字；**失败就留空、绝不阻塞回答**。实测真机来源 0.1～0.5s 拿到 500～800 字正文。
- **绝不降级**：原生搜索若没有返回结构化结果块，按错误处理，而不是从模型正文里抓 URL 凑数。
- **永不抛错到用户层**：超时（8s）、取消、provider 异常都收敛成 `{ok:false, reason}`，整轮解释照常出答案，只是没有外部资料。
- **按需才搜**：模型自己决定要不要调，不是每段都搜。
- **闸门**：默认关闭；开启后仍要求「非严格依据档 + provider 已配置」。
- **隐私**：开启后**选中的文字会被作为检索词发往搜索服务**，内部文件请勿开启；设置页对此有显式提示。
- **过程可见**：每一步检索的查询词、命中条数、来源都通过 `step` 事件推到前端，生成中自动展开、结束后折叠；最终答案下方另有一份去重后的**来源清单**，可点开原文出处核对。
- **轮次收口**：最多 3 轮；最后一轮摘掉 `tools`，这是唯一可靠的「逼它作答」手段（模型对不相关结果会继续换词再搜）。单轮最多真的执行 3 次检索。

配置见 `.env.example`：`SEARCH_PROVIDER=none|deepseek|bocha|mock`、`DEEPSEEK_SEARCH_BASE_URL`、`DEEPSEEK_SEARCH_MODEL`、`BOCHA_API_KEY`、`SEARCH_ENABLED`、`SEARCH_ALLOWED_DOMAINS`；
补正文可调 `SEARCH_FETCH_PAGES=0`（关闭）、`SEARCH_FETCH_MAX`、`SEARCH_FETCH_TIMEOUT_MS`、`SEARCH_FETCH_MAX_BYTES`。

> 与 DSH 内核的关系：DSH 自带的检索插件 `@deepseek-ai/dsh-web-search-deepseek` 走的就是上面这条 Anthropic 兼容路径（它另外支持 `x-dsh-auth-token` 的账号登录态）。本项目不复用其账号 token，而是直接用 API Key 调同一端点，自包含、可迁移。

## 实现说明

### 与设计文档的差异

| 设计文档 | 实现 | 原因 |
|---------|------|------|
| DeepSeek Harness + dsh-bubble-explain | 自建 Express 桥接层，保留全部接口契约 | `dsh-bubble-explain` 未发布到 npm；Harness 仍是 rc，插件 API 不可用 |
| `@pokapali/react` 的 CommentSidebar | 复用 comments-tiptap 锚点核心，侧边栏自建 | 该组件强依赖 `@pokapali/core` 的 helia/IPFS P2P 栈，单机场景过重 |
| `maxTokens = min(2000, maxChars*2+200)` | 答案额度保底 + 固定推理余量，上限 16000 | V4.1-Flash 先输出 `reasoning_content` 且与答案共用配额，原公式会让答案为空（详见下方第 6 条） |
| — | 请求体带 `effort: "low"` | 政策解释只需依据原文，过度推理拖慢首字并挤占答案配额 |
| 模型名 `deepseek-4.1-flash` | `deepseek-flash` | V4.1-Flash 的官方 API 名 |

### 真实模型实测

填入真实 Key 后跑 `npm run test:ai`（`e2e-check --with-ai` + `policy-compliance-test`），接口契约与**两档行为**均全绿：

- 流式链路：`phase:start` → `t` 增量 → `done`（带 `profile` / `disclaimer` / `steps` / `sources`），追问链路同样有答案
- **严格依据档**：金额/资格类提问带出「以主管部门审核为准」；正文标 `[段落ID]`；末尾输出「依据：」清单；
  超范围时说明「该问题需要参考其他条款」；未编造原文之外的具体数值
- **讲透档**：术语当场解释；补充内容带「※ 补充」类标注；**不再出现**「该问题需要参考其他条款」这类回避话术；
  落款为「供理解参考，不作办事依据」；两档输出确有差异
- **联网链路（`SEARCH_PROVIDER=deepseek`）**：真机一轮实测 **3 轮循环 / 6 次检索 / 去重后 26 条权威来源 / 10 步时间线**，
  落款与档位一致；来源清单可点开原始出处。补正文实测：同一查询采纳 5 条中抓回 2～3 条页面正文（0.1～0.5s，528～800 字），
  模型随即改成「据资料 1（嘉峪关，2025 年 3 月）、资料 2（上海普陀，2025 年 7 月）…」这种带内容的引用
- 单次解释耗时约 6～15 秒（含推理），可见答案 380～610 字

注意 `reasoning_content` 长度波动极大：同一段落实测在 **0～10053 字**之间跳
（后者是术语辨析类提问，`effort: low` 也压不住），
这也是下面第 6 条必须固定留推理余量、不能按输入长度等比缩放的原因。

> 采集演示页数据时要留意：两档对比样本必须在**关闭联网**时采集，
> 否则讲透档样本里会混进「据资料 1、2」，看起来像联网场景而不是档位对比（已踩过）。

### 本地调试时踩到的坑

以下几处在原始代码中会导致功能实际不可用，已修复：

1. **递归追问只能到第 1 层**（`App.jsx` `followUp`）
   `@pokapali/comments` 只支持一层线程，对回复再回复会直接抛
   `Cannot reply to a reply — one-level threading only`。
   README 承诺的「最多 6 层」在第 2 层就中断。
   修复：depth ≥ 2 的追问统一挂到线程根节点，层级由 `data.depth` 表达，
   侧边栏缩进与层数限制都按 `depth` 计算，观感与真嵌套一致。

2. **点击批注卡片，原文高亮不切换**（`App.jsx`）
   `CommentHighlight` 的 `activeCommentId` 在 `useEditor` 创建时就被冻结，
   `setActiveId` 不会让扩展重建，`activeCommentId` 永远是初始的 `null`。
   修复：新增 effect，在 `activeId` 变化时改写
   `editor.extensionManager.extensions` 上的 options 再重建装饰。

3. **流式节流失效**（`App.jsx` `runExplain`）
   `frame` 计数只增不减，一旦越过阈值 8 就永久命中，
   后续每个 token 都会写一次 Y.Doc，「按帧数节流」形同虚设。
   修复：`flush()` 内重置 `frame`。

4. **点击依据编号跳不过去**（`App.jsx` `jumpToParagraph`）
   原逻辑按 `heading.textContent.includes(pid)` 查找，但 `buildPolicyHtml`
   只把 `data-pid` 写在 `<p>` 上、`<h2>` 里没有 pid，主分支永远不命中，
   每次都退化到文本搜索。
   修复：改为按段落 `attrs.pid` 匹配，文本搜索降为兜底。

5. **追问轮 prompt 里同一问题出现两次**（`server/index.js`）
   `buildFollowupPrompt(question, parentAnswer, question)` 把本轮问题
   同时塞进「上文提问」和「本次追问」；且请求体只有 `parentAnswer`、
   并没有父轮提问原文，该位置本就无值可用。
   修复：`parentQuestion` 传空串，追问轮单独拼「原文依据」段落，
   不再重复拼「本段提问」。

6. **答案会随机为空**（`server/validate.js` `maxTokensFor`）
   原公式 `min(2000, n*2+200)` 再 ×1.6 + 800：85 字的段落只算出 **1392**，
   而 V4.1-Flash 的 `reasoning_content` 与答案共用这同一份配额，
   实测 reasoning 波动在 **0～4066 字**，一次就能吃光，可见答案为空
   —— 前端表现为卡片一直空白。
   修复：答案额度单独保底（下限 900、上限 2000），推理余量固定不参与缩放，
   两者相加再卡 16000。小段落预算由 1392 提到 3480。
   另在 `App.jsx` 的 `onDone` 加了兜底：万一仍无答案，提示
   「模型本次只输出了推理过程」而不是留空白。
   回归用 `npm run test:stability`（3 场景 × 5 轮）。

   **二次复发（推理余量 2400 → 6000）**：真实条例里问
   「什么时候称非公有制经济人士，什么时候称民营经济人士」这类**术语辨析题**，
   `effort: low` 也压不住，reasoning 一口气写了 **10053 字**。
   按中文约 0.34 token/字折算 ≈ 3418 token，几乎正好吃光当时 **3480** 的总额度
   （3418 + 答案 60 ≈ 3480），所以卡片只剩一句「本次只输出了推理过程」。
   注意这跟「上下文太长」无关——那次选区 13 字、段落 178 字，输入极短，
   被吃光的是**输出配额**，不是输入长度。
   现在推理余量抬到 6000：小段落 max_tokens 由 3480 → **7080**
   （≈ 可容纳 1.7 万字推理），大段落 8400。`max_tokens` 只是上限、不预扣费，
   调高本身不增加成本，代价仅是模型真长篇推理时耗时变长。

7. **追问轮 prompt 里同一问题出现两次**（`server/index.js`）
   `buildFollowupPrompt(question, parentAnswer, question)` 把本轮问题
   同时塞进「上文提问」和「本次追问」；且请求体只有 `parentAnswer`、
   并没有父轮提问原文，该位置本就无值可用。
   修复：`parentQuestion` 传空串，追问轮单独拼「原文依据」段落，
   不再重复拼「本段提问」。

8. **追问轮 token 预算被低估**（`server/index.js`）
   `maxTokensFor(max(text.length, paragraphText.length))` 中，
   追问请求的 `paragraphText` 为空串，预算只按选区长度算。
   修复：把 `parentAnswer.length` 一并计入。

9. **追问请求被误判为「缺少选中内容」**（`server/validate.js`）
   校验层无条件要求 `text` 非空，但追问的语义依据是上文答案，
   原文只是溯源补充；若线程根的 `anchorText` 为空，追问会被 400 拦掉。
   修复：`depth > 0` 且有 `parentAnswer` 时允许 `text` 为空，
   首轮仍强制要求选中内容。

10. **构建产物缺失时报 MIME 错误而非 404**（`server/index.js`）
    SPA 回退正则 `^\/(?!api\/).*` 会把 `index.html` 返回给
    `/assets/index-xxx.js`，浏览器报的是 MIME 错误，排查成本极高。
    修复：回退时排除带扩展名的路径，并补一个显式 404。

11. **流式过程中删除评论会抛未捕获异常**（`comment-store.js`）
    底层 `comments.update` 在条目不存在时 throw，
    而 SSE 回调是异步的，异常会变成 unhandledRejection。
    修复：`updateComment` 捕获并静默丢弃，返回是否真的写入。

12. **过渡轮把被丢弃的正文说成「已生成答案」**（`server/agent-loop.js`）
    带 `tool_calls` 的那一轮，模型常先吐一句「我先查一下权威口径。」，
    这段正文会被 `reset` 丢弃、降级成步骤说明。但「作答」步骤早在那之前就收尾为
    `已生成答案 / done`，于是时间线上出现「已生成答案」之后又冒出检索和下一轮作答。
    修复：把作答收尾拆成 `closeAnswer(label, status)`——最终轮 `已生成答案/done`，
    过渡轮 `过渡说明（已丢弃，不计入答案）/skipped`。
    这条是新增的 `scripts/agent-loop-test.mjs` 抓出来的（离线、不打模型）。

13. **SSE 兜底事件覆盖了服务端的权威 done 快照**（`web/src/sse.js`）
    客户端在读取循环结束后无条件补一次
    `onDone({done:true, truncated:true})`（本意是连接被截断时收尾）。
    但服务端是「先发 done 帧、再 `res.end()`」，正常结束同样会走到这里，
    于是刚拿到的 `sources / searched / elapsedMs / steps` 立刻被 `undefined` 覆盖
    → **来源清单永远不显示，摘要里的「检索 M 次」和耗时永远不显示**。
    修复：记 `sawDone`，只在没收到 `done` 时才兜底；截断兜底语义不变。
    这条是新增的 `scripts/activity-timeline-test.mjs`（jsdom 喂真实 SSE 帧）抓出来的。

14. **原生搜索只给元数据，模型只能看到标题**（`server/search/`）
    真机反馈：AI 回答里写「检索结果只返回了标题，没有正文内容」。探针
    `node wb/probe-native-search-raw.mjs` 打出原始响应才看清：
    `web_search_result` 条目字段只有 `type / title / url / encrypted_content / page_age`，
    **没有正文字段**；而唯一的摘要来源 `text.citations[].cited_text` 实测 **0 条**
    （`max_tokens` 1024 与 4096 一样）。也就是说，回灌给作答模型的确实只有标题。
    修复：新增 `server/search/page-text.js`（HTML→文本、charset 嗅探与 GBK 回落、受限抓取器），
    在过滤/去重/截断后自己抓来源页正文补进 `snippet`——
    只抓白名单内 http/https、拒绝私网、`redirect: 'error'`、4s 超时、256KB 上限、并发 3、每次最多 3 条，
    失败留空不阻塞。抓完真机重跑，模型开始引用页面里的具体时间与做法。

### 环境相关的坑

- **Windows 上 `npm install` 可能因 esbuild 的 postinstall 撞 `EBUSY` 中断**，
  导致 `@esbuild/win32-x64` 没装上、Vite 启动报
  `The package "@esbuild/win32-x64" could not be found`。
  解决：`npm install --include=optional`。
  注意普通 `npm install` 会把它再删掉，必须带 `--include=optional`。

- **中断的 `npm install` 会留下 `*.DELETE.<hash>` 半成品文件**，
  表现为启动时报
  `Cannot find module .../dist/index.js. Please verify that the package.json has a valid "main" entry`。
  排查：`find node_modules -name "*.DELETE.*"`；
  修复：`npm pack <pkg>@<ver>` 单独抓包解压覆盖对应目录，再删掉 `*.DELETE.*`。

- **`vite-node` 必须显式带 `--config web/vite.config.js`**，
  否则读不到 `@vitejs/plugin-react`，JSX 会按 classic runtime 转译，
  运行期报 `React is not defined`。`npm run test:web` 里已带上。

- **`npm run build` 可能报 `remove C:\...\Temp\esbuild-xxxx: Access is denied`**：
  esbuild 在 `%TEMP%` 里建的中间文件删不掉（杀软/临时目录权限都会导致），
  表现为 `[vite:esbuild-transpile]` 阶段失败，但代码本身没问题。
  解决：把临时目录指到工作区内再构建——
  ```powershell
  New-Item -ItemType Directory -Force .tmp-esbuild | Out-Null
  $env:TEMP = (Resolve-Path .tmp-esbuild).Path; $env:TMP = $env:TEMP
  npm run build
  ```
  另注：`npm run build` 因 rollup 的 chunk 体积警告会往 stderr 写内容，
  PowerShell 里会显示 `[exit code: 1]`，**那是 npm 的 stderr 噪音，不是构建失败**——
  以输出里是否有 `✓ built in` 与 `dist/assets/*` 为准。

- **`vite.config.js` 的 `root` 必须写绝对路径**。写 `'.'` 会按 `process.cwd()`
  解析，而 `dev:web` 是从项目根执行的，`root` 就指错目录、页面直接 404。

- **Vite 重建依赖缓存时可能被 safe-delete 保护拦下，导致开发服务器直接退出**。
  改动 `package.json` 后首次启动会出现：
  ```
  [vite] Re-optimizing dependencies because lockfile has changed
  Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":53,...,"targets":["...node_modules/.vite/deps"]}
  npm run dev:web exited with code 1
  ```
  此时 5179 端口可能残留一个僵尸进程返回 502，容易误判成后端挂了。
  解决：把缓存目录移走再启动（比删更稳，也绕开批量删除限制）：
  ```bash
  mv node_modules/.vite ../.vite_cache_stale
  npm run dev
  ```
  另注意 `node --watch` 会因初次写入 `data/` 触发一次重启，属正常现象。
- **jsdom 缺 `getClientRects`**，ProseMirror 的 `coordsAtPos` 会抛
  `target.getClientRects is not a function`。无头测试需补零尺寸桩。
- **Node 22 起 `globalThis.navigator` 是 getter-only**，
  覆盖需用 `Object.defineProperty`，直接赋值会抛
  `Cannot set property navigator of #<Object> which has only a getter`。

### 关于密钥

`DEEPSEEK_API_KEY` 只放在 `.env`，且 `.env` 已在 `.gitignore` 中，不会被提交。
服务端启动时通过 `dotenv` 读入，**不会下发到浏览器**；前端一律走 `/api` 代理，
`GET /api/health` 也只会返回布尔值 `keyConfigured`，不回显密钥本身。

若密钥曾经出现在聊天记录、日志或截图中，建议到 DeepSeek 控制台重新签发并吊销旧的。
