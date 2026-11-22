# JadeGate

A lightweight web proxy. Every site you open goes through the JadeGate server. Links, forms, popups
and `target="_blank"` are rewritten so you always stay in one tab. Search uses DuckDuckGo.

## Accounts and messenger

Click **Sign in** in the toolbar to create an account (username and password), then
**Messages** to open the Caravanserai: a public room plus private messages, delivered live.

Nothing is saved. Accounts, sessions and messages exist only in the server's memory
([chat.js](chat.js)). They are never written to disk or logged, and no IP addresses are kept.
Passwords are stored only as scrypt hashes. Messages expire after 24 hours, and restarting the
server erases everything. On Render's free plan the server sleeps after 15 idle minutes, which also
wipes accounts.

## Run it on your PC

1. Install Node.js 20 or newer from https://nodejs.org.
2. Double-click `start-jadegate.bat`. It starts the server and opens JadeGate in Brave app mode
   (a single window with no tab bar).

Or run it from a terminal in this folder:

```
npm start
```

Then open http://localhost:8080.

To open a hosted copy in Brave: `start-jadegate.bat https://jadegate.yourdomain.com`

## Settings (environment variables)

| Variable            | Default                                 | What it does                                  |
|---------------------|-----------------------------------------|-----------------------------------------------|
| `PORT`              | `8080`                                  | Port the server listens on (hosts set this).  |
| `JADEGATE_PASSWORD` | (none)                                  | If set, visitors must enter it before use.    |
| `JADEGATE_SEARCH`   | `https://html.duckduckgo.com/html/?q=` | Search engine; the query is appended.         |

Set `JADEGATE_PASSWORD` whenever you host JadeGate publicly. Otherwise anyone can use your proxy
and the host may suspend your account.

## Deploy on Render (free, custom domain supported)

1. Push this folder to a GitHub repo.
2. On https://render.com choose **New > Web Service** and pick the repo.
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
   - Environment: add `JADEGATE_PASSWORD`
3. When it's live, go to **Settings > Custom Domains** and add e.g. `jadegate.yourdomain.com`.
4. At your domain registrar, add the CNAME record Render shows you (pointing to `your-app.onrender.com`).
   Render issues the HTTPS certificate automatically.

## Limits

- Very heavy, script-driven sites (YouTube, Discord, Google sign-in) may only partly work.
  WebSockets are not proxied. Script navigations (`location.href = ...`, `location.assign()`) are
  caught in Chrome, Edge and Brave. In Firefox and Safari they can still leave JadeGate and show
  "refused to connect".
- Search engines sometimes block requests that come from servers (HTTP 429 or a captcha).
  If a search engine blocks you, set `JADEGATE_SEARCH` to another engine.
