# EXE Proxy

A minimal web proxy with a dark, starfield UI. Type in a URL (or a search
term), and the server fetches the page and streams it back to you, rewriting
links/assets so you can keep browsing through the proxy.

## How it works

- `server.js` — Express app. `GET /proxy?url=<target>` fetches `target`
  server-side and returns it. HTML responses are rewritten with `cheerio` so
  links, images, scripts, and forms route back through `/proxy`. Everything
  else (images, CSS, JS, fonts, JSON) is streamed through unchanged.
- `public/` — the landing page: pitch-black background, canvas-drawn
  twinkling starfield, and a search bar that redirects to `/proxy?url=...`.

## Local development

```bash
npm install
npm start
```

Visit `http://localhost:3000`.

## Deploy to Render

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In the Render dashboard: **New +** → **Web Service** → connect the repo.
3. Render should auto-detect the included `render.yaml`. If not, set manually:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
4. Deploy. Render assigns a public URL automatically.

No environment variables or API keys are required.

## Known limitations

- **JavaScript-heavy sites** (SPAs, sites that fetch data via `fetch`/XHR
  after load) will often break, since only same-document HTML is rewritten —
  in-page `fetch()` calls to the original domain won't get proxied
  automatically.
- **Cookies/login sessions** aren't preserved per-user; sites requiring login
  generally won't work well.
- **Some sites actively block proxies/datacenter IPs** (Render's IPs are
  datacenter IPs), so certain targets may refuse the request outright.
- This is a functional starting point, not a hardened production proxy —
  there's no rate limiting, allow/block list, or abuse protection built in.

## A note on use

Open proxies like this are frequently used to get around network-level
content filtering (school, workplace, etc.), which can violate the
acceptable-use policies of those networks. Use accordingly.
