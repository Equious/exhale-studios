/*
 * The smoke.
 *
 * This is a small simulation of actual smoke, not an animated texture.
 *
 *   air      a grid of wind. It is pushed by the pointer, by the smoke's own
 *            warmth (it rises), and by a slow draught through the room.
 *   smoke    how much smoke hangs at each point. The air carries it along.
 *            It thins out where the page has something to read and gathers at
 *            the edges, in the gaps between rooms, and into a wall when you
 *            walk from one place to another.
 *
 * Nothing here remembers where the smoke "should" be and pulls it back.
 * Disturbed smoke stays disturbed until the air settles and more drifts in.
 *
 * Where a device can't run the simulation the same shapes are drawn without
 * it: the smoke still hangs and still closes into a wall, it just can't be
 * stirred.
 */
(function () {
  'use strict';

  /* ---------- shared pieces ---------- */

  var NOISE = [
    'float hash(vec2 p){',
    '  p = fract(p*vec2(0.1031,0.1030));',
    '  p += dot(p, p.yx+33.33);',
    '  return fract((p.x+p.y)*p.y);',
    '}',
    'float vnoise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);',
    '  return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), u.x),',
    '             mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), u.x), u.y);',
    '}',
    'const mat2 ROT = mat2(0.8,-0.6,0.6,0.8);',
    'float fbm3(vec2 p){',
    '  float a = 0.5, s = 0.0;',
    '  for(int i=0;i<3;i++){ s += a*vnoise(p); p = ROT*p*2.03+vec2(17.1,3.7); a *= 0.5; }',
    '  return s/0.875;',
    '}',
    'float fbm5(vec2 p){',
    '  float a = 0.5, s = 0.0;',
    '  for(int i=0;i<5;i++){ s += a*vnoise(p); p = ROT*p*2.03+vec2(17.1,3.7); a *= 0.5; }',
    '  return s/0.96875;',
    '}'
  ].join('\n');

  // Where smoke gathers when left alone. It belongs to the page, not the
  // screen: scrolling carries it along with the content (uScroll), and walking
  // (uTravel) grows it toward you until it passes and new smoke forms beyond.
  var TARGET = [
    'uniform float uAspect, uTime, uScroll, uTravel, uWall, uColumn, uVeil;',
    'uniform vec4 uSeams;',
    'const float REST = 1.2911;',
    'float haze(vec2 sp){',
    '  float n = 0.0;',
    '  for (int k=0;k<2;k++){',
    '    float ph = uTravel + float(k)*0.5;',
    '    float s = fract(ph);',
    '    float w = sin(3.14159265*s); w *= w;',
    '    vec2 p = sp*2.6*exp(-1.4*s) + vec2(0.0, -uScroll*REST);',
    '    p += floor(ph)*vec2(7.13,3.71) + float(k)*vec2(31.7,17.3) + vec2(uTime*0.006, -uTime*0.004);',
    '    n += w*fbm5(p);',
    '  }',
    '  return n;',
    '}',
    'float target(vec2 uv){',
    '  vec2 sp = vec2((uv.x-0.5)*uAspect, uv.y-0.5);',
    '  float n = haze(sp);',
    '  float body = smoothstep(0.30, 0.76, n);',
    // Thin over the column of content, full at the margins...
    '  float edge = smoothstep(uColumn*0.72, uColumn*1.1 + 0.14, abs(sp.x));',
    // ...and banked up in the gap between one room and the next.
    '  vec4 sd = (vec4(uv.y) - uSeams)/0.10;',
    '  vec4 se = exp(-sd*sd);',
    '  float seam = max(max(se.x, se.y), max(se.z, se.w));',
    '  float where = max(uVeil, max(edge, seam*0.62));',
    '  return body*where*(1.0 - 0.6*uWall) + uWall*(0.55 + 3.1*smoothstep(0.26, 0.74, n));',
    '}'
  ].join('\n');

  /* ---------- shaders: the air ---------- */

  var SIM_VERT = [
    'precision highp float;',
    'attribute vec2 aPos;',
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform vec2 uTexel;',
    'void main(){',
    '  vUv = aPos*0.5+0.5;',
    '  vL = vUv - vec2(uTexel.x, 0.0); vR = vUv + vec2(uTexel.x, 0.0);',
    '  vT = vUv + vec2(0.0, uTexel.y); vB = vUv - vec2(0.0, uTexel.y);',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var HEAD = 'precision highp float;\nvarying vec2 vUv, vL, vR, vT, vB;\n';

  // Push the air along the pointer's latest stroke.
  var SPLAT = HEAD + [
    'uniform sampler2D uTarget;',
    'uniform vec2 uA, uB, uForce;',
    'uniform float uAspect, uRadius;',
    'void main(){',
    '  vec2 asp = vec2(uAspect, 1.0);',
    '  vec2 pa = (vUv-uA)*asp, ba = (uB-uA)*asp;',
    '  float h = clamp(dot(pa,ba)/max(dot(ba,ba),1e-7), 0.0, 1.0);',
    '  vec2 d = pa - ba*h;',
    '  float s = exp(-dot(d,d)/uRadius);',
    '  gl_FragColor = vec4(texture2D(uTarget, vUv).xy + uForce*s, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Warm smoke rises, and a slow draught wanders through the room.
  var FORCE = HEAD + NOISE + '\n' + [
    'uniform sampler2D uVelocity, uSmoke;',
    'uniform float uDt, uBuoy, uWind, uAspect, uTime, uScroll;',
    'float psi(vec2 p){ return fbm3(p*1.15 + vec2(uTime*0.021, -uTime*0.017)); }',
    'void main(){',
    '  vec2 v = texture2D(uVelocity, vUv).xy;',
    '  float d = texture2D(uSmoke, vUv).x;',
    '  v.y += uBuoy*min(d, 1.2)*uDt;',
    '  vec2 sp = vec2((vUv.x-0.5)*uAspect, vUv.y-0.5 - uScroll);',
    '  float e = 0.03;',
    '  vec2 w = vec2(psi(sp+vec2(0.0,e)) - psi(sp-vec2(0.0,e)), psi(sp-vec2(e,0.0)) - psi(sp+vec2(e,0.0)))/(2.0*e);',
    '  v += w*uWind*uDt;',
    '  gl_FragColor = vec4(v, 0.0, 1.0);',
    '}'
  ].join('\n');

  // The air carries itself along. Scrolling and walking move it with the page.
  var ADVECT = HEAD + [
    'uniform sampler2D uVelocity, uSource;',
    'uniform vec2 uTexel;',
    'uniform float uDt, uKeep, uShift, uZoom;',
    'void main(){',
    '  vec2 c = vUv - uDt*texture2D(uVelocity, vUv).xy*uTexel;',
    '  c = 0.5 + (c - 0.5)*uZoom;',
    '  c.y -= uShift;',
    '  vec2 v = texture2D(uSource, c).xy*uKeep;',
    '  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) v = vec2(0.0);',
    '  gl_FragColor = vec4(v, 0.0, 1.0);',
    '}'
  ].join('\n');

  var CURL = HEAD + [
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).y, R = texture2D(uVelocity, vR).y;',
    '  float T = texture2D(uVelocity, vT).x, B = texture2D(uVelocity, vB).x;',
    '  gl_FragColor = vec4(0.5*(R - L - T + B), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  // Vorticity confinement: feeds small whirls so they survive the coarse grid.
  var VORTICITY = HEAD + [
    'uniform sampler2D uVelocity, uCurl;',
    'uniform float uDt, uStrength;',
    'void main(){',
    '  float L = texture2D(uCurl, vL).x, R = texture2D(uCurl, vR).x;',
    '  float T = texture2D(uCurl, vT).x, B = texture2D(uCurl, vB).x;',
    '  float C = texture2D(uCurl, vUv).x;',
    '  vec2 f = 0.5*vec2(abs(T) - abs(B), abs(R) - abs(L));',
    '  f /= length(f) + 0.0001;',
    '  f *= uStrength*C;',
    '  f.y *= -1.0;',
    '  vec2 v = texture2D(uVelocity, vUv).xy + f*uDt;',
    '  gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);',
    '}'
  ].join('\n');

  var DIVERGENCE = HEAD + [
    'uniform sampler2D uVelocity;',
    'void main(){',
    '  float L = texture2D(uVelocity, vL).x, R = texture2D(uVelocity, vR).x;',
    '  float T = texture2D(uVelocity, vT).y, B = texture2D(uVelocity, vB).y;',
    '  vec2 C = texture2D(uVelocity, vUv).xy;',
    '  if (vL.x < 0.0) L = -C.x;',
    '  if (vR.x > 1.0) R = -C.x;',
    '  if (vT.y > 1.0) T = -C.y;',
    '  if (vB.y < 0.0) B = -C.y;',
    '  gl_FragColor = vec4(0.5*(R - L + T - B), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var PRESSURE = HEAD + [
    'uniform sampler2D uPressure, uDivergence;',
    'uniform float uScale;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;',
    '  float div = texture2D(uDivergence, vUv).x;',
    '  gl_FragColor = vec4((L + R + B + T)*uScale - div*0.25, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var GRADIENT = HEAD + [
    'uniform sampler2D uPressure, uVelocity;',
    'void main(){',
    '  float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;',
    '  gl_FragColor = vec4(texture2D(uVelocity, vUv).xy - vec2(R - L, T - B), 0.0, 1.0);',
    '}'
  ].join('\n');

  // The smoke itself: carried by the air, slowly topped up toward where it
  // gathers, and fed by anything that is giving it off.
  var SMOKE = HEAD + NOISE + '\n' + TARGET + '\n' + [
    'uniform sampler2D uVelocity, uSource;',
    'uniform vec2 uVelTexel;',
    'uniform float uDt, uRelax, uFall, uShift, uZoom, uInit;',
    'uniform vec3 uEmit[6];',
    'void main(){',
    '  float tgt = target(vUv);',
    '  vec2 c = vUv - uDt*texture2D(uVelocity, vUv).xy*uVelTexel;',
    '  c = 0.5 + (c - 0.5)*uZoom;',
    '  c.y -= uShift;',
    '  float d = tgt;',
    '  if (uInit < 0.5 && c.x > 0.0 && c.x < 1.0 && c.y > 0.0 && c.y < 1.0) {',
    '    d = texture2D(uSource, c).x;',
    // Smoke that has strayed over something worth reading thins out faster
    // than it gathers.
    '    d += (tgt - d)*(d > tgt ? uFall : uRelax);',
    '  }',
    '  for (int i=0;i<6;i++){',
    '    vec2 e = (vUv - uEmit[i].xy)*vec2(uAspect, 1.0);',
    '    d += uEmit[i].z*uDt*exp(-dot(e,e)/0.0008);',
    '  }',
    '  gl_FragColor = vec4(min(d, 4.0), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* ---------- shader: what you see ---------- */

  var VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }'
  ].join('\n');

  function viewFrag(simulated, precision) {
    return [
      'precision ' + precision + ' float;',
      'varying vec2 vUv;',
      NOISE,
      TARGET,
      simulated ? 'uniform sampler2D uSmoke;\n#define DENS(uv) texture2D(uSmoke, uv).x' : '#define DENS(uv) target(uv)',
      'uniform float uFade, uPing, uPingT, uTintAmt;',
      'uniform vec2 uPingAt;',
      'uniform vec3 uTint;',
      'uniform vec3 uLampPos[4];',
      'uniform vec3 uLampCol[4];',

      // Smoke far off behind everything: dim, slow, and it slides past more
      // slowly than the page when you scroll.
      'float farHaze(vec2 sp){',
      '  float n = 0.0;',
      '  for (int k=0;k<2;k++){',
      '    float ph = uTravel*0.5 + 0.25 + float(k)*0.5;',
      '    float s = fract(ph);',
      '    float w = sin(3.14159265*s); w *= w;',
      '    vec2 p = sp*2.0*exp(-1.4*s) + vec2(0.0, -uScroll*0.5);',
      '    p += floor(ph)*vec2(5.3,9.1) + float(k)*vec2(11.9,23.1) + vec2(-uTime*0.008, uTime*0.005);',
      '    n += w*fbm3(p);',
      '  }',
      '  return n;',
      '}',

      'vec3 shade(float l){',
      '  vec3 glow = mix(uTint*uTint, uTint, l)*l*1.25 + mix(uTint, vec3(1.0), 0.55)*l*l*l*0.5;',
      '  return mix(vec3(l), glow, uTintAmt);',
      '}',

      'void main(){',
      '  vec2 sp = vec2((vUv.x-0.5)*uAspect, vUv.y-0.5);',
      '  float d = DENS(vUv);',
      // How much smoke lies between this point and the light above it.
      '  float dU = DENS(vUv + vec2(0.0, 0.06));',
      '  float a = 1.0 - exp(-d*1.35);',
      '  float lum = 0.86*mix(1.0, 0.8, smoothstep(0.1, 2.4, dU))*(0.78 + 0.44*smoothstep(-0.7, 0.7, d - dU));',
      '  float fa = smoothstep(0.40, 0.92, farHaze(sp))*0.24;',

      // Light spilling from the doors in the front hall.
      '  vec3 lamp = vec3(0.0);',
      '  for (int i=0;i<4;i++){',
      '    vec2 dl = (vUv - uLampPos[i].xy)*vec2(uAspect, 1.0);',
      '    float r = uLampPos[i].z;',
      '    lamp += uLampCol[i]*exp(-dot(dl,dl)/(r*r + 0.00001));',
      '  }',

      '  float lit = clamp(dot(lamp, vec3(0.45)), 0.0, 1.0);',
      '  vec3 near = shade(lum)*(1.0 - 0.85*lit) + lamp*lum*1.2;',
      '  vec3 far = shade(0.34)*(1.0 - 0.6*lit) + lamp*0.4;',
      '  vec3 rgb = near*a + (1.0 - a)*far*fa;',
      '  float alpha = a + (1.0 - a)*fa;',

      // A sonar pulse travelling through the smoke.
      '  vec2 pv = (vUv - uPingAt)*vec2(uAspect, 1.0);',
      '  float ring = exp(-pow((length(pv) - uPingT*1.25)*16.0, 2.0))*(1.0 - uPingT);',
      '  rgb += uPing*ring*uTint*(0.05 + 0.6*alpha);',

      '  rgb += (hash(gl_FragCoord.xy + fract(uTime)*61.0) - 0.5)/160.0*alpha;',
      '  gl_FragColor = vec4(rgb, alpha)*uFade;',
      '}'
    ].join('\n');
  }

  /* ---------- plumbing ---------- */

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log);
    }
    return s;
  }

  function program(gl, vert, frag) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      u[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name);
    }
    return { p: p, u: u };
  }

  function createSmoke(canvas) {
    var gl = null;
    try {
      var opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' };
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch (err) { gl = null; }
    if (!gl) return null;

    var small = Math.min(window.innerWidth, window.innerHeight) < 600;
    var hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    var precision = hp && hp.precision > 0 ? 'highp' : 'mediump';

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    /* The simulation needs float textures it can draw into. */
    var air = null;
    (function () {
      var hf = gl.getExtension('OES_texture_half_float');
      var lin = gl.getExtension('OES_texture_half_float_linear');
      gl.getExtension('EXT_color_buffer_half_float');
      if (!hf || !lin || precision !== 'highp') return;
      var TYPE = hf.HALF_FLOAT_OES;

      function target(w, h) {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, TYPE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        var fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return ok ? { tex: tex, fb: fb, w: w, h: h } : null;
      }
      function pair(w, h) {
        var a = target(w, h), b = target(w, h);
        if (!a || !b) return null;
        return { read: a, write: b, swap: function () { var t = this.read; this.read = this.write; this.write = t; } };
      }

      var progs;
      try {
        progs = {
          splat: program(gl, SIM_VERT, SPLAT),
          force: program(gl, SIM_VERT, FORCE),
          advect: program(gl, SIM_VERT, ADVECT),
          curl: program(gl, SIM_VERT, CURL),
          vorticity: program(gl, SIM_VERT, VORTICITY),
          divergence: program(gl, SIM_VERT, DIVERGENCE),
          pressure: program(gl, SIM_VERT, PRESSURE),
          gradient: program(gl, SIM_VERT, GRADIENT),
          smoke: program(gl, SIM_VERT, SMOKE)
        };
      } catch (err) {
        if (window.console) console.warn('Smoke simulation failed to build:', err.message);
        return;
      }
      air = { progs: progs, w: 0, h: 0, sw: 0, sh: 0, pair: pair, target: target, fresh: true };
    })();

    var view;
    try {
      view = program(gl, VERT, viewFrag(!!air, precision));
    } catch (err) {
      if (window.console) console.warn('Smoke shader failed to build:', err.message);
      return null;
    }

    function grid(long, cw, ch) {
      return cw >= ch
        ? [long, Math.max(32, Math.round(long * ch / cw))]
        : [Math.max(32, Math.round(long * cw / ch)), long];
    }

    function sizeAir(cw, ch) {
      if (!air) return;
      var a = grid(small ? 128 : 192, cw, ch);
      var s = grid(small ? 384 : 576, cw, ch);
      if (a[0] === air.w && a[1] === air.h && s[0] === air.sw && s[1] === air.sh) return;
      air.w = a[0]; air.h = a[1]; air.sw = s[0]; air.sh = s[1];
      air.velocity = air.pair(air.w, air.h);
      air.pressure = air.pair(air.w, air.h);
      air.curl = air.target(air.w, air.h);
      air.divergence = air.target(air.w, air.h);
      air.smoke = air.pair(air.sw, air.sh);
      air.fresh = true;
      if (!air.velocity || !air.pressure || !air.curl || !air.divergence || !air.smoke) air = null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    var scale = small ? 0.5 : 0.6;
    var w = 1, h = 1, cssW = 1, cssH = 1, simW = 0, simH = 0;
    var ptr = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, seen: false };
    var slow = 0, frames = 0;

    function resize() {
      cssW = canvas.clientWidth || window.innerWidth;
      cssH = canvas.clientHeight || window.innerHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = Math.max(2, Math.round(cssW * dpr * scale));
      h = Math.max(2, Math.round(cssH * dpr * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      // A phone's address bar sliding away changes the height a little, over
      // and over. That is no reason to throw the smoke away and start again.
      if (cssW !== simW || Math.abs(cssH - simH) > 160) {
        simW = cssW; simH = cssH;
        sizeAir(cssW, cssH);
      }
    }

    // x and y are client pixels.
    function pointer(x, y) {
      var nx = x / cssW, ny = 1 - y / cssH;
      if (!ptr.seen) { ptr.px = nx; ptr.py = ny; ptr.seen = true; }
      ptr.x = nx; ptr.y = ny;
    }
    // A finger lifting and landing somewhere else is not a stroke.
    function pointerLift() { ptr.seen = false; }

    function pass(dest) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fb);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    function bind(unit, tex, loc) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    }

    // Everything the "where smoke gathers" function needs.
    function setTarget(pr, s) {
      gl.uniform1f(pr.u.uAspect, cssW / cssH);
      gl.uniform1f(pr.u.uTime, s.time);
      gl.uniform1f(pr.u.uScroll, s.scroll);
      gl.uniform1f(pr.u.uTravel, s.travel);
      gl.uniform1f(pr.u.uWall, s.wall);
      gl.uniform1f(pr.u.uColumn, s.column);
      gl.uniform1f(pr.u.uVeil, s.veil);
      gl.uniform4f(pr.u.uSeams, s.seams[0], s.seams[1], s.seams[2], s.seams[3]);
    }

    function stepSmoke(s, dt, shift, zoom, init) {
      var pr = air.progs.smoke;
      gl.useProgram(pr.p);
      gl.viewport(0, 0, air.sw, air.sh);
      gl.uniform2f(pr.u.uTexel, 1 / air.sw, 1 / air.sh);
      setTarget(pr, s);
      bind(0, air.velocity.read.tex, pr.u.uVelocity);
      bind(1, air.smoke.read.tex, pr.u.uSource);
      gl.uniform2f(pr.u.uVelTexel, 1 / air.w, 1 / air.h);
      gl.uniform1f(pr.u.uDt, dt);
      // Thin smoke takes a while to drift back; a wall closes quickly.
      gl.uniform1f(pr.u.uRelax, 1 - Math.exp(-dt / (5.5 - 4.9 * s.wall)));
      gl.uniform1f(pr.u.uFall, 1 - Math.exp(-dt / (2.2 - 1.6 * s.wall)));
      gl.uniform1f(pr.u.uShift, shift);
      gl.uniform1f(pr.u.uZoom, zoom);
      gl.uniform1f(pr.u.uInit, init ? 1 : 0);
      gl.uniform3fv(pr.u.uEmit, s.emit);
      pass(air.smoke.write); air.smoke.swap();
    }

    function stepAir(s, dt, shift, zoom) {
      var P = air.progs, tx = 1 / air.w, ty = 1 / air.h, pr;
      gl.viewport(0, 0, air.w, air.h);

      // The pointer pushes.
      var dx = ptr.x - ptr.px, dy = ptr.y - ptr.py;
      if (ptr.seen && (dx !== 0 || dy !== 0)) {
        // Force in grid cells per second, capped so a wild flick stays smoke.
        var fx = dx * air.w / dt * 0.3, fy = dy * air.h / dt * 0.3;
        var mag = Math.sqrt(fx * fx + fy * fy), cap = 95 * air.h / 108;
        if (mag > cap) { fx *= cap / mag; fy *= cap / mag; }
        pr = P.splat; gl.useProgram(pr.p);
        gl.uniform2f(pr.u.uTexel, tx, ty);
        bind(0, air.velocity.read.tex, pr.u.uTarget);
        gl.uniform2f(pr.u.uA, ptr.px, ptr.py);
        gl.uniform2f(pr.u.uB, ptr.x, ptr.y);
        gl.uniform2f(pr.u.uForce, fx, fy);
        gl.uniform1f(pr.u.uAspect, cssW / cssH);
        gl.uniform1f(pr.u.uRadius, 0.007);
        pass(air.velocity.write); air.velocity.swap();
      }
      ptr.px = ptr.x; ptr.py = ptr.y;

      pr = P.force; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uTexel, tx, ty);
      bind(0, air.velocity.read.tex, pr.u.uVelocity);
      bind(1, air.smoke.read.tex, pr.u.uSmoke);
      gl.uniform1f(pr.u.uDt, dt);
      gl.uniform1f(pr.u.uBuoy, 16 * air.h / 108);
      gl.uniform1f(pr.u.uWind, 5 * air.h / 108);
      gl.uniform1f(pr.u.uAspect, cssW / cssH);
      gl.uniform1f(pr.u.uTime, s.time);
      gl.uniform1f(pr.u.uScroll, s.scroll);
      pass(air.velocity.write); air.velocity.swap();

      pr = P.curl; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uTexel, tx, ty);
      bind(0, air.velocity.read.tex, pr.u.uVelocity);
      pass(air.curl);

      pr = P.vorticity; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uTexel, tx, ty);
      bind(0, air.velocity.read.tex, pr.u.uVelocity);
      bind(1, air.curl.tex, pr.u.uCurl);
      gl.uniform1f(pr.u.uStrength, 14);
      gl.uniform1f(pr.u.uDt, dt);
      pass(air.velocity.write); air.velocity.swap();

      pr = P.divergence; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uTexel, tx, ty);
      bind(0, air.velocity.read.tex, pr.u.uVelocity);
      pass(air.divergence);

      pr = P.pressure; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uTexel, tx, ty);
      bind(1, air.divergence.tex, pr.u.uDivergence);
      for (var i = 0; i < 20; i++) {
        bind(0, air.pressure.read.tex, pr.u.uPressure);
        // First pass starts from a faded copy of last frame's answer.
        gl.uniform1f(pr.u.uScale, i === 0 ? 0.2 : 0.25);
        pass(air.pressure.write); air.pressure.swap();
      }

      pr = P.gradient; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uTexel, tx, ty);
      bind(0, air.pressure.read.tex, pr.u.uPressure);
      bind(1, air.velocity.read.tex, pr.u.uVelocity);
      pass(air.velocity.write); air.velocity.swap();

      pr = P.advect; gl.useProgram(pr.p);
      gl.uniform2f(pr.u.uTexel, tx, ty);
      bind(0, air.velocity.read.tex, pr.u.uVelocity);
      bind(1, air.velocity.read.tex, pr.u.uSource);
      gl.uniform1f(pr.u.uDt, dt);
      gl.uniform1f(pr.u.uKeep, Math.exp(-dt * 0.55));
      gl.uniform1f(pr.u.uShift, shift);
      gl.uniform1f(pr.u.uZoom, zoom);
      pass(air.velocity.write); air.velocity.swap();

      stepSmoke(s, dt, shift, zoom, false);
    }

    function draw(s) {
      gl.useProgram(view.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      if (air) bind(0, air.smoke.read.tex, view.u.uSmoke);
      setTarget(view, s);
      gl.uniform1f(view.u.uFade, s.fade);
      gl.uniform1f(view.u.uPing, s.ping);
      gl.uniform1f(view.u.uPingT, s.pingT);
      gl.uniform2f(view.u.uPingAt, s.pingAt[0], s.pingAt[1]);
      gl.uniform3f(view.u.uTint, s.tint[0], s.tint[1], s.tint[2]);
      gl.uniform1f(view.u.uTintAmt, s.tintAmt);
      gl.uniform3fv(view.u.uLampPos, s.lampPos);
      gl.uniform3fv(view.u.uLampCol, s.lampCol);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /*
     * s.shift   how far the page scrolled this frame, in screen heights
     * s.walked  how far the camera walked this frame, in units of uTravel
     */
    function render(s, dt) {
      if (air) {
        // Walking forward grows the smoke toward you at the same rate the
        // gathering places grow, so the two never disagree.
        var zoom = Math.exp(-1.4 * (s.walked || 0));
        if (air.fresh || s.still) {
          stepSmoke(s, 0.016, 0, 1, true);
          air.fresh = false;
        } else {
          stepAir(s, Math.max(dt, 0.004), s.shift || 0, zoom);
        }
      }
      draw(s);

      // If this machine can't keep up, draw fewer pixels. Smoke is soft; it forgives.
      if (!s.still) {
        frames++;
        if (dt > 0.03) slow++;
        if (frames >= 90) {
          if (slow > 45 && scale > 0.3) { scale = Math.max(0.3, scale - 0.12); resize(); }
          frames = 0; slow = 0;
        }
      }
    }

    // Let the smoke run on by itself for a while (used to settle it, and by tests).
    function advance(s, seconds) {
      if (!air) return;
      if (air.fresh) { stepSmoke(s, 0.016, 0, 1, true); air.fresh = false; }
      for (var t = 0; t < seconds; t += 1 / 60) stepAir(s, 1 / 60, 0, 1);
    }

    resize();
    return {
      render: render, resize: resize, advance: advance,
      pointer: pointer, pointerLift: pointerLift,
      hasAir: function () { return !!air; }
    };
  }

  window.ExhaleSmoke = { create: createSmoke };
})();
