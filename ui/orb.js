// ═══════════════════════════════════════════
// ui/orb.js — 3D net cage, smoke, Jarvis rings
// ═══════════════════════════════════════════
import { CONFIG } from "../core/config.js";
import { Speech } from "../core/speech.js";

const canvas = document.getElementById("orb-canvas");
const ctx    = canvas.getContext("2d");
const C      = CONFIG.ORB;
let W, H, cx, cy, state = "idle", rotY = 0;
const rotX = 0.28;

const COLORS = {
  idle:      { c1:"#38bdf8", c2:"#0369a1", g:"56,189,248" },
  thinking:  { c1:"#fde68a", c2:"#b45309", g:"253,230,138" },
  speaking:  { c1:"#c4b5fd", c2:"#4f46e5", g:"196,181,253" },
  listening: { c1:"#86efac", c2:"#15803d", g:"134,239,172" },
};

// Fibonacci sphere nodes
const nodes = Array.from({ length: C.NODE_COUNT }, (_, i) => {
  const phi = Math.acos(1 - 2*(i+0.5)/C.NODE_COUNT);
  const th  = Math.PI*(1+Math.sqrt(5))*i;
  return { bx:Math.sin(phi)*Math.cos(th), by:Math.sin(phi)*Math.sin(th), bz:Math.cos(phi), spike:0, phase:Math.random()*Math.PI*2 };
});

const edges = [];
for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
  const dx=nodes[i].bx-nodes[j].bx, dy=nodes[i].by-nodes[j].by, dz=nodes[i].bz-nodes[j].bz;
  if (Math.sqrt(dx*dx+dy*dy+dz*dz)<0.68) edges.push([i,j]);
}

const SMOKE = Array.from({length:C.SMOKE_LAYERS},(_,i)=>({offset:(i/C.SMOKE_LAYERS)*Math.PI*2, speed:0.007+i*0.003, radius:16+i*7, amp:5+i*2}));

function resize() { W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; cx=W/2; cy=H/2; }
window.addEventListener("resize",resize); resize();

function project(nx,ny,nz,extra) {
  const cY=Math.cos(rotY),sY=Math.sin(rotY);
  const x1=nx*cY-nz*sY,z1=nx*sY+nz*cY;
  const cX=Math.cos(rotX),sX=Math.sin(rotX);
  const y1=ny*cX-z1*sX,z2=ny*sX+z1*cX;
  const r=C.NET_RADIUS+extra,fov=750,sc=fov/(fov+z2*50);
  return {sx:cx+x1*r*sc, sy:cy+y1*r*sc, z:z2, sc};
}

function draw(ts) {
  ctx.clearRect(0,0,W,H);
  rotY += 0.0046;
  const env = Speech.getEnvelope();
  const col = COLORS[state];

  // Update spikes
  nodes.forEach((n,i) => {
    let target = 0;
    if (state==="speaking") {
      const wave = Math.sin(ts*0.026+n.phase);
      target = wave > (0.82-env*0.68) ? (12+env*34) : 0;
    } else if (state==="listening") {
      target = Math.sin(ts*0.014+n.phase) > 0.65 ? (5+Math.random()*8) : 0;
    } else if (state==="thinking") {
      target = Math.max(0, Math.sin(ts*0.006+n.phase)*6);
    }
    n.spike += (target-n.spike)*0.42;
  });

  const proj = nodes.map((n,i)=>({...project(n.bx,n.by,n.bz,n.spike),i}));

  // Edges
  edges.forEach(([i,j])=>{
    const pa=proj[i],pb=proj[j];
    const midZ=(pa.z+pb.z)/2;
    const spiked=nodes[i].spike+nodes[j].spike>6;
    const alpha=0.05+0.4*((midZ+1)/2);
    ctx.beginPath(); ctx.moveTo(pa.sx,pa.sy); ctx.lineTo(pb.sx,pb.sy);
    ctx.strokeStyle=spiked?`rgba(${col.g},${Math.min(0.95,alpha*2.4).toFixed(2)})`:`rgba(${col.g},${alpha.toFixed(2)})`;
    ctx.lineWidth=spiked?1.8:0.75; ctx.stroke();
  });

  // Smoke
  SMOKE.forEach((s,i)=>{
    const t2=ts*s.speed+s.offset;
    ctx.save(); ctx.translate(cx,cy);
    for (let a=0;a<Math.PI*2;a+=0.28) {
      const sx=Math.cos(a+t2)*(s.radius+Math.sin(t2*2+a)*s.amp);
      const sy=Math.sin(a+t2)*(s.radius+Math.cos(t2*1.5+a)*s.amp)*0.5;
      ctx.beginPath(); ctx.arc(sx,sy,9+i*3,0,Math.PI*2);
      ctx.fillStyle=`rgba(${col.g},${(0.035+0.025*i)*(1+env*0.5)})`;
      ctx.fill();
    }
    ctx.restore();
  });

  // Core
  const grad=ctx.createRadialGradient(cx-16,cy-16,5,cx,cy,C.RADIUS);
  grad.addColorStop(0,col.c1); grad.addColorStop(0.55,col.c2); grad.addColorStop(1,"transparent");
  ctx.beginPath(); ctx.arc(cx,cy,C.RADIUS,0,Math.PI*2); ctx.fillStyle=grad; ctx.fill();

  // Nucleus
  const nuc=ctx.createRadialGradient(cx,cy,0,cx,cy,36);
  nuc.addColorStop(0,"rgba(255,255,255,0.9)"); nuc.addColorStop(0.3,`rgba(${col.g},0.6)`); nuc.addColorStop(1,"transparent");
  ctx.beginPath(); ctx.arc(cx,cy,36,0,Math.PI*2); ctx.fillStyle=nuc; ctx.fill();

  // Halo
  const glowR=C.RADIUS*(1.7+env*0.5);
  const halo=ctx.createRadialGradient(cx,cy,C.RADIUS*0.4,cx,cy,glowR);
  halo.addColorStop(0,`rgba(${col.g},${(0.28+env*0.22).toFixed(2)})`); halo.addColorStop(1,"transparent");
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
    const spiked=nodes[i].spike>6;
    const alpha=0.2+0.8*((p.z+1)/2);
    ctx.beginPath(); ctx.arc(p.sx,p.sy,(spiked?4:1.6)*p.sc,0,Math.PI*2);
    ctx.fillStyle=spiked?`rgba(255,255,255,${alpha.toFixed(2)})`:`rgba(${col.g},${alpha.toFixed(2)})`; ctx.fill();
  });

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

export const Orb = {
  setState(s) { state = s; },
  getState()  { return state; },
};