/* Agent Canvas — real-time + replay agent orchestration animation. */
/* globals: query, rows, rowsToObjects, tsToMs, escapeSQLString, escapeHTML, t, sessTimelineData, fmtCost */

var AgentCanvas = (function () {
  // ── Constants ────────────────────────────────────────────────
  var MAIN_R = 28, SUB_R = 20;
  var DAMPING = 0.92, CENTER_K = 0.005, CHARGE_K = 800;
  var PARTICLE_SPEED = 1.2;
  var BUBBLE_TTL = 4.0, MAX_BUBBLES = 4;
  var TOOL_W = 130, TOOL_H = 28;

  var STATE_COLORS = {
    idle: '#8b949e', thinking: '#d2a8ff', tool_calling: '#79c0ff',
    complete: '#3fb950', error: '#f85149',
  };
  var ROLE_COLORS = { user: '#f0883e', assistant: '#79c0ff', thinking: '#d2a8ff' };

  // ── State ────────────────────────────────────────────────────
  var canvas, ctx, dpr;
  var agents = {}, edges = {}, toolCalls = {}, particles = [], bubbles = [];
  var selectedId = null;
  var animFrame = null, lastTime = 0;
  var mode = null; // 'live' | 'replay'

  // Session info for display.
  var canvasSessionId = '';
  var canvasMode = '';

  // Live mode.
  var eventSource = null;

  // Replay mode.
  var replayEvents = [], replayIdx = 0, replayTimer = null;
  var replaySpeed = 1, replayPaused = false;
  var replayStartTs = 0, replayEndTs = 0, replayCurrentTs = 0;

  // Agent tool counts (for info card).
  var agentToolCounts = {};

  // ── Scene Graph Helpers ──────────────────────────────────────

  function addAgent(id, label, isMain) {
    if (agents[id]) return agents[id];
    var cx = canvas.width / dpr / 2, cy = canvas.height / dpr / 2;
    agents[id] = {
      id: id, x: cx + (Math.random() - 0.5) * 120, y: cy + (Math.random() - 0.5) * 80,
      vx: 0, vy: 0, r: isMain ? MAIN_R : SUB_R,
      label: label || (isMain ? 'main' : id.slice(0, 8)),
      state: 'idle', breath: Math.random() * Math.PI * 2, isMain: isMain,
    };
    agentToolCounts[id] = 0;
    return agents[id];
  }

  function addEdge(fromId, toId) {
    var key = fromId + '>' + toId;
    if (!edges[key]) edges[key] = { key: key, from: fromId, to: toId, active: true };
    return key;
  }

  function spawnParticle(edgeKey) {
    particles.push({ edge: edgeKey, t: 0, wobble: Math.random() * 6.28, trail: [] });
  }

  function addBubble(agentId, text, role) {
    if (text.length > 80) text = text.slice(0, 77) + '...';
    bubbles.push({ agentId: agentId, text: text, role: role, ttl: BUBBLE_TTL, opacity: 1 });
    if (bubbles.length > MAX_BUBBLES) bubbles.shift();
  }

  // ── Force Simulation ─────────────────────────────────────────

  function simulate(dt) {
    var cx = canvas.width / dpr / 2, cy = canvas.height / dpr / 2;
    var ids = Object.keys(agents);
    var i, j, a, b, dx, dy, distSq, force, fx, fy, dist, diff, nx, ny;

    for (i = 0; i < ids.length; i++) {
      a = agents[ids[i]];
      a.vx += (cx - a.x) * CENTER_K;
      a.vy += (cy - a.y) * CENTER_K;
      for (j = i + 1; j < ids.length; j++) {
        b = agents[ids[j]];
        dx = b.x - a.x; dy = b.y - a.y;
        distSq = dx * dx + dy * dy + 1;
        force = CHARGE_K / distSq;
        fx = dx / Math.sqrt(distSq) * force;
        fy = dy / Math.sqrt(distSq) * force;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }

    for (var ek in edges) {
      var e = edges[ek], from = agents[e.from], to = agents[e.to];
      if (!from || !to) continue;
      dx = to.x - from.x; dy = to.y - from.y;
      dist = Math.sqrt(dx * dx + dy * dy) || 1;
      diff = (dist - (from.r + to.r) * 3) * 0.01;
      nx = dx / dist; ny = dy / dist;
      from.vx += nx * diff; from.vy += ny * diff;
      to.vx -= nx * diff; to.vy -= ny * diff;
    }

    for (i = 0; i < ids.length; i++) {
      a = agents[ids[i]];
      a.vx *= DAMPING; a.vy *= DAMPING;
      a.x += a.vx; a.y += a.vy;
      a.breath += dt * 1.5;
    }
  }

  // ── Particle Update ──────────────────────────────────────────

  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.t += PARTICLE_SPEED * dt;
      p.wobble += dt * 3;
      var pos = particlePos(p);
      if (pos) { p.trail.push(pos); if (p.trail.length > 6) p.trail.shift(); }
      if (p.t >= 1) particles.splice(i, 1);
    }
  }

  function particlePos(p) {
    var e = edges[p.edge]; if (!e) return null;
    var f = agents[e.from], to = agents[e.to]; if (!f || !to) return null;
    var dx = to.x - f.x, dy = to.y - f.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var perpX = -dy / dist, perpY = dx / dist;
    var cpx = (f.x + to.x) / 2 + perpX * dist * 0.15;
    var cpy = (f.y + to.y) / 2 + perpY * dist * 0.15;
    var mt = 1 - p.t;
    var x = mt * mt * f.x + 2 * mt * p.t * cpx + p.t * p.t * to.x;
    var y = mt * mt * f.y + 2 * mt * p.t * cpy + p.t * p.t * to.y;
    var w = Math.sin(p.wobble) * 3 * Math.sin(p.t * Math.PI);
    return { x: x + perpX * w, y: y + perpY * w };
  }

  // ── Bubble Update ────────────────────────────────────────────

  function updateBubbles(dt) {
    for (var i = bubbles.length - 1; i >= 0; i--) {
      bubbles[i].ttl -= dt;
      bubbles[i].opacity = Math.min(1, bubbles[i].ttl / 0.5);
      if (bubbles[i].ttl <= 0) bubbles.splice(i, 1);
    }
  }

  // ── Rendering ────────────────────────────────────────────────

  function render() {
    var w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // Edges.
    for (var ek in edges) {
      var e = edges[ek], f = agents[e.from], to = agents[e.to];
      if (!f || !to) continue;
      var dx = to.x - f.x, dy = to.y - f.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var perpX = -dy / dist, perpY = dx / dist;
      var cpx = (f.x + to.x) / 2 + perpX * dist * 0.15;
      var cpy = (f.y + to.y) / 2 + perpY * dist * 0.15;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.quadraticCurveTo(cpx, cpy, to.x, to.y);
      ctx.strokeStyle = e.active ? 'rgba(121,192,255,0.4)' : 'rgba(139,148,158,0.15)';
      ctx.lineWidth = e.active ? 2 : 1; ctx.stroke();
    }

    // Particles.
    for (var pi = 0; pi < particles.length; pi++) {
      var pos = particlePos(particles[pi]); if (!pos) continue;
      var trail = particles[pi].trail;
      for (var ti = 0; ti < trail.length; ti++) {
        ctx.globalAlpha = (ti + 1) / trail.length * 0.4;
        ctx.beginPath(); ctx.arc(trail[ti].x, trail[ti].y, 2, 0, 6.28);
        ctx.fillStyle = '#79c0ff'; ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(pos.x, pos.y, 3.5, 0, 6.28);
      ctx.fillStyle = '#79c0ff'; ctx.fill();
    }

    // Agent hexagons.
    for (var aid in agents) {
      var a = agents[aid];
      var color = STATE_COLORS[a.state] || STATE_COLORS.idle;
      var s = a.r * (1 + Math.sin(a.breath) * 0.04);
      // Glow.
      if (a.state === 'thinking' || a.state === 'tool_calling') {
        ctx.beginPath();
        for (var gi = 0; gi < 6; gi++) { var ga = Math.PI / 3 * gi - Math.PI / 6; if (gi === 0) ctx.moveTo(a.x + (s + 6) * Math.cos(ga), a.y + (s + 6) * Math.sin(ga)); else ctx.lineTo(a.x + (s + 6) * Math.cos(ga), a.y + (s + 6) * Math.sin(ga)); }
        ctx.closePath(); ctx.strokeStyle = color; ctx.globalAlpha = 0.15; ctx.lineWidth = 8; ctx.stroke(); ctx.globalAlpha = 1;
      }
      // Selected ring.
      if (aid === selectedId) {
        ctx.beginPath();
        for (var si = 0; si < 6; si++) { var sa = Math.PI / 3 * si - Math.PI / 6; if (si === 0) ctx.moveTo(a.x + (s + 4) * Math.cos(sa), a.y + (s + 4) * Math.sin(sa)); else ctx.lineTo(a.x + (s + 4) * Math.cos(sa), a.y + (s + 4) * Math.sin(sa)); }
        ctx.closePath(); ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 2; ctx.stroke();
      }
      // Hex.
      ctx.beginPath();
      for (var hi = 0; hi < 6; hi++) { var ha = Math.PI / 3 * hi - Math.PI / 6; if (hi === 0) ctx.moveTo(a.x + s * Math.cos(ha), a.y + s * Math.sin(ha)); else ctx.lineTo(a.x + s * Math.cos(ha), a.y + s * Math.sin(ha)); }
      ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = 0.15; ctx.fill();
      ctx.globalAlpha = 0.8; ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
      // Label.
      ctx.fillStyle = '#e6edf3'; ctx.font = (a.r > 22 ? '11' : '9') + 'px system-ui,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(a.label, a.x, a.y);
    }

    // Tool call cards.
    var toolIdx = {};
    for (var tid in toolCalls) {
      var tc = toolCalls[tid], ag = agents[tc.agentId]; if (!ag) continue;
      if (!toolIdx[tc.agentId]) toolIdx[tc.agentId] = 0;
      var idx = toolIdx[tc.agentId]++;
      var tx = ag.x - TOOL_W / 2, ty = ag.y + ag.r + 10 + idx * (TOOL_H + 4);
      ctx.fillStyle = 'rgba(22,27,34,0.9)';
      ctx.strokeStyle = tc.state === 'running' ? '#79c0ff' : tc.state === 'error' ? '#f85149' : '#3fb950';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(tx, ty, TOOL_W, TOOL_H, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6edf3'; ctx.font = '10px system-ui,sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(tc.toolName, tx + 8, ty + TOOL_H / 2);
      if (tc.state === 'running') {
        tc.spin = (tc.spin || 0) + 0.06;
        ctx.beginPath(); ctx.arc(tx + TOOL_W - 14, ty + TOOL_H / 2, 5, tc.spin, tc.spin + 4.7);
        ctx.strokeStyle = '#79c0ff'; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    // Message bubbles.
    for (var bi = 0; bi < bubbles.length; bi++) {
      var bub = bubbles[bi], ba = agents[bub.agentId]; if (!ba) continue;
      ctx.globalAlpha = Math.max(0, bub.opacity);
      var bx = ba.x + ba.r + 16, by = ba.y - 20 - bi * 28;
      var bcolor = ROLE_COLORS[bub.role] || '#8b949e';
      ctx.fillStyle = 'rgba(22,27,34,0.85)';
      ctx.strokeStyle = bcolor;
      ctx.lineWidth = 1;
      var tw = Math.min(ctx.measureText(bub.text).width + 16, 300);
      ctx.beginPath(); ctx.roundRect(bx, by - 10, tw, 22, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = bcolor; ctx.font = '10px system-ui,sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(bub.text, bx + 8, by + 1);
      ctx.globalAlpha = 1;
    }

    // Selected agent info card.
    if (selectedId && agents[selectedId]) {
      var sa2 = agents[selectedId];
      var ix = sa2.x + sa2.r + 16, iy = sa2.y - sa2.r;
      ctx.fillStyle = 'rgba(22,27,34,0.92)'; ctx.strokeStyle = 'rgba(139,148,158,0.3)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(ix, iy, 150, 72, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 11px system-ui,sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(sa2.label, ix + 8, iy + 8);
      ctx.font = '10px system-ui,sans-serif'; ctx.fillStyle = '#8b949e';
      ctx.fillText('State: ' + sa2.state, ix + 8, iy + 24);
      ctx.fillText('Tools: ' + (agentToolCounts[selectedId] || 0), ix + 8, iy + 38);
      ctx.fillText(sa2.isMain ? 'Main agent' : 'Subagent', ix + 8, iy + 52);
    }

    // Replay scrubber.
    if (mode === 'replay' && replayEndTs > replayStartTs) {
      var barY = h - 36, barX = 60, barW = w - 120;
      ctx.fillStyle = 'rgba(139,148,158,0.15)';
      ctx.fillRect(barX, barY, barW, 4);
      // Event dots.
      ctx.fillStyle = 'rgba(121,192,255,0.4)';
      var maxDots = Math.min(replayEvents.length, 200);
      var step = Math.max(1, Math.floor(replayEvents.length / maxDots));
      for (var di = 0; di < replayEvents.length; di += step) {
        var dp = (replayEvents[di].ts - replayStartTs) / (replayEndTs - replayStartTs);
        ctx.beginPath(); ctx.arc(barX + dp * barW, barY + 2, 2, 0, 6.28); ctx.fill();
      }
      // Playhead.
      var pp = (replayCurrentTs - replayStartTs) / (replayEndTs - replayStartTs);
      pp = Math.max(0, Math.min(1, pp));
      ctx.fillStyle = '#79c0ff';
      ctx.fillRect(barX + pp * barW - 1, barY - 4, 3, 12);
      // Time labels.
      ctx.fillStyle = '#8b949e'; ctx.font = '9px system-ui,sans-serif'; ctx.textAlign = 'center';
      var elapsed = (replayCurrentTs - replayStartTs) / 1000;
      var total = (replayEndTs - replayStartTs) / 1000;
      ctx.fillText(fmtTime(elapsed), barX + pp * barW, barY + 16);
      ctx.textAlign = 'left'; ctx.fillText(fmtTime(0), barX, barY + 16);
      ctx.textAlign = 'right'; ctx.fillText(fmtTime(total), barX + barW, barY + 16);
    }

    // Session info label (top-left).
    ctx.fillStyle = 'rgba(139,148,158,0.6)'; ctx.font = '11px system-ui,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    var infoLabel = canvasMode === 'live' ? 'LIVE' : 'REPLAY';
    if (canvasSessionId && canvasSessionId !== 'replay') {
      infoLabel += '  \u00B7  ' + canvasSessionId;
    }
    ctx.fillText(infoLabel, 16, 16);
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ── Animation Loop ───────────────────────────────────────────

  function tick(timestamp) {
    var dt = Math.min((timestamp - lastTime) / 1000, 0.05);
    lastTime = timestamp;
    simulate(dt);
    updateParticles(dt);
    updateBubbles(dt);
    render();
    animFrame = requestAnimationFrame(tick);
  }

  // ── Event Processing ─────────────────────────────────────────

  function processEvent(ev) {
    var mainId = '_main';
    if (!agents[mainId]) addAgent(mainId, 'main', true);
    var name = ev.hook_event_name || ev.event_type || '';

    switch (name) {
    case 'SessionStart':
      agents[mainId].state = 'thinking'; break;

    case 'PreToolUse': {
      var aId = ev.agent_id || mainId;
      if (aId && aId !== mainId && !agents[aId]) {
        addAgent(aId, ev.agent_type || aId.slice(0, 8), false);
        addEdge(mainId, aId);
      }
      var agNode = agents[aId] || agents[mainId];
      if (agNode) agNode.state = 'tool_calling';
      agentToolCounts[aId || mainId] = (agentToolCounts[aId || mainId] || 0) + 1;
      toolCalls[ev.tool_use_id] = {
        toolUseId: ev.tool_use_id, agentId: aId || mainId,
        toolName: ev.tool_name || '?', state: 'running', spin: 0,
      };
      // Particle from main to this agent's edge (if subagent).
      if (aId && aId !== mainId) spawnParticle(mainId + '>' + aId);
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      var tc = toolCalls[ev.tool_use_id];
      if (tc) {
        tc.state = name === 'PostToolUseFailure' ? 'error' : 'done';
        var tuid = ev.tool_use_id;
        setTimeout(function () { delete toolCalls[tuid]; }, 800);
      }
      var aId2 = ev.agent_id || mainId;
      if (agents[aId2]) agents[aId2].state = 'thinking';
      break;
    }
    case 'SubagentStart': {
      var subId = ev.agent_id || ('sub_' + Date.now());
      addAgent(subId, ev.agent_type || 'subagent', false);
      var ek = addEdge(mainId, subId);
      agents[subId].state = 'thinking';
      spawnParticle(ek);
      break;
    }
    case 'SubagentStop': {
      if (ev.agent_id && agents[ev.agent_id]) agents[ev.agent_id].state = 'complete';
      var stopEdge = mainId + '>' + ev.agent_id;
      if (edges[stopEdge]) edges[stopEdge].active = false;
      break;
    }
    case 'SessionEnd': case 'Stop':
      agents[mainId].state = 'complete'; break;
    }

    // Message events (from replay timeline).
    if (ev._msgType) {
      addBubble(ev._agentId || '_main', ev._text || '', ev._msgType);
    }
  }

  // ── Live Mode ────────────────────────────────────────────────

  function startLive(sessionId) {
    var url = '/api/hooks/stream';
    if (sessionId) url += '?session_id=' + encodeURIComponent(sessionId);
    eventSource = new EventSource(url);
    eventSource.onmessage = function (e) {
      try {
        var ev = JSON.parse(e.data);
        processEvent(ev);
        // Show tool name as bubble for activity feedback.
        if (ev.hook_event_name === 'PreToolUse' && ev.tool_name) {
          addBubble(ev.agent_id || '_main', ev.tool_name, 'assistant');
        }
      } catch (err) { /* ignore */ }
    };
  }

  function stopLive() {
    if (eventSource) { eventSource.close(); eventSource = null; }
  }

  // ── Replay Mode ──────────────────────────────────────────────

  function startReplay(timelineData, speed) {
    replayEvents = buildReplayEvents(timelineData);
    if (!replayEvents.length) return;
    replayIdx = 0;
    replaySpeed = speed || 1;
    replayPaused = false;
    replayStartTs = replayEvents[0].ts;
    replayEndTs = replayEvents[replayEvents.length - 1].ts;
    replayCurrentTs = replayStartTs;
    scheduleNext();
  }

  function buildReplayEvents(timeline) {
    var evs = [];
    for (var i = 0; i < timeline.length; i++) {
      var item = timeline[i];
      if (item.source === 'tool_pair') {
        evs.push({ ts: item.data.start_ts, hook_event_name: 'PreToolUse',
          tool_name: item.data.tool_name, tool_use_id: item.data.tool_use_id,
          agent_id: item.data.agent_id || '', agent_type: item.data.agent_type || '' });
        evs.push({ ts: item.data.end_ts,
          hook_event_name: item.data.failed ? 'PostToolUseFailure' : 'PostToolUse',
          tool_use_id: item.data.tool_use_id, agent_id: item.data.agent_id || '' });
      } else if (item.source === 'hook') {
        evs.push({ ts: item.ts, hook_event_name: item.data.event_type,
          tool_name: item.data.tool_name, tool_use_id: item.data.tool_use_id,
          agent_id: item.data.agent_id || '', agent_type: item.data.agent_type || '' });
      } else if (item.source === 'message') {
        var mt = item.data.message_type;
        if (mt === 'user' || mt === 'assistant' || mt === 'thinking') {
          evs.push({ ts: item.ts, hook_event_name: '_msg',
            _msgType: mt, _text: item.data.content || '', _agentId: '_main' });
        }
      }
    }
    evs.sort(function (a, b) { return a.ts - b.ts; });
    return evs;
  }

  function scheduleNext() {
    if (replayIdx >= replayEvents.length || replayPaused) return;
    var ev = replayEvents[replayIdx];
    processEvent(ev);
    replayCurrentTs = ev.ts;
    replayIdx++;
    if (replayIdx < replayEvents.length) {
      var delay = (replayEvents[replayIdx].ts - ev.ts) / replaySpeed;
      delay = Math.max(16, Math.min(delay, 2000));
      replayTimer = setTimeout(scheduleNext, delay);
    }
  }

  function seekTo(fraction) {
    // Reset scene and fast-forward to target time.
    var targetTs = replayStartTs + fraction * (replayEndTs - replayStartTs);
    clearTimeout(replayTimer);
    agents = {}; edges = {}; toolCalls = {}; particles = []; bubbles = [];
    agentToolCounts = {}; selectedId = null;
    replayIdx = 0;
    // Fast-forward without animation delays.
    while (replayIdx < replayEvents.length && replayEvents[replayIdx].ts <= targetTs) {
      processEvent(replayEvents[replayIdx]);
      replayIdx++;
    }
    replayCurrentTs = targetTs;
    if (!replayPaused) scheduleNext();
  }

  // ── Click Handling ───────────────────────────────────────────

  function onClick(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = (e.clientX - rect.left), my = (e.clientY - rect.top);

    // Check scrubber click (replay mode).
    if (mode === 'replay' && replayEndTs > replayStartTs) {
      var h = canvas.height / dpr;
      var barY = h - 36, barX = 60, barW = canvas.width / dpr - 120;
      if (my >= barY - 8 && my <= barY + 16 && mx >= barX && mx <= barX + barW) {
        seekTo((mx - barX) / barW);
        return;
      }
    }

    // Check agent click.
    var closest = null, closestDist = Infinity;
    for (var aid in agents) {
      var a = agents[aid];
      var dx = mx - a.x, dy = my - a.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < a.r + 5 && dist < closestDist) { closest = aid; closestDist = dist; }
    }
    selectedId = closest; // null deselects
  }

  // ── Public API ───────────────────────────────────────────────

  function open(m, opts) {
    mode = m;
    var overlay = document.getElementById('agent-canvas-overlay');
    overlay.style.display = 'flex';
    canvas = document.getElementById('agent-canvas');
    ctx = canvas.getContext('2d');
    resize();
    agents = {}; edges = {}; toolCalls = {}; particles = []; bubbles = [];
    agentToolCounts = {}; selectedId = null;
    lastTime = performance.now();
    animFrame = requestAnimationFrame(tick);
    canvas.addEventListener('click', onClick);
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', onKey);

    canvasSessionId = opts.sessionId || (opts.timelineData && opts.timelineData.length > 0 ? 'replay' : '');
    canvasMode = m;
    renderControls();

    // Create main agent immediately so canvas isn't empty.
    addAgent('_main', 'main', true);
    agents['_main'].state = 'thinking';

    if (m === 'live') {
      startLive(opts.sessionId);
    } else {
      startReplay(opts.timelineData || [], opts.speed);
    }
  }

  function close() {
    stopLive();
    clearTimeout(replayTimer);
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey);
    document.getElementById('agent-canvas-overlay').style.display = 'none';
    mode = null;
  }

  function resize() {
    if (!canvas) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.scale(dpr, dpr);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === ' ' && mode === 'replay') { e.preventDefault(); togglePause(); }
  }

  function renderControls() {
    var bar = document.getElementById('agent-canvas-controls');
    var html = '';
    if (mode === 'replay') {
      html += '<button onclick="AgentCanvas.togglePause()" id="ac-pause-btn">\u23F8</button>';
      html += '<select onchange="AgentCanvas.setSpeed(Number(this.value))">';
      html += '<option value="0.5">0.5x</option><option value="1" selected>1x</option>';
      html += '<option value="2">2x</option><option value="5">5x</option>';
      html += '<option value="10">10x</option><option value="20">20x</option></select>';
    } else {
      html += '<span class="ac-live-dot"></span> Live';
    }
    html += '<button onclick="AgentCanvas.close()" class="ac-close">\u2715</button>';
    bar.innerHTML = html;
  }

  function togglePause() {
    replayPaused = !replayPaused;
    var btn = document.getElementById('ac-pause-btn');
    if (btn) btn.textContent = replayPaused ? '\u25B6' : '\u23F8';
    if (!replayPaused) scheduleNext();
  }

  function setSpeed(s) { replaySpeed = s || 1; }

  return { open: open, close: close, togglePause: togglePause, setSpeed: setSpeed };
})();
