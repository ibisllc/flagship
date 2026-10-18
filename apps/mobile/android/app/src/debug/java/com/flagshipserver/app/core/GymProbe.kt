// GYM-ONLY: the mock clients a smoke-mode launch runs against, so an
// instrumented gym scenario (same process) can check what a button sent: the
// request body, the order and its signer. MainActivity sets them only on a
// debuggable smoke launch; production never does.

package com.flagshipserver.app.core

object GymProbe {
    @Volatile var appState: AppState? = null
    @Volatile var screens: com.flagshipserver.app.api.MockScreensClient? = null
    @Volatile var build: com.flagshipserver.app.api.MockBuildClient? = null
    @Volatile var flagship: com.flagshipserver.app.api.MockFlagshipServerClient? = null
    @Volatile var mailbox: com.flagshipserver.app.api.MockSecretMailboxClient? = null
    @Volatile var transfer: com.flagshipserver.app.api.MockServerTransferClient? = null
    @Volatile var relay: MockQrRelayClient? = null
    @Volatile var access: com.flagshipserver.app.api.MockServiceAccessClient? = null
    @Volatile var boxDirect: com.flagshipserver.app.api.MockBoxDirect? = null
}
