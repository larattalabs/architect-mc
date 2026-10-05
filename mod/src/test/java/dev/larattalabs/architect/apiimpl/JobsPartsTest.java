package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Job;
import dev.larattalabs.architect.api.JobSpec;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.List;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;

/** The pure parts of the jobs bridge: the answer cache, DONE dedup, timeout bookkeeping, blob chunking, the wire forms. */
class JobsPartsTest {
	// ------------------------------------------------------------------ answer cache

	@Test
	void answerCacheRunsOnceThenResends() {
		ToolAnswerCache c = new ToolAnswerCache(4);
		assertEquals(ToolAnswerCache.Action.RUN, c.begin("c1"));
		// re-sent while the handler still runs (a reconnect): not run again
		assertEquals(ToolAnswerCache.Action.RUNNING, c.begin("c1"));
		assertNull(c.get("c1"));
		JsonObject a = new JsonObject();
		a.addProperty("callId", "c1");
		a.addProperty("result", 42);
		c.answer("c1", a);
		a.addProperty("result", 0); // the cache keeps its own copy
		assertFalse(c.isRunning("c1"));
		// re-sent after a sidecar restart: the same answer, no handler
		assertEquals(ToolAnswerCache.Action.RESEND, c.begin("c1"));
		assertEquals(42, c.get("c1").get("result").getAsInt());
		assertEquals(ToolAnswerCache.Action.RESEND, c.begin("c1"));
	}

	@Test
	void answerCacheKeepsTheNewest() {
		ToolAnswerCache c = new ToolAnswerCache(2);
		for (String id : List.of("a", "b", "c")) {
			c.begin(id);
			c.answer(id, new JsonObject());
		}
		assertEquals(2, c.size());
		assertNull(c.get("a"));
		assertEquals(ToolAnswerCache.Action.RESEND, c.begin("c"));
	}

	// ------------------------------------------------------------------ DONE dedup

	@Test
	void ledgerFiresDoneOnceAndUpdatesOnChange() {
		JobLedger l = new JobLedger();
		String k = JobLedger.key("j1", 100);
		assertTrue(l.updated(k, new JobLedger.Mark("running", "starting", 1, 0)));
		// the same state again (a reconnect's snapshot): no update
		assertFalse(l.updated(k, new JobLedger.Mark("running", "starting", 1, 0)));
		assertTrue(l.updated(k, new JobLedger.Mark("running", "waiting", 2, 0.01)));
		assertFalse(l.done(k, false));
		assertTrue(l.done(k, true));
		assertFalse(l.done(k, true));
		assertTrue(l.isDone(k));
		// a sidecar that numbers from j1 again (state wiped): another job
		assertTrue(l.done(JobLedger.key("j1", 200), true));
		// a game restart: the persisted set comes back
		JobLedger again = new JobLedger();
		again.restoreDone(l.doneKeys());
		assertFalse(again.done(k, true));
	}

	@Test
	void ledgerForgetsTheOldest() {
		JobLedger l = new JobLedger();
		for (int i = 0; i < JobLedger.KEEP + 5; i++) {
			l.done(JobLedger.key("j" + i, i), true);
		}
		assertEquals(JobLedger.KEEP, l.doneKeys().size());
		assertFalse(l.isDone(JobLedger.key("j0", 0)));
		assertTrue(l.isDone(JobLedger.key("j" + (JobLedger.KEEP + 4), JobLedger.KEEP + 4)));
	}

	// ------------------------------------------------------------------ timeouts

	@Test
	void pendingTimesOut() {
		PendingFutures<String> p = new PendingFutures<>("variant", 1000);
		CompletableFuture<String> f = p.await("v1", new CompletableFuture<>(), 0, 120_000);
		assertEquals(0, p.expire(119_999));
		assertFalse(f.isDone());
		assertEquals(1, p.expire(120_000));
		ExecutionException e = assertThrows(ExecutionException.class, f::get);
		assertTrue(e.getCause() instanceof TimeoutException);
		assertEquals(0, p.waitingCount());
		// finishing after the timeout: kept as an early outcome, then forgotten
		p.complete("v1", "late", 130_000);
		assertEquals(1, p.earlyCount());
		p.expire(131_000);
		assertEquals(0, p.earlyCount());
	}

	@Test
	void pendingOutcomeBeforeAckStillCompletes() throws Exception {
		PendingFutures<String> p = new PendingFutures<>("variant", 60_000);
		// the variant finished before the ack registered its future
		p.complete("v2", "entry", 10);
		CompletableFuture<String> f = p.await("v2", new CompletableFuture<>(), 20, 120_000);
		assertEquals("entry", f.get());
		p.fail("v3", new IllegalStateException("bad palette"), 10);
		CompletableFuture<String> g = p.await("v3", new CompletableFuture<>(), 20, 120_000);
		assertEquals("bad palette", assertThrows(ExecutionException.class, g::get).getCause().getMessage());
		assertEquals(0, p.waitingCount());
		assertEquals(0, p.earlyCount());
	}

	@Test
	void pendingFailsAllOnDisconnect() {
		PendingFutures<String> p = new PendingFutures<>("variant", 60_000);
		CompletableFuture<String> a = p.await("a", new CompletableFuture<>(), 0, 1000);
		CompletableFuture<String> b = p.await("b", new CompletableFuture<>(), 0, 1000);
		assertEquals(2, p.failAll("the helper disconnected"));
		assertTrue(a.isCompletedExceptionally() && b.isCompletedExceptionally());
		assertEquals(0, p.expire(5000));
	}

	@Test
	void timeoutsParse() {
		assertEquals(5000, ApiTimeouts.parse("5000", null, 1));
		assertEquals(7000, ApiTimeouts.parse(null, "7000", 1));
		assertEquals(7000, ApiTimeouts.parse("x", "7000", 1));
		assertEquals(1, ApiTimeouts.parse("-3", "", 1));
		assertEquals(600_000, ApiTimeouts.DESIGN_DEFAULT_MS);
		assertEquals(120_000, ApiTimeouts.VARIANT_DEFAULT_MS);
	}

	// ------------------------------------------------------------------ chunking

	@Test
	void framesKeepChunksAndFramesSmall() throws Exception {
		byte[] data = new byte[25 * 1024 * 1024 + 123];
		new Random(7).nextBytes(data);
		List<List<String>> frames = BlobFrames.frames(data);
		ByteArrayOutputStream back = new ByteArrayOutputStream();
		for (List<String> f : frames) {
			long chars = 0;
			assertTrue(f.size() <= 64);
			for (String c : f) {
				byte[] b = Base64.getDecoder().decode(c);
				assertTrue(b.length <= BlobFrames.CHUNK_BYTES, "chunk " + b.length);
				chars += c.length();
				back.write(b);
			}
			assertTrue(chars <= BlobFrames.FRAME_BUDGET && chars < BlobFrames.FRAME_BYTES, "frame " + chars);
		}
		assertTrue(frames.size() >= 3, "several frames: " + frames.size());
		assertArrayEquals(data, back.toByteArray());
	}

	@Test
	void framesOfSmallAndEmptyBlobs() {
		assertEquals(List.of(List.of()), BlobFrames.frames(new byte[0]));
		List<List<String>> one = BlobFrames.frames(new byte[] {1, 2, 3});
		assertEquals(1, one.size());
		assertEquals("AQID", one.get(0).get(0));
		// a tiny budget still puts one chunk in each frame
		assertEquals(3, BlobFrames.frames(new byte[30], 10, 1).size());
	}

	// ------------------------------------------------------------------ wire forms

	@Test
	void specWire() {
		JsonObject schema = JsonParser.parseString("{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\"}}}").getAsJsonObject();
		JobSpec s = new JobSpec("agent", "go", null, null, "low", null, List.of(new JobSpec.Tool("survey", "summary", schema, 5000L, true),
			new JobSpec.Tool("t2", "d", schema, null, false)), 0.05, 6, "apitest", "tag1", null, new JsonObject(), List.of("b1"));
		JsonObject w = JobsImpl.wire(s);
		assertEquals("agent", w.get("kind").getAsString());
		assertFalse(w.has("system") || w.has("model") || w.has("schema") || w.has("group") || w.has("ext"));
		assertEquals("low", w.get("effort").getAsString());
		assertEquals(5000, w.getAsJsonArray("tools").get(0).getAsJsonObject().get("timeoutMs").getAsInt());
		assertTrue(w.getAsJsonArray("tools").get(0).getAsJsonObject().get("readOnly").getAsBoolean());
		assertFalse(w.getAsJsonArray("tools").get(1).getAsJsonObject().has("readOnly"));
		assertEquals(0.05, w.get("budgetUsd").getAsDouble());
		assertEquals("b1", w.getAsJsonArray("blobs").get(0).getAsString());
		assertEquals("apitest", w.get("owner").getAsString());
	}

	@Test
	void jobView() {
		Job j = JobsImpl.view(JsonParser.parseString("{\"id\":\"j3\",\"spec\":{\"kind\":\"structured\",\"owner\":\"apitest\"},\"status\":\"done\","
			+ "\"step\":\"done\",\"result\":{\"name\":\"x\"},\"cost\":{\"usd\":0.02,\"turns\":2,\"cacheReadTokens\":500},\"createdAt\":5,\"updatedAt\":9}")
			.getAsJsonObject());
		assertEquals("j3", j.id());
		assertTrue(j.finished());
		assertEquals("apitest", j.owner().orElseThrow());
		assertEquals("x", j.result().orElseThrow().getAsJsonObject().get("name").getAsString());
		assertEquals(500, j.cost().cacheReadTokens());
		assertTrue(j.resultBlob().isEmpty());
		Job big = JobsImpl.view(JsonParser.parseString("{\"id\":\"j4\",\"spec\":{},\"status\":\"done\",\"step\":\"done\",\"resultBlob\":\"b9\","
			+ "\"cost\":{},\"createdAt\":5,\"updatedAt\":9}").getAsJsonObject());
		assertEquals("b9", big.resultBlob().orElseThrow());
		assertTrue(big.result().isEmpty() && big.owner().isEmpty());
		// the 1.0.0 constructor still works
		assertTrue(new Job("j", new JsonObject(), "queued", "", java.util.Optional.empty(), java.util.Optional.empty(), dev.larattalabs.architect.api.Cost.NONE,
			0, 0).resultBlob().isEmpty());
	}

	@Test
	void ackString() {
		JsonObject ok = JsonParser.parseString("{\"ok\":true,\"result\":{\"jobId\":\"j7\"}}").getAsJsonObject();
		assertEquals("j7", JobsImpl.ackString(ok, "jobId"));
		JsonObject no = JsonParser.parseString("{\"ok\":false,\"error\":\"Claude is not available\"}").getAsJsonObject();
		assertEquals("Claude is not available", assertThrows(RuntimeException.class, () -> JobsImpl.ackString(no, "jobId")).getCause().getMessage());
	}
}
