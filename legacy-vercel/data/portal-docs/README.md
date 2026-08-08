# portal-docs — folder-published document manifests

Each `<deal-id>.json` here is written by **`api/cron/publish-docs-from-dropbox.js`**,
which mirrors a deal's Dropbox share folders into `public/docs/<deal-id>/` and records
what it published. **Do not hand-edit these files** — they're regenerated from Dropbox.

`api/cron/sync-deals.js` reads `<deal-id>.json` alongside `deals.json`
`clientDocuments[]`, so folder placement in Dropbox drives portal documents. Each
entry:

```json
{ "name": "Transfer Disclosure Statement (TDS)",
  "url": "/docs/433-hwy4/tds.pdf",
  "scope": "property",
  "visibility": "seller",
  "key": "433-hwy4-tds",
  "rev": "0123456789abcdef" }
```

- `scope` — auto-derived by document type (property = survives an escrow).
- `visibility` — from the Dropbox folder the file sat in, after safety-narrowing.
- `key` — stable join handle (from the filename); governance/visibility hangs off it.
- `rev` — Dropbox file revision, used to skip re-downloading unchanged files.
