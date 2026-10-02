// Visualisation: three.js 3D path view (Z-up) + two 2D canvas plots.
// three.js is loaded lazily so the 2D plots still work if the CDN is unreachable.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Round a length (m) down to a "nice" 1/2/5 x 10^n value. */
function niceLength(m) {
  const p = Math.pow(10, Math.floor(Math.log10(m)));
  const f = m / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

function bounds(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { min, max };
}

// ---------------------------------------------------------------- 2D plots
const FUSED_HEX = 0xe040fb, FUSED_CSS = '#e040fb';

function drawPlot(canvas, points, points2, hAxis, vAxis, hName, vName) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const text = css('--text'), muted = css('--muted'), grid = css('--grid');

  const pts = points.map((p) => [p[hAxis], p[vAxis]]);
  const start = pts[0], end = pts[pts.length - 1];
  const pts2 = points2 ? points2.map((p) => [p[hAxis], p[vAxis]]) : null;
  const b = bounds([...pts, ...(pts2 || [])].map((p) => [p[0], p[1], 0]));
  const padL = 26, padR = 12, padT = 12, padB = 24;
  const aw = W - padL - padR, ah = H - padT - padB;
  const spanH = Math.max(b.max[0] - b.min[0], 0.05), spanV = Math.max(b.max[1] - b.min[1], 0.05);
  const s = Math.min(aw / (spanH * 1.2), ah / (spanV * 1.2)); // px per metre, equal on both axes
  const cH = (b.min[0] + b.max[0]) / 2, cV = (b.min[1] + b.max[1]) / 2;
  const X = (h) => padL + aw / 2 + (h - cH) * s;
  const Y = (v) => padT + ah / 2 - (v - cV) * s;

  // origin cross-hairs
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, Y(0)); ctx.lineTo(W - padR, Y(0));
  ctx.moveTo(X(0), padT); ctx.lineTo(X(0), H - padB);
  ctx.stroke();

  // path
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
  ctx.stroke();

  if (pts2 && pts2.length) {
    ctx.strokeStyle = FUSED_CSS; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    pts2.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.stroke();
  }

  const dot = (p, color, r = 5) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), r, 0, 7); ctx.fill(); };
  dot(start, css('--start')); dot(end, css('--end'));
  if (pts2 && pts2.length) {
    const e2 = pts2[pts2.length - 1];
    dot(e2, '#ffffff', 5); dot(e2, FUSED_CSS, 3.5);
  }

  // axis labels
  ctx.fillStyle = text; ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(hName + ' →', W - padR, H - 8);
  ctx.save(); ctx.translate(13, padT + 34); ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'right'; ctx.fillText(vName + ' →', 22, 0); ctx.restore();

  // scale bar (mm)
  const len = niceLength((aw * 0.4) / s);
  const px = len * s;
  ctx.strokeStyle = muted; ctx.fillStyle = muted; ctx.lineWidth = 2; ctx.font = '11px system-ui, sans-serif';
  ctx.beginPath();
  ctx.moveTo(padL, H - 12); ctx.lineTo(padL + px, H - 12);
  ctx.moveTo(padL, H - 15); ctx.lineTo(padL, H - 9);
  ctx.moveTo(padL + px, H - 15); ctx.lineTo(padL + px, H - 9);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(len * 1000)} mm`, padL + px + 6, H - 8);
}

// ---------------------------------------------------------------- 3D view
function makeLabel(THREE, text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 96px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeText(text, 64, 68);
  g.fillStyle = color; g.fillText(text, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.renderOrder = 10;
  return sp;
}

async function create3D(container) {
  const THREE = await import('three');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

  container.textContent = '';
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  let content = null;

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function update(points, points2) {
    if (content) {
      scene.remove(content);
      content.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    }
    content = new THREE.Group();
    scene.add(content);

    // Bounds always include the origin so the axes are inside the frame.
    const b = bounds([[0, 0, 0], ...points, ...(points2 || [])]);
    const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 0.1);
    const centre = new THREE.Vector3(...[0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2));

    // grid on z = 0
    const cell = niceLength(size / 5);
    const divs = Math.max(2, Math.ceil((size * 1.6) / cell / 2) * 2);
    const grid = new THREE.GridHelper(divs * cell, divs, 0x888888, 0x555555);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(Math.round(centre.x / cell) * cell, Math.round(centre.y / cell) * cell, 0);
    content.add(grid);

    // axes with labels
    const L = size * 0.6;
    const axes = [['X', [1, 0, 0], 0xff3b3b, '#ff5555'], ['Y', [0, 1, 0], 0x2fdc4f, '#3ee85c'], ['Z', [0, 0, 1], 0x3b8bff, '#5a9dff']];
    for (const [name, d, hex, col] of axes) {
      const pos = new THREE.Vector3(...d).multiplyScalar(L);
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), pos]);
      content.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: hex })));
      const label = makeLabel(THREE, name, col);
      label.position.copy(pos.clone().multiplyScalar(1.08));
      label.scale.setScalar(size * 0.12);
      content.add(label);
    }

    // path
    const vs = points.map((p) => new THREE.Vector3(...p));
    content.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs),
      new THREE.LineBasicMaterial({ color: new THREE.Color(css('--accent')) })));

    // start / end markers and dashed start->end line
    const r = size * 0.025;
    const ball = (p, color) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color }));
      m.position.copy(p); content.add(m);
    };
    ball(vs[0], new THREE.Color(css('--start'))); ball(vs[vs.length - 1], new THREE.Color(css('--end')));
    if (points2 && points2.length) {
      const vs2 = points2.map((p) => new THREE.Vector3(...p));
      content.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(vs2),
        new THREE.LineBasicMaterial({ color: FUSED_HEX })));
      const m = new THREE.Mesh(new THREE.SphereGeometry(r * 0.75, 16, 12), new THREE.MeshBasicMaterial({ color: FUSED_HEX }));
      m.position.copy(vs2[vs2.length - 1]); content.add(m);
    }
    const dashed = new THREE.Line(new THREE.BufferGeometry().setFromPoints([vs[0], vs[vs.length - 1]]),
      new THREE.LineDashedMaterial({ color: new THREE.Color(css('--muted')), dashSize: size * 0.03, gapSize: size * 0.02 }));
    dashed.computeLineDistances();
    content.add(dashed);

    // fit camera
    const radius = Math.max(size * 0.9, 0.1);
    const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
    camera.near = dist / 1000; camera.far = dist * 100; camera.updateProjectionMatrix();
    camera.position.copy(centre).add(new THREE.Vector3(0.8, -1, 0.7).normalize().multiplyScalar(dist));
    controls.target.copy(centre);
    controls.update();
    resize();
  }

  new ResizeObserver(resize).observe(container);
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  return { update, resize };
}

// ---------------------------------------------------------------- public API
/**
 * @param {{view3d:HTMLElement, plotTop:HTMLCanvasElement, plotSide:HTMLCanvasElement, legend?:HTMLElement}} els
 * @returns {Promise<{update:(path:Array, path2?:Array|null)=>void}>} path = processRecording().path
 */
export async function createViz({ view3d, plotTop, plotSide, legend }) {
  let points = [[0, 0, 0]];
  let points2 = null;
  let v3 = null;

  const draw2D = () => {
    drawPlot(plotTop, points, points2, 0, 1, 'X', 'Y');
    drawPlot(plotSide, points, points2, 1, 2, 'Y', 'Z');
  };
  new ResizeObserver(draw2D).observe(plotTop);
  new ResizeObserver(draw2D).observe(plotSide);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw2D);

  const ready = create3D(view3d).then((v) => { v3 = v; v3.update(points, points2); }).catch((e) => {
    console.error(e);
    view3d.textContent = '3D view unavailable (could not load three.js): ' + e.message;
  });

  return {
    ready,
    update(path, path2) {
      points = path.length ? path.map((s) => s.p) : [[0, 0, 0]];
      points2 = path2 && path2.length ? path2.map((s) => s.p) : null;
      if (legend) legend.hidden = !points2;
      draw2D();
      if (v3) v3.update(points, points2);
    },
  };
}
