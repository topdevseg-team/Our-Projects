## Glass Chess (Flask + JS + CSS)

Professional chess web app where the **Flask backend is the source of truth** for move validation (via `python-chess`), and the **frontend focuses on smooth UX** (glassmorphism UI, drag/drop, animations, puzzle assessment).

### Project layout

- `backend/`
  - `app.py` (Flask API + serves frontend)
  - `requirements.txt`
- `frontend/`
  - `index.html`
  - `style.css`
  - `game.js`

### Run on Windows (PowerShell)

From the project root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r .\backend\requirements.txt
python .\backend\app.py
```

Then open:
- `http://127.0.0.1:5000/`

### Deploy backend on Render (recommended for Netlify frontend)

Netlify hosts the **static frontend**, but this app needs a **Python backend** for:
- move validation (`python-chess`)
- play vs computer
- multiplayer WebSockets (`/ws`)

#### Render setup

- **Create**: Render → New → **Web Service**
- **Connect repo**: this repository
- **Root directory**: leave blank
- **Build command**:

```bash
pip install -r backend/requirements.txt
```

- **Start command** (WebSockets supported):

```bash
gunicorn -w 1 -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker backend.app:create_app\(\)
```

- **Environment variables**:
  - **ALLOWED_ORIGINS**: set to your Netlify site origin(s), e.g. `https://your-site.netlify.app`

After deploy, your backend base URL will look like `https://your-service.onrender.com`.

#### Netlify setup

- Deploy the **`frontend/` folder** as your Netlify site.
- Open the site → **Settings** → set **Backend URL (for Netlify)** to your Render backend base URL.

### Notes

- **Move format**: the frontend sends moves as UCI (e.g. `e2e4`, promotions like `e7e8q`). The backend accepts/rejects and returns updated `fen` and `legalUciMoves`.
- **Assets**: pieces are loaded from Wikimedia Commons SVGs using `Special:FilePath/*` URLs, with a Unicode fallback if an image fails.
- **ELO assessment**: 3 hardcoded puzzles run entirely client-side (no external API costs). Estimated ELO is stored in `localStorage` under `glasschess_elo`.
