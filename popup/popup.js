// ==========================================================
// Upwork Job Shortlister - Popup
// ==========================================================

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    mainView: $('mainView'),
    settingsView: $('settingsView'),
    detailView: $('detailView'),
    settingsBtn: $('settingsBtn'),
    backBtn: $('backBtn'),
    detailBack: $('detailBack'),
    detailBody: $('detailBody'),
    detailStatus: $('detailStatus'),
    detailPush: $('detailPush'),
    detailRemove: $('detailRemove'),

    searchInput: $('searchInput'),
    stats: $('stats'),
    filters: document.querySelectorAll('.chip'),
    sortBy: $('sortBy'),
    jobList: $('jobList'),
    empty: $('empty'),
    pendingDot: $('pendingDot'),

    openAllBtn: $('openAllBtn'),
    clearBtn: $('clearBtn'),
    clearConfirm: $('clearConfirm'),
    clearYes: $('clearYes'),
    clearNo: $('clearNo'),

    notionToken: $('notionToken'),
    notionDbId: $('notionDbId'),
    testNotion: $('testNotion'),
    saveNotion: $('saveNotion'),
    notionStatus: $('notionStatus'),

    toast: $('toast'),
  };

  // Current detail-panel job ID
  let currentDetailId = null;

  let state = {
    query: '',
    filter: 'all',
    sortBy: 'rating',
  };

  // ----------------------------------------------------------
  // Storage helpers
  // ----------------------------------------------------------
  const storage = {
    getJobs: () => new Promise(r => chrome.storage.local.get({ jobs: {} }, x => r(x.jobs))),
    getSettings: () => new Promise(r => chrome.storage.local.get({
      settings: { sortBy: 'rating', filter: 'all' }
    }, x => r(x.settings))),
    saveSettings: (settings) => new Promise(r => chrome.storage.local.set({ settings }, r)),
    getNotion: () => new Promise(r => chrome.storage.local.get({
      notion: { token: '', databaseId: '' }
    }, x => r(x.notion))),
    saveNotion: (notion) => new Promise(r => chrome.storage.local.set({ notion }, r)),
    getPending: () => new Promise(r => chrome.storage.local.get({ pendingPushes: {} }, x => r(x.pendingPushes))),
    setPendingEntry: (id, entry) => new Promise(r => chrome.storage.local.get({ pendingPushes: {} }, x => {
      x.pendingPushes[id] = entry;
      chrome.storage.local.set({ pendingPushes: x.pendingPushes }, r);
    })),
    removePendingEntry: (id) => new Promise(r => chrome.storage.local.get({ pendingPushes: {} }, x => {
      delete x.pendingPushes[id];
      chrome.storage.local.set({ pendingPushes: x.pendingPushes }, r);
    })),
    removeJob: (id) => new Promise(r => chrome.storage.local.get({ jobs: {}, pendingPushes: {} }, x => {
      delete x.jobs[id];
      delete x.pendingPushes[id];
      chrome.storage.local.set({ jobs: x.jobs, pendingPushes: x.pendingPushes }, r);
    })),
    clearJobs: () => new Promise(r => chrome.storage.local.set({ jobs: {}, pendingPushes: {} }, r)),
  };

  // ----------------------------------------------------------
  // Utils
  // ----------------------------------------------------------
  function escapeHtml(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function timeAgo(ts) {
    if (!ts) return null;
    const d = Date.now() - ts;
    const m = Math.floor(d / 60000);
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    const h = Math.floor(d / 3600000);
    if (h < 24) return h + 'h';
    const days = Math.floor(d / 86400000);
    if (days < 7) return days + 'd';
    const w = Math.floor(d / 604800000);
    if (w < 5) return w + 'w';
    return Math.floor(d / 2592000000) + 'mo';
  }

  function renderStars(rating) {
    if (!rating) return '';
    let s = '';
    for (let i = 1; i <= 5; i++) s += i <= rating ? '★' : '☆';
    return s;
  }

  function toast(msg, kind) {
    els.toast.textContent = msg;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    setTimeout(() => { els.toast.className = 'toast' + (kind ? ' ' + kind : ''); }, 2400);
  }

  // ----------------------------------------------------------
  // Sort / filter / search
  // ----------------------------------------------------------
  function sortJobs(jobs, by) {
    return jobs.sort((a, b) => {
      if (a.status === 'rejected' && b.status !== 'rejected') return 1;
      if (b.status === 'rejected' && a.status !== 'rejected') return -1;
      switch (by) {
        case 'rating': {
          const rA = a.rating || 0, rB = b.rating || 0;
          if (rB !== rA) return rB - rA;
          return (b.shortlistedAt || 0) - (a.shortlistedAt || 0);
        }
        case 'shortlistedAt': return (b.shortlistedAt || 0) - (a.shortlistedAt || 0);
        case 'title':         return (a.title || '').localeCompare(b.title || '');
        default: return 0;
      }
    });
  }

  function filterJobs(jobs, filter, pending) {
    switch (filter) {
      case 'pending':  return jobs.filter(j => pending[j.id]);
      case 'unrated':  return jobs.filter(j => j.status === 'shortlisted');
      case 'rated':    return jobs.filter(j => j.status === 'rated');
      case 'applied':  return jobs.filter(j => j.status === 'applied');
      case 'rejected': return jobs.filter(j => j.status === 'rejected');
      default:         return jobs;
    }
  }

  function searchJobs(jobs, q) {
    if (!q) return jobs;
    const needle = q.toLowerCase();
    return jobs.filter(j =>
      (j.title || '').toLowerCase().includes(needle) ||
      (j.descriptionSnippet || '').toLowerCase().includes(needle) ||
      (j.skills || []).some(s => s.toLowerCase().includes(needle))
    );
  }

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------
  function renderJobRow(job, pendingEntry) {
    const row = document.createElement('div');
    row.className = 'job-row ' + (job.status || 'shortlisted');

    const status = job.status || 'shortlisted';
    const showBadge = status === 'applied' || status === 'rated' || status === 'rejected';
    const ago = job.shortlistedAt ? timeAgo(job.shortlistedAt) : '';
    const stars = job.rating ? `<span class="job-rating">${renderStars(job.rating)}</span>` : '';
    const budget = job.budget ? `<span class="job-budget">${escapeHtml(job.budget)}</span>` : '';
    const badge = showBadge ? `<span class="job-badge ${status}">${status}</span>` : '';

    // Notion push state
    let pushAction = '';
    if (pendingEntry) {
      const st = pendingEntry.notionStatus;
      if (st === 'pending') {
        pushAction = `<button class="row-push-btn" data-action="review" data-id="${escapeHtml(job.id)}">Review &amp; push</button>`;
      } else if (st === 'pushed') {
        pushAction = `<button class="row-push-btn pushed" data-action="review" data-id="${escapeHtml(job.id)}">✓ Pushed</button>`;
      } else if (st === 'error') {
        pushAction = `<button class="row-push-btn" data-action="review" data-id="${escapeHtml(job.id)}" title="${escapeHtml(pendingEntry.notionError || '')}">⚠ Retry</button>`;
      }
    }

    row.innerHTML = `
      <div class="job-row-top">
        <a class="job-title" href="${escapeHtml(job.url || '#')}" target="_blank" rel="noopener">${escapeHtml(job.title || 'Untitled')}</a>
        <button class="job-remove" data-id="${escapeHtml(job.id)}" title="Remove">×</button>
      </div>
      <div class="job-meta">
        ${budget}
        ${stars}
        ${badge}
        ${ago ? `<span>${ago}</span>` : ''}
        ${pushAction}
      </div>
    `;

    row.querySelector('.job-remove').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await storage.removeJob(job.id);
      render();
    });

    const pushBtn = row.querySelector('.row-push-btn');
    if (pushBtn) {
      pushBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openDetail(pushBtn.dataset.id);
      });
    }

    return row;
  }

  async function render() {
    const jobs = await storage.getJobs();
    const pending = await storage.getPending();
    const arr = Object.values(jobs);

    // Stats
    const total = arr.length;
    const rated = arr.filter(j => j.status === 'rated').length;
    const applied = arr.filter(j => j.status === 'applied').length;
    let stats = total + ' job' + (total !== 1 ? 's' : '');
    if (rated)   stats += ' · ' + rated + ' rated';
    if (applied) stats += ' · ' + applied + ' applied';
    els.stats.textContent = total ? stats : '';

    // Pending count badge on the Notion chip — only count entries whose job
    // still exists in the shortlist, so orphans (if any) don't inflate the count
    const pendingCount = Object.entries(pending)
      .filter(([id, p]) => jobs[id] && (p.notionStatus === 'pending' || p.notionStatus === 'error'))
      .length;
    if (pendingCount > 0) {
      els.pendingDot.textContent = pendingCount;
      els.pendingDot.style.display = '';
    } else {
      els.pendingDot.style.display = 'none';
    }

    // Chip active state
    els.filters.forEach(c => c.classList.toggle('active', c.dataset.filter === state.filter));

    // Filter + search + sort
    let list = filterJobs(arr, state.filter, pending);
    list = searchJobs(list, state.query);
    list = sortJobs(list, state.sortBy);

    els.jobList.innerHTML = '';
    if (list.length === 0) {
      els.jobList.style.display = 'none';
      els.empty.style.display = 'flex';
      const t = els.empty.querySelector('.empty-title');
      const s = els.empty.querySelector('.empty-sub');
      if (state.filter === 'pending' && total > 0) {
        t.textContent = 'Notion queue is empty';
        s.textContent = 'Submitted proposals will appear here for review.';
      } else if (total === 0) {
        t.textContent = 'No jobs shortlisted';
        s.textContent = 'Click + on any Upwork job card to add it.';
      } else {
        t.textContent = 'Nothing matches';
        s.textContent = 'Try a different filter or search term.';
      }
    } else {
      els.jobList.style.display = 'flex';
      els.empty.style.display = 'none';
      list.forEach(j => els.jobList.appendChild(renderJobRow(j, pending[j.id])));
    }

    // Open-in-tabs reflects the currently VISIBLE list (after filter + search),
    // excluding rejected — so on the Unrated filter it only opens unrated jobs.
    const openableList = list.filter(j => j.status !== 'rejected' && j.url);
    state.openableUrls = openableList.map(j => j.url);
    els.openAllBtn.disabled = openableList.length === 0;
    els.openAllBtn.textContent = openableList.length > 0
      ? `Open ${openableList.length} in tab${openableList.length === 1 ? '' : 's'}`
      : 'Open in tabs';
    els.clearBtn.disabled = total === 0;
  }

  // ----------------------------------------------------------
  // Detail / review-before-push view
  // ----------------------------------------------------------
  const FIELD_DEFS = [
    { key: 'title',            label: 'Job Title',          type: 'text'     },
    { key: 'url',              label: 'Job URL',            type: 'text'     },
    { key: 'dateApplied',      label: 'Date Applied',       type: 'date'     },
    { key: 'proposalsText',    label: 'Proposals at Apply', type: 'text', hint: 'Bucketed automatically on push' },
    { key: 'rateSubmitted',    label: 'Rate Submitted',     type: 'number', half: true },
    { key: 'connectsSpent',    label: 'Connects Spent',     type: 'number', half: true },
    { key: 'boostUsed',        label: 'Boost Used',         type: 'checkbox' },
    { key: 'reviewScore',      label: 'Review Score',       type: 'number', half: true },
    { key: 'budget',           label: 'Budget',             type: 'text',   half: true },
    { key: 'clientRating',     label: 'Client Rating',      type: 'number', half: true, step: '0.01' },
    { key: 'clientHireRate',   label: 'Client Hire Rate %', type: 'number', half: true, step: '0.01', hint: '0.62 = 62%' },
    { key: 'clientTotalSpend', label: 'Client Total Spend', type: 'number', half: true },
    { key: 'clientAvgHourly',  label: 'Client Avg Hourly',  type: 'number', half: true },
    { key: 'coverLetter',      label: 'Cover Letter',       type: 'textarea' },
    { key: 'descriptionSnippet', label: 'Job Description',  type: 'textarea' },
  ];

  function formatDateInput(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }

  function buildDetailField(def, value) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-field';

    const label = document.createElement('span');
    label.className = 'detail-field-label';
    label.textContent = def.label + (def.hint ? ' · ' + def.hint : '');
    wrap.appendChild(label);

    if (def.type === 'textarea') {
      const ta = document.createElement('textarea');
      ta.className = 'detail-field-input textarea';
      ta.value = value ?? '';
      ta.dataset.key = def.key;
      wrap.appendChild(ta);
    } else if (def.type === 'checkbox') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      cb.dataset.key = def.key;
      cb.style.width = '18px';
      cb.style.height = '18px';
      wrap.appendChild(cb);
    } else {
      const input = document.createElement('input');
      input.className = 'detail-field-input';
      input.type = def.type === 'number' ? 'number' : (def.type === 'date' ? 'date' : 'text');
      if (def.step) input.step = def.step;
      if (def.type === 'date') input.value = formatDateInput(value);
      else input.value = value ?? '';
      input.dataset.key = def.key;
      wrap.appendChild(input);
    }

    return wrap;
  }

  async function openDetail(jobId) {
    const pending = await storage.getPending();
    const entry = pending[jobId];
    if (!entry) return;
    currentDetailId = jobId;

    els.detailBody.innerHTML = '';

    // Status pill
    const st = entry.notionStatus;
    els.detailStatus.textContent = st === 'pushed' ? 'Pushed' : st === 'error' ? 'Error' : 'Pending';
    els.detailStatus.className = 'status-pill ' + st;

    // Render fields (group halves into 2-column rows)
    let rowBuffer = null;
    const flush = () => { if (rowBuffer) { els.detailBody.appendChild(rowBuffer); rowBuffer = null; } };

    FIELD_DEFS.forEach(def => {
      const field = buildDetailField(def, entry.payload[def.key]);
      if (def.half) {
        if (!rowBuffer) {
          rowBuffer = document.createElement('div');
          rowBuffer.className = 'detail-field-row';
        }
        rowBuffer.appendChild(field);
        if (rowBuffer.children.length === 2) flush();
      } else {
        flush();
        els.detailBody.appendChild(field);
      }
    });
    flush();

    // Error message if any
    if (entry.notionError) {
      const err = document.createElement('div');
      err.className = 'row-error-msg';
      err.textContent = 'Last error: ' + entry.notionError;
      els.detailBody.appendChild(err);
    }

    // Push button label by state
    if (entry.notionStatus === 'pushed') {
      els.detailPush.textContent = 'Open in Notion';
    } else if (entry.notionStatus === 'error') {
      els.detailPush.textContent = 'Retry push';
    } else {
      els.detailPush.textContent = 'Push to Notion';
    }

    els.mainView.style.display = 'none';
    els.settingsView.style.display = 'none';
    els.detailView.style.display = 'flex';
  }

  function readDetailFields() {
    const payload = {};
    els.detailBody.querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      if (el.type === 'checkbox') payload[key] = el.checked;
      else if (el.type === 'date') payload[key] = el.value ? new Date(el.value).getTime() : null;
      else if (el.type === 'number') payload[key] = el.value === '' ? null : parseFloat(el.value);
      else payload[key] = el.value;
    });
    return payload;
  }

  async function pushDetailToNotion() {
    if (!currentDetailId) return;
    const pending = await storage.getPending();
    const entry = pending[currentDetailId];
    if (!entry) return;

    // If already pushed, button opens the Notion page
    if (entry.notionStatus === 'pushed' && entry.notionPageUrl) {
      chrome.tabs.create({ url: entry.notionPageUrl });
      return;
    }

    const notion = await storage.getNotion();
    if (!notion.token || !notion.databaseId) {
      toast('Configure Notion in settings first', 'error');
      return;
    }

    // Merge edits with payload
    const edited = readDetailFields();
    const merged = { ...entry.payload, ...edited, id: currentDetailId };

    els.detailPush.disabled = true;
    els.detailPush.textContent = 'Pushing…';

    try {
      const res = await chrome.runtime.sendMessage({ action: 'notionCreatePage', job: merged });
      if (res && res.ok) {
        entry.notionStatus = 'pushed';
        entry.notionPageUrl = res.pageUrl;
        entry.notionError = null;
        entry.pushedAt = Date.now();
        entry.payload = merged;
        await storage.setPendingEntry(currentDetailId, entry);
        toast('Pushed to Notion ✓', 'success');
        els.detailStatus.textContent = 'Pushed';
        els.detailStatus.className = 'status-pill pushed';
        els.detailPush.textContent = 'Open in Notion';
      } else {
        entry.notionStatus = 'error';
        entry.notionError = res?.error || 'Unknown error';
        entry.payload = merged;
        await storage.setPendingEntry(currentDetailId, entry);
        toast('Push failed: ' + entry.notionError, 'error');
        els.detailPush.textContent = 'Retry push';
      }
    } catch (e) {
      toast('Push failed: ' + e.message, 'error');
      els.detailPush.textContent = 'Retry push';
    } finally {
      els.detailPush.disabled = false;
    }
  }

  async function removeDetail() {
    if (!currentDetailId) return;
    await storage.removePendingEntry(currentDetailId);
    toast('Removed from queue');
    showMain();
  }

  function showDetailBack() {
    currentDetailId = null;
    showMain();
  }

  // ----------------------------------------------------------
  // View switching
  // ----------------------------------------------------------
  async function showSettings() {
    const n = await storage.getNotion();
    els.notionToken.value = n.token || '';
    els.notionDbId.value = n.databaseId || '';
    els.notionStatus.textContent = '';
    els.notionStatus.className = 'status-line';
    els.mainView.style.display = 'none';
    els.settingsView.style.display = 'flex';
  }

  function showMain() {
    els.settingsView.style.display = 'none';
    els.detailView.style.display = 'none';
    els.mainView.style.display = 'flex';
    render();
    setTimeout(() => els.searchInput.focus(), 50);
  }

  // ----------------------------------------------------------
  // Notion: test + save
  // ----------------------------------------------------------
  function setNotionStatus(text, kind) {
    els.notionStatus.textContent = text;
    els.notionStatus.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  async function testNotion() {
    const token = els.notionToken.value.trim();
    const dbId = els.notionDbId.value.trim();
    if (!token || !dbId) {
      setNotionStatus('Token and Database ID required', 'error');
      return;
    }
    setNotionStatus('Testing…');
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'notionTest',
        token, databaseId: dbId,
      });
      if (res && res.ok) setNotionStatus('Connected · ' + (res.dbTitle || 'database reachable'), 'success');
      else setNotionStatus('Failed: ' + (res?.error || 'unknown error'), 'error');
    } catch (e) {
      setNotionStatus('Failed: ' + e.message, 'error');
    }
  }

  async function saveNotion() {
    const token = els.notionToken.value.trim();
    const dbId = els.notionDbId.value.trim();
    await storage.saveNotion({ token, databaseId: dbId });
    setNotionStatus('Saved', 'success');
    toast('Notion settings saved', 'success');
  }

  // ----------------------------------------------------------
  // Event wiring
  // ----------------------------------------------------------
  els.settingsBtn.addEventListener('click', showSettings);
  els.backBtn.addEventListener('click', showMain);
  els.detailBack.addEventListener('click', showDetailBack);
  els.detailPush.addEventListener('click', pushDetailToNotion);
  els.detailRemove.addEventListener('click', removeDetail);

  els.searchInput.addEventListener('input', (e) => {
    state.query = e.target.value;
    render();
  });

  els.filters.forEach(chip => {
    chip.addEventListener('click', async () => {
      state.filter = chip.dataset.filter;
      const settings = await storage.getSettings();
      settings.filter = state.filter;
      await storage.saveSettings(settings);
      render();
    });
  });

  els.sortBy.addEventListener('change', async () => {
    state.sortBy = els.sortBy.value;
    const settings = await storage.getSettings();
    settings.sortBy = state.sortBy;
    await storage.saveSettings(settings);
    render();
  });

  els.openAllBtn.addEventListener('click', () => {
    const urls = state.openableUrls || [];
    if (!urls.length) return;
    chrome.runtime.sendMessage({ action: 'openTabs', urls });
  });

  els.clearBtn.addEventListener('click', () => {
    els.clearConfirm.style.display = 'flex';
  });
  els.clearNo.addEventListener('click', () => {
    els.clearConfirm.style.display = 'none';
  });
  els.clearYes.addEventListener('click', async () => {
    await storage.clearJobs();
    els.clearConfirm.style.display = 'none';
    render();
    toast('Shortlist cleared');
  });

  els.testNotion.addEventListener('click', testNotion);
  els.saveNotion.addEventListener('click', saveNotion);

  // Keyboard: ESC closes modals/settings, ⌘F focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.clearConfirm.style.display !== 'none') {
        els.clearConfirm.style.display = 'none';
      } else if (els.detailView.style.display !== 'none') {
        showDetailBack();
      } else if (els.settingsView.style.display !== 'none') {
        showMain();
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.jobs || changes.pendingPushes) render();
  });

  // ----------------------------------------------------------
  // Init
  // ----------------------------------------------------------
  (async function init() {
    const settings = await storage.getSettings();
    state.filter = settings.filter || 'all';
    state.sortBy = settings.sortBy || 'rating';
    els.sortBy.value = state.sortBy;

    // Sweep orphaned pending entries (job removed but pending lingered)
    const [jobsNow, pendingNow] = await Promise.all([storage.getJobs(), storage.getPending()]);
    const orphans = Object.keys(pendingNow).filter(id => !jobsNow[id]);
    if (orphans.length) {
      orphans.forEach(id => delete pendingNow[id]);
      await new Promise(r => chrome.storage.local.set({ pendingPushes: pendingNow }, r));
    }

    await render();
    setTimeout(() => els.searchInput.focus(), 60);
  })();
})();
