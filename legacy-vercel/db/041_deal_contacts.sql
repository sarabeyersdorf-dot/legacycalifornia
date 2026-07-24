-- 041_deal_contacts.sql
-- Team contact details for a deal — the escrow officer's and co-agent's email &
-- phone, plus the escrow file number. Cowork extracts these from email comms and
-- writes them into deals.json under "contacts"; sync-deals maps the whole object
-- into this jsonb column, and the client portal's "Your team" block renders the
-- reachable contact info so a client can reach anyone on their team.
--
-- Shape (all keys optional):
--   {
--     "escrow":        "Jane Ramirez",
--     "escrowEmail":   "jramirez@fidelitytitle.com",
--     "escrowPhone":   "209-555-0100",
--     "escrowNumber":  "ESC-2026-0433",
--     "title":         "Fidelity National Title",
--     "coAgent":       "John Smith",
--     "coAgentEmail":  "john@remax.com",
--     "coAgentPhone":  "209-555-0200"
--   }

alter table public.deals add column if not exists contacts jsonb;

comment on column public.deals.contacts is
  'Deal team contacts from deals.json (Cowork-maintained): { escrow, escrowEmail, escrowPhone, escrowNumber, title, coAgent, coAgentEmail, coAgentPhone }. Rendered in the seller portal Your-team block.';
