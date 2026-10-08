# Workspace packages whose BUILT dist/ the apps/com Worker bundles — directly
# (apps/com/package.json deps) or through control-plane's exports
# (services-zone via caaPublish, iso-personalizer via personalizeIso).
# Sourced by predeploy-com.sh and clean-build-com.sh so the two agree.
# shellcheck disable=SC2034
BUNDLED_PKGS="control-plane storage protocol boot-core services-zone iso-personalizer"
