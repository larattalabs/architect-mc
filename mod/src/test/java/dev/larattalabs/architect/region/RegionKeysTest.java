package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.RegionPlanRequest;
import java.util.List;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/** 6c X: the opKey body hashes (C20), the plan's lot ext onto the site's ext (C19) and the region record's key. */
class RegionKeysTest {
	private static RegionPlanRequest plan(JsonObject params, BoundingBox claim, String opKey) {
		return new RegionPlanRequest("flat_village", params, null, claim, null, null, null, LoadPolicy.LOADED_ONLY, null, new JsonObject(), opKey);
	}

	private static RealiseRequest realise(Map<String, String> entries, boolean force, String opKey) {
		return new RealiseRequest("rp1", Mode.AUTO, null, entries, null, true, null, force, new JsonObject(), 0, opKey);
	}

	@Test
	void planBodyHash() {
		JsonObject p = JsonParser.parseString("{\"lots\": [{\"id\": \"a_1\", \"ext\": {\"steward_mc:b\": 1}}], \"shared\": \"well\"}").getAsJsonObject();
		String h = RegionKeys.hash(RegionKeys.planBody(plan(p, new BoundingBox(0, 0, 0, 111, 0, 111), "k1")));
		assertEquals(64, h.length());
		// the key is not part of the body; the same request hashes the same (also with the members in another order)
		assertEquals(h, RegionKeys.hash(RegionKeys.planBody(plan(p.deepCopy(), new BoundingBox(0, 0, 0, 111, 0, 111), "other"))));
		JsonObject q = JsonParser.parseString("{\"shared\": \"well\", \"lots\": [{\"ext\": {\"steward_mc:b\": 1}, \"id\": \"a_1\"}]}").getAsJsonObject();
		assertEquals(h, RegionKeys.hash(RegionKeys.planBody(plan(q, new BoundingBox(0, 0, 0, 111, 0, 111), "k1"))));
		// the claim's y range is ignored by the plan, and so by the body
		assertEquals(h, RegionKeys.hash(RegionKeys.planBody(plan(p, new BoundingBox(0, -64, 0, 111, 320, 111), "k1"))));
		// another claim, another param, another ext value: another body
		assertNotEquals(h, RegionKeys.hash(RegionKeys.planBody(plan(p, new BoundingBox(0, 0, 0, 112, 0, 111), "k1"))));
		JsonObject changed = p.deepCopy();
		changed.getAsJsonArray("lots").get(0).getAsJsonObject().getAsJsonObject("ext").addProperty("steward_mc:b", 2);
		assertNotEquals(h, RegionKeys.hash(RegionKeys.planBody(plan(changed, new BoundingBox(0, 0, 0, 111, 0, 111), "k1"))));
	}

	@Test
	void realiseBodyHash() {
		String h = RegionKeys.hash(RegionKeys.realiseBody(realise(Map.of("a_1", "x", "b_1", "y"), false, "k1")));
		assertEquals(h, RegionKeys.hash(RegionKeys.realiseBody(realise(Map.of("b_1", "y", "a_1", "x"), false, "k2"))), "entry order and the key are not the body");
		assertNotEquals(h, RegionKeys.hash(RegionKeys.realiseBody(realise(Map.of("a_1", "x", "b_1", "z"), false, "k1"))));
		assertNotEquals(h, RegionKeys.hash(RegionKeys.realiseBody(realise(Map.of("a_1", "x", "b_1", "y"), true, "k1"))));
		assertNotEquals(h, RegionKeys.hash(RegionKeys.realiseBody(new RealiseRequest("rp2", Mode.AUTO, null, Map.of("a_1", "x", "b_1", "y"), null, true, null, false,
			new JsonObject(), 0, "k1"))));
		assertNotEquals(h, RegionKeys.hash(RegionKeys.realiseBody(new RealiseRequest("rp1", Mode.AUTO, null, Map.of("a_1", "x", "b_1", "y"), null, true, List.of("lots"),
			false, new JsonObject(), 0, "k1"))));
	}

	@Test
	void scopes() {
		assertNotEquals(RegionKeys.scope(null, "region.plan", "k"), RegionKeys.scope("steward", "region.plan", "k"), "the owner");
		assertNotEquals(RegionKeys.scope(null, "region.plan", "k"), RegionKeys.scope(null, "region.realise", "k"), "the kind");
	}

	@Test
	void planLotExtCopiesTheCallersKeysOnly() {
		JsonObject ir = JsonParser.parseString("""
			{"format": 1, "id": "flat_village", "kitVersion": "0.16.0", "seed": "7",
			 "claim": {"minX": 0, "minZ": 0, "maxX": 63, "maxZ": 63, "minY": -64, "maxY": 320},
			 "stages": ["lots"], "tiles": {},
			 "lots": [{"id": "a_1", "stage": "lots", "box": {"minX": 1, "minY": 64, "minZ": 1, "maxX": 9, "maxY": 80, "maxZ": 9}, "floorY": 64, "front": "south", "max": [9, 16, 9],
			   "ext": {"steward_mc:lot": "a_1", "steward_mc:build": {"id": "b7"}, "architect_mc:village": {"role": "dwelling"}, "architect_mc:lot": "forged"}},
			  {"id": "b_1", "stage": "lots", "box": {"minX": 11, "minY": 64, "minZ": 1, "maxX": 19, "maxY": 80, "maxZ": 9}, "floorY": 64, "front": "south", "max": [9, 16, 9]}],
			 "anchors": {}, "budget": {"cells": 1, "removed": 0, "added": 1}}
			""").getAsJsonObject();
		Ir i = Ir.of(ir);
		JsonObject a = RegionsImpl.planLotExt(i, "a_1");
		assertEquals(Set2.of("steward_mc:lot", "steward_mc:build"), a.keySet(), "Architect's keys stay on the LotSpec, not on the site");
		assertEquals("b7", a.getAsJsonObject("steward_mc:build").get("id").getAsString());
		// a copy
		a.getAsJsonObject("steward_mc:build").addProperty("id", "x");
		assertEquals("b7", RegionsImpl.planLotExt(i, "a_1").getAsJsonObject("steward_mc:build").get("id").getAsString());
		assertTrue(RegionsImpl.planLotExt(i, "b_1").keySet().isEmpty(), "a lot with no ext");
		assertTrue(RegionsImpl.planLotExt(i, "nope").keySet().isEmpty(), "an unknown lot");
	}

	/** java.util.Set.of with a stable comparison to a JsonObject.keySet(). */
	private static final class Set2 {
		static java.util.Set<String> of(String... k) {
			return new java.util.LinkedHashSet<>(List.of(k));
		}
	}

	@Test
	void regionRecKeepsItsKey() {
		RegionRec r = new RegionRec("rg7", "rp1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, -64, 0, 63, 320, 63}, 1L);
		assertNull(r.opKey);
		assertFalse(r.toJson().has("opKey"), "a region with no key writes none (older records read the same)");
		r.groupId = "g1";
		r.batchId = "b1";
		r.opKey = "steward.b7.vrealise";
		r.opHash = "abc";
		RegionRec back = RegionRec.fromJson(r.toJson());
		assertEquals("steward.b7.vrealise", back.opKey);
		assertEquals("abc", back.opHash);
		assertEquals("steward", back.owner);
	}
}
