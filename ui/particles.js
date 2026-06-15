// ═══════════════════════════════════════════
// ui/particles.js — Background neural web + World Map mode
// ═══════════════════════════════════════════

const canvas = document.getElementById("bg-canvas");
const ctx    = canvas.getContext("2d");
let W, H;
function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
resize(); window.addEventListener("resize", resize);

// ── Mouse tracking ────────────────────────────────────────────────────────
const mouse = { x: -9999, y: -9999 };
window.addEventListener("mousemove", e => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener("mouseleave", () => { mouse.x = -9999; mouse.y = -9999; });

// ── World map state ───────────────────────────────────────────────────────
let _globeMode  = false;
let _lerpAmt    = 0;
let _lerpTarget = 0;

// ── Continent OUTLINE points (lat, lon) — denser for smooth curves ────────
const CONTINENTS = [
  {
    name: "North America", color: "52,211,153",
    pts: [
      [72,-141],[71,-136],[70,-130],[67,-140],[62,-142],[60,-142],[58,-137],
      [56,-133],[54,-133],[51,-128],[49,-124],[47,-122],[45,-124],[42,-124],
      [40,-124],[37,-122],[34,-120],[32,-117],[30,-115],[28,-110],[25,-105],
      [22,-105],[18,-95],[15,-90],[12,-85],[10,-83],[8,-77],[9,-79],
      [11,-74],[14,-72],[18,-72],[23,-81],[25,-80],[28,-80],[31,-81],
      [34,-77],[35,-75],[38,-75],[41,-70],[43,-70],[45,-66],[47,-53],
      [50,-55],[52,-56],[55,-59],[58,-65],[62,-64],[64,-63],[66,-61],
      [68,-65],[70,-67],[70,-78],[72,-78],[72,-95],[72,-110],[70,-130],[72,-141],
    ]
  },
  {
    name: "South America", color: "52,211,153",
    pts: [
      [11,-73],[10,-75],[8,-77],[6,-77],[4,-77],[2,-79],[0,-80],
      [-2,-80],[-4,-81],[-5,-80],[-7,-78],[-10,-76],[-14,-76],
      [-16,-73],[-18,-71],[-20,-70],[-23,-70],[-26,-70],[-30,-71],
      [-33,-72],[-37,-73],[-38,-73],[-41,-72],[-42,-72],[-43,-70],
      [-45,-66],[-48,-67],[-52,-68],[-54,-68],[-55,-68],[-55,-66],
      [-55,-64],[-53,-60],[-52,-58],[-50,-65],[-46,-65],[-43,-63],
      [-40,-62],[-37,-58],[-34,-58],[-31,-52],[-30,-50],[-25,-48],
      [-23,-43],[-20,-40],[-16,-39],[-13,-39],[-10,-37],[-8,-35],
      [-5,-37],[-2,-40],[0,-48],[2,-50],[4,-50],[6,-55],[7,-60],
      [8,-63],[9,-63],[10,-62],[11,-63],[11,-73],
    ]
  },
  {
    name: "Europe", color: "52,211,153",
    pts: [
      [71,28],[70,25],[69,18],[68,16],[66,14],[64,14],[62,12],
      [60,10],[58,5],[56,8],[54,8],[52,4],[51,2],[50,0],
      [48,0],[46,-2],[43,-9],[38,-9],[36,-6],[37,0],
      [38,5],[38,10],[39,15],[40,18],[38,15],[37,15],[37,20],
      [38,23],[40,27],[41,29],[42,28],[43,28],[44,28],[45,28],
      [46,24],[47,24],[48,18],[48,16],[50,14],[52,14],[54,10],
      [55,10],[57,10],[59,18],[62,24],[64,26],[66,29],
      [68,25],[70,22],[71,25],[71,28],
    ]
  },
  {
    name: "Africa", color: "52,211,153",
    pts: [
      [37,10],[36,5],[34,-1],[34,-5],[32,-8],[30,-10],[27,-13],
      [22,-16],[18,-16],[15,-17],[12,-16],[10,-15],[8,-12],[6,-10],
      [4,-6],[2,-4],[0,2],[0,6],[-2,8],[-5,10],[-8,12],
      [-10,14],[-12,14],[-15,12],[-18,11],[-20,12],[-22,14],
      [-26,15],[-28,16],[-30,17],[-32,18],[-33,18],[-35,20],
      [-34,24],[-33,27],[-30,30],[-28,32],[-26,33],[-24,35],
      [-22,36],[-20,36],[-18,36],[-14,38],[-11,40],[-6,40],
      [-1,41],[3,41],[5,41],[8,40],[11,42],[12,44],[11,43],
      [12,42],[14,41],[15,41],[18,38],[20,37],[22,37],
      [24,35],[26,34],[28,34],[30,32],[31,32],[32,28],
      [32,25],[32,22],[32,18],[32,15],[30,15],[32,12],[33,12],
      [34,12],[36,10],[37,10],
    ]
  },
  {
    name: "Asia", color: "52,211,153",
    pts: [
      [70,30],[70,40],[68,45],[66,55],[66,60],[64,60],[62,60],
      [58,60],[55,60],[52,58],[50,58],[47,52],[44,50],[42,50],
      [40,50],[38,50],[36,50],[34,48],[30,48],[26,50],[22,56],
      [18,52],[14,48],[12,44],[11,43],[11,42],[12,44],[14,44],
      [16,43],[16,42],[18,40],[20,37],[22,38],[24,38],[26,38],
      [26,34],[28,34],[26,32],[24,30],[22,30],[20,30],[18,74],
      [16,80],[12,80],[10,80],[8,78],[8,77],[2,100],[0,100],
      [0,104],[6,102],[10,105],[14,108],[18,108],[20,110],[22,114],
      [24,116],[26,118],[28,120],[30,122],[32,122],[34,120],[36,120],
      [38,120],[40,122],[40,125],[42,130],[44,132],[46,135],
      [48,138],[48,142],[50,142],[52,142],[54,142],[56,140],
      [58,142],[60,150],[62,152],[64,152],[66,162],
      [68,165],[66,170],[70,175],[70,162],[68,141],
      [72,147],[74,135],[74,130],[74,120],[74,110],
      [72,100],[74,90],[76,80],[76,72],[74,60],[74,54],
      [72,52],[72,44],[72,38],[70,30],
    ]
  },
  {
    name: "Australia", color: "52,211,153",
    pts: [
      [-13,130],[-13,132],[-14,132],[-15,129],[-16,127],[-16,124],
      [-18,120],[-20,116],[-22,114],[-24,114],[-26,114],[-28,114],
      [-30,115],[-32,116],[-34,116],[-35,117],[-36,138],[-37,142],
      [-38,146],[-38,147],[-37,149],[-36,150],[-35,150],[-33,151],
      [-32,152],[-30,153],[-28,153],[-26,153],[-24,152],[-23,151],
      [-21,149],[-20,148],[-18,147],[-16,145],[-14,144],[-13,141],
      [-12,140],[-12,137],[-12,134],[-12,131],[-13,130],
    ]
  },
];

// Flatten continent points
const ALL_POINTS = [];
CONTINENTS.forEach(cont => {
  cont.pts.forEach(pt => ALL_POINTS.push({ lat: pt[0], lon: pt[1], cont: cont.name }));
});

// Pad with random sea-points
while (ALL_POINTS.length < 220) {
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
const pts = Array.from({ length: N }, () => {
  const rx = Math.random() * (window.innerWidth  || 1200);
  const ry = Math.random() * (window.innerHeight || 800);
  return {
    x: rx, y: ry,
    rx, ry,
    mx: 0, my: 0,
    vx: (Math.random()-.5)*0.32,
    vy: (Math.random()-.5)*0.32,
    r:  Math.random()*1.1 + 0.5,
  };
});

function updateMapTargets() {
  ALL_POINTS.forEach((wp, i) => {
    if (!pts[i]) return;
    const s   = ll2s(wp.lat, wp.lon);
    pts[i].mx = s.x;
    pts[i].my = s.y;
  });
}
updateMapTargets();
window.addEventListener("resize", () => { resize(); updateMapTargets(); });

// ── Smooth catmull-rom style path through continent points ────────────────
function drawSmoothPath(indices) {
  if (indices.length < 2) return;
  ctx.beginPath();
  const validPts = indices.map(i => pts[i]).filter(Boolean);
  if (validPts.length < 2) return;
  ctx.moveTo(validPts[0].x, validPts[0].y);
  for (let k = 1; k < validPts.length - 1; k++) {
    const p0 = validPts[k - 1];
    const p1 = validPts[k];
    const p2 = validPts[k + 1];
    // Control point = current point, target = midpoint to next
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    ctx.quadraticCurveTo(p1.x, p1.y, mx, my);
  }
  const last = validPts[validPts.length - 1];
  ctx.lineTo(last.x, last.y);
}

// ── Draw ──────────────────────────────────────────────────────────────────
const MOUSE_R = 110;

function draw() {
  ctx.clearRect(0, 0, W, H);

  _lerpAmt += (_lerpTarget - _lerpAmt) * 0.025;

  // Move particles + mouse repulsion
  pts.forEach(p => {
    // Float drift
    p.rx += p.vx;
    p.ry += p.vy;
    if (p.rx < 0 || p.rx > W) p.vx *= -1;
    if (p.ry < 0 || p.ry > H) p.vy *= -1;

    // Interpolate toward map target
    p.x = p.rx + (p.mx - p.rx) * _lerpAmt;
    p.y = p.ry + (p.my - p.ry) * _lerpAmt;

    // Mouse repulsion in neural web mode
    if (_lerpAmt < 0.7) {
      const dx = p.rx - mouse.x;
      const dy = p.ry - mouse.y;
      const d  = Math.sqrt(dx*dx + dy*dy);
      if (d < MOUSE_R && d > 1) {
        const force = (1 - d / MOUSE_R) * 2.8;
        p.rx += (dx / d) * force;
        p.ry += (dy / d) * force;
      }
    }
  });

  if (_lerpAmt < 0.05) {
    // ── Pure neural web ─────────────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      for (let j = i+1; j < N; j++) {
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        const d  = dx*dx + dy*dy;
        if (d < 150*150) {
          const dist  = Math.sqrt(d);
          const alpha = (1 - dist/150) * 0.13;
          // Slight curve on each neural line
          const mx = (pts[i].x + pts[j].x)/2 + (pts[j].y - pts[i].y)*0.06;
          const my = (pts[i].y + pts[j].y)/2 - (pts[j].x - pts[i].x)*0.06;
          ctx.beginPath();
          ctx.moveTo(pts[i].x, pts[i].y);
          ctx.quadraticCurveTo(mx, my, pts[j].x, pts[j].y);
          ctx.strokeStyle = `rgba(56,189,248,${alpha.toFixed(3)})`;
          ctx.lineWidth   = 0.6;
          ctx.stroke();
        }
      }
    }

    // Mouse glow + attraction lines
    if (mouse.x > 0) {
      pts.forEach(p => {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const d  = Math.sqrt(dx*dx + dy*dy);
        if (d < 130) {
          ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = `rgba(167,139,250,${((1-d/130)*0.22).toFixed(3)})`;
          ctx.lineWidth   = 0.9; ctx.stroke();
        }
      });
      ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 3.5, 0, Math.PI*2);
      ctx.fillStyle = "rgba(167,139,250,0.4)"; ctx.fill();
    }

    // Dots
    pts.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fillStyle = "rgba(56,189,248,0.55)"; ctx.fill();
    });

  } else if (_lerpAmt > 0.95) {
    // ── Pure world map ───────────────────────────────────────────────────
    let ptIdx = 0;
    CONTINENTS.forEach(cont => {
      const indices = cont.pts.map((_, k) => ptIdx + k);
      drawSmoothPath(indices);
      ctx.strokeStyle = "rgba(52,211,153,0.72)";
      ctx.lineWidth   = 1.6;
      ctx.lineJoin    = "round";
      ctx.stroke();
      ptIdx += cont.pts.length;
    });

    // Dots
    pts.forEach((p, i) => {
      const big = ALL_POINTS[i]?.cont !== null;
      ctx.beginPath(); ctx.arc(p.x, p.y, big ? 2.0 : 0.7, 0, Math.PI*2);
      ctx.fillStyle = big ? "rgba(52,211,153,0.88)" : "rgba(52,211,153,0.16)";
      ctx.fill();
    });

    // Subtle mouse spotlight on map
    if (mouse.x > 0) {
      const grad = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 100);
      grad.addColorStop(0, "rgba(52,211,153,0.10)");
      grad.addColorStop(1, "rgba(52,211,153,0)");
      ctx.beginPath(); ctx.arc(mouse.x, mouse.y, 100, 0, Math.PI*2);
      ctx.fillStyle = grad; ctx.fill();
    }

    // Grid lines
    ctx.save();
    ctx.strokeStyle = "rgba(52,211,153,0.07)";
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([4,10]);
    const ey = ll2s(0,0).y;
    ctx.beginPath(); ctx.moveTo(0,ey); ctx.lineTo(W,ey); ctx.stroke();
    const pm = ll2s(0,0).x;
    ctx.beginPath(); ctx.moveTo(pm,0); ctx.lineTo(pm,H); ctx.stroke();
    const tr1 = ll2s(23.5, 0).y;
    const tr2 = ll2s(-23.5, 0).y;
    ctx.strokeStyle = "rgba(52,211,153,0.04)";
    ctx.beginPath(); ctx.moveTo(0,tr1); ctx.lineTo(W,tr1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,tr2); ctx.lineTo(W,tr2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.65;
    ctx.font        = "700 10px monospace";
    ctx.fillStyle   = "rgba(52,211,153,0.7)";
    ctx.textAlign   = "right";
    ctx.fillText("◉ WORLD INTEL", W-20, 24);
    ctx.restore();

  } else {
    // ── Crossfade ────────────────────────────────────────────────────────
    const t  = _lerpAmt;
    const wt = Math.max(0, 1 - t*2.5);
    const mt = Math.max(0, t*2.5 - 1);

    if (wt > 0.01) {
      for (let i=0; i<N; i++) for (let j=i+1; j<N; j++) {
        const dx=pts[i].x-pts[j].x, dy=pts[i].y-pts[j].y;
        const d2=dx*dx+dy*dy;
        if (d2<150*150) {
          const dist=Math.sqrt(d2);
          const mx=(pts[i].x+pts[j].x)/2+(pts[j].y-pts[i].y)*0.06;
          const my=(pts[i].y+pts[j].y)/2-(pts[j].x-pts[i].x)*0.06;
          ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y);
          ctx.quadraticCurveTo(mx,my,pts[j].x,pts[j].y);
          ctx.strokeStyle=`rgba(56,189,248,${((1-dist/150)*0.13*wt).toFixed(3)})`;
          ctx.lineWidth=0.6; ctx.stroke();
        }
      }
    }

    if (mt > 0.01) {
      let ptIdx=0;
      CONTINENTS.forEach(cont => {
        const indices=cont.pts.map((_,k)=>ptIdx+k);
        drawSmoothPath(indices);
        ctx.strokeStyle=`rgba(52,211,153,${(0.72*mt).toFixed(3)})`;
        ctx.lineWidth=1.6; ctx.lineJoin="round"; ctx.stroke();
        ptIdx+=cont.pts.length;
      });
    }

    pts.forEach((p,i) => {
      const isMap = ALL_POINTS[i]?.cont !== null;
      const col   = isMap && t > 0.5 ? "52,211,153" : "56,189,248";
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(${col},0.5)`; ctx.fill();
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
