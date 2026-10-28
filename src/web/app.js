/* pi-output-translate reader page — zero-dependency, dark, streaming. */
"use strict";

import { renderMd, highlight, esc } from "./md.js";
import DOMPurify from "./vendor/purify.es.mjs";

/** renderMd with browser-side sanitization (translations are model output). */
const md = (t) => renderMd(t, { sanitize: DOMPurify.sanitize });

(() => {
	// ------------------------------------------------------------------
	// token & API
	// NOTE: document.currentScript is null inside ES modules — the token
	// comes from import.meta.url's query ("./app.js?token=…"), with the
	// session cookie covering subsequent bare-URL visits.
	const TOKEN = (() => {
		try {
			return new URL(import.meta.url).searchParams.get("token") || "";
		} catch {
			return "";
		}
	})();
	/** Frontend build stamp — must travel with PIPELINE_VER in src/types.ts.
	 * When the host reports a different pipeline version, this page reloads
	 * itself once so upgrades propagate without manual hard refreshes. */
	const PAGE_VER = "r14";
	const api = (path, opts = {}) =>
		fetch(path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN), {
			...opts,
			headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
		}).then(async (r) => {
			const text = await r.text();
			const body = text ? JSON.parse(text) : {};
			if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
			return body;
		});

	// ------------------------------------------------------------------
	// mini markdown renderer + highlighter

		// ------------------------------------------------------------------
	// state

	const sessions = new Map(); // id -> Sess
	let current = null;
	let lastSeq = 0;
	let es = null;
	let reconnectTimer = null;
	let cfg = null;
	let engineInfo = { id: "?", model: "?", ok: false };

	function Sess(info, isHistory = false) {
		return {
			info,
			isHistory,
			/** First user prompt of the session — a readable row label. */
			topic: "",
			el: null,
			msgs: new Map(), // msgKey -> {root, body, content: Map(ciKey -> el), tools: Map(tcid->el)}
			segs: new Map(), // segId -> {el, zh, en, kind, msgKey, segKey}
			unread: 0,
			nodeCount: 0,
		};
	}
	const $ = (sel) => document.querySelector(sel);
	const flow = $("#flow");

	/** Inline Lucide icon (sprite is embedded in index.html). */
	const icon = (n, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

	/** One-line topic label (≤32 chars) — mirrors journal.topicFrom. */
	function topicLabel(src) {
		const t = src
			.replace(/\s+/g, " ")
			.replace(/^(?:[#>*`\-]+\s*|\d+[.)]\s*|\[[ x]\]\s*)+/, "")
			.trim();
		return t.length > 32 ? t.slice(0, 32) + "…" : t;
	}

	// ------------------------------------------------------------------
	// DOM builders

	function ensureSessionEl(s) {
		if (s.el && s.el.isConnected) return s.el;
		const el = document.createElement("div");
		el.className = "session-flow";
		el.dataset.sid = s.info.id;
		if (!s.isHistory) el.style.display = "none";
		flow.appendChild(el);
		s.el = el;
		return el;
	}

	// Pure-prose segments (no headings/tables/code/lists/display-math) flow
	// INLINE within the message body: sentence-level segmentation stays for
	// streaming translation, but visually consecutive sentences read as one
	// paragraph instead of one-line-per-sentence. Structural segments keep
	// block layout and naturally break the run.
	function classifySeg(el) {
		if (!el || !el.classList.contains("seg")) return;
		const zh = el._zh;
		if (!zh) { el.classList.remove("prose-seg"); return; }
		const structural = zh.querySelector(
			"table,.codeblock,h1,h2,h3,h4,ul,ol,hr,blockquote,pre,.katex-display,.math-block,.math-raw",
		);
		el.classList.toggle("prose-seg", !structural);
	}

	// Focus-follow: while the user types in a pi terminal, the page follows it
	// (focus events clear the lock). Clicking a session in the sidebar locks
	// the view manually; the lock releases the moment any terminal gets input.
	let manualLock = false;

	function selectSession(id, opts = {}) {
		const s = sessions.get(id);
		if (!s) return;
		if (opts.fromFocus) manualLock = false;
		else if (opts.fromUser) manualLock = true;
		current = id;
		for (const [, other] of sessions) {
			if (other.el) other.el.style.display = "none";
		}
		ensureSessionEl(s).style.display = "block";
		s.unread = 0;
		renderSidebar();
		const name = s.topic || (s.info.cwd ? `${s.info.name}` : s.info.name);
		$("#cur-session").innerHTML = s.isHistory
			? `${icon("scroll-text")} ${esc(name)}（历史）`
			: `${esc(name)}${s.info.model ? " · " + esc(s.info.model) : ""}`;
		scrollBottom(true);
	}

	// VSCode-style collapsible folders. Fold state persists per cwd; a focus
	// follow into a folded project force-expands it (jump visibility wins
	// over the fold preference), manual folds are otherwise respected.
	const foldState = (() => {
		try { return new Map(JSON.parse(localStorage.getItem("pot-folded") ?? "[]")); }
		catch { return new Map(); }
	})();
	const saveFold = () => localStorage.setItem("pot-folded", JSON.stringify([...foldedSet()]));
	const foldedSet = () => foldState;
	function ensureVisible(sid) {
		const s = sessions.get(sid);
		if (!s) return;
		if (foldState.get(s.info.cwd || "") === true) {
			foldState.set(s.info.cwd || "", false);
			saveFold();
			renderSidebar();
		}
	}

	function folderBlock(parent, cwd, title, count, buildRows, activeIn, rerender = renderSidebar) {
		const key = cwd || "";
		const folded = foldState.get(key) === true;
		const head = document.createElement("div");
		head.className = "proj-fold" + (folded ? "" : " open");
		head.innerHTML = `<span class="caret">${icon("chevron-right")}</span><span class="fn">${icon("folder")} ${esc(title)}</span>` +
			(count > 1 || activeIn ? `<span class="fold-count">${count}</span>` : "");
		head.title = cwd || "";
		head.onclick = () => {
			foldState.set(key, foldState.get(key) !== true); // absent -> fold; true -> unfold
			saveFold();
			// Re-render the list THIS folder lives in. The hardwired
			// renderSidebar() call used to redraw only the live-session list,
			// so history folders could never visually collapse (round 10).
			rerender();
		};
		const kids = document.createElement("div");
		kids.className = "proj-kids" + (folded ? " folded" : "");
		buildRows(kids);
		parent.appendChild(head);
		parent.appendChild(kids);
	}

	/** Live-list group titles: basename, disambiguated with the parent path
	 * segment when two projects share a basename. */
	function disambiguatedNames(cwdsIterable) {
		// materialize first: a Map iterator is one-shot, and iterating it in
		// two passes used to exhaust it — every lookup then fell through to
		// "（未知）" even though grouping itself was correct
		const cwds = [...cwdsIterable];
		const baseOf = (cwd) => (cwd ? cwd.split("/").filter(Boolean).pop() || cwd : "");
		const counts = new Map();
		const bases = new Map();
		for (const cwd of cwds) {
			const b = baseOf(cwd) || "（未知）";
			bases.set(cwd, b);
			counts.set(b, (counts.get(b) ?? 0) + 1);
		}
		const names = new Map();
		for (const cwd of cwds) {
			const b = bases.get(cwd);
			if ((counts.get(b) ?? 0) > 1 && cwd) {
				const segs = cwd.split("/").filter(Boolean);
				const parent = segs.length >= 2 ? segs[segs.length - 2] : "";
				names.set(cwd, parent ? `${parent}/${b}` : b);
			} else {
				names.set(cwd, b);
			}
		}
		return names;
	}

	function renderSidebar() {
		const list = $("#session-list");
		list.innerHTML = "";
		const live = [...sessions.values()].filter((s) => !s.isHistory);
		const byCwd = new Map();
		for (const s of live) {
			const key = s.info.cwd || "";
			if (!byCwd.has(key)) byCwd.set(key, []);
			byCwd.get(key).push(s);
		}
		const names = disambiguatedNames(byCwd.keys());
		for (const [cwd, group] of byCwd) {
			const base = names.get(cwd) || "（未知）";
			const hasActive = group.some((s) => s.info.id === current);
			folderBlock(list, cwd, base || "（未知）", group.length, (kids) => {
				for (const s of group) {
					const row = document.createElement("div");
					row.className = "sess" + (current === s.info.id ? " active" : "") + (s.info._gone ? " gone" : "");
					// topic (first user prompt) distinguishes same-project sessions;
					// the project basename alone repeated on every row says nothing
					const label = s.topic || s.info.name || s.info.id;
					const text = group.length > 1 ? `${label} · ${s.info.id.slice(0, 6)}` : label;
					const dot = s.info._gone ? "#565c67" : s.info.muted ? "#f0b429" : "#3ecf8e";
					row.title = s.info._gone ? "会话已结束" : s.info.cwd || "";
					row.innerHTML = `<span class="dot2" style="background:${dot}"></span><span class="nm">${esc(
						text,
					)}</span>${s.unread ? `<span class="badge">${s.unread > 99 ? "99+" : s.unread}</span>` : ""}`;
					row.onclick = () => selectSession(s.info.id, { fromUser: true });
					kids.appendChild(row);
				}
			}, hasActive);
		}
	}

	function hideEmptyState() {
		$("#empty-state")?.classList.add("hidden");
	}
	function msgEl(s, ev) {
		const key = ev.m;
		let m = s.msgs.get(key);
		if (m) return m;
		hideEmptyState();
		// lazy creation from a segment: user segments carry r:"user" so the
		// card gets the right class (round-14: they rendered as "msg undefined")
		if (!ev.role && ev.r) ev.role = ev.r;
		const root = document.createElement("div");
		root.dataset.msgkey = key;
		root.className = `msg ${ev.role}`;
		const av = ev.role === "user" ? "你" : "AI";
		// identity lives in the avatar; the label adds info only (model name
		// for AI, nothing for user — "你 你" duplication fixed)
		const who = ev.role === "user" ? "" : ev.role === "assistant" ? (ev.model || "回复") : "";
		const ts = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
		root.innerHTML = `<div class="msg-head"><span class="avatar">${av}</span>${who ? `<span class="who">${esc(who)}</span>` : ""}<span class="ts">${ts}</span></div><div class="bubble"></div>`;
		const body = root.querySelector(".bubble");
		m = { root, body, content: new Map(), tools: new Map(), ciOrder: [] };
		s.msgs.set(key, m);
		const el = ensureSessionEl(s);
		el.appendChild(root);
		// cap DOM nodes per session: fold oldest messages beyond 250
		s.nodeCount++;
		if (s.nodeCount > 250) {
			const firstMsg = el.querySelector(".msg");
			if (firstMsg) {
				firstMsg.remove();
				s.nodeCount--;
				if (!el.querySelector(".fold-note")) {
					const note = document.createElement("div");
					note.className = "fold-note hist-note";
					note.textContent = "（更早的消息已折叠，完整记录见“历史”）";
					el.prepend(note);
				}
			}
		}
		autoScroll(s);
		return m;
	}

	function ciKey(ev) {
		return `${ev.k}:${ev.c ?? 0}`;
	}

	// Interleaved content (text, code, user, comments) shares ONE flow per
	// message and is appended strictly in arrival order — grouping them into
	// per-kind containers used to relocate every code block to the end of the
	// message. Thinking keeps its own collapsible container per content index.
	function contentEl(s, ev) {
		const m = msgEl(s, ev);
		if (ev.k === "thinking") {
			const key = ciKey(ev);
			let wrap = m.content.get(key);
			if (wrap) return wrap;
			wrap = document.createElement("div");
			wrap.className = "ci ci-thinking think-wrap";
			if (tgThink.classList.contains("on")) wrap.classList.add("open");
			const head = document.createElement("div");
			head.className = "think-head";
			const caret = document.createElement("span");
			caret.className = "caret";
			caret.innerHTML = icon("chevron-right");
			const live = document.createElement("span");
			live.className = "live-dot hidden";
			const label = document.createElement("span");
			label.textContent = "思考过程";
			head.appendChild(caret);
			head.appendChild(live);
			head.appendChild(label);
			head.onclick = () => wrap.classList.toggle("open");
			const body = document.createElement("div");
			body.className = "think-body";
			wrap.appendChild(head);
			wrap.appendChild(body);
			m.body.appendChild(wrap);
			wrap._segHost = body;
			m.content.set(key, wrap);
			return wrap;
		}
		// single ordered flow container for everything else
		let flow = m.content.get("flow");
		if (!flow) {
			flow = document.createElement("div");
			flow.className = "ci ci-flow";
			m.body.appendChild(flow);
			flow._segHost = flow; // tailEl/segEl append through _segHost
			m.content.set("flow", flow);
		}
		return flow;
	}

	// tail: raw un-segmented remainder, live during streaming
	function tailEl(s, ev) {
		const wrap = contentEl(s, ev);
		if (!wrap._tail) {
			const t = document.createElement("div");
			t.className = "tail";
			wrap._segHost.appendChild(t);
			wrap._tail = t;
			wrap._acc = "";
			wrap._cursor = 0;
		}
		return wrap;
	}

	function segEl(s, ev) {
		let seg = s.segs.get(ev.id);
		if (seg) return seg;
		const wrap = contentEl(s, ev);
		const tail = tailEl(s, ev);
		// advance cursor past this segment's source text within the accumulator
		const idx = wrap._acc.indexOf(ev.src, wrap._cursor);
		if (idx >= 0) wrap._cursor = idx + ev.src.length;

		const el = document.createElement("div");
		if (ev.k === "code") {
			el.className = "codeblock";
			const langLabel = document.createElement("div");
			langLabel.className = "code-lang";
			langLabel.textContent = ev.lang || "";
			const pre = document.createElement("pre");
			const code = document.createElement("code");
			// strip the full fence lines (3+ backticks plus the info string — a
			// ````thinking block leaves a stray backtick with the old ```\w* strip)
			const inner = ev.src.replace(/^`{3,}[^\n]*\n?/, "").replace(/\n?`{3,}[ \t]*$/, "");
			code.innerHTML = highlight(inner, ev.lang);
			pre.appendChild(code);
			el.appendChild(langLabel);
			el.appendChild(pre);
		} else {
			el.className = "seg translating";
			const zh = document.createElement("div");
			zh.className = "zh";
			zh.innerHTML = md(ev.src);
			const en = document.createElement("div");
			en.className = "en";
			en.innerHTML = md(ev.src);
			zh.title = "点击切换该段原文";
			zh.style.cursor = "pointer";
			// per-seg override via inline style: wins over both body.dual and the base rule
			zh.onclick = () => {
				en.style.display = en.style.display === "none" ? "" : "none";
			};
			el.appendChild(zh);
			el.appendChild(en);
			el._zh = zh;
			el._en = en;
		}
		classifySeg(el);
		if (ev.pb === 1) el.classList.add("para-start");
		wrap._segHost.insertBefore(el, wrap._tail);
		seg = { el, kind: ev.k, msgKey: ev.m, src: ev.src };
		s.segs.set(ev.id, seg);
		if (s.info.id === current && !s.isHistory) {
			s.unread = 0;
		} else if (!s.isHistory) {
			s.unread++;
		}
		renderSidebar();
		autoScroll(s);
		return seg;
	}

	// ------------------------------------------------------------------
	// event dispatch

	function onEvent(sev) {
		lastSeq = Math.max(lastSeq, sev.seq);
		const ev = sev.ev;
		const h = HANDLERS[ev.t];
		if (h) h(ev);
	}

	const HANDLERS = {
		hello(ev) {
			cfg = ev.cfg;
			engineInfo = ev.engine;
			if (ev.ver) {
				$("#pipe-ver").textContent = "管线 " + ev.ver;
				console.log("[pi-output-translate] pipeline", ev.ver, "— 若为旧版本请重启 pi 会话");
				// self-upgrade: host moved to a newer pipeline than this page's
				// build — reload once so stale frontends heal themselves
				if (ev.ver !== PAGE_VER && !sessionStorage.getItem("pot-reload-" + ev.ver)) {
					sessionStorage.setItem("pot-reload-" + ev.ver, "1");
				location.reload();
				return;
				}
			}
			for (const info of ev.sessions) {
				if (!sessions.has(info.id)) sessions.set(info.id, Sess(info));
				else sessions.get(info.id).info = info;
			}
			// Diff-remove ghost sessions: after a host restart/takeover the new
			// hello no longer lists dead sessions, and stale rows used to linger
			// forever with a live green dot (A1).
			const known = new Set(ev.sessions.map((i) => i.id));
			for (const [id, s] of [...sessions]) {
				if (!s.isHistory && !known.has(id)) sessions.delete(id);
			}
			renderSidebar();
			updateTopbar();
			if (!displayPrefsApplied) applyDisplayPrefs();
			const want = new URLSearchParams(location.search).get("session");
			if (!current || !sessions.has(current)) {
				selectSession(want && sessions.has(want) ? want : ev.sessions[0]?.id);
			}
			// focus recorded on the server wins over the default pick
			if (ev.focus && sessions.has(ev.focus)) selectSession(ev.focus, { fromFocus: true });
			renderSidebar();
		},
		focus(ev) {
			// a terminal just received keypresses -> follow it (releases any
			// manual lock; history views return to live). The target folder is
			// force-expanded so the jump is visible.
			if (sessions.has(ev.s)) {
				selectSession(ev.s, { fromFocus: true });
				ensureVisible(ev.s);
			}
		},
		typing(ev) {
			const s = sessions.get(ev.s);
			if (!s || !s.el) return;
			let bar = s.el.querySelector(".typing-bar");
			if (!bar) {
				bar = document.createElement("div");
				bar.className = "typing-bar";
				bar.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span>正在输入…</span>`;
				s.el.appendChild(bar);
			}
			bar.classList.remove("hidden");
			clearTimeout(bar._t);
			bar._t = setTimeout(() => bar.classList.add("hidden"), 2600);
		},
		session_up(ev) {
			if (!sessions.has(ev.s.id)) sessions.set(ev.s.id, Sess(ev.s));
			else sessions.get(ev.s.id).info = ev.s;
			renderSidebar();
		},
		session_down(ev) {
			const s = sessions.get(ev.s);
			if (s) {
				s.info._gone = true;
				renderSidebar();
			}
		},
		session_mute(ev) {
			const s = sessions.get(ev.s);
			if (s) s.info.muted = ev.muted;
			renderSidebar();
		},
		msg_start(ev) {
			const s = sessions.get(ev.s);
			if (!s) return;
			// user cards are created lazily by their first segment, so an
			// empty submission renders nothing instead of a bare avatar card
			if (ev.role !== "user") msgEl(s, ev);
		},
		delta(ev) {
			const s = sessions.get(ev.s);
			if (!s) return;
			const wrap = tailEl(s, ev);
			wrap._acc += ev.d;
			wrap._tail.textContent = wrap._acc.slice(wrap._cursor);
			if (ev.k === "thinking" && wrap.closest) {
				const th = wrap.closest(".think-wrap");
				if (th && !th.classList.contains("open")) th.classList.add("open");
				const dotEl = th?.querySelector(".live-dot");
				if (dotEl) dotEl.classList.remove("hidden");
			}
			autoScroll(s);
		},
		segment(ev) {
			const s = sessions.get(ev.s);
			if (!s) return;
			// remember the first user prompt as this session's topic label
			if (ev.k === "user" && !s.topic && ev.src && ev.src.trim()) {
				s.topic = topicLabel(ev.src);
				if (!s.isHistory && current === s.info.id) {
					$("#cur-session").textContent = `${s.topic}${s.info.model ? " · " + s.info.model : ""}`;
				}
				renderSidebar();
			}
			segEl(s, ev);
			if (ev.k === "comment" && ev.of) {
				const owner = s.segs.get(ev.of);
				if (owner) {
					let list = owner.el.querySelector(".comment-list");
					if (!list) {
						list = document.createElement("div");
						list.className = "comment-list";
						owner.el.appendChild(list);
					}
					const cm = document.createElement("div");
					cm.className = "cm seg";
					cm.dataset.segid = ev.id;
					cm.innerHTML = `<div class="zh">${md(ev.src)}</div>`;
					list.appendChild(cm);
					s.segs.set(ev.id, { el: cm, kind: "comment", msgKey: ev.m, src: ev.src });
				}
			}
		},
		trans(ev) {
			if (ev.st === "done" || ev.st === "cached") {
				waveDone++;
				const st = $("#st-done");
				if (st) {
					st.classList.remove("pop");
					void st.offsetWidth; // restart the pop animation
					st.classList.add("pop");
					$("#n-done").textContent = String(waveDone);
				}
			}
			for (const [, s] of sessions) {
				const seg = s.segs.get(ev.id);
				if (!seg) continue;
				const el = seg.el;
				if (ev.st === "done" || ev.st === "cached") {
					el.classList.remove("failed", "skipped", "translating");
					el.classList.add("translated");
					el._zh.innerHTML = md(ev.tgt || seg.src);
					classifySeg(el);
				} else if (ev.st === "failed") {
					el.classList.add("failed");
					const r = document.createElement("span");
					r.className = "retry";
					r.textContent = "重试";
					r.onclick = () => api("/api/retry", { method: "POST", body: JSON.stringify({ segId: ev.id }) }).catch(() => {});
					el._zh.appendChild(r);
				} else if (ev.st === "skipped" || ev.st === "notrans" || ev.st === "degraded") {
					el.classList.remove("translating");
					if (ev.st !== "notrans") el.classList.add(ev.st);
					if (ev.st === "degraded") el._zh.innerHTML = md(seg.src);
				}
				break;
			}
		},
		tool(ev) {
			const s = sessions.get(ev.s);
			if (!s) return;
			const m = s.msgs.get(ev.m) || msgEl(s, { m: ev.m, role: "assistant", model: "" });
			let line = m.tools.get(ev.tc);
			if (!line) {
				line = document.createElement("div");
				line.className = "toolline running";
				line.dataset.tcid = ev.tc;
				m.body.appendChild(line);
				m.tools.set(ev.tc, line);
			}
			if (ev.ph === "start") {
				line.innerHTML = `<span class="tname">${icon("wrench")} ${esc(ev.name)}</span><span class="tsum">${esc(ev.sum || "")}</span>`;
			} else {
				line.classList.remove("running");
				const status = ev.ok === false ? `<span class="bad">${icon("x")}</span>` : `<span class="ok">${icon("check")}</span>`;
				const ms = ev.ms != null ? ` <span style="color:var(--fg-faint)">${ev.ms}ms</span>` : "";
				line.innerHTML = `<span class="tname">${icon("wrench")} ${esc(ev.name)}</span><span class="tsum">${esc(ev.sum || "")}</span>${status}${ms}`;
			}
			autoScroll(s);
		},
		msg_end(ev) {
			const s = sessions.get(ev.s);
			if (!s) return;
			const m = s.msgs.get(ev.m);
			if (m) {
				for (const [, wrap] of m.content) {
					if (wrap._tail && (!wrap._acc || wrap._cursor >= wrap._acc.length)) {
						wrap._tail.classList.add("hidden");
					}
				}
				// thinking blocks: streaming finished — stop the pulse and fold
				// back unless the user keeps "思考" expanded globally.
				for (const el of m.body.querySelectorAll(".think-wrap")) {
					const dotEl = el.querySelector(".live-dot");
					if (dotEl) dotEl.classList.add("hidden");
					if (!tgThink.classList.contains("on")) el.classList.remove("open");
				}
			}
			hideEmptyState();
		},
		cfg(ev) {
			cfg = ev.cfg;
			// R4 (audit round 2): do NOT re-apply display prefs here — that
			// would reset checkboxes the user just toggled. Only refresh the
			// settings form (when the panel is open) from the new config.
			if (!$("#settings").classList.contains("hidden")) loadSettingsForm();
		},
		status(ev) {
			engineInfo.ok = ev.eng;
			const el = $("#queue-info");
			el.textContent = ev.q > 0 ? `${ev.q} 篇翻译中` : "";
			// backlog vs deadlock at a glance (hover): waiting / in-flight /
			// oldest wait. A stuck "进行中" with a=0 and old growing = bug;
			// a>0 with old shrinking = a healthy backlog draining.
			el.title =
				ev.q > 0
					? `等待 ${ev.p ?? "?"} · 进行 ${ev.a ?? "?"} · 最老等待 ${Math.round((ev.old ?? 0) / 1000)}s`
					: "";
			pipeRender(ev);
			updateTopbar();
		},
	};

	// ------------------------------------------------------------------
	// translation pipeline strip (user proposal): a backlog bar whose length
	// is proportional to the REMAINING untranslated count (grows as segments
	// enqueue, shrinks as they are translated), plus a stage view making the
	// accumulate→batch→translate cycle visible.
	let backlogPeak = 0; // high-water mark of the current wave (reset at 0)
	let waveDone = 0; // segments completed in the current wave
	function pipeRender(s) {
		const wrap = $("#pipe-wrap");
		if (!wrap) return;
		const q = s.q ?? 0;
		const p = s.p ?? 0;
		const a = s.a ?? 0;
		if (q === 0) backlogPeak = 0;
		else backlogPeak = Math.max(backlogPeak, q);
		const pct = backlogPeak > 0 ? Math.round((q / backlogPeak) * 100) : 0;
		const fill = $("#pipe-fill");
		fill.style.width = pct + "%";
		fill.classList.toggle("busy", a > 0);
		fill.classList.toggle("bad", s.eng === false);
		const idle = q === 0 && a === 0;
		wrap.classList.toggle("pipe-idle", idle);
		const label = $("#pipe-label");
		// the queue is host-global (shared by every CLI instance); show the
		// current session's share alongside so multi-window users know whose
		// backlog they are looking at
		const mine = s.pq && current ? (s.pq[current] ?? 0) : 0;
		label.textContent = idle
			? (waveDone > 0 ? `✓ 全部完成 · 本波共 ${waveDone} 段` : "队列空闲")
			: `剩余 ${q} 段（本会话 ${mine}）· 已完成 ${waveDone} · 最老等待 ${Math.round((s.old ?? 0) / 1000)}s`;
		const mark = $("#pipe-mark");
		mark.textContent = idle ? "" : `${pct}%`;
		mark.classList.toggle("show", !idle && pct > 12);
		// stage chips
		$("#n-acc").textContent = String(p);
		$("#st-acc").classList.toggle("on", p > 0);
		const bs = s.bs;
		$("#n-bat").textContent = bs ? String(bs) : "?";
		const batEl = $("#st-bat");
		batEl.querySelector("s").textContent = "批×" + (bs ?? "?");
		batEl.classList.toggle("on", a > 0 || p >= (bs ?? 4));
		$("#n-fly").textContent = String(a);
		$("#st-fly").classList.toggle("on", a > 0);
		$("#n-done").textContent = String(waveDone);
	}

	function updateTopbar() {
		const e = $("#engine-info");
		e.innerHTML = `${esc(engineInfo.id)}/${esc(engineInfo.model)}${engineInfo.ok ? "" : " " + icon("triangle-alert") + "离线"}`;
		e.classList.toggle("engine-bad", !engineInfo.ok);
	}

	// ------------------------------------------------------------------
	// scroll

	const tgDual = $("#tg-dual");
	const tgFollow = $("#tg-follow");
	const tgThink = $("#tg-think");
	/** Manual toggle state persists across reloads (localStorage); config
	 * display.* stays the first-visit factory default. Reconnect hellos
	 * must never reset what the user just clicked. */
	const DISPLAY_KEY = "pot-display";
	function loadDisplayPrefs() {
		try {
			return JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? "null");
		} catch {
			return null;
		}
	}
	function saveDisplayPrefs() {
		try {
			localStorage.setItem(
				DISPLAY_KEY,
				JSON.stringify({
					dual: tgDual.classList.contains("on"),
					follow: tgFollow.classList.contains("on"),
					think: tgThink.classList.contains("on"),
				}),
			);
		} catch {
			/* private mode etc. */
		}
	}
	function applyDual() { document.body.classList.toggle("dual", tgDual.classList.contains("on")); }
	tgDual.onclick = () => { tgDual.classList.toggle("on"); applyDual(); saveDisplayPrefs(); };
	tgFollow.onclick = () => { tgFollow.classList.toggle("on"); saveDisplayPrefs(); };
	tgThink.onclick = () => {
		tgThink.classList.toggle("on");
		saveDisplayPrefs();
		const open = tgThink.classList.contains("on");
		document.querySelectorAll(".think-wrap").forEach((w) => w.classList.toggle("open", open));
	};
	applyDual();

	let scrollTick = false;
	function nearBottom() {
		return flow.scrollHeight - flow.scrollTop - flow.clientHeight < 150;
	}
	function smoothBottom() {
		if (scrollTick) return;
		scrollTick = true;
		requestAnimationFrame(() => {
			scrollTick = false;
			flow.scrollTop = flow.scrollHeight;
		});
	}
	function autoScroll(s) {
		if (s && s.info.id !== current) return;
		if (tgFollow.classList.contains("on") && nearBottom()) {
			smoothBottom();
			$("#btn-bottom").classList.add("hidden");
		} else if (s && s.info.id === current) {
			$("#btn-bottom").classList.remove("hidden");
		}
	}
	window.__scrollBottom = () => scrollBottom(true);
	$("#btn-bottom").onclick = () => scrollBottom(true);
	flow.addEventListener("scroll", () => {
		if (nearBottom()) $("#btn-bottom").classList.add("hidden");
	});
	function scrollBottom(force) {
		if (force || tgFollow.classList.contains("on")) {
			smoothBottom();
			$("#btn-bottom").classList.add("hidden");
		}
	}

	let displayPrefsApplied = false;
	function applyDisplayPrefs() {
		if (!cfg) return;
		// config display.* are the FIRST-visit defaults; a returning user's
		// saved toggles win. Called once per page life — reconnect hellos
		// used to re-run this and silently revert manual clicks.
		tgDual.classList.toggle("on", !!cfg.display?.defaultShowOriginal);
		tgFollow.classList.toggle("on", cfg.display?.autoScroll !== false);
		tgThink.classList.toggle("on", !cfg.display?.thinkingCollapsed);
		const saved = loadDisplayPrefs();
		if (saved) {
			if (typeof saved.dual === "boolean") tgDual.classList.toggle("on", saved.dual);
			if (typeof saved.follow === "boolean") tgFollow.classList.toggle("on", saved.follow);
			if (typeof saved.think === "boolean") tgThink.classList.toggle("on", saved.think);
		}
		applyDual();
		displayPrefsApplied = true;
	}

	// ------------------------------------------------------------------
	// SSE

	// A dead token (server regenerated it) used to leave pages silently
	// frozen on their last successful render — stale "unknown" folders and
	// uuid rows that no refresh could fix. Surface it loudly instead.
	let authWarned = false;
	function warnAuth() {
		if (authWarned) return;
		authWarned = true;
		let b = document.getElementById("auth-banner");
		if (!b) {
			b = document.createElement("div");
			b.id = "auth-banner";
			b.innerHTML = `${icon("triangle-alert")} 本页的访问令牌已失效（页面数据已停止更新）—— 请在 pi 终端执行 /pot 重新打开本页`;
			document.body.prepend(b);
		}
	}
	async function checkAuth() {
		try {
			const r = await fetch("/api/config?token=" + encodeURIComponent(TOKEN));
			if (r.status === 401) warnAuth();
			else if (r.ok) authWarned = false;
		} catch {
			/* server unreachable — the normal reconnect path handles it */
		}
	}

	function connect() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (es) es.close();
		es = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}&since=${lastSeq}`);
		const dot = $("#conn-dot");
		es.onopen = () => {
			dot.className = "dot on";
			$("#conn-text").textContent = "已连接";
		};
		es.onmessage = (e) => {
			try {
				onEvent(JSON.parse(e.data));
			} catch (err) {
				console.warn("event parse error", err);
			}
		};
		es.onerror = () => {
			dot.className = "dot off";
			$("#conn-text").textContent = "重连中";
			es.close();
			es = null;
			void checkAuth();
			reconnectTimer = setTimeout(connect, 1500);
		};
	}

	// ------------------------------------------------------------------
	// history

	let historyFingerprint = "";
	async function loadHistoryList(force = false) {
		try {
			const data = await api("/api/history");
			const groups = data.groups ?? [{ cwd: "", name: "（未知项目）", sessions: data.sessions ?? [] }];
			// Efficiency: the 30s poll rebuilds the whole list DOM — skip when
			// the group structure changed (same groups, counts, newest ids).
			// NOTE: mtime is deliberately NOT in the fingerprint: an active
			// session's journal mtime changes every second, which busted the
			// cache on every poll exactly when the page is busiest (C3).
			const fp = JSON.stringify(
				groups.map((g) => [g.cwd, g.sessions.length, g.sessions[0]?.sessionId]),
			);
			if (!force && fp === historyFingerprint) return;
			historyFingerprint = fp;
			const el = $("#history-list");
			el.innerHTML = "";
			// self-describing status line: instantly tells whether the panel sees
			// the real data (debugging stale/interfered pages)
			const dbg = document.createElement("div");
			dbg.className = "hist-note";
			dbg.textContent = `${groups.length} 个项目 · ${groups.reduce((n, g) => n + g.sessions.length, 0)} 条会话 · 页面 ${PAGE_VER}`;
			dbg.title = "若此处数字为 0 或显示失败，说明浏览器侧没拿到数据（插件拦截/网络），而非服务端问题";
			el.appendChild(dbg);
			const MAX_GROUPS = 40;
			const MAX_PER_GROUP = 20;
			let renderedGroups = 0;
			for (const g of groups) {
				if (renderedGroups >= MAX_GROUPS) break;
				renderedGroups++;
				folderBlock(el, "hist:" + (g.cwd || ""), g.name, g.sessions.length, (kids) => {
					for (const h of g.sessions.slice(0, MAX_PER_GROUP)) {
						const row = document.createElement("div");
						row.className = "sess";
						const d = new Date(h.mtime);
						const date = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
						// topic (first user prompt) beats a raw uuid prefix; a session
						// that is ALSO live right now gets a badge so the duplicate
						// row is explained instead of looking like a bug (B1)
						const liveSess = sessions.get(h.sessionId);
						const isLive = !!liveSess && !liveSess.isHistory;
						const label = h.topic || h.sessionId.slice(0, 8);
						row.title = h.sessionId + (isLive ? "（会话进行中，实时视图更完整）" : "");
						row.innerHTML = `<span class="nm">${isLive ? '<span class="live-flag" title="会话进行中">●</span>' : ""}${date} · ${esc(label)}</span>`;
						row.onclick = () => openHistory(h.sessionId);
						kids.appendChild(row);
					}
					// silent truncation used to hide rows with no explanation (B5)
					if (g.sessions.length > MAX_PER_GROUP) {
						const more = document.createElement("div");
						more.className = "hist-more";
						more.textContent = `…还有 ${g.sessions.length - MAX_PER_GROUP} 条更早会话未显示`;
						kids.appendChild(more);
					}
				}, false, () => loadHistoryList(true));
			}
			if (groups.length > MAX_GROUPS) {
				const more = document.createElement("div");
				more.className = "hist-more";
				more.textContent = `…还有 ${groups.length - MAX_GROUPS} 个项目未显示`;
				el.appendChild(more);
			}
			if (renderedGroups === 0) el.innerHTML = `<div class="hist-note">（暂无历史记录）</div>`;
		} catch (err) {
			// never freeze silently: an auth failure used to leave a stale
			// "unknown projects" list on screen forever
			const msg = String((err && err.message) || err);
			if (msg.includes("unauthorized")) {
				warnAuth();
			} else {
				const el = $("#history-list");
				if (el && !el.childElementCount) el.innerHTML = `<div class="hist-note">${icon("triangle-alert")} 历史加载失败：${esc(msg)}</div>`;
			}
		}
	}

	async function openHistory(sessionId) {
		try {
			const { records } = await api(`/api/history/${encodeURIComponent(sessionId)}`);
			// topic label: first user prompt, matching the live rows (A2)
			let topic = "";
			for (const r of records) {
				if (r.k === "user" && r.src && r.src.trim()) {
					topic = topicLabel(r.src);
					break;
				}
			}
			const s = Sess({ id: `hist:${sessionId}`, name: topic || sessionId.slice(0, 12), cwd: "" }, true);
			if (sessions.has(s.info.id)) sessions.delete(s.info.id);
			sessions.set(s.info.id, s);
			const el = ensureSessionEl(s);
			el.innerHTML = "";
			s.msgs.clear();
			s.segs.clear();
			if (records.length === 0) {
				el.innerHTML = `<div class="hist-note">该会话没有已翻译的记录（历史仅收录翻译过的段落）。</div>`;
				selectSession(s.info.id);
				return;
			}
			const byMsg = new Map();
			for (const r of records) {
				if (!byMsg.has(r.m)) byMsg.set(r.m, []);
				byMsg.get(r.m).push(r);
			}
			for (const [mk, recs] of byMsg) {
				// B4: roles used to be lost (every record rendered as assistant);
				// a message holding user-kind records is the user's card.
				const isUser = recs.some((r) => r.k === "user");
				const root = document.createElement("div");
				root.className = `msg ${isUser ? "user" : "assistant"}`;
				const av = isUser ? "你" : "AI";
				const ts = new Date(recs[0].ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
				root.innerHTML = `<div class="msg-head"><span class="avatar">${av}</span><span class="who">${icon("scroll-text")} ${ts}</span></div><div class="bubble"></div>`;
				const body = root.querySelector(".bubble");
				for (const r of recs) {
					if (r.k === "thinking") {
					// thinking records keep their collapsible block, folded like live
					const wrap = document.createElement("div");
					wrap.className = "ci ci-thinking think-wrap";
					const head = document.createElement("div");
					head.className = "think-head";
					head.innerHTML = `<span class="caret">${icon("chevron-right")}</span><span>思考过程</span>`;
					head.onclick = () => wrap.classList.toggle("open");
					const tbody = document.createElement("div");
					tbody.className = "think-body";
					wrap.appendChild(head);
					wrap.appendChild(tbody);
					const seg = document.createElement("div");
					seg.className = "seg" + (r.st === "failed" ? " failed" : "");
					seg.innerHTML = `<div class="zh">${md(r.tgt || r.src)}</div>`;
					tbody.appendChild(seg);
					body.appendChild(wrap);
					continue;
				}
					const seg = document.createElement("div");
					seg.className = "seg" + (r.st === "failed" ? " failed" : "");
					const zh = document.createElement("div");
					zh.className = "zh";
					zh.innerHTML = md(r.tgt || r.src);
					seg.appendChild(zh);
					if (r.tgt && r.tgt !== r.src) {
						const en = document.createElement("div");
						en.className = "en hidden";
						en.innerHTML = md(r.src);
						seg.appendChild(en);
					}
					body.appendChild(seg);
				}
				el.appendChild(root);
			}
			selectSession(s.info.id);
		} catch (err) {
			alert("读取历史失败: " + err.message);
		}
	}

	// ------------------------------------------------------------------
	// settings panel

	function openSettings() {
		$("#settings").classList.remove("hidden");
		loadSettingsForm();
		loadCacheStats();
	}
	function closeSettings() {
		$("#settings").classList.add("hidden");
	}
	function loadSettingsForm() {
		if (!cfg) return;
		const t = cfg.translate || {};
		$("#s-engine").value = t.engine || "ollama";
		$("#s-baseurl").value = t.baseUrl || "";
		$("#s-apikey").value = t.apiKey || "";
		$("#s-model").value = t.model || "";
		$("#s-pimodel").value = t.piModelId || "";
		$("#s-lang").value = t.targetLang || "zh-Hans";
		$("#s-timeout").value = t.timeoutSeconds ?? 45;
		$("#s-batchwin").value = t.batchWindowMs ?? 300;
		$("#s-batchsize").value = t.batchSize ?? 4;
		$("#s-conc").value = t.concurrency ?? 1;
		$("#s-src-text").checked = cfg.sources?.assistantText !== false;
		$("#s-src-think").checked = cfg.sources?.thinking !== false;
		$("#s-src-user").checked = cfg.sources?.userMessage !== false;
		$("#s-src-tools").checked = cfg.sources?.toolLines !== false;
		$("#s-codecomments").value = t.codeComments || "off";
		$("#s-idle").value = cfg.idle?.noViewerBehavior || "text-only";
		$("#s-glossary").value = Object.entries(cfg.glossary || {})
			.map(([k, v]) => `${k}=${v}`)
			.join("\n");
	}

	async function saveSettings() {
		const glossary = {};
		for (const line of $("#s-glossary").value.split("\n")) {
			const i = line.indexOf("=");
			if (i > 0) glossary[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
		const config = {
			translate: {
				engine: $("#s-engine").value,
				baseUrl: $("#s-baseurl").value.trim(),
				apiKey: $("#s-apikey").value,
				model: $("#s-model").value.trim(),
				piModelId: $("#s-pimodel").value.trim(),
				targetLang: $("#s-lang").value.trim() || "zh-Hans",
				timeoutSeconds: Number($("#s-timeout").value) || 45,
				batchWindowMs: Number($("#s-batchwin").value) || 300,
				batchSize: Number($("#s-batchsize").value) || 4,
				concurrency: Number($("#s-conc").value) || 1,
				codeComments: $("#s-codecomments").value,
			},
			sources: {
				assistantText: $("#s-src-text").checked,
				thinking: $("#s-src-think").checked,
				userMessage: $("#s-src-user").checked,
				toolLines: $("#s-src-tools").checked,
			},
			idle: { noViewerBehavior: $("#s-idle").value },
			glossary,
		};
		try {
			const r = await api("/api/config", { method: "POST", body: JSON.stringify({ config }) });
			cfg = r.config;
			$("#save-result").textContent = "已保存并热应用 ✓";
			setTimeout(() => ($("#save-result").textContent = ""), 2500);
		} catch (err) {
			$("#save-result").textContent = "✗ " + err.message;
		}
	}

	async function loadCacheStats() {
		try {
			const s = await api("/api/cache/stats");
			$("#cache-stats").textContent = `${s.size} 条 · 命中率 ${(s.hitRate * 100).toFixed(0)}%`;
		} catch {
			$("#cache-stats").textContent = "—";
		}
	}

	$("#btn-settings").onclick = openSettings;
	// narrow-screen sidebar drawer
	$("#btn-sidebar-open").onclick = () => {
		$("#sidebar").classList.add("open");
		$("#scrim").classList.remove("hidden");
	};
	const closeDrawer = () => {
		$("#sidebar").classList.remove("open");
		$("#scrim").classList.add("hidden");
	};
	$("#btn-sidebar-close").onclick = closeDrawer;
	$("#scrim").onclick = closeDrawer;
	$("#btn-close-settings").onclick = closeSettings;
	$("#btn-save").onclick = saveSettings;
	$("#btn-cache-refresh").onclick = loadCacheStats;
	$("#btn-cache-clear").onclick = async () => {
		await api("/api/cache/clear", { method: "POST", body: "{}" }).catch(() => {});
		loadCacheStats();
	};
	$("#btn-models").onclick = async () => {
		try {
			const { models } = await api("/api/engine/models");
			$("#s-models").innerHTML = models.map((m) => `<option value="${esc(m)}">`).join("");
			$("#test-result").textContent = `获取到 ${models.length} 个模型`;
		} catch (err) {
			$("#test-result").textContent = "获取失败: " + err.message;
		}
	};
	$("#btn-test").onclick = async () => {
		$("#test-result").textContent = "翻译中…";
		try {
			const r = await api("/api/engine/test", {
				method: "POST",
				body: JSON.stringify({ text: "The build failed due to a race condition between the cache loader and the config watcher." }),
			});
			$("#test-result").textContent = r.ok ? "✓ " + r.output : "✗ " + r.error;
		} catch (err) {
			$("#test-result").textContent = "✗ " + err.message;
		}
	};

	// ------------------------------------------------------------------
	// boot

	connect();
	loadHistoryList();
	setInterval(loadHistoryList, 30_000);
})();
