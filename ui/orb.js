// ═══════════════════════════════════════════
// ui/orb.js — 3D net cage, smoke, Jarvis rings + Globe mode
// ═══════════════════════════════════════════
import { CONFIG } from "../core/config.js";
import { Speech } from "../core/speech.js";

const canvas = document.getElementById("orb-canvas");
const ctx    = canvas.getContext("2d");
const C      = CONFIG.ORB;
let W, H, cx, cy, state = "idle", rotY = 0;
const rotX = 0.28;

// ── Globe mode ────────────────────────────────────────────────────────────
let globeMode   = false;
let globeLerp   = 0;      // 0 = normal sphere, 1 = globe shape
let globeTarget = 0;      // what globeLerp is animating toward

const COLORS = {
  idle:      { c1:"#38bdf8", c2:"#0369a1", g:"56,189,248"   },
  thinking:  { c1:"#fde68a", c2:"#b45309", g:"253,230,138"  },
  speaking:  { c1:"#c4b5fd", c2:"#4f46e5", g:"196,181,253"  },
  listening: { c1:"#86efac", c2:"#15803d", g:"134,239,172"  },
  globe:     { c1:"#34d399", c2:"#065f46", g:"52,211,153"   }, // green for Earth
};

// ── Continent anchor points (lat/lon → unit sphere xyz) ───────────────────
// Each anchor pulls nearby nodes toward it when globe mode is active
// lat/lon in degrees → xyz on unit sphere
function ll2xyz(lat, lon) {
  const φ = lat * Math.PI / 180;
  const λ = lon * Math.PI / 180;
  return {
    x: Math.cos(φ) * Math.cos(λ),
    y: Math.sin(φ),
    z: Math.cos(φ) * Math.sin(λ),
  };
}

// Continent cluster centres + rough size (radius of influence 0..1)
const CONTINENTS = [
  // North America
  { ...ll2xyz(40,  -100), r: 0.38, label: "NA" },
  // South America
  { ...ll2xyz(-15,  -60), r: 0.30, label: "SA" },
  // Europe
  { ...ll2xyz( 50,   15), r: 0.22, label: "EU" },
  // Africa (includes Nigeria!)
  { ...ll2xyz(  5,   20), r: 0.36, label: "AF" },
  // Asia
  { ...ll2xyz( 35,   90), r: 0.48, label: "AS" },
  // Australia
  { ...ll2xyz(-25,  135), r: 0.22, label: "AU" },
  // Antarctica
  { ...ll2xyz(-80,    0), r: 0.20, label: "AN" },
];

// Pre-compute each node's "globe target" position:
// Pull it toward the nearest continent centre's surface edge,
// so the net clusters into continent shapes
function computeGlobeTarget(bx, by, bz) {
  // Find which continent this node is closest to
  let bestDist = Infinity, bestC = null;
  for (const c of CONTINENTS) {
    const dx = bx - c.x, dy = by - c.y, dz = bz - c.z;
    const d  = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (d < bestDist) { bestDist = d; bestC = c; }
  }
  if (!bestC || bestDist > bestC.r * 1.8) {
    // Ocean — push node slightly inward (sinks toward centre of sphere)
    const scale = 0.55;
    return { gx: bx * scale, gy: by * scale, gz: bz * scale };
  }
  // Land — keep on surface but cluster toward continent centre
  const pull = 0.35; // how strongly nodes are pulled to centre (0=no pull, 1=all merge)
  const tx   = bx + (bestC.x - bx) * pull;
  const ty   = by + (bestC.y - by) * pull;
  const tz   = bz + (bestC.z - bz) * pull;
  // Normalize back onto unit sphere
  const len  = Math.sqrt(tx*tx + ty*ty + tz*tz);
  return { gx: tx/len, gy: ty/len, gz: tz/len };
}

// Fibonacci sphere nodes — store both sphere position and globe target
const nodes = Array.from({ length: C.NODE_COUNT }, (_, i) => {
  const phi = Math.acos(1 - 2*(i+0.5)/C.NODE_COUNT);
  const th  = Math.PI*(1+Math.sqrt(5))*i;
  const bx  = Math.sin(phi)*Math.cos(th);
  const by  = Math.sin(phi)*Math.sin(th);
  const bz  = Math.cos(phi);
  const gt  = computeGlobeTarget(bx, by, bz);
  return { bx, by, bz, ...gt, spike: 0, phase: Math.random()*Math.PI*2 };
});

const edges = [];
for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
  const dx=nodes[i].bx-nodes[j].bx, dy=nodes[i].by-nodes[j].by, dz=nodes[i].bz-nodes[j].bz;
  if (Math.sqrt(dx*dx+dy*dy+dz*dz)<0.68) edges.push([i,j]);
}

const SMOKE = Array.from({length:C.SMOKE_LAYERS},(_,i)=>({
  offset:(i/C.SMOKE_LAYERS)*Math.PI*2, speed:0.007+i*0.003, radius:16+i*7, amp:5+i*2
}));

function resize() { W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; cx=W/2; cy=H/2; }
window.addEventListener("resize", resize); resize();

function project(nx, ny, nz, extra) {
  const cY=Math.cos(rotY), sY=Math.sin(rotY);
  const x1=nx*cY-nz*sY, z1=nx*sY+nz*cY;
  const cX=Math.cos(rotX), sX=Math.sin(rotX);
  const y1=ny*cX-z1*sX, z2=ny*sX+z1*cX;
  const r=C.NET_RADIUS+extra, fov=750, sc=fov/(fov+z2*50);
  return { sx:cx+x1*r*sc, sy:cy+y1*r*sc, z:z2, sc };
}

function draw(ts) {
  ctx.clearRect(0,0,W,H);

  // Globe rotation is slower and smoother
  rotY += globeMode ? 0.0018 : 0.0046;

  // Animate globeLerp toward globeTarget
  globeLerp += (globeTarget - globeLerp) * 0.025;

  const env = Speech.getEnvelope();
  const col = globeMode ? COLORS.globe : COLORS[state];

  // Update spikes — disabled in globe mode
  nodes.forEach((n) => {
    let target = 0;
    if (!globeMode) {
      if (state==="speaking") {
        const wave = Math.sin(ts*0.026+n.phase);
        target = wave > (0.82-env*0.68) ? (12+env*34) : 0;
      } else if (state==="listening") {
        target = Math.sin(ts*0.014+n.phase) > 0.65 ? (5+Math.random()*8) : 0;
      } else if (state==="thinking") {
        target = Math.max(0, Math.sin(ts*0.006+n.phase)*6);
      }
    }
    n.spike += (target - n.spike) * 0.42;
  });

  // Interpolate node positions between sphere (lerp=0) and globe (lerp=1)
  const proj = nodes.map((n) => {
    const nx = n.bx + (n.gx - n.bx) * globeLerp;
    const ny = n.by + (n.gy - n.by) * globeLerp;
    const nz = n.bz + (n.gz - n.bz) * globeLerp;
    return { ...project(nx, ny, nz, n.spike), nx, ny, nz };
  });

  // Edges — in globe mode, only draw edges between land nodes (continent outlines)
  edges.forEach(([i,j]) => {
    const pa = proj[i], pb = proj[j];
    const midZ = (pa.z+pb.z)/2;
    const spiked = nodes[i].spike+nodes[j].spike > 6;

    if (globeMode) {
      // In globe mode: draw land edges bright, ocean edges very faint
      const niOcean = (nodes[i].bx**2+nodes[i].by**2+nodes[i].bz**2) < 0.4;
      const njOcean = (nodes[j].bx**2+nodes[j].by**2+nodes[j].bz**2) < 0.4;
      const isOcean = niOcean || njOcean;
      const alpha   = isOcean
        ? 0.04 * ((midZ+1)/2)
        : 0.15 + 0.6 * ((midZ+1)/2);
      ctx.beginPath(); ctx.moveTo(pa.sx,pa.sy); ctx.lineTo(pb.sx,pb.sy);
      ctx.strokeStyle = `rgba(${col.g},${alpha.toFixed(2)})`;
      ctx.lineWidth   = isOcean ? 0.4 : 1.2;
      ctx.stroke();
    } else {
      const alpha = 0.05 + 0.4*((midZ+1)/2);
      ctx.beginPath(); ctx.moveTo(pa.sx,pa.sy); ctx.lineTo(pb.sx,pb.sy);
      ctx.strokeStyle = spiked
        ? `rgba(${col.g},${Math.min(0.95,alpha*2.4).toFixed(2)})`
        : `rgba(${col.g},${alpha.toFixed(2)})`;
      ctx.lineWidth = spiked ? 1.8 : 0.75;
      ctx.stroke();
    }
  });

  // Smoke — subtle in globe mode
  SMOKE.forEach((s,i) => {
    const t2 = ts*s.speed+s.offset;
    ctx.save(); ctx.translate(cx,cy);
    for (let a=0;a<Math.PI*2;a+=0.28) {
      const sx=Math.cos(a+t2)*(s.radius+Math.sin(t2*2+a)*s.amp);
      const sy=Math.sin(a+t2)*(s.radius+Math.cos(t2*1.5+a)*s.amp)*0.5;
      ctx.beginPath(); ctx.arc(sx,sy,9+i*3,0,Math.PI*2);
      const opacity = globeMode ? 0.015+0.01*i : (0.035+0.025*i)*(1+env*0.5);
      ctx.fillStyle=`rgba(${col.g},${opacity})`;
      ctx.fill();
    }
    ctx.restore();
  });

  // Core glow
  const grad=ctx.createRadialGradient(cx-16,cy-16,5,cx,cy,C.RADIUS);
  grad.addColorStop(0,col.c1); grad.addColorStop(0.55,col.c2); grad.addColorStop(1,"transparent");
  ctx.beginPath(); ctx.arc(cx,cy,C.RADIUS,0,Math.PI*2); ctx.fillStyle=grad; ctx.fill();

  // Nucleus
  const nuc=ctx.createRadialGradient(cx,cy,0,cx,cy,36);
  nuc.addColorStop(0,"rgba(255,255,255,0.9)");
  nuc.addColorStop(0.3,`rgba(${col.g},0.6)`);
  nuc.addColorStop(1,"transparent");
  ctx.beginPath(); ctx.arc(cx,cy,36,0,Math.PI*2); ctx.fillStyle=nuc; ctx.fill();

  // Halo
  const glowR=C.RADIUS*(1.7+env*0.5);
  const halo=ctx.createRadialGradient(cx,cy,C.RADIUS*0.4,cx,cy,glowR);
  halo.addColorStop(0,`rgba(${col.g},${(0.28+env*0.22).toFixed(2)})`);
  halo.addColorStop(1,"transparent");
  ctx.beginPath(); ctx.arc(cx,cy,glowR,0,Math.PI*2); ctx.fillStyle=halo; ctx.fill();

  // Jarvis rings
  [{r:C.RADIUS+18,spd:0.004,lw:1.2},{r:C.RADIUS+32,spd:-0.003,lw:0.7}].forEach(ring=>{
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(ts*ring.spd); ctx.scale(1,0.28);
    ctx.beginPath(); ctx.arc(0,0,ring.r,0,Math.PI*2);
    ctx.strokeStyle=`rgba(${col.g},${(0.3+env*0.2).toFixed(2)})`; ctx.lineWidth=ring.lw; ctx.stroke();
    ctx.restore();
  });

  // Node dots
  proj.forEach((p,i)=>{
    if(p.z<-0.25) return;
    const spiked = nodes[i].spike>6;
    const alpha  = 0.2+0.8*((p.z+1)/2);
    // In globe mode: land nodes are bright green dots, ocean very dim
    const isLand = globeMode && !(nodes[i].bx**2+nodes[i].by**2+nodes[i].bz**2 < 0.4);
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, (spiked?4:globeMode && isLand ? 2.5 : 1.6)*p.sc, 0, Math.PI*2);
    ctx.fillStyle = spiked
      ? `rgba(255,255,255,${alpha.toFixed(2)})`
      : globeMode && !isLand
        ? `rgba(${col.g},${(alpha*0.25).toFixed(2)})`
        : `rgba(${col.g},${alpha.toFixed(2)})`;
    ctx.fill();
  });

  // Globe mode: "GLOBE" label
  if (globeLerp > 0.3) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, (globeLerp - 0.3) / 0.4);
    ctx.font = `700 9px var(--fd, monospace)`;
    ctx.fillStyle = `rgba(52,211,153,0.7)`;
    ctx.letterSpacing = "0.14em";
    ctx.textAlign = "center";
    ctx.fillText("WORLD INTEL", cx, cy + C.NET_RADIUS + 36);
    ctx.restore();
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

export const Orb = {
  setState(s) {
    state = s;
    // If a non-intel state is set, exit globe mode
    if (s !== "globe" && globeMode) {
      globeMode   = false;
      globeTarget = 0;
    }
    // Sync the title-bar rotating light effect to the SAME real colors
    // used above (STATES palette) — reading from document root CSS
    // custom properties rather than a duplicated color map, so the two
    // effects can never silently drift out of sync with each other.
    const palette = COLORS[s] || COLORS.idle;
    document.documentElement.style.setProperty("--titlebar-glow-c1", palette.c1);
    document.documentElement.style.setProperty("--titlebar-glow-c2", palette.c2);
    document.documentElement.style.setProperty("--titlebar-glow-rgb", palette.g);
  },
  setGlobe(on) {
    globeMode   = on;
    globeTarget = on ? 1 : 0;
    if (on) state = "globe";
  },
  getState()  { return state; },
};
