// "Connect to an existing account": one page, two ways in. The account-name
// field signs in (resolve → recovery / demo); the code field joins through the
// pairing relay. Same rules as iOS ConnectInput and the webapp's
// lib/connectAccount.js. Pure: no UI, no network.

package com.flagshipserver.app.core

sealed interface ConnectInput {
    data object Empty : ConnectInput
    /** A /join link (https or legacy flagship://) or a bare `sid=…&pk=…` code. */
    data class Pairing(val link: JoinLink, val raw: String) : ConnectInput
    data class Name(val name: String) : ConnectInput
    /** A link, but not a pairing link (or one missing its session). */
    data object BadLink : ConnectInput

    sealed interface NameField {
        data object None : NameField
        data class SignIn(val name: String) : NameField
        data class Join(val link: JoinLink, val note: String) : NameField
        data class Error(val message: String) : NameField
    }

    sealed interface PairingField {
        data object None : PairingField
        data class Join(val link: JoinLink) : PairingField
        data class Error(val message: String) : PairingField
    }

    companion object {
        const val ROUTED_TO_JOIN = "That's a pairing link, so we're joining with it."
        const val NOT_A_CODE = "That isn't a pairing code. Paste the whole link from the other device, or scan its code."
        const val NAME_IN_CODE = "That looks like an account name. Type it under Sign in with your account name."
        const val BAD_LINK = "That link isn't a pairing link. Ask the other device to show a new code."
        const val EMPTY_CODE = "Paste the pairing link, or scan the code."

        private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*://")
        private val SESSION_PARAM = Regex("(^|[?&])(sid|pk)=")
        private val ACCOUNT_NAME = Regex("^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$")

        fun classify(text: String): ConnectInput {
            val raw = text.trim()
            if (raw.isEmpty()) return Empty
            JoinLink.parse(raw)?.let { return Pairing(it, raw) }
            if (SCHEME.containsMatchIn(raw) || "/join" in raw || SESSION_PARAM.containsMatchIn(raw)) return BadLink
            return Name(raw.lowercase().removePrefix("@"))
        }

        /** The account-name field: a pasted pairing link goes to join, with a note. */
        fun readNameField(text: String): NameField = when (val c = classify(text)) {
            Empty -> NameField.None
            is Pairing -> NameField.Join(c.link, ROUTED_TO_JOIN)
            BadLink -> NameField.Error(BAD_LINK)
            is Name -> NameField.SignIn(c.name)
        }

        /** The pairing field: only a pairing link or bare code joins. */
        fun readPairingField(text: String): PairingField = when (val c = classify(text)) {
            Empty -> PairingField.None
            is Pairing -> PairingField.Join(c.link)
            BadLink -> PairingField.Error(BAD_LINK)
            is Name -> PairingField.Error(if (ACCOUNT_NAME.matches(c.name)) NAME_IN_CODE else NOT_A_CODE)
        }
    }
}
