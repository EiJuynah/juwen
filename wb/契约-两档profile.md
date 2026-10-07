# 契约：`constraints: boolean` → `profile` 两档（并行开发冻结版）

> 本文件由 Lead 冻结。两名开发 Agent **只按本文件写代码，不自行改契约**。
> 需求全文见 `wb/需求-两档解释-给开发Agent.md`（下称「需求文档」）；本文件只固定**跨模块接口**与**文件归属**。
> 项目根：`C:\Users\yujie\Desktop\project\readtool\freadtool`

---

## 1. 枚举与语义（唯一真源）

| profile | 界面名 | System Prompt | 落款 disclaimer | 联网 |
|---|---|---|---|---|
| `explain`（**默认**） | 讲透 | `EXPLAIN_SYSTEM_PROMPT` | `供理解参考，不作办事依据` | 允许（需 provider 已配置 + 用户显式开启） |
| `strict` | 严格依据 | `STRICT_SYSTEM_PROMPT`（= 现 `POLICY_SYSTEM_PROMPT` **原文照搬**） | `最终认定与金额以主管部门审核为准` | **禁止** |

`EXPLAIN_SYSTEM_PROMPT` 全文以需求文档 §3.1 为准，**逐字复制**，不得改写、精简、加条款。

## 2. 服务端契约（`server/`）

```js
// server/policy-prompt.js —— 文件名不变，只改内容
export const EXPLAIN_SYSTEM_PROMPT = `…需求§3.1 全文…`;
export const STRICT_SYSTEM_PROMPT = /* 现 POLICY_SYSTEM_PROMPT 原样 */;
export const EXPLAIN_DISCLAIMER = '供理解参考，不作办事依据';
export const STRICT_DISCLAIMER = '最终认定与金额以主管部门审核为准';
export function systemPromptFor(profile) { /* strict → STRICT_…，其它 → EXPLAIN_… */ }
export function disclaimerFor(profile) { /* 同上 */ }
export function buildFollowupPrompt(parentQuestion, parentAnswer, question) // 签名与『【原文依据】』字段名不变
```

- `runtimeSettings.profile`：`'explain' | 'strict'`，默认 `'explain'`。
- `resolveProfile()`：`DEEPSEEK_PROFILE` 为两档之一则用它；否则旧变量 `DEEPSEEK_CONSTRAINTS === '1'` → `strict`；其它 → `explain`。
- `GET /api/settings` 响应：
  ```json
  {
    "enabled": true, "profile": "explain", "model": "…", "effort": "low",
    "limits": { "…": "只读" }, "effortLevels": ["off","low","medium","high"],
    "profileOptions": [
      { "value": "explain", "label": "讲透", "desc": "…" },
      { "value": "strict", "label": "严格依据", "desc": "…" }
    ],
    "searchEnabled": false, "searchAvailable": false, "searchInfo": null
  }
  ```
  `profileOptions[].desc` 文案（前端直接渲染，不得硬编码）：
  - `explain`：`把话讲透，术语当场讲清、可补背景，补充会标注为补充。`
  - `strict`：`只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。`
- `POST /api/settings`：接受 `{ profile }`；**只接受两档枚举，非法值忽略并回落**（不返回 400，不写坏值）。
- `GET /api/health`：`constraints` 字段换成 `profile`。
- `POST /api/ai/stream` 的 `done` 事件：`constraints: boolean` → `profile: 'explain'|'strict'`，并带 `disclaimer: disclaimerFor(profile)`；**`steps` / `sources` / `rounds` / `searched` / `elapsedMs` / `reasoningChars` 字段名与含义不变**（任务1 成果）。
- 三处联动必须同时改（需求文档 §3.2）：① System Prompt ② **用户提示词里的任务措辞** ③ 落款。`explain` 档任务措辞用需求文档给的句子（`把上述选中内容讲清楚，讲透。` 等）。
- `server/validate.js`：`parseExplainRequest(body, settings)` 解析 `profile`，只接受两档、非法回落 `'explain'`，并在 `value` 里返回；`maxTokensFor` 与 `LIMITS` **不动**。
- `server/search/index.js`：`canSearch(ctx)` 的 `ctx.constraints` → `ctx.profile === 'strict'`，`reason` 由 `'constraints-mode'` → `'strict-mode'`；JSDoc/注释里的「政策约束模式」措辞同步改。

## 3. 前端契约（`web/src/`）

- `settings.profile` 初始值 `'explain'`；访问兼容：`settings.profile` 缺失且 `settings.constraints === true` → 视为 `'strict'`。
- 档位文案**只从 `settings.profileOptions` 取**（label / desc）；服务端没给该字段时不硬编码备用文案（测试 mock 必须提供）。
- 顶栏 chip：`.mode-chip` + `.mode-chip.explain` / `.mode-chip.strict`（旧 `.on` / `.off` 类名删除）；`title` 按档给完整说明，`searchLive` 分支保留。
- 提示条：`.doc-hint.explain` / 默认（strict）；旧 `.doc-hint.general` 删除。
- 设置页 `.mode-picker` 仍是 2 张卡片，语义为「讲透 ↔ 严格依据」，第一张默认选中；点选发 `{ profile: 'explain'|'strict' }`。
- 联网开关：`profile === 'strict'` 时禁用并说明「严格依据档不联网」；`<input class="switch" data-field="searchEnabled">` 保持不变（`data-field="enabled"` 同理，测试依赖）。
- 任务1 已落地的 `d.sources` 来源清单（`.srcs` / `.srcs-list`）、`.activity` 时间线：**不要回退**。
- 品牌区文案、`web/index.html` 的 `<title>` 不动。

## 4. 文件归属（**单一写者**，越界即视为冲突）

| 归属 | 文件 |
|---|---|
| **server 侧（teammate：profile-server）** | `server/policy-prompt.js`、`server/index.js`、`server/validate.js`、`server/search/index.js`、`scripts/search-test.mjs`、`scripts/policy-compliance-test.mjs`、`scripts/e2e-check.mjs`、`scripts/stream-stability-test.mjs`、`scripts/deep-followup-test.mjs`、`scripts/gen-demo-data.mjs` |
| **web 侧（teammate：profile-web）** | `web/src/App.jsx`、`web/src/styles.css`、`scripts/settings-ui-test.mjs`、`scripts/library-ui-test.mjs`、`scripts/active-highlight-test.mjs`、`scripts/smoke-render.mjs`、`scripts/activity-timeline-test.mjs`、`scripts/agent-loop-test.mjs`、`package.json` |
| **Lead** | `README.md`、`.env.example`、`wb/**`、`scripts/gen-demo-page.mjs`、`demo/index.html`、`freadtool/tmp_demo_data.json`、最终验收 |

- 任何人**不得**改不属于自己的文件；需要对方改，用 `send_message` 提给 Lead 转达。
- `gen-demo-data.mjs`（server 侧）产出的 JSON 键固定为：`{ sourceDoc, sections, clause, clauseId, question, explain, strict }`，其中 `explain` / `strict` 各为 `{ text, done }`；并修掉 `OUT` 硬编码错路径，改为相对脚本的 `../tmp_demo_data.json`。`gen-demo-page.mjs`（Lead 侧）依赖该键名。
- 品牌/产品文案改动仅限需求文档 §3.5 列出的位置。

## 5. 环境与验证纪律

- **5178 端口上有一个正在运行的 dev server（`node --watch`），5179 上有 Vite**。不要 kill 它们；改 `server/*.js` 会让 5178 自动重启，**因此改服务端期间不要跑打 5178 的测试**（`test:api`/`test:files`/`test:ai`）。
- 需要起服务自测时，用**自己的端口**：`$env:PORT='5188'`（或 5189）后 `node server/index.js`（后台作业），再 `$env:PORT='5188'; node scripts/e2e-check.mjs`。
- `vite-node`（`npm run test:web`）在当前沙箱下 esbuild 会 `spawn EPERM`：先按原命令原样重试一次并附 `sandbox_permissions: danger-full-access` 与一句理由（这是文档认可的边界，不要绕路重构）。
- PATH 里的 `node` 是 v20.17.0（可用）；需要 v24 用 `C:\Users\yujie\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。
- 只跑**自己范围内的定向测试**验证；完整 `npm test` 由 Lead 在两侧都停下后统一执行。
- 测试断言**不得为了过测而放宽**（需求文档 §4）。

## 6. 验收口径（Lead 最终执行）

1. `npm test` 全绿（含新增 `scripts/agent-loop-test.mjs`、`scripts/activity-timeline-test.mjs`）。
2. `npm run test:ai` 两档可区分：`explain` 档有术语讲解/背景补充且补充带「※ 补充」标注、无「该问题需要参考其他条款」回避话术；`strict` 档不出现原文外数值、涉及资格金额带「以主管部门审核为准」、末尾有「依据：」清单。
3. 顶栏 chip 与设置页两档切换即时生效，刷新后读服务端值。
4. `grep -rn 政策 --include=*.js --include=*.jsx --include=*.html .`（排除 `node_modules`/`dist`）：只允许出现在 `strict` 档约束文案、政策类示例数据、README 历史说明章节。
5. `grep -rn 通俗解释` 不得再有把它当档位名的地方。

## 7. 追加需求：DeepSeek 原生搜索 provider（Lead 已实测打通）

**背景（实测结论，不要重新论证）**：项目此前的结论「DeepSeek 不支持服务端搜索」只对 OpenAI 兼容的 `/chat/completions` 成立（那里的内置工具被静默忽略）。
DSH 内核自带的检索插件 `@deepseek-ai/dsh-web-search-deepseek` 走的是 **Anthropic 兼容 Messages API**，实测（`wb/probe-deepseek-native-search.mjs`）：

```
POST https://api.deepseek.com/anthropic/v1/messages
headers: x-api-key: $DEEPSEEK_API_KEY / authorization: Bearer $DEEPSEEK_API_KEY
         anthropic-version: 2023-06-01 / content-type: application/json
body:    { model: "deepseek-v4-flash", max_tokens: 1024,
           messages: [{role:"user", content:[{type:"text",
             text:"Perform a web search for the query: <query>"}]}],
           tools: [{ type:"web_search_20250305", name:"web_search", max_uses: 2 }] }
→ HTTP 200 / 0.4s；content 块：thinking, server_tool_use, web_search_tool_result, thinking, text
→ web_search_tool_result.content[] 为 web_search_result：{ url, title, page_age }
→ snippet 来自 text 块的 citations[].cited_text（按 url 关联，首次命中优先）
→ usage.server_tool_use.web_search_requests = 1；10 条来源中 7 条命中本项目权威源白名单
```

**新增 provider**（只加文件、不改 agent-loop、不改 SSE 契约）：

- 新文件 `server/search/providers/deepseek-native.js`，导出 `createDeepseekNativeProvider({ apiKey, baseUrl, model, maxTokens, maxUses, fetchImpl })`，
  返回既有 provider 形状 `{ name: 'deepseek', configured: boolean, async search(query, { count, signal }) }`，结果条目字段固定为
  `{ title, url, snippet, site, publishedAt }`（`site` 由 URL 主机名推导，复用 `allowlist.js` 的 `hostOf`）。
  默认：`baseUrl = process.env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic/v1'`、`model = process.env.DEEPSEEK_SEARCH_MODEL || 'deepseek-v4-flash'`、`maxTokens = 1024`、`maxUses = 2`。
  - 没有 `web_search_tool_result` 块时**必须当错误抛**（不降级、不从正文扒 URL）——与 DSH 内核同策略。
  - 非 2xx 抛错并带上状态码（上层 `searchWeb` 会收敛成 `provider-error`）。
  - 必须把调用方 `signal` 透传给 `fetch`（可取消）。
- `server/search/index.js` 的 `createSearchServiceFromEnv` 增加 `SEARCH_PROVIDER=deepseek`（可接受 `deepseek`/`deepseek-native`/`native` 三种写法），
  用 `env.DEEPSEEK_API_KEY`；没有 key 时 `configured:false`（服务仍然创建，`enabled` 由 provider 是否存在决定，与现有 bocha 分支一致）。
  JSDoc 里补上新的环境变量。
- `scripts/search-test.mjs` 增加该 provider 的**离线**单测（打桩 `fetchImpl`，不联网）：
  ① 请求体/请求头正确（`anthropic-version`、`x-api-key`、`Bearer`、`tools[0].type=web_search_20250305`、`max_uses`）；
  ② 从 `web_search_tool_result` + citations 正确映射出 title/url/snippet/publishedAt，按 URL 去重；
  ③ 响应缺少结果块 → 抛错（而不是返回空数组当成功）；
  ④ 非 2xx → 抛错；
  ⑤ `createSearchServiceFromEnv({ SEARCH_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: '' })` → `enabled:false`；
  ⑥ 白名单仍然生效：native 返回的非权威 URL 被 `searchWeb` 滤除。
- `SEARCH_PROVIDER=deepseek` 时**继续沿用现有权威源白名单**与现有闸门（默认关闭、严格依据档不联网），白名单可用 `SEARCH_ALLOWED_DOMAINS` 覆盖。

**归属**：新增/修改都落在 `server/search/**` 与 `scripts/search-test.mjs`（task-1 的写权范围内，同一写者），
`.env.example` 与 README 的说明由 Lead 补。

