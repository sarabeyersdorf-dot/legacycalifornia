// api/_lib/timeline-template.js
// The standard California escrow timeline, in plain English, computed per deal
// from the same unit-tested RPA math the briefing calendar uses. Every entry
// is "what it is · when it's expected · whose court it's in" — deliberately
// no legal language.

import { computeTimeline, dealTimelineInput, addDays } from './deal-timeline.js';

// due:  (T) => 'YYYY-MM-DD' | null      (T = computeTimeline output)
const TEMPLATE = [
  { key: 'acceptance', kind: 'milestone', owner: 'both', sort: 10,
    title: 'Contract accepted',
    plain: 'All signatures are in — this is “Day 0.” Every deadline below counts from here.',
    due: (T) => T.day0, doneOnSeed: true },

  { key: 'escrow_open', kind: 'milestone', owner: 'escrow', sort: 20,
    title: 'Escrow opened',
    plain: 'The neutral third party (the escrow/title company) opens the file that will hold the money and paperwork until closing.',
    due: (T, deal) => deal.escrow_open_date || (T.day0 ? addDays(T.day0, 3) : null) },

  { key: 'emd', kind: 'milestone', owner: 'buyer', sort: 30,
    title: 'Buyer’s deposit received',
    plain: 'The buyer’s good-faith deposit lands at escrow, usually within 3 business days of acceptance.',
    due: (T) => T.day0 ? addDays(T.day0, 3) : null },

  { key: 'tds', kind: 'disclosure', owner: 'seller', sort: 40,
    title: 'Transfer Disclosure Statement (TDS)',
    plain: 'Your written description of the property’s condition — what works, what doesn’t, what you know. You sign; the buyer countersigns.',
    due: (T) => T.day0 ? addDays(T.day0, 7) : null },

  { key: 'spq', kind: 'disclosure', owner: 'seller', sort: 41,
    title: 'Seller Property Questionnaire (SPQ)',
    plain: 'A companion questionnaire covering the property’s history — repairs, insurance claims, neighborhood matters.',
    due: (T) => T.day0 ? addDays(T.day0, 7) : null },

  { key: 'nhd', kind: 'disclosure', owner: 'seller', sort: 42,
    title: 'Natural Hazard Disclosure (NHD)',
    plain: 'A third-party report showing official hazard zones (fire, flood, earthquake). It arrives ready-made — you just review and sign.',
    due: (T) => T.day0 ? addDays(T.day0, 7) : null },

  { key: 'cont_inspection', kind: 'contingency', owner: 'buyer', sort: 50, cKey: 'inspection',
    title: 'Buyer’s inspection contingency',
    plain: 'The buyer’s window to investigate the home and either move forward, negotiate, or step away. Removing it in writing is the milestone.' },

  { key: 'cont_appraisal', kind: 'contingency', owner: 'buyer', sort: 51, cKey: 'appraisal',
    title: 'Appraisal contingency',
    plain: 'The buyer’s lender confirms the home is worth the contract price. Removed once the appraisal supports the deal.' },

  { key: 'cont_title', kind: 'contingency', owner: 'buyer', sort: 52, cKey: 'title',
    title: 'Title & document review',
    plain: 'The buyer reviews the title report and your disclosures. Removed when everything reads clean.' },

  { key: 'cont_insurance', kind: 'contingency', owner: 'buyer', sort: 53, cKey: 'insurance',
    title: 'Insurance contingency',
    plain: 'The buyer confirms the home can be insured (a real question in fire country). Removed once coverage is locked.' },

  { key: 'cont_loan', kind: 'contingency', owner: 'buyer', sort: 54, cKey: 'loan',
    title: 'Loan contingency',
    plain: 'The buyer’s financing gets final approval. Once this is removed, the deal is substantially de-risked.' },

  { key: 'walkthrough', kind: 'milestone', owner: 'buyer', sort: 80,
    title: 'Buyer’s final walk-through',
    plain: 'About 5 days before closing, the buyer verifies the property is in the same condition and agreed repairs are done.',
    due: (T) => T.coe ? addDays(T.coe.date, -5) : null },

  { key: 'coe', kind: 'milestone', owner: 'both', sort: 90,
    title: 'Close of escrow',
    plain: 'The deed records, funds disburse, and the sale is complete. Congratulations!',
    due: (T) => T.coe ? T.coe.date : null }
];

// Build concrete rows for one deal. Contingency dates (and which contingencies
// still exist) come from computeTimeline — removed ones aren't seeded.
export function buildTimelineItems(deal) {
  const T = computeTimeline(dealTimelineInput(deal));
  const active = new Set(T.contingencies.map((c) => c.key));
  const byKey = Object.fromEntries(T.contingencies.map((c) => [c.key, c]));
  const rows = [];
  for (const t of TEMPLATE) {
    if (t.cKey) {
      if (!active.has(t.cKey)) continue;               // removed / not applicable
      rows.push({
        key: t.key, kind: t.kind, owner: t.owner, sort_order: t.sort,
        title: t.title, plain: t.plain,
        due_date: byKey[t.cKey].date, status: 'upcoming'
      });
    } else {
      rows.push({
        key: t.key, kind: t.kind, owner: t.owner, sort_order: t.sort,
        title: t.title, plain: t.plain,
        due_date: t.due ? (t.due(T, deal) || null) : null,
        status: (t.doneOnSeed && T.day0) ? 'done' : 'upcoming',
        done_at: (t.doneOnSeed && T.day0) ? new Date(T.day0 + 'T12:00:00Z').toISOString() : null
      });
    }
  }
  return rows;
}

// Evidence keywords for matching deal_documents rows to disclosure items.
export const DOC_EVIDENCE = {
  nhd: /natural hazard|nhd/i,
  tds: /transfer disclosure|tds/i,
  spq: /property questionnaire|spq/i,
  emd: /earnest|deposit receipt|emd/i
};
