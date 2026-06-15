// ═══════════════════════════════════════════
// ui/particles.js — Background neural web + World Map mode
// ═══════════════════════════════════════════

const canvas = document.getElementById("bg-canvas");
const ctx    = canvas.getContext("2d");
let W, H;
function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
resize(); window.addEventListener("resize", resize);

// ── World map state ───────────────────────────────────────────────────────
let _globeMode  = false;
let _lerpAmt    = 0;
let _lerpTarget = 0;

// ── Simplified continent OUTLINE points (lat, lon) connected in order ─────
// These trace the coastlines so they visually form continent shapes
const CONTINENTS = [
  {
    name: "North America",
    color: "52,211,153",
    // Clockwise outline of North America
    pts: [
      [72,-141],[70,-130],[60,-142],[58,-137],[54,-133],[49,-124],[47,-122],
      [42,-124],[37,-122],[32,-117],[28,-110],[22,-105],[15,-90],[10,-83],
      [8,-77],[9,-79],[11,-74],[23,-81],[25,-80],[31,-81],[35,-75],
      [41,-70],[45,-66],[47,-53],[52,-56],[58,-65],[62,-64],[66,-61],
      [70,-67],[72,-78],[72,-95],[70,-130],[72,-141],
    ]
  },
  {
    name: "South America",
    color: "52,211,153",
    pts: [
      [11,-73],[8,-77],[4,-77],[0,-80],[-4,-81],[-7,-78],[-14,-76],
      [-18,-71],[-23,-70],[-30,-71],[-37,-73],[-41,-72],[-45,-66],
      [-52,-68],[-55,-68],[-55,-64],[-52,-58],[-46,-65],[-40,-62],
      [-34,-58],[-30,-50],[-23,-43],[-13,-39],[-8,-35],[-2,-40],
      [3,-50],[7,-60],[8,-63],[10,-62],[11,-63],[11,-73],
    ]
  },
  {
    name: "Europe",
    color: "52,211,153",
    pts: [
      [71,28],[69,18],[65,14],[58,5],[51,2],[48,0],[43,-9],[36,-6],
      [37,0],[38,15],[40,18],[37,15],[38,23],[41,29],[42,28],[43,28],
      [47,24],[48,16],[52,14],[54,10],[57,10],[59,18],[64,26],[69,18],
      [71,25],[71,28],
    ]
  },
  {
    name: "Africa",
    color: "52,211,153",
    pts: [
      [37,10],[34,-5],[30,-10],[22,-16],[15,-17],[10,-15],[4,-6],
      [0,8],[-5,10],[-10,14],[-15,12],[-18,11],[-22,14],[-26,15],
      [-30,17],[-33,18],[-35,20],[-33,27],[-28,32],[-24,35],
      [-18,36],[-11,40],[-1,41],[5,41],[11,42],[12,44],[11,43],
      [15,41],[20,37],[22,37],[30,32],[31,32],[30,33],[32,25],
      [30,20],[30,15],[32,12],[33,12],[37,10],
    ]
  },
  {
    name: "Asia",
    color: "52,211,153",
    pts: [
      [70,30],[66,60],[62,60],[55,60],[50,58],[42,50],[36,50],
      [22,56],[12,44],[11,43],[15,41],[20,37],[22,37],[26,32],
      [23,22],[31,28],[28,34],[22,38],[12,44],[8,77],[0,100],
      [1,104],[10,105],[20,110],[22,114],[32,122],[38,120],[42,130],
      [48,142],[54,142],[60,150],[64,150],[68,162],[66,170],
      [70,175],[70,162],[68,141],[64,173],[72,147],[74,130],
      [74,110],[72,100],[76,80],[74,60],[72,52],[70,30],
    ]
  },
  {
    name: "Australia",
    color: "52,211,153",
    pts: [
      [-13,130],[-15,129],[-16,124],[-22,114],[-27,114],[-32,116],
      [-35,117],[-38,146],[-38,147],[-35,150],[-33,151],[-29,153],
      [-23,151],[-18,147],[-14,144],[-12,137],[-12,131],[-13,130],
    ]
  },
];

// Flatten all continent points into a single array for particle animation
const ALL_POINTS = [];
CONTINENTS.forEach(cont => {
  cont.pts.forEach(pt => ALL_POINTS.push({ lat: pt[0], lon: pt[1], cont: cont.name }));
});

// Total points — pad with random extras to reach ~110
while (ALL_POINTS.length < 100) {
  ALL_POINTS.push({ lat: Math.random()*160-80, lon: Math.random()*360-180, cont: null });
}

// ── Convert lat/lon → screen ──────────────────────────────────────────────
function ll2s(lat, lon) {
  return {
    x: (lon + 180) / 360 * W,
    y: (90 - lat) / 180 * H,
  };
}

// ── Particles ─────────────────────────────────────────────────────────────
const N = ALL_POINTS.length;
const pts = Array.from({ length: N }, (_, i) => {
  const rx = Math.random() * (window.innerWidth  || 1200);
  const ry = Math.random() * (window.innerHeight || 800);
  return {
    x: rx, y: ry,
    rx, ry,
    mx: 0, my: 0,  // world map target — set after first resize
    vx: (Math.random()-.5)*0.36,
    vy: (Math.random()-.5)*0.36,
    r: Math.random()*1.1 + 0.5,
  };
});

function updateMapTargets() {
  ALL_POINTS.forEach((wp, i) => {
    if (!pts[i]) return;
    const s    = ll2s(wp.lat, wp.lon);
    pts[i].mx  = s.x;
    pts[i].my  = s.y;
  });
}
updateMapTargets();
window.addEventListener("resize", () => { resize(); updateMapTargets(); });

// ── Draw ──────────────────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, W, H);

  // Animate lerp
  _lerpAmt += (_lerpTarget - _lerpAmt) * 0.025;

  // Move particles
  pts.forEach(p => {
    p.rx += p.vx;
    p.ry += p.vy;
    if (p.rx < 0 || p.rx > W) p.vx *= -1;
    if (p.ry < 0 || p.ry > H) p.vy *= -1;
    p.x = p.rx + (p.mx - p.rx) * _lerpAmt;
    p.y = p.ry + (p.my - p.ry) * _lerpAmt;
  });

  if (_lerpAmt < 0.05) {
    // ── Pure neural web ───────────────────────────────────────────────────
    for (let i = 0; i < N; i++) for (let j = i+1; j < N; j++) {
      const dx = pts[i].x-pts[j].x, dy = pts[i].y-pts[j].y;
      const d  = Math.sqrt(dx*dx+dy*dy);
      if (d < 155) {
        ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y);
        ctx.strokeStyle = `rgba(56,189,248,${((1-d/155)*0.1).toFixed(3)})`;
        ctx.lineWidth = 0.6; ctx.stroke();
      }
    }
    pts.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle = "rgba(56,189,248,0.5)"; ctx.fill();
    });

  } else if (_lerpAmt > 0.95) {
    // ── Pure world map ────────────────────────────────────────────────────
    // Draw each continent outline as a connected polyline
    let ptIdx = 0;
    CONTINENTS.forEach(cont => {
      const cPts = cont.pts;
      ctx.beginPath();
      cPts.forEach((_, k) => {
        const idx = ptIdx + k;
        if (idx >= pts.length) return;
        const p = pts[idx];
        if (k === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = `rgba(52,211,153,0.65)`;
      ctx.lineWidth   = 1.4;
      ctx.stroke();
      ptIdx += cPts.length;
    });

    // Dots
    pts.forEach((p, i) => {
      const wp  = ALL_POINTS[i];
      const big = wp?.cont !== null;
      ctx.beginPath(); ctx.arc(p.x, p.y, big ? 2.2 : 1.0, 0, Math.PI*2);
      ctx.fillStyle = big ? "rgba(52,211,153,0.8)" : "rgba(52,211,153,0.2)";
      ctx.fill();
    });

    // Grid lines
    ctx.save();
    ctx.strokeStyle = "rgba(52,211,153,0.08)";
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([4,10]);
    // Equator
    const ey = ll2s(0,0).y;
    ctx.beginPath(); ctx.moveTo(0,ey); ctx.lineTo(W,ey); ctx.stroke();
    // Prime meridian
    const pm = ll2s(0,0).x;
    ctx.beginPath(); ctx.moveTo(pm,0); ctx.lineTo(pm,H); ctx.stroke();
    ctx.setLineDash([]);
    // Label
    ctx.globalAlpha  = 0.65;
    ctx.font         = "700 10px monospace";
    ctx.fillStyle    = "rgba(52,211,153,0.7)";
    ctx.textAlign    = "right";
    ctx.fillText("◉ WORLD INTEL", W-20, 24);
    ctx.restore();

  } else {
    // ── Crossfade: blend both ─────────────────────────────────────────────
    const t  = _lerpAmt;
    const wt = Math.max(0, 1 - t*2.5);   // neural web fades out
    const mt = Math.max(0, t*2.5 - 1);   // map fades in

    // Neural web (fading)
    if (wt > 0.01) {
      for (let i=0; i<N; i++) for (let j=i+1; j<N; j++) {
        const dx=pts[i].x-pts[j].x, dy=pts[i].y-pts[j].y;
        const d=Math.sqrt(dx*dx+dy*dy);
        if (d<155) {
          ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y);
          ctx.strokeStyle=`rgba(56,189,248,${((1-d/155)*0.1*wt).toFixed(3)})`;
          ctx.lineWidth=0.6; ctx.stroke();
        }
      }
    }

    // Continent outlines (fading in)
    if (mt > 0.01) {
      let ptIdx = 0;
      CONTINENTS.forEach(cont => {
        ctx.beginPath();
        cont.pts.forEach((_,k) => {
          const idx = ptIdx+k;
          if (idx >= pts.length) return;
          const p = pts[idx];
          if (k===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y);
        });
        ctx.strokeStyle = `rgba(52,211,153,${(0.65*mt).toFixed(3)})`;
        ctx.lineWidth=1.4; ctx.stroke();
        ptIdx += cont.pts.length;
      });
    }

    // Dots (color crossfade)
    pts.forEach((p,i) => {
      const isMap = ALL_POINTS[i]?.cont !== null;
      const col   = isMap && t > 0.5 ? "52,211,153" : "56,189,248";
      const alpha = 0.5;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle = `rgba(${col},${alpha})`; ctx.fill();
    });
  }

  requestAnimationFrame(draw);
}
draw();

// ── Public API ─────────────────────────────────────────────────────────────
export function setGlobeBackground(on) {
  _globeMode  = on;
  _lerpTarget = on ? 1 : 0;
}
