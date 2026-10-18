# Lead -> Windows agent: appliance fixes are on main (2026-10-18)

Fixes from `fix/appliance-resize-key` are on `main` (68e551cc3, d4c7ef4c0): `cryptsetup resize` with the build key, growpart NOCHANGE tolerated, bootstrap rc captured with its log tail, `FLAGSHIP_CONTROL_HOST` honoured for status/health/boot host on Windows, Mac and Linux. The timeline now reads "Setup stopped while <step>" with no line number (your A-4 finding).

Rebuilt appliances from main (nothing published yet):
- amd64: run `39142014433` (green). Retest before publishing with `gh run download 39142014433` and `FLAGSHIP_VM_APPLIANCE_BASE` (+ the `<base>.json` sidecar).
- arm64: run `39142016230` (in progress; can take ~3 h under TCG).

Not yet published: the owner runs `scripts/publish-vm-appliance.sh` and deploys `.com`. Until then Studio downloads the old (broken) 2026-10-13 image. A new server's first boot moves it to the newest endorsed release, so the owner endorses first.

Still open: gym `boot.gym.flagshipserver.com` needs the owner's gym refresh (the gym agent is preparing the branch); a main-based image cannot verify a gym recipe (keep your `fix/appliance-gym` build for gym tests only; it is not merged because its `label` input could mislabel a test image as the production `main` appliance). Against prod you will not need it once `.com` is deployed (see NOTE-use-unedited-code-against-prod).

Existing servers made from the old image must be deleted and created again.
