package com.flagshipserver.app.api

/** The random code every mock service starts with. */
const val MOCK_SHORT_CODE = "k3x9qa"

/** Scriptable broker for previews and tests. Records every check and signed order. */
class MockVoiciNameClient : VoiciNameClient {
    var scriptedStatus = "available"
    var scriptedDomain: String? = null
    var checkError: Exception? = null
    var saveError: VoiciNameException? = null
    var link = AppLinkState(name = null, held = 0, limit = 5, changesLeft = 3)
    val names = mutableListOf<VoiciNameEntry>()
    val checks = mutableListOf<String>()
    val saves = mutableListOf<VoiciNameOrderBody>()

    override suspend fun check(username: String, serviceId: String, name: String): VoiciNameCheck {
        checks += name
        checkError?.let { throw it }
        return VoiciNameCheck(status = scriptedStatus, domain = scriptedDomain)
    }

    override suspend fun list(username: String): List<VoiciNameEntry> = names.toList()

    override suspend fun save(username: String, serviceId: String, body: VoiciNameOrderBody): AppLinkState {
        saves += body
        saveError?.let { throw it }
        val next = if (body.order.op == "set") {
            link.copy(
                name = body.order.name,
                held = if (link.name == null) link.held + 1 else link.held,
                changesLeft = maxOf(0, link.changesLeft - 1),
                releasesAt = 1L,
            )
        } else {
            link.copy(
                name = null,
                held = maxOf(0, link.held - 1),
                changesLeft = maxOf(0, link.changesLeft - 1),
                releasesAt = null,
            )
        }
        names.removeAll { it.serviceId == serviceId }
        if (next.name != null) names += VoiciNameEntry(serviceId, next.name!!, 0)
        link = next
        return next
    }
}
