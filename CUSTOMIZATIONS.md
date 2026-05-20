# Personal customizations

This branch (`personal-fork`) layers personal customizations on top of upstream `mackym-dev/upwork-job-shortlister-chrome` (post merge of PR #1, `expand-page-coverage`). Not intended to be upstreamed — these are workflow choices specific to one user.

## What's different from upstream

### Visual redesign — calming aesthetic
- Warm cream backgrounds (`#FBF8F3`) instead of dark surfaces
- Soft sage accent (`#7FA88E`) replacing the original green
- Side-stripe card indicators (3px accent) replacing color-wash overlays
- Larger inline buttons matching Upwork's native action button scale
- Layered soft shadows; `cubic-bezier(0.16, 1, 0.3, 1)` easing
- Review overlay shadow-DOM rebuilt to match (cream background, sage star fills)

### Notion review-before-push queue
- New "Notion" filter chip in the popup with a pending-count badge
- Submitting a proposal **does not** auto-push to Notion — instead caches into a `pendingPushes` queue in `chrome.storage.local`
- Detail panel lets you review/edit every Notion schema field before push
- Push happens on explicit button click; status tracked per-row (pending / pushed / error)
- Notion credentials configured in a settings view (gear icon)

### Extension settings UI
- Settings view replaces parts of the old popup
- Token + Database ID stored in `chrome.storage.local`
- "Test connection" verifies Notion access end-to-end

### Page detection improvements
- `getPageType()` now recognizes `/nx/s/job-details-viewer/jobs/...~ID` variants
- Proposal-submission detection via:
  - `?success` URL query param (strongest signal)
  - "Your proposal was submitted" text
  - `/proposals/{numericId}` URL pattern
  - Fallback to stashed `pendingApplication.jobId` (post-submit URL doesn't carry the job ID)

### Proposal form scraping
- Submit-button click hook (capture phase) on `/apply/` pages
- Captures cover letter, rate, connects spent, boost amount before navigation
- Confirmation-page snapshot for client metrics (rating, hire rate %, total spend, avg hourly)
- All values merged with cache, prioritized fresh > pending > cached

### Detail-page enhancements
- Floating shortlist button uses `[data-test="job-title"]` selector
- `document.title` fallback when DOM selectors miss
- Inline injection of +/× buttons next to Upwork's native dislike/heart group

## Architecture

```
.
├── manifest.json              # +Notion host permission
├── background/
│   └── service-worker.js      # +Notion API handlers (test, create-page)
├── content/
│   ├── content.js             # +proposal hook, +confirmation detection,
│   │                          #  +form scraping, +Notion queue trigger,
│   │                          #  +inline button injection
│   └── content.css            # Calming aesthetic, design tokens
└── popup/
    ├── popup.html             # +settings view, +detail view, +filter chips
    ├── popup.css              # Calming aesthetic
    └── popup.js               # +Notion queue UI, +settings, +detail panel,
                               #  +filter chips, +search, +toast
```

## Upstream

This fork is the source of truth — not tracking upstream `mackym-dev/master` after PR #1 merged. If you ever want to pull in a specific upstream feature, cherry-pick the relevant commit explicitly rather than merging the whole branch.

## Notion DB schema

The push code targets these property names exactly — see [notion-schema.json](../../Volumes/SSD-500/Business/upwork/notion-schema.json) in the Business folder. Schema verified via Notion MCP on 2026-05-15.
