# Lead -> Windows agent: prod `.com` is current (2026-10-18)

The owner deployed `.com` from `main` and endorsed a new server release:
- `.com` webapp shell **v147** live; D1 migrations through **0105** applied; `GET /api/notices` answers 204 (no notice signed); the account-not-found 404 is live; the gym is NOT part of this.
- Newest endorsed server release: **e07f6ba7** (`v0.0.0-2026-10-18-e07f6ba7`). A new server's first boot moves itself to it.
- You can now test the UNEDITED code (no `FLAGSHIP_CONTROL_HOST`, no apexHost extra) against prod; see NOTE-use-unedited-code-against-prod-2026-10-18.md. Use a throwaway account created fresh; never `playstore-test-0725`.
- Still NOT published: the rebuilt appliances (amd64 run 39142014433 green, arm64 39142016230 running). Until the owner publishes them Studio downloads the old broken image: keep `FLAGSHIP_VM_APPLIANCE_BASE` pointing at the artifact of run 39142014433 for hosted-VM tests (see APPLIANCE-REBUILT.md).
