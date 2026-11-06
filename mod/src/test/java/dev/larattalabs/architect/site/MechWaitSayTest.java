package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.region.Ir;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (WE, docs/CONTRACT.md "Slice WE"; Steward's ask on 0.53.0) A gate mechanism's waits say their own subject ("Main gatehouse's
 * portcullis waits for Main gatehouse to be built"), and its move to the bill wait (both SITE_BUSY) is announced once as ITEM_WAITING with a
 * sentence naming the missing items, never again on a poll.
 */
class MechWaitSayTest {
	@org.junit.jupiter.api.BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	private static final String IR = """
		{"format":2,"id":"t","kitVersion":"0","seed":"1","claim":{"minX":0,"minY":-64,"minZ":0,"maxX":255,"maxY":319,"maxZ":255},
		 "stages":["walls"],"tiles":{},"parts":[]}
		""";
	private static final String BODY = """
		{"plan":{"schemaVersion":"plan/0","planId":"p","zones":[],
		  "connectors":[{"id":"main_gate","kind":"gate","label":"Main gatehouse"},{"id":"north_gate","kind":"gate","label":"North gate"}]}}
		""";

	@Test
	void theFirstWaitNamesTheMechanismAndWhatItWaitsFor() {
		Ir ir = Ir.of(JsonParser.parseString(IR).getAsJsonObject());
		JsonObject body = JsonParser.parseString(BODY).getAsJsonObject();
		String portcullis = MechCharges.subject(RegionWaitTags.wordsOf(ir, body, "main_gate"), "portcullis");
		assertEquals("Main gatehouse's portcullis waits for Main gatehouse to be built", RegionWaitTags.sayWithOf(ir, body, portcullis, "lot main_gate"));
		// a K1 swing gate (its id, no lot)
		assertEquals("North gate's swing gate waits for Main gatehouse to be built", RegionWaitTags.sayWithOf(ir, body, MechCharges.subject("North gate", "swing"),
			"main_gate"));
		assertEquals("Main gatehouse's sliding gate", MechCharges.subject("Main gatehouse", "slide"));
		// (GM-c) a drawbridge's circuit: its connector's words, then the kind; (GMc-2) words already ending in the kind's are not doubled
		assertEquals("Redstone drawbridge waits for the drawbridge to be built", RegionWaitTags.sayWithOf(null, null, MechCharges.subject(
			"Redstone drawbridge", "drawbridge"), "the drawbridge"));
		assertEquals("Redstone drawbridge", MechCharges.subject("Redstone drawbridge", "drawbridge"));
		assertEquals("Drawbridge", MechCharges.subject("Drawbridge", "drawbridge"));
		assertEquals("East Drawbridge", MechCharges.subject("East Drawbridge", "drawbridge"));
		assertEquals("Moat bridge's drawbridge", MechCharges.subject("Moat bridge", "drawbridge"));
		assertEquals("Underdrawbridge's drawbridge", MechCharges.subject("Underdrawbridge", "drawbridge"), "a word boundary, not a suffix");
		assertEquals("Main portcullis", MechCharges.subject("Main portcullis", "portcullis"));
		assertEquals("North swing gate", MechCharges.subject("North swing gate", "swing"));
		// the other kinds keep their wording: "gate" is not "swing gate"
		assertEquals("North gate's swing gate", MechCharges.subject("North gate", "swing"));
		assertEquals("Main gatehouse's portcullis", MechCharges.subject("Main gatehouse", "portcullis"));
		assertEquals("Main gatehouse's gate mechanism", MechCharges.subject("Main gatehouse", null));
		// no plan label: the id with spaces
		assertEquals("Gate 2's portcullis waits for gate 2 to be built", RegionWaitTags.sayWithOf(null, null, "gate 2's portcullis", "gate_2"));
	}

	@Test
	void theBillWaitNamesTheMissingItems() {
		java.util.function.Function<String, String> names = id -> id.replace("minecraft:", "").replace('_', ' ');
		String subject = MechCharges.subject("Main gatehouse", "portcullis");
		assertEquals("Main gatehouse's portcullis waits for 1 × comparator and 3 × observer in the stockpile", MechCharges.billSay(subject, Map.of(
			"minecraft:observer", 3, "minecraft:comparator", 1), names));
		assertEquals("Main gatehouse's portcullis waits for 2 × piston, 1 × redstone dust and 6 × slime ball in the stockpile", MechCharges.billSay(
			subject, Map.of("minecraft:piston", 2, "minecraft:redstone_dust", 1, "minecraft:slime_ball", 6), names));
		assertEquals("Main gatehouse's portcullis waits for 4 × iron bars in the stockpile", MechCharges.billSay(subject, Map.of("minecraft:iron_bars", 4),
			names));
		// (GM-c) the drawbridge's bill wait names the drawbridge like the other kinds, (GMc-2) its noun once
		assertEquals("Redstone drawbridge waits for 2 × lever and 14 × repeater in the stockpile", MechCharges.billSay(MechCharges.subject(
			"Redstone drawbridge", "drawbridge"), Map.of("minecraft:repeater", 14, "minecraft:lever", 2), names));
	}

	@Test
	void theMoveToTheBillWaitIsAnnouncedOnceNotOnEveryPoll() {
		QItem i = new QItem("mech:main_gate", "walls", List.of(), "cells", "minecraft:overworld", 0, 64, 0, 0, false, new JsonObject(), null, false, false);
		assertTrue(MechCharges.billWaitMoved(i), "the move itself");
		for (int k = 0; k < 5; k++) {
			assertFalse(MechCharges.billWaitMoved(i), "poll " + k);
		}
	}
}
