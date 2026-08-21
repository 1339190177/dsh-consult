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
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const NAME = 'dsh-advisor'
const HTTP_PATH = '/v1/chat/completions'
const BODY_LIMIT_BYTES = 4 << 20
const LOOPBACKS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const CONSULT_MAX_TOKENS = 1200

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
 * consult 路由优先级：显式 model 参数 > settings/composition 配置的 route >
 * 自动选择与当前默认模型异源的供应商。绝不静默落到当前模型。
 */
async function resolveConsultRoute({ llm, agentDefaultModel, explicit, configured, settings: settingsService }) {
  const providers = llm.listProviders().map((p) => p.id)
  if (explicit !== undefined && explicit !== '') {
    const route = parseRoute(explicit)
    if (route === undefined) {
      throw new Error(`consult：model 参数需为 "provider/model" 形式（收到 ${JSON.stringify(explicit)}）。可用 provider：${providers.join(', ') || '（无）'}`)
    }
    if (!providers.includes(route.provider)) {
      throw new Error(`consult：provider "${route.provider}" 未注册。可用：${providers.join(', ') || '（无）'}`)
    }
    return { ...route, explicit: true }
  }
  if (configured !== undefined && configured.provider !== '' && configured.model !== '') {
    if (!providers.includes(configured.provider)) {
      throw new Error(`${NAME}：配置的 advisor route ${configured.provider}/${configured.model} 的 provider 未注册（可用：${providers.join(', ')}）。请修正 settings.yaml 的 advisor.route`)
    }
    return { provider: configured.provider, model: configured.model, explicit: false }
  }
  const current = agentDefaultModel === undefined ? undefined : agentDefaultModel.currentSelection()
  // 候选只考虑已注册（active）的路由；优先用户在 settings llm-pi-ai 里
  // 显式配置过凭证的网关供应商（如 XQAPI 中转），再考虑其他 active 路由。
  // listConfigurableProviders 返回的是 pi-ai 全量网关模板目录（大多休眠），不可用。
  const active = providers
  const userConfigured = []
  let settingsProbe = 'no-service'
  if (settingsService !== undefined) {
    try {
      const section = settingsService.get('llm-pi-ai')
      settingsProbe = section === undefined ? 'ns-undefined'
        : (section !== null && typeof section === 'object' && section.providers !== undefined) ? 'ok' : `shape:${typeof section}`
      if (settingsProbe === 'ok') {
        for (const id of Object.keys(section.providers)) {
          if (active.includes(id)) userConfigured.push(id)
        }
      }
    } catch (error) {
      settingsProbe = `throw:${error instanceof Error ? error.message : String(error)}`
    }
  }
  const seen = new Set()
  const candidates = []
  for (const id of userConfigured) {
    if (!seen.has(id)) {
      seen.add(id)
      candidates.push(id)
    }
  }
  for (const id of active) {
    if (!seen.has(id)) {
      seen.add(id)
      candidates.push(id)
    }
  }
  const altProvider = candidates.find((id) => current === undefined || id !== current.provider)
  if (altProvider === undefined) {
    throw new Error(`consult：唯一活跃 provider 就是当前模型所在供应商 ${current.provider}（自己问自己没有意义）。请在 settings.yaml 的 advisor.route 或 consult 的 model 参数显式指定 "provider/model"`)
  }
  const models = await llm.listModels(altProvider)
  const pick = models.find((m) => current === undefined || m.id !== current.model) ?? models[0]
  if (pick === undefined) {
    throw new Error(`consult：provider "${altProvider}" 没有可用模型目录，请在 settings.yaml 的 advisor.route 显式指定 provider/model`)
  }
  console.log(NAME, `：consult 自动路由 → ${altProvider}/${pick.id}（当前 ${current === undefined ? '?' : `${current.provider}/${current.model}`}；用户配置供应商：${userConfigured.join(',') || '（未读到）'}[${settingsProbe}]；候选顺序：${candidates.join(' > ')}）`)
  return { provider: altProvider, model: pick.id, explicit: false }
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
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderOpinion(value) }],
    },
    async execute(args, exec) {
      const started = Date.now()
      const route = await resolveConsultRoute({
        llm: deps.llm,
        agentDefaultModel: deps.agentDefaultModel,
        explicit: args.model,
        configured: deps.configuredRoute(),
        settings: ctx.get('settings'),
      })
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
        durationMs,
        ok: true,
        structured,
        adopted: null,
      })
      return {
        backend: `dsh-advisor(${route.model}@${route.provider})`,
        route: { provider: route.provider, model: route.model },
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
        const raw = await readBody(req, BODY_LIMIT_BYTES)
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          sendJson(400, openaiError('请求体不是合法 JSON', 'invalid_request_error', 'invalid_json'))
          return
        }
        if (typeof body.model !== 'string' || body.model === '') {
          sendJson(400, openaiError('`model` 必须为 "provider/model" 形式（如 deepseek/deepseek-v4-flash）', 'invalid_request_error', 'missing_model'))
          return
        }
        const route = parseRoute(body.model)
        if (route === undefined) {
          const providers = deps.llm.listProviders().map((p) => p.id)
          sendJson(400, openaiError(`\`model\` 需为 "provider/model"（收到 ${JSON.stringify(body.model)}）。可用 provider：${providers.join(', ') || '（无）'}`, 'invalid_request_error', 'invalid_model'))
          return
        }
        const providers = deps.llm.listProviders().map((p) => p.id)
        if (!providers.includes(route.provider)) {
          sendJson(404, openaiError(`provider "${route.provider}" 未注册。可用：${providers.join(', ') || '（无）'}`, 'invalid_request_error', 'unknown_provider'))
          return
        }
        headers['x-model-upstream'] = `${route.provider}/${route.model}`
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
        const options = {
          provider: route.provider,
          model: route.model,
          messages: mapped.messages,
          ...(system !== undefined ? { system } : {}),
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          ...(Number.isFinite(body.max_tokens) && body.max_tokens > 0 ? { maxTokens: body.max_tokens } : {}),
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
            durationMs: Date.now() - started,
            ok: true,
            structured: body.response_format?.type === 'json_schema' || body.response_format?.type === 'json_object',
            adopted: null,
          })
        }
        if (!wantsStream) {
          const result = assertStreamOk(await pullStream(deps.llm.stream(options)))
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
      } catch (error) {
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
    }), { base: { token: config.token, route: config.route } })
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

  const deps = {
    llm: ctx.llm,
    tools: ctx.tools,
    agentDefaultModel,
    token,
    configuredRoute,
  }

  registerConsultTool(ctx, deps)
  // HTTP 端点用运行时注入等 webServer 就绪（apply 时服务尚未注册会静默跳过；
  // headless 无 webServer 属正常，注入不触发即可）。房内范式：ctx.inject([...], cb)
  if (config.httpEnabled !== false) {
    ctx.inject(['webServer'], (wsCtx) => {
      registerHttpEndpoint(wsCtx, deps)
    })
  }
  registerModelOverride(ctx)
}
