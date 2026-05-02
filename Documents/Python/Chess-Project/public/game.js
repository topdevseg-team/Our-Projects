function normalizeBaseUrl(url) {
  const v = (url || "").trim();
  if (!v) return "";
  return v.replace(/\/+$/, "");
}

function getBackendBase() {
  return normalizeBaseUrl(window.localStorage.getItem("glasschess_backend_url") || "");
}

function apiUrl(path) {
  const base = getBackendBase();
  if (!base) return path;
  return `${base}${path}`;
}

const API = {
  async createGame(fen = null) {
    const res = await fetch(apiUrl("/api/game/create"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fen ? { fen } : {}),
    });
    return await res.json();
  },
  async move(gameId, uci) {
    const res = await fetch(apiUrl("/api/game/move"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId, uci }),
    });
    return await res.json();
  },
  async state(gameId) {
    const url = new URL(apiUrl("/api/game/state"), window.location.origin);
    url.searchParams.set("gameId", gameId);
    const res = await fetch(url);
    return await res.json();
  },
  async aiMove(gameId) {
    const res = await fetch(apiUrl("/api/game/ai_move"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId }),
    });
    return await res.json();
  },
  async createRoom() {
    const res = await fetch(apiUrl("/api/room/create"), { method: "POST" });
    return await res.json();
  },
};

// Wikimedia Commons (Cburnett) chess pieces.
// We use Special:FilePath for stable URLs.
const WIKI_FILEPATH_BASE = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const PIECE_FILES = {
  wP: "Chess_plt45.svg",
  wN: "Chess_nlt45.svg",
  wB: "Chess_blt45.svg",
  wR: "Chess_rlt45.svg",
  wQ: "Chess_qlt45.svg",
  wK: "Chess_klt45.svg",
  bP: "Chess_pdt45.svg",
  bN: "Chess_ndt45.svg",
  bB: "Chess_bdt45.svg",
  bR: "Chess_rdt45.svg",
  bQ: "Chess_qdt45.svg",
  bK: "Chess_kdt45.svg",
};

function pieceUrl(pieceCode) {
  const file = PIECE_FILES[pieceCode];
  return file ? `${WIKI_FILEPATH_BASE}${encodeURIComponent(file)}` : null;
}

function toast(msg, ms = 1400) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("is-visible");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove("is-visible"), ms);
}

// Minimal FEN parser for placement only (we rely on backend for legality).
function parseFenPieces(fen) {
  const placement = fen.split(" ")[0];
  const rows = placement.split("/");
  const pieces = [];
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const isWhite = ch === ch.toUpperCase();
      const p = ch.toLowerCase();
      const type = ({ p: "P", n: "N", b: "B", r: "R", q: "Q", k: "K" })[p];
      const code = (isWhite ? "w" : "b") + type;
      pieces.push({ code, file, rank: 7 - r });
      file += 1;
    }
  }
  return pieces;
}

function sqName(file, rank) {
  return "abcdefgh"[file] + "12345678"[rank];
}

function fileRankFromSq(sq) {
  const file = "abcdefgh".indexOf(sq[0]);
  const rank = "12345678".indexOf(sq[1]);
  return { file, rank };
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

const UNICODE_PIECES = {
  wK: "♔",
  wQ: "♕",
  wR: "♖",
  wB: "♗",
  wN: "♘",
  wP: "♙",
  bK: "♚",
  bQ: "♛",
  bR: "♜",
  bB: "♝",
  bN: "♞",
  bP: "♟︎",
};

class ChessUI {
  constructor() {
    this.boardEl = document.getElementById("board");
    this.moveListEl = document.getElementById("moveList");
    this.statusLineEl = document.getElementById("statusLine");
    this.fenLineEl = document.getElementById("fenLine");
    this.pillTurnEl = document.getElementById("pillTurn");
    this.pillStatusEl = document.getElementById("pillStatus");
    this.pillEloEl = document.getElementById("pillElo");
    this.btnNewGame = document.getElementById("btnNewGame");
    this.btnPlayPerson = document.getElementById("btnPlayPerson");
    this.btnPlayComputer = document.getElementById("btnPlayComputer");
    this.btnFlip = document.getElementById("btnFlip");
    this.btnCopyFEN = document.getElementById("btnCopyFEN");
    this.btnAssessment = document.getElementById("btnAssessment");
    this.btnStartAssessment = document.getElementById("btnStartAssessment");
    this.btnExitAssessment = document.getElementById("btnExitAssessment");
    this.assessmentHintEl = document.getElementById("assessmentHint");
    this.assessmentProgressEl = document.getElementById("assessmentProgress");
    this.btnSettings = document.getElementById("btnSettings");

    // Multiplayer controls (wired in multiplayer todo)
    this.mpStatusEl = document.getElementById("mpStatus");
    this.btnCreateRoom = document.getElementById("btnCreateRoom");
    this.btnJoinRoom = document.getElementById("btnJoinRoom");
    this.roomCodeInput = document.getElementById("roomCodeInput");
    this.mpRoomLineEl = document.getElementById("mpRoomLine");

    // Settings modal
    this.settingsModal = document.getElementById("settingsModal");
    this.settingsBackdrop = document.getElementById("settingsBackdrop");
    this.btnCloseSettings = document.getElementById("btnCloseSettings");
    this.btnSaveSettings = document.getElementById("btnSaveSettings");
    this.themeSelect = document.getElementById("themeSelect");
    this.nameInput = document.getElementById("nameInput");
    this.backendUrlInput = document.getElementById("backendUrlInput");
    this.toggleCoords = document.getElementById("toggleCoords");
    this.toggleReducedMotion = document.getElementById("toggleReducedMotion");

    this.gameId = null;
    this.fen = null;
    this.turn = "w";
    this.status = "playing";
    this.lastMoveUci = null;
    this.legalUciMoves = [];
    this.flip = false;
    this.moveHistory = [];

    this.drag = null;

    this.mode = { kind: "play" }; // {kind:'play'} | {kind:'assessment', puzzleIndex, startedAt, stepIndex, attempts}
    this.settings = this._loadSettings();
    this.net = { connected: false, roomCode: null, myColor: null, ws: null };
    this.playMode = "person"; // person | computer | online
    this.vsComputer = { enabled: false, humanColor: "w", aiColor: "b" };

    this._renderBoardBase();
    this._bindUI();
    this._loadElo();
    this._applySettingsToUI();
  }

  _bindUI() {
    this.btnNewGame.addEventListener("click", () => this.newGame());
    this.btnPlayPerson.addEventListener("click", () => this.setPlayMode("person"));
    this.btnPlayComputer.addEventListener("click", () => this.setPlayMode("computer"));
    this.btnFlip.addEventListener("click", () => {
      this.flip = !this.flip;
      this._renderBoardBase();
      this.render();
    });
    this.btnCopyFEN.addEventListener("click", async () => {
      if (!this.fen) return;
      try {
        await navigator.clipboard.writeText(this.fen);
        toast("FEN copied");
      } catch {
        toast("Copy failed");
      }
    });

    this.btnAssessment.addEventListener("click", () => {
      this._scrollAssessmentIntoView();
    });
    this.btnStartAssessment.addEventListener("click", () => this.startAssessment());
    this.btnExitAssessment.addEventListener("click", () => this.exitAssessment());

    this.btnSettings.addEventListener("click", () => this._openSettings());
    this.settingsBackdrop.addEventListener("click", () => this._closeSettings());
    this.btnCloseSettings.addEventListener("click", () => this._closeSettings());
    this.btnSaveSettings.addEventListener("click", () => this._saveSettings());

    this.btnCreateRoom.addEventListener("click", () => this._mpCreateRoom());
    this.btnJoinRoom.addEventListener("click", () => this._mpJoinRoom());
  }

  _scrollAssessmentIntoView() {
    this.btnStartAssessment.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  _loadElo() {
    const elo = window.localStorage.getItem("glasschess_elo");
    this.pillEloEl.textContent = `ELO: ${elo || "—"}`;
  }

  _loadSettings() {
    const raw = window.localStorage.getItem("glasschess_settings");
    const defaults = {
      theme: "glass",
      name: window.localStorage.getItem("glasschess_name") || "Player",
      backendUrl: window.localStorage.getItem("glasschess_backend_url") || "",
      showCoords: false,
      reducedMotion: false,
    };
    try {
      return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    } catch {
      return defaults;
    }
  }

  _persistSettings() {
    window.localStorage.setItem("glasschess_settings", JSON.stringify(this.settings));
    window.localStorage.setItem("glasschess_name", this.settings.name || "Player");
    window.localStorage.setItem("glasschess_backend_url", normalizeBaseUrl(this.settings.backendUrl || ""));
  }

  _applySettingsToUI() {
    document.body.dataset.theme = this.settings.theme || "glass";
    document.body.classList.toggle("reduced-motion", Boolean(this.settings.reducedMotion));

    if (this.themeSelect) this.themeSelect.value = this.settings.theme || "glass";
    if (this.nameInput) this.nameInput.value = this.settings.name || "";
    if (this.backendUrlInput) this.backendUrlInput.value = this.settings.backendUrl || "";
    if (this.toggleCoords) this.toggleCoords.checked = Boolean(this.settings.showCoords);
    if (this.toggleReducedMotion) this.toggleReducedMotion.checked = Boolean(this.settings.reducedMotion);
  }

  _openSettings() {
    this._applySettingsToUI();
    this.settingsModal?.classList.add("is-open");
    this.settingsModal?.setAttribute("aria-hidden", "false");
  }

  _closeSettings() {
    this.settingsModal?.classList.remove("is-open");
    this.settingsModal?.setAttribute("aria-hidden", "true");
  }

  _saveSettings() {
    this.settings.theme = this.themeSelect?.value || "glass";
    this.settings.name = (this.nameInput?.value || "Player").trim().slice(0, 24);
    this.settings.backendUrl = normalizeBaseUrl(this.backendUrlInput?.value || "");
    this.settings.showCoords = Boolean(this.toggleCoords?.checked);
    this.settings.reducedMotion = Boolean(this.toggleReducedMotion?.checked);
    this._persistSettings();
    this._applySettingsToUI();
    this._renderBoardBase();
    this.render();
    this._closeSettings();
    toast("Settings saved");
  }

  async newGame() {
    if (this.net?.connected) {
      toast("Disconnect multiplayer to start a local game");
      return;
    }
    const res = await API.createGame();
    if (!res.ok) {
      toast(res.message || "Failed to create game");
      return;
    }
    this.mode = { kind: "play" };
    this.btnExitAssessment.disabled = true;
    this.moveHistory = [];
    this._applyServerState(res);
    this._setStatusLine("New game started. Drag a piece to move.");
    toast("New game");

    if (this.vsComputer?.enabled) {
      // If we ever allow playing as black, this will trigger the AI immediately.
      await this._maybePlayComputerMove();
    }
  }

  async setPlayMode(mode) {
    if (this.net?.connected) {
      toast("Disconnect multiplayer to change mode");
      return;
    }
    this.playMode = mode;
    this.vsComputer.enabled = mode === "computer";
    await this.newGame();
    if (mode === "computer") {
      this._setStatusLine("Play vs computer (you are White).");
      toast("Vs computer");
    } else {
      this._setStatusLine("Play vs person (hotseat).");
      toast("Vs person");
    }
  }

  async loadFenAsNewGame(fen) {
    if (this.net?.connected) {
      toast("Exit multiplayer to run assessment");
      return false;
    }
    const res = await API.createGame(fen);
    if (!res.ok) {
      toast(res.message || "Failed to load puzzle");
      return false;
    }
    this.moveHistory = [];
    this._applyServerState(res);
    return true;
  }

  _applyServerState(res) {
    this.gameId = res.gameId;
    this.fen = res.fen;
    this.turn = res.turn;
    this.status = res.status;
    this.lastMoveUci = res.lastMoveUci;
    this.legalUciMoves = Array.isArray(res.legalUciMoves) ? res.legalUciMoves : [];
    this.render();
  }

  _setStatusLine(text) {
    this.statusLineEl.textContent = text;
  }

  render() {
    if (!this.fen) {
      this.fenLineEl.textContent = "";
      this.pillTurnEl.textContent = "Turn: —";
      this.pillStatusEl.textContent = "Status: —";
      this._renderPieces([]);
      return;
    }

    this.fenLineEl.textContent = this.fen;
    this.pillTurnEl.textContent = `Turn: ${this.turn === "w" ? "White" : "Black"}`;
    this.pillStatusEl.textContent = `Status: ${this.status}`;

    const pieces = parseFenPieces(this.fen);
    this._renderPieces(pieces);
    this._renderMoveList();
    this._applyLastMoveHighlights();
  }

  _renderMoveList() {
    this.moveListEl.innerHTML = "";
    for (let i = 0; i < this.moveHistory.length; i += 2) {
      const li = document.createElement("li");
      li.className = "move-item";
      const no = document.createElement("span");
      no.className = "move-no";
      no.textContent = `${Math.floor(i / 2) + 1}.`;
      const moves = document.createElement("span");
      const w = this.moveHistory[i] || "…";
      const b = this.moveHistory[i + 1] || "";
      moves.textContent = `${w}${b ? "  " + b : ""}`;
      li.appendChild(no);
      li.appendChild(moves);
      this.moveListEl.appendChild(li);
    }
  }

  _renderBoardBase() {
    this.boardEl.innerHTML = "";
    this.sqEls = new Map();
    this.sqToCell = new Map(); // sq -> {col,row} in visual grid (0,0 top-left)
    this.cellToSq = Array.from({ length: 8 }, () => Array(8).fill(null)); // [row][col] -> sq

    // Squares first (64 buttons), then a piece layer on top for smooth animation positioning.
    const ranks = this.flip ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    const files = this.flip ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];

    for (let row = 0; row < 8; row++) {
      const rank = ranks[row];
      for (let col = 0; col < 8; col++) {
        const file = files[col];
        const isLight = (file + rank) % 2 === 0;
        const sq = sqName(file, rank);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `sq ${isLight ? "is-light" : "is-dark"}`;
        btn.dataset.sq = sq;
        btn.setAttribute("aria-label", sq);
        btn.addEventListener("pointerdown", (e) => this._onSquarePointerDown(e, sq));
        if (this.settings?.showCoords) {
          const coord = document.createElement("span");
          coord.className = "coord";
          coord.textContent = sq;
          btn.appendChild(coord);
        }
        this.boardEl.appendChild(btn);
        this.sqEls.set(sq, btn);
        this.sqToCell.set(sq, { col, row });
        this.cellToSq[row][col] = sq;
      }
    }

    this.pieceLayer = document.createElement("div");
    this.pieceLayer.className = "piece-layer";
    this.boardEl.appendChild(this.pieceLayer);
  }

  _squareToXYPct(sq) {
    const cell = this.sqToCell?.get(sq);
    if (!cell) {
      // fallback: treat as non-flipped a1 bottom-left
      const { file, rank } = fileRankFromSq(sq);
      return { x: file * 12.5, y: (7 - rank) * 12.5 };
    }
    return { x: cell.col * 12.5, y: cell.row * 12.5 };
  }

  _xyToSquare(clientX, clientY) {
    const rect = this.boardEl.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width - 1);
    const y = clamp(clientY - rect.top, 0, rect.height - 1);
    let col = Math.floor((x / rect.width) * 8);
    let row = Math.floor((y / rect.height) * 8);
    col = clamp(col, 0, 7);
    row = clamp(row, 0, 7);
    const sq = this.cellToSq?.[row]?.[col];
    if (sq) return sq;

    // fallback
    const file = col;
    const rank = 7 - row;
    return sqName(file, rank);
  }

  _renderPieces(pieces) {
    // Keep existing piece DOM nodes for animation.
    const next = new Map();

    for (const p of pieces) {
      const sq = sqName(p.file, p.rank);
      const id = `${p.code}@${sq}`;
      let el = this.pieceLayer.querySelector(`[data-piece-id="${CSS.escape(id)}"]`);
      if (!el) {
        el = document.createElement("div");
        el.className = "piece";
        el.dataset.pieceId = id;
        el.dataset.code = p.code;
        el.dataset.sq = sq;

        const img = document.createElement("img");
        img.alt = p.code;
        img.loading = "lazy";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        const url = pieceUrl(p.code);
        if (url) img.src = url;
        img.addEventListener("error", () => {
          img.remove();
          el.textContent = UNICODE_PIECES[p.code] || "";
          el.style.fontSize = "40px";
          el.style.color = "rgba(0,0,0,.72)";
          el.style.textShadow = "0 8px 18px rgba(0,0,0,.28)";
        });
        el.appendChild(img);

        el.addEventListener("pointerdown", (e) => this._onPiecePointerDown(e, el));
        this.pieceLayer.appendChild(el);
      } else {
        el.dataset.sq = sq;
      }

      const { x, y } = this._squareToXYPct(sq);
      if (!this.drag || this.drag.el !== el) {
        el.style.left = `${x}%`;
        el.style.top = `${y}%`;
      }

      next.set(id, el);
    }

    for (const el of Array.from(this.pieceLayer.querySelectorAll(".piece"))) {
      if (!next.has(el.dataset.pieceId)) {
        el.remove();
      }
    }
  }

  _applyLastMoveHighlights() {
    for (const btn of this.sqEls.values()) {
      btn.classList.remove("is-last", "is-check");
      btn.querySelector(".hint")?.remove();
    }
    if (this.lastMoveUci && this.lastMoveUci.length >= 4) {
      const from = this.lastMoveUci.slice(0, 2);
      const to = this.lastMoveUci.slice(2, 4);
      this.sqEls.get(from)?.classList.add("is-last");
      this.sqEls.get(to)?.classList.add("is-last");
    }
  }

  _onPiecePointerDown(e, el) {
    if (!this.gameId || !this.fen) return;
    if (this.status !== "playing" && this.status !== "check") return;
    const code = el.dataset.code;
    const pieceColor = code?.[0] === "w" ? "w" : "b";
    if (pieceColor !== this.turn) return;
    if (this.net?.connected) {
      if (this.net.myColor === "s") return;
      if (this.net.myColor && this.net.myColor !== this.turn) return;
    }

    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const fromSq = el.dataset.sq;
    const { left, top } = this._squareToXYPct(fromSq);
    this.drag = {
      el,
      pointerId: e.pointerId,
      fromSq,
      startX: e.clientX,
      startY: e.clientY,
      baseLeft: left,
      baseTop: top,
    };
    el.classList.add("is-dragging");
    this._setSelectedSquare(fromSq);
  }

  _onSquarePointerDown(_e, sq) {
    if (!this.gameId || !this.fen) return;
    this._setSelectedSquare(sq);
  }

  _setSelectedSquare(sq) {
    for (const btn of this.sqEls.values()) btn.classList.remove("is-selected");
    this.sqEls.get(sq)?.classList.add("is-selected");
    this._renderLegalHintsForFromSquare(sq);
  }

  _clearSelectedSquare() {
    for (const btn of this.sqEls.values()) btn.classList.remove("is-selected");
    this._clearHints();
  }

  _clearHints() {
    for (const btn of this.sqEls.values()) {
      btn.querySelector(".hint")?.remove();
    }
  }

  _renderLegalHintsForFromSquare(fromSq) {
    this._clearHints();
    if (!this.fen || !this.legalUciMoves?.length) return;

    const pieces = parseFenPieces(this.fen);
    const occ = new Map();
    for (const p of pieces) occ.set(sqName(p.file, p.rank), p.code);

    const fromPiece = occ.get(fromSq);
    if (!fromPiece) return;

    const fromColor = fromPiece[0]; // w|b
    const targets = this.legalUciMoves
      .filter((m) => m.startsWith(fromSq))
      .map((m) => m.slice(2, 4));

    for (const toSq of targets) {
      const btn = this.sqEls.get(toSq);
      if (!btn) continue;

      const dstPiece = occ.get(toSq);
      const isCapture = Boolean(dstPiece && dstPiece[0] !== fromColor);

      const wrap = document.createElement("span");
      wrap.className = "hint";
      const inner = document.createElement("span");
      inner.className = isCapture ? "hint-ring" : "hint-dot";
      wrap.appendChild(inner);
      btn.appendChild(wrap);
    }
  }

  async _tryMove(fromSq, toSq) {
    if (this.net?.connected) {
      // Multiplayer uses WS moves; gameId is not used.
      let uci = `${fromSq}${toSq}`;
      if (this._isPromotionMove(fromSq, toSq)) uci += "q";
      this.net.ws?.send(JSON.stringify({ type: "move", uci }));
      return;
    }
    if (!this.gameId) return;

    // Default promotion: queen (frontend can be extended with a picker).
    let uci = `${fromSq}${toSq}`;
    if (this._isPromotionMove(fromSq, toSq)) uci += "q";

    const res = await API.move(this.gameId, uci);
    if (!res.ok) {
      toast(res.message || res.error || "Move rejected");
      this.render();
      return;
    }

    this.lastMoveUci = res.lastMoveUci;
    this.fen = res.fen;
    this.turn = res.turn;
    this.status = res.status;
    this.legalUciMoves = Array.isArray(res.legalUciMoves) ? res.legalUciMoves : [];

    this.moveHistory.push(uci);
    this.render();

    if (this.mode.kind === "assessment") {
      await this._assessmentOnMoveAccepted(uci);
    }

    if (this.vsComputer?.enabled) {
      await this._maybePlayComputerMove();
    }

    if (this.status === "checkmate") this._setStatusLine("Checkmate.");
    else if (this.status === "draw") this._setStatusLine("Draw.");
    else if (this.status === "check") this._setStatusLine("Check.");
    else this._setStatusLine("Move accepted.");
  }

  async _maybePlayComputerMove() {
    if (!this.vsComputer.enabled) return;
    if (!this.gameId) return;
    if (this.status !== "playing" && this.status !== "check") return;
    if (this.turn !== this.vsComputer.aiColor) return;

    // Small delay to feel natural.
    await new Promise((r) => window.setTimeout(r, 220));
    const res = await API.aiMove(this.gameId);
    if (!res.ok) {
      return;
    }
    this.lastMoveUci = res.lastMoveUci;
    this.fen = res.fen;
    this.turn = res.turn;
    this.status = res.status;
    this.legalUciMoves = Array.isArray(res.legalUciMoves) ? res.legalUciMoves : [];
    if (res.aiMoveUci) this.moveHistory.push(res.aiMoveUci);
    this.render();
  }

  async _mpCreateRoom() {
    try {
      const data = await API.createRoom();
      if (!data.ok) throw new Error();
      this.roomCodeInput.value = data.roomCode;
      await this._mpConnectAndJoin(data.roomCode);
    } catch {
      toast("Failed to create room");
    }
  }

  async _mpJoinRoom() {
    const code = (this.roomCodeInput.value || "").trim().toUpperCase();
    if (!code) {
      toast("Enter a room code");
      return;
    }
    await this._mpConnectAndJoin(code);
  }

  async _mpConnectAndJoin(code) {
    if (this.net.ws) {
      try {
        this.net.ws.close();
      } catch {}
    }

    const base = getBackendBase();
    const proto = base.startsWith("https://") ? "wss" : "ws";
    const wsUrl = base ? `${base.replace(/^https?:\/\//, `${proto}://`)}/ws` : `${proto}://${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    this.net = { connected: false, roomCode: code, myColor: null, ws };

    this.mpStatusEl.textContent = "Connecting…";
    this.mpRoomLineEl.textContent = "";

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", roomCode: code, name: this.settings?.name || "Player" }));
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this._mpOnMessage(msg);
      } catch {}
    });

    ws.addEventListener("close", () => {
      this.net = { connected: false, roomCode: null, myColor: null, ws: null };
      this.mpStatusEl.textContent = "Disconnected.";
      this.mpRoomLineEl.textContent = "";
    });
  }

  _mpOnMessage(msg) {
    if (msg.type === "joined") {
      this.net.connected = true;
      this.net.roomCode = msg.roomCode;
      this.net.myColor = msg.color; // w|b|s
      this.mpStatusEl.textContent =
        msg.color === "s" ? "Spectating" : `Playing as ${msg.color === "w" ? "White" : "Black"}`;
      this.mpRoomLineEl.textContent = `Room: ${msg.roomCode}`;
      toast(`Joined room ${msg.roomCode}`);
      return;
    }

    if (msg.type === "state") {
      // Multiplayer state payload mirrors server board summary.
      this.gameId = null;
      this.fen = msg.fen;
      this.turn = msg.turn;
      this.status = msg.status;
      this.lastMoveUci = msg.lastMoveUci;
      this.legalUciMoves = Array.isArray(msg.legalUciMoves) ? msg.legalUciMoves : [];
      this.render();
      return;
    }

    if (msg.type === "error") {
      toast(msg.error || "Error");
    }
  }

  _isPromotionMove(fromSq, toSq) {
    // If a pawn reaches back rank, append q. We infer from FEN placement.
    const pieces = parseFenPieces(this.fen || "");
    const found = pieces.find((p) => sqName(p.file, p.rank) === fromSq);
    if (!found) return false;
    if (found.code !== "wP" && found.code !== "bP") return false;
    return (found.code === "wP" && toSq[1] === "8") || (found.code === "bP" && toSq[1] === "1");
  }

  startAssessment() {
    this._startAssessmentInternal().catch(() => toast("Failed to start assessment"));
  }

  async _startAssessmentInternal() {
    this.btnExitAssessment.disabled = false;
    this.mode = {
      kind: "assessment",
      puzzleIndex: 0,
      stepIndex: 0,
      startedAt: performance.now(),
      attempts: 0,
      score: 0,
    };
    const ok = await this._loadCurrentPuzzle();
    if (!ok) return;
    this._updateAssessmentUI();
    toast("Assessment started");
  }

  exitAssessment() {
    if (this.mode.kind !== "assessment") return;
    this.mode = { kind: "play" };
    this.btnExitAssessment.disabled = true;
    this.assessmentProgressEl.textContent = "";
    this.assessmentHintEl.textContent =
      "Run the 3-puzzle assessment to calibrate an estimated ELO stored locally.";
    toast("Assessment exited");
  }

  async _loadCurrentPuzzle() {
    const p = PUZZLES[this.mode.puzzleIndex];
    if (!p) return false;
    const ok = await this.loadFenAsNewGame(p.fen);
    if (!ok) return false;
    if (this.turn !== p.sideToMove) {
      toast("Puzzle load mismatch; reloading.");
      const ok2 = await this.loadFenAsNewGame(p.fen);
      if (!ok2) return false;
    }
    this._setStatusLine(`Assessment: ${p.title} (${p.sideToMove === "w" ? "White" : "Black"} to move)`);
    this.assessmentHintEl.textContent = p.hint || "Find the best move sequence.";
    return true;
  }

  _updateAssessmentUI() {
    if (this.mode.kind !== "assessment") return;
    const p = PUZZLES[this.mode.puzzleIndex];
    this.assessmentProgressEl.textContent = `Puzzle ${this.mode.puzzleIndex + 1}/${
      PUZZLES.length
    } • Step ${this.mode.stepIndex + 1}/${p.solutionUci.length} • Attempts ${this.mode.attempts}`;
  }

  async _assessmentOnMoveAccepted(uci) {
    if (this.mode.kind !== "assessment") return;
    const p = PUZZLES[this.mode.puzzleIndex];
    const expected = p.solutionUci[this.mode.stepIndex];
    this.mode.attempts += 1;

    if (uci !== expected) {
      toast("Not the best move (assessment)");
      this.mode.score -= 1;
      this._updateAssessmentUI();
      // Reload the puzzle position so the user can try again.
      await this._loadCurrentPuzzle();
      return;
    }

    toast("Correct");
    this.mode.score += 4;
    this.mode.stepIndex += 1;

    if (this.mode.stepIndex >= p.solutionUci.length) {
      // Puzzle done
      this.mode.puzzleIndex += 1;
      this.mode.stepIndex = 0;
      if (this.mode.puzzleIndex >= PUZZLES.length) {
        this._finishAssessment();
        return;
      }
      await this._loadCurrentPuzzle();
    }

    this._updateAssessmentUI();
  }

  _finishAssessment() {
    if (this.mode.kind !== "assessment") return;
    const elapsedSec = (performance.now() - this.mode.startedAt) / 1000;
    const raw = this.mode.score;
    const timeBonus = Math.max(0, 18 - elapsedSec); // quick completion bonus
    const total = raw + timeBonus * 0.25;
    const estimated = estimateElo(total);
    window.localStorage.setItem("glasschess_elo", String(estimated));
    this._loadElo();
    this.assessmentHintEl.textContent = `Assessment complete. Estimated ELO: ${estimated}`;
    this.assessmentProgressEl.textContent = `Score ${total.toFixed(1)} • Time ${elapsedSec.toFixed(
      1
    )}s`;
    toast(`Estimated ELO: ${estimated}`, 2200);
    this.mode = { kind: "play" };
    this.btnExitAssessment.disabled = true;
  }
}

// 3-puzzle module (hardcoded to avoid API costs)
const PUZZLES = [
  {
    id: "p1",
    title: "Mate in 1",
    sideToMove: "w",
    // White to move: Qh7#
    fen: "6k1/6pp/8/8/8/7Q/6PP/6K1 w - - 0 1",
    solutionUci: ["h3h7"],
    hint: "Look for a direct mate.",
  },
  {
    id: "p2",
    title: "Best developing move",
    sideToMove: "w",
    // White to move: Ne4 (simple centralization)
    fen: "r1bqkbnr/pppp1ppp/2n5/4p3/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 2 3",
    solutionUci: ["c3e4"],
    hint: "Improve the knight toward the center.",
  },
  {
    id: "p3",
    title: "Strong check",
    sideToMove: "w",
    // White to move: Qd8+ (forcing check)
    fen: "6k1/5ppp/8/8/8/3Q4/5PPP/6K1 w - - 0 1",
    solutionUci: ["d3d8"],
    hint: "Give a forcing check.",
  },
];

function estimateElo(score) {
  // Very lightweight calibration curve for 3 puzzles.
  // Typical range: ~800–2000.
  const s = clamp(score, -6, 18);
  const t = (s + 6) / 24; // 0..1
  return Math.round(800 + t * 1200);
}

const ui = new ChessUI();
// Auto-start a game on load for convenience.
ui.newGame().catch(() => toast("Failed to create game"));

// Drag motion: update on pointer move while dragging.
window.addEventListener("pointermove", (e) => {
  if (!ui.drag) return;
  const el = ui.drag.el;
  const rect = ui.boardEl.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, -rect.width * 0.25, rect.width * 1.25);
  const y = clamp(e.clientY - rect.top, -rect.height * 0.25, rect.height * 1.25);
  const xp = (x / rect.width) * 100;
  const yp = (y / rect.height) * 100;
  el.style.left = `${xp}%`;
  el.style.top = `${yp}%`;
});

// Drop outside squares: snap back.
window.addEventListener("pointerup", (e) => {
  if (!ui.drag) return;
  const toSq = ui._xyToSquare(e.clientX, e.clientY);
  const fromSq = ui.drag.fromSq;
  ui.drag.el.classList.remove("is-dragging");
  ui.drag = null;
  ui._clearSelectedSquare();
  ui._tryMove(fromSq, toSq).catch(() => {});
});
