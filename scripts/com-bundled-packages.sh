# Workspace packages (repo-relative paths) whose BUILT dist/ the apps/com
# Worker bundles — directly (apps/com/package.json deps) or through
# control-plane's exports (services-zone via caaPublish, iso-personalizer via
# personalizeIso, billing-metering via meter.ts and storage, billing-store-d1 via storage).
# Sourced by predeploy-com.sh and clean-build-com.sh so the two agree.
# shellcheck disable=SC2034
BUNDLED_PKGS="packages/control-plane packages/storage packages/protocol packages/boot-core packages/services-zone packages/iso-personalizer billing/packages/metering billing/packages/store-d1"
