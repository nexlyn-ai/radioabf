// src/scripts/abf-chat-widget.js
(() => {
  const WS_URL = "wss://chat.radioabf.com/ws";

  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function makeGuest() {
    const n = Math.floor(1000 + Math.random() * 9000);
    return `Guest ${n}`;
  }

  function mount() {
    const root = $("#abfChatWidgetRoot");
    if (!root) return;

    const btn = $("#abfChatBtn", root);
    const panel = $("#abfChatPanel", root);
    const closeBtn = $("#abfChatClose", root);

    const pseudoInput = $("#abfChatPseudo", root);
    const roomSelect = $("#abfChatRoom", root);
    const joinBtn = $("#abfChatJoin", root);

    const log = $("#abfChatLog", root);
    const msgInput = $("#abfChatMsg", root);
    const sendBtn = $("#abfChatSend", root);
    const status = $("#abfChatStatus", root);
    const err = $("#abfChatError", root);

    let ws = null;
    let joined = false;

    function setStatus(t, ok = false) {
      status.textContent = t;
      status.dataset.ok = ok ? "1" : "0";
    }

    function showErr(t = "") {
      err.textContent = t;
      err.style.display = t ? "block" : "none";
    }

    function addLine(html) {
      const div = document.createElement("div");
      div.className = "abf-chat-line";
      div.innerHTML = html;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }

    function openPanel() {
      panel.setAttribute("data-open", "1");
      btn.setAttribute("aria-expanded", "true");
    }

    function closePanel() {
      panel.removeAttribute("data-open");
      btn.setAttribute("aria-expanded", "false");
    }

    function connect() {
      showErr("");
      joined = false;

      // Close existing
      try { ws?.close(); } catch {}
      ws = new WebSocket(WS_URL);

      ws.addEventListener("open", () => {
        setStatus("Connected", true);
        addLine(`<span class="abf-chat-muted">— connected —</span>`);
      });

      ws.addEventListener("close", () => {
        setStatus("Disconnected", false);
        addLine(`<span class="abf-chat-muted">— disconnected —</span>`);
        joined = false;
      });

      ws.addEventListener("error", () => {
        showErr("WebSocket error (TLS/DNS/proxy).");
      });

      ws.addEventListener("message", (e) => {
        showErr("");
        let m;
        try { m = JSON.parse(e.data); } catch { return; }

        if (m.type === "hello") return;

        if (m.type === "joined") {
          joined = true;
          addLine(`<span class="abf-chat-muted">— joined <b>#${esc(m.room)}</b> as <b>${esc(m.pseudo)}</b> —</span>`);
          (m.history || []).forEach((h) => {
            const t = new Date(h.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            addLine(`<span class="abf-chat-time">[${esc(t)}]</span> <b>${esc(h.pseudo)}</b>: ${esc(h.message)}`);
          });
          return;
        }

        if (m.type === "presence") {
          addLine(`<span class="abf-chat-muted">— ${esc(m.pseudo)} ${esc(m.event)} —</span>`);
          return;
        }

        if (m.type === "msg") {
          const t = new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          addLine(`<span class="abf-chat-time">[${esc(t)}]</span> <b>${esc(m.pseudo)}</b>: ${esc(m.message)}`);
          return;
        }

        if (m.type === "error") {
          showErr(`Error: ${m.code}`);
        }
      });
    }

    function ensureConnected() {
      if (!ws || ws.readyState !== 1) connect();
    }

    function join() {
      ensureConnected();
      const pseudo = (pseudoInput.value || "").trim() || makeGuest();
      const room = roomSelect.value;

      // Give the socket a tick to connect if just opened
      setTimeout(() => {
        if (!ws || ws.readyState !== 1) return showErr("Not connected.");
        ws.send(JSON.stringify({ type: "join", pseudo, room }));
      }, 100);
    }

    function send() {
      showErr("");
      if (!ws || ws.readyState !== 1) return showErr("Not connected.");
      if (!joined) return showErr("Join a room first.");
      const text = (msgInput.value || "").trim();
      if (!text) return;
      ws.send(JSON.stringify({ type: "msg", message: text }));
      msgInput.value = "";
    }

    // UI events
    btn.addEventListener("click", () => {
      const isOpen = panel.getAttribute("data-open") === "1";
      if (isOpen) closePanel();
      else openPanel();
    });

    closeBtn.addEventListener("click", closePanel);

    joinBtn.addEventListener("click", join);
    sendBtn.addEventListener("click", send);
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") send();
    });

    // First connect (silent)
    setStatus("Connecting…", false);
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();