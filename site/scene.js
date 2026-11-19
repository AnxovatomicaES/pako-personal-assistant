// Pako's site · the one WebGL scene behind the page: Pako's figure (a living orb with two eyes that follow you), a swirl of particles, stars
// and a nebula, with bloom. The page moves it with setLayout (where the figure sits), setMood (what it feels) and pulse (a happy burst).

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/** The figure's moods, as in the app (src/panel/pako-figure.js): three colours, how much it moves, how open its eyes are. */
const MOODS = {
  idle:      { colors: ["#5b46ff", "#29c4ff", "#4ff2b0"], amp: 0.036, speed: 0.28, open: 1, squint: 0, swirl: 0.25, glow: 1 },
  listening: { colors: ["#4a4bff", "#36d2ff", "#7ff7d0"], amp: 0.032, speed: 0.34, open: 1.15, squint: 0, swirl: 0.45, glow: 1.2 },
  thinking:  { colors: ["#3f36ff", "#5aa8ff", "#a98bff"], amp: 0.05, speed: 0.55, open: 0.9, squint: 0, swirl: 1.1, glow: 1.15 },
  speaking:  { colors: ["#5246ff", "#2fc8ff", "#6ff5c4"], amp: 0.042, speed: 0.45, open: 1, squint: 0.15, swirl: 0.55, glow: 1.3 },
  happy:     { colors: ["#5b46ff", "#39d0ff", "#8dffc9"], amp: 0.042, speed: 0.42, open: 1, squint: 1, swirl: 0.8, glow: 1.5 },
  sleeping:  { colors: ["#3036a8", "#4a86e8", "#6aa0f0"], amp: 0.017, speed: 0.1, open: 0, squint: 0, swirl: 0.08, glow: 0.75 },
  paused:    { colors: ["#c45b7a", "#ff9db0", "#ffd0b8"], amp: 0.013, speed: 0.12, open: 0.7, squint: 0, swirl: 0.05, glow: 0.8 },
};

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
`;

export function createScene(canvas, o = {}) {
  // manual: a video renderer drives time itself (step), and the same seed gives the same stars, swirl and blinks in every frame.
  let seed = 0x9e3779b9;
  const rand = o.manual ? () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) : Math.random;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  const reduced = o.reduced === true;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, small ? 1.5 : 1.75));
  renderer.setClearColor(0x06070d, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x06070d, 0.035);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 0, 9);

  const uni = {
    uTime: { value: 0 },
    uAmp: { value: MOODS.idle.amp },
    uSwirl: { value: MOODS.idle.swirl },
    uGlow: { value: 1 },
    uC1: { value: new THREE.Color(MOODS.idle.colors[0]) },
    uC2: { value: new THREE.Color(MOODS.idle.colors[1]) },
    uC3: { value: new THREE.Color(MOODS.idle.colors[2]) },
    uPulse: { value: 0 },
  };

  // ---------- the nebula: a big sphere seen from inside, with slow coloured clouds ----------
  const nebula = new THREE.Mesh(
    new THREE.SphereGeometry(80, 48, 48),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTime: uni.uTime, uScroll: { value: 0 } },
      vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `${NOISE}
        uniform float uTime; uniform float uScroll; varying vec3 vP;
        void main(){
          vec3 p = vP * 1.6 + vec3(0., uScroll * .6, uTime * .015);
          float n = snoise(p) * .5 + snoise(p * 2.3 + 4.) * .25 + snoise(p * 5.1) * .12;
          float m = smoothstep(.05, .85, n + .25);
          vec3 a = vec3(.36,.27,1.) * .22; vec3 b = vec3(.16,.77,1.) * .14; vec3 c = vec3(.31,.95,.69) * .07;
          vec3 col = mix(a, b, smoothstep(-.4,.6,vP.y + n*.6)); col = mix(col, c, smoothstep(.4,.9,n));
          gl_FragColor = vec4(col * m * .55 + vec3(.008,.009,.02), 1.);
        }`,
    }),
  );
  scene.add(nebula);

  // ---------- stars ----------
  const starCount = small ? 1400 : 3200;
  const starGeo = new THREE.BufferGeometry();
  const sp = new Float32Array(starCount * 3);
  const ss = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const r = 18 + rand() * 50;
    const th = rand() * Math.PI * 2;
    const ph = Math.acos(2 * rand() - 1);
    sp.set([r * Math.sin(ph) * Math.cos(th), r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph) - 10], i * 3);
    ss[i] = rand();
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute("aSeed", new THREE.BufferAttribute(ss, 1));
  const stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime: uni.uTime, uPx: { value: renderer.getPixelRatio() } },
    vertexShader: `attribute float aSeed; uniform float uTime; uniform float uPx; varying float vA;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); gl_Position = projectionMatrix * mv;
        vA = .35 + .65 * (.5 + .5 * sin(uTime * (1. + aSeed * 3.) + aSeed * 40.));
        gl_PointSize = (1. + aSeed * 2.2) * uPx * (30. / -mv.z); }`,
    fragmentShader: `varying float vA; void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d);
      gl_FragColor = vec4(vec3(.8,.88,1.), a * vA); }`,
  }));
  scene.add(stars);

  // ---------- Pako's figure ----------
  const figure = new THREE.Group();
  const holder = new THREE.Group(); // where the page puts it
  holder.add(figure);
  scene.add(holder);

  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.25, small ? 48 : 96),
    new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: `${NOISE}
        uniform float uTime; uniform float uAmp; uniform float uSwirl; uniform float uPulse;
        varying vec3 vN; varying vec3 vView; varying float vNoise; varying vec3 vPos;
        void main(){
          vec3 p = position;
          float n = snoise(p * .85 + vec3(uTime * .3, uTime * .2 * (1. + uSwirl), 0.));
          n += .3 * snoise(p * 1.9 - uTime * .35);
          vNoise = n;
          // The face (front, z+) stays smooth so the eyes sit well.
          float face = smoothstep(.2, .95, normalize(p).z);
          p += normal * n * uAmp * (1. - face * .92) + normal * uPulse * .14;
          vPos = p;
          vec4 mv = modelViewMatrix * vec4(p, 1.);
          vView = -mv.xyz; vN = normalMatrix * normal;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform float uGlow; uniform float uTime; uniform float uSwirl;
        varying vec3 vN; varying vec3 vView; varying float vNoise; varying vec3 vPos;
        void main(){
          vec3 n = normalize(vN); vec3 v = normalize(vView);
          float fres = pow(1. - max(dot(n, v), 0.), 2.4);
          float t = clamp(.5 + .5 * sin(vPos.y * 1.6 + vNoise * 1.8 + uTime * (.4 + uSwirl * .6)), 0., 1.);
          vec3 col = mix(uC1, uC2, t);
          col = mix(col, uC3, smoothstep(.6, 1., vNoise * .5 + .5) * .45);
          // Light from above left, a soft core, a bright rim.
          float light = .35 + .65 * max(dot(n, normalize(vec3(-.4,.7,.6))), 0.);
          col = mix(col * .55, col, light); light = 1.;
          col *= light;
          col += fres * mix(uC2, vec3(.8,.92,1.), .15) * .7 * uGlow;
          gl_FragColor = vec4(col * (.5 + .18 * uGlow), 1.);
        }`,
    }),
  );
  figure.add(body);

  // The eyes: two soft capsules on the face, that open, squint, blink and look at you.
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.85, 2.0), toneMapped: false });
  const eyeGeo = new THREE.CapsuleGeometry(0.085, 0.24, 8, 16);
  const eyes = [new THREE.Mesh(eyeGeo, eyeMat), new THREE.Mesh(eyeGeo, eyeMat)];
  const face = new THREE.Group();
  eyes[0].position.set(-0.3, 0.14, 0);
  eyes[1].position.set(0.3, 0.14, 0);
  face.add(eyes[0], eyes[1]);
  face.position.z = 1.3;
  figure.add(face);

  // A halo behind: a soft gradient sprite.
  const haloTex = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    r.addColorStop(0, "rgba(120,160,255,0.32)");
    r.addColorStop(0.35, "rgba(91,70,255,0.14)");
    r.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.set(7, 7, 1);
  halo.position.z = -0.6;
  figure.add(halo);

  // Rings: two thin orbits, tilted.
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
  const rings = [1.95, 2.45].map((r, i) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.006, 6, 220), ringMat);
    m.rotation.set(1.2 + i * 0.25, 0.3 - i * 0.5, 0);
    figure.add(m);
    return m;
  });

  // The swirl: particles around the figure, in a disc, turning.
  const swirlCount = small ? 900 : 2200;
  const swGeo = new THREE.BufferGeometry();
  const swP = new Float32Array(swirlCount * 3);
  const swS = new Float32Array(swirlCount * 3); // radius, angle, seed
  for (let i = 0; i < swirlCount; i++) {
    const r = 1.6 + Math.pow(rand(), 1.6) * 3.2;
    swS.set([r, rand() * Math.PI * 2, rand()], i * 3);
  }
  swGeo.setAttribute("position", new THREE.BufferAttribute(swP, 3));
  swGeo.setAttribute("aS", new THREE.BufferAttribute(swS, 3));
  const swirl = new THREE.Points(swGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: uni.uTime, uSwirl: uni.uSwirl, uC2: uni.uC2, uC3: uni.uC3, uPx: { value: renderer.getPixelRatio() }, uPulse: uni.uPulse },
    vertexShader: `attribute vec3 aS; uniform float uTime; uniform float uSwirl; uniform float uPx; uniform float uPulse; varying float vS; varying float vR;
      void main(){
        float r = aS.x * (1. + uPulse * .5); float a = aS.y + uTime * (.08 + uSwirl * .25) / (r * .5);
        float y = sin(a * 3. + aS.z * 20. + uTime * .5) * .12 * r + (aS.z - .5) * .5;
        vec3 p = vec3(cos(a) * r, y, sin(a) * r);
        // Tilt the disc towards the viewer.
        p = vec3(p.x, p.y * .9 + p.z * .35, p.z * .9 - p.y * .35);
        vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv;
        vS = aS.z; vR = r;
        gl_PointSize = (1.2 + aS.z * 2.4) * uPx * (9. / -mv.z);
      }`,
    fragmentShader: `uniform vec3 uC2; uniform vec3 uC3; varying float vS; varying float vR;
      void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d);
        vec3 col = mix(uC2, uC3, vS); gl_FragColor = vec4(col * 1.1, a * (.25 + .45 * vS) * smoothstep(5., 2., vR)); }`,
  }));
  figure.add(swirl);

  // A burst ring for happy moments.
  const burst = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.36, 128), new THREE.MeshBasicMaterial({ color: 0x8dffc9, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  figure.add(burst);

  // ---------- post: bloom ----------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), small ? 0.45 : 0.55, 0.5, 0.55);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------- state ----------
  const target = { x: 2.1, y: 0, s: 1, mood: "listening", opacity: 1 };
  const cur = { x: 2.1, y: 0, s: 1 };
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  let scroll = 0;
  let pulse = 0;
  let burstT = 1;
  let nextBlink = 2.5;
  let blinkT = 1;
  let open = 1;
  let squint = 0;
  let running = true;
  const clock = new THREE.Clock();

  const resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w, h);
    camera.aspect = w / h;
    // Keep the figure a good size on a narrow screen.
    camera.fov = w < 700 ? 58 : 42;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) clock.getDelta();
  });

  const tmp = new THREE.Color();
  const update = (dt) => {
    const m = MOODS[target.mood] ?? MOODS.idle;
    uni.uTime.value += dt * (reduced ? 0.3 : 1) * (0.6 + m.speed * 1.4);
    const k = 1 - Math.pow(0.0015, dt); // smooth follow
    uni.uAmp.value += (m.amp - uni.uAmp.value) * k;
    uni.uSwirl.value += (m.swirl - uni.uSwirl.value) * k;
    uni.uGlow.value += (m.glow - uni.uGlow.value) * k;
    uni.uC1.value.lerp(tmp.set(m.colors[0]), k);
    uni.uC2.value.lerp(tmp.set(m.colors[1]), k);
    uni.uC3.value.lerp(tmp.set(m.colors[2]), k);

    // Where it sits, and how big.
    cur.x += (target.x - cur.x) * k * 0.9;
    cur.y += (target.y - cur.y) * k * 0.9;
    cur.s += (target.s - cur.s) * k * 0.9;
    holder.position.set(cur.x, cur.y + Math.sin(uni.uTime.value * 0.9) * 0.08, 0);
    holder.scale.setScalar(cur.s * (1 + pulse * 0.08));

    // It looks at you, and leans a little.
    pointer.sx += (pointer.x - pointer.sx) * k;
    pointer.sy += (pointer.y - pointer.sy) * k;
    figure.rotation.y = pointer.sx * 0.35 - cur.x * 0.06;
    figure.rotation.x = -pointer.sy * 0.22;
    face.position.x = pointer.sx * 0.1;
    face.position.y = pointer.sy * 0.08;

    // Eyes: open, squint (a happy smile), blink.
    open += (m.open - open) * k;
    squint += (m.squint - squint) * k;
    nextBlink -= dt;
    if (nextBlink <= 0 && m.open > 0) {
      blinkT = 0;
      nextBlink = 2.2 + rand() * 3.5;
    }
    blinkT = Math.min(1, blinkT + dt * 7);
    const blink = blinkT < 1 ? Math.abs(Math.cos(blinkT * Math.PI)) : 1;
    const sy = Math.max(0.06, open * blink * (1 - squint * 0.62));
    for (const e of eyes) {
      e.scale.set(1 + squint * 0.25, sy, 1);
      e.rotation.z = 0;
    }
    eyes[0].rotation.z = squint * 0.35;
    eyes[1].rotation.z = -squint * 0.35;

    rings[0].rotation.z += dt * (0.1 + m.swirl * 0.2);
    rings[1].rotation.z -= dt * (0.07 + m.swirl * 0.15);
    stars.rotation.y += dt * 0.006;
    nebula.material.uniforms.uScroll.value = scroll;

    // Happy pulse and its ring.
    pulse += (0 - pulse) * k * 0.6;
    uni.uPulse.value = pulse;
    burstT = Math.min(1, burstT + dt * 0.9);
    burst.scale.setScalar(1 + burstT * 2.4);
    burst.material.opacity = (1 - burstT) * 0.8;

    // The camera floats with the pointer and the scroll.
    camera.position.x += (pointer.sx * 0.35 - camera.position.x) * k * 0.5;
    camera.position.y += (pointer.sy * 0.25 - scroll * 1.2 - camera.position.y) * k * 0.5;
    camera.lookAt(0, -scroll * 1.2, 0);
    holder.position.y += -scroll * 1.2;

  };
  const frame = () => {
    requestAnimationFrame(frame);
    if (!running) return;
    update(Math.min(clock.getDelta(), 0.05));
    composer.render();
  };
  if (!o.manual) requestAnimationFrame(frame);

  return {
    /** Where the figure sits (scene units: x across, y up) and its size. */
    setLayout: (x, y, s, snap = false) => {
      Object.assign(target, { x, y, s });
      // snap: be there at once (a still picture), instead of gliding there.
      if (snap) Object.assign(cur, { x, y, s });
    },
    setMood: (mood) => void (MOODS[mood] && (target.mood = mood)),
    /** 0 at the top of the page, 1 at the bottom. */
    setScroll: (p) => void (scroll = p),
    pulse: () => {
      pulse = 1;
      burstT = 0;
    },
    /** Manual mode: advance exactly dt seconds, then draw (or just advance, with draw false). */
    step: (dt, draw = true) => {
      update(dt);
      if (draw) composer.render();
    },
    get mood() {
      return target.mood;
    },
  };
}
