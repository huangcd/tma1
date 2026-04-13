// prompts.js — Prompt Evaluation & Improvement view
// Depends on: core.js (query, rows, rowsToObjects, fmtNum, fmtCost, escapeHTML, intervalSQL, loadPricing, costCaseSQL),
//             chart.js (renderUPlot), i18n.js (t)

var prPage = 0;
var prPageSize = 50;
var prHasNext = false;
var prSort = 'time'; // 'time' | 'score' | 'cost'
var prScoreFilter = 'all'; // 'all' | 'poor' | 'fair' | 'good' | 'excellent'
var prPromptData = []; // cached scored prompts for current page
var prSessionStats = {}; // session_id → {turns, totalInput, totalOutput, cacheRead, model}
var prToolStats = {};    // session_id → {ok, fail}
var prToolSequences = {}; // session_id → [{tool, ok, inputPrefix}, ...]
var prAllScores = [];    // all composite scores for distribution
var prLLMAvailable = null; // null = unchecked, true/false
var prExpandedIdx = -1;

// pr_sourceSQL returns a WHERE clause fragment for agent_source filtering.
// Uses session_id IN (SELECT ...) to filter tma1_messages by agent_source from tma1_hook_events.
function pr_sourceSQL() {
  var el = document.getElementById('pr-source-filter');
  if (!el || !el.value) return '';
  var iv = intervalSQL();
  return " AND session_id IN (SELECT DISTINCT session_id FROM tma1_hook_events WHERE agent_source = '" + escapeSQLString(el.value) + "' AND ts > NOW() - INTERVAL '" + iv + "')";
}

function pr_reload() {
  prDataCache = null;
  prPromptData = [];
  prPage = 0;
  prExpandedIdx = -1;
  pr_loadCards().then(function(ok) {
    if (!ok) return;
    pr_loadData().then(function() {
      pr_loadOverview();
      pr_loadPrompts();
      pr_loadPatterns();
    });
  });
}

// ============================================================
// Scoring Engine
// ============================================================

var PR_FILE_EXTS = /\.(go|ts|tsx|js|jsx|rs|py|java|rb|cpp|c|h|css|html|sql|yaml|yml|json|toml|md|sh|bash|zsh|proto|graphql)\b/i;
var PR_PATH_PATTERN = /(?:^|\s|['"`])[.~]?\/[\w\-./]+/g;
var PR_PATH_PATTERN_TEST = /(?:^|\s|['"`])[.~]?\/[\w\-./]+/;
var PR_IDENT_PATTERN = /\b[a-z][a-zA-Z0-9]{3,}\b|\b[A-Z][a-zA-Z0-9]{3,}\b|\b[a-z]+_[a-z_]{2,}\b/g;
var PR_ERROR_KEYWORDS = /\b(error|failed|failure|panic|exception|traceback|stacktrace|crash|segfault|ENOENT|EPERM|EACCES|404|500|502|503)\b/i;
var PR_BACKTICK = /`[^`]{2,}`/g;
var PR_LINE_REF = /\b(?:line\s*\d+|L\d+|:\d{2,})\b/i;
var PR_CODE_BLOCK = /```[\s\S]*?```/g;
var PR_STACK_TRACE = /^\s+at\s+/m;
var PR_TRACEBACK = /Traceback|File ".*", line \d+/;
var PR_BEHAVIOR_KEYWORDS = /\b(expected|actual|should|want|instead|currently|but\s+(?:it|the|I|we)|rather|supposed\s+to)\b/i;
var PR_BEHAVIOR_KEYWORDS_G = /\b(expected|actual|should|want|instead|currently|but\s+(?:it|the|I|we)|rather|supposed\s+to)\b/gi;
var PR_QUOTED_STRINGS = /"[^"]{15,}"|'[^']{15,}'/g;

var PR_EXPLORATION_TOOLS = ['Read', 'Grep', 'Glob', 'Search', 'Agent'];
var PR_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
var PR_FILE_PATH_IN_JSON = /"file_path"\s*:\s*"([^"]+)"/;

var PR_VERBS = ['fix', 'add', 'implement', 'refactor', 'debug', 'explain', 'update', 'remove', 'test', 'review', 'create', 'change', 'move', 'rename', 'optimize', 'migrate', 'upgrade', 'setup', 'configure', 'deploy', 'write', 'build', 'run', 'check', 'find', 'search', 'read', 'show', 'list', 'help'];

// --- Behavior Pattern Detection (Layer 3) ---

function pr_detectPatterns(toolSeq, sessionTokens) {
  if (!toolSeq || toolSeq.length === 0) return { patterns: [], stats: {} };

  var patterns = [];

  // 1. Exploration loop: >=4 consecutive exploration tool calls
  var maxExplRun = 0, explRun = 0;
  toolSeq.forEach(function(t) {
    if (PR_EXPLORATION_TOOLS.indexOf(t.tool) !== -1) explRun++;
    else { maxExplRun = Math.max(maxExplRun, explRun); explRun = 0; }
  });
  maxExplRun = Math.max(maxExplRun, explRun);
  if (maxExplRun >= 4) patterns.push({ type: 'exploration_loop', count: maxExplRun });

  // 2. Edit retry: same file edited >2 times
  var editFiles = {};
  toolSeq.forEach(function(t) {
    if (PR_EDIT_TOOLS.indexOf(t.tool) !== -1 && t.inputPrefix) {
      var m = t.inputPrefix.match(PR_FILE_PATH_IN_JSON);
      var path = m ? m[1] : null;
      if (path) editFiles[path] = (editFiles[path] || 0) + 1;
    }
  });
  var editVals = Object.values(editFiles);
  var maxEdits = editVals.length > 0 ? Math.max.apply(null, editVals) : 0;
  if (maxEdits > 2) patterns.push({ type: 'edit_retry', count: maxEdits });

  // 3. Consecutive failures: >=3 in a row
  var maxFailRun = 0, failRun = 0;
  toolSeq.forEach(function(t) {
    if (!t.ok) failRun++;
    else { maxFailRun = Math.max(maxFailRun, failRun); failRun = 0; }
  });
  maxFailRun = Math.max(maxFailRun, failRun);
  if (maxFailRun >= 3) patterns.push({ type: 'consecutive_failures', count: maxFailRun });

  // 4. High absolute cost
  if (sessionTokens > 100000) patterns.push({ type: 'high_cost', tokens: sessionTokens });

  // Stats for dimension scoring
  var explCount = toolSeq.filter(function(t) { return PR_EXPLORATION_TOOLS.indexOf(t.tool) !== -1; }).length;
  return {
    patterns: patterns,
    stats: {
      explorationRatio: toolSeq.length > 0 ? explCount / toolSeq.length : 0,
      maxExplRun: maxExplRun,
      maxEdits: maxEdits,
      maxFailRun: maxFailRun,
    },
  };
}

// --- Dimension Scoring (refined, count-based) ---

function pr_scoreSpecificity(content) {
  var score = 0;
  // File paths: count matches
  var paths = (content.match(PR_PATH_PATTERN) || []);
  if (PR_FILE_EXTS.test(content)) paths.push('ext'); // add 1 for file extension mention
  if (paths.length >= 3) score += 25;
  else if (paths.length >= 1) score += 15;

  // Identifiers: count unique
  var idents = content.match(PR_IDENT_PATTERN) || [];
  var uniqueIdents = new Set(idents).size;
  if (uniqueIdents >= 3) score += 20;
  else if (uniqueIdents >= 1) score += 10;

  // Error/log info
  if (PR_ERROR_KEYWORDS.test(content)) score += 10;
  if ((content.match(PR_QUOTED_STRINGS) || []).length > 0) score += 10;

  // Line references
  if (PR_LINE_REF.test(content)) score += 15;

  // Backtick code spans: count
  var ticks = (content.match(PR_BACKTICK) || []).length;
  if (ticks >= 3) score += 20;
  else if (ticks >= 1) score += 10;

  return Math.min(score, 100);
}

function pr_scoreContext(content, behaviorStats) {
  var score = 0;
  // Code blocks: count and size
  var blocks = content.match(PR_CODE_BLOCK) || [];
  if (blocks.length > 0) {
    var codeLen = blocks.reduce(function(a, b) { return a + b.length; }, 0);
    score += codeLen > 200 ? 30 : 20;
  }

  // Stack trace / error log
  if (PR_STACK_TRACE.test(content) || PR_TRACEBACK.test(content)) score += 15;

  // Behavioral spec: count keyword hits
  var behaviorHits = (content.match(PR_BEHAVIOR_KEYWORDS_G) || []).length;
  score += Math.min(behaviorHits * 7, 20);

  // Length: smoother curve
  if (content.length > 100) score += 5;
  if (content.length > 250) score += 5;
  if (content.length > 500) score += 5;
  if (content.length > 1000) score += 5;
  if (content.length > 3000) score -= 10; // likely pasted whole file

  // Behavior signal: high exploration ratio = insufficient context provided
  if (behaviorStats && behaviorStats.explorationRatio > 0.6) score -= 15;
  else if (behaviorStats && behaviorStats.explorationRatio > 0.4) score -= 8;

  return Math.max(0, Math.min(score, 100));
}

function pr_scoreClarity(turns, toolFailures, detection) {
  var score;
  if (turns <= 1) score = 100;
  else if (turns <= 2) score = 85;
  else if (turns <= 3) score = 70;
  else if (turns <= 5) score = 50;
  else score = Math.max(15, 60 - turns * 6);

  score -= Math.min((toolFailures || 0) * 4, 20);

  // Behavior pattern penalties
  if (detection && detection.patterns) {
    detection.patterns.forEach(function(p) {
      if (p.type === 'exploration_loop') score -= 10;
      if (p.type === 'edit_retry') score -= 8;
    });
  }

  return Math.max(0, Math.min(100, score));
}

// allTokensSorted must be pre-sorted ascending.
function pr_scoreCostEfficiency(sessionTokens, allTokensSorted) {
  if (!allTokensSorted || allTokensSorted.length === 0) return 50;
  var rank = 0;
  for (var i = 0; i < allTokensSorted.length; i++) {
    if (allTokensSorted[i] <= sessionTokens) rank = i;
  }
  var relativeScore = Math.round(100 - (rank / allTokensSorted.length * 100));

  // Absolute penalty for expensive sessions
  if (sessionTokens > 200000) relativeScore -= 20;
  else if (sessionTokens > 100000) relativeScore -= 10;

  return Math.max(0, relativeScore);
}

function pr_scoreToolEfficiency(ok, fail) {
  if (ok + fail === 0) return 70;
  return Math.round(ok / (ok + fail) * 100);
}

function pr_scoreComposite(dims) {
  return Math.round(
    dims.specificity * 0.20 +
    dims.context * 0.15 +
    dims.clarity * 0.30 +
    dims.costEfficiency * 0.20 +
    dims.toolEfficiency * 0.15
  );
}

function pr_scoreTier(score) {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 40) return 'fair';
  return 'poor';
}

function pr_tierColor(tier) {
  switch (tier) {
    case 'excellent': return 'var(--green)';
    case 'good': return 'var(--blue)';
    case 'fair': return 'var(--yellow)';
    default: return 'var(--red)';
  }
}

function pr_scorePrompt(content, sess, tools, toolSeq, allTokensSorted) {
  var turns = sess ? sess.turns : 1;
  var totalTokens = sess ? (sess.totalInput + sess.totalOutput) : 0;
  var toolOk = tools ? tools.ok : 0;
  var toolFail = tools ? tools.fail : 0;

  // Detect behavioral patterns once, reuse across dimensions
  var detection = pr_detectPatterns(toolSeq, totalTokens);

  var dims = {
    specificity: pr_scoreSpecificity(content),
    context: pr_scoreContext(content, detection.stats),
    clarity: pr_scoreClarity(turns, toolFail, detection),
    costEfficiency: pr_scoreCostEfficiency(totalTokens, allTokensSorted),
    toolEfficiency: pr_scoreToolEfficiency(toolOk, toolFail),
  };
  dims.composite = pr_scoreComposite(dims);
  dims._patterns = detection.patterns; // attached for suggestion generation
  dims._stats = detection.stats;
  return dims;
}

// ============================================================
// Suggestion Rules
// ============================================================

function pr_getSuggestions(content, dims, sess, tools) {
  var suggestions = [];
  var turns = sess ? sess.turns : 1;
  var toolFail = tools ? tools.fail : 0;
  var cacheRead = sess ? sess.cacheRead : 0;
  var totalInput = sess ? sess.totalInput : 0;

  // Behavior pattern suggestions (highest signal)
  if (dims._patterns) {
    dims._patterns.forEach(function(p) {
      if (p.type === 'exploration_loop') {
        suggestions.push(t('pr.sug.exploration_loop').replace('{N}', p.count));
      } else if (p.type === 'edit_retry') {
        suggestions.push(t('pr.sug.edit_retry').replace('{N}', p.count));
      } else if (p.type === 'consecutive_failures') {
        suggestions.push(t('pr.sug.consec_fail').replace('{N}', p.count));
      } else if (p.type === 'high_cost') {
        suggestions.push(t('pr.sug.high_cost').replace('{N}', Math.round(p.tokens / 1000)));
      }
    });
  }

  // Content-based suggestions
  if (dims.specificity < 40 && !PR_PATH_PATTERN_TEST.test(content) && !PR_FILE_EXTS.test(content)) {
    suggestions.push(t('pr.sug.no_paths'));
  }
  if (content.length < 50 && dims.specificity < 30) {
    suggestions.push(t('pr.sug.vague'));
  }
  if (content.length > 3000) {
    suggestions.push(t('pr.sug.too_long').replace('{N}', content.length));
  }
  if (dims.clarity < 40 && !(dims._patterns && dims._patterns.some(function(p) { return p.type === 'exploration_loop'; }))) {
    suggestions.push(t('pr.sug.high_turns').replace('{N}', turns));
  }
  if (dims.context < 30) {
    suggestions.push(t('pr.sug.no_code'));
  }
  if (dims.toolEfficiency < 50 && toolFail > 0) {
    suggestions.push(t('pr.sug.tool_fails').replace('{N}', toolFail));
  }
  if (!PR_BEHAVIOR_KEYWORDS.test(content)) {
    suggestions.push(t('pr.sug.no_behavior'));
  }
  if (totalInput > 0 && cacheRead / totalInput < 0.1) {
    suggestions.push(t('pr.sug.cache_low'));
  }
  return suggestions.slice(0, 5); // max 5 (raised from 4)
}

// ============================================================
// Data Loading
// ============================================================

var prTotalPrompts = 0; // full count from DB (may exceed analyzed)
var prDataCache = null; // { range: string, data: scored[] }
var prDataGeneration = 0; // incremented on each pr_loadData(), used as AI insights cache key

async function pr_loadCards() {
  prDataCache = null; // invalidate on every cards reload (refresh / time range change)
  prPromptData = [];  // force pr_loadData() re-fetch (don't let AI Insights use stale data)
  var iv = intervalSQL();
  try {
    var res = await query(
      "SELECT COUNT(*) AS total_prompts, COUNT(DISTINCT session_id) AS sessions " +
      "FROM tma1_messages WHERE message_type = 'user' AND ts > NOW() - INTERVAL '" + iv + "'" + pr_sourceSQL()
    );
    var r = rows(res);
    if (!r || !r[0]) return false;
    prTotalPrompts = Number(r[0][0]) || 0;
    var totalSessions = Number(r[0][1]) || 0;
    if (prTotalPrompts === 0) return false;

    document.getElementById('pr-val-prompts').textContent = fmtNum(prTotalPrompts);
    document.getElementById('pr-val-turns').textContent = totalSessions > 0 ? (prTotalPrompts / totalSessions).toFixed(1) : '\u2014';

    return true;
  } catch (e) {
    return false;
  }
}

async function pr_loadData() {
  // Return cached data if time range hasn't changed.
  if (prDataCache && prDataCache.range === currentTimeRange) {
    prAllScores = prDataCache.data.map(function(s) { return s.dims.composite; });
    return prDataCache.data;
  }

  var iv = intervalSQL();

  // Q1: User prompts
  var promptRes = await query(
    "SELECT session_id, ts, content, model FROM tma1_messages " +
    "WHERE message_type = 'user' AND ts > NOW() - INTERVAL '" + iv + "'" + pr_sourceSQL() +
    " ORDER BY ts DESC LIMIT 500"
  );
  var prompts = rowsToObjects(promptRes);
  if (!prompts || prompts.length === 0) return [];

  // Unique session IDs
  var sidSet = {};
  prompts.forEach(function(p) { sidSet[p.session_id] = true; });
  var sids = Object.keys(sidSet);
  var sidList = sids.map(function(s) { return "'" + escapeSQLString(s) + "'"; }).join(',');

  // Q2 + Q3 + Q4 in parallel
  var results = await Promise.all([
    query(
      "SELECT session_id, " +
      "SUM(CASE WHEN message_type = 'user' THEN 1 ELSE 0 END) AS user_turns, " +
      "SUM(COALESCE(input_tokens, 0)) AS total_input, " +
      "SUM(COALESCE(output_tokens, 0)) AS total_output, " +
      "SUM(COALESCE(cache_read_tokens, 0)) AS total_cache_read, " +
      "MAX(model) AS model " +
      "FROM tma1_messages WHERE session_id IN (" + sidList + ") GROUP BY session_id"
    ),
    query(
      "SELECT session_id, " +
      "SUM(CASE WHEN event_type = 'PostToolUse' THEN 1 ELSE 0 END) AS tool_ok, " +
      "SUM(CASE WHEN event_type IN ('PostToolUseFailure','ToolError') THEN 1 ELSE 0 END) AS tool_fail " +
      "FROM tma1_hook_events WHERE session_id IN (" + sidList + ") GROUP BY session_id"
    ).catch(function() { return null; }),
    // Q4: Tool call sequence for behavioral pattern detection.
    // Include PreToolUse (Codex stores tool_name/input there). Pair via tool_use_id.
    query(
      "SELECT session_id, tool_name, event_type, tool_use_id, " +
      "LEFT(tool_input, 200) AS tool_input_prefix " +
      "FROM tma1_hook_events WHERE session_id IN (" + sidList + ") " +
      "AND event_type IN ('PreToolUse','PostToolUse','PostToolUseFailure') " +
      "ORDER BY session_id, ts LIMIT 8000"
    ).catch(function() { return null; }),
  ]);

  // Build lookup maps
  prSessionStats = {};
  rowsToObjects(results[0]).forEach(function(r) {
    prSessionStats[r.session_id] = {
      turns: Number(r.user_turns) || 1,
      totalInput: Number(r.total_input) || 0,
      totalOutput: Number(r.total_output) || 0,
      cacheRead: Number(r.total_cache_read) || 0,
      model: r.model || '',
    };
  });

  prToolStats = {};
  if (results[1]) {
    rowsToObjects(results[1]).forEach(function(r) {
      prToolStats[r.session_id] = {
        ok: Number(r.tool_ok) || 0,
        fail: Number(r.tool_fail) || 0,
      };
    });
  }

  // Build tool sequence map for behavioral analysis.
  // Pair PreToolUse with PostToolUse/Failure by tool_use_id (handles interleaved/concurrent calls).
  prToolSequences = {};
  if (results[2]) {
    var pendingPre = {}; // tool_use_id → {tool, inputPrefix}
    rowsToObjects(results[2]).forEach(function(r) {
      var sid = r.session_id;
      var tuid = r.tool_use_id || '';
      if (r.event_type === 'PreToolUse') {
        if (tuid) pendingPre[tuid] = { tool: r.tool_name || '', inputPrefix: r.tool_input_prefix || '' };
      } else {
        // PostToolUse or PostToolUseFailure — pair with Pre by tool_use_id.
        if (!prToolSequences[sid]) prToolSequences[sid] = [];
        var pre = tuid ? pendingPre[tuid] : null;
        prToolSequences[sid].push({
          tool: r.tool_name || (pre ? pre.tool : '') || '',
          ok: r.event_type === 'PostToolUse',
          inputPrefix: r.tool_input_prefix || (pre ? pre.inputPrefix : '') || '',
        });
        if (tuid) delete pendingPre[tuid];
      }
    });
  }

  // Precompute sorted token list once for cost efficiency ranking.
  var allTokensSorted = Object.values(prSessionStats)
    .map(function(s) { return s.totalInput + s.totalOutput; })
    .sort(function(a, b) { return a - b; });

  // Score all prompts
  var scored = prompts.map(function(p) {
    var sess = prSessionStats[p.session_id];
    var tools = prToolStats[p.session_id];
    var toolSeq = prToolSequences[p.session_id] || null;
    var dims = pr_scorePrompt(p.content || '', sess, tools, toolSeq, allTokensSorted);
    return {
      sessionId: p.session_id,
      ts: p.ts,
      content: p.content || '',
      model: p.model || (sess ? sess.model : ''),
      dims: dims,
      sess: sess,
      tools: tools,
      toolSeq: toolSeq,
    };
  });

  prAllScores = scored.map(function(s) { return s.dims.composite; });
  prDataCache = { range: currentTimeRange, data: scored };
  prDataGeneration++;
  return scored;
}

// ============================================================
// Overview Tab
// ============================================================

async function pr_loadOverview() {
  var scored = await pr_loadData();
  if (!scored || scored.length === 0) return;

  // Update KPI: show analyzed count (may differ from total if truncated)
  if (scored.length < prTotalPrompts) {
    document.getElementById('pr-val-prompts').innerHTML = fmtNum(scored.length) +
      ' <span style="font-size:12px;color:var(--text-dim);font-weight:400">/ ' + fmtNum(prTotalPrompts) + '</span>';
  }

  // Update KPI: avg score
  var avgScore = Math.round(prAllScores.reduce(function(a, b) { return a + b; }, 0) / prAllScores.length);
  document.getElementById('pr-val-score').innerHTML = pr_renderScoreRing(avgScore, 44);

  // Avg cost per session
  await loadPricing();
  var sessionCosts = Object.entries(prSessionStats).map(function(entry) {
    var s = entry[1];
    var price = lookupPrice(s.model);
    return (s.totalInput * price.i + s.totalOutput * price.o) / 1e6;
  });
  var avgCost = sessionCosts.length > 0 ? sessionCosts.reduce(function(a, b) { return a + b; }, 0) / sessionCosts.length : 0;
  document.getElementById('pr-val-cost').textContent = fmtCost(avgCost);

  // Score distribution (4 buckets)
  var buckets = [0, 0, 0, 0]; // poor, fair, good, excellent
  prAllScores.forEach(function(s) {
    if (s >= 90) buckets[3]++;
    else if (s >= 70) buckets[2]++;
    else if (s >= 40) buckets[1]++;
    else buckets[0]++;
  });
  pr_renderDistribution(buckets);

  // Score trend
  pr_renderTrend(scored);

  // Top suggestions
  pr_renderTopSuggestions(scored);

  // Dimension breakdown
  pr_renderDimensionBreakdown(scored);

  // AI Insights container (only when LLM configured)
  var aiContainer = document.getElementById('pr-ai-container');
  if (aiContainer) aiContainer.style.display = prLLMAvailable ? '' : 'none';
}

function pr_renderDistribution(buckets) {
  var el = document.getElementById('pr-chart-distribution');
  var labels = [t('pr.tier.poor'), t('pr.tier.fair'), t('pr.tier.good'), t('pr.tier.excellent')];
  var colors = ['var(--red)', 'var(--yellow)', 'var(--blue)', 'var(--green)'];
  var max = Math.max.apply(null, buckets) || 1;

  var html = '<div class="bar-chart">';
  for (var i = 0; i < 4; i++) {
    var pct = buckets[i] / max * 100;
    html += '<div class="bar-row">' +
      '<div class="bar-label">' + labels[i] + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:' + colors[i] + '"></div></div>' +
      '<div class="bar-value">' + buckets[i] + '</div></div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function pr_renderTrend(scored) {
  var el = document.getElementById('pr-chart-trend');
  // Group by day
  var dayMap = {};
  scored.forEach(function(s) {
    var day = new Date(tsToMs(s.ts)).toISOString().slice(0, 10);
    if (!dayMap[day]) dayMap[day] = [];
    dayMap[day].push(s.dims.composite);
  });

  var days = Object.keys(dayMap).sort();
  if (days.length < 2) {
    el.innerHTML = '<div class="chart-empty">' + t('pr.trend.not_enough') + '</div>';
    return;
  }

  var timestamps = days.map(function(d) { return new Date(d).getTime() / 1000; });
  var avgs = days.map(function(d) {
    var arr = dayMap[d];
    return Math.round(arr.reduce(function(a, b) { return a + b; }, 0) / arr.length);
  });

  el.innerHTML = '';
  if (chartInstances['pr-chart-trend']) chartInstances['pr-chart-trend'].destroy();
  var opts = {
    width: el.clientWidth || 500,
    height: 200,
    series: [
      {},
      { label: t('pr.avg_score'), stroke: 'var(--blue)', width: 2, fill: 'rgba(121,192,255,0.1)' },
    ],
    axes: [
      { stroke: 'var(--text-dim)', grid: { stroke: 'var(--border)' } },
      { stroke: 'var(--text-dim)', grid: { stroke: 'var(--border)' }, values: function(u, vals) { return vals.map(function(v) { return v != null ? v : ''; }); } },
    ],
    scales: { y: { min: 0, max: 100 } },
  };
  chartInstances['pr-chart-trend'] = new uPlot(opts, [timestamps, avgs], el);
}

function pr_renderTopSuggestions(scored) {
  var el = document.getElementById('pr-chart-suggestions');
  // Count suggestion frequency
  var counts = {};
  scored.forEach(function(s) {
    var suggestions = pr_getSuggestions(s.content, s.dims, s.sess, s.tools);
    suggestions.forEach(function(sug) {
      counts[sug] = (counts[sug] || 0) + 1;
    });
  });

  var sorted = Object.entries(counts).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 5);
  if (sorted.length === 0) {
    el.innerHTML = '<div class="chart-empty">' + t('pr.no_suggestions') + '</div>';
    return;
  }

  var total = scored.length;
  var html = '';
  sorted.forEach(function(entry, i) {
    var pct = Math.round(entry[1] / total * 100);
    html += '<div class="pr-sug-card">' +
      '<div class="pr-sug-card-head">' +
        '<span class="pr-sug-rank">' + (i + 1) + '</span>' +
        '<span class="pr-sug-badge">' + pct + '% ' + t('pr.of_prompts') + '</span>' +
      '</div>' +
      '<div class="pr-sug-card-body">' + escapeHTML(entry[0]) + '</div>' +
    '</div>';
  });
  el.innerHTML = html;
}

function pr_renderDimensionBreakdown(scored) {
  var el = document.getElementById('pr-chart-dimensions');
  var dims = ['specificity', 'context', 'clarity', 'costEfficiency', 'toolEfficiency'];
  var labels = [t('pr.dim.spec'), t('pr.dim.ctx'), t('pr.dim.clarity'), t('pr.dim.cost'), t('pr.dim.tool')];
  var descs = [t('pr.dim.spec_desc'), t('pr.dim.ctx_desc'), t('pr.dim.clarity_desc'), t('pr.dim.cost_desc'), t('pr.dim.tool_desc')];

  var avgs = dims.map(function(d) {
    var sum = scored.reduce(function(a, s) { return a + s.dims[d]; }, 0);
    return Math.round(sum / scored.length);
  });

  var html = '';
  for (var i = 0; i < dims.length; i++) {
    var tier = pr_scoreTier(avgs[i]);
    var color = pr_tierColor(tier);
    html += '<div class="pr-dim-card">' +
      '<div class="pr-dim-card-head">' +
        '<span class="pr-dim-card-label">' + labels[i] + '</span>' +
        '<span class="pr-dim-card-val" style="color:' + color + '">' + avgs[i] + ' / 100</span>' +
      '</div>' +
      '<div class="bar-track" style="height:6px;border-radius:3px"><div class="bar-fill" style="width:' + avgs[i] + '%;background:' + color + ';border-radius:3px"></div></div>' +
      '<div class="pr-dim-card-desc">' + escapeHTML(descs[i]) + '</div>' +
    '</div>';
  }
  el.innerHTML = html;
}

// ============================================================
// Prompts Tab
// ============================================================

async function pr_loadPrompts() {
  var scored = await pr_loadData();
  if (!scored || scored.length === 0) {
    document.getElementById('pr-prompt-list').innerHTML = '<div class="chart-empty">' + t('empty.waiting') + '</div>';
    return;
  }

  // Filter
  if (prScoreFilter !== 'all') {
    scored = scored.filter(function(s) { return pr_scoreTier(s.dims.composite) === prScoreFilter; });
  }

  // Sort
  if (prSort === 'score') {
    scored.sort(function(a, b) { return a.dims.composite - b.dims.composite; });
  } else if (prSort === 'cost') {
    scored.sort(function(a, b) {
      var ca = (a.sess ? a.sess.totalInput + a.sess.totalOutput : 0);
      var cb = (b.sess ? b.sess.totalInput + b.sess.totalOutput : 0);
      return cb - ca;
    });
  }
  // else time (already sorted by ts DESC)

  prPromptData = scored;

  // Paginate
  var start = prPage * prPageSize;
  var page = scored.slice(start, start + prPageSize);
  prHasNext = scored.length > start + prPageSize;

  pr_renderPromptCards(page, start);
  pr_renderPagination(scored.length);
}

function pr_renderPromptCards(pageData, startIdx) {
  var container = document.getElementById('pr-prompt-list');
  if (pageData.length === 0) {
    container.innerHTML = '<div class="chart-empty">' + t('pr.no_prompts') + '</div>';
    return;
  }

  var html = '';
  pageData.forEach(function(p, i) {
    var idx = startIdx + i;
    var tier = pr_scoreTier(p.dims.composite);
    var expanded = prExpandedIdx === idx;
    var relTime = pr_relativeTime(p.ts);
    var turns = p.sess ? p.sess.turns : 1;
    var cost = 0;
    if (p.sess) {
      var price = lookupPrice(p.model);
      cost = (p.sess.totalInput * price.i + p.sess.totalOutput * price.o) / 1e6;
    }

    html += '<div class="pr-card' + (expanded ? ' expanded' : '') + '" data-idx="' + idx + '" onclick="pr_toggleCard(' + idx + ')">';
    html += '<div class="pr-card-header">';
    html += '<div class="pr-score-dot ' + tier + '">' + p.dims.composite + '</div>';
    html += '<div class="pr-card-meta">';
    html += '<span>' + escapeHTML(relTime) + '</span>';
    html += '<span class="pr-sep">\u00b7</span>';
    html += '<span>' + escapeHTML(p.model || t('pr.unknown_model')) + '</span>';
    html += '<span class="pr-sep">\u00b7</span>';
    html += '<span>' + turns + ' ' + (turns === 1 ? t('pr.turn') : t('pr.turns')) + '</span>';
    html += '<span class="pr-sep">\u00b7</span>';
    html += '<span>' + fmtCost(cost) + '</span>';
    html += '</div></div>';
    html += '<div class="pr-card-content">' + escapeHTML(p.content) + '</div>';

    if (expanded) {
      html += pr_renderDetail(p);
    }
    html += '</div>';
  });

  container.innerHTML = html;
}

function pr_renderDetail(p) {
  var dims = p.dims;
  var suggestions = pr_getSuggestions(p.content, dims, p.sess, p.tools);
  var dimNames = ['specificity', 'context', 'clarity', 'costEfficiency', 'toolEfficiency'];
  var dimLabels = [t('pr.dim.spec'), t('pr.dim.ctx'), t('pr.dim.clarity'), t('pr.dim.cost'), t('pr.dim.tool')];

  var html = '<div class="pr-detail">';

  // Dimension bars
  html += '<div class="pr-dims">';
  for (var i = 0; i < dimNames.length; i++) {
    var val = dims[dimNames[i]];
    var tier = pr_scoreTier(val);
    var color = pr_tierColor(tier);
    html += '<div class="pr-dim-row">' +
      '<div class="pr-dim-label">' + dimLabels[i] + '</div>' +
      '<div class="pr-dim-track"><div class="pr-dim-fill" style="width:' + val + '%;background:' + color + '"></div></div>' +
      '<div class="pr-dim-val">' + val + '</div></div>';
  }
  html += '</div>';

  // Suggestions
  if (suggestions.length > 0) {
    html += '<div class="pr-suggestions">';
    html += '<div class="pr-suggestions-title">' + t('pr.suggestions') + '</div>';
    suggestions.forEach(function(s) {
      html += '<div class="pr-suggestion-item">' + escapeHTML(s) + '</div>';
    });
    html += '</div>';
  }

  // LLM evaluate button
  if (prLLMAvailable) {
    html += '<button class="pr-eval-btn" onclick="event.stopPropagation(); pr_evaluate(' + prPromptData.indexOf(p) + ')" id="pr-eval-btn-' + prPromptData.indexOf(p) + '">' + t('pr.deep_evaluate') + '</button>';
    html += '<div id="pr-llm-result-' + prPromptData.indexOf(p) + '"></div>';
  }

  html += '</div>';
  return html;
}

function pr_toggleCard(idx) {
  prExpandedIdx = prExpandedIdx === idx ? -1 : idx;
  var start = prPage * prPageSize;
  var page = prPromptData.slice(start, start + prPageSize);
  pr_renderPromptCards(page, start);
}

function pr_renderPagination(total) {
  var el = document.getElementById('pr-pagination');
  var totalPages = Math.ceil(total / prPageSize);
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  el.innerHTML =
    '<button class="filter-btn" onclick="pr_prevPage()" ' + (prPage === 0 ? 'disabled' : '') + '>\u2190 ' + t('pr.prev') + '</button>' +
    ' <span style="color:var(--text-muted);font-size:13px">' + (prPage + 1) + ' / ' + totalPages + '</span> ' +
    '<button class="filter-btn" onclick="pr_nextPage()" ' + (!prHasNext ? 'disabled' : '') + '>' + t('pr.next') + ' \u2192</button>';
}

function pr_prevPage() { if (prPage > 0) { prPage--; pr_loadPrompts(); } }
function pr_nextPage() { if (prHasNext) { prPage++; pr_loadPrompts(); } }

function pr_onSortChange(val) {
  prSort = val;
  prPage = 0;
  prExpandedIdx = -1;
  pr_loadPrompts();
}

function pr_onScoreFilterChange(val) {
  prScoreFilter = val;
  prPage = 0;
  prExpandedIdx = -1;
  pr_loadPrompts();
}

// ============================================================
// Patterns Tab
// ============================================================

async function pr_loadPatterns() {
  var scored = await pr_loadData();
  if (!scored || scored.length === 0) {
    document.getElementById('pr-pattern-content').innerHTML = '<div class="chart-empty">' + t('empty.waiting') + '</div>';
    return;
  }

  // Extract verb from prompt content
  var patterns = {};
  scored.forEach(function(s) {
    var verb = pr_extractVerb(s.content);
    if (!patterns[verb]) patterns[verb] = { count: 0, scores: [], costs: [], turns: [] };
    patterns[verb].count++;
    patterns[verb].scores.push(s.dims.composite);
    var cost = 0;
    if (s.sess) {
      var price = lookupPrice(s.model);
      cost = (s.sess.totalInput * price.i + s.sess.totalOutput * price.o) / 1e6;
    }
    patterns[verb].costs.push(cost);
    patterns[verb].turns.push(s.sess ? s.sess.turns : 1);
  });

  var sorted = Object.entries(patterns).sort(function(a, b) { return b[1].count - a[1].count; }).slice(0, 12);
  var maxCount = sorted[0] ? sorted[0][1].count : 1;

  // Bar chart
  var barHtml = '<div class="bar-chart">';
  sorted.forEach(function(entry) {
    var pct = entry[1].count / maxCount * 100;
    barHtml += '<div class="bar-row">' +
      '<div class="bar-label">' + escapeHTML(entry[0]) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:var(--blue)"></div></div>' +
      '<div class="bar-value">' + entry[1].count + '</div></div>';
  });
  barHtml += '</div>';

  // Table
  var tableHtml = '<table><thead><tr>' +
    '<th>' + t('pr.pattern') + '</th><th>' + t('pr.count') + '</th><th>' + t('pr.avg_score') + '</th><th>' + t('pr.avg_cost') + '</th><th>' + t('pr.avg_turns') + '</th>' +
    '</tr></thead><tbody>';

  sorted.forEach(function(entry) {
    var p = entry[1];
    var avgScore = Math.round(p.scores.reduce(function(a, b) { return a + b; }, 0) / p.scores.length);
    var avgCost = p.costs.reduce(function(a, b) { return a + b; }, 0) / p.costs.length;
    var avgTurns = (p.turns.reduce(function(a, b) { return a + b; }, 0) / p.turns.length).toFixed(1);
    var tier = pr_scoreTier(avgScore);

    tableHtml += '<tr>' +
      '<td><strong>' + escapeHTML(entry[0]) + '</strong></td>' +
      '<td>' + p.count + '</td>' +
      '<td><span class="pr-score-dot-sm ' + tier + '">' + avgScore + '</span></td>' +
      '<td>' + fmtCost(avgCost) + '</td>' +
      '<td>' + avgTurns + '</td></tr>';
  });
  tableHtml += '</tbody></table>';

  // Insight
  var worstPattern = sorted.reduce(function(worst, entry) {
    var avg = entry[1].scores.reduce(function(a, b) { return a + b; }, 0) / entry[1].scores.length;
    if (!worst || avg < worst.avg) return { name: entry[0], avg: avg, cost: entry[1].costs.reduce(function(a, b) { return a + b; }, 0) / entry[1].costs.length };
    return worst;
  }, null);

  var insightHtml = '';
  if (worstPattern && worstPattern.avg < 60) {
    insightHtml = '<div class="pr-insight">' +
      t('pr.insight').replace('{pattern}', '<strong>' + escapeHTML(worstPattern.name) + '</strong>')
        .replace('{score}', Math.round(worstPattern.avg))
        .replace('{cost}', fmtCost(worstPattern.cost)) +
      '</div>';
  }

  document.getElementById('pr-pattern-content').innerHTML =
    '<div style="font-size:13px;color:var(--text-muted);margin-bottom:16px;line-height:1.5">' + t('pr.pattern_desc') + '</div>' +
    '<div class="chart-container"><h3>' + t('pr.pattern_distribution') + '</h3>' + barHtml + '</div>' +
    '<div class="chart-container"><h3>' + t('pr.pattern_table') + '</h3>' + tableHtml + '</div>' +
    insightHtml;
}

function pr_extractVerb(content) {
  var lower = (content || '').toLowerCase().trim();
  // Skip leading @, /, # etc.
  lower = lower.replace(/^[@/#!\-*]+\s*/, '');
  var words = lower.split(/\s+/);
  for (var i = 0; i < Math.min(words.length, 5); i++) {
    var w = words[i].replace(/[^a-z]/g, '');
    if (PR_VERBS.indexOf(w) !== -1) return w;
  }
  return 'other';
}

// ============================================================
// LLM Evaluation
// ============================================================

async function pr_checkLLM() {
  try {
    var resp = await fetch('/api/evaluate');
    var data = await resp.json();
    prLLMAvailable = data.available === true;
  } catch (e) {
    prLLMAvailable = false;
  }
}

async function pr_evaluate(idx) {
  var p = prPromptData[idx];
  if (!p) return;

  var btn = document.getElementById('pr-eval-btn-' + idx);
  var resultEl = document.getElementById('pr-llm-result-' + idx);
  if (btn) { btn.disabled = true; btn.textContent = t('pr.evaluating'); }

  try {
    var resp = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: p.content,
        context: {
          turns: p.sess ? p.sess.turns : 1,
          tool_failures: p.tools ? p.tools.fail : 0,
          total_tokens: p.sess ? (p.sess.totalInput + p.sess.totalOutput) : 0,
          tools_used: p.toolSeq ? pr_summarizeTools(p.toolSeq) : [],
          tool_summary: p.toolSeq ? pr_toolSequenceSummary(p.toolSeq) : '',
          exploration_ratio: p.dims._stats ? p.dims._stats.explorationRatio : 0,
          patterns: p.dims._patterns ? p.dims._patterns.map(function(p) { return p.type; }) : [],
        },
      }),
    });
    var data = await resp.json();
    if (data.error) {
      resultEl.innerHTML = '<div class="pr-llm-result" style="border-color:var(--red)"><div class="pr-llm-header" style="color:var(--red)">' + t('pr.llm_error_title') + '</div><div style="font-size:13px;color:var(--text-muted)">' + escapeHTML(data.error) + '</div></div>';
      return;
    }
    pr_renderLLMResult(resultEl, data);
  } catch (e) {
    if (resultEl) resultEl.innerHTML = '<div class="pr-llm-result" style="border-color:var(--red)"><div style="font-size:13px;color:var(--red)">' + escapeHTML(e.message) + '</div></div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('pr.deep_evaluate'); }
  }
}

function pr_renderLLMResult(el, data) {
  var html = '<div class="pr-llm-result">';
  html += '<div class="pr-llm-header">' + t('pr.llm_evaluation') + ' \u00b7 ' + escapeHTML(data.model || '') + '</div>';

  // V2: point-based with reasoning
  if (data.points) {
    if (data.reasoning) {
      html += '<div class="pr-ai-summary" style="margin-bottom:10px;font-style:italic">' + escapeHTML(data.reasoning) + '</div>';
    }
    html += '<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text)">' +
      escapeHTML(data.total + '/20') + '</div>';
    Object.entries(data.points).forEach(function(entry) {
      var dim = entry[0], detail = entry[1];
      var pct = detail.score / 5 * 100;
      var tier = pr_scoreTier(pct);
      var color = pr_tierColor(tier);
      html += '<div class="pr-dim-card" style="margin-bottom:6px">' +
        '<div class="pr-dim-card-head">' +
          '<span class="pr-dim-card-label">' + escapeHTML(dim) + '</span>' +
          '<span class="pr-dim-card-val" style="color:' + color + '">' + detail.score + '/5</span>' +
        '</div>';
      if (detail.awarded && detail.awarded.length > 0) {
        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">';
        detail.awarded.forEach(function(a) {
          html += '<span style="display:inline-block;margin-right:8px">\u2713 ' + escapeHTML(a) + '</span>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
  }
  // V1 fallback: raw 0-100 scores
  else if (data.scores) {
    html += '<div class="pr-dims" style="margin-bottom:8px">';
    Object.entries(data.scores).forEach(function(entry) {
      var val = entry[1];
      var tier = pr_scoreTier(val);
      var color = pr_tierColor(tier);
      html += '<div class="pr-dim-row">' +
        '<div class="pr-dim-label">' + escapeHTML(entry[0]) + '</div>' +
        '<div class="pr-dim-track"><div class="pr-dim-fill" style="width:' + val + '%;background:' + color + '"></div></div>' +
        '<div class="pr-dim-val">' + val + '</div></div>';
    });
    html += '</div>';
  }

  // Suggestions
  if (data.suggestions && data.suggestions.length > 0) {
    html += '<div class="pr-suggestions" style="border-style:solid;border-color:var(--blue)">';
    html += '<div class="pr-suggestions-title" style="color:var(--blue)">' + t('pr.suggestions') + '</div>';
    data.suggestions.forEach(function(s) {
      html += '<div class="pr-suggestion-item">' + escapeHTML(s) + '</div>';
    });
    html += '</div>';
  }

  // Rewrite
  if (data.rewrite) {
    html += '<div class="pr-llm-rewrite">';
    html += '<div class="pr-llm-rewrite-label">' + t('pr.suggested_rewrite') + '</div>';
    html += escapeHTML(data.rewrite);
    html += '</div>';
  }

  html += '</div>';
  el.innerHTML = html;
}

// Helper: summarize tool names from sequence
function pr_summarizeTools(toolSeq) {
  var names = {};
  toolSeq.forEach(function(t) { names[t.tool] = true; });
  return Object.keys(names);
}

// Helper: compact tool sequence summary like "Read(5) → Grep(3) → Edit(1)"
function pr_toolSequenceSummary(toolSeq) {
  if (!toolSeq || toolSeq.length === 0) return '';
  var runs = [], last = '', count = 0;
  toolSeq.forEach(function(t) {
    if (t.tool === last) { count++; }
    else { if (last) runs.push(last + '(' + count + ')'); last = t.tool; count = 1; }
  });
  if (last) runs.push(last + '(' + count + ')');
  return runs.join(' \u2192 ');
}

// ============================================================
// AI Insights (Sampled Summary)
// ============================================================

var prAIInsightsCache = {};

function pr_samplePrompts(scored) {
  var tiers = { poor: [], fair: [], good: [], excellent: [] };
  scored.forEach(function(s) {
    tiers[pr_scoreTier(s.dims.composite)].push(s);
  });

  var targets = [
    { tier: 'poor', n: 5 },
    { tier: 'fair', n: 4 },
    { tier: 'good', n: 3 },
    { tier: 'excellent', n: 2 },
  ];

  var sample = [];
  var surplus = 0;
  targets.forEach(function(t) {
    var pool = tiers[t.tier].slice(); // clone to avoid mutating original
    var take = Math.min(t.n + surplus, pool.length);
    // Shuffle and pick
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    for (var k = 0; k < take; k++) sample.push(pool[k]);
    surplus = Math.max(0, (t.n + surplus) - pool.length);
  });

  return sample;
}

async function pr_loadAIInsights() {
  var key = prDataGeneration + ':' + (currentLocale || 'en');
  if (prAIInsightsCache[key]) {
    pr_renderAIInsights(prAIInsightsCache[key]);
    return;
  }

  var btn = document.getElementById('pr-ai-btn');
  var el = document.getElementById('pr-ai-insights');
  if (btn) { btn.disabled = true; btn.textContent = t('pr.ai_generating'); }
  el.innerHTML = '<div class="loading">' + t('pr.ai_generating') + '</div>';

  // Ensure data is loaded
  if (!prPromptData || prPromptData.length === 0) {
    prPromptData = await pr_loadData();
  }

  var sample = pr_samplePrompts(prPromptData);
  if (sample.length === 0) {
    el.innerHTML = '<div class="chart-empty">' + t('pr.no_prompts') + '</div>';
    if (btn) { btn.disabled = false; btn.textContent = t('pr.generate_insights'); }
    return;
  }

  // Snapshot stats before async LLM call (globals may change while awaiting).
  var snapshotTotal = prAllScores.length;
  var snapshotRange = currentTimeRange;
  var avgScore = snapshotTotal > 0
    ? Math.round(prAllScores.reduce(function(a, b) { return a + b; }, 0) / snapshotTotal) : 0;

  var payload = {
    prompts: sample.map(function(s) {
      return {
        content: s.content.slice(0, 200),
        score: s.dims.composite,
        turns: s.sess ? s.sess.turns : 1,
        cost_tokens: s.sess ? (s.sess.totalInput + s.sess.totalOutput) : 0,
      };
    }),
    total_prompts: prAllScores.length,
    avg_score: avgScore,
    lang: currentLocale || 'en',
  };

  try {
    var resp = await fetch('/api/evaluate/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await resp.json();
    if (data.error) {
      el.innerHTML = '<div class="pr-llm-result" style="border-color:var(--red)"><div style="font-size:13px;color:var(--red)">' + escapeHTML(data.error) + '</div></div>';
      return;
    }
    data._sampleSize = sample.length;
    data._totalSize = snapshotTotal;
    data._avgScore = avgScore;
    data._timeRange = snapshotRange;
    data._sample = sample; // keep for rendering example prompts
    prAIInsightsCache[key] = data;
    pr_renderAIInsights(data);
    pr_saveInsight(data); // persist to DB (best-effort)
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);font-size:13px">' + t('pr.ai_error') + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('pr.generate_insights'); }
  }
}

function pr_renderAIInsights(data) {
  var el = document.getElementById('pr-ai-insights');
  var sample = data._sample || [];
  var html = '';

  // Summary
  if (data.summary) {
    html += '<div class="pr-ai-summary">' + escapeHTML(data.summary) + '</div>';
  }

  // Patterns with expanded explanation + example prompts
  if (data.patterns && data.patterns.length > 0) {
    data.patterns.forEach(function(p) {
      var freqClass = p.frequency === 'high' ? 'high' : (p.frequency === 'medium' ? 'medium' : 'low');
      html += '<div class="pr-ai-pattern">';
      html += '<div class="pr-ai-pattern-issue">' + escapeHTML(p.issue) +
        ' <span class="pr-ai-pattern-freq ' + freqClass + '">' + escapeHTML(p.frequency) + '</span></div>';
      html += '<div style="font-size:13px;color:var(--text);margin:6px 0">' + escapeHTML(p.suggestion) + '</div>';

      // Expanded explanation
      if (p.explanation) {
        html += '<div style="font-size:12px;color:var(--text-muted);line-height:1.5;margin-bottom:6px">' + escapeHTML(p.explanation) + '</div>';
      }

      // Example prompts from sample
      if (p.examples && p.examples.length > 0 && sample.length > 0) {
        html += '<div class="pr-ai-examples">';
        p.examples.forEach(function(idx) {
          var s = sample[idx - 1]; // 1-based index
          if (s) {
            var preview = s.content.length > 120 ? s.content.slice(0, 120) + '...' : s.content;
            html += '<div class="pr-ai-example">' +
              '<span class="pr-ai-example-score ' + pr_scoreTier(s.dims.composite) + '">' + s.dims.composite + '</span> ' +
              escapeHTML(preview) + '</div>';
          }
        });
        html += '</div>';
      }

      html += '</div>';
    });
  }

  // Top tip
  if (data.top_tip) {
    html += '<div class="pr-ai-top-tip">';
    html += '<div style="font-size:10px;color:var(--green);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">' + t('pr.ai_top_tip') + '</div>';
    html += escapeHTML(data.top_tip);
    html += '</div>';
  }

  // Footnote
  html += '<div class="pr-ai-footnote">' +
    t('pr.ai_sampled').replace('{n}', data._sampleSize || '?').replace('{total}', data._totalSize || '?') +
    (data.model ? ' \u00b7 ' + escapeHTML(data.model) : '') +
    '</div>';

  el.innerHTML = html;
}

// ============================================================
// Insight Persistence & History
// ============================================================

var prHistoryOpen = false;
var prActiveInsightId = null;

async function pr_saveInsight(data) {
  try {
    var sampleForSave = (data._sample || []).map(function(s) {
      return { content: (s.content || '').slice(0, 200), score: s.dims ? s.dims.composite : 0 };
    });
    await fetch('/api/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: data.summary || '',
        patterns: data.patterns || [],
        top_tip: data.top_tip || '',
        model: data.model || '',
        sample_size: data._sampleSize || 0,
        total_prompts: data._totalSize || 0,
        avg_score: data._avgScore || 0,
        sample_prompts: sampleForSave,
        time_range: data._timeRange || currentTimeRange,
      }),
    });
  } catch (e) { /* silent — save is best-effort */ }
}

async function pr_toggleHistory() {
  var panel = document.getElementById('pr-ai-history-panel');
  prHistoryOpen = !prHistoryOpen;
  if (!prHistoryOpen) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  panel.innerHTML = '<div class="loading">' + t('pr.ai_history_loading') + '</div>';
  try {
    var resp = await fetch('/api/insights?limit=10');
    var gdbResp = await resp.json();
    var recs = (gdbResp.output && gdbResp.output[0] && gdbResp.output[0].records) || {};
    var colNames = (recs.schema && recs.schema.column_schemas || []).map(function(c) { return c.name; });
    var rowData = (recs.rows || []).map(function(row) {
      var obj = {};
      colNames.forEach(function(c, i) { obj[c] = row[i]; });
      return obj;
    });
    pr_renderHistoryPanel(rowData);
  } catch (e) {
    panel.innerHTML = '<div style="color:var(--red);font-size:12px">' + t('pr.ai_error') + '</div>';
  }
}

function pr_renderHistoryPanel(items) {
  var panel = document.getElementById('pr-ai-history-panel');
  if (!items || items.length === 0) {
    panel.innerHTML = '<div class="chart-empty" style="height:auto;padding:16px">' + t('pr.ai_no_history') + '</div>';
    return;
  }

  var html = '<div class="pr-ai-history-panel">';
  items.forEach(function(item) {
    var id = item.insight_id || '';
    var score = Number(item.avg_score) || 0;
    var tier = pr_scoreTier(score);
    var sampleSize = Number(item.sample_size) || 0;
    var total = Number(item.total_prompts) || 0;
    var range = item.time_range || '';
    var summary = (item.summary || '').slice(0, 80);
    var ts = item.ts ? new Date(tsToMs(item.ts)).toLocaleString() : '';
    var active = id === prActiveInsightId ? ' active' : '';

    html += '<div class="pr-ai-history-card' + active + '" data-insight-id="' + escapeHTML(id) + '" onclick="pr_loadHistoryDetail(\'' + escapeJSString(id) + '\')">';
    html += '<div class="pr-ai-history-date">' + escapeHTML(ts) + '</div>';
    html += '<div class="pr-ai-history-meta">';
    html += '<span class="pr-score-dot-sm ' + tier + '">' + score + '</span>';
    html += '<span>\u00b7</span>';
    html += '<span>' + sampleSize + ' / ' + total + ' ' + t('pr.ai_prompts_label') + '</span>';
    if (range) html += '<span>\u00b7</span><span>' + escapeHTML(range) + '</span>';
    html += '</div>';
    if (summary) html += '<div class="pr-ai-history-summary">' + escapeHTML(summary) + (item.summary && item.summary.length > 80 ? '...' : '') + '</div>';
    html += '</div>';
  });
  html += '</div>';
  panel.innerHTML = html;
}

async function pr_loadHistoryDetail(insightId) {
  var el = document.getElementById('pr-ai-insights');
  el.innerHTML = '<div class="loading">' + t('pr.ai_history_loading') + '</div>';
  try {
    var resp = await fetch('/api/insights/' + encodeURIComponent(insightId));
    var gdbResp = await resp.json();
    var recs = (gdbResp.output && gdbResp.output[0] && gdbResp.output[0].records) || {};
    var colNames = (recs.schema && recs.schema.column_schemas || []).map(function(c) { return c.name; });
    var row = (recs.rows || [])[0];
    if (!row) { el.innerHTML = '<div class="chart-empty">' + t('pr.ai_error') + '</div>'; return; }

    var obj = {};
    colNames.forEach(function(c, i) { obj[c] = row[i]; });

    // Parse JSON string fields
    var data = {
      summary: obj.summary || '',
      patterns: JSON.parse(obj.patterns || '[]'),
      top_tip: obj.top_tip || '',
      model: obj.model || '',
      _sampleSize: Number(obj.sample_size) || 0,
      _totalSize: Number(obj.total_prompts) || 0,
      _sample: JSON.parse(obj.sample_prompts || '[]').map(function(s) {
        return { content: s.content || '', dims: { composite: s.score || 0 } };
      }),
    };
    prActiveInsightId = insightId;
    pr_renderAIInsights(data);
    // Update history card highlights
    document.querySelectorAll('.pr-ai-history-card').forEach(function(card) {
      card.classList.toggle('active', card.dataset.insightId === insightId);
    });
  } catch (e) {
    el.innerHTML = '<div style="color:var(--red);font-size:12px">' + escapeHTML(e.message) + '</div>';
  }
}

// ============================================================
// Tab Navigation
// ============================================================

function pr_onTabChange(tab) {
  if (tab === 'pr-overview') pr_loadOverview();
  else if (tab === 'pr-prompts') pr_loadPrompts();
  else if (tab === 'pr-patterns') pr_loadPatterns();
}

// ============================================================
// Helpers
// ============================================================

function pr_renderScoreRing(score, size) {
  var tier = pr_scoreTier(score);
  var color = pr_tierColor(tier);
  var r = (size - 6) / 2;
  var circ = 2 * Math.PI * r;
  var offset = circ * (1 - score / 100);
  return '<div class="pr-score-ring" style="width:' + size + 'px;height:' + size + 'px">' +
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
    '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="var(--border)" stroke-width="4"/>' +
    '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="4" ' +
    'stroke-dasharray="' + circ + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')" ' +
    'style="transition:stroke-dashoffset 0.5s ease"/>' +
    '</svg>' +
    '<span class="pr-score-num" style="color:' + color + '">' + score + '</span>' +
    '</div>';
}

function pr_relativeTime(ts) {
  var ms = tsToMs(ts);
  var diff = Date.now() - ms;
  if (diff < 60000) return t('pr.time.now');
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ' + t('pr.time.ago');
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ' + t('pr.time.ago');
  return Math.floor(diff / 86400000) + 'd ' + t('pr.time.ago');
}

function lookupPrice(model) {
  if (!model || !window.modelPricing) return { i: 0, o: 0 };
  for (var i = 0; i < modelPricing.length; i++) {
    if (model.match(modelPricing[i].p)) return { i: modelPricing[i].i, o: modelPricing[i].o };
  }
  return { i: 3, o: 15 }; // fallback: mid-range pricing
}
