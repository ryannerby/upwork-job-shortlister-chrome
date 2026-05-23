// ==========================================================
// Service worker - tab ops + Notion sync
// ==========================================================

const NOTION_VERSION = '2022-06-28';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openTabs') {
    openTabsStaggered(message.urls);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'notionTest') {
    notionTest(message.token, message.databaseId)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }

  if (message.action === 'notionCreatePage') {
    notionCreatePage(message.job)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return false;
});

async function openTabsStaggered(urls) {
  for (let i = 0; i < urls.length; i++) {
    chrome.tabs.create({ url: urls[i], active: i === 0 });
    if (i < urls.length - 1) await new Promise(r => setTimeout(r, 50));
  }
}

// ----------------------------------------------------------
// Notion
// ----------------------------------------------------------
function notionHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionTest(token, databaseId) {
  const res = await fetch('https://api.notion.com/v1/databases/' + databaseId, {
    method: 'GET',
    headers: notionHeaders(token),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: json.message || ('HTTP ' + res.status) };
  }
  const title = (json.title || [])[0]?.plain_text || '';
  return { ok: true, dbTitle: title };
}

function getNotionConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get({ notion: { token: '', databaseId: '' } }, x => resolve(x.notion));
  });
}

function bucketProposalCount(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  // Only accept text that's PURELY a count pattern — rejects free-form
  // text accidentally captured by old/loose regex (e.g. screening questions)
  const isPureCount =
    /^less than \d+$/.test(t) ||
    /^over \d+$/.test(t) ||
    /^\d+\s*to\s*\d+$/.test(t) ||
    /^\d+\+?$/.test(t);
  if (!isPureCount) return null;

  if (t.startsWith('less than 5')) return '<5';
  if (/^50\+|^50 to \d{2,}/.test(t)) return '50+';
  const nums = (t.match(/\d+/g) || []).map(Number);
  const max = Math.max(...nums, 0);
  if (max < 5)   return '<5';
  if (max <= 15) return '5-15';
  if (max <= 50) return '15-50';
  return '50+';
}

function extractLoom(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/(?:www\.)?loom\.com\/share\/[a-z0-9]+/i);
  return m ? m[0] : null;
}

function detectTags(text) {
  if (!text) return [];
  const map = {
    n8n: /\bn8n\b/i,
    Make: /\bmake\.com\b|\bintegromat\b|\bmake\b(?=.*automat)/i,
    Zapier: /\bzapier\b/i,
    GHL: /\bgohighlevel\b|\bgo high level\b|\bghl\b/i,
    Claude: /\bclaude\b|\banthropic\b/i,
    OpenAI: /\bopenai\b|\bgpt-?\d|\bchatgpt\b/i,
    Airtable: /\bairtable\b/i,
    HubSpot: /\bhubspot\b/i,
    Notion: /\bnotion\b/i,
  };
  const out = [];
  for (const [tag, rx] of Object.entries(map)) {
    if (rx.test(text)) out.push(tag);
  }
  return out;
}

function clamp(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) : s;
}

function buildNotionProperties(job) {
  const props = {};

  if (job.title) {
    props['Job Title'] = { title: [{ text: { content: clamp(job.title, 200) } }] };
  }

  props['Date Applied'] = { date: { start: new Date(job.dateApplied || Date.now()).toISOString() } };

  if (job.url) props['Job URL'] = { url: job.url };

  const bucket = bucketProposalCount(job.proposalsAtApply || job.proposalsText || '');
  if (bucket) props['Proposals at Apply'] = { select: { name: bucket } };

  if (typeof job.rateSubmitted === 'number') props['Rate Submitted'] = { number: job.rateSubmitted };

  const cover = job.coverLetter || '';
  if (cover) props['Cover Letter'] = { rich_text: [{ text: { content: clamp(cover, 2000) } }] };

  const loom = extractLoom(cover) || job.loomUrl;
  if (loom) props['Loom URL'] = { url: loom };

  if (typeof job.boostUsed === 'boolean') props['Boost Used'] = { checkbox: job.boostUsed };
  props['Proposal Viewed']  = { checkbox: false };
  props['Response Received']= { checkbox: false };
  props['Outcome']          = { select: { name: 'Ghost' } };

  if (typeof job.clientRating === 'number')    props['Client Rating']      = { number: job.clientRating };
  if (typeof job.clientHireRate === 'number')  props['Client Hire Rate %'] = { number: job.clientHireRate };
  if (typeof job.clientTotalSpend === 'number')props['Client Total Spend'] = { number: job.clientTotalSpend };
  if (typeof job.clientAvgHourly === 'number') props['Client Avg Hourly']  = { number: job.clientAvgHourly };
  if (typeof job.connectsSpent === 'number')   props['Connects Spent']     = { number: job.connectsSpent };
  if (typeof job.reviewScore === 'number')     props['Review Score']       = { number: job.reviewScore };
  if (typeof job.proposalValue === 'number')   props['Proposal Value']     = { number: job.proposalValue };
  if (typeof job.earningsAfterFees === 'number') props['earnings after Upwork fees & taxes'] = { number: job.earningsAfterFees };

  const tagSources = [job.title, job.descriptionSnippet, (job.skills || []).join(' ')].filter(Boolean).join(' ');
  const tags = detectTags(tagSources);
  if (tags.length) props['Tags'] = { multi_select: tags.map(name => ({ name })) };

  if (job.descriptionSnippet) {
    props['Job Description'] = { rich_text: [{ text: { content: clamp(job.descriptionSnippet, 2000) } }] };
  }

  return props;
}

async function notionCreatePage(job) {
  const { token, databaseId } = await getNotionConfig();
  if (!token || !databaseId) return { ok: false, error: 'Notion not configured' };

  const body = {
    parent: { database_id: databaseId },
    properties: buildNotionProperties(job),
  };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: json.message || ('HTTP ' + res.status) };
  return { ok: true, pageId: json.id, pageUrl: json.url };
}
