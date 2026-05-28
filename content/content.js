// ============================================================
// Upwork Job Shortlister - Content Script
// ============================================================

(function () {
  'use strict';

  // ----------------------------------------------------------
  // Selector config - single place to update when Upwork changes DOM
  // ----------------------------------------------------------
  const SELECTORS = {
    // Search results page
    search: {
      jobCard: '[data-test="JobsList"] article, [data-test="job-tile-list"] article, .job-tile, section.air3-card-section, .notifications-list__item',
      // Last fallback (bare a[href]) is for /ab/notifications job-alert rows,
      // which render the title as a plain link with no heading wrapper.
      jobTitle: '[data-test="job-tile-title-link UpLink"], h2 a, a.job-tile-title, h3.job-tile-title a, h3 a[href*="/jobs/"][href*="~"], a[href*="/jobs/"][href*="~"]',
      jobBudget: '[data-test="is-fixed-price"], [data-test="job-type-label"]',
      jobPosted: '[data-test="job-pubilshed-date"]',
      jobSkills: '[data-test="token"] .air3-token, [data-test="TokenClamp JobAttrs"] .air3-token',
      jobDescription: '[data-test="UpCLineClamp JobDescription"]',
      jobLocation: '[data-test="location"]',
    },
    // Job detail page
    detail: {
      title: 'h4.m-0, header h4, [data-test="JobDescription"] h4, .job-details-header h4, h1[class*="job-title" i], h2[class*="job-title" i], [data-test="job-title"], [data-test*="JobTitle"], h1.m-0, h2.m-0',
      budget: '[data-test="BudgetAmount"], [data-test="job-type-label"], .budget-amount',
      budgetType: '[data-test="job-type-label"]',
      clientCountry: '[data-test="client-country"], .client-location, [data-test="LocationLabel"]',
      postedDate: '[data-test="PostedOn"], [data-test="job-pubilshed-date"], .posted-on',
      skills: '[data-test="token"] .air3-token, .up-skill-badge, [data-test="TokenClamp SkillsBadge"] .air3-token, a.air3-token',
      description: '[data-test="Description"] .break, [data-test="JobDescription"], .job-description',
    },
  };

  // ----------------------------------------------------------
  // Page type detection
  // ----------------------------------------------------------
  function getPageType() {
    const path = window.location.pathname;
    const search = window.location.search;
    if (
      path.includes('/search/jobs') ||
      path.includes('/nx/search/jobs') ||
      path.includes('/universal-search/jobs') ||
      path.startsWith('/nx/find-work') ||
      (path.startsWith('/ab/notifications') && /[?&]tab=job_alerts\b/.test(search))
    ) {
      return 'search';
    }
    if (/\/(ab\/)?proposals\/job\/~\d+/.test(path) || /\/apply\b/.test(path)) {
      return 'proposal';
    }
    if (path.match(/\/jobs\/.*~\d+/)) {
      return 'detail';
    }
    return null;
  }

  function getJobIdFromUrl(url) {
    const match = (url || window.location.href).match(/~(\d{10,})/);
    return match ? '~' + match[1] : null;
  }

  // ----------------------------------------------------------
  // Scraping helpers
  // ----------------------------------------------------------
  function safeText(parent, selector) {
    try {
      const el = parent.querySelector(selector);
      return el ? el.textContent.trim() : null;
    } catch (e) {
      return null;
    }
  }

  function safeTextMulti(parent, selectorString) {
    const selectors = selectorString.split(',').map(s => s.trim());
    for (const sel of selectors) {
      try {
        const el = parent.querySelector(sel);
        if (el && el.textContent.trim()) {
          return el.textContent.trim();
        }
      } catch (e) {
        // try next selector
      }
    }
    return null;
  }

  function safeHref(parent, selectorString) {
    const selectors = selectorString.split(',').map(s => s.trim());
    for (const sel of selectors) {
      try {
        const el = parent.querySelector(sel);
        if (el && el.href) {
          return el.href;
        }
      } catch (e) {
        // try next selector
      }
    }
    return null;
  }

  function safeListText(parent, selectorString) {
    const selectors = selectorString.split(',').map(s => s.trim());
    for (const sel of selectors) {
      try {
        const els = parent.querySelectorAll(sel);
        if (els.length > 0) {
          return Array.from(els).map(el => el.textContent.trim()).filter(Boolean);
        }
      } catch (e) {
        // try next selector
      }
    }
    return [];
  }

  // Convert "posted X ago" text to an absolute timestamp
  function parsePostedDate(text) {
    if (!text) return null;
    const lower = text.toLowerCase().replace('posted', '').trim();
    const now = Date.now();
    const MS = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, quarter: 7776000000 };

    // Match patterns like "2 hours ago", "last month", "yesterday", "3 quarters ago"
    const match = lower.match(/(\d+)\s*(minute|hour|day|week|month|quarter)s?\s*ago/);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2];
      return now - num * (MS[unit] || 0);
    }
    if (lower.includes('yesterday')) return now - MS.day;
    if (lower.includes('just now') || lower.includes('moment')) return now;
    if (lower.match(/last\s+month/)) return now - MS.month;
    if (lower.match(/last\s+week/)) return now - MS.week;
    if (lower.match(/last\s+quarter/)) return now - MS.quarter;

    return null;
  }

  function detectBudgetType(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    if (lower.includes('hourly') || lower.includes('/hr')) return 'hourly';
    if (lower.includes('fixed')) return 'fixed';
    return null;
  }

  // ----------------------------------------------------------
  // Scrape job detail page
  // ----------------------------------------------------------
  // Find Upwork's "more" toggle that expands the truncated description.
  // Returns the button element if found, else null.
  function findDescriptionMoreToggle() {
    // Try common test IDs first
    const direct = document.querySelector('[data-test="description-toggle"], [data-test="more-link"], button[aria-label*="show more" i]');
    if (direct) return direct;
    // Fallback: any button/anchor with text "more" or "Show more" sitting
    // inside the description region
    const descRegion = document.querySelector('[data-test="Description"], [data-test="JobDescription"], .job-description');
    const root = descRegion || document;
    const candidates = root.querySelectorAll('button, a');
    for (const el of candidates) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'more' || t === 'show more' || t === 'read more') return el;
    }
    return null;
  }

  // Programmatically expand the truncated description so scrape captures
  // the full text, not the clipped version.
  async function expandDescriptionIfTruncated() {
    const btn = findDescriptionMoreToggle();
    if (!btn) return;
    btn.click();
    // Give the SPA a beat to update the DOM
    await new Promise(r => setTimeout(r, 250));
  }

  // Hook for when the user manually clicks "more" — re-scrape and update
  // the cached description so the latest text lands in the Notion push.
  function hookManualMoreClick(jobId) {
    if (document.body.dataset.ujsMoreHook === '1') return;
    document.body.dataset.ujsMoreHook = '1';
    document.addEventListener('click', (e) => {
      const target = e.target.closest('button, a');
      if (!target) return;
      const text = (target.textContent || '').trim().toLowerCase();
      if (text !== 'more' && text !== 'show more' && text !== 'read more') return;
      // Wait for the expansion, then re-scrape and update the cached job
      setTimeout(async () => {
        try {
          const fresh = scrapeDetailPage();
          if (!fresh.descriptionSnippet) return;
          const jobs = await getJobs();
          const cached = jobs[jobId];
          if (cached) {
            cached.descriptionSnippet = fresh.descriptionSnippet;
            await saveJob(cached);
          }
        } catch (e2) { /* ignore */ }
      }, 300);
    }, true);
  }

  // Hook for the post-submit success page — when user clicks "more" to
  // expand the truncated job description, re-scrape it and update the
  // pending push entry so the FULL text lands in Notion when they push.
  function hookConfirmationMoreClick(jobId) {
    if (document.body.dataset.ujsConfMoreHook === '1') return;
    document.body.dataset.ujsConfMoreHook = '1';
    document.addEventListener('click', (e) => {
      const target = e.target.closest('button, a');
      if (!target) return;
      const text = (target.textContent || '').trim().toLowerCase();
      if (text !== 'more' && text !== 'show more' && text !== 'read more') return;
      setTimeout(async () => {
        try {
          const snap = scrapeClientInfoFromPage();
          if (!snap.descriptionFromPage) return;
          const data = await new Promise(r => chrome.storage.local.get({ pendingPushes: {} }, r));
          const entry = data.pendingPushes[jobId];
          if (entry && entry.payload) {
            entry.payload.descriptionSnippet = snap.descriptionFromPage;
            chrome.storage.local.set({ pendingPushes: data.pendingPushes });
          }
        } catch (e2) { /* ignore */ }
      }, 300);
    }, true);
  }

  function scrapeDetailPage() {
    const s = SELECTORS.detail;
    let title = safeTextMulti(document, s.title);
    // Fallback: derive from <title> tag (e.g. "Job Name | Upwork")
    if (!title && document.title) {
      title = document.title.replace(/\s*[|·-]\s*Upwork.*$/i, '').trim() || null;
    }
    const budget = safeTextMulti(document, s.budget);
    const budgetTypeText = safeTextMulti(document, s.budgetType);
    const clientCountry = safeTextMulti(document, s.clientCountry);
    let postedDate = safeTextMulti(document, s.postedDate);
    const skills = safeListText(document, s.skills);
    const descEl = document.querySelector(s.description.split(',')[0]) ||
                   document.querySelector(s.description.split(',')[1]) ||
                   document.querySelector(s.description.split(',')[2]);
    let fullDesc = descEl ? descEl.textContent.trim() : '';
    // Cap at 2000 chars (Notion rich_text limit). Was 200, which truncated
    // full descriptions captured from the detail page.
    let descriptionSnippet = fullDesc.substring(0, 2000);

    // Best-effort heuristic scrapes for Notion sync — silently null on miss
    const bodyText = document.body.innerText || '';

    // Resilience fallbacks for stale selectors:
    if (!postedDate) {
      const m = bodyText.match(/Posted\s+([^\n•]{1,40})/i);
      if (m) postedDate = m[1].trim();
    }
    if (!descriptionSnippet) {
      // Pull text from a "Summary"/"Job description" heading down to next major heading
      const m = bodyText.match(/(?:Summary|Job description|Project details)[\s:]*\n([\s\S]{50,2000}?)(?:\n\s*(?:Skills|Project Type|Activity|About|Less than|More than)|$)/i);
      if (m) descriptionSnippet = m[1].trim().substring(0, 500);
    }
    const proposalsMatch = bodyText.match(/Proposals?:\s*([^\n]{1,40})/i);
    const proposalsText = proposalsMatch ? proposalsMatch[1].trim() : null;
    const hireRateMatch = bodyText.match(/(\d{1,3})\s*%\s*(?:hire rate|job success)/i);
    // Match $100K+ spent / $1.2M+ spent / $5,400 spent (with or without "total")
    const totalSpendMatch = bodyText.match(/\$([\d,.]+)\s*([KMkm])?\+?\s+(?:total\s+)?spent/i);
    const avgHourlyMatch = bodyText.match(/\$([\d.]+)\s*\/\s*hr\s+avg/i);
    // Match the rating that precedes "of N reviews" (e.g. "5.00 of 29 reviews")
    // — works whether the page shows "5.0\n5.00 of 29 reviews" or one line.
    const clientRatingMatch = bodyText.match(/(\d\.\d{1,2})[\s\S]{0,30}of\s+\d+\s*reviews?/i);
    const reviewCountMatch = bodyText.match(/of\s+(\d+)\s+reviews?/i);

    // Anti-pattern signals
    const paymentVerified = /payment\s+(?:method\s+)?verified/i.test(bodyText);
    const jobsPostedMatch = bodyText.match(/(\d+)\s+jobs?\s+posted/i);
    const clientJobsPosted = jobsPostedMatch ? parseInt(jobsPostedMatch[1]) : null;
    const memberSinceMatch = bodyText.match(/Member\s+since\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
    let clientMemberSinceDays = null;
    if (memberSinceMatch) {
      const d = new Date(memberSinceMatch[1]);
      if (!isNaN(d)) clientMemberSinceDays = Math.floor((Date.now() - d.getTime()) / 86400000);
    }

    // Normalize spend with K/M multiplier
    let clientTotalSpend = null;
    if (totalSpendMatch) {
      const num = parseFloat(totalSpendMatch[1].replace(/,/g, ''));
      const mult = (totalSpendMatch[2] || '').toUpperCase();
      clientTotalSpend = mult === 'M' ? num * 1_000_000 : mult === 'K' ? num * 1_000 : num;
    }

    return {
      title,
      budget,
      budgetType: detectBudgetType(budgetTypeText || budget),
      clientCountry,
      postedDate,
      postedTimestamp: parsePostedDate(postedDate),
      skills,
      descriptionSnippet,
      proposalsText,
      clientHireRate: hireRateMatch ? parseInt(hireRateMatch[1]) / 100 : null,
      clientTotalSpend,
      clientAvgHourly: avgHourlyMatch ? parseFloat(avgHourlyMatch[1]) : null,
      clientRating: clientRatingMatch ? parseFloat(clientRatingMatch[1]) : null,
      clientReviews: reviewCountMatch ? parseInt(reviewCountMatch[1]) : null,
      paymentVerified,
      clientJobsPosted,
      clientMemberSinceDays,
    };
  }

  // ----------------------------------------------------------
  // Detail-page deterministic score (0-100). Used inside the Review
  // overlay — by that point all signals are visible so the score is
  // trustworthy. Cards on search pages are too sparse for this.
  // ----------------------------------------------------------
  // Data-backed scoring calibrated against Upwork research (proposal hit-rate
  // curves, hire-rate distribution, AI-automation niche rates). Total 100.
  // Negative points apply for known anti-patterns. Final score is floored at 0.
  function computeJobScore(job) {
    if (!job) return { score: 0, breakdown: {}, missing: [], flags: [] };
    const b = {};
    const missing = [];
    const flags = [];

    // ----- Proposals (22 pts) — outsized reward for <5; steep cliff after -----
    const p = (job.proposalsText || '').toLowerCase();
    if (/less than 5|fewer than 5|<\s*5/.test(p))   b.proposals = 22;
    else if (/50\+|over 50/.test(p))                b.proposals = -3;
    else {
      const range = p.match(/(\d+)\s*(?:to|-)\s*(\d+)/);
      if (range) {
        const max = parseInt(range[2]);
        if (max <= 10)      b.proposals = 6;
        else if (max <= 15) b.proposals = 1;
        else if (max <= 20) b.proposals = 0;
        else                b.proposals = -2;
      } else missing.push('proposals');
    }

    // ----- Recency (12 pts) — sharper falloff -----
    if (job.postedTimestamp) {
      const ageMin = (Date.now() - job.postedTimestamp) / 60000;
      if (ageMin < 15)        b.recency = 12;
      else if (ageMin < 60)   b.recency = 7;
      else if (ageMin < 120)  b.recency = 2;
      else if (ageMin < 360)  b.recency = 0;
      else if (ageMin < 1440) b.recency = -1;
      else                    b.recency = -2;
    } else missing.push('recency');

    // ----- Budget (18 pts) — biggest signal in AI automation niche -----
    // Bigger jumps at the $75 and $100/hr thresholds to differentiate
    // "okay-rate" from "good-rate" from "premium" clients
    const budgetText = (job.budget || '').toLowerCase();
    const hourly = budgetText.match(/\$([\d.]+)\s*[-–]\s*\$([\d.]+)/);
    const fixed = !hourly && budgetText.match(/\$([\d,]+(?:\.\d+)?)/);
    if (hourly) {
      const max = parseFloat(hourly[2]);
      if (max >= 100)     b.budget = 18;
      else if (max >= 75) b.budget = 12;
      else if (max >= 50) b.budget = 5;
      else if (max >= 30) b.budget = 1;
      else                b.budget = -5;
    } else if (fixed) {
      const v = parseFloat(fixed[1].replace(/,/g, ''));
      if (v >= 10000)     b.budget = 18;
      else if (v >= 5000) b.budget = 12;
      else if (v >= 1000) b.budget = 5;
      else if (v >= 300)  b.budget = 1;
      else                b.budget = -5;
    } else missing.push('budget');

    // ----- Client total spend (13 pts) — $0 / <$1K = real red flags -----
    if (typeof job.clientTotalSpend === 'number') {
      const s = job.clientTotalSpend;
      if (s === 0)          b.spend = -8;
      else if (s < 1000)    b.spend = 0;
      else if (s >= 100000) b.spend = 13;
      else if (s >= 10000)  b.spend = 9;
      else                  b.spend = 4;
    } else missing.push('spend');

    // ----- Hire rate (9 pts) — <20% bigger penalty -----
    if (typeof job.clientHireRate === 'number') {
      const hr = job.clientHireRate;
      if (hr >= 0.75)      b.hireRate = 9;
      else if (hr >= 0.50) b.hireRate = 5;
      else if (hr >= 0.20) b.hireRate = 2;
      else                 b.hireRate = -8;
    } else missing.push('hireRate');

    // ----- Payment verified (5 pts) — only 5 since most jobs have it;
    //       unverified is a real -10 penalty (no Upwork protection)
    if (typeof job.paymentVerified === 'boolean') {
      b.paymentVerified = job.paymentVerified ? 5 : -10;
      if (!job.paymentVerified) flags.push('no payment verification');
    } else missing.push('paymentVerified');

    // ----- Client rating (6 pts) — most cluster at 4.9, so we discriminate at the top -----
    if (typeof job.clientRating === 'number') {
      const r = job.clientRating;
      if (r >= 4.95)     b.rating = 6;
      else if (r >= 4.8) b.rating = 4;
      else if (r >= 4.5) b.rating = 2;
      else               b.rating = -3;
    } else missing.push('rating');

    // ----- Reviews count (6 pts) -----
    if (typeof job.clientReviews === 'number') {
      const n = job.clientReviews;
      if (n >= 100)     b.reviews = 6;
      else if (n >= 20) b.reviews = 5;
      else if (n >= 5)  b.reviews = 3;
      else if (n >= 1)  b.reviews = 1;
      else              b.reviews = -2;
    } else missing.push('reviews');

    // ----- Scope clarity (5 pts) -----
    const desc = (job.descriptionSnippet || '').toLowerCase();
    if (desc) {
      let pts = 0;
      if (desc.length > 800)      pts += 2;
      else if (desc.length > 400) pts += 1;
      if (/[•·]\s|^\s*[-*]\s|^\d+[.)]\s/m.test(desc)) pts += 2;
      if (/\bmilestone|deliverable|requirements?\b/.test(desc)) pts += 1;
      b.scopeClarity = Math.min(5, pts);
    } else missing.push('scopeClarity');

    // ----- Client tenure / sanity check (2 pts) -----
    if (typeof job.clientMemberSinceDays === 'number') {
      if (job.clientMemberSinceDays >= 365)     b.tenure = 2;
      else if (job.clientMemberSinceDays >= 90) b.tenure = 1;
      else if (job.clientMemberSinceDays < 30 && (job.clientReviews === 0 || job.clientReviews == null)) {
        b.tenure = -3;
        flags.push('new account, no reviews');
      } else b.tenure = 0;
    }

    // ----- LTV signal (2 pts) — soft tiebreaker only -----
    if (/\b(ongoing|long[-\s]term|weekly|monthly|continuous|recurring|retainer|part[-\s]time)\b/.test(desc)) {
      b.ltv = 2;
    }

    // ----- Sum + anti-pattern overlay -----
    let total = Object.values(b).reduce((sum, v) => sum + (v || 0), 0);

    // Ghost-lister cap: 0% hire rate with multiple posts is a strong red flag
    if (job.clientHireRate === 0 && typeof job.clientJobsPosted === 'number' && job.clientJobsPosted >= 5) {
      total = Math.min(total, 30);
      flags.push('ghost lister (0% hire rate, multiple posts)');
    }

    // Floor at 0
    total = Math.max(0, total);

    return { score: Math.round(total), breakdown: b, missing, flags };
  }

  // ----------------------------------------------------------
  // Scrape a single search result card
  // ----------------------------------------------------------
  function scrapeSearchCard(card) {
    const s = SELECTORS.search;
    const title = safeTextMulti(card, s.jobTitle);
    const href = safeHref(card, s.jobTitle);
    const budget = safeTextMulti(card, s.jobBudget);
    const postedDate = safeTextMulti(card, s.jobPosted);
    const skills = safeListText(card, s.jobSkills);
    const descriptionSnippet = (safeTextMulti(card, s.jobDescription) || '').substring(0, 200);
    const clientCountry = safeTextMulti(card, s.jobLocation);

    const id = href ? getJobIdFromUrl(href) : null;
    const url = href ? href.split('?')[0] : null;

    return {
      id,
      url,
      title,
      budget,
      budgetType: detectBudgetType(budget),
      clientCountry,
      postedDate,
      postedTimestamp: parsePostedDate(postedDate),
      skills,
      descriptionSnippet,
    };
  }

  // ----------------------------------------------------------
  // Storage helpers
  // ----------------------------------------------------------
  function contextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch (e) {
      return false;
    }
  }

  function getJobs() {
    if (!contextValid()) return Promise.resolve({});
    return new Promise(resolve => {
      chrome.storage.local.get({ jobs: {} }, result => resolve(result.jobs));
    });
  }

  function saveJob(job) {
    if (!contextValid()) return Promise.resolve();
    return new Promise(resolve => {
      chrome.storage.local.get({ jobs: {} }, result => {
        const jobs = result.jobs;
        jobs[job.id] = job;
        chrome.storage.local.set({ jobs }, resolve);
      });
    });
  }

  function removeJob(jobId) {
    if (!contextValid()) return Promise.resolve();
    return new Promise(resolve => {
      chrome.storage.local.get({ jobs: {} }, result => {
        const jobs = result.jobs;
        delete jobs[jobId];
        chrome.storage.local.set({ jobs }, resolve);
      });
    });
  }

  function isShortlisted(jobId) {
    if (!contextValid()) return Promise.resolve(false);
    return new Promise(resolve => {
      chrome.storage.local.get({ jobs: {} }, result => {
        resolve(!!result.jobs[jobId]);
      });
    });
  }

  // ----------------------------------------------------------
  // Shortlist + reject buttons on SEARCH RESULTS
  // ----------------------------------------------------------
  function createSearchButtons(jobData, existingJob) {
    const wrap = document.createElement('div');
    wrap.className = 'ujs-btn-group';
    wrap.dataset.ujsJobId = jobData.id;

    const addBtn = document.createElement('button');
    addBtn.className = 'ujs-shortlist-btn';
    addBtn.title = 'Add to shortlist';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'ujs-reject-btn';
    rejectBtn.title = 'Reject';

    wrap.appendChild(addBtn);
    wrap.appendChild(rejectBtn);

    function applyState(job) {
      const card = wrap.closest('.job-tile, article, section.air3-card-section, .notifications-list__item');
      // Reset all states
      addBtn.classList.remove('ujs-shortlisted', 'ujs-applied');
      rejectBtn.classList.remove('ujs-rejected');
      if (card) {
        card.classList.remove('ujs-card-rejected', 'ujs-card-shortlisted', 'ujs-card-applied');
      }

      if (!job) {
        addBtn.textContent = '+';
        rejectBtn.textContent = '\u00d7';
      } else if (job.status === 'rejected') {
        addBtn.textContent = '\u2713';
        rejectBtn.textContent = '\u00d7';
        rejectBtn.classList.add('ujs-rejected');
        if (card) card.classList.add('ujs-card-rejected');
      } else if (job.status === 'applied') {
        addBtn.textContent = '\u2709';
        addBtn.classList.add('ujs-applied');
        rejectBtn.textContent = '\u00d7';
        if (card) card.classList.add('ujs-card-applied');
      } else {
        addBtn.textContent = '\u2713';
        addBtn.classList.add('ujs-shortlisted');
        rejectBtn.textContent = '\u00d7';
        if (card) card.classList.add('ujs-card-shortlisted');
      }
    }

    applyState(existingJob);

    addBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!jobData.id) return;
      const jobs = await getJobs();
      const existing = jobs[jobData.id];

      // Toggle off - remove from list if already shortlisted/rated
      if (existing && existing.status !== 'rejected') {
        await removeJob(jobData.id);
        applyState(null);
        return;
      }

      const job = {
        ...jobData,
        shortlistedAt: Date.now(),
        status: 'shortlisted',
        rating: null,
      };
      await saveJob(job);
      applyState(job);
    });

    rejectBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!jobData.id) return;
      const jobs = await getJobs();
      const existing = jobs[jobData.id];

      // Toggle off - unreject
      if (existing && existing.status === 'rejected') {
        await removeJob(jobData.id);
        applyState(null);
        return;
      }

      const job = existing || {
        ...jobData,
        shortlistedAt: Date.now(),
        rating: null,
      };
      job.status = 'rejected';
      await saveJob(job);
      applyState(job);
    });

    // Expose applyState so storage listener can update
    wrap._applyState = applyState;

    return wrap;
  }

  async function injectSearchButtons() {
    const selectorString = SELECTORS.search.jobCard;
    const selectors = selectorString.split(',').map(s => s.trim());
    let cards = [];
    for (const sel of selectors) {
      cards = document.querySelectorAll(sel);
      if (cards.length > 0) break;
    }

    const jobs = await getJobs();

    cards.forEach(card => {
      if (card.querySelector('.ujs-btn-group')) return;

      const jobData = scrapeSearchCard(card);
      if (!jobData.id) return;

      const existingJob = jobs[jobData.id] || null;
      const wrap = createSearchButtons(jobData, existingJob);

      // Try to inject inline with Upwork's native action buttons
      // (heart / dislike / save). Fall back to absolute corner.
      const nativeAction = findNativeActionAnchor(card);
      if (nativeAction) {
        wrap.classList.add('ujs-btn-group-inline');
        // Walk up to the shared parent that contains ALL native action buttons,
        // then prepend so our pair sits at the leftmost edge of the toolbar.
        const group = findActionGroupContainer(nativeAction, card);
        group.insertBefore(wrap, group.firstChild);
      } else {
        card.style.position = card.style.position || 'relative';
        card.appendChild(wrap);
      }
    });
  }

  // Locate the LEFTMOST of Upwork's native action buttons (heart/dislike/save)
  // so we can prepend our buttons in front of the whole group.
  function findNativeActionAnchor(card) {
    const allCandidates = [];
    const selectors = [
      '[data-test="job-feedback-save-button"]',
      '[data-test="job-feedback"]',
      'button[aria-label^="Save job" i]',
      'button[aria-label*="dislike" i]',
      'button[aria-label*="not interested" i]',
      'button[aria-label*="like" i]',
      'button[aria-label*="save" i]',
      'button[data-test*="dislike" i]',
      'button[data-test*="like" i]',
      '[data-test="dislike-button"]',
      '[data-test="save-job-button"]',
    ];
    for (const sel of selectors) {
      try {
        card.querySelectorAll(sel).forEach(b => allCandidates.push(b));
      } catch (e) { /* skip */ }
    }
    if (!allCandidates.length) return null;
    // Pick the one with the smallest left coordinate — the leftmost button
    let leftmost = allCandidates[0];
    let minX = leftmost.getBoundingClientRect().left;
    for (const b of allCandidates) {
      const x = b.getBoundingClientRect().left;
      if (x < minX) { minX = x; leftmost = b; }
    }
    return leftmost;
  }

  // Find the inner toolbar row that holds Upwork's native action buttons
  // (thumbs-down + heart). On /search/jobs this is .job-tile-actions > .d-flex
  // — the thumbs-down has no aria-label so we can't rely on querying buttons.
  function findActionGroupContainer(anchorBtn, card) {
    // Preferred: Upwork's known structure. On /search/jobs there's an inner
    // .d-flex row inside .job-tile-actions; on feed pages there isn't —
    // .job-tile-actions itself directly contains the dislike + save siblings.
    const actionsCol = card.querySelector('.job-tile-actions');
    if (actionsCol) {
      const innerRow = actionsCol.querySelector('.d-flex');
      return innerRow || actionsCol;
    }
    // Fallback: walk up looking for an ancestor with multiple button-like children
    let el = anchorBtn.parentElement;
    while (el && el !== card) {
      try {
        if (el.querySelectorAll('button, [role="button"]').length >= 2) return el;
      } catch (e) { /* skip */ }
      el = el.parentElement;
    }
    return anchorBtn.parentElement;
  }

  // ----------------------------------------------------------
  // Shortlist button on JOB DETAIL page
  // ----------------------------------------------------------
  async function injectDetailButton() {
    if (document.querySelector('.ujs-detail-btn')) return;

    const jobId = getJobIdFromUrl();
    if (!jobId) return;

    const alreadyShortlisted = await isShortlisted(jobId);

    const btn = document.createElement('button');
    btn.className = 'ujs-detail-btn';
    btn.dataset.ujsJobId = jobId;

    function updateDetailBtn(shortlisted) {
      btn.textContent = shortlisted ? '\u2713 Shortlisted' : '\u2605 Shortlist';
      btn.classList.toggle('ujs-shortlisted', shortlisted);
    }

    updateDetailBtn(alreadyShortlisted);

    btn.addEventListener('click', async () => {
      const already = await isShortlisted(jobId);
      if (already) return;

      const scraped = scrapeDetailPage();
      const job = {
        id: jobId,
        url: window.location.href.split('?')[0],
        ...scraped,
        shortlistedAt: Date.now(),
        status: 'shortlisted',
        rating: null,
      };
      await saveJob(job);
      updateDetailBtn(true);
    });

    document.body.appendChild(btn);
  }

  // ----------------------------------------------------------
  // Review overlay (Shadow DOM) on JOB DETAIL page
  // ----------------------------------------------------------
  async function injectReviewOverlay() {
    if (document.querySelector('.ujs-review-host')) return;

    const jobId = getJobIdFromUrl();
    if (!jobId) return;

    const jobs = await getJobs();
    // If not yet shortlisted, build a stub from the current page so the
    // overlay can still render. Star/reject clicks below will save it
    // (auto-shortlist + apply rating in one tap).
    const job = jobs[jobId] || {
      id: jobId,
      url: window.location.href.split('?')[0],
      status: null,
      rating: null,
    };

    const host = document.createElement('div');
    host.className = 'ujs-review-host';
    const shadow = host.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
        }
        .card {
          position: fixed;
          top: 84px;
          right: 24px;
          width: 296px;
          background: #FFFFFF;
          border: 1px solid rgba(60, 50, 40, 0.08);
          border-radius: 16px;
          box-shadow: 0 1px 2px rgba(60, 50, 40, 0.04), 0 6px 24px rgba(60, 50, 40, 0.08);
          color: #3D3A36;
          z-index: 999999;
          overflow: hidden;
          transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1), transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Minimized = small circular pill in same corner */
        .card.minimized {
          width: 44px;
          height: 44px;
          padding: 0;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #FFFFFF;
          border-color: rgba(127, 168, 142, 0.32);
          box-shadow: 0 1px 3px rgba(60, 50, 40, 0.08), 0 6px 18px rgba(60, 50, 40, 0.06);
        }
        .card.minimized .body { display: none; }
        .card.minimized .header { display: none; }
        .card.minimized::before {
          content: '\u2605';
          color: #7FA88E;
          font-size: 20px;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 16px 8px;
        }
        .header-label {
          font-size: 11px;
          font-weight: 500;
          color: #8A857F;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .minimize-btn {
          width: 22px;
          height: 22px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          border-radius: 6px;
          color: #A39E97;
          cursor: pointer;
          padding: 0;
          transition: background 100ms ease, color 100ms ease;
        }
        .minimize-btn:hover {
          background: rgba(60, 50, 40, 0.06);
          color: #3D3A36;
        }

        .body {
          padding: 4px 18px 18px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        /* Algo score block */
        .algo {
          display: flex;
          align-items: baseline;
          gap: 8px;
          padding: 10px 14px;
          border-radius: 12px;
          border: 1px solid;
        }
        .algo-num {
          font-size: 26px;
          font-weight: 700;
          letter-spacing: -0.02em;
          font-variant-numeric: tabular-nums;
          line-height: 1;
        }
        .algo-of {
          font-size: 12px;
          font-weight: 500;
          opacity: 0.55;
          margin-right: auto;
        }
        .algo-tier {
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          opacity: 0.7;
        }
        .algo.high { background: rgba(127, 168, 142, 0.14); border-color: rgba(127, 168, 142, 0.40); color: #4F7860; }
        .algo.mid  { background: rgba(201, 148, 89, 0.12);  border-color: rgba(201, 148, 89, 0.35);  color: #9A6F35; }
        .algo.low  { background: rgba(120, 110, 100, 0.08); border-color: rgba(120, 110, 100, 0.25); color: #6B6660; }

        /* Section label */
        .section-label {
          font-size: 11px;
          font-weight: 500;
          color: #8A857F;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          margin-bottom: -6px;
        }

        .stars {
          display: flex;
          gap: 2px;
          justify-content: space-between;
        }
        .star {
          flex: 1;
          height: 36px;
          font-size: 22px;
          cursor: pointer;
          background: transparent;
          border: none;
          color: #DCD8D2;
          padding: 0;
          border-radius: 8px;
          transition: color 120ms ease, background 120ms ease, transform 80ms ease;
          line-height: 1;
        }
        .star:hover {
          color: #C99459;
          background: rgba(201, 148, 89, 0.08);
        }
        .star:active { transform: scale(0.94); }
        .star.active { color: #C99459; }

        .actions {
          display: flex;
          gap: 8px;
        }
        .btn {
          flex: 1;
          padding: 9px 14px;
          border-radius: 10px;
          border: 1px solid;
          background: transparent;
          cursor: pointer;
          font-size: 12.5px;
          font-weight: 500;
          font-family: inherit;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .btn-reject {
          color: #C97B7B;
          border-color: rgba(201, 123, 123, 0.32);
        }
        .btn-reject:hover {
          background: rgba(201, 123, 123, 0.10);
          border-color: rgba(201, 123, 123, 0.55);
        }
        .btn-reject.active {
          background: #C97B7B;
          color: #fff;
          border-color: #C97B7B;
        }
        .btn-restore {
          color: #5E8A6F;
          border-color: rgba(127, 168, 142, 0.32);
        }
        .btn-restore:hover {
          background: rgba(127, 168, 142, 0.10);
          border-color: rgba(127, 168, 142, 0.55);
        }

        .status-text {
          font-size: 11px;
          color: #8A857F;
          text-align: center;
        }
      </style>
      <div class="card" id="card">
        <div class="header">
          <span class="header-label">Job review</span>
          <button class="minimize-btn" id="minimizeBtn" title="Minimize" aria-label="Minimize">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="6" x2="10" y2="6"></line></svg>
          </button>
        </div>
        <div class="body">
          <div class="algo low" id="algo" title="">
            <span class="algo-num" id="algoNum">\u2014</span>
            <span class="algo-of">/100</span>
            <span class="algo-tier" id="algoTier">scoring\u2026</span>
          </div>
          <div class="section-label">Your rating</div>
          <div class="stars" id="stars">
            <button class="star" data-rating="1">\u2605</button>
            <button class="star" data-rating="2">\u2605</button>
            <button class="star" data-rating="3">\u2605</button>
            <button class="star" data-rating="4">\u2605</button>
            <button class="star" data-rating="5">\u2605</button>
          </div>
          <div class="actions" id="actions">
            <button class="btn btn-reject" id="rejectBtn">Reject</button>
          </div>
          <div class="status-text" id="statusText"></div>
        </div>
      </div>
    `;

    const card = shadow.getElementById('card');
    const stars = shadow.querySelectorAll('.star');
    const rejectBtn = shadow.getElementById('rejectBtn');
    const statusText = shadow.getElementById('statusText');
    const minimizeBtn = shadow.getElementById('minimizeBtn');
    const actionsDiv = shadow.getElementById('actions');
    const algoEl = shadow.getElementById('algo');
    const algoNumEl = shadow.getElementById('algoNum');
    const algoTierEl = shadow.getElementById('algoTier');

    // Render algo score — runs after page hydration so all signals are scraped
    function renderAlgoScore() {
      try {
        const fresh = scrapeDetailPage();
        const merged = { ...(jobs[jobId] || {}), ...fresh };
        const { score, breakdown, missing, flags } = computeJobScore(merged);
        const tier = score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low';
        algoEl.classList.remove('high', 'mid', 'low');
        algoEl.classList.add(tier);
        algoNumEl.textContent = score;
        algoTierEl.textContent = tier === 'high' ? 'strong' : tier === 'mid' ? 'okay' : 'weak';
        const lines = ['Algo score ' + score + '/100', ''];
        for (const [k, v] of Object.entries(breakdown)) {
          const sign = v < 0 ? '' : '+';  // negative shown as-is
          lines.push('  ' + k + ': ' + sign + v);
        }
        if (flags && flags.length) {
          lines.push('');
          lines.push('Red flags:');
          flags.forEach(f => lines.push('  ⚠ ' + f));
        }
        if (missing && missing.length) {
          lines.push('');
          lines.push('Missing signals: ' + missing.join(', '));
        }
        algoEl.title = lines.join('\n');
      } catch (e) {
        algoEl.title = 'Score unavailable: ' + e.message;
      }
    }
    renderAlgoScore();
    // Re-score once after a beat — gives SPA a chance to finish hydrating
    setTimeout(renderAlgoScore, 1500);

    // Restore state
    function renderState(j) {
      stars.forEach(s => {
        const val = parseInt(s.dataset.rating);
        s.classList.toggle('active', j.rating && val <= j.rating);
      });

      if (j.status === 'rejected') {
        rejectBtn.classList.add('active');
        rejectBtn.textContent = 'Rejected';
        // Add restore button if not present
        if (!shadow.getElementById('restoreBtn')) {
          const restoreBtn = document.createElement('button');
          restoreBtn.className = 'btn btn-restore';
          restoreBtn.id = 'restoreBtn';
          restoreBtn.textContent = 'Restore';
          restoreBtn.addEventListener('click', async () => {
            const jobs = await getJobs();
            const current = jobs[jobId];
            if (current) {
              current.status = 'shortlisted';
              await saveJob(current);
              renderState(current);
            }
          });
          actionsDiv.appendChild(restoreBtn);
        }
        statusText.textContent = 'This job has been rejected';
      } else {
        rejectBtn.classList.remove('active');
        rejectBtn.textContent = 'Reject';
        const existing = shadow.getElementById('restoreBtn');
        if (existing) existing.remove();
        if (j.rating) {
          statusText.textContent = 'Rated ' + j.rating + '/5';
        } else {
          statusText.textContent = '';
        }
      }
    }

    renderState(job);

    // Star click
    // Build (or fetch) the job to save. If user hasn't shortlisted yet,
    // scrape the detail page so we capture the title/budget/skills/etc.
    async function getOrCreateJob() {
      const jobs = await getJobs();
      if (jobs[jobId]) return jobs[jobId];
      const scraped = scrapeDetailPage();
      return {
        id: jobId,
        url: window.location.href.split('?')[0],
        ...scraped,
        shortlistedAt: Date.now(),
        status: 'shortlisted',
        rating: null,
      };
    }

    // Auto-tab-advance: after a rating or reject, close this tab and
    // activate the next one in the window so the user keeps reviewing
    // without trekking back to the tab bar.
    function advanceToNextTab() {
      // Tiny delay so the storage write commits + the visual state shows briefly
      setTimeout(() => {
        try { chrome.runtime.sendMessage({ action: 'closeTabAndAdvance' }); } catch (e) { /* ignore */ }
      }, 250);
    }

    stars.forEach(starBtn => {
      starBtn.addEventListener('click', async () => {
        const rating = parseInt(starBtn.dataset.rating);
        const current = await getOrCreateJob();
        current.rating = rating;
        current.status = 'rated';
        await saveJob(current);
        renderState(current);
        advanceToNextTab();
      });
    });

    // Reject click
    rejectBtn.addEventListener('click', async () => {
      const current = await getOrCreateJob();
      if (current.status === 'rejected') return;
      current.status = 'rejected';
      await saveJob(current);
      renderState(current);
      advanceToNextTab();
    });

    // Minimize toggle \u2014 click the pill itself to restore
    let minimized = false;
    function setMinimized(state) {
      minimized = state;
      card.classList.toggle('minimized', minimized);
      const detailBtn = document.querySelector('.ujs-detail-btn');
      if (detailBtn) detailBtn.style.display = minimized ? 'none' : '';
    }
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMinimized(true);
    });
    card.addEventListener('click', (e) => {
      if (minimized) setMinimized(false);
    });

    document.body.appendChild(host);
  }

  // ----------------------------------------------------------
  // Auto-detect application status on job detail pages
  // ----------------------------------------------------------
  async function detectAppliedStatus() {
    if (!contextValid()) return;
    const jobId = getJobIdFromUrl();
    if (!jobId) return;

    const jobs = await getJobs();
    const job = jobs[jobId];
    if (!job) return;
    if (job.status === 'applied') return;

    // Check for "already submitted a proposal" or "View Proposal" link
    const bodyText = document.body.innerText.toLowerCase();
    const hasSubmitted = bodyText.includes('already submitted a proposal') ||
                         bodyText.includes('already applied') ||
                         bodyText.includes('view proposal');

    if (hasSubmitted) {
      job.status = 'applied';
      await saveJob(job);
    }
  }

  // Detect application on proposal/confirmation pages
  // Post-submit URL is /nx/proposals/{proposalId}?success which has NO job ID,
  // so we fall back to the jobId we stashed at submit-click time.
  async function detectAppliedOnProposalPage() {
    if (!contextValid()) return;
    const path = window.location.pathname;
    const queryString = window.location.search;

    let jobId = getJobIdFromUrl(window.location.href);
    if (!jobId) {
      // Fall back to the pending application we stashed when user clicked submit
      const stash = await new Promise(r => chrome.storage.local.get({ pendingApplication: null }, r));
      jobId = stash.pendingApplication?.jobId || null;
    }
    if (!jobId) return;

    const jobs = await getJobs();
    const job = jobs[jobId];
    if (!job || job.status === 'applied') return;

    const bodyText = document.body.innerText.toLowerCase();
    const onApplyForm = /\/apply\b/.test(path);

    // Strong markers — trust anywhere
    const strongMatch = bodyText.includes('your proposal was submitted') ||
                        bodyText.includes('proposal submitted') ||
                        bodyText.includes('submitted successfully') ||
                        bodyText.includes('your proposal has been sent') ||
                        bodyText.includes('successfully sent your proposal') ||
                        bodyText.includes('already submitted a proposal');

    // Strong URL signal: ?success query param after submission
    const successQuery = /[?&]success(=|&|$)/.test(queryString);

    // Broad markers that ALSO match the empty /apply/ form page — trust only
    // when we're NOT on the apply form (i.e. user has already navigated to
    // the post-submit confirmation/details page)
    const broadMatch = !onApplyForm && (
      bodyText.includes('your proposal') ||
      bodyText.includes('view proposal')
    );

    // URL-based fallback: confirmation pages live at /nx/proposals/{proposalId}
    // (no job ID, just a numeric proposal ID) — intrinsically post-submit.
    const urlBasedMatch = !onApplyForm && /\/proposals\/(\d+|job\/~\d+)/.test(path);

    const isConfirmation = strongMatch || broadMatch || urlBasedMatch || successQuery;

    if (isConfirmation) {
      job.status = 'applied';
      await saveJob(job);
      // Silently expand the "more" toggle so the description scrape captures
      // the full text before pushing, then push + install a manual hook as
      // backup in case auto-expand misses a non-standard toggle.
      try { await expandDescriptionIfTruncated(); } catch (e) { /* ignore */ }
      await pushApplicationToNotion(jobId).catch(() => {});
      hookConfirmationMoreClick(jobId);
    }
  }

  // ----------------------------------------------------------
  // Proposal page: scrape submit form + push to Notion
  // ----------------------------------------------------------
  function scrapeProposalForm() {
    // Best-effort — Upwork's proposal form selectors change. Multiple fallbacks.
    const findValue = (selectors) => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el && (el.value || el.textContent)) {
            return (el.value || el.textContent).trim();
          }
        } catch (e) { /* skip */ }
      }
      return null;
    };

    const coverLetter = findValue([
      'textarea[aria-label*="cover letter" i]',
      'textarea[name*="cover" i]',
      'textarea[data-test*="cover" i]',
      '.cover-letter textarea',
      'textarea',
    ]);

    const rateStr = findValue([
      'input[aria-label*="hourly rate" i]',
      'input[aria-label*="bid" i]',
      'input[name*="rate" i]',
      'input[name*="bid" i]',
      'input[data-test*="rate" i]',
      'input[type="number"]',
    ]);
    const rateSubmitted = rateStr ? parseFloat(rateStr.replace(/[^\d.]/g, '')) : null;

    // Boost: Upwork now uses a numeric "Bid to boost" input, not a checkbox.
    // Treat as used when value > 0.
    let boostUsed = false;
    let boostAmount = null;
    document.querySelectorAll('input[type="number"], input[inputmode="numeric"]').forEach(input => {
      const label = (input.closest('label')?.textContent ||
                     input.getAttribute('aria-label') ||
                     input.previousElementSibling?.textContent ||
                     '').toLowerCase();
      if (/boost/i.test(label)) {
        const v = parseFloat(input.value);
        if (!isNaN(v)) {
          boostAmount = v;
          if (v > 0) boostUsed = true;
        }
      }
    });

    const bodyText = document.body.innerText || '';

    // Connects: prefer the submit button text ("Send for 11 Connects"), fall back to body
    let connectsSpent = null;
    const sendBtn = Array.from(document.querySelectorAll('button')).find(b =>
      /^send\s+for\s+\d+\s+connects?/i.test((b.textContent || '').trim())
    );
    if (sendBtn) {
      const m = sendBtn.textContent.match(/(\d+)\s+connects?/i);
      if (m) connectsSpent = parseInt(m[1]);
    }
    if (connectsSpent === null) {
      const m = bodyText.match(/proposal\s+requires?\s+(\d+)\s+connects?/i) ||
                bodyText.match(/(\d+)\s+connects?\s+(?:required|to submit|will be used)/i);
      if (m) connectsSpent = parseInt(m[1]);
    }

    // Page-state snapshot — scrape client info from the proposal page's
    // sidebar right when the user submits. This is more reliable than
    // relying on cached detail-page data (user may have applied directly
    // from search results without visiting the job page first).
    const snapshot = scrapeClientInfoFromPage();

    return { coverLetter, rateSubmitted, boostUsed, boostAmount, connectsSpent, ...snapshot };
  }

  // Scrape client info from the current page (works on detail and proposal pages)
  function scrapeClientInfoFromPage() {
    const bodyText = document.body.innerText || '';

    const hireRateMatch = bodyText.match(/(\d{1,3})\s*%\s*(?:hire rate|job success)/i);
    const totalSpendMatch = bodyText.match(/\$([\d,.]+)\s*([KMkm])?\+?\s+(?:total\s+)?spent/i);
    // Scope avg-hourly to the value followed by "avg" / "avg hourly" — avoids
    // matching past-contract rates like "$10.00/hr" near "17 hrs @"
    const avgHourlyMatch = bodyText.match(/\$([\d.]+)\s*\/\s*hr\s+avg/i);
    // Match the rating that precedes "of N reviews" (e.g. "5.00 of 29 reviews")
    // — works whether the page shows "5.0\n5.00 of 29 reviews" or one line.
    const clientRatingMatch = bodyText.match(/(\d\.\d{1,2})[\s\S]{0,30}of\s+\d+\s*reviews?/i);
    // "Proposals:" is followed by a newline then the value — allow whitespace
    // Require plural "Proposals:" AND a recognizable count pattern.
    // Avoids matching things like "Required for proposal: 11 Connects".
    const proposalsMatch = bodyText.match(/Proposals:\s*(Less than \d+|\d+\s*to\s*\d+|\d+\+|Over \d+|\d+(?=\s|$))/i);
    // Budget — fixed price or hourly range, typically shown on proposal page too
    const budgetFixedMatch = bodyText.match(/\$([\d,]+(?:\.\d+)?)\s*(?:fixed[-\s]price|fixed budget)/i);
    // Hourly range — Upwork uses two formats:
    //   "$25 - $65 /hr"            (older)
    //   "$25.00 - $65.00 ... Hourly range"  (current confirmation page)
    const budgetHourlyMatch =
      bodyText.match(/\$([\d.]+)\s*[-–]\s*\$([\d.]+)\s*\/\s*hr/i) ||
      bodyText.match(/\$([\d.]+)\s*[-–]\s*\$([\d.]+)[\s\S]{0,60}Hourly\s+range/i);

    let clientTotalSpend = null;
    if (totalSpendMatch) {
      const num = parseFloat(totalSpendMatch[1].replace(/,/g, ''));
      const mult = (totalSpendMatch[2] || '').toUpperCase();
      clientTotalSpend = mult === 'M' ? num * 1_000_000 : mult === 'K' ? num * 1_000 : num;
    }

    let budget = null;
    if (budgetHourlyMatch) {
      budget = '$' + budgetHourlyMatch[1] + '-$' + budgetHourlyMatch[2] + '/hr';
    } else if (budgetFixedMatch) {
      budget = '$' + budgetFixedMatch[1];
    }

    // ---- Confirmation-page-only signals (won't match on detail/apply pages) ----

    // Fixed-price total: "Total price of project ... $1,497.95"
    const totalPriceMatch = bodyText.match(/Total\s+price\s+of\s+project[\s\S]{0,200}?\$([\d,]+(?:\.\d{1,2})?)/i);
    // Hourly rate — multiple anchors Upwork uses:
    //   "Hourly rate ... $34.95/hr"   (most common on confirmation)
    //   "Your bid ... $X/hr"          (older variant)
    //   "Your hourly rate ... $X/hr"
    // Last-resort fallback: the FIRST $X/hr on the page (gross rate is shown
    // before the "You'll receive after fees" section).
    const hourlyBidMatch =
      bodyText.match(/(?:Hourly\s+rate|Your\s+(?:bid|hourly\s+rate))[\s\S]{0,200}?\$([\d.]+)\s*\/\s*hr/i) ||
      bodyText.match(/\$([\d.]+)\s*\/\s*hr/i);
    // Net earnings: "You'll receive ... after service fees ... $1,273.26"
    const earningsMatch = bodyText.match(/You'?ll\s+receive[\s\S]{0,200}?\$([\d,]+(?:\.\d{1,2})?)/i);
    // Boost: "Boosted proposal" heading + "Your bid is set to N Connects"
    const boostedMatch = bodyText.match(/Boosted\s+proposal[\s\S]{0,200}?Your\s+bid\s+is\s+set\s+to\s+(\d+)\s+Connects?/i);

    const rateFromConfirmation =
      hourlyBidMatch ? parseFloat(hourlyBidMatch[1]) :
      totalPriceMatch ? parseFloat(totalPriceMatch[1].replace(/,/g, '')) :
      null;
    const proposalValueFromConfirmation = totalPriceMatch
      ? parseFloat(totalPriceMatch[1].replace(/,/g, ''))
      : null;
    const earningsAfterFeesFromConfirmation = earningsMatch
      ? parseFloat(earningsMatch[1].replace(/,/g, ''))
      : null;

    let boostUsedFromConfirmation = null;
    let boostAmountFromConfirmation = null;
    if (boostedMatch) {
      boostUsedFromConfirmation = true;
      boostAmountFromConfirmation = parseInt(boostedMatch[1]);
    } else if (/Your\s+proposal\s+(?:was\s+|is\s+)?(?:not\s+)?boosted/i.test(bodyText)
            || /Not\s+boosted/i.test(bodyText)) {
      // Explicit "not boosted" signal — only set false if we have negative evidence
      boostUsedFromConfirmation = false;
    }

    // Job description from confirmation page — Upwork shows it under "Job details"
    const descEl = document.querySelector('[data-test="Description"], [data-test="JobDescription"], .job-description, [class*="description" i]');
    const descriptionFromPage = descEl ? descEl.textContent.trim().substring(0, 2000) : null;

    return {
      clientHireRate: hireRateMatch ? parseInt(hireRateMatch[1]) / 100 : null,
      clientTotalSpend,
      clientAvgHourly: avgHourlyMatch ? parseFloat(avgHourlyMatch[1]) : null,
      clientRating: clientRatingMatch ? parseFloat(clientRatingMatch[1]) : null,
      proposalsText: proposalsMatch ? proposalsMatch[1].trim() : null,
      budgetFromPage: budget,
      rateFromConfirmation,
      proposalValueFromConfirmation,
      earningsAfterFeesFromConfirmation,
      boostUsedFromConfirmation,
      boostAmountFromConfirmation,
      descriptionFromPage,
    };
  }

  async function stashPendingApplication() {
    if (!contextValid()) return;
    const jobId = getJobIdFromUrl(window.location.href);
    if (!jobId) return;
    const form = scrapeProposalForm();
    return new Promise(resolve => {
      chrome.storage.local.set({
        pendingApplication: {
          jobId,
          dateApplied: Date.now(),
          ...form,
        }
      }, resolve);
    });
  }

  function attachProposalSubmitHook() {
    if (document.body.dataset.ujsSubmitHook === '1') return;
    document.body.dataset.ujsSubmitHook = '1';

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, [role="button"]');
      if (!btn) return;
      const text = (btn.textContent || '').trim();
      // Match the proposal-submit button. Upwork's current label is
      // "Send for N Connects"; older variants use "Submit proposal" / "Send proposal".
      const isSubmit =
        /^send\s+for\s+\d+\s+connects?\b/i.test(text) ||
        /^(submit|send)\s+(a\s+)?proposal\b/i.test(text);
      if (isSubmit) {
        // Scrape NOW before navigation
        stashPendingApplication();
      }
    }, true); // capture phase
  }

  // Capture the application as a "pending push" entry. The user reviews and
  // pushes it to Notion manually from the popup — we do NOT auto-call Notion.
  async function pushApplicationToNotion(jobId) {
    if (!contextValid()) return;
    const data = await new Promise(r => chrome.storage.local.get({
      jobs: {}, pendingApplication: null, pendingPushes: {}
    }, r));
    if (data.pendingPushes[jobId]) return; // already captured

    const job = data.jobs[jobId];
    if (!job) return;

    const pending = data.pendingApplication && data.pendingApplication.jobId === jobId
      ? data.pendingApplication
      : {};

    // Re-scrape the CURRENT page (this fires on the confirmation page, where
    // client info is freshly visible — the apply form doesn't show it).
    const confSnap = scrapeClientInfoFromPage();

    // Prefer fresh confirmation-page data, then form-page snapshot,
    // then cached detail-page values.
    const pick3 = (...vals) => {
      for (const v of vals) {
        if (v !== null && v !== undefined && v !== '') return v;
      }
      return null;
    };

    const payload = {
      id: jobId,
      url: job.url || window.location.href.split('?')[0],
      title: job.title,
      budget: pick3(confSnap.budgetFromPage, pending.budgetFromPage, job.budget),
      skills: job.skills,
      descriptionSnippet: pick3(confSnap.descriptionFromPage, job.descriptionSnippet, pending.descriptionFromPage),
      proposalsText: pick3(confSnap.proposalsText, pending.proposalsText, job.proposalsText),
      clientHireRate: pick3(confSnap.clientHireRate, pending.clientHireRate, job.clientHireRate),
      clientTotalSpend: pick3(confSnap.clientTotalSpend, pending.clientTotalSpend, job.clientTotalSpend),
      clientAvgHourly: pick3(confSnap.clientAvgHourly, pending.clientAvgHourly, job.clientAvgHourly),
      clientRating: pick3(confSnap.clientRating, pending.clientRating, job.clientRating),
      reviewScore: job.rating ? job.rating : null,
      coverLetter: pending.coverLetter || '',
      // Rate Submitted: confirmation page is the source of truth — apply-form
      // scrape often grabbed the boost connects number instead of the real bid.
      rateSubmitted: pick3(confSnap.rateFromConfirmation, pending.rateSubmitted),
      // Boost: confirmation page text is unambiguous ("Boosted proposal" / "Your bid is set to N Connects")
      boostUsed: confSnap.boostUsedFromConfirmation !== null
        ? confSnap.boostUsedFromConfirmation
        : pending.boostUsed,
      // connectsSpent comes from the "Send for N Connects" submit button — the
      // total cost (base + boost). Don't conflate with boost amount alone.
      connectsSpent: pending.connectsSpent,
      proposalValue: confSnap.proposalValueFromConfirmation,
      // Leave earnings-after-fees null at submission time — the user fills
      // it in manually after the actual payout clears (Upwork's "you'll
      // receive" estimate doesn't account for taxes / withdrawal fees)
      earningsAfterFees: null,
      dateApplied: pending.dateApplied || Date.now(),
    };

    data.pendingPushes[jobId] = {
      capturedAt: Date.now(),
      notionStatus: 'pending',
      notionPageUrl: null,
      notionError: null,
      pushedAt: null,
      payload,
    };

    chrome.storage.local.set({ pendingPushes: data.pendingPushes });
    chrome.storage.local.remove('pendingApplication');
  }

  // Watch for DOM changes that indicate a submission confirmation appeared
  function watchForApplicationConfirmation() {
    let debounceTimer = null;

    const check = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const path = window.location.pathname;
        const isProposalPage = path.includes('/proposals/') || path.includes('/apply/');
        const isDetailPage = !!path.match(/\/jobs\/.*~\d+/);

        if (isProposalPage) {
          detectAppliedOnProposalPage();
        } else if (isDetailPage) {
          detectAppliedStatus();
        }
      }, 1500);
    };

    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true });
    check();
  }

  // ----------------------------------------------------------
  // MutationObserver for infinite scroll
  // ----------------------------------------------------------
  function observeSearchResults() {
    const observer = new MutationObserver(() => {
      injectSearchButtons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ----------------------------------------------------------
  // Listen for storage changes to update button states
  // ----------------------------------------------------------
  chrome.storage.onChanged.addListener((changes) => {
    if (!changes.jobs) return;
    const newJobs = changes.jobs.newValue || {};

    // Update search button groups
    document.querySelectorAll('.ujs-btn-group').forEach(wrap => {
      const id = wrap.dataset.ujsJobId;
      if (wrap._applyState) {
        wrap._applyState(newJobs[id] || null);
      }
    });

    // Update detail button
    const detailBtn = document.querySelector('.ujs-detail-btn');
    if (detailBtn) {
      const id = detailBtn.dataset.ujsJobId;
      const shortlisted = !!newJobs[id];
      detailBtn.textContent = shortlisted ? '\u2713 Shortlisted' : '\u2605 Shortlist';
      detailBtn.classList.toggle('ujs-shortlisted', shortlisted);
    }
  });

  // ----------------------------------------------------------
  // Initialization
  // ----------------------------------------------------------
  function init() {
    const pageType = getPageType();

    if (pageType === 'search') {
      injectSearchButtons();
      observeSearchResults();
    } else if (pageType === 'detail') {
      injectDetailButton();
      // Expand truncated description (silent click on "more" toggle), then
      // inject the review overlay so its scrape captures the full text
      setTimeout(async () => {
        await expandDescriptionIfTruncated();
        injectReviewOverlay();
        const jobId = getJobIdFromUrl();
        if (jobId) hookManualMoreClick(jobId);
      }, 1200);
      setTimeout(detectAppliedStatus, 1500);
    } else if (pageType === 'proposal') {
      attachProposalSubmitHook();
    }
    watchForApplicationConfirmation();
  }

  // Upwork is an SPA - re-init on URL changes
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Small delay to let the SPA render
      setTimeout(init, 500);
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // Initial run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
