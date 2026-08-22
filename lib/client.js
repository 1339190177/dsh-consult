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
			description: "选择顾问使用的供应商、模型与推理档位。默认官方 DeepSeek（稳定、身份可验证）；档位选项随所选模型的实际支持列表变化。"
		};
		const en = {
			title: "Advisor / Second Opinion",
			description: "Pick the provider, model, and reasoning effort for second opinions. Defaults to official DeepSeek; effort options follow the selected model."
		};

		// 档位未知时的兜底选项（deepseek 家族词表；服务端仍会逐模型校验）
		const EFFORT_FALLBACK = ["off", "high", "max"];

		const S = {
			section: { flexDirection: "column", display: "flex", maxWidth: 560, gap: 12 },
			heading: { margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.4 },
			lede: { margin: 0, fontSize: 13, lineHeight: 1.5, opacity: 0.7 },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			label: { fontSize: 13, minWidth: 72 },
			select: { minWidth: 180, padding: "4px 8px" },
			hint: { fontSize: 12, opacity: 0.65, lineHeight: 1.5 },
			button: { padding: "6px 16px", cursor: "pointer" },
			ghost: { padding: "6px 12px", cursor: "pointer", opacity: 0.8 },
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
			const [provider, setProvider] = useState("");
			const [model, setModel] = useState("");
			const [effort, setEffort] = useState("");
			const [busy, setBusy] = useState(false);
			const [saved, setSaved] = useState(false);
			const [error, setError] = useState("");

			const applyCfg = (c) => {
				// 已保存的 route 优先；未配置时落到默认路由（官方 DeepSeek）
				const r = c.route || c.defaultRoute;
				setProvider(r.provider);
				setModel(r.model);
				setEffort(c.reasoningEffort || "");
			};
			const load = async () => {
				try {
					const c = await fetchJson("/api/dsh-consult/config");
					setCfg(c);
					applyCfg(c);
				} catch (e) {
					setError(String(e.message || e));
				}
			};
			useEffect(() => { load(); }, []);

			const models = ((cfg && cfg.providers.find((p) => p.id === provider)) || { models: [] }).models;
			const modelInfo = models.find((m) => m.id === model);
			const efforts = (modelInfo && modelInfo.efforts) || EFFORT_FALLBACK;
			const isDefault = cfg && provider === cfg.defaultRoute.provider && model === cfg.defaultRoute.model;

			const save = async (payload) => {
				setBusy(true); setSaved(false); setError("");
				try {
					await fetchJson("/api/dsh-consult/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
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
					jsx.jsx("label", { style: S.label, children: "供应商" }),
					jsx.jsx("select", { style: S.select, value: provider,
						onChange: (e) => { setProvider(e.target.value); setModel(""); setEffort(""); }, children:
						(cfg ? cfg.providers : []).map((p) =>
							jsx.jsx("option", { value: p.id, children: p.id }, p.id))
					})
				]}),
				jsx.jsxs("div", { style: S.row, children: [
					jsx.jsx("label", { style: S.label, children: "模型" }),
					jsx.jsx("select", { style: S.select, value: model,
						onChange: (e) => { setModel(e.target.value); setEffort(""); }, children: [
						jsx.jsx("option", { value: "", children: "（选择模型）" }, "__placeholder"),
						models.map((m) => jsx.jsx("option", { value: m.id,
							children: m.name ? (m.name + " (" + m.id + ")") : m.id }, m.id))
					]})
				]}),
				jsx.jsxs("div", { style: S.row, children: [
					jsx.jsx("label", { style: S.label, children: "推理档位" }),
					jsx.jsxs("select", { style: S.select, value: effort,
						onChange: (e) => setEffort(e.target.value), children: [
						jsx.jsx("option", { value: "", children: "自动（provider 默认）" }, "auto"),
						efforts.map((e) => jsx.jsx("option", { value: e, children: e }, e))
					]}),
					modelInfo && modelInfo.efforts === undefined &&
						jsx.jsx("span", { style: S.hint, children: "（该模型档位未知，以上为通用候选）" })
				]}),
				jsx.jsxs("div", { style: S.row, children: [
					jsx.jsx("button", { style: S.button, disabled: busy || !provider || !model, onClick: () =>
						save({ route: { provider: provider, model: model }, reasoningEffort: effort }),
						children: busy ? "保存中…" : "保存" }),
					jsx.jsx("button", { style: S.ghost, disabled: busy, onClick: () =>
						save({ route: null, reasoningEffort: "" }),
						children: "恢复默认" }),
					saved && jsx.jsx("span", { style: Object.assign({}, S.status, S.ok),
						children: "✅ 已保存并写入 settings.yaml" }),
					error && jsx.jsx("span", { style: Object.assign({}, S.status, S.err),
						children: "⚠ " + error })
				]}),
				jsx.jsxs("p", { style: S.hint, children: [
					cfg && cfg.defaultRoute
						? "默认路由：" + cfg.defaultRoute.provider + "/" + cfg.defaultRoute.model
						: "",
					isDefault ? "（当前即默认）" : "",
					cfg && cfg.tokenConfigured ? "；Bearer token 已配置" : "；⚠ token 未配置",
					"。端点：POST ", cfg ? cfg.endpoint : "/v1/chat/completions",
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
