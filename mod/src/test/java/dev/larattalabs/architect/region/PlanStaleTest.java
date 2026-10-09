package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * PLAN_STALE (docs/CONTRACT.md phase 6b §2.4, gate item 1 "the PLAN_STALE gates (a)-(c) with fake IRs"). The three gates
 * (accept, realise start, resume) all ask {@link IrStale#reason} of the raw IR (RegionsImpl.staleReason); these cases are what
 * each of them refuses. The resume gate also needs the record to load: {@link Ir#lenient}.
 */
class PlanStaleTest {
	static JsonObject ir(int format, String kit, String... requires) {
		JsonObject o = JsonParser.parseString("""
			{"format": 1, "id": "region_small", "kitVersion": "0.12.0", "seed": "7",
			 "claim": {"minX": 0, "minZ": 0, "maxX": 63, "maxZ": 63, "minY": -64, "maxY": 320},
			 "stages": ["ground"], "tiles": {"ground": {"terrain": ["0,0"], "path": []}},
			 "anchors": {"entrance": [1, 64, 1], "spawn": [2, 64, 2]}, "budget": {"cells": 10, "removed": 4, "added": 6}}
			""").getAsJsonObject();
		o.addProperty("format", format);
		o.addProperty("kitVersion", kit);
		if (requires.length > 0) {
			JsonArray a = new JsonArray();
			for (String r : requires) {
				a.add(r);
			}
			o.add("requires", a);
		}
		return o;
	}

	@Test
	void currentPlansAreNotStale() {
		assertNull(IrStale.reason(ir(1, "0.11.0"), null), "a 6a plan");
		assertNull(IrStale.reason(ir(2, "0.12.0", "shape:ellipsoid", "material:rule", "blobs:side"), null));
		assertNull(IrStale.reason(ir(2, "0.12.0", "volumes"), new IrStale.Hello("0.12.0", List.of(1, 2), IrStale.KINDS_FORMAT2)));
	}

	@Test
	void formatThree() {
		assertEquals("plan needs format 3; this is kit 0.12.0", IrStale.reason(ir(3, "0.12.0"), null));
	}

	@Test
	void newerKit() {
		assertEquals("plan needs kit 0.99.0; this is kit 0.12.0", IrStale.reason(ir(2, "0.99.0", "shape:wedge"), null));
		assertNull(IrStale.reason(ir(1, "0.12.0-dev"), null), "pre-release parts compare as the kit's semverCompare (numbers only)");
	}

	@Test
	void unknownKind() {
		assertEquals("plan needs kinds [shape:torus, op:relief]; this is kit 0.12.0", IrStale.reason(ir(2, "0.12.0", "shape:ellipsoid", "shape:torus",
			"op:relief"), null));
	}

	@Test
	void allThreeInTheKitsOrder() {
		assertEquals("plan needs kit 0.99.0 / format 3 / kinds [shape:torus]; this is kit 0.12.0", IrStale.reason(ir(3, "0.99.0", "shape:torus"), null));
	}

	@Test
	void anOlderHelperNarrows() {
		// a 0.11 helper (formats [1], no kinds) refuses a format-2 plan the mod itself could read
		IrStale.Hello old = new IrStale.Hello("0.11.0", List.of(1), List.of());
		assertEquals("plan needs kit 0.12.0 / format 2; this is kit 0.11.0", IrStale.reason(ir(2, "0.12.0", "shape:ellipsoid"), old));
		// a newer helper never widens what the mod accepts
		IrStale.Hello newer = new IrStale.Hello("0.13.0", List.of(1, 2, 3), List.of("shape:torus"));
		assertEquals("plan needs format 3; this is kit 0.12.0", IrStale.reason(ir(3, "0.12.0"), newer));
		assertTrue(IrStale.versionWarning(newer).contains("0.13.0"));
		assertNull(IrStale.versionWarning(new IrStale.Hello("0.12.0", List.of(1, 2), List.of())));
	}

	@Test
	void helloFromSnapshot() {
		JsonObject snap = JsonParser.parseString("{\"protocol\": 2, \"kitVersion\": \"0.12.0\", \"irFormats\": [1, 2], \"irKinds\": [\"fields\"]}")
			.getAsJsonObject();
		IrStale.Hello h = IrStale.Hello.of(snap);
		assertEquals("0.12.0", h.kitVersion());
		assertEquals(List.of(1, 2), h.irFormats());
		assertEquals(List.of("fields"), h.irKinds());
		assertNull(IrStale.Hello.of(JsonParser.parseString("{\"protocol\": 2}").getAsJsonObject()), "a 6a helper names none");
		// a helper naming only some kinds refuses the others
		assertEquals("plan needs kinds [shape:warp]; this is kit 0.12.0", IrStale.reason(ir(2, "0.12.0", "fields", "shape:warp"), h));
	}

	@Test
	void resumeLoadsAStaleRecord() {
		// (c): a format-3 IR is read (the record loads, waits PLAN_STALE, can be removed)
		Ir a = Ir.of(ir(3, "0.99.0"));
		assertEquals(3, a.format());
		assertEquals(List.of("0,0"), a.terrainTiles().get("ground"));
		// an IR far newer than this mod, unreadable as format 1/2: a placeholder with the claim
		JsonObject weird = new JsonObject();
		weird.addProperty("format", 9);
		weird.addProperty("kitVersion", "2.0.0");
		Ir b = Ir.lenient(weird, new int[] {0, -64, 0, 63, 320, 63});
		assertEquals(9, b.format());
		assertEquals(0, b.tileItems().size());
		assertEquals(63, b.claim()[3]);
		assertTrue(IrStale.reason(weird, null).startsWith("plan needs kit 2.0.0 / format 9"));
	}

	@Test
	void format2MembersRead() {
		JsonObject o = ir(2, "0.12.0", "blobs:side");
		JsonObject blobs = new JsonObject();
		JsonObject hb = new JsonObject();
		hb.addProperty("sha", "a".repeat(64));
		hb.addProperty("bytes", 1024);
		hb.addProperty("kind", "heightfield");
		blobs.add("crater", hb);
		JsonObject again = new JsonObject();
		again.addProperty("sha", "a".repeat(64));
		again.addProperty("bytes", 1024);
		again.addProperty("kind", "mask");
		blobs.add("crater2", again);
		o.add("blobs", blobs);
		Ir i = Ir.of(o);
		assertEquals(2, i.blobs().size());
		assertEquals(List.of("a".repeat(64)), i.blobShas(), "unique shas");
		assertEquals(List.of("blobs:side"), i.requires());
	}

	/** The compiled-in constants equal the kit's (kit/lib/realise.mjs, kit/lib/region/plan.mjs): a merge can't drift them. */
	@Test
	void constantsEqualTheKit() throws Exception {
		String realise = Files.readString(Path.of("../kit/lib/realise.mjs"));
		String plan = Files.readString(Path.of("../kit/lib/region/plan.mjs"));
		Matcher kv = Pattern.compile("export const KIT_VERSION = '([^']+)'").matcher(plan);
		assertTrue(kv.find());
		assertEquals(kv.group(1), IrStale.KIT_VERSION);
		Matcher f = Pattern.compile("export const IR_FORMATS = Object.freeze\\(\\[([^\\]]*)\\]\\)").matcher(realise);
		assertTrue(f.find());
		List<Integer> formats = new ArrayList<>();
		for (String x : f.group(1).split(",")) {
			formats.add(Integer.parseInt(x.trim()));
		}
		assertEquals(formats, IrStale.IR_FORMATS);
		Matcher k = Pattern.compile("export const KINDS_FORMAT2 = Object.freeze\\(\\[([^\\]]*)\\]\\)", Pattern.DOTALL).matcher(realise);
		assertTrue(k.find());
		List<String> kinds = new ArrayList<>();
		Matcher q = Pattern.compile("'([^']+)'").matcher(k.group(1));
		while (q.find()) {
			kinds.add(q.group(1));
		}
		assertEquals(kinds, IrStale.KINDS_FORMAT2);
	}

	@Test
	void semver() {
		assertEquals(1, IrStale.semverCompare("0.13.0", "0.12.9"));
		assertEquals(-1, IrStale.semverCompare("0.9.0", "0.12.0"));
		assertEquals(0, IrStale.semverCompare("0.12", "0.12.0"));
		assertEquals(0, IrStale.semverCompare("0.12.0-rc1", "0.12.0"));
	}
}
