package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Anchors;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P1-7; row T4RDF-paid-cascade) A paid road layered over a site and removed by that site's CASCADE is a paid member
 * of the site's owner record, as its standalone removal is: its stash (its refunds, priced per cell, settled after its W) is on the record,
 * so recovery pays it. Red before the fix: every road or cell member was recorded unpaid with no settle, and the cascade never planned its
 * refunds (RoadBuilder.beforeRemove was never called on that path).
 */
class T4RDFixPaidCascadeTest {
	static final String DIM = "minecraft:overworld";

	@AfterEach
	void reset() throws Exception {
		Field f = Infras.class.getDeclaredField("byId");
		f.setAccessible(true);
		f.set(null, Map.of());
		OwnerRemovals.read(null, null);
	}

	@Test
	void aPaidRoadInACascadeIsAPaidMember() throws Exception {
		System.out.println("ROW T4RDF-paid-cascade (unit)");
		Infra paid = new Infra("roadPaid", "road", "sameOwner", new JsonObject(), DIM, new Anchors.Bounds(0, 65, 0, 2, 65, 2), 3, null, false, new JsonObject(),
			new Construction(Construction.BUILT, new int[] {0}, "journal", null, new BitSet(), false, "sameOwner"));
		Field f = Infras.class.getDeclaredField("byId");
		f.setAccessible(true);
		f.set(null, Map.of("roadPaid", paid));
		// the road's stash as RoadBuilder plans it (a crate-fed road's refunds, its cells for the W's min)
		JsonObject stash = JsonParser.parseString("{\"key\":\"crate-refund:road:roadPaid@3\",\"dim\":\"minecraft:overworld\",\"pos\":" + net.minecraft.core.BlockPos
			.asLong(1, 66, 1) + ",\"recipient\":\"sameOwner\",\"site\":\"roadPaid\",\"refund\":{\"minecraft:cobblestone\":3},\"cells\":[{\"pos\":"
			+ net.minecraft.core.BlockPos.asLong(0, 65, 0) + ",\"block\":\"minecraft:cobblestone\",\"items\":{\"minecraft:cobblestone\":3}}],"
			+ "\"box\":[0,65,0,2,65,2],\"undoGroup\":\"u:base\"}").getAsJsonObject();
		Map<String, JsonObject> stashes = new java.util.HashMap<>();
		stashes.put("roadPaid", stash);
		JsonObject rec = OwnerRemovals.build("base", "u:base", DIM, null, "base", List.of("roadPaid"), List.of(), Map.of(), stashes, Map.of());
		JsonObject m = rec.getAsJsonObject("members").getAsJsonObject("roadPaid");
		System.out.println("ROW T4RDF-paid-cascade: member " + m);
		assertTrue(m.get("paid").getAsBoolean(), "T4RDF-paid-cascade: the paid road in the cascade is a paid member");
		assertNotNull(m.get("settle"), "T4RDF-paid-cascade: its stash is on the owner record (its refunds settle in the owner txn)");
		assertTrue(OwnerRemovals.needed(stashes, Map.of()), "a paid road alone needs an owner record");
		String src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Sites.java"));
		int rd = src.indexOf("public static Removed removeDetailed(ServerLevel level, String id, boolean force, Covered covered, @Nullable String tagOwner)");
		int build = src.indexOf("OwnerRemovals.build(", rd);
		int plan = src.indexOf("RoadBuilder.plan(level, ci)", rd);
		assertTrue(plan > 0 && plan < build, "T4RDF-paid-cascade: the cascade plans each paid road's refunds before the owner record is built");
	}
}
