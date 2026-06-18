/* ── Admin Dashboard Script ────────────────────────────────────── */
'use strict';

// ── Tab switching ───────────────────────────────────────────────
function switchTab(id, btn) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
}

// ── Helpers ─────────────────────────────────────────────────────
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function scoreBadge(score, wasFallback) {
  if (wasFallback) {
    return '<span class="badge badge-fallback">FALLBACK</span>';
  }
  if (score < 0.35) {
    return '<span class="badge badge-fallback">' + score.toFixed(3) + '</span>';
  }
  if (score < 0.45) {
    return '<span class="badge badge-low">' + score.toFixed(3) + '</span>';
  }
  return '<span class="badge badge-ok">' + score.toFixed(3) + '</span>';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Render stats cards ───────────────────────────────────────────
function renderStats(s) {
  const fallbackClass =
    s.fallbackRate > 30 ? 'danger' : s.fallbackRate > 15 ? 'warning' : 'success';

  document.getElementById('stats').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Total Conversations</div>
      <div class="stat-value">${s.totalConversations}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Fallback Rate</div>
      <div class="stat-value ${fallbackClass}">${s.fallbackRate.toFixed(1)}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Avg Similarity</div>
      <div class="stat-value score">${s.avgSimilarityScore.toFixed(3)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Unanswered</div>
      <div class="stat-value danger">${s.fallbackCount}</div>
    </div>
  `;
}

// ── Render low-confidence table ──────────────────────────────────
function renderLowConfidence(rows) {
  if (!rows.length) {
    document.getElementById('low-conf').innerHTML =
      '<p class="empty">No low-confidence answers yet 🎉</p>';
    return;
  }

  let html = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Question</th>
            <th>Score</th>
            <th>Answer (preview)</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (const row of rows) {
    const q = escHtml(row.question);
    const answerPreview = escHtml((row.answer || '').slice(0, 120));
    html += `
      <tr>
        <td class="time-ago">${timeAgo(row.created_at)}</td>
        <td><span class="truncate" title="${q}">${q}</span></td>
        <td>${scoreBadge(row.top_similarity_score || 0, row.was_fallback)}</td>
        <td><span class="truncate">${answerPreview}</span></td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  document.getElementById('low-conf').innerHTML = html;
}

// ── Render top queries table ─────────────────────────────────────
function renderTopQueries(rows) {
  if (!rows.length) {
    document.getElementById('top-queries').innerHTML =
      '<p class="empty">No queries logged yet</p>';
    return;
  }

  let html = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Count</th>
            <th>Avg Score</th>
            <th>Last Asked</th>
          </tr>
        </thead>
        <tbody>
  `;

  for (const row of rows) {
    const q = escHtml(row.question);
    html += `
      <tr>
        <td><span class="truncate" title="${q}">${q}</span></td>
        <td><strong>${row.count}</strong></td>
        <td class="score">${row.avg_score.toFixed(3)}</td>
        <td class="time-ago">${timeAgo(row.latest_at)}</td>
      </tr>
    `;
  }

  html += '</tbody></table></div>';
  document.getElementById('top-queries').innerHTML = html;
}

// ── Main data loader ─────────────────────────────────────────────
async function loadData() {
  const btn = document.getElementById('refresh-btn');

  // Show loading state
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Loading…';
  }
  document.getElementById('low-conf').innerHTML = '<div class="loading">Loading…</div>';
  document.getElementById('top-queries').innerHTML = '<div class="loading">Loading…</div>';

  try {
    const res = await fetch('/api/admin');

    if (!res.ok) {
      throw new Error('HTTP ' + res.status + ' ' + res.statusText);
    }

    const data = await res.json();

    renderStats(data.stats);
    renderLowConfidence(data.lowConfidence);
    renderTopQueries(data.topQueries);

  } catch (err) {
    console.error('Admin load error:', err);
    document.getElementById('stats').innerHTML =
      '<p class="error-msg">⚠️ Failed to load data — ' + escHtml(err.message) + '</p>';
    document.getElementById('low-conf').innerHTML =
      '<p class="error-msg">Failed to load. Check console.</p>';
    document.getElementById('top-queries').innerHTML =
      '<p class="error-msg">Failed to load. Check console.</p>';
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '↻ Refresh';
    }
  }
}

// ── Init ─────────────────────────────────────────────────────────
loadData();
