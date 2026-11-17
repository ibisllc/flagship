# Plans and the backup offer

Status: **design, for owner review** (2026-11-17). Release 0.4. **Business is built** on branch `0.4/business` with the
recommended answers as **provisional** decisions (owner, 2026-11-17: "I meant putting the enterprise features in 0.4"):
see §9 for which are taken and "As built" at the end for what exists. Cluster backup and the Vault (§4, §5) are not
built and stay in 0.5.

The owner's two questions:

1. **The enterprise plan.** Do we need one, or do we fold it into Pro Max? Candidates: LDAP and SCIM (the org
   directory has them), cluster backups, many people each admin of some servers or apps (org seats, k-of-n, custody
   labels). On cluster backups: maybe users would rather own 3 servers than trust our network, so we gate "bring your
   cluster, we orchestrate". Or rename Pro Max to Enterprise, "but billing a company $20 a month seems ridiculous".
2. **Backup-for-you.** People rent backup space on our servers for their phones, laptops and maybe their Flagship
   servers. Buy once and keep while subscribed, its own subscription, or part of a plan?

Read with: `monetization-free-tier-first.md` (what we charge for), `payments-privacy-and-rails.md` (vouchers, the
wallet, the trickle), `anonymous-vouchers.md`, `enterprise-accounts.md` and `org-directory.md` (orgs, seats, SCIM and
LDAP), `server-backup-and-clone.md` (the archive and the backup policy), `peer-backup.md` (bricks, blind leases),
`share-a-server.md` §5.8 (co-manager caps), `packages/protocol/src/paymentsConfig.ts`,
`packages/control-plane/src/meter.ts`, `apps/web/public/pro.html`.

## 1. Summary and recommendation

1. **Keep Free, Pro and Pro Max as personal and family plans. Add one org plan, "Business", priced per seat.**
   Do not rename Pro Max. An org is a different kind of account (no UMK of its own, seats, an authority record), not
   a bigger personal account, so it can't be a tier of one. Per seat fixes the "$20 for a company" problem: the bill
   grows with the team.
2. **Business: $6 per seat a month, minimum 3 seats ($18), annual or monthly, paid in the same $1 vouchers.** It holds
   every org feature: seats, scoped admins, k-of-n, freeze and bylaws, offboarding re-keys, audit export, SCIM and
   LDAP connectors, the org's cluster backup, unlimited custom domains, egress pooled at 100 GB per seat.
   "Enterprise" is not a plan: it is Business plus a contract (invoice terms, site mode, support, later an SLA), quoted.
3. **Gate the org, not single features.** No "SSO tax": a three-person org gets the directory connectors too. What
   a personal account can't have is another person with admin rights, and that is the org.
4. **Cluster backup ("your servers back each other up") goes in Pro and up**, Free keeps every backup it has today
   (phone copy, file download, the peer network). Rationale: it is convenience over a free path (download and copy),
   and it moves bytes through our relay, which is the one thing that costs us money. Pro: up to 3 servers; Pro Max and
   Business: any number, with k-of-n spread.
5. **Backup-for-you is "Flagship Vault": an end-to-end encrypted off-site copy of a server's backup**, stored on
   Backblaze B2 (or Hetzner) behind our front door. First version backs up **Flagship servers** only; laptops
   (restic-compatible) come second; phones back up to the owner's own server, which the vault then covers.
6. **Vault pricing: prepaid storage, spent from the wallet like the plan, never a separate subscription and never a
   one-time "forever" purchase.** Pro includes 50 GB, Pro Max 200 GB, Business 50 GB per seat pooled. More is $1 per
   50 GB a month ($20 a TB), or a 1 TB block for $12 a month. Our cost is about $7 a TB a month on B2.
7. **A lapsed vault turns read-only for 30 days, then is deleted 60 days after the lapse.** The keys never leave the
   owner's devices, so what we delete is ciphertext either way.
8. **Companies buy an invoiced voucher batch.** The invoice names the company and the count of vouchers, never an org,
   an account or a seat. The batch goes into the org's wallet, or is split into voucher files handed to staff for their
   own personal Pro.

## 2. What exists today

| | Free | Pro | Pro Max | Org (built, not priced) |
|---|---|---|---|---|
| Price | $0 | $10 a month (10 vouchers) | $20 a month (20 vouchers) | `enterprise-trial`, 10 seats, no end |
| Public egress | 25 GB, then slowed | 250 GB + prepaid 100 GB blocks | 500 GB + blocks | not metered per org yet |
| Custom domains | none | 1 | unlimited | not decided |
| Co-managers | 5 | 10 | 25 | seats instead (unlimited, `coManagerCap.ts`) |
| Outbound proxy, separate lists per server | no | yes | yes | not decided |
| Backups | phone copy, file, peer network (strangers) | same | same | same |
| Admin authority | one person | one person | one person | n people, k-of-n, scoped |

Code facts that shape the answer:

- `TierName` is `free | hobby | maker`. `coManagerCap.ts` already knows `enterprise`. `orgs.ts` gives a new org
  `planTier: "enterprise-trial"`, `seatLimit` 10, `paidUntil` null, and refuses new seats past the limit
  (`org-seat-limit`). A lapse stops new seats and admin raises, never revokes.
- `paymentsConfig.ts` has two paid plans, `unitsPerMonth`, `includedGb`, overage blocks, the trickle and the grace.
- Peer backup v2 never places bricks on the owner's own account (`peer-backup.md` §5.2). The old same-account peer
  backup was removed. **So "my servers back each other up" does not exist today.**
- A scheduled backup is already end-to-end sealed: the account slot's key is `deriveServerArchiveKey(UMK, archiveId)`
  and the box can't open its own archive (`server-backup-and-clone.md` "Scheduled backups").

## 3. The plan lineup

### 3.1 Options

| Option | For | Against |
|---|---|---|
| **A. Keep Pro Max, add Business per seat** (recommended) | matches the code (org is its own account kind); price grows with the team; families keep a flat price | four plans to explain |
| B. Rename Pro Max to Enterprise | one fewer plan | an org is not a bigger personal account: the features can't attach to it; $20 flat for a 40-person company; families on "Enterprise" is odd |
| C. Merge org features into Pro Max | simplest page | gives k-of-n and seats for $20 flat to any company of any size; nothing left to sell; seat limit has no price |
| D. Business flat (e.g. $50 a month up to 10 seats) | easy to say | a two-person shop pays for ten; a 60-person one has no path |
| E. No paid org plan, orgs free | goodwill | orgs are the one place people expect to pay (multi-device-monetization.md §5); support cost is real |

### 3.2 Recommended lineup

| | Free | Pro | Pro Max | Business |
|---|---|---|---|---|
| Who | anyone | one person, a few apps public | a family or a heavy user | a team: several people with admin rights |
| Price | $0 | $10 a month | $20 a month | **$6 per seat a month**, min 3 seats |
| Public egress | 25 GB, slowed | 250 GB | 500 GB | 100 GB per seat, pooled |
| Custom domains | none | 1 | unlimited | unlimited |
| Co-managers / seats | 5 | 10 | 25 | seats (as paid) |
| Cluster backup (own servers) | no | up to 3 servers | any number, k-of-n | any number, k-of-n, restore needs the org's approval |
| Vault included | none | 50 GB | 200 GB | 50 GB per seat, pooled |
| Org features (§3.3) | no | no | no | yes |
| How it is bought | n/a | vouchers | vouchers | vouchers, or an invoiced voucher batch |

**Enterprise** stays a word on the page: "Over 50 seats, site mode, an air-gapped site or a support contract? Write to
us." It is Business plus a contract. No separate code tier.

Why $6: it sits under 1Password Business ($8.99), Tailscale Standard ($8) and Proton Drive Professional ($7.99),
level with Bitwarden Enterprise ($6) and over Bitwarden Teams ($4) (§7). The minimum of 3 is
the smallest org that makes k-of-n meaningful (2 to destroy, one more to stay safe when a phone is lost). At 3 seats
the floor is $18, close to Pro Max, which is honest: a three-person shop is about a family's size. At 40 seats it is
$240 a month, which is the bill a company expects.

Why not per server: `monetization-free-tier-first.md` says "don't gate server count, meter the bandwidth". A server
costs us nothing; egress does. Pooled egress per seat keeps that rule.

### 3.3 What only Business has

All already designed or built on 0.4 branches; none of it is offered to a personal account:

- several people with admin authority; scoped server admins and app admins;
- k-of-n approvals for destroy, governance and site check-in; freeze; founder removal; bylaws;
- offboarding that re-keys (CGK, directory key, archive keys, disk key);
- the signed org log and the offline audit export;
- the org directory, SCIM 2.0 and LDAP connectors (run on the org's own box, so names never reach us);
- fleet setup (wired tray), batch claims;
- strict PQ from creation (no extra price; it comes with the org).

Custody labels and the quantum-safe settings are not plan features. They are safety information and stay on every
plan.

### 3.4 Trial and lapse

- A new org gets the built trial: 10 seats, **30 days** (today: no end). Then it needs 3 paid seats or it lapses.
- Lapse follows the built rule: no new seats, no role raises, no new servers. Every seat, approval, offboarding,
  restore and app keeps working. A lapsed org is never wiped.
- Seat count is what `.com` already counts at seat admission (live seats). Paying for N seats sets `seatLimit` to N.

## 4. Cluster backup: "bring your servers, we orchestrate"

### 4.1 What it is

The owner's servers back each other up. Each server's newest scheduled archive is sealed (it already is), cut into
shards (the peer engine's Reed-Solomon code) and placed on the account's other servers. Two servers: a full copy on
the other. Three or more: k-of-n, e.g. 2 of 3, so any one server can die. Restore works from any device of the
account, as with peer backup, because every key comes from the UMK.

It reuses the peer engine with one switch: placement on the owner's own account (`diversity: "account"` inverted),
no blind tokens (the owner pays nobody), no filler proofs (the owner trusts its own servers), and the
1/3-of-disk cap of the Peer policy. It is a fourth backup policy, `cluster`.

### 4.2 Is it a paid feature?

Run through the decision recipe (`monetization-free-tier-first.md`):

1. **On the core loop?** Recovery is. But Free already has three ways to recover: the phone copy, the downloaded
   `.flagship` file, and the peer network. Cluster backup is a fourth, nicer way. Not core.
2. **Escape hatch?** Yes: download the backup file and copy it to the other server by hand, or script it.
3. **Matches a paid surface?** It is relay egress. Servers on different networks send every shard through Fly
   ($0.02 a GB). A 100 GB server backed up weekly to two others sends about 200 GB a week, 800 GB a month: about $16
   of Fly egress. On the same LAN it is free (LAN-direct). This is the cost case the plans exist for.
4. **Trust?** "Your own servers protect each other" is the pitch, not a capture. Fine.

**Verdict: paid, on Pro and up.** The owner's instinct holds: people who own three servers are exactly the people who
pay, and the feature is the reason to own a third.

- **Pro:** up to 3 servers in the cluster (replicas or 2-of-3).
- **Pro Max and Business:** any number, any k-of-n.
- **Business:** a restore to a new server needs the org's restore threshold (k_grant by default), so one admin can't
  pull a copy of a server they don't administer.
- Cluster traffic counts against the plan's egress like any relay traffic. LAN traffic counts nothing. The box sends
  a generation only when the archive changed, and at most weekly over the relay.
- **Free keeps everything it has.** The peer network stays free, because it is reciprocal: the user gives disk to get
  disk.

Do not market it as a replacement for an off-site copy: three servers in one house burn together. That is what the
vault is for (§5), and the page should say it.

## 5. Backup-for-you: Flagship Vault

### 5.1 What it backs up, in order

1. **Flagship servers (first).** A fifth backup destination beside phone, peer, cluster and none: the scheduled
   archive (both files) goes to the vault. The server is where the data lives, so this covers the most for the least
   new code: the archive format, its keys, its restore and "Restore from other servers" exist.
2. **Laptops (second).** A restic-compatible endpoint (restic's REST server protocol): restic encrypts on the laptop
   with a key only the owner holds. Studio can set it up with a key derived from the UMK, so restore needs only the
   account.
3. **Phones (not directly).** iOS and Android give a third-party app no full-device backup, and photo upload in the
   background is a photos app, not a backup. Phones back up their photos and files to the owner's own server (an app
   on it), and the vault covers the server. The phone's own Flagship state is already in cloud recovery.

### 5.2 Encryption and what we learn

- **We store ciphertext only.** A server archive is sealed under a random content key, wrapped by
  `deriveServerArchiveKey(UMK, archiveId)` (and an optional passcode slot). A laptop's restic repo is encrypted by
  restic. No key ever reaches the vault.
- **The vault does not know the account.** A vault is a random `vaultId = HKDF(UMK, "flagship/vault-id/v1")`, so any
  device of the account (or a recovered UMK) finds it again; requests are signed by a per-vault key derived the same
  way. Uploads and downloads go **straight to the storage provider** through short presigned URLs from `.com`, not
  through Fly, so they cost us no relay egress and the box's address is seen by the provider, not stored by us.
- **Payment is by voucher against the vaultId** (§6), over OHTTP, at trickle times, like the plan. `.com` learns
  "vault V is paid until D and holds S bytes", and separately "account X is on Pro". Joining them takes timing, which
  the trickle blurs. Plans that include vault space (§5.3) are the exception: the account proves its plan to the vault
  with a blind token, not its name (one `included-vault` token per month, issued to the account, redeemed against the
  vault).
- **Not a sharing service.** Objects are readable only with the vault's key: no public links. That keeps the vault
  from being a file-sharing channel, and keeps abuse handling to "we can't read it, and nobody but the owner can
  fetch it".
- Size is visible to us (we bill for it). Archives are padded to 64 MiB steps to blur it a little.

### 5.3 Pricing model

| Model | Verdict |
|---|---|
| **Bought once, kept while subscribed** | No. A one-time price for an ongoing cost is a liability that grows each month. It also needs a "while subscribed" link between a purchase and an account, which vouchers exist to avoid. |
| **Its own subscription** | No. A second subscription is a second store record per payer and a second thing to cancel. The privacy design already turns subscriptions into voucher drips; a vault is just one more thing the wallet pays. |
| **Included in a plan, more as prepaid blocks** (recommended) | Yes. It feels like buying once (the user buys a voucher pack), it behaves like a subscription (the wallet trickles it), it gives Pro and Pro Max a concrete reason beyond egress, and it needs no new payment path. |

Recommended numbers:

| | Included | Extra |
|---|---|---|
| Free | none (may buy blocks) | $1 per 50 GB a month |
| Pro | 50 GB | $1 per 50 GB a month, or 1 TB for $12 a month |
| Pro Max | 200 GB | same |
| Business | 50 GB per seat, pooled | same |

Free may buy vault blocks: storage is not a feature to gate, and a Free user paying $1 a month for an off-site copy
is a good outcome. Blocks are counted at the high-water mark of the month, rounded up to the next 50 GB.

### 5.4 Our cost

Per TB a month (details and sources in §7):

| Provider | Storage | Egress | Notes | Our cost per TB-month |
|---|---|---|---|---|
| Backblaze B2 | $6.95 | free up to 3× stored, then $0.01/GB | S3 API, presigned URLs, no minimum duration, API calls nearly free | **~$7** |
| Cloudflare R2 Standard | $15 (IA: $10 + $0.01/GB read, 30-day minimum) | free | same platform as `.com` | ~$15 |
| Wasabi | $7.99 | free while egress ≤ stored | 90-day minimum, 1 TB minimum charge | ~$8, more for short-lived data |
| Hetzner Object Storage | ~€6.50 (€6.49 base includes 1 TB + 1 TB egress) | ~€1/TB past the included | S3 API; base charged even when empty | ~$7.50 |
| Hetzner Storage Box | €3.20 (1 TB) down to €2.03 (20 TB box) | unlimited | SFTP/Borg, no S3: needs a gateway we run; one data centre | ~$2.50 to $3.70 plus a gateway |

Recommendation: **B2 as the store, R2 as nothing** (R2 is twice the price and its free egress doesn't matter for a
backup that is rarely read). Revisit Hetzner behind our own gateway past ~50 TB.

Margin at $1 per 50 GB ($20 a TB): cost ~$7, store fee up to 15%, so ~$10 margin per TB, about 50%. The 1 TB block
at $12: ~$3 after a 15% store fee (at $10 it would be ~$1.50, too close to cost; Synology C2 sells 1 TB at about
$7.99 and iCloud 2 TB at $9.99, so the TB block competes on privacy, not price). Past ~50 TB, Hetzner Storage Boxes
behind our own gateway cut the cost to about a third. Included space: Pro's 50 GB costs ~$0.35 a month, Pro Max's 200 GB ~$1.40, inside
both plans' margins even at their egress worst case ($5 and $10 of Fly egress).

### 5.5 When payment lapses

- **Grace 72 hours** (the plan's grace), during which nothing changes.
- **Then 30 days read-only**: no uploads, restore and download work. Every app shows "Your vault is not paid. You can
  restore from it until <date>."
- **Deleted 60 days after the lapse.** The apps warn at 30, 7 and 1 day before (Activity and a content-free push).
- Over the paid size (a plan dropped from Pro Max to Pro): the oldest generations go first, never the newest.
- We can't email anyone (we don't know who it is), so the warnings live only in the apps and on the box. Say so on
  the page.

### 5.6 How vouchers pay for it

- One wallet. The trickle spends for the plan and for the vault separately, at separate random times, against
  separate ids (account name, vaultId).
- `paymentsConfig.ts` gains `vault: { blockUnits: 1, blockGb: 50, tbBlockUnits: 10, includedGb: {pro, "pro-max"},
  perSeatGb, readOnlyDays: 30, deleteAfterDays: 60 }`.
- A vault spend is `spend 1 voucher for vault V, block-month Q` over OHTTP, with no account credential, like a plan
  spend. `.com` refuses a spend more than 35 days ahead, as for plans.

## 6. Business and the anonymous vouchers

The tension: companies want an invoice in their legal name, a VAT number and a named buyer. Vouchers exist so a
payment never names an account.

**Answer: the invoice buys a voucher batch, and the batch is blind like every other.**

1. **Buy.** On the web, an org admin (or the company's finance person, who needs no Flagship account) asks for N
   vouchers: company name, address, VAT id, email for the invoice. Pay by card (Stripe Invoicing) or bank transfer.
   The invoice reads "Flagship vouchers, N × $1". It names no org, account or seat.
2. **Issue.** When the invoice is paid, the buyer's browser (from the link in the receipt, the secret after `#`)
   makes N blinded tokens and gets them signed, exactly as for a Stripe pack. The issuer keeps `hash(order id) → count`,
   as today.
3. **Use, two ways:**
   - **Into the org wallet.** An org admin imports the batch on the web (never in the phone apps: Apple 3.1.1). The
     org wallet trickles seat-months: 6 vouchers per seat per month. The org wallet is sealed under a new org key-ring
     kind `wallet` (the org has no UMK), opened by org admins.
   - **Handed to staff.** The batch is split into voucher files (QR or file) for staff to spend on their own personal
     Pro. The company learns nothing about which accounts they went to; staff learn nothing about each other.

What links, said plainly:

- The company's name links to "bought N vouchers on day D". It never links to the org by our records. But an org
  whose spends match N/6 seats starting a few days after a big batch can be guessed when there are few orgs. Say so.
  Companies that need their auditors to see "this payment is for org acme" may ask for the org name on the invoice;
  that is their choice, it is the company's own name, and no seat is named either way.
- Seats are never named to us (pseudonyms, sealed directory, `enterprise-accounts.md`).

**VAT.** Business batches are B2B: with a valid EU or UK VAT id the buyer self-accounts (reverse charge), so no EU
VAT is charged; a US buyer may owe use tax. A voucher sold to a known business for one kind of service in a known
country is likely a single-purpose voucher, taxed at sale (which is what an invoice wants). To confirm with the
accountant, with the consumer questions in `payments-privacy-and-rails.md` §7.

**Minimum batch:** 100 vouchers ($100), so invoice handling doesn't cost more than the sale. Annual billing is just a
bigger batch (3 seats for a year: 216).

## 7. Market prices

Read 2026-11-17 by a research pass; "unverified" means only third-party pages had it. Several of these changed in
2026 (Tailscale April, Google May, Synology June, Proton's Workspace rename), and some are first-year promos: re-check
before quoting any on a public page.

**Teams and business, per user a month:**

| Product | Price | Notes | Source |
|---|---|---|---|
| Tailscale Personal | $0 | up to 6 users, non-commercial | https://tailscale.com/pricing |
| Tailscale Standard / Premium / Enterprise | $8 / $18 / quote | Enterprise by invoice | same |
| 1Password Teams Starter Pack | $24.95 a month flat, up to 10 users | small-team flat pack | https://1password.com/business-pricing |
| 1Password Business | $8.99, annual | | same |
| Bitwarden Teams / Enterprise | $4 / $6, annual | crypto via BitPay into account credit | https://bitwarden.com/pricing/ |
| Proton Drive Professional | $7.99, annual | 1 TB per user | https://proton.me/business/drive/pricing |
| Proton Workspace Standard / Premium | $14.99 / $24.99 list | promos to 2026-11-30 | https://proton.me/business/plans |
| Nextcloud Enterprise | €71.29 per user a year (Standard, 100 users) | minimum 100 users | https://nextcloud.com/pricing/ |

**Personal and storage:**

| Product | Price | Notes | Source |
|---|---|---|---|
| 1Password Individual / Families | $3.99 / $5.99 a month, yearly | Families: 5 people | https://1password.com/pricing/password-manager |
| Bitwarden Premium / Families | $1.65 / $3.99 a month, yearly | Families: 6 | https://bitwarden.com/pricing/ |
| Proton Unlimited | $9.99 a month, yearly | 500 GB; takes cash by post and Bitcoin | https://proton.me/pricing, https://proton.me/support/payment-options |
| Proton Drive Plus | $3.99 a month, yearly | 200 GB | https://proton.me/drive/pricing |
| iCloud+ (US) | $0.99 / $2.99 / $9.99 / $29.99 / $59.99 a month | 50 GB / 200 GB / 2 TB / 6 TB / 12 TB | https://support.apple.com/en-us/108047 |
| Google One | $1.99 (100 GB), $9.99 (2 TB, AI Plus), $19.99 (5 TB, AI Pro) a month | | https://one.google.com/about/plans |
| Backblaze Personal Backup | $99 a year per computer | unlimited | https://www.backblaze.com/cloud-backup/pricing |
| Backblaze B2 | $6.95 per TB a month | egress free to 3× stored | https://www.backblaze.com/cloud-storage/pricing |
| Synology C2 Storage | ~$7.99 per TB a month (unverified) | plans replaced 2026-06-22 | https://c2.synology.com/en-us/pricing/storage |
| Synology C2 Backup | priced by storage, not device (unverified) | | https://c2.synology.com/en-us/pricing/backup |
| Umbrel | umbrelOS free; hardware ~$699 | no subscription | https://umbrel.com/ |
| Start9 | hardware ~$749 to $1,399 (unverified); support $200 a year | one year included | https://start9.com/ |

**Storage cost to us:** Cloudflare R2 https://developers.cloudflare.com/r2/pricing/, Hetzner Storage Box
https://www.hetzner.com/storage/storage-box/, Hetzner Object Storage https://www.hetzner.com/storage/object-storage/,
Wasabi https://wasabi.com/pricing and https://wasabi.com/pricing/faq.

What it tells us:

- **Per seat, $4 to $9 is the band** for privacy tools; full suites are $15 to $25. $6 fits, and nobody serious sells
  a business plan at a flat $20 for any size, which confirms the owner's doubt about renaming Pro Max.
- **Capacity is not our pitch.** iCloud gives 2 TB for $9.99. Pro's 250 GB of egress and 50 GB of vault are not a
  storage deal; Pro sells privacy and running your own apps. The vault sells "off-site, and we can't read it".
- **Small vaults fit a $1 to $4 a month habit** (iCloud 200 GB $2.99, Proton 200 GB $3.99). Ours: 200 GB is $4 a
  month as blocks, or included in Pro Max.
- **Anonymous payment has precedent only as prepaid credit** (Proton cash and Bitcoin, Bitwarden BitPay credit). Every
  business tier above bills a named account. An invoiced but blind voucher batch is unusual and worth saying on the
  page.
- **Self-hosting hardware (Umbrel, Start9) charges once, no subscription**; Start9 sells support at $200 a year. A
  Business "support contract" can sit near that.

## 8. What changes in code and pricing

Nothing is built by this doc. When the owner decides:

- **`paymentsConfig.ts`**: add `business: { unitsPerSeatMonth: 6, minSeats: 3, egressGbPerSeat: 100,
  vaultGbPerSeat: 50 }` and the `vault` block (§5.6). Clients read them from `GET /api/payments/config`.
- **`TierName`** and **`meter.ts`**: an org's egress plan = seats × 100 GB, throttled past it with blocks like Pro.
  The meter needs the org's seat count (the org row has `seatLimit`). New resource `vault-bytes` (record, judged
  against paid blocks).
- **Plan attestation v2**: tier `enterprise`, `seatLimit`, `serverLimit` (none), already proposed in
  `enterprise-accounts.md` §15. Org `paidUntil` set by voucher spends; the trial gets a 30-day end.
- **Backup policy**: `flagship/backup-policy/v2` adds `cluster` and `vault` (and lets `vault` combine with any other,
  since off-site is a second copy). The box checks the plan attestation for `cluster` (Pro and up).
- **Peer engine**: a same-account placement mode for `cluster` (no tokens, no filler, LAN-direct first).
- **Vault service**: `.com` routes for presigned upload and download, vault spends, size accounting, the lapse
  timer and deletion; a B2 bucket; restic REST compatibility later.
- **Invoices**: Stripe Invoicing (or a hand-made invoice and bank transfer at first) feeding the existing issue call;
  the voucher batch split and import on the web.
- **`pro.html`**: a Business column, the vault rows, the cluster line, "Enterprise: write to us". Terms and Privacy:
  vault retention and deletion, invoice data kept (company details, 10 years for tax law), never linked to an account.
- **`monetization-free-tier-first.md`**: "Backup destinations" becomes "peer backup with anyone stays free; backing up
  between your own servers and the vault are paid". "Number of paired devices" stays free: seats are other people.
- **i18n**: every new sentence through `i18n/<surface>/*.json`.

## 9. Owner decisions

Recommended answer first. **Provisional (taken for the 0.4 build, 2026-11-17, open to change):** 1, 2, 3 (but the code
says `business`, not `enterprise`: one id everywhere), 4, 5, 6, 13, 14. Every number is in `paymentsConfig.ts`
`business`, so changing 2, 4 or 6 is a `PAYMENTS_CONFIG` setting, not a release. Not taken (0.5): 7 to 12, 15.

1. **Lineup.** Keep Free, Pro, Pro Max; add Business per seat; "Enterprise" is a contract, not a plan. (Alternatives:
   rename Pro Max; fold org features into Pro Max.)
2. **Business price.** $6 per seat a month, minimum 3 seats. (Alternatives: $5; $8; a minimum of 5.)
3. **Plan name.** "Business" on the page, `enterprise` in code. (Alternative: "Teams", or "Enterprise".)
4. **Org trial.** 10 seats for 30 days, then lapse (degrade, never wipe). (Alternative: free forever up to 3 seats.)
5. **Gate the org, not SSO.** SCIM and LDAP come with every Business seat count. (Alternative: connectors only above
   N seats.)
6. **Business egress.** 100 GB per seat, pooled, plus 100 GB blocks. (Alternative: 500 GB flat per org.)
7. **Cluster backup.** Build it; Pro up to 3 servers, Pro Max and Business unlimited; Free keeps peer, phone and file.
   (Alternatives: free for all, metered by egress only; Pro Max only.)
8. **Vault scope for 0.4.** Servers only; laptops via restic next; phones through the owner's server. (Alternative:
   start with laptops.)
9. **Vault pricing model.** Included in plans plus prepaid blocks from the wallet; no separate subscription, no
   one-time forever purchase.
10. **Vault numbers.** Pro 50 GB, Pro Max 200 GB, Business 50 GB per seat; extra $1 per 50 GB a month or 1 TB for
    $12; Free may buy blocks. (Alternative: 1 TB for $10, near cost.)
11. **Vault store.** Backblaze B2. (Alternatives: R2 for simplicity at twice the cost; Hetzner behind our gateway.)
12. **Vault lapse.** 72 h grace, 30 days read-only, deleted 60 days after the lapse, warnings in the apps only.
13. **Business payment.** Invoiced voucher batches (minimum 100), blind like the rest; the invoice names the company
    and the count, never the org, unless the company asks for the org name on it.
14. **Staff perk.** Allow splitting a batch into voucher files for staff's personal plans.
15. **Amend `monetization-free-tier-first.md`** for the cluster and vault lines (§8).

## As built: Business (branch `0.4/business`, 2026-11-17)

Not deployed, not run on a real box or phone. Decisions §9 1-6, 13 and 14 are provisional.

**Numbers** (`packages/protocol/src/paymentsConfig.ts` `business`, overridable field by field with `PAYMENTS_CONFIG`
on `.com`): 6 vouchers a seat a month, at least 3 seats, at most 10,000; 100 GB of egress per seat, pooled; a trial of
10 seats for 30 days; invoiced batches of 100 to 5,000 vouchers. The plan id is `business` everywhere (the org row's
`plan_tier`, the code); "Enterprise" is a word on the page only.

**Plan state** (`packages/protocol/src/orgPlan.ts`, vectors `test-vectors/org-plan/`): `trial` until the trial ends
(the trial's seats, or the paid seats if more), `paid` while paid seats are paid (the 72-hour grace included),
`lapsed` otherwise. Paid time starts when the trial ends, so paying early never shortens the trial. A spend for a
different seat count converts the time left at the ratio of the unit lengths, as a plan switch does. The trickle and
overage rules are the personal wallet's, fed with `orgSeatUnitMs(seats)` (40 hours a voucher at 3 seats).

**What is gated** (`.com` `orgPlanGate` in `packages/control-plane/src/orgPlan.ts`, used by `orgs.ts`,
`orgServers.ts`, `orgConnectors.ts`). Before this branch every org feature was free with no end (a 10-seat trial that
never expired; only a `paid_until` set by hand could lapse it). Now a lapsed org can't: admit a new seat (`org-plan-lapsed`;
`org-seat-limit` past the seat limit while live), raise a seat's role, add a server, add an admin to its authority
record (a `direct` version naming a seat no earlier record had), or turn a directory connector `active`. It can still:
remove a seat, freeze, recover, overturn and veto, rotate keys (offboarding), export and read the log, write the
directory, pause or retire a connector, approve ceremonies, and every app, server and seat keeps working. Nothing is
ever wiped. The box enforces the same from the CA-signed attestation (below): a seat new to the box waits while the
plan can't take it, and a directory connector proposes no new person while the org has lapsed (they are proposed once
it is paid; removals and updates go on). Fleet setup and batch claims are not on `release/0.4`, so nothing gates them.

**Attestation** (`flagship/org-plan-attestation/v1|<orgId>|<status>|<seatLimit>|<paidSeats>|<trialEndsAt>|<paidUntil>|<issuedAt>|<expiresAt>`,
`planAttestation.ts`): CA-signed by `.com` at `GET /api/orgs/<id>/plan-attestation`, same chain and 26-hour life as the
account variant. The box (`packages/server-daemon/src/orgPlanCheck.ts`) reads it hourly and keeps it on disk; one that
is missing, expired or unverifiable means "plan unknown", which never blocks.

**The org wallet** (`orgWallet.ts`): the personal wallet's format with `settings {seats, autoPay, overageCapUnits,
updatedAt}`, sealed with AES-256-GCM under `HKDF(ring key, "flagship/org-voucher-wallet/v1|<orgId>")`, where the ring
key is the newest version of a new org key-ring kind **`wallet`** (scope `*`, org admins only, never a box, rotated by
offboarding like the directory key). `.com` keeps the ciphertext in `voucher_wallets` under the row `org:<orgId>`
(`GET/PUT /api/orgs/<id>/voucher-wallet`, compare-and-set); every write carries one org admin's approval over
`flagship/org-voucher-wallet-write/v1|<orgId>|<version>|<keyVersion>|<blobSha256>|<issuedAt>`. Because a voucher is a
bearer token, an admin who left could have copied the unspent ones: after a `wallet` rotation the apps exchange every
voucher the old key could read (`POST /api/vouchers/exchange`: spend n, blind-sign n fresh, all or nothing, through the
OHTTP relay) and seal the wallet under the new key.

**Spending** (`POST /api/vouchers/redeem` `{v:1, org, for:"business", seats, vouchers}` or `{v:1, org, for:"overage",
vouchers}`): no credential, through the private relay like a personal spend; refused with `org-not-found`,
`org-seats` (outside min..max), `org-seats-below-live`, `plan-paid-ahead`, `overage-needs-plan` (lapsed). Anyone may
pay any org's seats (as for accounts); a stranger's spend with an odd seat count converts the time left, never loses
value. `.com` updates the paid end with a compare-and-set (`setPlanIf`). D1 **0156** `org_plan_terms` keeps the
trial's end and the paid seats (an org without a row is on the trial that began when it was created).

**Egress**: `MeterDeps.orgEgressBytes` gives an org name `seatLimit × 100 GB` while on trial or paid (asked only once it
is over Free's 25 GB), plus the month's prepaid blocks; lapsed orgs fall back to Free's 25 GB, slowed.

**The invoiced batch** (`voucherBatch.ts`, `voucherRails.ts`): the buyer's browser makes a random 32-byte seed and
derives every blinded request from it (`HKDF(seed, "flagship/voucher-batch/v1|<keyId>|<i>")`), so only the small
batch key file is needed to finish on another computer. `POST /api/vouchers/stripe/batch-checkout` makes a Stripe
Checkout Session in payment mode with `invoice_creation`, `tax_id_collection`, a required billing address and a
customer: the invoice reads "Flagship vouchers" × units; the metadata carries the count, the key and the commitment,
never an org, account or seat. `POST /api/vouchers/batch-issue` re-checks the paid session and the commitment and
signs 100 at a time from `from` (a retry or another computer gets the same signatures; a bank transfer answers
`payment-unpaid` until it lands; a refund or dispute stops further signing). The webapp then puts the batch into the
org wallet or saves voucher files (`flagship-vouchers` JSON) of a chosen size for staff, which the personal Plan
imports.

**Clients.** Webapp (shell v234): Settings → Organizations shows each org's Plan (status, seats in use, price, the
wallet's balance and auto-pay for org admins, the seat count to pay for, import voucher files, buy a batch, finish a
batch from its key file, batch to the wallet or to staff files) and runs the org trickle while it is open; the
personal Plan imports voucher files. iOS and Android: see their commits on this branch (the org's Plan in the org
page, ports with vector tests, the store purchase into the org wallet; iOS has no voucher import or batch, per App
Review 3.1.1 and §4.3 of `payments-privacy-and-rails.md`; Android imports voucher files). Pro page, release notes,
blog and store texts carry Business in seven languages (machine drafts).

**Open (owner):** whether the phones may import voucher files at all (Android does; iOS doesn't); a finance person
with no Flagship account can't yet buy a batch (the webapp's batch shop sits in an org admin's Plan; the batch key
file lets an admin finish it anywhere); the store texts' Business bullets ship only if orgs launch in 0.4; Stripe's
yes for invoiced prepaid vouchers and bank transfers; the numbers on `pro.html` are written in the page and must be
edited by hand if `PAYMENTS_CONFIG` changes them.
