// Pako's figure, drawn with Three.js: the living blue orb (a sphere whose surface breathes with 3D simplex noise, lit by a fresnel rim in the
// panel's gradient, with particles in orbit), now with a face of two luminous eyes drawn in its shader. It blinks, looks at the pointer or at
// the chat box, and shows what Pako is doing (pako-figure.js): listening, thinking (an inner swirl), speaking (a pulse), happy (a bounce,
// a ring of light, the eyes in arcs), sleeping, paused (the slow red) or an error (a short shake, amber). Every change is eased in the
// uniforms, never a jump. One WebGL context: the other places of the page draw its CSS twin (figure-twin.js). It sleeps when hidden or out
// of view, caps the pixel ratio, and holds a still, friendly pose for people who ask for less motion.

import * as THREE from "./three.module.js";
import { LOOKS, approach, makeBlinker, pageFigure } from "./pako-figure.js";

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const vertex = /* glsl */ `
uniform float uTime; uniform float uAmp; uniform float uSpeed; uniform float uPulse;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
${NOISE}
void main(){
  float n = snoise(normal * 1.1 + uTime * uSpeed);
  float n2 = snoise(normal * 2.2 - uTime * uSpeed * 0.6) * 0.25;
  vNoise = n + n2;
  vec3 p = position + normal * (vNoise * uAmp + uPulse * 0.035);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

// The face is drawn on the side that looks at the camera (the view-space normal), so it stays put while the surface flows under it.
// An eye is an ellipse (open, closing as it blinks), an arc up when happy (^ ^), an arc down when asleep (u u).
const fragment = /* glsl */ `
uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform float uTime;
uniform float uOpen; uniform float uSquint; uniform float uSleep; uniform vec2 uLook; uniform float uFace;
uniform float uGlow; uniform float uSwirl; uniform float uPhase; uniform float uDim; uniform float uPulse; uniform float uShade;
varying vec3 vNormal; varying vec3 vView; varying float vNoise;
float arc(vec2 q, float r, float w, float dir){
  vec2 c = vec2(0.0, -dir * r * 0.62);
  float d = abs(length(q - c) - r) - w;
  return max(d, r * 0.42 - dir * (q.y - c.y));
}
float eye(vec2 p, vec2 c){
  vec2 q = p - c;
  float open = clamp(uOpen, 0.0, 1.4);
  vec2 rad = vec2(0.07 + 0.006 * max(open - 1.0, 0.0), max(0.115 * open, 0.016));
  float d = (length(q / rad) - 1.0) * min(rad.x, rad.y);
  d = mix(d, arc(q, 0.085, 0.017, 1.0), uSquint);
  return mix(d, arc(q, 0.075, 0.012, -1.0), uSleep);
}
void main(){
  float fres = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.4);
  float t = clamp(vNoise * 0.5 + 0.5, 0.0, 1.0);
  vec2 p = vNormal.xy;
  float front = smoothstep(0.15, 0.55, vNormal.z);
  // Where the face is the surface stays calm (no bright patch that reads as a mouth).
  float faceZone = uFace * front * smoothstep(0.8, 0.15, length(p - vec2(0.0, 0.02)));
  vec3 base = mix(uA, uB, t);
  base = mix(base, uC, smoothstep(0.55, 1.0, t) * 0.6 * (1.0 - 0.8 * faceZone));
  vec3 col = base * (0.55 + 0.45 * (1.0 - fres)) + fres * mix(uB, vec3(1.0), 0.35) * 1.4 * uGlow;
  // A soft light from the upper left: a glassy highlight.
  float spec = pow(max(dot(vNormal, normalize(vec3(-0.45, 0.6, 0.66))), 0.0), 28.0);
  col += vec3(0.85, 0.93, 1.0) * spec * 0.32 * uGlow;
  // Thinking: bands that turn inside.
  float r = length(p);
  float a = atan(p.y, p.x);
  float sw = smoothstep(0.62, 1.0, sin(a * 3.0 + r * 7.0 - uPhase * 2.6) * 0.5 + 0.5) * smoothstep(0.3, 0.68, r) * smoothstep(1.0, 0.82, r);
  col += mix(uC, vec3(1.0), 0.3) * sw * uSwirl * 0.5 * front;
  // A soft shade where the face is, so the eyes read on the bright surface.
  col = mix(col, uA * 0.55, uShade * faceZone);
  vec2 look = uLook * vec2(0.13, 0.1);
  float d = min(eye(p, vec2(-0.25, 0.1) + look), eye(p, vec2(0.25, 0.1) + look));
  float aa = fwidth(d) * 1.2 + 0.001;
  float core = 1.0 - smoothstep(-aa, aa, d);
  float halo = exp(-max(d, 0.0) * 30.0) * 0.6;
  float face = uFace * front;
  vec3 eyeCol = vec3(0.94, 0.98, 1.0);
  col = mix(col, eyeCol, core * face) + mix(uB, vec3(1.0), 0.4) * halo * face * (0.5 + 0.3 * uGlow);
  col *= uDim * (1.0 + uPulse * 0.12);
  gl_FragColor = vec4(col, clamp(0.92 + fres * 0.08, 0.0, 1.0));
}`;

// A plane behind the orb: a soft blue halo around it, and the ring of light that opens when Pako is happy.
const haloVertex = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const haloFragment = /* glsl */ `
uniform vec3 uB; uniform float uGlow; uniform float uRing; uniform float uDim; uniform float uHalf; uniform float uLight;
varying vec2 vUv;
void main(){
  float d = length(vUv - 0.5) * 2.0 * uHalf;
  float halo = exp(-max(d - 0.95, 0.0) * 3.2) * smoothstep(0.85, 1.0, d) * 0.32 * uGlow * uDim;
  float rr = mix(1.02, 1.95, uRing);
  float ring = exp(-abs(d - rr) * 22.0) * pow(1.0 - uRing, 1.4) * step(0.001, uRing) * 1.2;
  ring += exp(-abs(d - rr * 0.9) * 40.0) * pow(1.0 - uRing, 2.0) * step(0.001, uRing) * 0.5;
  vec3 col = mix(uB, vec3(1.0), 0.35 + 0.4 * ring);
  float a = clamp(halo * (1.0 - 0.45 * uLight) + ring, 0.0, 1.0) * smoothstep(1.0, 0.92, length(vUv - 0.5) * 2.0);
  gl_FragColor = vec4(col * a, a);
}`;

// Particles: most in a tilted orbit (closer when Pako listens, faster when it thinks), a few that drift away from it and fade.
const dustVertex = /* glsl */ `
attribute vec4 aOrbit; attribute float aKind;
uniform float uPhase; uniform float uGather; uniform float uTime; uniform float uSize; uniform float uDrift;
varying float vAlpha;
void main(){
  float s = aOrbit.w;
  vec3 p;
  if (aKind < 0.5) {
    float a = aOrbit.y + uPhase * (0.7 + s * 0.6);
    float r = aOrbit.x * uGather;
    p = vec3(cos(a) * r, aOrbit.z + sin(uTime * 0.7 + s * 12.0) * 0.05, sin(a) * r);
    vAlpha = 0.5 + 0.5 * sin(uTime * 1.3 + s * 30.0);
  } else {
    float life = fract(uTime * 0.06 * (0.6 + s) + s * 7.0);
    vec3 dir = normalize(vec3(cos(aOrbit.y), aOrbit.z * 2.5, sin(aOrbit.y)));
    p = dir * (1.15 + life * 1.5);
    vAlpha = sin(life * 3.14159) * 0.8 * uDrift;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (6.0 / -mv.z) * (0.6 + s * 0.8);
  gl_Position = projectionMatrix * mv;
}`;
const dustFragment = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity;
varying float vAlpha;
void main(){
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(uColor * (0.7 + a * 0.6), a * vAlpha * uOpacity);
}`;

/** Each state's three colours, made once. */
const COLORS = Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, v.colors.map((c) => new THREE.Color(c))]));

const PARAMS = ["open", "squint", "glow", "swirl", "gather", "orbit", "amp", "speed", "dim", "lean", "rest", "shade"];
/** What a state may leave out: its eyes stay open (rest 0) and the face's place darkens as usual (shade 0.3). */
const value = (look, p) => look[p] ?? ({ rest: 0, shade: 0.3 })[p];

/** Pako's old moods, kept for the callers that still say them: active is idle, busy is thinking. */
const MOOD_STATE = { active: "idle", busy: "thinking", paused: "paused" };

/**
 * Draws the figure in `canvas` and returns { setMood, render, stop }, or null without WebGL (the CSS twin shows instead).
 * opts.machine: the state machine (the page's one by default). opts.pose: a state held still (the app icon's picture). opts.orb: the orb's
 * diameter as a share of the canvas (by default the canvas's parent's width, the place the orb was given). opts.calm: the surface's waves,
 * 1 normal, less for a large still picture.
 */
export function startOrb(canvas, opts = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power", preserveDrawingBuffer: !!opts.pose });
  } catch {
    return null; // no WebGL: the CSS fallback shows instead
  }
  const machine = opts.machine ?? pageFigure();
  const still = !!opts.pose || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const light = matchMedia("(prefers-color-scheme: light)");
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.set(0, 0, 4.2);
  const group = new THREE.Group();
  scene.add(group);

  const look0 = LOOKS[opts.pose ?? machine.state] ?? LOOKS.idle;
  const cur = Object.fromEntries(PARAMS.map((k) => [k, value(look0, k)]));
  const calm = opts.calm ?? 1; // the surface's waves: less for a large still picture (the app icon)
  const colors = look0.colors.map((c) => new THREE.Color(c));
  const uniforms = {
    uTime: { value: 0 },
    uAmp: { value: cur.amp },
    uSpeed: { value: cur.speed },
    uPulse: { value: 0 },
    uA: { value: colors[0].clone() },
    uB: { value: colors[1].clone() },
    uC: { value: colors[2].clone() },
    uOpen: { value: cur.open },
    uSquint: { value: cur.squint },
    uSleep: { value: cur.rest },
    uLook: { value: new THREE.Vector2() },
    uFace: { value: still ? 1 : 0 },
    uGlow: { value: cur.glow },
    uSwirl: { value: cur.swirl },
    uPhase: { value: 0 },
    uDim: { value: cur.dim },
    uShade: { value: cur.shade },
  };
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 40),
    new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment, transparent: true }),
  );
  group.add(orb);

  const HALF = 2.6;
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2), new THREE.ShaderMaterial({
    uniforms: { uB: uniforms.uB, uGlow: uniforms.uGlow, uDim: uniforms.uDim, uRing: { value: 0 }, uHalf: { value: HALF }, uLight: { value: 0 } },
    vertexShader: haloVertex, fragmentShader: haloFragment, transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  }));
  halo.position.z = -0.6;
  group.add(halo);

  const orbiting = 300;
  const drifting = 70;
  const count = orbiting + drifting;
  const orbit = new Float32Array(count * 4);
  const kind = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const drift = i >= orbiting;
    // The ones that drift away never go toward the text at the right (within 60 degrees of +x).
    const angle = drift ? (Math.PI / 3) * (1 + Math.random() * 4) : Math.random() * Math.PI * 2;
    orbit.set([1.4 + Math.random() * 0.5, angle, (Math.random() - 0.5) * (drift ? 0.9 : 0.35), Math.random()], i * 4);
    kind[i] = drift ? 1 : 0;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  dustGeo.setAttribute("aOrbit", new THREE.BufferAttribute(orbit, 4));
  dustGeo.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
  dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
  const dustUniforms = {
    uPhase: { value: 0 }, uGather: { value: cur.gather }, uTime: uniforms.uTime, uSize: { value: 1 }, uDrift: { value: 1 },
    uColor: { value: colors[1].clone() }, uOpacity: { value: 0.85 },
  };
  const dustMat = new THREE.ShaderMaterial({ uniforms: dustUniforms, vertexShader: dustVertex, fragmentShader: dustFragment, transparent: true, depthWrite: false });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.rotation.x = 0.45;
  dust.rotation.z = -0.2;
  group.add(dust);

  // On a light page added light vanishes: the particles are drawn over it, a deeper blue.
  const scheme = () => {
    dustMat.blending = light.matches ? THREE.NormalBlending : THREE.AdditiveBlending;
    dustUniforms.uOpacity.value = light.matches ? 0.75 : 0.85;
    halo.material.uniforms.uLight.value = light.matches ? 1 : 0;
    dustMat.needsUpdate = true;
  };
  scheme();
  light.addEventListener?.("change", () => (scheme(), still && draw()));

  let fieldAt = null; // the chat box's middle, measured when it takes the focus and after a resize or a scroll
  let rect = null; // the canvas's place on the page: measured once, again only after a resize or a scroll (no layout read per frame)
  const resize = () => {
    const w = canvas.clientWidth || 120;
    const h = canvas.clientHeight || 120;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const orbPx = opts.orb ? opts.orb * h : (canvas.parentElement?.clientWidth || h) * 0.94;
    camera.position.z = h / orbPx / Math.tan((camera.fov / 2) * (Math.PI / 180));
    dustUniforms.uSize.value = Math.max(1.6, (orbPx / 88) * 2.4) * renderer.getPixelRatio();
    camera.updateProjectionMatrix();
    rect = null;
    fieldAt = null;
  };
  resize();
  new ResizeObserver(() => (resize(), still && draw())).observe(canvas);
  addEventListener("scroll", () => ((rect = null), (fieldAt = null)), { passive: true, capture: true });

  // Where the eyes go: the chat box while it has the focus, the pointer otherwise, and a small look around when nothing moves for a while.
  const gaze = { x: 0, y: 0, tx: 0, ty: 0, moved: -10, wander: 0 };
  let pointer = null;
  let field = null;
  const toward = (x, y) => {
    rect ??= canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Each side against its own room: from the top-left corner a point at the far left is as far left as the eyes can look.
    const span = (d, before, after) => Math.max(60, d < 0 ? before : after);
    const dx = x - cx;
    const dy = cy - y;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    return [clamp(dx / span(dx, cx, innerWidth - cx)), clamp(dy / span(dy, innerHeight - cy, cy))];
  };
  addEventListener("pointermove", (e) => (pointer = [e.clientX, e.clientY], (gaze.moved = clock())), { passive: true });
  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el instanceof HTMLElement && el.matches("textarea, input[type=text], input:not([type])")) (field = el), (fieldAt = null);
  });
  document.addEventListener("focusout", () => ((field = null), (fieldAt = null)));

  const blink = makeBlinker();
  const t0 = performance.now();
  const clock = () => (performance.now() - t0) / 1000;
  let last = 0;
  let moment = { kind: "", at: -10 };
  let state = opts.pose ?? machine.state;
  let enteredAt = 0;
  if (!opts.pose) {
    machine.subscribe((s) => {
      state = s;
      enteredAt = clock();
      if (s === "happy" || s === "error") moment = { kind: s, at: clock() };
      if (still) draw();
      else wake();
    });
  }

  const step = (t, dt) => {
    const look = LOOKS[state] ?? LOOKS.idle;
    const k = still ? 1e3 : 1;
    for (const p of PARAMS) cur[p] = approach(cur[p], value(look, p), 3.2 * k, dt);
    for (let i = 0; i < 3; i++) {
      const c = [uniforms.uA, uniforms.uB, uniforms.uC][i].value;
      const to = (COLORS[state] ?? COLORS.idle)[i];
      const rate = (state === "error" ? 7 : 2.4) * k; // an error is short: its amber comes at once
      c.r = approach(c.r, to.r, rate, dt);
      c.g = approach(c.g, to.g, rate, dt);
      c.b = approach(c.b, to.b, rate, dt);
    }
    dustUniforms.uColor.value.copy(uniforms.uB.value);
    if (light.matches) dustUniforms.uColor.value.multiplyScalar(0.8);
    uniforms.uTime.value = t;
    // With the face on, the outline stays a round globe (as its CSS twin): the noise lives on in the colours that flow.
    uniforms.uAmp.value = cur.amp * calm * (1 - 0.8 * uniforms.uFace.value);
    uniforms.uShade.value = cur.shade;
    uniforms.uSpeed.value = cur.speed;
    uniforms.uGlow.value = cur.glow;
    uniforms.uSwirl.value = cur.swirl;
    uniforms.uDim.value = cur.dim;
    uniforms.uSquint.value = cur.squint;
    uniforms.uSleep.value = cur.rest; // closed in calm arcs: asleep, or paused (resting, never a squint)
    uniforms.uPhase.value += dt * (0.6 + cur.swirl * 1.6);
    dustUniforms.uPhase.value += dt * cur.orbit;
    dustUniforms.uGather.value = cur.gather;
    dustUniforms.uDrift.value = approach(dustUniforms.uDrift.value, state === "sleeping" || state === "paused" ? 0.25 : 1, 1.5 * k, dt);

    // The eyes: open as the state wants, closed for a blink (never while asleep, paused or happy: those eyes are arcs already).
    const blinking = still || cur.rest > 0.5 || state === "happy" ? 1 : blink.open(t);
    uniforms.uOpen.value = cur.open * blinking;
    if (!still) uniforms.uFace.value = approach(uniforms.uFace.value, t > 0.5 ? 1 : 0, 1.6, dt);

    // The gaze: the chat box, else the pointer, else a look around now and then.
    if (still) {
      gaze.tx = 0;
      gaze.ty = 0;
    } else if (field) {
      if (!fieldAt) {
        const r = field.getBoundingClientRect();
        fieldAt = toward(r.left + r.width / 2, r.top + r.height / 2);
      }
      [gaze.tx, gaze.ty] = fieldAt;
    } else if (pointer && t - gaze.moved < 4) {
      [gaze.tx, gaze.ty] = toward(pointer[0], pointer[1]);
    } else if (t > gaze.wander) {
      gaze.wander = t + 2.5 + Math.random() * 3;
      const roam = Math.random() < 0.4;
      gaze.tx = roam ? (Math.random() - 0.5) * 1.2 : 0;
      gaze.ty = roam ? (Math.random() - 0.5) * 0.6 : 0;
    }
    gaze.x = approach(gaze.x, gaze.tx, 6 * k, dt);
    gaze.y = approach(gaze.y, gaze.ty, 6 * k, dt);
    uniforms.uLook.value.set(gaze.x * (1 - Math.abs(look.look[0])) + look.look[0], gaze.y * (1 - Math.abs(look.look[1])) + look.look[1]);

    // The body: breathing, a lean to the gaze, the speaking pulse, a happy bounce, an error's shake.
    const since = t - moment.at;
    const bounce = moment.kind === "happy" && since < 2 ? Math.sin(since * Math.PI * 2.4) * Math.exp(-since * 3.2) : 0;
    const shake = moment.kind === "error" && since < 1.2 ? Math.sin(since * 46) * Math.exp(-since * 4.5) : 0;
    const speaking = state === "speaking" ? Math.min(1, (t - enteredAt) * 3) : 0;
    const pulse = still ? 0 : speaking * (0.5 + 0.5 * Math.sin(t * 9.5)) * (0.6 + 0.4 * Math.sin(t * 2.3 + 1));
    uniforms.uPulse.value = approach(uniforms.uPulse.value, pulse, 14, dt);
    const breathe = still ? 0 : Math.sin(t * (state === "sleeping" ? 0.8 : 1.4)) * (state === "sleeping" ? 0.025 : 0.015);
    group.position.x = gaze.x * cur.lean * 0.1 + shake * 0.07;
    group.position.y = gaze.y * cur.lean * 0.07 + Math.max(0, bounce) * 0.16 + (state === "sleeping" ? -0.04 : 0);
    orb.scale.set(1 + breathe - bounce * 0.05, 1 + breathe + bounce * 0.06, 1 + breathe);
    halo.material.uniforms.uRing.value = moment.kind === "happy" && since < 1.6 ? since / 1.6 : 0;
    orb.rotation.y += dt * cur.orbit * 1.2;
    orb.rotation.x = approach(orb.rotation.x, -gaze.y * 0.25, 3, dt);
    orb.rotation.z = approach(orb.rotation.z, -gaze.x * 0.15, 3, dt);
  };

  const draw = () => {
    const t = clock();
    step(t, still ? 1 : Math.min(0.1, t - last));
    last = t;
    renderer.render(scene, camera);
  };

  // One loop at most; it runs while the page is shown, the canvas in view and not covered: by the chat, full screen on a phone, or by a
  // modal dialog (Settings, the welcome) that blurs over it.
  let raf = 0;
  let shown = !document.hidden;
  let inView = true;
  let covered = false;
  const phone = matchMedia("(max-width: 640px)");
  const isCovered = () => {
    if (opts.pose) return false;
    if (phone.matches && document.body.classList.contains("chat-open")) return true;
    try {
      return !!document.querySelector("dialog:modal");
    } catch {
      return !!document.querySelector("dialog[open][aria-modal=true]");
    }
  };
  const frame = () => {
    raf = 0;
    if (!shown || !inView || covered) return;
    draw();
    raf = requestAnimationFrame(frame);
  };
  const wake = () => {
    if (still || raf || !shown || !inView || covered) return;
    last = clock();
    raf = requestAnimationFrame(frame);
  };
  const sleep = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  draw(); // one frame at once: the orb shows even before the first animation frame (or with none, in a hidden tab)
  if (!still) {
    wake();
    document.addEventListener("visibilitychange", () => ((shown = !document.hidden), shown ? wake() : sleep()));
    new IntersectionObserver(([e]) => ((inView = !!e?.isIntersecting), inView ? wake() : sleep())).observe(canvas);
    const recheck = () => {
      covered = isCovered();
      if (covered) sleep();
      else wake();
    };
    const watch = new MutationObserver(recheck);
    watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    for (const dlg of document.querySelectorAll("dialog")) watch.observe(dlg, { attributes: true, attributeFilter: ["open"] });
    phone.addEventListener?.("change", recheck);
    recheck();
  }

  return {
    /** The old moods (active, busy, paused), said as the page's events. */
    setMood(name) {
      machine.send("paused", { on: MOOD_STATE[name] === "paused" });
    },
    render: draw,
    stop() {
      sleep();
      renderer.dispose();
    },
  };
}
