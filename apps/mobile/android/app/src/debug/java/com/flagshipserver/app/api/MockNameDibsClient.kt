package com.flagshipserver.app.api

/** Scriptable broker for previews and tests. Records every signed body. */
class MockNameDibsClient : NameDibsClient {
    var scriptedWindow = DibsWindow()
    var initiateError: DibsClientException? = null
    var verifyError: DibsClientException? = null
    val initiates = mutableListOf<DibsInitiateBody>()
    val verifies = mutableListOf<DibsVerifyBody>()

    override suspend fun window(): DibsWindow = scriptedWindow

    override suspend fun initiate(body: DibsInitiateBody): DibsClaim {
        initiates += body
        initiateError?.let { throw it }
        val name = body.request.name
        return DibsClaim(
            name = name,
            nonce = "0".repeat(63) + "1",
            challenge = "mock-challenge",
            record = "flagship-claim:mock-challenge",
            publishAt = DibsPublishAt(
                DibsPublishDns("_flagship-claim.$name.com"),
                DibsPublishHttps("https://$name.com/.well-known/flagship-claim"),
            ),
        )
    }

    override suspend fun verify(body: DibsVerifyBody): DibsVerifyResult {
        verifies += body
        verifyError?.let { throw it }
        return DibsVerifyResult(name = body.request.name, verified = true, method = "dns")
    }
}
