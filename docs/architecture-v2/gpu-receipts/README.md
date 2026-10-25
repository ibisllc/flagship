# GPU hardware receipts

One file per receipt, `<id>.md`, named by the ids in `release/gpu-catalog/matrix.json`
(`receiptIds`). A receipt is written on the device by the runbook in `../gpu-runbooks/`: the
commit it ran, the exact host (`lspci -nn`, `uname -r`, driver, toolkit, runsc / Kata, Secure Boot
state, module signer), every check with its verdict, and the raw outputs (`summary.json`, the JSON
reports, `nvidia-smi -q -x`, the CDI spec). `node scripts/gpu-catalog.mjs build` pins each
receipt's SHA-256 in the catalog entry it qualifies, so a receipt changed after signing no longer
matches its catalog.

Nothing here is a receipt yet: no GPU profile is qualified (REGISTER G01–G05). Simulated-device
runs (`flagship-gpud self-test`, the `gpu-sim` gym group) prove the software, never a device, and
never produce a receipt.
