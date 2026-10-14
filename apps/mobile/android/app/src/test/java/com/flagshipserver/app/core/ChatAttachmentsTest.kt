package com.flagshipserver.app.core

import com.flagshipserver.app.api.VibeCodeAttachment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAttachmentsTest {
    @Test fun kinds() {
        assertEquals(AttachKind.IMAGE, ChatAttachments.kindFor("a.PNG", null))
        assertEquals(AttachKind.IMAGE, ChatAttachments.kindFor("photo", "image/webp"))
        assertEquals(AttachKind.DOCUMENT, ChatAttachments.kindFor("spec.pdf", "application/pdf"))
        assertEquals(AttachKind.DATA, ChatAttachments.kindFor("plants.csv", "text/csv"))
        assertEquals(AttachKind.DATA, ChatAttachments.kindFor("seed.json", null))
        assertEquals(AttachKind.TEXT, ChatAttachments.kindFor("notes.md", null))
        assertEquals(AttachKind.TEXT, ChatAttachments.kindFor("main.kt", "application/octet-stream"))
        assertEquals(AttachKind.TEXT, ChatAttachments.kindFor("readme", "text/plain"))
        assertNull(ChatAttachments.kindFor("movie.mp4", "video/mp4"))
        assertNull(ChatAttachments.kindFor("pic.heic", "image/heic"))
    }

    @Test fun limits() {
        assertNull(ChatAttachments.problem(AttachKind.IMAGE, "a.png", 4L * 1024 * 1024, 0))
        assertEquals("a.png is over 4 MB, so it wasn't attached.", ChatAttachments.problem(AttachKind.IMAGE, "a.png", 4L * 1024 * 1024 + 1, 0))
        assertEquals("n.md is over 256 KB, so it wasn't attached.", ChatAttachments.problem(AttachKind.TEXT, "n.md", 256L * 1024 + 1, 0))
        assertNull(ChatAttachments.problem(AttachKind.DATA, "d.csv", 2L * 1024 * 1024, 0))
        assertEquals("d.csv is over 2 MB, so it wasn't attached.", ChatAttachments.problem(AttachKind.DATA, "d.csv", 2L * 1024 * 1024 + 1, 0))
        assertNull(ChatAttachments.problem(AttachKind.DOCUMENT, "s.pdf", 10L * 1024 * 1024, 5))
        assertEquals("s.pdf is over 10 MB, so it wasn't attached.", ChatAttachments.problem(AttachKind.DOCUMENT, "s.pdf", 10L * 1024 * 1024 + 1, 0))
        assertEquals(ChatAttachments.TOO_MANY, ChatAttachments.problem(AttachKind.IMAGE, "a.png", 10, 6))
        assertTrue(ChatAttachments.problem(null, "m.mp4", 10, 0)!!.startsWith("m.mp4 can't be attached."))
    }

    @Test fun builds() {
        val img = ChatAttachments.build(AttachKind.IMAGE, "a.jpg", "image/jpeg", byteArrayOf(1, 2, 3)) as VibeCodeAttachment.Image
        assertEquals("image/jpeg", img.mediaType)
        assertEquals("AQID", img.dataBase64)
        val data = ChatAttachments.build(AttachKind.DATA, "x.json", null, "{}".toByteArray()) as VibeCodeAttachment.Data
        assertEquals("application/json", data.mediaType)
        val csv = ChatAttachments.build(AttachKind.DATA, "x.csv", "text/comma-separated-values", "a".toByteArray()) as VibeCodeAttachment.Data
        assertEquals("text/csv", csv.mediaType)
        val pdf = ChatAttachments.build(AttachKind.DOCUMENT, "s.pdf", null, byteArrayOf(0x25)) as VibeCodeAttachment.Document
        assertEquals("application/pdf", pdf.mediaType)
        assertTrue(ChatAttachments.hasSampleData(listOf(img, data)))
        assertTrue(ChatAttachments.hasImage(listOf(img)))
        assertEquals("The AI will see what you attach.", ChatAttachments.NOTICE)
    }
}
