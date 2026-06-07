(function () {
	// 1. CONFIG
	// Read what the business set on their page via window.SupportNestConfig

	const config = window.SupportNestConfig || {};
	const API_KEY = config.apiKey;
	const CUSTOMER_TOKEN = config.customerToken || null;
	const BASE_URL = config.baseUrl || "http://localhost:3001";
	let reconnectDelay = 1000;
	let ws;

	if (!API_KEY) {
		console.error("[SupportNest] No apiKey found in window.SupportNestConfig");
		return;
	}

	// 2. STATE
	// Everything the widget needs to track during its lifetime

	let sessionToken = null; // ← must be uncommented
	let conversationId = sessionStorage.getItem("sn_conversation_id") || null;
	let customerId = null;
	let widgetConfig = {};
	let isOpen = false;
	let isSending = false;
	let conversationStatus = "active";

	// 3. API LAYER
	// Two functions handle all HTTP communication with your Express backend

	async function post(endpoint, body, useSession = false) {
		const headers = { "Content-Type": "application/json" };

		// if (useSession) {
		//   All requests after init use the session token
		//   headers["Authorization"] = `Bearer ${sessionToken}`;
		// } else {
		//   Only /widget/init uses the raw API key
		//   headers["x-api-key"] = API_KEY;
		// }
		headers["x-api-key"] = API_KEY;

		const res = await fetch(`${BASE_URL}${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		const data = await res.json();

		if (!res.ok) {
			throw new Error(data.error || "Request failed");
		}
		return data;
	}

	async function get(endpoint) {
		const res = await fetch(`${BASE_URL}${endpoint}`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${sessionToken}`,
			},
		});

		const data = await res.json();
		if (!res.ok) {
			throw new Error(data.error || "Request failed");
		}
		return data;
	}

	// 4. API CALLS
	// One function per endpoint — clean and easy to debug individually

	async function connect() {
		const wsUrl = BASE_URL.replace(/^http/, "ws");
		ws = new WebSocket(`${wsUrl}/widget/ws`);

		ws.onopen = () => {
			reconnectDelay = 1000;
			ws.send(
				JSON.stringify({
					type: "auth",
					payload: { apiKey: API_KEY, customerJwt: CUSTOMER_TOKEN || null },
				}),
			);
		};

		ws.onmessage = (event) => {
			const envelope = JSON.parse(event.data);
			handleEvent(envelope);
		};

		ws.onclose = () => scheduleReconnect();
		ws.onerror = () => scheduleReconnect();
	}

	async function handleEvent({ type, payload }) {
		if (type === "auth_ack") {
			sessionStorage.setItem("sn_conversation_id", payload.conversationId);
			loadHistory(payload.history);
		} else if (type === "typing") {
			showTyping();
		} else if (type === "message_ai") {
			hideTyping();
			appendMessage("ai", payload.message.content);
		} else if (type === "escalated") {
			hideTyping();
		} else if (type === "error") {
			console.error("[SupportNest]", payload.message);
		}
	}
	// POST /widget/init   ==> Validates API key, identifies customer, returns sessionToken + widgetConfig
	async function initSession() {
		const data = await post("/api/v1/widget/init", {
			customerToken: CUSTOMER_TOKEN,
		});

		sessionToken = data.sessionToken;
		customerId = data.customer.id;
		widgetConfig = data.widgetConfig || {};

		return data;
	}

	// POST /conversations  ==> Creates a new conversation, returns conversationId
	async function startConversation() {
		const data = await post("/api/v1/widget/conversations", { customerId }, true);
		conversationId = data.data.conversationId;
		conversationStatus = data.data.status;
		return data;
	}

	// GET /conversations/:id/messages  ==> Loads all previous messages when widget opens for the first time
	async function loadHistory() {
		if (!conversationId) return;

		// const data = await get(
		//   `/api/v1/widget/conversations/${conversationId}/messages`,
		// );
		const data = {
			conversationId: "b11eabcc-2683-4055-b84b-552eb254aa53",
			status: "ACTIVE",
		};
		conversationStatus = data.status;

		// If already escalated show the banner
		if (conversationStatus === "escalated") {
			appendSystemMessage("You are connected with a human agent.");
		}
		return data;
	}

	function loadHIstory(messages) {
		if (!messages || messages.length === 0) return;

		messages.forEach((msg) => {
			if (msg.role === "customer") {
				appendMessage(msg.content, "customer");
			} else if (msg.role === "ai" || msg.role === "human_agent") {
				appendMessage(msg.content, "agent");
			}
		});
	}
	// POST /conversations/:id/messages
	// Sends customer message and triggers the AI pipeline
	// Returns AI response or escalation status
	async function sendMessage(content) {
		appendMessage("customer", content);
		ws.send(JSON.stringify({ type: "message_send", payload: { content } }));
		// const data = await post(
		// 	`/api/v1/widget/conversations/${conversationId}/messages`,
		// 	{ content },
		// 	false,
		// );

		// Render AI or human agent response
		// if (data.aiMessage) {
		// 	appendMessage(data.aiMessage.role, data.aiMessage.content);
		// }

		// Handle escalation — switch UI to escalated mode
		// if (data.status === "escalated") {
		// 	conversationStatus = "escalated";
		// 	appendSystemMessage("You are now connected with a human agent.");
		// 	showCsatPrompt();
		// }

		// return data;
	}

	async function scheduleReconnect() {
		setTimeout(() => connect(), reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 30000);
	}
	// POST /widget/csat   ==> Submits the star rating after conversation ends
	async function submitCsat(score, comment) {
		await post("/api/v1/widget/csat", { conversationId, score, comment }, true);
		appendSystemMessage("Thank you for your feedback!");
		hideCsatPrompt();
	}

	// 5. STYLES
	// Everything injected into the page — scoped with sn- prefix
	// so it never conflicts with the business's own CSS

	function injectStyles() {
		const style = document.createElement("style");
		style.textContent = `
      #sn-btn {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: var(--sn-accent, #6366f1);
        border: none;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483647;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      #sn-btn:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 24px rgba(0,0,0,0.25);
      }

      #sn-btn svg {
        width: 26px;
        height: 26px;
        fill: white;
        transition: opacity 0.2s;
      }

      #sn-panel {
        position: fixed;
        bottom: 92px;
        right: 24px;
        width: 360px;
        height: 540px;
        border-radius: 16px;
        background: #ffffff;
        box-shadow: 0 8px 40px rgba(0,0,0,0.15);
        display: flex;
        flex-direction: column;
        z-index: 2147483646;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        opacity: 0;
        transform: scale(0.95) translateY(8px);
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }

      #sn-panel.sn-open {
        opacity: 1;
        transform: scale(1) translateY(0);
        pointer-events: all;
      }

      /* ── Header ── */
      #sn-header {
        background: var(--sn-accent, #6366f1);
        padding: 14px 18px;
        display: flex;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
      }

      #sn-header-icon {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: rgba(255,255,255,0.2);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      #sn-header-icon svg {
        width: 18px;
        height: 18px;
        fill: white;
      }

      #sn-header-title {
        color: white;
        font-weight: 600;
        font-size: 15px;
      }

      #sn-header-subtitle {
        color: rgba(255,255,255,0.72);
        font-size: 12px;
        margin-top: 1px;
      }

      /* ── Messages ── */
      #sn-messages {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        scroll-behavior: smooth;
        background: #fafafa;
      }

      #sn-messages::-webkit-scrollbar {
        width: 4px;
      }

      #sn-messages::-webkit-scrollbar-thumb {
        background: #e5e7eb;
        border-radius: 99px;
      }

      .sn-bubble {
        max-width: 78%;
        padding: 10px 14px;
        border-radius: 16px;
        word-wrap: break-word;
        animation: snFadeUp 0.18s ease;
      }

      @keyframes snFadeUp {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      .sn-bubble.customer {
        background: var(--sn-accent, #6366f1);
        color: white;
        align-self: flex-end;
        border-bottom-right-radius: 4px;
      }

      .sn-bubble.ai,
      .sn-bubble.human_agent {
        background: #f3f4f6;
        color: #111827;
        align-self: flex-start;
        border-bottom-left-radius: 4px;
      }

      .sn-bubble.system {
        background: transparent;
        color: #9ca3af;
        font-size: 12px;
        align-self: center;
        text-align: center;
        padding: 4px 8px;
        max-width: 100%;
      }

      /* ── Typing indicator ── */
      #sn-typing {
        display: none;
        align-self: flex-start;
        background: #f3f4f6;
        border-radius: 16px;
        border-bottom-left-radius: 4px;
        padding: 12px 16px;
        gap: 4px;
        align-items: center;
      }

      #sn-typing.sn-visible {
        display: flex;
      }

      .sn-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #9ca3af;
        animation: snBounce 1.2s infinite ease-in-out;
      }

      .sn-dot:nth-child(2) { animation-delay: 0.2s; }
      .sn-dot:nth-child(3) { animation-delay: 0.4s; }

      @keyframes snBounce {
        0%, 60%, 100% { transform: translateY(0); }
        30%           { transform: translateY(-6px); }
      }

      /* ── CSAT ── */
      #sn-csat {
        display: none;
        padding: 14px 18px;
        border-top: 1px solid #f3f4f6;
        text-align: center;
        flex-shrink: 0;
        background: white;
      }

      #sn-csat.sn-visible {
        display: block;
      }

      #sn-csat-label {
        color: #374151;
        font-weight: 500;
        font-size: 13px;
        margin-bottom: 10px;
      }

      .sn-star {
        font-size: 26px;
        cursor: pointer;
        color: #d1d5db;
        display: inline-block;
        transition: color 0.15s, transform 0.15s;
        line-height: 1;
      }

      .sn-star:hover,
      .sn-star.sn-active {
        color: #f59e0b;
        transform: scale(1.2);
      }

      /* ── Input row ── */
      #sn-input-row {
        padding: 10px 12px;
        border-top: 1px solid #f3f4f6;
        display: flex;
        gap: 8px;
        align-items: flex-end;
        flex-shrink: 0;
        background: white;
      }

      #sn-input {
        flex: 1;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        padding: 9px 13px;
        font-size: 14px;
        font-family: inherit;
        line-height: 1.5;
        resize: none;
        outline: none;
        max-height: 100px;
        transition: border-color 0.15s;
        background: white;
        color: #111827;
      }

      #sn-input:focus {
        border-color: var(--sn-accent, #6366f1);
      }

      #sn-input::placeholder {
        color: #9ca3af;
      }

      #sn-send-btn {
        width: 38px;
        height: 38px;
        border-radius: 10px;
        background: var(--sn-accent, #6366f1);
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: opacity 0.15s;
      }

      #sn-send-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }

      #sn-send-btn svg {
        width: 18px;
        height: 18px;
        fill: white;
      }
    `;
		document.head.appendChild(style);
	}

	// 6. BUILD DOM
	// Creates the chat button and panel from scratch
	// Injected into whatever page the widget loads on

	function buildDOM() {
		// Set accent color CSS variable from widgetConfig
		document.documentElement.style.setProperty("--sn-accent", widgetConfig.accentColor || "#6366f1");

		// ── Chat bubble button ──
		const btn = document.createElement("button");
		btn.id = "sn-btn";
		btn.setAttribute("aria-label", "Open support chat");
		btn.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/>
      </svg>
    `;
		btn.addEventListener("click", togglePanel);
		document.body.appendChild(btn);

		// ── Chat panel ──
		const panel = document.createElement("div");
		panel.id = "sn-panel";
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "Support chat");
		panel.innerHTML = `
      <div id="sn-header">
        <div id="sn-header-icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/>
          </svg>
        </div>
        <div>
          <div id="sn-header-title">${widgetConfig.title || "Support"}</div>
          <div id="sn-header-subtitle">We typically reply instantly</div>
        </div>
      </div>

      <div id="sn-messages">
        <div id="sn-typing">
          <div class="sn-dot"></div>
          <div class="sn-dot"></div>
          <div class="sn-dot"></div>
        </div>
      </div>

      <div id="sn-csat">
        <div id="sn-csat-label">How was your experience?</div>
        <div id="sn-stars">
          <span class="sn-star" data-score="1" role="button" aria-label="1 star">★</span>
          <span class="sn-star" data-score="2" role="button" aria-label="2 stars">★</span>
          <span class="sn-star" data-score="3" role="button" aria-label="3 stars">★</span>
          <span class="sn-star" data-score="4" role="button" aria-label="4 stars">★</span>
          <span class="sn-star" data-score="5" role="button" aria-label="5 stars">★</span>
        </div>
      </div>

      <div id="sn-input-row">
        <textarea
          id="sn-input"
          rows="1"
          placeholder="${widgetConfig.placeholder || "Type a message..."}"
          aria-label="Message"
        ></textarea>
        <button id="sn-send-btn" aria-label="Send" disabled>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    `;
		document.body.appendChild(panel);

		// ── Wire up events ──
		wireEvents();
	}

	// 7. EVENTS
	// All user interaction handlers

	function wireEvents() {
		const input = document.getElementById("sn-input");
		const sendBtn = document.getElementById("sn-send-btn");

		// Enable send button only when input has text
		input.addEventListener("input", function () {
			sendBtn.disabled = !input.value.trim() || isSending;

			// Auto-grow textarea height with content
			input.style.height = "auto";
			input.style.height = Math.min(input.scrollHeight, 100) + "px";
		});

		// Enter to send, Shift+Enter for new line
		input.addEventListener("keydown", function (e) {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (!sendBtn.disabled) handleSend();
			}
		});

		// Send button click
		// sendBtn.addEventListener("click", handleSend);

		// Star rating clicks
		var stars = document.querySelectorAll(".sn-star");
		stars.forEach(function (star) {
			star.addEventListener("click", function () {
				var score = parseInt(star.getAttribute("data-score"));

				// Highlight all stars up to selected
				stars.forEach(function (s) {
					var sScore = parseInt(s.getAttribute("data-score"));
					if (sScore <= score) {
						s.classList.add("sn-active");
					} else {
						s.classList.remove("sn-active");
					}
				});

				// Submit after short delay so user sees the highlight
				setTimeout(function () {
					submitCsat(score, "");
				}, 400);
			});
		});
	}

	// 8. UI HELPERS
	// Small focused functions that update the DOM

	function appendMessage(role, content) {
		var messages = document.getElementById("sn-messages");
		var typing = document.getElementById("sn-typing");

		var bubble = document.createElement("div");
		bubble.className = "sn-bubble " + role;
		bubble.textContent = content;

		// Always insert before the typing indicator
		// so typing dots stay at the bottom
		messages.insertBefore(bubble, typing);
		messages.scrollTop = messages.scrollHeight;
	}

	function appendSystemMessage(text) {
		appendMessage("system", text);
	}

	function showTyping() {
		var typing = document.getElementById("sn-typing");
		typing.classList.add("sn-visible");
		var messages = document.getElementById("sn-messages");
		messages.scrollTop = messages.scrollHeight;
	}

	function hideTyping() {
		document.getElementById("sn-typing").classList.remove("sn-visible");
	}

	function showCsatPrompt() {
		document.getElementById("sn-csat").classList.add("sn-visible");
		document.getElementById("sn-input-row").style.display = "none";
	}

	function hideCsatPrompt() {
		document.getElementById("sn-csat").classList.remove("sn-visible");
		document.getElementById("sn-input-row").style.display = "flex";
	}

	function setInputDisabled(disabled) {
		var input = document.getElementById("sn-input");
		var sendBtn = document.getElementById("sn-send-btn");
		input.disabled = disabled;
		sendBtn.disabled = disabled;
	}

	// 9. SEND FLOW
	// The main user action — send message and show response

	async function handleSend() {
		var input = document.getElementById("sn-input");
		var sendBtn = document.getElementById("sn-send-btn");
		var content = input.value.trim();

		// Guards
		if (!content) return;
		if (isSending) return;
		if (conversationStatus !== "ACTIVE") return;

		// Clear input immediately — don't wait for server
		input.value = "";
		input.style.height = "auto";
		isSending = true;
		sendBtn.disabled = true;

		// Show customer message immediately (optimistic UI)
		appendMessage("customer", content);
		showTyping();

		try {
			await sendMessage(content);
		} catch (err) {
			appendSystemMessage("Failed to send. Please try again.");
			console.error("[SupportNest] Send error:", err.message);
		} finally {
			hideTyping();
			isSending = false;
			sendBtn.disabled = !input.value.trim();
			input.focus();
		}
	}

	// 10. TOGGLE PANEL
	// Open and close the chat panel
	// First open triggers conversation start + history load

	async function togglePanel() {
		isOpen = !isOpen;
		var panel = document.getElementById("sn-panel");
		panel.classList.toggle("sn-open", isOpen);

		if (isOpen && !conversationId) {
			// First time opening — start conversation
			setInputDisabled(true);

			try {
				await startConversation();

				await loadHistory();

				// Show greeting only if no history messages exist
				var bubbles = document.querySelectorAll(".sn-bubble");
				if (bubbles.length === 0 && widgetConfig.greetingMessage) {
					appendMessage("ai", widgetConfig.greetingMessage);
				}
			} catch (err) {
				appendSystemMessage("Could not connect. Please refresh and try again.");
				console.error("[SupportNest] Connection error:", err.message);
			} finally {
				setInputDisabled(false);
				document.getElementById("sn-input").focus();
			}
		}
	}

	// 11. BOOT
	// Entry point — runs once when script loads
	// Order matters: init first (get sessionToken + widgetConfig)
	//                then build DOM using widgetConfig values

	async function boot() {
		try {
			await initSession(); // must happen before buildDOM
			injectStyles(); // inject CSS after we have widgetConfig
			buildDOM(); // build HTML using widgetConfig values
			connect(); // connect to WebSocket
		} catch (err) {
			// Init failed — log and stop silently
			// Don't render anything broken on the customer's site
			// console.error("[SupportNest] Init failed:", err.message);
			console.error("[SupportNest] Init failed:", err);
		}
	}

	// Wait for DOM to be ready then boot
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}
})();
