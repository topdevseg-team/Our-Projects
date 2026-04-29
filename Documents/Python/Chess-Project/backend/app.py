import os
import threading
import uuid
from dataclasses import dataclass
import json
import random
import string

import chess
from flask import Flask, jsonify, request
from flask_sock import Sock


FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))


@dataclass
class Game:
    board: chess.Board
    last_move_uci: str | None = None


@dataclass
class Room:
    code: str
    game: Game
    white_id: str | None = None
    black_id: str | None = None
    names: dict[str, str] | None = None
    conns: set | None = None


_games_lock = threading.Lock()
_games: dict[str, Game] = {}

_rooms_lock = threading.Lock()
_rooms: dict[str, Room] = {}


def _turn_char(board: chess.Board) -> str:
    return "w" if board.turn == chess.WHITE else "b"


def _status_string(board: chess.Board) -> str:
    outcome = board.outcome(claim_draw=True)
    if outcome is not None:
        if outcome.winner is None:
            return "draw"
        return "checkmate"
    if board.is_check():
        return "check"
    return "playing"


def _board_summary(game: Game) -> dict:
    board = game.board
    outcome = board.outcome(claim_draw=True)
    result_str = board.result(claim_draw=True)
    return {
        "fen": board.fen(),
        "turn": _turn_char(board),
        "status": _status_string(board),
        "lastMoveUci": game.last_move_uci,
        "legalUciMoves": [m.uci() for m in board.legal_moves],
        "isCheck": board.is_check(),
        "isCheckmate": board.is_checkmate(),
        "isStalemate": board.is_stalemate(),
        "outcome": (
            None
            if outcome is None
            else {
                "result": result_str,
                "winner": (
                    None
                    if outcome.winner is None
                    else ("w" if outcome.winner == chess.WHITE else "b")
                ),
                "termination": outcome.termination.name,
            }
        ),
    }

def _choose_ai_move(board: chess.Board) -> chess.Move | None:
    moves = list(board.legal_moves)
    if not moves:
        return None

    best: list[chess.Move] = []
    best_score = -10**9

    for m in moves:
        score = 0
        is_capture = board.is_capture(m)
        if is_capture:
            score += 50

        board.push(m)
        if board.is_checkmate():
            score += 10_000
        elif board.is_check():
            score += 30
        # small random jitter to avoid determinism
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
    sock = Sock(app)

    @app.after_request
    def add_cors_headers(resp):
        # Netlify-hosted frontend calls a separate backend origin.
        # For production, set ALLOWED_ORIGINS to a comma-separated list like:
        # "https://your-site.netlify.app,https://your-custom-domain.com"
        origin = request.headers.get("Origin")
        allowed = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
        if "*" in allowed:
            resp.headers["Access-Control-Allow-Origin"] = origin or "*"
        elif origin and origin in allowed:
            resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
        resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return resp

    @app.route("/api/<path:_any>", methods=["OPTIONS"])
    def api_preflight(_any):
        return ("", 204)

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.post("/api/game/create")
    def api_game_create():
        body = request.get_json(silent=True) or {}
        fen = body.get("fen")
        try:
            board = chess.Board(fen) if fen else chess.Board()
        except ValueError:
            return _error("invalid_fen", "Provided FEN is invalid.")

        game_id = uuid.uuid4().hex
        with _games_lock:
            _games[game_id] = Game(board=board, last_move_uci=None)

        payload = {"ok": True, "gameId": game_id}
        payload.update(_board_summary(_games[game_id]))
        return jsonify(payload)

    def _room_state_payload(room: Room) -> dict:
        # Server-authoritative view for multiplayer
        payload = {"ok": True, "roomCode": room.code}
        payload.update(_board_summary(room.game))
        names = room.names or {}
        payload["players"] = {
            "white": {"id": room.white_id, "name": (names.get(room.white_id) if room.white_id else None)},
            "black": {"id": room.black_id, "name": (names.get(room.black_id) if room.black_id else None)},
        }
        return payload

    def _broadcast_room(room: Room):
        payload = json.dumps({"type": "state", **_room_state_payload(room)})
        for ws in list(room.conns or []):
            try:
                ws.send(payload)
            except Exception:
                try:
                    room.conns.discard(ws)
                except Exception:
                    pass

    def _new_room_code() -> str:
        alphabet = string.ascii_uppercase + string.digits
        for _ in range(32):
            code = "".join(random.choice(alphabet) for _ in range(6))
            if code not in _rooms:
                return code
        return uuid.uuid4().hex[:6].upper()

    @app.post("/api/room/create")
    def api_room_create():
        code = _new_room_code()
        board = chess.Board()
        room = Room(code=code, game=Game(board=board), names={}, conns=set())
        with _rooms_lock:
            _rooms[code] = room
        return jsonify({"ok": True, "roomCode": code})

    @app.get("/api/room/state")
    def api_room_state():
        code = request.args.get("roomCode", "").strip().upper()
        if not code:
            return _error("missing_roomCode", "Query param 'roomCode' is required.")
        with _rooms_lock:
            room = _rooms.get(code)
            if room is None:
                return _error("unknown_room", "Unknown roomCode.", http_status=404)
            return jsonify(_room_state_payload(room))

    @app.get("/api/game/state")
    def api_game_state():
        game_id = request.args.get("gameId", "").strip()
        if not game_id:
            return _error("missing_gameId", "Query param 'gameId' is required.")

        with _games_lock:
            game = _games.get(game_id)
            if game is None:
                return _error("unknown_game", "Unknown gameId.", http_status=404)
            payload = {"ok": True, "gameId": game_id}
            payload.update(_board_summary(game))
            return jsonify(payload)

    @app.post("/api/game/move")
    def api_game_move():
        body = request.get_json(silent=True) or {}
        game_id = (body.get("gameId") or "").strip()
        uci = (body.get("uci") or "").strip()

        if not game_id:
            return _error("missing_gameId", "Body field 'gameId' is required.")
        if not uci:
            return _error("missing_uci", "Body field 'uci' is required.")

        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            return _error("invalid_uci_format", "Move must be UCI like e2e4 or e7e8q.")

        with _games_lock:
            game = _games.get(game_id)
            if game is None:
                return _error("unknown_game", "Unknown gameId.", http_status=404)

            board = game.board

            if board.outcome(claim_draw=True) is not None:
                payload = {"ok": False, "error": "game_over", "message": "Game is already over."}
                payload.update(_board_summary(game))
                return jsonify(payload), 409

            if move not in board.legal_moves:
                payload = {"ok": False, "error": "illegal_move", "message": "Illegal move."}
                payload.update(_board_summary(game))
                return jsonify(payload), 400

            board.push(move)
            game.last_move_uci = uci

            payload = {"ok": True, "gameId": game_id}
            payload.update(_board_summary(game))
            return jsonify(payload)

    @app.post("/api/game/ai_move")
    def api_game_ai_move():
        body = request.get_json(silent=True) or {}
        game_id = (body.get("gameId") or "").strip()
        if not game_id:
            return _error("missing_gameId", "Body field 'gameId' is required.")

        with _games_lock:
            game = _games.get(game_id)
            if game is None:
                return _error("unknown_game", "Unknown gameId.", http_status=404)

            board = game.board
            if board.outcome(claim_draw=True) is not None:
                payload = {"ok": False, "error": "game_over", "message": "Game is already over."}
                payload.update(_board_summary(game))
                return jsonify(payload), 409

            move = _choose_ai_move(board)
            if move is None:
                payload = {"ok": False, "error": "no_legal_moves", "message": "No legal moves."}
                payload.update(_board_summary(game))
                return jsonify(payload), 409

            uci = move.uci()
            board.push(move)
            game.last_move_uci = uci

            payload = {"ok": True, "gameId": game_id, "aiMoveUci": uci}
            payload.update(_board_summary(game))
            return jsonify(payload)

    @sock.route("/ws")
    def ws_handler(ws):
        client_id = uuid.uuid4().hex
        joined_room: Room | None = None

        def send(obj: dict):
            ws.send(json.dumps(obj))

        try:
            while True:
                raw = ws.receive()
                if raw is None:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    send({"type": "error", "error": "bad_json"})
                    continue

                mtype = msg.get("type")
                if mtype == "join":
                    code = (msg.get("roomCode") or "").strip().upper()
                    name = (msg.get("name") or "Player").strip()[:24]
                    if not code:
                        send({"type": "error", "error": "missing_roomCode"})
                        continue
                    with _rooms_lock:
                        room = _rooms.get(code)
                        if room is None:
                            send({"type": "error", "error": "unknown_room"})
                            continue
                        room.conns = room.conns or set()
                        room.names = room.names or {}
                        room.conns.add(ws)
                        room.names[client_id] = name
                        color = None
                        if room.white_id is None:
                            room.white_id = client_id
                            color = "w"
                        elif room.black_id is None:
                            room.black_id = client_id
                            color = "b"
                        else:
                            color = "s"
                        joined_room = room
                        send({"type": "joined", "clientId": client_id, "roomCode": code, "color": color})
                        _broadcast_room(room)
                    continue

                if mtype == "move":
                    if joined_room is None:
                        send({"type": "error", "error": "not_joined"})
                        continue
                    uci = (msg.get("uci") or "").strip()
                    if not uci:
                        send({"type": "error", "error": "missing_uci"})
                        continue
                    try:
                        move = chess.Move.from_uci(uci)
                    except ValueError:
                        send({"type": "error", "error": "invalid_uci_format"})
                        continue

                    with _rooms_lock:
                        room = joined_room
                        game = room.game
                        board = game.board

                        # Turn enforcement
                        my_color = (
                            "w"
                            if room.white_id == client_id
                            else ("b" if room.black_id == client_id else "s")
                        )
                        if my_color == "s":
                            send({"type": "error", "error": "spectator_cannot_move"})
                            continue
                        if _turn_char(board) != my_color:
                            send({"type": "error", "error": "not_your_turn"})
                            continue
                        if board.outcome(claim_draw=True) is not None:
                            send({"type": "error", "error": "game_over"})
                            continue
                        if move not in board.legal_moves:
                            send({"type": "error", "error": "illegal_move"})
                            continue

                        board.push(move)
                        game.last_move_uci = uci
                        _broadcast_room(room)
                    continue

                send({"type": "error", "error": "unknown_type"})
        finally:
            if joined_room is not None:
                with _rooms_lock:
                    try:
                        joined_room.conns.discard(ws)
                    except Exception:
                        pass

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
