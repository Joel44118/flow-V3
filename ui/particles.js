// ═══════════════════════════════════════════
// ui/particles.js — Background neural web + World Map mode
// ═══════════════════════════════════════════

const canvas = document.getElementById("bg-canvas");
const ctx    = canvas.getContext("2d");

let W, H;
function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
resize(); window.addEventListener("resize", resize);

// ── World map mode state ──────────────────────────────────────────────────
let _globeMode  = false;
let _lerpAmt    = 0;   // 0 = neural web, 1 = world map
let _lerpTarget = 0;

// ── Actual world city/landmark coordinates (lat/lon) ─────────────────────
// 110 points spread across all continents — dense enough to form recognizable shapes
const WORLD_POINTS = [
  // North America
  [49, -123], [47, -122], [44, -79], [40, -74], [37, -122], [34, -118],
  [41, -87],  [29, -95],  [32, -96], [25, -80], [19, -99],  [51, -114],
  [43, -80],  [45, -73],  [61, -150],[64, -147],[21, -157], [18, -66],
  // South America
  [-34, -58], [-23, -43], [-12, -77], [-3, -60], [10, -67], [4, -74],
  [-33, -70], [-16, -68], [-1, -78], [-25, -49], [-8, -35], [11, -15],
  // Europe
  [51, 0],    [48, 2],    [52, 13],  [55, 37],  [59, 18],  [60, 25],
  [41, 29],   [53, -8],   [43, -8],  [41, 12],  [37, 15],  [47, 8],
  [48, 16],   [50, 14],   [54, 18],  [56, 24],  [64, -22], [64, 26],
  // Africa
  [30, 31],   [6, 3],     [-26, 28], [33, -7],  [-4, 15],  [15, 38],
  [-18, 47],  [0, 37],    [12, 15],  [9, 38],   [-33, 18], [3, 36],
  [24, 32],   [-13, -12], [18, -16], [10, -13], [4, 9],    [-11, 17],
  // Asia
  [55, 37],   [39, 116],  [35, 139], [22, 114], [1, 104],  [13, 100],
  [28, 77],   [23, 90],   [31, 121], [37, 127], [33, 44],  [25, 51],
  [24, 46],   [41, 29],   [59, 57],  [43, 77],  [56, 93],  [52, 104],
  [62, 130],  [47, 142],  [69, 33],  [64, 100], [35, 51],  [32, 53],
  // Australia + Oceania
  [-33, 151], [-37, 145], [-27, 153], [-31, 116], [-12, 130],
  [-43, 172], [-36, 174], [-9, 147],  [-18, 178], [-13, -172],
  // Antarctica (sparse)
  [-85, 0],   [-80, 90],  [-75, -45],
  // More Africa fill
  [-4, 22],   [0, 15],    [7, 21],   [13, 23],  [20, 17],
];

// Convert lat/lon to screen x/y using equirectangular projection
function ll2screen(lat, lon) {
  const x = (lon + 180) / 360 * W;
  const y = (90 - lat)  / 180 * H;
  return { x, y };
}

// ── Particles: store both random pos and world map target ─────────────────
const pts = Array.from({ length: 110 }, (_, i) => {
  const rx = Math.random() * (window.innerWidth  || 1200);
  const ry = Math.random() * (window.innerHeight || 800);
  const wp = WORLD_POINTS[i] || [Math.random()*180-90, Math.random()*360-180];
  const ms = ll2screen(wp[0], wp[1]);
  return {
    x: rx, y: ry,       // current position (animates)
    rx, ry,              // random neural-web home
    mx: ms.x, my: ms.y, // world map target
    vx: (Math.random()-.5)*0.36,
    vy: (Math.random()-.5)*0.36,
    r: Math.random()*1.2 + 0.6,
  };
});

// Update map targets on resize
function updateMapTargets() {
  WORLD_POINTS.forEach((wp, i) => {
    if (!pts[i]) return;
    const ms   = ll2screen(wp[0], wp[1]);
    pts[i].mx  = ms.x;
    pts[i].my  = ms.y;
  });
}
window.addEventListener("resize", () => { resize(); updateMapTargets(); });

// Continent outline connections: pairs of point indices that form coastlines
// Connect points that are geographically adjacent (same continent, nearby)
function shouldConnect(i, j, lerpAmt) {
  if (lerpAmt < 0.3) {
    // Neural web mode: connect by distance
    const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
    return Math.sqrt(dx*dx + dy*dy) < 155;
  }
  // World map mode: connect only same-continent nearby points
  const wi = WORLD_POINTS[i] || [0,0];
  const wj = WORLD_POINTS[j] || [0,0];
  const dLat = wi[0]-wj[0], dLon = wi[1]-wj[1];
  const geo  = Math.sqrt(dLat*dLat + dLon*dLon);
  // Must be geographically close AND same rough region (longitude difference < 50°)
  return geo < 22 && Math.abs(dLon) < 50;
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  // Animate lerp
  _lerpAmt += (_lerpTarget - _lerpAmt) * 0.022;

  // Move each particle: lerp between random drift and map position
  pts.forEach(p => {
    if (_lerpAmt < 0.98) {
      // Random drift (scaled by 1-lerp)
      p.rx += p.vx;
      p.ry += p.vy;
      if (p.rx < 0 || p.rx > W) p.vx *= -1;
      if (p.ry < 0 || p.ry > H) p.vy *= -1;
    }
    // Interpolate between random home and map target
    p.x = p.rx + (p.mx - p.rx) * _lerpAmt;
    p.y = p.ry + (p.my - p.ry) * _lerpAmt;
  });

  // Draw connections
  const globeGreen = "52,211,153";
  const neuralBlue = "56,189,248";
  const col        = _lerpAmt > 0.5 ? globeGreen : neuralBlue;
  // Crossfade color
  const blueWeight  = Math.max(0, 1 - _lerpAmt * 2);
  const greenWeight = Math.max(0, _lerpAmt * 2 - 1);

  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
      const d  = Math.sqrt(dx*dx + dy*dy);

      if (_lerpAmt < 0.5) {
        // Neural web — distance-based
        if (d < 155) {
          const alpha = (1 - d/155) * 0.1 * (1 - _lerpAmt * 1.5);
          if (alpha <= 0) continue;
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y);
          ctx.strokeStyle = `rgba(56,189,248,${alpha.toFixed(3)})`;
          ctx.lineWidth   = 0.6; ctx.stroke();
        }
      } else {
        // World map — geographic connections only
        const wi = WORLD_POINTS[i] || [0,0];
        const wj = WORLD_POINTS[j] || [0,0];
        const dLat = wi[0]-wj[0], dLon = wi[1]-wj[1];
        const geo  = Math.sqrt(dLat*dLat + dLon*dLon);
        if (geo < 18 && Math.abs(dLon) < 45) {
          const alpha = ((1 - geo/18) * 0.55 * (_lerpAmt * 2 - 1)).toFixed(3);
          if (alpha <= 0) continue;
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y);
          ctx.strokeStyle = `rgba(52,211,153,${alpha})`;
          ctx.lineWidth   = 0.9; ctx.stroke();
        }
      }
    }
  }

  // Draw dots
  pts.forEach((p, i) => {
    const isLand    = _lerpAmt > 0.5 && i < WORLD_POINTS.length;
    const dotColor  = _lerpAmt < 0.5 ? `rgba(56,189,248,0.5)` : `rgba(52,211,153,${(0.3 + _lerpAmt * 0.5).toFixed(2)})`;
    const dotRadius = isLand ? p.r * 1.4 : p.r;
    ctx.beginPath();
    ctx.arc(p.x, p.y, dotRadius, 0, Math.PI*2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  });

  // World map mode: draw equator and prime meridian as subtle guides
  if (_lerpAmt > 0.4) {
    const a = Math.min(0.12, (_lerpAmt - 0.4) / 0.6 * 0.12);
    ctx.save();
    ctx.strokeStyle = `rgba(52,211,153,${a.toFixed(3)})`;
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([4, 8]);
    // Equator
    const ey = ll2screen(0, 0).y;
    ctx.beginPath(); ctx.moveTo(0, ey); ctx.lineTo(W, ey); ctx.stroke();
    // Prime meridian
    const px = ll2screen(0, 0).x;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.setLineDash([]);

    // "WORLD INTEL" label in top-right area
    const labelAlpha = Math.min(1, (_lerpAmt - 0.6) / 0.4);
    if (labelAlpha > 0) {
      ctx.globalAlpha = labelAlpha;
      ctx.font        = `700 10px monospace`;
      ctx.fillStyle   = "rgba(52,211,153,0.6)";
      ctx.textAlign   = "right";
      ctx.fillText("◉ WORLD INTEL", W - 24, 28);
      ctx.textAlign   = "left";
    }
    ctx.restore();
  }

  requestAnimationFrame(draw);
}
draw();

// ── Public API ─────────────────────────────────────────────────────────────
export function setGlobeBackground(on) {
  _globeMode  = on;
  _lerpTarget = on ? 1 : 0;
}
