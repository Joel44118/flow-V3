// ═══════════════════════════════════════════
// ui/particles.js — Background neural web + World Map mode
// PERF: Neural web uses small fixed pool (60 pts, O(N²)=1800/frame)
//       Map mode uses continent pts only — no O(N²) at all
// ═══════════════════════════════════════════

const canvas = document.getElementById("bg-canvas");
const ctx    = canvas.getContext("2d");
let W, H;
function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
resize();
window.addEventListener("resize", () => { resize(); updateMapTargets(); });

// ── Mouse tracking ────────────────────────────────────────────────────────
const mouse = { x: -9999, y: -9999 };
window.addEventListener("mousemove", e => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener("mouseleave", () => { mouse.x = -9999; mouse.y = -9999; });

// ── Lerp state ────────────────────────────────────────────────────────────
let _lerpAmt    = 0;
let _lerpTarget = 0;

// ── Continent data ────────────────────────────────────────────────────────
// Each continent has: pts (lat/lon outline), label position (lat/lon), name
const CONTINENTS = [
  {
    name: "NORTH AMERICA", labelLat: 48, labelLon: -100,
    pts: [
      [72,-141],[70,-130],[62,-142],[58,-137],[54,-133],[51,-128],
      [49,-124],[47,-122],[45,-124],[42,-124],[40,-124],[37,-122],
      [34,-120],[32,-117],[28,-110],[22,-105],[15,-90],[10,-83],
      [8,-77],[9,-79],[11,-74],[18,-72],[23,-81],[25,-80],[31,-81],
      [35,-75],[38,-75],[41,-70],[45,-66],[47,-53],[52,-56],
      [58,-65],[62,-64],[66,-61],[70,-67],[70,-78],[72,-78],
      [72,-95],[70,-130],[72,-141],
    ]
  },
  {
    name: "SOUTH AMERICA", labelLat: -15, labelLon: -58,
    pts: [
      [11,-73],[8,-77],[4,-77],[0,-80],[-4,-81],[-7,-78],[-14,-76],
      [-18,-71],[-23,-70],[-30,-71],[-37,-73],[-41,-72],[-45,-66],
      [-52,-68],[-55,-68],[-55,-64],[-52,-58],[-46,-65],[-40,-62],
      [-34,-58],[-30,-50],[-23,-43],[-13,-39],[-8,-35],[-2,-40],
      [3,-50],[7,-60],[8,-63],[10,-62],[11,-63],[11,-73],
    ]
  },
  {
    name: "EUROPE", labelLat: 54, labelLon: 15,
    pts: [
      [71,28],[69,18],[65,14],[60,10],[58,5],[52,4],[51,2],[50,0],
      [48,0],[46,-2],[43,-9],[36,-6],[37,0],[38,10],[40,18],
      [37,15],[38,23],[41,29],[43,28],[47,24],[48,16],[52,14],
      [54,10],[57,10],[59,18],[64,26],[69,18],[71,25],[71,28],
    ]
  },
  {
    name: "AFRICA", labelLat: -5, labelLon: 22,
    pts: [
      [37,10],[34,-5],[30,-10],[22,-16],[15,-17],[10,-15],[4,-6],
      [0,6],[-5,10],[-10,14],[-15,12],[-18,11],[-22,14],[-26,15],
      [-30,17],[-33,18],[-35,20],[-33,27],[-28,32],[-24,35],
      [-18,36],[-11,40],[-1,41],[5,41],[11,42],[12,44],[11,43],
      [15,41],[20,37],[22,37],[30,32],[31,32],[32,25],[30,20],
      [30,15],[32,12],[33,12],[37,10],
    ]
  },
  {
    name: "ASIA", labelLat: 50, labelLon: 90,
    pts: [
      [70,30],[66,60],[62,60],[55,60],[50,58],[42,50],[36,50],
      [22,56],[12,44],[11,43],[15,41],[20,37],[22,37],[26,32],
      [23,22],[31,28],[22,38],[12,44],[8,77],[0,100],
      [1,104],[10,105],[20,110],[22,114],[32,122],[38,120],
      [42,130],[48,142],[54,142],[60,150],[64,150],[68,162],
      [66,170],[70,175],[70,162],[74,130],[74,110],[72,100],
      [76,80],[74,60],[72,52],[70,30],
    ]
  },
  {
    name: "AUSTRALIA", labelLat: -27, labelLon: 134,
    pts: [
      [-13,130],[-15,129],[-16,124],[-22,114],[-27,114],[-32,116],
      [-35,117],[-38,146],[-38,147],[-35,150],[-33,151],[-29,153],
      [-23,151],[-18,147],[-14,144],[-12,137],[-12,131],[-13,130],
    ]
  },
];

// ── Convert lat/lon → screen ──────────────────────────────────────────────
function ll2s(lat, lon) {
  return { x: (lon+180)/360*W, y: (90-lat)/180*H };
}

// ── MAP PARTICLES: one per continent point, no extras ─────────────────────
const MAP_PTS = [];
CONTINENTS.forEach((cont, ci) => {
  cont.pts.forEach(([lat, lon]) => {
    MAP_PTS.push({ lat, lon, ci, x: 0, y: 0 });
  });
});

function updateMapTargets() {
  MAP_PTS.forEach(p => {
    const s = ll2s(p.lat, p.lon);
    p.x = s.x; p.y = s.y;
  });
  // Precompute label positions
  CONTINENTS.forEach(c => {
    const s = ll2s(c.labelLat, c.labelLon);
    c.lx = s.x; c.ly = s.y;
  });
}
updateMapTargets();

// ── NEURAL WEB PARTICLES: small fixed pool, completely separate ───────────
const NW_COUNT = 62;
const nwPts = Array.from({ length: NW_COUNT }, () => ({
  x:  Math.random() * (window.innerWidth  || 1200),
  y:  Math.random() * (window.innerHeight || 800),
  vx: (Math.random()-.5) * 0.38,
  vy: (Math.random()-.5) * 0.38,
  r:  Math.random() * 1.1 + 0.45,
}));

// ── Draw smooth bezier path through a set of {x,y} points ────────────────
function drawSmooth(points, close) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let k = 1; k < points.length - 1; k++) {
    const mx = (points[k].x + points[k+1].x) / 2;
    const my = (points[k].y + points[k+1].y) / 2;
    ctx.quadraticCurveTo(points[k].x, points[k].y, mx, my);
  }
  const last = points[points.length - 1];
  if (close) {
    const mx = (last.x + points[0].x) / 2;
    const my = (last.y + points[0].y) / 2;
    ctx.quadraticCurveTo(last.x, last.y, mx, my);
    ctx.closePath();
  } else {
    ctx.lineTo(last.x, last.y);
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────
const MOUSE_R  = 105;
const LINK_D   = 148;

function draw() {
  ctx.clearRect(0, 0, W, H);
  _lerpAmt += (_lerpTarget - _lerpAmt) * 0.025;

  // ── NEURAL WEB MODE (lerpAmt < 0.05) ──────────────────────────────────
  if (_lerpAmt < 0.05) {

    // Move + mouse repulsion
    nwPts.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
      if (mouse.x > 0) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < MOUSE_R*MOUSE_R && d2 > 1) {
          const d = Math.sqrt(d2);
          const f = (1 - d/MOUSE_R) * 2.6;
          p.x += (dx/d)*f; p.y += (dy/d)*f;
        }
      }
    });

    // Lines between close particles — O(62²/2) = 1891/frame, fast
    for (let i = 0; i < NW_COUNT; i++) {
      for (let j = i+1; j < NW_COUNT; j++) {
        const dx = nwPts[i].x - nwPts[j].x;
        const dy = nwPts[i].y - nwPts[j].y;
        const d2 = dx*dx + dy*dy;
        if (d2 < LINK_D*LINK_D) {
          const d = Math.sqrt(d2);
          // Slight bezier bend on each link
          const mx = (nwPts[i].x+nwPts[j].x)/2 + (nwPts[j].y-nwPts[i].y)*0.055;
          const my = (nwPts[i].y+nwPts[j].y)/2 - (nwPts[j].x-nwPts[i].x)*0.055;
          ctx.beginPath();
          ctx.moveTo(nwPts[i].x, nwPts[i].y);
          ctx.quadraticCurveTo(mx, my, nwPts[j].x, nwPts[j].y);
          ctx.strokeStyle = `rgba(56,189,248,${((1-d/LINK_D)*0.14).toFixed(3)})`;
          ctx.lineWidth = 0.65; ctx.stroke();
        }
      }
    }

    // Mouse attraction lines
    if (mouse.x > 0) {
      nwPts.forEach(p => {
        const dx = p.x-mouse.x, dy = p.y-mouse.y;
        const d = Math.sqrt(dx*dx+dy*dy);
        if (d < 120) {
          ctx.beginPath(); ctx.moveTo(mouse.x,mouse.y); ctx.lineTo(p.x,p.y);
          ctx.strokeStyle = `rgba(167,139,250,${((1-d/120)*0.25).toFixed(3)})`;
          ctx.lineWidth = 0.9; ctx.stroke();
        }
      });
      ctx.beginPath(); ctx.arc(mouse.x,mouse.y,3.5,0,Math.PI*2);
      ctx.fillStyle = "rgba(167,139,250,0.45)"; ctx.fill();
    }

    // Dots
    nwPts.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle = "rgba(56,189,248,0.6)"; ctx.fill();
    });

  // ── WORLD MAP MODE (lerpAmt > 0.95) ────────────────────────────────────
  } else if (_lerpAmt > 0.95) {

    // Draw each continent as smooth bezier path
    let idx = 0;
    CONTINENTS.forEach(cont => {
      const cPts = MAP_PTS.slice(idx, idx + cont.pts.length);
      drawSmooth(cPts, true);
      ctx.strokeStyle = "rgba(52,211,153,0.75)";
      ctx.lineWidth   = 1.6;
      ctx.lineJoin    = "round";
      ctx.stroke();
      idx += cont.pts.length;
    });

    // Dots on continent outline points
    MAP_PTS.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI*2);
      ctx.fillStyle = "rgba(52,211,153,0.85)"; ctx.fill();
    });

    // ── Continent name labels ─────────────────────────────────────────────
    ctx.save();
    ctx.font         = "700 10px monospace";
    ctx.textAlign    = "center";
    ctx.shadowColor  = "rgba(52,211,153,0.8)";
    ctx.shadowBlur   = 8;
    ctx.fillStyle    = "rgba(52,211,153,0.65)";
    CONTINENTS.forEach(cont => {
      if (!cont.lx) return;
      ctx.fillText(cont.name, cont.lx, cont.ly);
    });
    ctx.restore();

    // Mouse spotlight
    if (mouse.x > 0) {
      const grad = ctx.createRadialGradient(mouse.x,mouse.y,0,mouse.x,mouse.y,90);
      grad.addColorStop(0,"rgba(52,211,153,0.10)");
      grad.addColorStop(1,"rgba(52,211,153,0)");
      ctx.beginPath(); ctx.arc(mouse.x,mouse.y,90,0,Math.PI*2);
      ctx.fillStyle = grad; ctx.fill();
    }

    // Grid + label
    ctx.save();
    ctx.strokeStyle = "rgba(52,211,153,0.07)";
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([4,10]);
    const ey = ll2s(0,0).y, pm = ll2s(0,0).x;
    ctx.beginPath(); ctx.moveTo(0,ey); ctx.lineTo(W,ey); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pm,0); ctx.lineTo(pm,H); ctx.stroke();
    const t1=ll2s(23.5,0).y, t2=ll2s(-23.5,0).y;
    ctx.strokeStyle="rgba(52,211,153,0.04)";
    ctx.beginPath(); ctx.moveTo(0,t1); ctx.lineTo(W,t1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,t2); ctx.lineTo(W,t2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha=0.65; ctx.font="700 10px monospace";
    ctx.fillStyle="rgba(52,211,153,0.7)"; ctx.textAlign="right";
    ctx.fillText("◉ WORLD INTEL", W-20, 24);
    ctx.restore();

  // ── CROSSFADE ───────────────────────────────────────────────────────────
  } else {
    const t  = _lerpAmt;
    const wt = Math.max(0, 1 - t*2.5);
    const mt = Math.max(0, t*2.5 - 1);

    // Neural web fading out (use nwPts, keep moving)
    if (wt > 0.01) {
      nwPts.forEach(p => { p.x+=p.vx; p.y+=p.vy; if(p.x<0||p.x>W)p.vx*=-1; if(p.y<0||p.y>H)p.vy*=-1; });
      for (let i=0;i<NW_COUNT;i++) for (let j=i+1;j<NW_COUNT;j++) {
        const dx=nwPts[i].x-nwPts[j].x,dy=nwPts[i].y-nwPts[j].y,d2=dx*dx+dy*dy;
        if (d2<LINK_D*LINK_D) {
          const d=Math.sqrt(d2);
          ctx.beginPath();ctx.moveTo(nwPts[i].x,nwPts[i].y);ctx.lineTo(nwPts[j].x,nwPts[j].y);
          ctx.strokeStyle=`rgba(56,189,248,${((1-d/LINK_D)*0.14*wt).toFixed(3)})`;
          ctx.lineWidth=0.65;ctx.stroke();
        }
      }
      nwPts.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(56,189,248,${(0.6*wt).toFixed(2)})`;ctx.fill();});
    }

    // Map fading in
    if (mt > 0.01) {
      let idx=0;
      CONTINENTS.forEach(cont=>{
        const cPts=MAP_PTS.slice(idx,idx+cont.pts.length);
        drawSmooth(cPts,true);
        ctx.strokeStyle=`rgba(52,211,153,${(0.75*mt).toFixed(3)})`;
        ctx.lineWidth=1.6;ctx.lineJoin="round";ctx.stroke();
        idx+=cont.pts.length;
      });
      MAP_PTS.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,1.8,0,Math.PI*2);ctx.fillStyle=`rgba(52,211,153,${(0.85*mt).toFixed(2)})`;ctx.fill();});
      if (mt > 0.5) {
        ctx.save();
        ctx.font="700 10px monospace";ctx.textAlign="center";
        ctx.shadowColor="rgba(52,211,153,0.8)";ctx.shadowBlur=8;
        CONTINENTS.forEach(c=>{if(c.lx){ctx.fillStyle=`rgba(52,211,153,${((mt-0.5)*1.3).toFixed(2)})`;ctx.fillText(c.name,c.lx,c.ly);}});
        ctx.restore();
      }
    }
  }

  requestAnimationFrame(draw);
}
draw();

// ── Public API ─────────────────────────────────────────────────────────────
export function setGlobeBackground(on) {
  _lerpTarget = on ? 1 : 0;
}
