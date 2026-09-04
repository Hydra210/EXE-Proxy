const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const compression = require('compression');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Gzip everything we send back to the browser (HTML, and any text-ish
// passthrough assets that aren't already compressed).
app.use(compression());

app.use(express.static('public'));

// Reuse TCP/TLS connections to upstream hosts instead of paying a fresh
// handshake on every single request (page + every image/css/js it loads).
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
function agentFor(targetUrl) {
  return targetUrl.startsWith('https:') ? httpsAgent : httpAgent;
}

// Small in-memory cache for non-HTML assets (css/js/images/fonts) so that
// the same file requested repeatedly within a short window — very common
// across a single page load, or a few reloads — doesn't get re-fetched
// through Render every time. Capped in size; not persisted across restarts.
const assetCache = new Map(); // url -> { body, contentType, headers, expiresAt }
const ASSET_CACHE_MAX_ENTRIES = 200;
const ASSET_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedAsset(url) {
  const hit = assetCache.get(url);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    assetCache.delete(url);
    return null;
  }
  return hit;
}

function setCachedAsset(url, entry) {
  if (assetCache.size >= ASSET_CACHE_MAX_ENTRIES) {
    const oldestKey = assetCache.keys().next().value;
    assetCache.delete(oldestKey);
  }
  assetCache.set(url, entry);
}

// --- helpers -----------------------------------------------------------

function normalizeTarget(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  try {
    return new URL(url).toString();
  } catch (e) {
    return null;
  }
}

// Build a proxied URL for any resource found on the page
function toProxied(base, resourceUrl) {
  try {
    const abs = new URL(resourceUrl, base).toString();
    return '/proxy?url=' + encodeURIComponent(abs);
  } catch (e) {
    return resourceUrl;
  }
}

// Rewrites url(...) references inside CSS text (external stylesheets,
// <style> blocks, and style="" attributes) so backgrounds, @font-face,
// @import, etc. get routed through the proxy too — otherwise they just
// point straight at the real site and silently fail to load.
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
function rewriteCssText(css, baseUrl) {
  if (!css) return css;
  return css.replace(CSS_URL_RE, (match, quote, rawUrl) => {
    const url = rawUrl.trim();
    if (!url || url.startsWith('data:') || url.startsWith('#')) return match;
    return `url(${quote}${toProxied(baseUrl, url)}${quote})`;
  });
}

const REWRITE_ATTRS = ['href', 'src', 'action', 'srcset'];

function rewriteHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  $('*').each((_, el) => {
    const node = $(el);
    REWRITE_ATTRS.forEach((attr) => {
      const val = node.attr(attr);
      if (!val) return;

      if (attr === 'srcset') {
        // srcset can contain multiple comma-separated candidates
        const rewritten = val
          .split(',')
          .map((part) => {
            const [urlPart, size] = part.trim().split(/\s+/, 2);
            if (!urlPart) return part;
            const proxied = toProxied(baseUrl, urlPart);
            return size ? `${proxied} ${size}` : proxied;
          })
          .join(', ');
        node.attr('srcset', rewritten);
        return;
      }

      if (val.startsWith('#') || val.startsWith('javascript:') || val.startsWith('mailto:') || val.startsWith('data:')) {
        return;
      }

      node.attr(attr, toProxied(baseUrl, val));
    });
  });

  // Neutralize base tags so relative resolution stays predictable
  $('base').remove();

  // Rewrite url(...) references inside <style> blocks and style="" attributes
  $('style').each((_, el) => {
    $(el).text(rewriteCssText($(el).html(), baseUrl));
  });
  $('[style]').each((_, el) => {
    const node = $(el);
    node.attr('style', rewriteCssText(node.attr('style'), baseUrl));
  });

  // Handle <meta http-equiv> tags: rewrite refresh redirects, strip CSP
  // (the page's own CSP can otherwise block our injected script and/or
  // resources now loading from our domain instead of the original one).
  $('meta[http-equiv]').each((_, el) => {
    const node = $(el);
    const httpEquiv = (node.attr('http-equiv') || '').toLowerCase();

    if (httpEquiv === 'content-security-policy') {
      node.remove();
      return;
    }

    if (httpEquiv === 'refresh') {
      const content = node.attr('content');
      if (!content) return;
      const match = content.match(/^(\d+)\s*;\s*url=(.+)$/i);
      if (!match) return;
      const seconds = match[1];
      const url = match[2].trim().replace(/^['"]|['"]$/g, '');
      node.attr('content', `${seconds};url=${toProxied(baseUrl, url)}`);
    }
  });

  // Inject a base target marker
  $('head').prepend(`<meta name="exe-proxy-origin" content="${baseUrl}">`);

  // Inject a client-side script that keeps JS-driven navigation/requests
  // (dynamically added links, SPA routing, fetch/XHR calls, redirects)
  // routed through the proxy too, not just the links present at load time.
  const clientScript = `<script>(function(){
var EXE_ORIGIN = ${JSON.stringify(baseUrl)};
function abs(u){ try { return new URL(u, EXE_ORIGIN).toString(); } catch(e){ return u; } }
function proxied(u){
  if (!u || typeof u !== 'string') return u;
  if (u.indexOf('/proxy?url=') === 0) return u;
  if (/^(#|javascript:|data:|mailto:|blob:|about:)/i.test(u)) return u;
  return '/proxy?url=' + encodeURIComponent(abs(u));
}
var REWRITE_ATTRS = ['href','src','action'];
function rewriteEl(el){
  if (!el || !el.getAttribute) return;
  REWRITE_ATTRS.forEach(function(attr){
    var val = el.getAttribute(attr);
    if (!val) return;
    var next = proxied(val);
    // Only touch the DOM if the value would actually change — calling
    // setAttribute with the same value still fires a mutation event,
    // which would otherwise re-trigger this same handler forever.
    if (next !== val) el.setAttribute(attr, next);
  });
}
function rewriteTree(root){
  if (!root || !root.querySelectorAll) return;
  rewriteEl(root);
  var els = root.querySelectorAll('[href],[src],[action]');
  for (var i = 0; i < els.length; i++) rewriteEl(els[i]);
}
function startObserving(){
  new MutationObserver(function(muts){
    muts.forEach(function(m){
      if (m.addedNodes) m.addedNodes.forEach(function(n){ if (n.nodeType === 1) rewriteTree(n); });
      if (m.type === 'attributes' && m.target && m.target.getAttribute) {
        var val = m.target.getAttribute(m.attributeName);
        if (val && val.indexOf('/proxy?url=') !== 0) rewriteEl(m.target);
      }
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: REWRITE_ATTRS });
  rewriteTree(document);
}
if (document.documentElement) startObserving();
else document.addEventListener('DOMContentLoaded', startObserving);
var nativeFetch = window.fetch;
if (nativeFetch) {
  window.fetch = function(input, init){
    try {
      if (typeof input === 'string') input = proxied(input);
      else if (input && input.url) input = new Request(proxied(input.url), input);
    } catch(e) {}
    return nativeFetch.call(this, input, init);
  };
}
var nativeOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url){
  var args = Array.prototype.slice.call(arguments);
  try { args[1] = proxied(url); } catch(e) {}
  return nativeOpen.apply(this, args);
};
})();</script>`;
  $('head').prepend(clientScript);

  return $.html();
}

// --- routes --------------------------------------------------------------

// Content types worth caching in memory + telling the browser to cache.
// Deliberately excludes JSON/text (often live API data that shouldn't go stale).
const CACHEABLE_ASSET_RE = /^(image\/|font\/|text\/css|(application|text)\/javascript|application\/font|application\/x-font)/i;

app.get('/proxy', async (req, res) => {
  const target = normalizeTarget(req.query.url);
  if (!target) {
    return res.status(400).send('Missing or invalid ?url= parameter.');
  }

  // Serve from our own cache when we can — skips the upstream round trip
  // entirely for assets we've already fetched recently (shared css/js,
  // logos, icon fonts, etc. that show up across many page loads).
  const cached = getCachedAsset(target);
  if (cached) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(cached.body);
  }

  try {
    const upstream = await fetch(target, {
      redirect: 'follow',
      agent: (parsedUrl) => (parsedUrl.protocol === 'http:' ? httpAgent : httpsAgent),
      headers: {
        'User-Agent':
          req.get('user-agent') ||
          'Mozilla/5.0 (compatible; EXEProxy/1.0)',
        Accept: req.get('accept') || '*/*',
        'Accept-Language': req.get('accept-language') || 'en-US,en;q=0.9',
      },
      timeout: 20000,
    });

    const contentType = upstream.headers.get('content-type') || '';
    res.status(upstream.status);

    if (contentType.includes('text/html')) {
      const body = await upstream.text();
      const rewritten = rewriteHtml(body, upstream.url || target);
      res.set('Content-Type', 'text/html; charset=utf-8');
      // Pages are dynamic (search results, feeds, etc.) — don't cache these.
      res.set('Cache-Control', 'no-cache');
      return res.send(rewritten);
    }

    if (contentType.includes('text/css')) {
      const cssText = await upstream.text();
      const rewritten = rewriteCssText(cssText, upstream.url || target);
      res.set('Content-Type', 'text/css; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=300');
      setCachedAsset(target, {
        body: rewritten,
        contentType: 'text/css; charset=utf-8',
        expiresAt: Date.now() + ASSET_CACHE_TTL_MS,
      });
      return res.send(rewritten);
    }

    if (CACHEABLE_ASSET_RE.test(contentType)) {
      const buffer = await upstream.buffer();
      res.set('Content-Type', contentType || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=300');
      setCachedAsset(target, {
        body: buffer,
        contentType: contentType || 'application/octet-stream',
        expiresAt: Date.now() + ASSET_CACHE_TTL_MS,
      });
      return res.send(buffer);
    }

    // Everything else (JSON APIs, streaming media, etc.) — stream through as-is
    res.set('Content-Type', contentType || 'application/octet-stream');
    upstream.body.pipe(res);
  } catch (err) {
    console.error('Proxy error for', target, err.message);
    res
      .status(502)
      .send(
        `Couldn't load that page. The site may be blocking proxies, or the URL may be wrong.<br><br><small>${err.message}</small>`
      );
  }
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`EXE Proxy running on port ${PORT}`);
});
