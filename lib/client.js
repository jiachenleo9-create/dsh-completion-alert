/**
 * dsh-completion-alert · browser half.
 *
 * Two jobs, both tiny:
 *  1. Tell the host whether the Harness window is actually in front. The host
 *     cannot know this (it is a separate process), so the alert is gated on
 *     this report: focused window ⇒ stay silent.
 *  2. Watch for a click on the bottom-right card. The card writes a claim that
 *     the host hands over here, and this half then raises the window and
 *     selects the finished task.
 *
 * Plain browser JavaScript in the client-module lazy-CJS format; no build step.
 */
window.__ModuleLoader__.load({
	id: 'dsh-completion-alert',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/** Route prefix served by the host half. */
		const PREFIX = "/completion-alert";
		/** Heartbeat while the page stays open, so the host never guesses stale focus. */
		const HEARTBEAT_MS = 20000;
		/** Claim poll cadence: fast while visible, gentle while hidden. */
		const POLL_VISIBLE_MS = 2500;
		const POLL_HIDDEN_MS = 10000;

		/** Required services: none. Both lookups below are optional. */
		const inject = [];

		/**
		 * @param ctx - Client root context (guarded facade).
		 */
		function apply(ctx) {
			let disposed = false;
			let heartbeat;
			let poll;

			const visible = () => document.visibilityState === "visible";
			const focused = () => visible() && document.hasFocus() === true;

			/** The session the user is looking at, when the Session controller is loaded. */
			const mainSession = () => {
				try {
					const rows = ctx.get("sessions")?.list?.getSnapshot?.()?.byId ?? {};
					const row = Object.values(rows).find((candidate) => (candidate?.retainedBy?.mainView ?? 0) > 0);
					if (row === undefined || row === null) return undefined;
					return { id: row.id, title: typeof row.title === "string" ? row.title : undefined };
				} catch {
					return undefined;
				}
			};

			/** Publish one focus sample; `beacon` survives an unloading page. */
			const report = (beacon) => {
				if (disposed) return;
				const session = mainSession();
				const body = JSON.stringify({
					focused: focused(),
					visible: visible(),
					mode: location.protocol === "dsh-app:" ? "desktop" : "browser",
					url: location.href,
					documentTitle: document.title,
					session: session ?? null
				});
				try {
					const request = fetch(`${PREFIX}/focus`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
						credentials: "same-origin",
						keepalive: beacon === true
					});
					if (request !== undefined && typeof request.catch === "function") request.catch(() => {});
				} catch {
					/* the host may be restarting; the next heartbeat retries */
				}
			};

			/** Bring the Harness window forward and select the finished task. */
			const activate = (sessionId) => {
				try {
					window.focus();
				} catch {
					/* browser focus policy may refuse; the card also runs dsh://open */
				}
				if (typeof sessionId !== "string" || sessionId === "") return;
				try {
					const workspace = ctx.get("uiWorkspace");
					if (workspace !== undefined && typeof workspace.openSession === "function") workspace.openSession(sessionId);
				} catch (error) {
					console.warn("[completion-alert] could not open the finished session", error);
				}
			};

			/** Ask the host whether a card was clicked since the last poll. */
			const claim = () => {
				if (disposed || !visible()) return;
				fetch(`${PREFIX}/state`, { credentials: "same-origin", cache: "no-store" })
					.then((response) => (response.ok ? response.json() : undefined))
					.then((state) => {
						if (disposed || state === undefined || state === null) return;
						if (state.pending !== null && state.pending !== undefined) activate(state.pending.sessionId);
					})
					.catch(() => {});
			};

			const schedule = () => {
				if (poll !== undefined) clearInterval(poll);
				poll = setInterval(claim, visible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
			};

			const onStateChange = () => {
				report(false);
				schedule();
				if (visible()) claim();
			};

			window.addEventListener("focus", onStateChange);
			window.addEventListener("blur", onStateChange);
			window.addEventListener("pageshow", onStateChange);
			document.addEventListener("visibilitychange", onStateChange);
			window.addEventListener("pagehide", () => report(true));

			ctx.effect(() => () => {
				disposed = true;
				if (heartbeat !== undefined) clearInterval(heartbeat);
				if (poll !== undefined) clearInterval(poll);
				window.removeEventListener("focus", onStateChange);
				window.removeEventListener("blur", onStateChange);
				window.removeEventListener("pageshow", onStateChange);
				document.removeEventListener("visibilitychange", onStateChange);
			}, "completion-alert: focus reporting");

			report(false);
			heartbeat = setInterval(() => report(false), HEARTBEAT_MS);
			schedule();
			claim();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
