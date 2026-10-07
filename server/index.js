import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExplainRequest, maxTokensFor, LIMITS } from './validate.js';
import {
  buildSystemPrompt,
  disclaimerFor,
  buildFollowupPrompt,
} from './policy-prompt.js';
import { createSearchServiceFromEnv } from './search/index.js';
import { runExplainLoop } from './agent-loop.js';
import { createFileStore } from './files-store.js';
import { createFilesRouter } from './routes-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5178;
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const API_KEY = process.env.DEEPSEEK_API_KEY || '';

// 文档库根目录。
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const fileStore = await createFileStore(DATA_DIR);

// 检索服务。SEARCH_PROVIDER 未配置时为 null（= 不具备联网能力）。
const searchService = createSearchServiceFromEnv(process.env, (msg) => console.log(msg));

/** 两档枚举与界面文案。档位文案只从这里下发，前端不硬编码 */
const PROFILE_OPTIONS = [
  {
    value: 'explain',
    label: '讲透',
    desc: '把话讲透，术语当场讲清、可补背景，补充会标注为补充。',
  },
  {
    value: 'strict',
    label: '严格依据',
    desc: '只用原文作答，逐条标出依据段落，要写材料、要经得起对照时用。',
  },
];

const PROFILE_VALUES = PROFILE_OPTIONS.map((o) => o.value);

/** 归一化档位：只认两档，其它一律回落到默认档 explain */
const normalizeProfile = (v) => (PROFILE_VALUES.includes(v) ? v : 'explain');

/**
 * 启动档位。
 *   DEEPSEEK_PROFILE=explain|strict → 用它（默认档 explain）
 * 旧变量兼容（只兼容一个版本，之后移除）：
 *   DEEPSEEK_CONSTRAINTS=1 → strict；=0 或未设 → explain
 */
function resolveProfile() {
  const p = process.env.DEEPSEEK_PROFILE;
  if (p === 'strict' || p === 'explain') return p;
  if (process.env.DEEPSEEK_CONSTRAINTS === '1') return 'strict';
  return 'explain';
}

// 可运行时调整的开关，对应 /api/settings 的 enabled 字段
const runtimeSettings = {
  enabled: true,
  model: MODEL,
  effort: process.env.DEEPSEEK_EFFORT || 'low',
  // 解释档位。默认「讲透」（explain）；切到 'strict' 走严格依据的五条约束。
  // 需要持久到下次启动时，把它写进 .env 的 DEEPSEEK_PROFILE。
  profile: resolveProfile(),
  // 联网检索开关。**默认关闭**：选中文字会被发往第三方搜索服务，
  // 内部文件场景必须由用户显式打开。且严格依据档（strict）强制不生效（见下方 gate）。
  searchEnabled: process.env.SEARCH_ENABLED === '1',
};

const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use('/api', createFilesRouter(fileStore));

/**
 * 同源校验：仅接受 POST，并拒绝跨源请求。
 * 开发态前端(5179)经 Vite 代理到后端(5178) 属正常链路，
 * 因此以「是否存在 Origin 且与本服务对外地址不符」为拒绝依据，
 * 并允许通过 ALLOWED_ORIGINS 显式放行。
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true; // 非浏览器客户端（curl、服务端调用）
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const o = new URL(origin);
    // 反向代理场景：X-Forwarded-Host 才是用户实际访问的域名
    const publicHost = (req.get('x-forwarded-host') || req.get('host') || '').split(':')[0];
    const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
    // 本机开发：前后端不同端口同主机，视为同源
    if (localHosts.has(o.hostname) && localHosts.has(publicHost)) return true;
    return o.host === req.get('host');
  } catch {
    return false;
  }
}

/**
 * 流式解释：POST /api/ai/stream
 * SSE 事件（前端 web/src/sse.js 逐一对应）：
 *   {phase:'start', depth}      开始
 *   {step:{...}}                步骤时间线增量（思考/检索/来源/作答），按 key upsert
 *   {reset:true}                清空正文缓冲（过渡轮那句「我先查一下…」不该留在答案里）
 *   {r:'...'}                   推理过程增量
 *   {t:'...'}                   可见解释文本增量
 *   {done:true, ...}            结束，带 profile/disclaimer/steps/sources/rounds/searched/elapsedMs
 *   {error:'...'}               出错
 */
app.post('/api/ai/stream', async (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ error: '跨源请求被拒绝' });

  const parsed = parseExplainRequest(req.body, runtimeSettings);
  if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
  const {
    text,
    question,
    depth,
    paragraphText,
    parentAnswer,
    paragraphId,
    profile: requestedProfile,
  } = parsed.value;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ phase: 'start', depth });

  const controller = new AbortController();
  // 注意：必须监听 res 而非 req。请求体被 express.json() 读完后，
  // Node 会立即触发 IncomingMessage 的 'close' 事件，用 req 会误判为客户端断开。
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  // 用户提示词里的任务措辞也要跟着档位走，
  // 否则「严格依据档」却仍在要求「可补充必要背景」，自相矛盾。
  //
  // 档位的基准是服务端设置（/api/settings 的 profile）；请求体里带合法
  // profile 时按单次请求覆盖（validate.js 已把非法值收敛掉）。
  // 服务端设为严格依据档时不允许被单次请求降级——「严格依据档不联网」
  // 是硬承诺，降级会顺带把联网能力放出来。
  const profile =
    runtimeSettings.profile === 'strict' || requestedProfile === 'strict'
      ? 'strict'
      : 'explain';

  const userParts = [];
  const isFollowup = depth > 0 && Boolean(parentAnswer);

  if (isFollowup) {
    // 请求体只带 parentAnswer（父轮答案正文），没有父轮的提问原文，
    // 因此 parentQuestion 传空串，避免把本轮问题重复当成上文提问
    userParts.push(buildFollowupPrompt('', parentAnswer, question || text));
  } else if (question) {
    userParts.push(`【本段提问】${question}`);
  }

  if (isFollowup) {
    // 追问轮次：上下文已由上文段落承载，原文只补一份用于溯源，
    // 不再重复拼「本段提问」，否则同一问题会在 prompt 里出现两次
    const excerpt = paragraphText || text;
    if (excerpt) {
      userParts.push(
        `【原文依据】${paragraphId ? `(${paragraphId})` : ''}\n${excerpt}`,
      );
    }
    userParts.push(
      profile === 'strict'
        ? '【任务】仅依据上述原文与上文回答作答，不得引入原文之外的信息。'
        : '【任务】把追问的部分讲清楚；可补充必要背景，但与原文区分。',
    );
  } else if (paragraphText) {
    userParts.push(`【当前选中内容】\n${text}`);
    if (paragraphText !== text) {
      userParts.push(`【所属段落原文】${paragraphId ? `(${paragraphId})` : ''}\n${paragraphText}`);
    }
    if (!question) {
      userParts.push(
        profile === 'strict' ? '【任务】解释上述选中内容。' : '【任务】把上述选中内容讲清楚，讲透。',
      );
    }
  } else {
    userParts.push(`【原文段落】${paragraphId ? `(${paragraphId})` : ''}\n${text}`);
    if (question) userParts.push(`【本段提问】${question}`);
    else {
      userParts.push(
        profile === 'strict' ? '【任务】解释上述原文。' : '【任务】把上述这段讲清楚，讲透。',
      );
    }
  }

  /*
   * 联网闸门：**严格依据档（strict）强制不联网**。
   *
   * 严格依据档的立身之本是「只依据原文 + 逐条标注依据段落 + 可点回原文」，
   * 一旦掺进外部网页，溯源链就断了，也就没有存在意义。
   * 因此联网只在讲透档（explain）、且用户显式打开时才生效。
   */
  const searchActive =
    runtimeSettings.searchEnabled === true &&
    profile !== 'strict' &&
    Boolean(searchService?.enabled);

  // 组装顺序（档位正文 → 联网时检索规范 → 讲透档回答规范）由 buildSystemPrompt 统一负责，
  // 避免 composition 散在这里，也让「strict 到底带没带多余段落」可以离线单测
  const systemPrompt = buildSystemPrompt({ profile, searchActive });

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userParts.join('\n\n') },
  ];

  // 预算按「本次实际送进 prompt 的原文长度」算，
  // 追问轮 paragraphText 为空，要带上 parentAnswer 才不会低估
  const maxTokens = maxTokensFor(
    Math.max(text.length, paragraphText.length || 0, parentAnswer.length || 0),
  );

  try {
    const result = await runExplainLoop({
      baseUrl: DEEPSEEK_BASE,
      apiKey: API_KEY,
      model: runtimeSettings.model,
      messages,
      maxTokens,
      temperature: LIMITS.temperature,
      effort: runtimeSettings.effort,
      searchService: searchActive ? searchService : null,
      onEvent: send,
      signal: controller.signal,
    });

    if (result.error) {
      send({
        error: `模型服务返回 ${result.error.status}`,
        detail: result.error.detail,
      });
      return res.end();
    }

    send({
      done: true,
      reasoningChars: result.reasoningChars,
      profile,
      disclaimer: disclaimerFor(profile),
      // 步骤时间线与来源清单：前端即使漏收了 step 事件，
      // 也能从 done 里拿到完整的一份，避免时间线残缺
      steps: result.steps,
      sources: result.sources,
      rounds: result.rounds,
      searched: result.searched,
      elapsedMs: result.elapsedMs,
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      send({ error: '解释服务异常', detail: String(err.message || err).slice(0, 300) });
    }
  } finally {
    res.end();
  }
});

/** 推理强度可选值（与模型侧声明对齐） */
const EFFORT_LEVELS = ['off', 'low', 'medium', 'high'];

/** 开关与配置读写 */
app.get('/api/settings', (_req, res) => {
  res.json({
    ...runtimeSettings,
    limits: LIMITS,
    effortLevels: EFFORT_LEVELS,
    // 档位文案的唯一真源：前端直接渲染，不硬编码
    profileOptions: PROFILE_OPTIONS,
    // 检索能力是否具备（provider 是否配好）。前端据此决定联网开关能否点。
    searchAvailable: Boolean(searchService?.enabled),
    searchInfo: searchService ? searchService.describe() : null,
  });
});

app.post('/api/settings', (req, res) => {
  const { enabled, model, profile, effort, searchEnabled } = req.body || {};
  if (typeof enabled === 'boolean') runtimeSettings.enabled = enabled;
  if (typeof model === 'string' && model.trim()) runtimeSettings.model = model.trim();
  // 解释档位。它同时影响 system prompt、任务措辞与落款提示三处，
  // 不能只改提示词，否则会出现「严格依据档却仍要求可补充背景」。
  // 只接受两档枚举：非法值静默忽略并回落（不返回 400，不写坏值）。
  if (profile !== undefined) runtimeSettings.profile = normalizeProfile(profile);
  if (typeof effort === 'string' && EFFORT_LEVELS.includes(effort)) {
    runtimeSettings.effort = effort;
  }
  // 联网开关。允许打开，但真正的生效条件是「讲透档 + provider 已配置」，
  // 由 /api/ai/stream 的闸门统一裁决——这里不做隐式改写，
  // 否则用户切到严格依据档再切回来会发现开关被悄悄关掉了。
  if (typeof searchEnabled === 'boolean') runtimeSettings.searchEnabled = searchEnabled;
  res.json({
    ok: true,
    ...runtimeSettings,
    effortLevels: EFFORT_LEVELS,
    profileOptions: PROFILE_OPTIONS,
    searchAvailable: Boolean(searchService?.enabled),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: runtimeSettings.model,
    keyConfigured: Boolean(API_KEY),
    profile: runtimeSettings.profile,
    limits: LIMITS,
    search: searchService ? searchService.describe() : { provider: 'none', configured: false },
    searchEnabled: runtimeSettings.searchEnabled === true,
  });
});

// 生产模式下托管前端构建产物
const dist = path.join(__dirname, '..', 'dist');
const indexHtml = path.join(dist, 'index.html');
app.use(express.static(dist));

// SPA 回退。必须排除带扩展名的路径（如 /assets/index-xxx.js）：
// 否则构建产物缺失时会把 index.html 返回给 .js 请求，
// 浏览器报的是 MIME 错误而不是 404，排查成本极高。
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(indexHtml, (err) => {
    if (err) next(err);
  });
});

// 明确的 404，避免落到 express 默认的 HTML 错误页
app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));

app.listen(PORT, () => {
  console.log(`[桥接层] 已启动 http://localhost:${PORT}`);
  console.log(`[桥接层] 模型=${runtimeSettings.model} key=${API_KEY ? '已配置' : '未配置(缺失)'}`);
  const opt = PROFILE_OPTIONS.find((o) => o.value === runtimeSettings.profile);
  console.log(`[桥接层] 解释档位=${runtimeSettings.profile}（${opt?.label ?? ''}）`);
  if (searchService?.enabled) {
    const info = searchService.describe();
    console.log(
      `[桥接层] 联网检索=${info.provider} 权威源=${info.open ? '未限制' : `${info.allowedDomains.length} 个域名`} ` +
        `开关=${runtimeSettings.searchEnabled ? '开' : '关（默认，需在设置里打开）'}`,
    );
  } else {
    console.log(
      '[桥接层] 联网检索=未启用（.env 里设 SEARCH_PROVIDER=deepseek 用现有 Key 走 DeepSeek 原生搜索，' +
        '或设 bocha 并填 BOCHA_API_KEY）',
    );
  }
});