package com.flagshipserver.app.api

import com.flagshipserver.app.core.HttpClientFactory
import com.flagshipserver.app.core.JsonHttpTransport
import com.flagshipserver.app.core.OkHttpJsonTransport
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** In-memory mock: returns a configurable map (default null = "no fresher
 *  source"). Mirror of iOS `MockLeadsClient`. */
class MockLeadsClient(var result: LeadsMap? = null) : LeadsClient {
    val requested = mutableListOf<String>()
    override suspend fun fetchLeads(podFqdn: String): LeadsMap? {
        requested.add(podFqdn)
        return result
    }
}
