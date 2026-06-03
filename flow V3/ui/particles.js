// ═══════════════════════════════════════════
// ui/particles.js — Background neural web
// ═══════════════════════════════════════════

const canvas = document.getElementById("bg-canvas");
const ctx    = canvas.getContext("2d");

function resize() { canvas.width=window.innerWidth; canvas.height=window.innerHeight; }
resize(); window.addEventListener("resize",resize);

const pts = Array.from({length:110},()=>({
  x:Math.random()*canvas.width, y:Math.random()*canvas.height,
  vx:(Math.random()-.5)*.36,   vy:(Math.random()-.5)*.36,
  r:Math.random()*1.2+0.6,
}));

function draw() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  pts.forEach(p=>{
    p.x+=p.vx; p.y+=p.vy;
    if(p.x<0||p.x>canvas.width)  p.vx*=-1;
    if(p.y<0||p.y>canvas.height) p.vy*=-1;
  });
  for(let i=0;i<pts.length;i++) for(let j=i+1;j<pts.length;j++){
    const dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy);
    if(d<155){
      ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y);
      ctx.strokeStyle=`rgba(56,189,248,${((1-d/155)*0.1).toFixed(3)})`; ctx.lineWidth=0.6; ctx.stroke();
    }
  }
  pts.forEach(p=>{
    ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
    ctx.fillStyle="rgba(56,189,248,0.5)"; ctx.fill();
  });
  requestAnimationFrame(draw);
}
draw();