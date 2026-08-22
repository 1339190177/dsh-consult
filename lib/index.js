/**
 * dsh-advisor — 跨供应商第二意见服务（本地插件）
 *
 * F1  DSH_MODEL=provider/model 主代理请求改道（agent/request waterfall，
 *     不受 settings.yaml agent-default-model 用户层压制，路由写入会话日志）
 * F2  OpenAI 兼容端点 POST /v1/chat/completions（复用现有 web 端口，
 *     Bearer token，SSE 流式 + 非流式，仅回环，无 CORS）
 * F3  consult 模型工具（默认路由到与当前模型异源的供应商，可显式指定）
 * F4  结构化输出（recommendation/reasons/confidence/risks/alternatives）
 * F5  上游路由透传（x-model-upstream 响应头 + 后端标记，尽力而为）
 * F6  咨询审计（$DSH_HOME/storages/advisor/audit.jsonl）
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const NAME = 'dsh-consult'
const HTTP_PATH = '/v1/chat/completions'
const BODY_LIMIT_BYTES = 4 << 20
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
// v4-flash 等混合推理模型：思考与正文共享 maxTokens，1200 会被思考吃光导致空意见。
// 答案长度由 system 提示约束（≤300 字），这里只防失控，不掐思考。
const CONSULT_MAX_TOKENS = 4000

/** OpenAI 风格思考控制 → dsh 原生 reasoningEffort（off/high/max 词表由 resolveEffort 校验）。
 *  兼容三种写法：thinking:{type:'disabled'} / enable_thinking:false / reasoning_effort:'off'。
 *  返回 undefined = 不控制（provider 默认自适应思考）。 */
function thinkingControlToEffort(body) {
  if (body?.thinking?.type === 'disabled' || body?.enable_thinking === false) return 'off'
  return undefined
}

/** 默认顾问路由：官方 DeepSeek（稳定、身份可验证、无中转封禁风险）。
 *  优先级：显式 model 参数 > settings advisor.route > 此默认。 */
const DEFAULT_ROUTE = 'deepseek-official/deepseek-v4-flash'

const ADVISOR_SYSTEM_STRUCTURED = [
  '你是资深技术顾问，为另一个 AI 编码助手提供第二意见。',
  '必须只输出一个 JSON 对象（不要 markdown 代码围栏、不要任何多余文字），字段：',
  '{"recommendation":"明确的推荐方案","reasons":["关键理由"],"confidence":"high|medium|low","risks":["主要风险"],"alternatives":[{"option":"替代方案","when":"何时选它"}]}',
  'reasons 与 risks 各不超过 3 条；整体不超过 300 字。意见仅供参考，主助手保留决策权。',
].join('\n')

const ADVISOR_SYSTEM_TEXT = [
  '你是资深技术顾问，为另一个 AI 编码助手提供第二意见。',
  '直接给出：推荐方案 + 关键理由（注明确定程度）+ 主要风险 + 替代方案何时选它。不超过 300 字。',
  '意见仅供参考，主助手保留决策权。',
].join('\n')

//#region 小工具

/** 解析 "provider/model"（按最后一个斜杠切分，两段都非空才算有效）。 */
function parseRoute(raw) {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  const i = trimmed.lastIndexOf('/')
  if (i <= 0 || i >= trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, i), model: trimmed.slice(i + 1) }
}

//#region scout：带实时 web_search 的调查顾问（DeepSeek 官方 Anthropic 兼容端点）

const SCOUT_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'
const SCOUT_SYSTEM = [
  '你是带实时网络搜索能力的技术调查顾问，为主 AI 编码助手服务。',
  '对方（及它的人类用户）已无法凭已有知识解决这个问题，才启用你。',
  '要求：先用 web_search 主动调查（必要时多次、更换关键词），再下结论；',
  '结论必须注明信息新鲜度并附来源链接；若调查后仍无定论，明确说"搜不到可靠信息"并列出已尝试的关键词。',
  '若摆渡来的上下文明显缺失关键信息（报错原文/版本号/代码位置），先指出缺什么，再基于最可能假设调查并标注假设。',
  '正文 ≤400 字，末尾附来源列表。',
].join('\n')

function readDeepSeekOfficialKey() {
  const env = process.env.DEEPSEEK_API_KEY?.trim()
  if (env) return env
  try {
    const m = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
      .match(/^DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)/m)
    return m?.[1]
  } catch { return undefined }
}

async function consultScout(question, context, { signal } = {}) {
  const key = readDeepSeekOfficialKey()
  if (!key) throw Object.assign(
    new Error('scout 需要 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）'),
    { statusCode: 503 })
  const resp = await fetch(SCOUT_ENDPOINT, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: 1500,
      system: SCOUT_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text',
        text: context ? `【问题】${question}\n【已知上下文】${context}` : question }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
    signal: signal ?? AbortSignal.timeout(180_000),
  })
  if (!resp.ok) throw Object.assign(
    new Error(`scout 上游 ${resp.status}: ${(await resp.text()).slice(0, 200)}`),
    { statusCode: 502 })
  const data = await resp.json()
  const texts = [], sources = []
  let rounds = 0
  for (const block of data.content ?? []) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'web_search_tool_result') {
      rounds += 1
      for (const c of block.content ?? []) {
        if (c?.url) sources.push({ url: c.url, title: c.title ?? '' })
      }
    }
  }
  return { opinion: texts.join('\n').trim(), sources, searchRounds: rounds, usage: data.usage }
}

//#endregion

let idCounter = 0
function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${(idCounter += 1).toString(36)}`
}

function userTextMessage(text) {
  return {
    id: genId('advisor-msg'),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'tool' },
  }
}

function assistantTextMessage(text) {
  return {
    id: genId('advisor-msg'),
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model' },
  }
}

function truncate(text, limit) {
  if (typeof text !== 'string') return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** 从顾问回复中宽松提取第一个 JSON 对象（容忍代码围栏与前后闲话）。 */
function extractJson(text) {
  if (typeof text !== 'string') return undefined
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced !== null ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * 拉取整个模型流。不走 for-await/AsyncIterator 符号（动态沙箱跨 realm
 * 的 well-known symbol 不保证一致），直接用生成器的 next()。
 */
async function pullStream(stream, onDelta) {
  const iterator = typeof stream.next === 'function'
    ? stream
    : (typeof stream[Symbol.asyncIterator] === 'function' ? stream[Symbol.asyncIterator]() : undefined)
  if (iterator === undefined) throw new Error('llm.stream 未返回可迭代流')
  let text = ''
  let reasoning = ''
  let usage
  let finish
  while (true) {
    const step = await iterator.next()
    if (step.done === true) break
    const chunk = step.value
    if (chunk.type === 'text-delta') {
      text += chunk.text
      if (onDelta !== undefined) onDelta(chunk.text)
    } else if (chunk.type === 'reasoning-delta') {
      reasoning += chunk.text
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'finish') {
      finish = chunk
    }
  }
  return { text, reasoning, usage, finish }
}

function finishReasonOf(finish) {
  if (finish === undefined) return 'stop'
  const kind = finish.reason?.kind
  if (kind === 'max-tokens') return 'length'
  if (kind === 'tool-calls') return 'tool_calls'
  if (kind === 'aborted') return 'aborted'
  return 'stop'
}

function assertStreamOk(result) {
  const kind = result.finish?.reason?.kind
  if (kind === 'error') {
    const failure = result.finish.reason.failure
    throw new Error(`顾问模型调用失败：${failure?.message ?? String(kind)}${failure?.code !== undefined ? `（${failure.code}）` : ''}`)
  }
  if (kind === 'aborted') throw new Error('顾问模型调用被中止')
  return result
}

/** 读取请求体（对 chunk 兼容 string/Buffer，跨 realm 安全）。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += typeof chunk === 'string' ? chunk.length : chunk.length
      if (size > limit) {
        const error = new Error('request body too large')
        error.statusCode = 413
        fail(error)
        req.destroy()
        return
      }
      parts.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(parts.join(''))
      }
    })
    req.on('error', fail)
  })
}

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

//#endregion

//#region 审计（F6）

const auditState = { dir: undefined, ready: false, chain: Promise.resolve() }
function auditDir() {
  if (auditState.dir === undefined) {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    auditState.dir = join(home, 'storages', 'advisor')
  }
  return auditState.dir
}

/** 串行追加一行审计记录；失败只记日志，绝不影响咨询主流程。 */
function audit(record) {
  const line = `${JSON.stringify(record)}\n`
  auditState.chain = auditState.chain.then(async () => {
    try {
      if (!auditState.ready) {
        await mkdir(auditDir(), { recursive: true })
        auditState.ready = true
      }
      await appendFile(join(auditDir(), 'audit.jsonl'), line)
    } catch (error) {
      console.error(NAME, '审计写入失败：', error instanceof Error ? error.message : error)
    }
  })
  return auditState.chain
}

//#endregion

//#region 路由解析（F3）

/**
 * 路由解析（v2 简化）：显式 model 参数 > settings advisor.route > 默认官方 DeepSeek。
 * 不再做"自动异源选择"——那是为 XQAPI 默认时代设计的复杂度；
 * 想换供应商就在设置面板/配置里显式指定（可配置），默认走最稳的官方（稳定）。
 */
async function resolveConsultRoute({ llm, explicit, configured }) {
  const providers = llm.listProviders().map((p) => p.id)
  const raw = (explicit !== undefined && explicit !== '')
    ? explicit
    : (configured !== undefined && configured.provider !== '' && configured.model !== ''
        ? `${configured.provider}/${configured.model}`
        : DEFAULT_ROUTE)
  const route = parseRoute(raw)
  if (route === undefined) {
    throw new Error(`consult：model 需为 "provider/model" 形式（收到 ${JSON.stringify(raw)}）。可用 provider：${providers.join(', ') || '（无）'}；默认 ${DEFAULT_ROUTE}`)
  }
  if (!providers.includes(route.provider)) {
    throw new Error(`consult：provider "${route.provider}" 未注册。可用：${providers.join(', ') || '（无）'}；默认 ${DEFAULT_ROUTE}`)
  }
  return { ...route, explicit: explicit !== undefined && explicit !== '' }
}

//#endregion

//#region consult 工具（F3/F4）

function consultPrompt(question, context) {
  const q = typeof question === 'string' ? question.trim() : ''
  const c = typeof context === 'string' ? context.trim() : ''
  return c === '' ? `【问题】${q}` : `【问题】${q}\n\n【上下文】${c}`
}

function renderOpinion(value) {
  if (value.structured) {
    const o = value.opinion ?? {}
    const lines = [`【外部顾问意见 · ${value.route.provider}/${value.route.model} · 仅供参考】`]
    if (typeof o.recommendation === 'string' && o.recommendation !== '') lines.push(`推荐：${o.recommendation}`)
    if (Array.isArray(o.reasons) && o.reasons.length > 0) lines.push(`关键理由：\n${o.reasons.map((r, i) => `${i + 1}. ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n')}`)
    if (typeof o.confidence === 'string' && o.confidence !== '') lines.push(`置信度：${o.confidence}`)
    if (Array.isArray(o.risks) && o.risks.length > 0) lines.push(`风险：\n${o.risks.map((r) => `- ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n')}`)
    if (Array.isArray(o.alternatives) && o.alternatives.length > 0) {
      lines.push(`替代方案：\n${o.alternatives.map((a) => `- ${typeof a?.option === 'string' ? a.option : JSON.stringify(a)}${typeof a?.when === 'string' && a.when !== '' ? `（何时选它：${a.when}）` : ''}`).join('\n')}`)
    }
    if (value.sameAsCurrent) lines.push('⚠ 顾问与当前模型同源，第二意见参考价值有限。')
    lines.push(`（耗时 ${value.durationMs}ms；已写入咨询审计。采纳与否请在你的回复中明确标注。）`)
    return lines.join('\n')
  }
  return [
    `【外部顾问意见 · ${value.route.provider}/${value.route.model} · 仅供参考】`,
    typeof value.opinion === 'string' ? value.opinion : JSON.stringify(value.opinion),
    value.sameAsCurrent ? '⚠ 顾问与当前模型同源，第二意见参考价值有限。' : '',
    `（耗时 ${value.durationMs}ms；已写入咨询审计。采纳与否请在你的回复中明确标注。）`,
  ].filter((s) => s !== '').join('\n')
}

const EFFORT_VOCAB = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 解析并校验 reasoning 等级（F 思维等级）。
 * 优先级：显式参数 > settings advisor.reasoningEffort > 不传（provider 默认）。
 * 逐模型校验（resolveModelInfo），不支持时显式报错并列出该模型支持的等级——绝不静默。
 */
async function resolveEffort(llm, route, explicit, configured) {
  const effort = explicit !== undefined && explicit !== '' ? explicit
    : (configured !== undefined && configured !== '' ? configured : undefined)
  if (effort === undefined) return undefined
  if (!EFFORT_VOCAB.includes(effort)) {
    throw new Error(`consult：reasoning 需为 ${EFFORT_VOCAB.join('/')} 之一（收到 ${JSON.stringify(effort)}）`)
  }
  let supported = null
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    supported = info?.reasoning?.efforts?.map((e) => e.id) ?? null
  } catch {
    supported = null
  }
  if (supported === null || !supported.includes(effort)) {
    throw new Error(`consult：模型 ${route.provider}/${route.model} 不支持 reasoning "${effort}"${supported ? `（支持：${supported.join('/')}）` : '（该模型无 reasoning 能力，如 glm-5.3）'}`)
  }
  return effort
}

function registerConsultTool(ctx, deps) {
  const tool = defineTool({
    name: 'consult',
    description:
      '遇到不确定的技术/领域决策时，向另一个供应商的模型征求第二意见（跨供应商交叉验证）。' +
      '适用：不熟悉的框架/库行为、参数选型、领域最佳实践、多方案取舍无把握。' +
      '不适用：能从本项目代码直接推断的问题。' +
      '默认自动路由到与当前模型异源的供应商（可显式传 model="provider/model"）；' +
      '返回推荐方案/关键理由/置信度/风险/替代方案。本地供应商路由时上下文不出本机；' +
      '若配置的顾问 route 是云端中转则只贴必要内容。意见仅供参考，你保留决策权。',
    parameters: {
      question: { type: 'string', required: true, description: '要决策的具体问题（一句话说清）' },
      context: { type: 'string', description: '相关上下文摘要：代码片段/参数/已试过什么' },
      model: { type: 'string', description: '显式指定顾问模型 "provider/model"（如 deepseek/deepseek-v4-flash）。缺省自动选异源供应商' },
      format: { type: 'string', description: 'structured（默认，结构化 JSON）或 text（纯文本意见）' },
      reasoning: { type: 'string', description: '顾问思维等级 off/minimal/low/medium/high/xhigh/max（按模型支持情况校验，不支持会明确报错）。缺省用 provider 默认（自适应思考）；难题可传 high/max' },
      mode: { type: 'string', description: 'plain（默认，本地异源顾问）或 scout（带实时 web_search 的调查顾问：先上网调查再回答，附来源链接）。scout 走 DeepSeek 官方 API 且上下文会外发——仅当你和人类用户都无法解决、需要外部世界知识时使用' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderOpinion(value) }],
    },
    async execute(args, exec) {
      const started = Date.now()
      if (args.mode === 'scout') {
        const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : undefined
        try {
          const scout = await consultScout(args.question, args.context, { signal: exec.signal })
          const durationMs = Date.now() - started
          audit({
            ts: new Date().toISOString(), source: 'tool', sessionId, mode: 'scout',
            question: truncate(args.question, 200),
            route: { provider: 'deepseek-official', model: 'deepseek-v4-flash+web_search' },
            durationMs, ok: true, structured: false, adopted: null,
            searchRounds: scout.searchRounds, sources: scout.sources.length,
          })
          return {
            backend: 'dsh-advisor-scout(deepseek-official+web_search)', mode: 'scout',
            durationMs, structured: false,
            opinion: scout.opinion, sources: scout.sources,
            searchRounds: scout.searchRounds,
            usage: scout.usage,
          }
        } catch (error) {
          audit({
            ts: new Date().toISOString(), source: 'tool', sessionId, mode: 'scout',
            question: truncate(args.question, 200),
            durationMs: Date.now() - started, ok: false,
            error: String(error.message).slice(0, 200),
          })
          throw error
        }
      }
      const route = await resolveConsultRoute({
        llm: deps.llm,
        explicit: args.model,
        configured: deps.configuredRoute(),
      })
      const effort = await resolveEffort(deps.llm, route, args.reasoning, deps.configuredEffort())
      const current = deps.agentDefaultModel === undefined ? undefined : deps.agentDefaultModel.currentSelection()
      const sameAsCurrent = current !== undefined && current.provider === route.provider && current.model === route.model
      const wantStructured = args.format !== 'text'
      const system = wantStructured ? ADVISOR_SYSTEM_STRUCTURED : ADVISOR_SYSTEM_TEXT
      const messages = [userTextMessage(consultPrompt(args.question, args.context))]
      const result = assertStreamOk(await pullStream(deps.llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages,
        maxTokens: CONSULT_MAX_TOKENS,
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        signal: exec.signal,
      })))
      const durationMs = Date.now() - started
      const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : undefined
      const opinion = wantStructured ? (extractJson(result.text) ?? result.text.trim()) : result.text.trim()
      const structured = wantStructured && opinion !== null && typeof opinion === 'object'
      audit({
        ts: new Date().toISOString(),
        source: 'tool',
        sessionId,
        question: truncate(args.question, 200),
        route: { provider: route.provider, model: route.model },
        ...(effort === undefined ? {} : { effort }),
        durationMs,
        ok: true,
        structured,
        adopted: null,
      })
      return {
        backend: `dsh-advisor(${route.model}@${route.provider}${effort === undefined ? '' : `,effort=${effort}`})`,
        route: { provider: route.provider, model: route.model },
        ...(effort === undefined ? {} : { effort }),
        sameAsCurrent,
        durationMs,
        structured,
        opinion,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      }
    },
  })
  ctx.effect(() => deps.tools.register(tool), `${NAME}: consult 工具`)
}

//#endregion

//#region OpenAI 兼容端点（F2/F4/F5）

function openaiError(message, type, code) {
  return { error: { message, type, code } }
}

function usageOf(usage) {
  if (usage === undefined) return undefined
  const prompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const completion = (usage.outputTokens ?? 0)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

/** 把 OpenAI messages 转成 dsh Message 列表 + system 提示。 */
function mapOpenAiMessages(input) {
  if (!Array.isArray(input) || input.length === 0) throw Object.assign(new Error('`messages` 必须为非空数组'), { statusCode: 400 })
  const systemParts = []
  const messages = []
  for (const message of input) {
    if (message === null || typeof message !== 'object' || typeof message.role !== 'string') {
      throw Object.assign(new Error('`messages` 每项需含 role 字段'), { statusCode: 400 })
    }
    let text = ''
    if (typeof message.content === 'string') text = message.content
    else if (Array.isArray(message.content)) {
      text = message.content
        .map((part) => (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
        .join('')
    } else if (message.content !== undefined && message.content !== null) {
      throw Object.assign(new Error('`content` 仅支持 string 或 text 数组'), { statusCode: 400 })
    }
    if (message.role === 'system') systemParts.push(text)
    else if (message.role === 'user') messages.push(userTextMessage(text))
    else if (message.role === 'assistant') messages.push(assistantTextMessage(text))
    else throw Object.assign(new Error(`不支持的 role "${message.role}"（支持 system/user/assistant）`), { statusCode: 400 })
  }
  if (messages.length === 0) throw Object.assign(new Error('`messages` 需要至少一条 user/assistant 消息'), { statusCode: 400 })
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages }
}

/** response_format → 追加到 system 的结构化约束说明（提示级执行，尽力而为）。 */
function responseFormatInstruction(responseFormat) {
  if (responseFormat === null || typeof responseFormat !== 'object') return ''
  if (responseFormat.type === 'json_schema') {
    const schema = responseFormat.json_schema?.schema
    if (schema === undefined) throw Object.assign(new Error('response_format.json_schema.schema 缺失'), { statusCode: 400 })
    return `\n\n输出必须是符合以下 JSON Schema 的单个 JSON 对象（不要代码围栏）：${JSON.stringify(schema)}`
  }
  if (responseFormat.type === 'json_object') return '\n\n输出必须是单个合法 JSON 对象（不要代码围栏）。'
  return ''
}

function registerHttpEndpoint(ctx, deps) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.log(NAME, '：当前组合未挂载 webServer，跳过 OpenAI 兼容端点（headless 模式属正常）')
    return
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: HTTP_PATH,
    handler: async (req, res) => {
      const started = Date.now()
      const headers = { 'x-model-upstream': '' }
      const sendJson = (status, obj, extra = {}) => {
        const body = JSON.stringify(obj)
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': byteLength(body),
          ...headers,
          ...extra,
        })
        res.end(body)
      }
      try {
        // 安全边界：仅回环 + 无 CORS + Bearer token
        const remote = req.socket?.remoteAddress ?? ''
        if (!LOOPBACKS.has(remote)) {
          sendJson(403, openaiError('advisor endpoint is loopback-only', 'permission_error', 'loopback_only'))
          return
        }
        if (req.method !== 'POST') {
          sendJson(405, openaiError(`${req.method} 不支持；本端点只接受 POST（OpenAI chat/completions 协议）`, 'invalid_request_error', 'method_not_allowed'), { allow: 'POST' })
          return
        }
        const expected = deps.token()
        const auth = req.headers?.authorization ?? ''
        const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
        if (expected === undefined || expected === '') {
          sendJson(401, openaiError('顾问端点尚未配置 token：请在 ~/.dsh/settings.yaml 的 advisor.token 写入随机串后重启', 'auth_error', 'token_not_configured'))
          return
        }
        if (presented !== expected) {
          sendJson(401, openaiError('invalid bearer token（settings.yaml 的 advisor.token）', 'auth_error', 'invalid_api_key'))
          return
        }
        const startedHttp = Date.now()
        const raw = await readBody(req, BODY_LIMIT_BYTES)
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          sendJson(400, openaiError('请求体不是合法 JSON', 'invalid_request_error', 'invalid_json'))
          return
        }
        if (body.mode === 'scout') {
          const lastUser = [...(Array.isArray(body.messages) ? body.messages : [])].reverse()
            .find((m) => m?.role === 'user')
          const q = typeof lastUser?.content === 'string' ? lastUser.content
            : Array.isArray(lastUser?.content)
              ? lastUser.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n')
              : ''
          if (!q.trim()) {
            sendJson(400, openaiError('scout 需要 messages 里至少一条 user 文本', 'invalid_request_error', 'empty_question'))
            return
          }
          headers['x-advisor-mode'] = 'scout'
          headers['x-model-upstream'] = 'deepseek-official/deepseek-v4-flash+web_search'
          try {
            const scout = await consultScout(q, undefined, {})
            audit({
              ts: new Date().toISOString(), source: 'http', mode: 'scout',
              question: truncate(q, 200),
              route: { provider: 'deepseek-official', model: 'deepseek-v4-flash+web_search' },
              durationMs: Date.now() - startedHttp, ok: true, structured: false, adopted: null,
              searchRounds: scout.searchRounds, sources: scout.sources.length,
            })
            sendJson(200, {
              id: genId('scout'), object: 'chat.completion',
              created: Math.floor(Date.now() / 1000), model: 'dsh-advisor/scout',
              choices: [{ index: 0, message: { role: 'assistant', content: scout.opinion }, finish_reason: 'stop' }],
              usage: scout.usage ?? {},
              advisor: { mode: 'scout', search_rounds: scout.searchRounds, sources: scout.sources },
            })
          } catch (error) {
            audit({
              ts: new Date().toISOString(), source: 'http', mode: 'scout',
              question: truncate(q, 200),
              durationMs: Date.now() - startedHttp, ok: false,
              error: String(error.message).slice(0, 200),
            })
            sendJson(error.statusCode ?? 502, openaiError(String(error.message).slice(0, 200), 'api_error', 'scout_failed'))
          }
          return
        }
        // model 可选：缺省走 默认官方 > settings advisor.route（与 consult 工具同一解析器）
        let route
        try {
          route = await resolveConsultRoute({
            llm: deps.llm,
            explicit: typeof body.model === 'string' && body.model !== '' ? body.model : undefined,
            configured: deps.configuredRoute(),
          })
        } catch (error) {
          sendJson(400, openaiError(error.message, 'invalid_request_error', 'invalid_model'))
          return
        }
        headers['x-model-upstream'] = `${route.provider}/${route.model}`
        // 思考控制：显式 reasoning_effort 优先，其次 OpenAI 风格 thinking/enable_thinking
        // （此前这两个字段被 options 白名单静默丢弃——"禁思考时灵时不灵"的真凶之一）
        const explicitEffort = body.reasoning_effort ?? thinkingControlToEffort(body)
        let effort
        try {
          effort = await resolveEffort(deps.llm, route, explicitEffort, undefined)
        } catch (error) {
          sendJson(400, openaiError(error.message, 'invalid_request_error', 'invalid_reasoning_effort'))
          return
        }
        if (effort !== undefined) headers['x-reasoning-effort'] = effort
        let mapped
        try {
          mapped = mapOpenAiMessages(body.messages)
        } catch (error) {
          sendJson(error.statusCode ?? 400, openaiError(error.message, 'invalid_request_error', 'invalid_messages'))
          return
        }
        let instruction = ''
        try {
          instruction = responseFormatInstruction(body.response_format)
        } catch (error) {
          sendJson(error.statusCode ?? 400, openaiError(error.message, 'invalid_request_error', 'invalid_response_format'))
          return
        }
        const system = mapped.system === undefined ? undefined : mapped.system + instruction
        // 服务端超时：上游挂起时中止模型调用（实测官方路由偶发无限挂起——
        // 没有它，客户端断开后 handler 永远 pending 且可能卡住 provider 资源）。
        // 正常复杂问答可到 ~65s，默认上限 120s，DSH_CONSULT_TIMEOUT_MS 可调。
        const abort = new AbortController()
        const abortTimer = setTimeout(
          () => abort.abort(),
          Math.max(10_000, Number(process.env.DSH_CONSULT_TIMEOUT_MS) || 120_000))
        const options = {
          provider: route.provider,
          model: route.model,
          messages: mapped.messages,
          ...(system !== undefined ? { system } : {}),
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          ...(Number.isFinite(body.max_tokens) && body.max_tokens > 0 ? { maxTokens: body.max_tokens } : {}),
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          signal: abort.signal,
        }
        const completionId = `chatcmpl-${randomUUID()}`
        const created = Math.floor(Date.now() / 1000)
        const modelLabel = `${route.provider}/${route.model}`
        const auditQuestion = truncate(([...body.messages].reverse().find((m) => m?.role === 'user')?.content ?? ''), 200)
        const wantsStream = body.stream === true
        const finish = () => {
          audit({
            ts: new Date().toISOString(),
            source: 'http',
            question: auditQuestion,
            route: { provider: route.provider, model: route.model },
            ...(effort === undefined ? {} : { effort }),
            durationMs: Date.now() - started,
            ok: true,
            structured: body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object',
            adopted: null,
          })
        }
        if (!wantsStream) {
          let result
          try {
            result = assertStreamOk(await pullStream(deps.llm.stream(options)))
          } catch (error) {
            if (abort.signal.aborted) {
              sendJson(504, openaiError(`模型调用超时（${Math.round((Number(process.env.DSH_CONSULT_TIMEOUT_MS) || 120_000) / 1000)}s，已中止）`, 'api_error', 'upstream_timeout'))
            }
            throw error
          } finally {
            clearTimeout(abortTimer)
          }
          const payload = {
            id: completionId,
            object: 'chat.completion',
            created,
            model: modelLabel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: result.text },
              finish_reason: finishReasonOf(result.finish),
            }],
            ...(usageOf(result.usage) === undefined ? {} : { usage: usageOf(result.usage) }),
          }
          finish()
          sendJson(200, payload)
          return
        }
        // SSE 流式
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-model-upstream': headers['x-model-upstream'],
          'x-accel-buffering': 'no',
        })
        const sendEvent = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        const chunkBase = { id: completionId, object: 'chat.completion.chunk', created, model: modelLabel }
        sendEvent({ ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
        try {
          const result = assertStreamOk(await pullStream(deps.llm.stream(options), (delta) => {
            sendEvent({ ...chunkBase, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
          }))
          sendEvent({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: finishReasonOf(result.finish) }] })
          const usage = usageOf(result.usage)
          if (usage !== undefined) sendEvent({ ...chunkBase, choices: [], usage })
          finish()
        } catch (error) {
          sendEvent({ error: { message: error instanceof Error ? error.message : String(error), type: 'api_error' } })
        }
        res.write('data: [DONE]\n\n')
        res.end()
        clearTimeout(abortTimer)
      } catch (error) {
        clearTimeout(abortTimer)
        const status = error instanceof Error && typeof error.statusCode === 'number' ? error.statusCode : 500
        try {
          sendJson(status, openaiError(error instanceof Error ? error.message : String(error), 'api_error', status === 413 ? 'body_too_large' : 'internal_error'))
        } catch {
          /* 响应已提交则忽略 */
        }
      }
    },
  }), `${NAME}: ${HTTP_PATH} 端点`)
  console.log(NAME, `：OpenAI 兼容端点已挂载 → POST http://127.0.0.1:3080${HTTP_PATH}（Bearer token 见 settings.yaml 的 advisor.token）`)
}

//#endregion

//#region 可视化配置 API（设置面板的数据面：/api/dsh-consult/config）

/** 供面板读取的供应商目录（id + 模型列表，逐家容错）。 */
async function providerCatalog(llm) {
  const out = []
  for (const p of llm.listProviders()) {
    let models = []
    try {
      models = (await llm.listModels(p.id)).map((m) => ({ id: m.id, name: m.name }))
    } catch { models = [] }
    out.push({ id: p.id, models })
  }
  return out
}

/**
 * GET  /api/dsh-consult/config → 当前配置 + 供应商目录 + 兜底链（面板数据源）
 * POST /api/dsh-consult/config → {route: {provider,model}|null, reasoningEffort: ''}
 *        写回 settings.yaml 的 advisor 段（经注册的 settings scope，非裸写文件）。
 * 安全：仅回环；POST 校验 Origin 同源（浏览器跨站必带 Origin，本地 curl 无 Origin 放行）。
 */
function registerConfigEndpoint(ctx, deps) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': byteLength(body) })
    res.end(body)
  }
  const loopback = (req) => LOOPBACKS.has(req.socket?.remoteAddress ?? '')
  const sameOrigin = (req) => {
    const origin = req.headers?.origin
    if (origin === undefined || origin === '') return true // 非浏览器本地客户端
    const host = req.headers?.host ?? ''
    return origin === `http://${host}` || origin === `https://${host}`
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-consult/config',
    handler: async (req, res) => {
      try {
        if (!loopback(req)) return sendJson(res, 403, { error: 'loopback only' })
        if (req.method === 'GET') {
          const route = deps.configuredRoute()
          return sendJson(res, 200, {
            route: route === undefined ? null : route,
            reasoningEffort: deps.configuredEffort() ?? '',
            tokenConfigured: deps.token() !== '',
            providers: await providerCatalog(deps.llm),
            defaultRoute: DEFAULT_ROUTE,
            endpoint: HTTP_PATH,
          })
        }
        if (req.method === 'POST') {
          if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin rejected' })
          const raw = await readBody(req, 1 << 20)
          let body
          try { body = JSON.parse(raw) } catch { return sendJson(res, 400, { error: 'invalid json' }) }
          const scope = deps.settingsScope()
          if (scope === undefined) return sendJson(res, 503, { error: 'settings 服务未就绪，稍后重试' })
          const patch = {}
          if (body.route === null) {
            patch.route = { provider: '', model: '' } // 清空 = 自动异源路由
          } else if (body.route !== undefined) {
            const r = body.route ?? {}
            if (typeof r.provider !== 'string' || typeof r.model !== 'string' || !r.provider || !r.model) {
              return sendJson(res, 400, { error: 'route 需为 {provider, model} 或 null' })
            }
            const known = deps.llm.listProviders().some((p) => p.id === r.provider)
            if (!known) return sendJson(res, 400, { error: `provider "${r.provider}" 未注册` })
            patch.route = { provider: r.provider, model: r.model }
          }
          if (body.reasoningEffort !== undefined) {
            const e = body.reasoningEffort
            if (e !== '' && !EFFORT_VOCAB.includes(e)) {
              return sendJson(res, 400, { error: `reasoningEffort 需为 ''/${EFFORT_VOCAB.join('/')} 之一` })
            }
            patch.reasoningEffort = e
          }
          await scope.update(patch)
          console.log(NAME, `：面板更新配置 ${JSON.stringify(patch)}`)
          return sendJson(res, 200, { ok: true })
        }
        return sendJson(res, 405, { error: 'GET/POST only' })
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error).slice(0, 200) })
      }
    },
  }), `${NAME}: /api/dsh-consult/config`)
  console.log(NAME, '：配置面板 API 已挂载 → GET/POST http://127.0.0.1:3080/api/dsh-consult/config（设置页「顾问」分区）')
}

//#endregion

//#region DSH_MODEL 主代理改道（F1）

function registerModelOverride(ctx) {
  const target = parseRoute(process.env.DSH_MODEL ?? '')
  if (process.env.DSH_MODEL !== undefined && target === undefined) {
    console.error(NAME, `：DSH_MODEL=${JSON.stringify(process.env.DSH_MODEL)} 不是合法的 "provider/model"，已忽略`)
    return
  }
  if (target === undefined) return
  let warnedUnknown = false
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    if (config.provider === target.provider && config.model === target.model) return config
    if (!warnedUnknown) {
      warnedUnknown = true
      const providers = ctx.get('llm')?.listProviders().map((p) => p.id) ?? []
      if (providers.length > 0 && !providers.includes(target.provider)) {
        console.error(NAME, `：DSH_MODEL 指向未注册 provider "${target.provider}"（可用：${providers.join(', ')}），本次改道将在模型解析处显式报错`)
      }
    }
    const agentId = payload.agent && typeof payload.agent.id === 'string' ? payload.agent.id : '?'
    console.log(NAME, `：DSH_MODEL 改道 ${config.provider}/${config.model} → ${target.provider}/${target.model}（agent ${agentId} turn ${payload.turn}）`)
    return { ...config, provider: target.provider, model: target.model }
  })
}

//#endregion

export const name = NAME
export const inject = ['llm', 'tools']
export const Config = z.object({
  httpEnabled: z.boolean().default(true),
  token: z.string().default(''),
  route: z.object({ provider: z.string(), model: z.string() }).default({ provider: '', model: '' }),
  reasoningEffort: z.string().default(''),
})

export function apply(ctx, config) {
  const agentDefaultModel = ctx.get('agentDefaultModel')

  // settings.yaml 的 `advisor:` 段：token 与默认顾问路由（用户层覆盖组合层）。
  // 用 ctx.inject 等待 settings 服务挂载（激活时它可能尚未就绪）。
  let scope
  ctx.inject(['settings'], (sctx) => {
    scope = sctx.settings.register('advisor', z.object({
      token: z.string().default(''),
      route: z.object({ provider: z.string(), model: z.string() }).default({ provider: '', model: '' }),
      reasoningEffort: z.string().default(''),
    }), { base: { token: config.token, route: config.route, reasoningEffort: config.reasoningEffort } })
    if (scope.get().token === '' && config.token === '') {
      const generated = `dsha_${randomUUID().replace(/-/g, '')}`
      scope.update({ token: generated }).then(() => {
        console.log(NAME, '：已生成顾问端点 token 并写入 settings.yaml（advisor.token）')
      }, (error) => {
        console.error(NAME, '：advisor.token 自动生成失败：', error instanceof Error ? error.message : error)
      })
    }
  })
  const token = () => scope?.get().token || config.token || ''
  const configuredRoute = () => {
    const r = scope?.get().route ?? config.route
    return r !== undefined && r.provider !== '' && r.model !== '' ? r : undefined
  }
  const configuredEffort = () => {
    const e = scope?.get().reasoningEffort ?? config.reasoningEffort
    return typeof e === 'string' && e !== '' ? e : undefined
  }

  const deps = {
    llm: ctx.llm,
    tools: ctx.tools,
    agentDefaultModel,
    token,
    configuredRoute,
    configuredEffort,
    settingsScope: () => scope,
  }

  registerConsultTool(ctx, deps)
  // HTTP 端点用运行时注入等 webServer 就绪（apply 时服务尚未注册会静默跳过；
  // headless 无 webServer 属正常，注入不触发即可）。房内范式：ctx.inject([...], cb)
  if (config.httpEnabled !== false) {
    ctx.inject(['webServer'], (wsCtx) => {
      registerHttpEndpoint(wsCtx, deps)
      registerConfigEndpoint(wsCtx, deps)
    })
  }
  registerModelOverride(ctx)
}
