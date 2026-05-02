import os
import threading
import uuid
from dataclasses import dataclass
import json
import random
import string

import chess
from flask import Flask, jsonify, request
from flask_cors import CORS

# WebSocket (flask-sock) is removed because Vercel doesn't support persistent connections.
# The FRONTEND_DIR is set to look for your 'public' folder.
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))

@dataclass
class Game:
    board: chess.Board
    last_move_uci: str | None = None

_games_lock = threading.Lock()
_games: dict[str, Game] = {}

def _turn_char(board: chess.Board) -> str:
    return "w" if board.turn == chess.WHITE else "b"

def _status_string(board: chess.Board) -> str:
    outcome = board.outcome(claim_draw=True)
    if outcome is not None:
        return "draw" if outcome.winner is None else "checkmate"
    return "check" if board.is_check() else "playing"

def _board_summary(game: Game) -> dict:
    board = game.board
    outcome = board.outcome(claim_draw=True)
    return {
        "fen": board.fen(),
        "turn": _turn_char(board),
        "status": _status_string(board),
        "lastMoveUci": game.last_move_uci,
        "legalUciMoves": [m.uci() for m in board.legal_moves],
    }

def _choose_ai_move(board: chess.Board) -> chess.Move | None:
    moves = list(board.legal_moves)
    if not moves: return None
    best = []
    best_score = -10**9
    for m in moves:
        score = 50 if board.is_capture(m) else 0
        board.push(m)
        if board.is_checkmate(): score += 10000
        elif board.is_check(): score += 30
        score += random.randint(0, 5)
        board.pop()
        if score > best_score:
            best_score = score
            best = [m]
        elif score == best_score:
            best.append(m)
    return random.choice(best) if best else random.choice(moves)

def _error(code: str, message: str, http_status: int = 400):
    return jsonify({"ok": False, "error": code, "message": message}), http_status

def create_app() -> Flask:
    app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
    CORS(app)

    @app.route("/api/game/create", methods=["POST"])
    def api_game_create():
        body = request.get_json(silent=True) or {}
        fen = body.get("fen")
        try:
            board = chess.Board(fen) if fen else chess.Board()
        except:
            return _error("invalid_fen", "Invalid FEN.")
        game_id = uuid.uuid4().hex
        with _games_lock:
            _games[game_id] = Game(board=board)
        payload = {"ok": True, "gameId": game_id}
        payload.update(_board_summary(_games[game_id]))
        return jsonify(payload)

    @app.route("/api/game/move", methods=["POST"])
    def api_game_move():
        body = request.get_json(silent=True) or {}
        game_id, uci = body.get("gameId"), body.get("uci")
        with _games_lock:
            game = _games.get(game_id)
            if not game: return _error("unknown_game", "Unknown Game ID", 404)
            try:
                move = chess.Move.from_uci(uci)
                if move in game.board.legal_moves:
                    game.board.push(move)
                    game.last_move_uci = uci
                else:
                    return _error("illegal_move", "Illegal Move")
            except:
                return _error("invalid_uci", "Invalid UCI")
            payload = {"ok": True, "gameId": game_id}
            payload.update(_board_summary(game))
            return jsonify(payload)

    @app.route("/api/game/ai_move", methods=["POST"])
    def api_game_ai_move():
        body = request.get_json(silent=True) or {}
        game_id = body.get("gameId")
        with _games_lock:
            game = _games.get(game_id)
            if not game: return _error("unknown_game", "Unknown Game ID", 404)
            move = _choose_ai_move(game.board)
            if move:
                game.board.push(move)
                game.last_move_uci = move.uci()
            payload = {"ok": True, "gameId": game_id, "aiMoveUci": game.last_move_uci}
            payload.update(_board_summary(game))
            return jsonify(payload)

    return app

# CRITICAL: This variable MUST be named 'app' and be at the top level for Vercel
app = create_app()

if __name__ == "__main__":
    app.run()
