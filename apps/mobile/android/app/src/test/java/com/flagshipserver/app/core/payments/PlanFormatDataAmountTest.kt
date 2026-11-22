package com.flagshipserver.app.core.payments

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

class PlanFormatDataAmountTest {
    private val mib = 1024L * 1024
    private val gib = mib * 1024

    @Test fun nothingUsedIsZeroMegabytes() {
        assertEquals(PlanFormat.Amount("0", gb = false), PlanFormat.dataAmount(0, Locale.US))
        assertEquals(PlanFormat.Amount("0", gb = false), PlanFormat.dataAmount(-5, Locale.US))
    }

    @Test fun underAGigabyteIsWholeMegabytes() {
        assertEquals(PlanFormat.Amount("512", gb = false), PlanFormat.dataAmount(512 * mib + 900_000, Locale.US))
    }

    @Test fun gigabytesToOneDecimalInTheLocale() {
        assertEquals(PlanFormat.Amount("25", gb = true), PlanFormat.dataAmount(25 * gib, Locale.US))
        assertEquals(PlanFormat.Amount("1.5", gb = true), PlanFormat.dataAmount(gib + gib / 2, Locale.US))
        assertEquals(PlanFormat.Amount("1,5", gb = true), PlanFormat.dataAmount(gib + gib / 2, Locale.GERMANY))
    }
}
