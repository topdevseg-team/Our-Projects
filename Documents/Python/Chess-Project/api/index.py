import os
import threading
import uuid
import random
import chess
from flask import Flask, jsonify, request
from flask_cors import CORS

# Look for the 'public' folder where your HTML/CSS/JS live
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))

@dataclass
class Game:
    board: chess.Board
    last_move_uci: str | None = None

_games_lock = threading.Lock()
_games = {}

def _board_summary(game):
    board = game.board
    return {
        "fen": board.fen(),
        "turn": "w" if board.turn == chess.WHITE else "b",
        "status": "checkmate" if board.is_checkmate() else "check" if board.is_check() else "playing",
        "lastMoveUci": game.last_move_uci,
        "legalUciMoves": [m.uci() for m in board.legal_moves],
    }

def create_app():
    app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
    CORS(app)

    @app.route("/api/game/create", methods=["POST"])
    def api_game_create():
        game_id = uuid.uuid4().hex
        with _games_lock:
            _games[game_id] = Game(board=chess.Board())
        res = {"ok": True, "gameId": game_id}
        res.update(_board_summary(_games[game_id]))
        return jsonify(res)

    @app.route("/api/game/state", methods=["GET"])
    def api_game_state():
        gid = request.args.get("gameId")
        game = _games.get(gid)
        if not game: return jsonify({"ok": False}), 404
        res = {"ok": True, "gameId": gid}
        res.update(_board_summary(game))
        return jsonify(res)

    @app.route("/api/game/move", methods=["POST"])
    def api_game_move():
        data = request.json
        gid, uci = data.get("gameId"), data.get("uci")
        game = _games.get(gid)
        if not game: return jsonify({"ok": False}), 404
        try:
            move = chess.Move.from_uci(uci)
            if move in game.board.legal_moves:
                game.board.push(move)
                game.last_move_uci = uci
                res = {"ok": True}
                res.update(_board_summary(game))
                return jsonify(res)
        except: pass
        return jsonify({"ok": False, "message": "Invalid move"}), 400

    @app.route("/api/game/ai_move", methods=["POST"])
    def api_ai():
        gid = request.json.get("gameId")
        game = _games.get(gid)
        if not game or game.board.is_game_over(): return jsonify({"ok": False}), 400
        move = random.choice(list(game.board.legal_moves))
        game.board.push(move)
        game.last_move_uci = move.uci()
        res = {"ok": True, "aiMoveUci": move.uci()}
        res.update(_board_summary(game))
        return jsonify(res)

    return app

# MUST BE OUTSIDE THE IF BLOCK FOR VERCEL
app = create_app()

if __name__ == "__main__":
    app.run()
