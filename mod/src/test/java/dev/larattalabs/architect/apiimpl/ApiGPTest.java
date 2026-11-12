package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BiblePin;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Designs;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.ProgramRefused;
import dev.larattalabs.architect.api.Reason;
import java.util.List;
import java.util.concurrent.CompletionException;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (M5 GP) Given-program designs on the mod side: the {@code design.fromProgram}, {@code design.variant} and {@code design.variantByKey}
 * messages and their checks (the bible's latest, the reserved cells in the lot's frame, the source and params bounds), an operation's
 * outcome as the API answers it (the new entry id, or a {@link ProgramRefused} carrying the checker's typed findings), a synchronous
 * PROGRAM_REFUSED made a ProgramRefused too, the feature name, the Reason appended last, and the Designs defaults that throw.
 */
class ApiGPTest {
	static final String SRC = "export const id = 'farm';\nexport default function build() {}\n";

	static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	@Test
	void fromProgramMessage() {
		JsonObject m = GivenPrograms.fromProgramMessage(SRC, json("{\"side\":9}"), new BiblePin("birch_town", 3), "steward.b.module.lot_1", "steward:abc");
		assertEquals("design.fromProgram", m.get("type").getAsString());
		assertEquals(SRC, m.get("source").getAsString());
		assertEquals(json("{\"side\":9}"), m.get("params"));
		assertEquals(json("{\"id\":\"birch_town\",\"version\":3}"), m.get("bible"));
		assertEquals("steward.b.module.lot_1", m.get("opKey").getAsString());
		assertEquals("steward:abc", m.get("owner").getAsString());
		// version 0: the latest (no version on the wire); no bible, no owner: neither on the wire
		assertEquals(json("{\"id\":\"birch_town\"}"), GivenPrograms.fromProgramMessage(SRC, new JsonObject(), new BiblePin("birch_town", 0), "k", null).get("bible"));
		JsonObject bare = GivenPrograms.fromProgramMessage(SRC, new JsonObject(), null, "k", null);
		assertFalse(bare.has("bible"));
		assertFalse(bare.has("owner"));
	}

	@Test
	void fromProgramChecks() {
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.fromProgramMessage("", new JsonObject(), null, "k", null));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.fromProgramMessage(SRC, null, null, "k", null));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.fromProgramMessage(SRC, new JsonObject(), null, null, null));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.fromProgramMessage(SRC, new JsonObject(), null, "bad key!", null));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.fromProgramMessage(SRC, new JsonObject(), new BiblePin("Bad-Id", 1), "k", null));
		ArchitectRefused big = assertThrows(ArchitectRefused.class, () -> GivenPrograms.fromProgramMessage("x".repeat(Limits.PROGRAM_SOURCE_MAX + 1), new JsonObject(), null,
			"k", null));
		assertEquals(Reason.FIELD_LIMIT, big.reason());
		JsonObject p = new JsonObject();
		p.addProperty("notes", "y".repeat(Limits.PROGRAM_PARAMS_MAX));
		assertEquals(Reason.FIELD_LIMIT, assertThrows(ArchitectRefused.class, () -> GivenPrograms.fromProgramMessage(SRC, p, null, "k", null)).reason());
		// the sidecar's bounds (programs.ts PROGRAM_SOURCE_MAX, PROGRAM_PARAMS_MAX)
		assertEquals(262144, Limits.PROGRAM_SOURCE_MAX);
		assertEquals(16384, Limits.PROGRAM_PARAMS_MAX);
	}

	@Test
	void variantMessage() {
		DesignRequest.Reserved r = new DesignRequest.Reserved("south", 11, 11, List.of(new BlockPos(5, -1, 5), new BlockPos(5, 0, 5)));
		JsonObject m = GivenPrograms.variantMessage("crop_farm", json("{\"crop\":\"wheat\"}"), null, r, "steward.b.module.lot_3", null);
		assertEquals("design.variant", m.get("type").getAsString());
		assertEquals("crop_farm", m.get("entryId").getAsString());
		assertEquals(json("{\"front\":\"south\",\"size\":[11,11],\"cells\":[[5,-1,5],[5,0,5]]}"), m.get("reserved"));
		assertFalse(GivenPrograms.variantMessage("crop_farm", new JsonObject(), null, null, "k", null).has("reserved"));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.variantMessage("Crop Farm", new JsonObject(), null, null, "k", null));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.variantMessage("crop_farm", new JsonObject(), null, new DesignRequest.Reserved("up", 9, 9,
			List.of()), "k", null));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.variantMessage("crop_farm", new JsonObject(), null, new DesignRequest.Reserved("south", 0, 9,
			List.of()), "k", null));
		JsonObject k = GivenPrograms.byKeyMessage("steward:abc", "steward.b.module.lot_3");
		assertEquals("design.variantByKey", k.get("type").getAsString());
		assertEquals("steward:abc", k.get("owner").getAsString());
		assertFalse(GivenPrograms.byKeyMessage(null, "k").has("owner"));
		assertThrows(IllegalArgumentException.class, () -> GivenPrograms.byKeyMessage(null, null));
	}

	@Test
	void outcomeAndRefusal() {
		assertEquals("crop_farm_kv", GivenPrograms.outcome(json("{\"id\":\"kv1\",\"status\":\"done\",\"newEntryId\":\"crop_farm_kv\"}")));
		JsonObject refused = json("{\"id\":\"kv1\",\"status\":\"done\",\"refused\":{\"code\":\"PROGRAM_REFUSED\",\"detail\":\"reserved\",\"message\":\"the variant did not"
			+ " pass: ...\",\"findings\":[{\"rule\":\"reserved\",\"severity\":\"error\",\"message\":\"reserved: the design writes 2 of the lot's reserved cell(s)\"},"
			+ "{\"rule\":\"anchors\",\"severity\":\"error\",\"message\":\"missing required anchor 'spawn'\"}]}}");
		ProgramRefused e = assertThrows(ProgramRefused.class, () -> GivenPrograms.outcome(refused));
		assertEquals(Reason.PROGRAM_REFUSED, e.reason());
		assertEquals("reserved", e.detail());
		assertFalse(e.report().ok());
		assertEquals(2, e.report().errors());
		assertEquals(List.of("reserved", "anchors"), e.report().findings().stream().map(f -> f.rule()).toList());
		assertEquals(1, e.report().of("reserved").size());
		assertNull(e.report().findings().get(0).part());
		assertTrue(e.report().findings().get(0).message().startsWith("reserved: the design writes 2"));
		assertThrows(IllegalStateException.class, () -> GivenPrograms.outcome(json("{\"id\":\"kv1\",\"status\":\"done\"}")));
	}

	@Test
	void synchronousRefusalIsTyped() {
		ArchitectRefused sync = new ArchitectRefused(Reason.PROGRAM_REFUSED, "not_given: cabin is not a given-program entry", "not_given");
		ProgramRefused t = assertInstanceOf(ProgramRefused.class, GivenPrograms.typed(new CompletionException(sync)));
		assertEquals("not_given", t.detail());
		assertEquals("not_given", t.report().findings().get(0).rule());
		// other failures pass through (unwrapped)
		ArchitectRefused other = new ArchitectRefused(Reason.UNKNOWN_BLUEPRINT, "no entry", "no_entry");
		assertSame(other, GivenPrograms.typed(new CompletionException(other)));
		ProgramRefused already = new ProgramRefused("m", "params", List.of());
		assertSame(already, GivenPrograms.typed(already));
		// the ack's code maps to the Reason (Wire0b)
		JsonObject ack = json("{\"ok\":false,\"error\":\"program_stale: changed\",\"code\":\"PROGRAM_REFUSED\",\"detail\":\"program_stale\"}");
		assertEquals(Reason.PROGRAM_REFUSED, Wire0b.refusal(ack).reason());
	}

	@Test
	void featureReasonAndDefaults() {
		assertTrue(ApiRules.features(2, List.of("design.program")).contains("givenPrograms"));
		assertFalse(ApiRules.features(2, List.of("site.design")).contains("givenPrograms"));
		Reason[] all = Reason.values();
		assertEquals(Reason.PROGRAM_REFUSED, all[all.length - 1]);
		assertEquals(Reason.NO_LINK, all[all.length - 2]);
		// every abstract method unimplemented; the GP defaults run as an older implementation sees them
		Designs d = (Designs) java.lang.reflect.Proxy.newProxyInstance(Designs.class.getClassLoader(), new Class<?>[] {Designs.class}, (proxy, method, args) -> {
			if (method.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(proxy, method, args);
			}
			throw new AssertionError("not called: " + method.getName());
		});
		assertThrows(UnsupportedOperationException.class, () -> d.fromProgram(SRC, new JsonObject(), null, "k"));
		assertThrows(UnsupportedOperationException.class, () -> d.variant("e", new JsonObject(), null, null, "k"));
		assertThrows(UnsupportedOperationException.class, () -> d.variantByKey("k"));
	}
}
