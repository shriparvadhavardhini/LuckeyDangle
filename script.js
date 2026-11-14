/* ============================================================================
   LUCKY DANGLE — script.js
   ----------------------------------------------------------------------------
   A charm hangs from the top edge of the viewport on a rope.

   The rope is a chain of Verlet particles. Each frame we:
     1. integrate  — move every particle by its own velocity + gravity
     2. constrain  — pull neighbours back to their rest distance
     3. bound      — keep the charm inside the visible viewport
     4. render     — draw rope / glow / dust on canvas, place the charm in DOM

   Verlet integration stores position and *previous* position instead of an
   explicit velocity. Velocity is implied by (position - previousPosition),
   which makes collisions, pinning and dragging trivial: you just move a point
   and the motion follows.

   No libraries, no build step. Sections below, in order:
     CONFIG · STATE · ROPE · EFFECTS · INPUT · UI · RENDER · LOOP
   ========================================================================== */

(function () {
  "use strict";

  /* ==========================================================================
     CONFIG — every tunable number lives here
     ========================================================================== */
  const CONFIG = {
    segments: 16,          // rope particles (more = softer, smoother bend)
    ropeMin: 150,          // shortest rope, px (small windows)
    ropeMax: 280,          // longest rope, px (tall windows)
    ropeRatio: 0.26,       // rope length as a fraction of viewport height

    gravity: 1500,         // px/s². Scaled by the gravity slider.
    baseDrag: 0.999,       // air friction per step at damping = 0

    charmMass: 7,          // charm is heavier than a rope link, so it leads
    iterations: 10,        // constraint passes per step (more = stiffer rope)
    stiffness: 0.92,       // 1 = inextensible rope
    stretchStiffness: 0.34,// while dragging, the rope is allowed to stretch
    maxStretch: 1.45,      // hardest pull, as a multiple of the rope's length

    mouseRadius: 240,      // cursor influence distance, px
    mousePush: 620,        // how hard the cursor nudges the charm
    flickScale: 0.5,       // extra flick added on top of the drag's own speed
    doubleClickKick: 780,  // horizontal impulse on double click, px/s

    dust: 42,              // background particles
    swingImpactAngle: 0.26 // radians: past this, a turn-around emits a ring
  };

  const FIXED_DT = 1 / 60; // physics runs at a fixed 60 Hz, independent of FPS
  const MAX_STEPS = 4;     // never simulate more than this per frame

  /* ==========================================================================
     STATE
     ========================================================================== */
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const charmEl = document.getElementById("charm");
  const charmImg = document.getElementById("charmImage");
  const charmFallback = document.getElementById("charmFallback");
  const hintEl = document.getElementById("hint");
  const fpsEl = document.getElementById("fps");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Desktop mode: set by preload.js when the page is running inside
  // the Electron shell instead of a browser tab. The page then drops its own
  // background and UI so only the charm is painted over your desktop.
  const desktop = !!(window.dangle && window.dangle.isDesktop);
  if (desktop) {
    document.body.classList.add("is-desktop");
    CONFIG.dust = 0;                  // no floating dust over the real desktop
  }

  const view = { w: 0, h: 0, dpr: 1 };

  // Cached charm box. Reading offsetWidth every frame would force a layout,
  // so it is measured on resize and whenever the artwork finishes loading.
  const charmBox = { w: 104, h: 128 };
  function measureCharm() {
    charmBox.w = charmEl.offsetWidth || charmBox.w;
    charmBox.h = charmEl.offsetHeight || charmBox.h;
  }

  // Live values driven by the sliders.
  const settings = {
    swing: 1,     // multiplier on every external force
    gravity: 1,   // multiplier on gravity
    damping: 0.2  // 0 = swings for ages, 1 = stops almost immediately
  };

  // Pointer tracking. `vx/vy` is pointer speed in px/s, used for flicks.
  const pointer = {
    x: -9999, y: -9999,
    px: -9999, py: -9999,
    vx: 0, vy: 0,
    inside: false,
    dragging: false,
    grabOffX: 0, grabOffY: 0
  };

  const state = {
    hidden: false,
    lengthScale: 1,      // animates to ~0 when the charm is hidden
    lengthTarget: 1,
    tilt: 0,             // secondary rotation (the charm lags behind the rope)
    tiltVel: 0,
    lastSwingDir: 0,     // used to detect a turn-around at full swing
    blur: 0
  };

  /* ==========================================================================
     ROPE — Verlet particles + distance constraints
     ========================================================================== */

  /** One simulated particle. `mass: 0` means pinned (never moves). */
  function makePoint(x, y, mass) {
    return { x: x, y: y, px: x, py: y, mass: mass, inv: mass === 0 ? 0 : 1 / mass };
  }

  const rope = {
    points: [],
    rest: 10,      // rest distance between neighbouring points
    anchor: { x: 0, y: 0 },

    /** Build (or rebuild) the rope hanging straight down from the anchor. */
    build: function (anchorX, anchorY, length) {
      this.anchor.x = anchorX;
      this.anchor.y = anchorY;
      this.rest = length / (CONFIG.segments - 1);
      this.points = [];
      for (let i = 0; i < CONFIG.segments; i++) {
        const isLast = i === CONFIG.segments - 1;
        this.points.push(makePoint(
          anchorX,
          anchorY + this.rest * i,
          i === 0 ? 0 : (isLast ? CONFIG.charmMass : 1)
        ));
      }
    },

    /** The charm sits on the final point. */
    tip: function () { return this.points[this.points.length - 1]; },

    /* ---- 1. integrate -------------------------------------------------- */
    integrate: function (dt) {
      // Slider 0..1 maps to a per-step velocity multiplier.
      const drag = CONFIG.baseDrag - settings.damping * 0.03;
      const g = CONFIG.gravity * settings.gravity * dt * dt;

      for (const p of this.points) {
        if (p.inv === 0) continue;

        // implied velocity, reduced by air friction
        const vx = (p.x - p.px) * drag;
        const vy = (p.y - p.py) * drag;

        p.px = p.x;
        p.py = p.y;

        p.x += vx;
        p.y += vy + g;   // gravity is an acceleration: dt² is already applied
      }
    },

    /* ---- 2. constrain -------------------------------------------------- */
    /** Pull each pair of neighbours back towards their rest distance. */
    solve: function (stiffness) {
      for (let k = 0; k < CONFIG.iterations; k++) {
        for (let i = 0; i < this.points.length - 1; i++) {
          const a = this.points[i];
          const b = this.points[i + 1];

          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.0001;

          const rest = this.rest * state.lengthScale;
          const diff = (dist - rest) / dist;

          // Softer correction when the rope is being pulled longer than it
          // should be — that is what makes it visibly stretch under a drag.
          const k2 = dist > rest ? stiffness : Math.min(1, stiffness + 0.25);

          const totalInv = a.inv + b.inv;
          if (totalInv === 0) continue;

          const sx = dx * diff * k2;
          const sy = dy * diff * k2;

          // heavier points move less — the charm leads, the links follow
          a.x += sx * (a.inv / totalInv);
          a.y += sy * (a.inv / totalInv);
          b.x -= sx * (b.inv / totalInv);
          b.y -= sy * (b.inv / totalInv);
        }

        // The first point is welded to the top edge of the screen.
        this.points[0].x = this.anchor.x;
        this.points[0].y = this.anchor.y;
      }
    },

    /* ---- 3. bounds ------------------------------------------------------ */
    /** Keep the charm on screen; bounce gently off the edges. */
    bound: function (halfW, halfH) {
      const p = this.tip();
      const minX = halfW + 8;
      const maxX = view.w - halfW - 8;
      const maxY = view.h - halfH - 8;

      if (p.x < minX) { const v = p.x - p.px; p.x = minX; p.px = p.x + v * 0.45; }
      if (p.x > maxX) { const v = p.x - p.px; p.x = maxX; p.px = p.x + v * 0.45; }
      if (p.y > maxY) { const v = p.y - p.py; p.y = maxY; p.py = p.y + v * 0.45; }
      if (p.y < 4)    { p.y = 4; }
    },

    /** Add an instantaneous velocity to the charm (px/s). */
    kick: function (vx, vy) {
      const p = this.tip();
      p.px -= vx * FIXED_DT;
      p.py -= vy * FIXED_DT;
    },

    /** Drop everything and hang straight down again. */
    reset: function () {
      this.build(this.anchor.x, this.anchor.y, this.rest * (CONFIG.segments - 1));
      state.tilt = 0;
      state.tiltVel = 0;
    }
  };

  /** Cursor influence: a soft pull towards the pointer that falls off with
   *  distance, plus a little of the pointer's own speed as "wind". */
  function applyPointerForce(dt) {
    if (!pointer.inside || pointer.dragging || state.hidden) return;

    for (let i = 1; i < rope.points.length; i++) {
      const p = rope.points[i];
      const dx = pointer.x - p.x;
      const dy = pointer.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > CONFIG.mouseRadius || dist < 0.001) continue;

      // 1 at the pointer, 0 at the edge of the influence radius, eased
      let falloff = 1 - dist / CONFIG.mouseRadius;
      falloff *= falloff;

      // rope links react less than the charm itself
      const weight = i === rope.points.length - 1 ? 1 : 0.35;
      const force = CONFIG.mousePush * settings.swing * falloff * weight * dt * dt;

      p.x += (dx / dist) * force;
      p.y += (dy / dist) * force * 0.45;

      // the pointer sweeping past drags a little air with it
      p.x += pointer.vx * 0.00012 * falloff * weight * settings.swing;
      p.y += pointer.vy * 0.00007 * falloff * weight * settings.swing;
    }
  }

  /* ==========================================================================
     EFFECTS — background dust and swing-impact rings
     ========================================================================== */

  const dust = [];
  function seedDust() {
    dust.length = 0;
    if (reducedMotion) return;
    for (let i = 0; i < CONFIG.dust; i++) {
      dust.push({
        x: Math.random() * view.w,
        y: Math.random() * view.h,
        r: 0.5 + Math.random() * 1.5,
        vy: -(3 + Math.random() * 10),
        vx: (Math.random() - 0.5) * 6,
        a: 0.06 + Math.random() * 0.2,
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  function updateDust(dt, time) {
    for (const d of dust) {
      d.y += d.vy * dt;
      d.x += (d.vx + Math.sin(time * 0.0007 + d.phase) * 6) * dt;
      if (d.y < -10) { d.y = view.h + 10; d.x = Math.random() * view.w; }
      if (d.x < -10) d.x = view.w + 10;
      if (d.x > view.w + 10) d.x = -10;
    }
  }

  const rings = [];
  function spawnRing(x, y, strength) {
    if (reducedMotion || rings.length > 6) return;
    rings.push({ x: x, y: y, r: 12, max: 52 + strength * 26, life: 1 });
  }

  function updateRings(dt) {
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life -= dt * 1.6;
      r.r += (r.max - r.r) * dt * 4;
      if (r.life <= 0) rings.splice(i, 1);
    }
  }

  /** Fires when the charm turns around at the end of a wide swing. */
  function detectSwingImpact() {
    const tip = rope.tip();
    const vx = tip.x - tip.px;
    const dir = vx > 0.2 ? 1 : vx < -0.2 ? -1 : 0;

    const angle = Math.atan2(tip.x - rope.anchor.x, tip.y - rope.anchor.y);

    if (dir !== 0 && state.lastSwingDir !== 0 && dir !== state.lastSwingDir) {
      if (Math.abs(angle) > CONFIG.swingImpactAngle) {
        spawnRing(tip.x, tip.y, Math.min(2, Math.abs(angle)));
      }
    }
    if (dir !== 0) state.lastSwingDir = dir;
  }

  /* ==========================================================================
     INPUT
     ========================================================================== */

  /** True when the event started on the control panel. */
  function overPanel(target) {
    return !!(target && target.closest && target.closest(".panel"));
  }

  function isOverCharm(x, y) {
    const tip = rope.tip();
    const cx = tip.x;
    const cy = tip.y + charmBox.h * 0.42;
    const grab = Math.max(charmBox.w, charmBox.h) * 0.52;
    return Math.hypot(x - cx, y - cy) < grab;
  }

  function onPointerMove(e) {
    pointer.inside = true;
    pointer.x = e.clientX;
    pointer.y = e.clientY;

    if (!state.hidden && !pointer.dragging) {
      charmEl.classList.toggle("is-hover", isOverCharm(pointer.x, pointer.y));
    }
  }

  function onPointerDown(e) {
    if (state.hidden) return;
    if (overPanel(e.target)) return;             // don't grab through the UI
    if (!isOverCharm(e.clientX, e.clientY)) return;

    pointer.dragging = true;
    charmEl.classList.add("is-grabbed");

    // Pinning the charm while it is held means the constraints cannot pull it
    // off the cursor — instead the rope itself takes the stretch.
    rope.tip().inv = 0;
    hintEl.classList.add("is-faded");

    const tip = rope.tip();
    pointer.grabOffX = tip.x - e.clientX;
    pointer.grabOffY = tip.y - e.clientY;

    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    e.preventDefault();
  }

  function onPointerUp() {
    if (!pointer.dragging) return;
    pointer.dragging = false;
    charmEl.classList.remove("is-grabbed");
    rope.tip().inv = 1 / CONFIG.charmMass;

    // Release velocity: the charm keeps the speed the pointer had.
    rope.kick(pointer.vx * CONFIG.flickScale * settings.swing,
              pointer.vy * CONFIG.flickScale * settings.swing * 0.6);
  }

  function onDoubleClick(e) {
    if (state.hidden || overPanel(e.target)) return;
    const dir = e.clientX < rope.anchor.x ? 1 : -1;
    rope.kick(dir * CONFIG.doubleClickKick * settings.swing, -120);
    hintEl.classList.add("is-faded");
  }

  /** While dragging, the charm is pinned to the pointer and the rope stretches. */
  function followPointer() {
    const tip = rope.tip();
    let targetX = pointer.x + pointer.grabOffX;
    let targetY = pointer.y + pointer.grabOffY;

    // The rope can be pulled taut, but only so far — past this the charm
    // stops following the cursor, exactly like a real string running out.
    const maxReach = rope.rest * (CONFIG.segments - 1) * CONFIG.maxStretch;
    const dx = targetX - rope.anchor.x;
    const dy = targetY - rope.anchor.y;
    const dist = Math.hypot(dx, dy);
    if (dist > maxReach) {
      targetX = rope.anchor.x + (dx / dist) * maxReach;
      targetY = rope.anchor.y + (dy / dist) * maxReach;
    }

    // a touch of smoothing keeps fast drags from looking snappy
    tip.px = tip.x;
    tip.py = tip.y;
    tip.x += (targetX - tip.x) * 0.55;
    tip.y += (targetY - tip.y) * 0.55;
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("pointerout", function (e) {
    if (!e.relatedTarget) pointer.inside = false;   // cursor left the window
  });
  window.addEventListener("blur", onPointerUp);
  charmEl.addEventListener("dragstart", function (e) { e.preventDefault(); });

  /* ==========================================================================
     UI — sliders and buttons
     ========================================================================== */

  function bindSlider(id, outId, apply, format) {
    const input = document.getElementById(id);
    const out = document.getElementById(outId);
    const update = function () {
      const value = Number(input.value);
      apply(value);
      out.textContent = format(value);
    };
    input.addEventListener("input", update);
    update();
  }

  bindSlider("swing", "swingOut",
    function (v) { settings.swing = v / 100; },
    function (v) { return (v / 100).toFixed(2) + "\u00D7"; });

  bindSlider("gravity", "gravityOut",
    function (v) { settings.gravity = v / 100; },
    function (v) { return (v / 100).toFixed(2) + "\u00D7"; });

  bindSlider("damping", "dampingOut",
    function (v) { settings.damping = v / 100; },
    function (v) { return (v / 100).toFixed(2); });

  document.getElementById("resetBtn").addEventListener("click", function () {
    rope.reset();
    rings.length = 0;
  });

  const hideBtn = document.getElementById("hideBtn");
  hideBtn.addEventListener("click", function () {
    state.hidden = !state.hidden;
    state.lengthTarget = state.hidden ? 0.03 : 1;   // rope retracts upwards
    charmEl.classList.toggle("is-hidden", state.hidden);
    charmEl.classList.remove("is-hover");
    hideBtn.textContent = state.hidden ? "Show charm" : "Hide charm";
    hideBtn.setAttribute("aria-pressed", String(state.hidden));
    if (!state.hidden) rope.kick(0, 90);            // a small drop on return
  });

  // Use the CSS fallback charm if the artwork is missing.
  charmImg.addEventListener("load", measureCharm);
  charmImg.addEventListener("error", function () {
    charmImg.hidden = true;
    charmFallback.hidden = false;
    measureCharm();
  });
  if (charmImg.complete && charmImg.naturalWidth === 0) {
    charmImg.hidden = true;
    charmFallback.hidden = false;
  }

  /* ==========================================================================
     RENDER
     ========================================================================== */

  function resize() {
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    canvas.style.width = view.w + "px";
    canvas.style.height = view.h + "px";
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    const length = Math.max(CONFIG.ropeMin,
                   Math.min(CONFIG.ropeMax, view.h * CONFIG.ropeRatio));

    if (rope.points.length === 0) {
      rope.build(view.w / 2, -4, length);
    } else {
      // Keep the charm roughly where it was, just re-anchor and re-scale.
      const oldX = rope.anchor.x;
      rope.anchor.x = view.w / 2;
      rope.rest = length / (CONFIG.segments - 1);
      const shift = rope.anchor.x - oldX;
      for (const p of rope.points) {
        p.x += shift; p.px += shift;
        p.x = Math.max(8, Math.min(view.w - 8, p.x));
        p.y = Math.min(p.y, view.h - 8);
      }
    }
    measureCharm();
    seedDust();
  }

  function drawDust() {
    ctx.save();
    for (const d of dust) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(226, 216, 190, " + d.a + ")";
      ctx.fill();
    }
    ctx.restore();
  }

  /** Warm pool of light behind the charm; it leans with the swing. */
  function drawGlow(tip) {
    const lean = (tip.x - rope.anchor.x) * 0.05;
    const gx = tip.x + lean;
    const gy = tip.y + charmBox.h * 0.35;
    const radius = 210 * state.lengthScale;
    if (radius < 4) return;

    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, radius);
    g.addColorStop(0, "rgba(226, 189, 110, 0.20)");
    g.addColorStop(0.45, "rgba(226, 189, 110, 0.07)");
    g.addColorStop(1, "rgba(226, 189, 110, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(gx, gy, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Trace the rope as a smooth curve through the particle positions. */
  function traceRope() {
    const pts = rope.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  function drawRope() {
    if (state.lengthScale < 0.06) return;
    const alpha = Math.min(1, state.lengthScale * 1.6);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 1. dark outline, so the rope reads against the glow
    traceRope();
    ctx.strokeStyle = "rgba(4, 6, 12, " + 0.75 * alpha + ")";
    ctx.lineWidth = 4.4;
    ctx.stroke();

    // 2. body, shaded from dim at the top to lit near the charm
    const grad = ctx.createLinearGradient(
      rope.anchor.x, rope.anchor.y, rope.tip().x, rope.tip().y);
    grad.addColorStop(0, "rgba(142, 128, 102, " + 0.85 * alpha + ")");
    grad.addColorStop(0.6, "rgba(196, 173, 126, " + 0.9 * alpha + ")");
    grad.addColorStop(1, "rgba(233, 205, 150, " + alpha + ")");

    traceRope();
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // 3. thin specular highlight, offset to one side
    ctx.save();
    ctx.translate(-0.7, 0);
    traceRope();
    ctx.strokeStyle = "rgba(255, 246, 224, " + 0.3 * alpha + ")";
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.restore();

    // 4. small knot where the rope meets the top edge
    ctx.beginPath();
    ctx.arc(rope.anchor.x, 2, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(226, 189, 110, " + 0.8 * alpha + ")";
    ctx.fill();
  }

  function drawRings() {
    for (const r of rings) {
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(226, 189, 110, " + 0.22 * r.life + ")";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  /** Move the charm element and rotate it to match the rope's last segment. */
  function placeCharm(dt) {
    const pts = rope.points;
    const tip = pts[pts.length - 1];
    const prev = pts[pts.length - 2];

    const dx = tip.x - prev.x;
    const dy = tip.y - prev.y;

    // Screen-space rotation: a bob hanging to the right needs a negative
    // (counter-clockwise) CSS angle for its body to line up with the rope.
    const ropeAngle = -Math.atan2(dx, dy);

    // Secondary motion: the charm's body lags behind the rope on a spring,
    // so it overshoots slightly and wobbles as the swing turns around.
    const velX = (tip.x - tip.px) / FIXED_DT;
    const target = Math.max(-0.35, Math.min(0.35, -velX * 0.00022 * settings.swing));
    state.tiltVel += (target - state.tilt) * 26 * dt;
    state.tiltVel *= 0.88;
    state.tilt += state.tiltVel * dt;

    const angle = (ropeAngle + state.tilt) * (180 / Math.PI);

    const w = charmBox.w;
    const h = charmBox.h;
    const x = tip.x - w / 2;
    const y = tip.y - h * 0.07;      // matches transform-origin in CSS

    const scale = 0.55 + 0.45 * state.lengthScale;   // shrinks away when hidden

    charmEl.style.transform =
      "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0) " +
      "rotate(" + angle.toFixed(2) + "deg) scale(" + scale.toFixed(3) + ")";

    // Very subtle motion blur at speed. Only written when it actually changes.
    if (!reducedMotion) {
      const speed = Math.hypot(tip.x - tip.px, tip.y - tip.py) / FIXED_DT;
      const blur = Math.min(1.5, speed * 0.0009);
      if (Math.abs(blur - state.blur) > 0.12) {
        state.blur = blur;
        charmEl.style.filter = blur > 0.15 ? "blur(" + blur.toFixed(2) + "px)" : "";
      }
    }
  }

  /* ==========================================================================
     LOOP
     ========================================================================== */

  let accumulator = 0;
  let previous = performance.now();
  let frames = 0;
  let fpsClock = previous;

  function step() {
    const halfW = charmBox.w / 2;
    const halfH = charmBox.h / 2;

    rope.integrate(FIXED_DT);
    applyPointerForce(FIXED_DT);
    if (pointer.dragging) followPointer();

    rope.solve(pointer.dragging ? CONFIG.stretchStiffness : CONFIG.stiffness);
    rope.bound(halfW, halfH);
    detectSwingImpact();
  }

  function frame(now) {
    let elapsed = (now - previous) / 1000;
    previous = now;
    if (elapsed > 0.25) elapsed = 0.25;   // after a tab switch, don't explode

    // Pointer velocity in px/s, smoothed a little.
    if (elapsed > 0 && pointer.px > -9000) {
      const instVX = (pointer.x - pointer.px) / elapsed;
      const instVY = (pointer.y - pointer.py) / elapsed;
      const clamp = function (v) { return Math.max(-2600, Math.min(2600, v)); };
      pointer.vx += (clamp(instVX) - pointer.vx) * 0.45;
      pointer.vy += (clamp(instVY) - pointer.vy) * 0.45;
    }
    pointer.px = pointer.x;
    pointer.py = pointer.y;

    // Hide / show animation drives the rope's rest length.
    state.lengthScale += (state.lengthTarget - state.lengthScale) * Math.min(1, elapsed * 3.4);

    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      step();
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;

    updateDust(elapsed, now);
    updateRings(elapsed);

    ctx.clearRect(0, 0, view.w, view.h);
    drawDust();
    if (!state.hidden || state.lengthScale > 0.08) {
      drawGlow(rope.tip());
      drawRings();
      drawRope();
    }
    placeCharm(elapsed);

    // FPS readout, refreshed twice a second.
    frames++;
    if (now - fpsClock >= 500) {
      fpsEl.textContent = Math.round(frames * 1000 / (now - fpsClock)) + " fps";
      frames = 0;
      fpsClock = now;
    }

    requestAnimationFrame(frame);
  }

  /* ==========================================================================
     START
     ========================================================================== */

  let resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 80);
  });

  /* ==========================================================================
     DESKTOP SHELL BRIDGE
     The Electron window is click-through so it never blocks the desktop
     underneath. We only ask for mouse input while the cursor is over the
     charm (or while it is being dragged).
     ========================================================================== */
  if (desktop) {
    let interactive = null;
    setInterval(function () {
      const want = pointer.dragging ||
                   (!state.hidden && isOverCharm(pointer.x, pointer.y));
      if (want !== interactive) {
        interactive = want;
        window.dangle.setInteractive(want);
      }
    }, 60);

    // Right-click the charm to close it.
    window.addEventListener("contextmenu", function (e) {
      if (isOverCharm(e.clientX, e.clientY)) {
        e.preventDefault();
        window.dangle.quit();
      }
    });
  }

  resize();
  rope.kick(90, 0);                    // a gentle nudge so it is alive on load
  setTimeout(function () { hintEl.classList.add("is-faded"); }, 9000);
  requestAnimationFrame(frame);
})();
