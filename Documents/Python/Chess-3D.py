from ursina import *
import chess
import chess.engine
import random

# Path for Stockfish on your Arch/CachyOS system
STOCKFISH_PATH = "/usr/bin/stockfish"

class ChessTitans(Entity):
    def __init__(self):
        super().__init__()
        self.board = chess.Board()
        self.selected_sq = None
        self.game_mode = "PvE"
        self.piece_entities = []
        
        self.create_board()
        self.setup_ui()
        self.update_pieces()

    def create_board(self):
        # Dark wood base to contrast the white screen issue
        self.base = Entity(model='cube', scale=(8.2, 0.4, 8.2), y=-0.25, color=color.rgb(50, 25, 10))
        
        self.squares = {}
        for r in range(8):
            for c in range(8):
                is_black = (r + c) % 2 == 0
                sq = Button(
                    parent=self, model='cube', scale=(1, 0.1, 1), position=(c, 0, r),
                    color=color.rgb(230, 230, 220) if not is_black else color.rgb(30, 50, 30),
                    highlight_color=color.yellow
                )
                sq.on_click = Func(self.on_sq_click, (r, c))
                self.squares[(r, c)] = sq

    def setup_ui(self):
        self.ui_parent = Entity(parent=camera.ui, position=(-0.75, 0.4))
        self.mode_btn = Button(parent=self.ui_parent, text=f"Mode: {self.game_mode}", 
                               scale=(0.25, 0.05), color=color.azure, on_click=self.toggle_mode)
        Button(parent=self.ui_parent, text="Undo", scale=(0.25, 0.05), y=-0.07, on_click=self.undo)

    def toggle_mode(self):
        self.game_mode = "PvP" if self.game_mode == "PvE" else "PvE"
        self.mode_btn.text = f"Mode: {self.game_mode}"

    def undo(self):
        steps = 2 if (self.game_mode == "PvE" and len(self.board.move_stack) >= 2) else 1
        if len(self.board.move_stack) >= steps:
            for _ in range(steps): self.board.pop()
            self.update_pieces()

    def update_pieces(self):
        for p in self.piece_entities: destroy(p)
        self.piece_entities.clear()

        for sq_idx, piece in self.board.piece_map().items():
            r, c = divmod(sq_idx, 8)
            
            # --- SCALE ADJUSTMENT ---
            # Increase this if they still look like dots
            p_scale = 0.06 
            
            p_entity = Entity(
                parent=self,
                model='assets/chess.obj', # Your TurboSquid OBJ
                color=color.white if piece.color == chess.WHITE else color.black,
                position=(c, 0.05, r),
                scale=p_scale,
                rotation_x=-90, 
                shading='smooth'
            )
            self.piece_entities.append(p_entity)

    def on_sq_click(self, pos):
        r, c = pos
        square_idx = chess.square(c, r)
        if self.selected_sq is None:
            p = self.board.piece_at(square_idx)
            if p and p.color == self.board.turn:
                self.selected_sq = square_idx
                self.squares[pos].color = color.cyan
        else:
            move = chess.Move(self.selected_sq, square_idx)
            if move in self.board.legal_moves:
                self.board.push(move)
                self.update_pieces()
                if not self.board.is_game_over() and self.game_mode == "PvE":
                    invoke(self.computer_move, delay=0.5)
            self.reset_colors()
            self.selected_sq = None

    def computer_move(self):
        moves = list(self.board.legal_moves)
        if moves:
            self.board.push(random.choice(moves))
            self.update_pieces()

    def reset_colors(self):
        for p, s in self.squares.items():
            s.color = color.rgb(230, 230, 220) if (p[0]+p[1])%2!=0 else color.rgb(30, 50, 30)

app = Ursina()

# --- THE LIGHTING FIX ---
# A dark background prevents the over-exposure seen in your images
Sky(color=color.rgb(30, 30, 30))
sun = DirectionalLight(y=10, rotation=(45, -45, 0))
sun.shadows = True

game = ChessTitans()
game.position = (-3.5, 0, -3.5)

# --- CAMERA SETUP ---
cam = EditorCamera()
cam.position = (0, 15, -12)
cam.rotation_x = 45

app.run()