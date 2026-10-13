package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.JobSpec;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.region.IrStale;
import java.util.List;
import org.junit.jupiter.api.Test;

/** C33 (API 1.27.0 placeholder): JobSpec.systemRefs, the raised system cap, FIELD_LIMIT, the wire shape and binary compatibility. */
class JobSystemRefsTest {
	private static JobSpec spec(String kind, String system, List<String> refs) {
		return new JobSpec(kind, "go", system, null, null, null, List.of(), null, null, "t:o", null, null, new JsonObject(), List.of(), List.of(), refs);
	}

	@Test
	void version() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.27.0") >= 0, ArchitectApi.VERSION);
	}

	@Test
	void oldConstructorsKeepWorkingWithNoRefs() {
		JobSpec fourteen = new JobSpec("structured", "p", "s", null, null, null, List.of(), null, null, null, null, null, null, List.of());
		JobSpec fifteen = new JobSpec("structured", "p", "s", null, null, null, List.of(), null, null, null, null, null, null, List.of(), List.of());
		assertEquals(List.of(), fourteen.systemRefs());
		assertEquals(List.of(), fifteen.systemRefs());
		assertEquals(List.of(), new JobSpec("structured", "p", null, null, null, null, null, null, null, null, null, null, null, null, null, null).systemRefs(), "null = none");
	}

	@Test
	void copiersKeepTheRefs() {
		JobSpec s = spec("structured", null, List.of("plan/0#compact"));
		assertEquals(List.of("plan/0#compact"), s.images(List.of(new JobSpec.ImageRef("b1", "x"))).systemRefs(), "images() must not drop the refs");
		assertEquals(List.of("plan/0"), s.systemRefs(List.of("plan/0")).systemRefs());
		assertEquals(1, s.systemRefs(List.of("plan/0")).images().size() + 1, "no images added");
	}

	@Test
	void wireCarriesRefsOnlyWhenSet() {
		assertFalse(JobsImpl.wire(spec("structured", "s", List.of())).has("systemRefs"), "none: the 1.26 shape");
		JsonObject w = JobsImpl.wire(spec("structured", "s", List.of("plan/0", "mask/1")));
		JsonArray a = w.getAsJsonArray("systemRefs");
		assertEquals(List.of("plan/0", "mask/1"), List.of(a.get(0).getAsString(), a.get(1).getAsString()), "the caller's order goes as given; the helper orders");
		assertEquals("s", w.get("system").getAsString());
	}

	@Test
	void systemCapByKind() {
		assertNull(FieldLimits.job(spec("structured", "a".repeat(Limits.JOB_SYSTEM_MAX), List.of())));
		String why = FieldLimits.job(spec("structured", "a".repeat(Limits.JOB_SYSTEM_MAX + 1), List.of()));
		assertEquals("system: 120001 characters, at most 120000", why);
		assertNull(FieldLimits.job(spec("agent", "a".repeat(Limits.JOB_SYSTEM_AGENT_MAX), List.of())));
		assertEquals("system: 50001 characters, at most 50000", FieldLimits.job(spec("agent", "a".repeat(Limits.JOB_SYSTEM_AGENT_MAX + 1), List.of())));
		assertEquals(120_000, Limits.JOB_SYSTEM_MAX);
		assertNull(FieldLimits.job(spec("structured", "  " + "a".repeat(Limits.JOB_SYSTEM_MAX - 2), List.of())), "not trimmed, as zod");
	}

	@Test
	void refBounds() {
		assertNull(FieldLimits.job(spec("structured", null, List.of("plan/0", "plan/0#compact".replace("plan", "mask").replace("/0", "/1")))));
		List<String> eight = List.of("a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7", "a/8");
		assertNull(FieldLimits.job(spec("structured", null, eight)));
		assertEquals("systemRefs: 9 entries, at most 8", FieldLimits.job(spec("structured", null, List.of("a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7", "a/8", "a/9"))));
		String bad = FieldLimits.job(spec("structured", null, List.of("plan/0", "Plan 0")));
		assertNotNull(bad);
		assertTrue(bad.startsWith("systemRefs[1]: \"Plan 0\" doesn't match"), bad);
		assertTrue(FieldLimits.job(spec("structured", null, List.of("plan/0", "plan/0"))).contains("systemRefs[1]"), "a duplicate");
		String longRef = "a/" + "b".repeat(Limits.JOB_SYSTEM_REF_MAX - 1);
		assertEquals(Limits.JOB_SYSTEM_REF_MAX + 1, longRef.length());
		assertNull(FieldLimits.job(spec("structured", null, List.of(longRef.substring(0, Limits.JOB_SYSTEM_REF_MAX)))), "64 characters: fine");
		assertEquals("systemRefs[0]: 65 characters, at most 64", FieldLimits.job(spec("structured", null, List.of(longRef))));
	}

	@Test
	void runRefusesBeforeSending() {
		var f = new JobsImpl().run(spec("structured", "a".repeat(Limits.JOB_SYSTEM_MAX + 1), List.of()));
		var e = org.junit.jupiter.api.Assertions.assertThrows(java.util.concurrent.ExecutionException.class, () -> f.get(5, java.util.concurrent.TimeUnit.SECONDS));
		assertTrue(e.getCause() instanceof dev.larattalabs.architect.api.ArchitectRefused r && r.reason() == dev.larattalabs.architect.api.Reason.FIELD_LIMIT, String.valueOf(e.getCause()));
	}

	@Test
	void helperRefusalIsTyped() {
		JsonObject ack = com.google.gson.JsonParser.parseString("{\"ok\":false,\"error\":\"systemRefs: unknown ref \\\"plan/9\\\" (known: plan/0)\",\"code\":\"FIELD_LIMIT\",\"detail\":\"system_ref\"}").getAsJsonObject();
		var r = Wire0b.refusal(ack);
		assertNotNull(r);
		assertEquals(dev.larattalabs.architect.api.Reason.FIELD_LIMIT, r.reason());
		assertEquals("system_ref", r.detail());
		assertTrue(r.getMessage().contains("plan/9"), r.getMessage());
	}

	@Test
	void featureNameIsPassedThrough() {
		assertTrue(ApiRules.features(2, List.of("job.run", "job.systemRefs")).contains("job.systemRefs"));
		assertFalse(ApiRules.features(2, List.of("job.run")).contains("job.systemRefs"));
	}
}
