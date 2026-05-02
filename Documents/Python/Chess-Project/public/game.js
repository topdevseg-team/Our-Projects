function normalizeBaseUrl(url) {
  const v = (url || "").trim();
  if (!v) return "";
  return v.replace(/\/+$/, "");
}

function getBackendBase() {
  // Defaults to empty string so /api calls work locally on the same domain
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
};

// Use chessboardjs CDN for better reliability than Wikipedia
function pieceUrl(pieceCode) {
  return `https://chessboardjs.com/img/chesspieces/wikipedia/${pieceCode}.png`;
}

function toast(msg, ms = 1400) {
  const el = document.getElementById("toast");
  if(!el) return;
  el.textContent = msg;
  el.classList.add("is-visible");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove("is-visible"), ms);
}

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
  wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
  bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟︎",
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

    this.mode = { kind: "play" };
    this.settings = this._loadSettings();
    this.playMode = "person";
    this.vsComputer = { enabled: false, humanColor: "w", aiColor: "b" };

    this._renderBoardBase();
    this._bindUI();
    this._loadElo();
    this._applySettingsToUI();
  }

  _bindUI() {
    this.btnNewGame?.addEventListener("click", () => this.newGame());
    this.btnPlayPerson?.addEventListener("click", () => this.setPlayMode("person"));
    this.btnPlayComputer?.addEventListener("click", () => this.setPlayMode("computer"));
    this.btnFlip?.addEventListener("click", () => {
      this.flip = !this.flip;
      this._renderBoardBase();
      this.render();
    });
    this.btnCopyFEN?.addEventListener("click", async () => {
      if (!this.fen) return;
      try {
        await navigator.clipboard.writeText(this.fen);
        toast("FEN copied");
      } catch {
        toast("Copy failed");
      }
    });

    this.btnStartAssessment?.addEventListener("click", () => this.startAssessment());
    this.btnExitAssessment?.addEventListener("click", () => this.exitAssessment());
    this.btnSettings?.addEventListener("click", () => this._openSettings());
    this.settingsBackdrop?.addEventListener("click", () => this._closeSettings());
    this.btnCloseSettings?.addEventListener("click", () => this._closeSettings());
    this.btnSaveSettings?.addEventListener("click", () => this._saveSettings());
  }

  _loadElo() {
    const elo = window.localStorage.getItem("glasschess_elo");
    if(this.pillEloEl) this.pillEloEl.textContent = `ELO: ${elo || "—"}`;
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
    } catch { return defaults; }
  }

  _persistSettings() {
    window.localStorage.setItem("glasschess_settings", JSON.stringify(this.settings));
    window.localStorage.setItem("glasschess_name", this.settings.name);
    window.localStorage.setItem("glasschess_backend_url", this.settings.backendUrl);
  }

  _applySettingsToUI() {
    document.body.dataset.theme = this.settings.theme;
    document.body.classList.toggle("reduced-motion", Boolean(this.settings.reducedMotion));
  }

  _openSettings() {
    if (this.themeSelect) this.themeSelect.value = this.settings.theme;
    if (this.nameInput) this.nameInput.value = this.settings.name;
    if (this.backendUrlInput) this.backendUrlInput.value = this.settings.backendUrl;
    if (this.toggleCoords) this.toggleCoords.checked = this.settings.showCoords;
    if (this.toggleReducedMotion) this.toggleReducedMotion.checked = this.settings.reducedMotion;
    this.settingsModal?.classList.add("is-open");
  }

  _closeSettings() {
    this.settingsModal?.classList.remove("is-open");
  }

  _saveSettings() {
    this.settings.theme = this.themeSelect.value;
    this.settings.name = this.nameInput.value;
    this.settings.backendUrl = normalizeBaseUrl(this.backendUrlInput.value);
    this.settings.showCoords = this.toggleCoords.checked;
    this.settings.reducedMotion = this.toggleReducedMotion.checked;
    this._persistSettings();
    this._applySettingsToUI();
    this._renderBoardBase();
    this.render();
    this._closeSettings();
    toast("Settings saved");
  }

  async newGame() {
    try {
      const res = await API.createGame();
      if (!res.ok) throw new Error();
      this.mode = { kind: "play" };
      this.moveHistory = [];
      this._applyServerState(res);
      this._setStatusLine("Game started.");
      toast("New game");
    } catch {
      toast("Failed to start game. Check Backend URL.");
    }
  }

  async setPlayMode(mode) {
    this.playMode = mode;
    this.vsComputer.enabled = mode === "computer";
    await this.newGame();
  }

  _applyServerState(res) {
    this.gameId = res.gameId;
    this.fen = res.fen;
    this.turn = res.turn;
    this.status = res.status;
    this.lastMoveUci = res.lastMoveUci;
    this.legalUciMoves = res.legalUciMoves || [];
    this.render();
  }

  _setStatusLine(text) {
    if(this.statusLineEl) this.statusLineEl.textContent = text;
  }

  render() {
    if (!this.fen) return;
    if(this.fenLineEl) this.fenLineEl.textContent = this.fen;
    if(this.pillTurnEl) this.pillTurnEl.textContent = `Turn: ${this.turn === 'w' ? 'White' : 'Black'}`;
    if(this.pillStatusEl) this.pillStatusEl.textContent = `Status: ${this.status}`;

    this._renderPieces(parseFenPieces(this.fen));
    this._applyLastMoveHighlights();
  }

  _renderBoardBase() {
    if(!this.boardEl) return;
    this.boardEl.innerHTML = "";
    this.sqEls = new Map();
    this.sqToCell = new Map();
    this.cellToSq = Array.from({ length: 8 }, () => Array(8).fill(null));

    const ranks = this.flip ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];
    const files = this.flip ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = files[col], rank = ranks[row];
        const sq = sqName(file, rank);
        const btn = document.createElement("button");
        btn.className = `sq ${(file+rank)%2===0 ? 'is-light' : 'is-dark'}`;
        btn.addEventListener("pointerdown", (e) => this._onSquarePointerDown(e, sq));
        if (this.settings.showCoords) {
           const c = document.createElement("span"); c.className="coord"; c.textContent=sq; btn.appendChild(c);
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

  _onSquarePointerDown(e, sq) {
    this._setSelectedSquare(sq);
  }

  _setSelectedSquare(sq) {
    this.sqEls.forEach(el => el.classList.remove("is-selected"));
    this.sqEls.get(sq)?.classList.add("is-selected");
    this._renderHints(sq);
  }

  _renderHints(fromSq) {
    this.sqEls.forEach(el => el.querySelector(".hint")?.remove());
    const targets = this.legalUciMoves.filter(m => m.startsWith(fromSq)).map(m => m.slice(2,4));
    targets.forEach(to => {
      const h = document.createElement("span"); h.className="hint";
      const dot = document.createElement("span"); dot.className="hint-dot";
      h.appendChild(dot);
      this.sqEls.get(to).appendChild(h);
    });
  }

  _renderPieces(pieces) {
    this.pieceLayer.innerHTML = "";
    pieces.forEach(p => {
      const sq = sqName(p.file, p.rank);
      const { col, row } = this.sqToCell.get(sq);
      const el = document.createElement("div");
      el.className = "piece";
      el.style.left = `${col * 12.5}%`;
      el.style.top = `${row * 12.5}%`;
      const img = document.createElement("img");
      img.src = pieceUrl(p.code);
      el.appendChild(img);
      el.addEventListener("pointerdown", (e) => this._onPiecePointerDown(e, el, sq));
      this.pieceLayer.appendChild(el);
    });
  }

  _onPiecePointerDown(e, el, sq) {
    if((el.dataset.code?.[0] || sqName(0,0)) && this.turn !== (parseFenPieces(this.fen).find(x => sqName(x.file, x.rank) === sq)?.code[0])) return;
    el.setPointerCapture(e.pointerId);
    this.drag = { el, fromSq: sq };
    el.classList.add("is-dragging");
    this._setSelectedSquare(sq);
  }

  async _tryMove(fromSq, toSq) {
    let uci = fromSq + toSq;
    if (this._isPromotion(fromSq, toSq)) uci += "q";
    const res = await API.move(this.gameId, uci);
    if (res.ok) {
      this._applyServerState(res);
      if (this.vsComputer.enabled) {
        setTimeout(async () => {
          const aiRes = await API.aiMove(this.gameId);
          if(aiRes.ok) this._applyServerState(aiRes);
        }, 500);
      }
    } else {
      this.render();
    }
  }

  _isPromotion(from, to) {
    const p = parseFenPieces(this.fen).find(x => sqName(x.file, x.rank) === from);
    return p && (p.code === 'wP' && to[1] === '8' || p.code === 'bP' && to[1] === '1');
  }

  _applyLastMoveHighlights() {
    this.sqEls.forEach(el => el.classList.remove("is-last"));
    if (this.lastMoveUci) {
      this.sqEls.get(this.lastMoveUci.slice(0,2))?.classList.add("is-last");
      this.sqEls.get(this.lastMoveUci.slice(2,4))?.classList.add("is-last");
    }
  }

  _xyToSquare(x, y) {
    const rect = this.boardEl.getBoundingClientRect();
    const col = Math.floor(((x - rect.left) / rect.width) * 8);
    const row = Math.floor(((y - rect.top) / rect.height) * 8);
    return this.cellToSq[clamp(row,0,7)][clamp(col,0,7)];
  }
}

const ui = new ChessUI();
window.addEventListener("pointermove", (e) => {
  if (!ui.drag) return;
  const rect = ui.boardEl.getBoundingClientRect();
  ui.drag.el.style.left = `${((e.clientX - rect.left) / rect.width) * 100 - 6}%`;
  ui.drag.el.style.top = `${((e.clientY - rect.top) / rect.height) * 100 - 6}%`;
});

window.addEventListener("pointerup", (e) => {
  if (!ui.drag) return;
  const toSq = ui._xyToSquare(e.clientX, e.clientY);
  const fromSq = ui.drag.fromSq;
  ui.drag.el.classList.remove("is-dragging");
  ui.drag = null;
  ui._tryMove(fromSq, toSq);
});
