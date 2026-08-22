window.__ModuleLoader__.load({
	id: "dsh-consult",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React;
		let jsx;
		try {
			React = require("react");
			jsx = require("react/jsx-runtime");
		} catch (e) {
			// 宿主未暴露 React（理论上不会）：面板静默不注册，服务端功能不受影响
			console.error("[dsh-consult] React 不可用，设置面板不加载：", e && e.message);
			exports.apply = () => {};
			exports.inject = [];
			return module.exports;
		}
		const { useState, useEffect } = React;

		const zh = {
			title: "顾问 / 第二意见",
			description: "dsh-consult：跨供应商第二意见。简约模式下选一个供应商和模型，或保持自动异源路由。"
		};
		const en = {
			title: "Advisor / Second Opinion",
			description: "dsh-consult: cross-provider second opinions. Pick a provider and model, or keep automatic cross-source routing."
		};

		const S = {
			section: { flexDirection: "column", display: "flex", maxWidth: 560, gap: 12 },
			heading: { margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.4 },
			lede: { margin: 0, fontSize: 13, lineHeight: 1.5, opacity: 0.7 },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			label: { fontSize: 13, minWidth: 72 },
			select: { minWidth: 180, padding: "4px 8px" },
			hint: { fontSize: 12, opacity: 0.65, lineHeight: 1.5 },
			button: { padding: "6px 16px", cursor: "pointer" },
			status: { fontSize: 12 },
			ok: { color: "#2e9e5b" },
			err: { color: "#d05050" }
		};

		async function fetchJson(url, options) {
			const r = await fetch(url, options);
			const d = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
			return d;
		}

		function AdvisorSection(props) {
			const { t } = props;
			const [cfg, setCfg] = useState(null);
			const [mode, setMode] = useState("auto");
			const [provider, setProvider] = useState("");
			const [model, setModel] = useState("");
			const [effort, setEffort] = useState("");
			const [busy, setBusy] = useState(false);
			const [saved, setSaved] = useState(false);
			const [error, setError] = useState("");

			const load = async () => {
				try {
					const c = await fetchJson("/api/dsh-consult/config");
					setCfg(c);
					setMode(c.route ? "manual" : "auto");
					setProvider(c.route ? c.route.provider : (c.providers[0] ? c.providers[0].id : ""));
					setModel(c.route ? c.route.model : "");
					setEffort(c.reasoningEffort || "");
				} catch (e) {
					setError(String(e.message || e));
				}
			};
			useEffect(() => { load(); }, []);

			const models = (cfg && cfg.providers.find((p) => p.id === provider) || { models: [] }).models;
			const fallback = cfg && cfg.fallbacks && cfg.fallbacks.deepseek ? cfg.fallbacks.deepseek.join(" → ") : "";

			const save = async () => {
				setBusy(true); setSaved(false); setError("");
				try {
					await fetchJson("/api/dsh-consult/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							route: mode === "manual" && provider && model ? { provider: provider, model: model } : null,
							reasoningEffort: effort
						})
					});
					setSaved(true);
					await load();
				} catch (e) {
					setError(String(e.message || e));
				} finally {
					setBusy(false);
				}
			};

			return jsx.jsxs("div", { style: S.section, children: [
				jsx.jsx("h2", { style: S.heading, children: t("title") }),
				jsx.jsx("p", { style: S.lede, children: t("description") }),
				jsx.jsxs("div", { style: S.row, children: [
					jsx.jsx("label", { style: S.label, children: "模式" }),
					jsx.jsx("label", { children: [
						jsx.jsx("input", { type: "radio", checked: mode === "auto",
							onChange: () => setMode("auto") }),
						" 自动（异源路由）"
					]}),
					jsx.jsx("label", { children: [
						jsx.jsx("input", { type: "radio", checked: mode === "manual",
							onChange: () => setMode("manual"), disabled: !(cfg && cfg.providers.length) }),
						" 指定供应商和模型"
					]})
				]}),
				mode === "manual" && jsx.jsxs("div", { style: S.row, children: [
					jsx.jsx("label", { style: S.label, children: "供应商" }),
					jsx.jsx("select", { style: S.select, value: provider,
						onChange: (e) => { setProvider(e.target.value); setModel(""); }, children:
						(cfg ? cfg.providers : []).map((p) =>
							jsx.jsx("option", { value: p.id, children: p.id }, p.id))
					}),
					jsx.jsx("label", { style: S.label, children: "模型" }),
					jsx.jsx("select", { style: S.select, value: model,
						onChange: (e) => setModel(e.target.value), children: [
						jsx.jsx("option", { value: "", children: "（选择模型）" }, "__placeholder"),
						models.map((m) => jsx.jsx("option", { value: m.id,
							children: m.name ? (m.name + " (" + m.id + ")") : m.id }, m.id))
					]})
				]}),
				jsx.jsxs("div", { style: S.row, children: [
					jsx.jsx("label", { style: S.label, children: "思考档位" }),
					jsx.jsxs("select", { style: S.select, value: effort,
						onChange: (e) => setEffort(e.target.value), children: [
						jsx.jsx("option", { value: "", children: "自动（provider 默认）" }, "auto"),
						jsx.jsx("option", { value: "off", children: "off（禁思考）" }, "off"),
						jsx.jsx("option", { value: "high", children: "high" }, "high"),
						jsx.jsx("option", { value: "max", children: "max" }, "max")
					]})
				]}),
				jsx.jsxs("div", { style: S.row, children: [
					jsx.jsx("button", { style: S.button, disabled: busy, onClick: save,
						children: busy ? "保存中…" : "保存" }),
					saved && jsx.jsx("span", { style: Object.assign({}, S.status, S.ok),
						children: "✅ 已保存并写入 settings.yaml" }),
					error && jsx.jsx("span", { style: Object.assign({}, S.status, S.err),
						children: "⚠ " + error })
				]}),
				jsx.jsxs("p", { style: S.hint, children: [
					"端点：POST ", cfg ? cfg.endpoint : "/v1/chat/completions",
					cfg && cfg.tokenConfigured ? "（Bearer token 已配置）" : "（⚠ token 未配置）",
					fallback ? "；兜底链（deepseek 主路由硬故障时）：XQAPI → " + fallback : "",
					"。意见仅供参考，采纳与否由主助手标注。"
				]})
			]});
		}

		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("dsh-consult", { zh: zh, en: en }), "dsh-consult: dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-consult",
				order: 115,
				label: () => ctx.locale.bind("dsh-consult")("title"),
				locale: "dsh-consult"
			}, AdvisorSection));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
