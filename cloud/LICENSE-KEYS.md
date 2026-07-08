# Pro license keys — owner guide

Each paying user gets their own key (`RESIT-XXXX-XXXX-XXXX`). Keys are stored
in the Worker's database and can be revoked one by one — no more single shared
code. Your `PRO_UNLOCK` secret becomes the MASTER code: it still unlocks Pro
directly, and it is what authorises minting/revoking.

## One-time setup
In the Cloudflare dashboard → the `resit` Worker → Settings → Variables and
Secrets → add a **Secret** named `PRO_UNLOCK` with a passphrase only you know.
(If you already set it, nothing to do.)

## Mint a key for a new customer (PowerShell)
```powershell
$body = @{ secret = "YOUR-PRO-UNLOCK-SECRET"; label = "customer name / email" } | ConvertTo-Json
Invoke-RestMethod -Uri "https://resit.adrianloh10.workers.dev/mint" -Method Post -ContentType "application/json" -Body $body
```
The response contains `key` — send that to the customer. They tap
**Upgrade → "I have an unlock code"** in the app and enter it.

## Revoke a key (e.g. refund / abuse)
```powershell
$body = @{ secret = "YOUR-PRO-UNLOCK-SECRET"; code = "RESIT-XXXX-XXXX-XXXX" } | ConvertTo-Json
Invoke-RestMethod -Uri "https://resit.adrianloh10.workers.dev/revoke" -Method Post -ContentType "application/json" -Body $body
```
The app re-verifies each key weekly, so a revoked key downgrades within a week.

## See all keys
D1 dashboard → `resit-quota` database → Console:
```sql
SELECT key, label, revoked, created_at, used_at FROM license_keys ORDER BY created_at DESC;
```

Notes
- The `license_keys` table creates itself on first use — no setup needed.
- Keys are NOT included in app backups, so a shared backup can't leak one.
- Later, Google Play billing (Phase A) will replace hand-minted keys for
  store customers; keys remain useful for web/direct sales.
