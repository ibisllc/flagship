# Driver maintenance on real hardware (H11)

The pipeline (`maintenance.rs`): proposed → staged → draining → installed (reboot) → verifying →
committed, or rolling-back (reboot) → rolled-back / failed. Run on the NVIDIA box from
`nvidia-cuda.md` with Secure Boot on.

1. The catalog lists two drivers for the device (the current one and the target), each with its
   `.deb` packages pinned by SHA-256 (`apt-get download nvidia-driver=<v>` then `sha256sum`).
2. Propose with the owner's maintenance order: a driver the catalog doesn't list, or one an
   advisory withdraws, is refused.
3. Stage: the packages are fetched and checked; a tampered mirror (edit one `.deb`) ends the
   maintenance before anything is installed.
4. Drain: GPU admission pauses (`admissionPaused` in `/api/screens/accelerators`), running GPU
   apps drain, CPU apps keep serving.
5. Install and reboot: the previous versions are recorded. After the reboot the device reports
   the target driver, `modinfo -F signer nvidia` names the enrolled MOK, the catalog qualifies the
   device, the vector add verifies: committed, admission resumes.
6. Rollback: repeat with the module left unsigned (skip the MOK enrolment): verification fails,
   the previous versions go back on, a second reboot, `rolled-back` with admission resumed on the
   old driver. A rollback that doesn't verify ends `failed` with admission paused.
7. The state survives each reboot (the record is in flagship-gpud's state directory).

Receipt `H11-nvidia-driver-lifecycle-owner-pc`.
