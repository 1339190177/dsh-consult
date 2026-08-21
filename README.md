# dsh-advisor（本地插件）

跨供应商第二意见服务：dsh 自身 agent 获得跨供应商咨询工具，外部 harness
（ZCode 等）获得轻量本地 OpenAI 兼容顾问 API。对应需求文档
`dsh-advisor-plugin-需求.md` 的路径 B 产品化。

## 能力（对照需求 F1–F6）

| # | 能力 | 说明 |
|---|------|------|
| F1 | `DSH_MODEL=provider/model` 直选 | 经 `agent/request` waterfall 改道主代理请求，**不受 settings.yaml `agent-default-model` 用户层压制**（旧 `--patch` 方案会被压过而静默走错模型）；改道动作写日志、实际路由写入会话 `request/header`；headless profile 的 patch 层另含 `!!js` 条目让 `--dump-config` 与选择一致 |
| F2 | OpenAI 兼容端点 | `POST http://127.0.0.1:3080/v1/chat/completions`，复用现有 web 端口（不另起端口）；Bearer token（`settings.yaml` 的 `advisor.token`，首启自动生成）；SSE 流式 + 非流式；仅回环、无 CORS；`model` 字段接受 `provider/model` |
| F3 | `consult` 工具 | 注册给所有 agent；默认自动路由到与当前模型**异源**的供应商（优先用户在 `llm-pi-ai` settings 里配置过凭证的网关，如 XQAPI），可显式传 `model="provider/model"`；绝不静默换模型——无解时显式报错并列出可用 provider |
| F4 | 结构化输出 | consult 默认要求 JSON `{recommendation, reasons, confidence, risks, alternatives}`（宽松解析，失败降级纯文本并标注）；HTTP 端点支持 `response_format: json_schema / json_object`（提示级约束 + 解析） |
| F5 | 上游溯源 | HTTP 响应头 `x-model-upstream: provider/model`；consult 返回 `backend: dsh-advisor(model@provider)`。注意：中转商自报身份不可验证的部分与需求 G3 相同，此为网关侧尽力而为 |
| F6 | 咨询审计 | `$DSH_HOME/storages/advisor/audit.jsonl`：时间 / 来源(tool\|http) / sessionId / 问题摘要 / 路由 / 耗时 / 是否结构化；`adopted` 字段留待回填 |

## 安装

- 克隆本仓库到插件目录：`git clone <本仓库地址> ~/.dsh/local-plugins/dsh-advisor`
- `~/.dsh/profiles/web/package.json` 与 `~/.dsh/profiles/headless/package.json`：
  `dependencies` 加 `link:` 依赖 + `dsh.profile.bundles` 加 `dsh-advisor`
- 两个 profile 目录各跑一次 `pnpm install`（link 包的依赖装在插件目录自身）
- headless 的 `cordis.patch.yml` 含 F1 的 `!!js` 条目

**web profile 需重启 `dsh web` 后生效**（bundle 列表在启动时读取）；
headless 每次运行都是新进程，即时生效。

## 配置

组合层（bundle patch 的 `config`）：

```yaml
- id: dsh-advisor
  name: 'dsh-advisor'
  config:
    httpEnabled: true   # false 可关掉 HTTP 端点（consult 工具不受影响）
```

用户层（`~/.dsh/settings.yaml`，优先）：

```yaml
advisor:
  token: dsha_...            # 首次启动自动生成；换 token 直接改这里
  route:                     # 可选：固定 consult 的默认顾问路由
    provider: deepseek
    model: deepseek-v4-flash
```

## 使用示例

```bash
# F1：headless 直选模型（替代旧 --patch hack，不粘住、不会被 settings 压过）
DSH_MODEL=deepseek/deepseek-v4-flash dsh --profile headless "问题"

# F1 验收：dump-config 与选择一致
DSH_MODEL=deepseek/deepseek-v4-flash dsh --profile headless --dump-config

# F2：标准 OpenAI 客户端直调（token 见 settings.yaml 的 advisor.token）
curl -X POST http://127.0.0.1:3080/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dsha_...' \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"…"}]}'
# 流式加 "stream":true；结构化加 response_format json_schema

# F3：会话内 agent 自动可用 consult 工具（无需配置）
```

## 实测记录（2026-08-21）

- 401（无/错 token）、405（GET，带 Allow: POST）、400（裸模型名，列出可用 provider）✓
- 非流式 fib(10)=55，SSE 分片 + usage + [DONE]，json_schema 结构化输出 ✓
- `DSH_MODEL` headless：日志显示 `改道 zai-coding-cn/glm-5.3 → deepseek/deepseek-v4-flash`，
  会话 `request/header` 记录 deepseek 路由 ✓
- GLM agent 会话内调 consult → 自动路由 deepseek（XQAPI 中转），结构化意见 + 审计落盘 ✓
- P50：HTTP 化后 5–9s（旧 headless CLI ~7s + 冷启动）✓

## 未做 / 边界

- F7（配额限速）、F8（并发 quorum）：未实现，留待后续
- `--model` CLI 旗标本体需改 dsh 源码（路径 A 提 issue）；本插件以 `DSH_MODEL` env
  + `agent/request` 改道达成同等效果且更稳
- consult 的 `adopted` 回填目前靠主模型在回复中标注「已采纳/未采纳」（审计字段已预留）
