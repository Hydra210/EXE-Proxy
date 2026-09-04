const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

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

  // Rewrite meta-refresh redirects (e.g. <meta http-equiv="refresh" content="0;url=...">)
  $('meta[http-equiv]').each((_, el) => {
    const node = $(el);
    if ((node.attr('http-equiv') || '').toLowerCase() !== 'refresh') return;
    const content = node.attr('content');
    if (!content) return;
    const match = content.match(/^(\d+)\s*;\s*url=(.+)$/i);
    if (!match) return;
    const seconds = match[1];
    const url = match[2].trim().replace(/^['"]|['"]$/g, '');
    node.attr('content', `${seconds};url=${toProxied(baseUrl, url)}`);
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
    if (val) el.setAttribute(attr, proxied(val));
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
      if (m.type === 'attributes') rewriteEl(m.target);
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

app.get('/proxy', async (req, res) => {
  const target = normalizeTarget(req.query.url);
  if (!target) {
    return res.status(400).send('Missing or invalid ?url= parameter.');
  }

  try {
    const upstream = await fetch(target, {
      redirect: 'follow',
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
      return res.send(rewritten);
    }

    // Non-HTML (images, css, js, fonts, json, etc.) — stream through as-is
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
