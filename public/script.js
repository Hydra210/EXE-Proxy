// --- tiny starfield -------------------------------------------------------
const canvas = document.getElementById('stars');
const ctx = canvas.getContext('2d');
let stars = [];

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const count = Math.floor((canvas.width * canvas.height) / 4000);
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    r: Math.random() * 1.1 + 0.2,
    baseAlpha: Math.random() * 0.6 + 0.2,
    twinkleSpeed: Math.random() * 0.02 + 0.005,
    phase: Math.random() * Math.PI * 2,
  }));
}

function draw(time) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  for (const s of stars) {
    const alpha = s.baseAlpha + Math.sin(time * s.twinkleSpeed + s.phase) * 0.25;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(draw);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(draw);

// --- go form ---------------------------------------------------------------
const form = document.getElementById('go-form');
const input = document.getElementById('url-input');

function looksLikeUrl(str) {
  return /^(https?:\/\/)?[^\s]+\.[^\s]{2,}$/i.test(str.trim());
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = input.value.trim();
  if (!val) return;

  let target;
  if (looksLikeUrl(val)) {
    target = val.startsWith('http') ? val : 'https://' + val;
  } else {
    target = 'https://www.google.com/search?q=' + encodeURIComponent(val);
  }

  window.location.href = '/proxy?url=' + encodeURIComponent(target);
});
