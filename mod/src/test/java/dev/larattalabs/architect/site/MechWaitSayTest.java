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
import java.util.Objects;
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

	private static final String WALL_BODY = """
		{"plan":{"schemaVersion":"plan/0","planId":"p","zones":[],
		  "connectors":[{"id":"curtain","kind":"wall","label":"Curtain wall"},{"id":"bare","kind":"wall"},{"id":"north_gate","kind":"gate","label":"North gate"}]}}
		""";

	/** (NM) A wall's own unnamed gates say their place in the wall's gate order; named gates and gatehouses keep their names. */
	@Test
	void anAutoGateIsNamedFromItsWall() {
		Ir ir = Ir.of(JsonParser.parseString(IR).getAsJsonObject());
		JsonObject body = JsonParser.parseString(WALL_BODY).getAsJsonObject();
		// a wall with 3 auto gates: first, second, third
		assertEquals("Curtain wall's first gate", RegionWaitTags.capital(RegionWaitTags.wordsOf(ir, body, "curtain_g1")));
		assertEquals("Curtain wall's second gate", RegionWaitTags.capital(RegionWaitTags.wordsOf(ir, body, "curtain_g2")));
		assertEquals("Curtain wall's third gate", RegionWaitTags.capital(RegionWaitTags.wordsOf(ir, body, "curtain_g3")));
		assertEquals("Curtain wall's 11th gate", RegionWaitTags.wordsOf(ir, body, "curtain_g11"));
		// the mechanism subject (the swing's kind words in the noun, never "...gate's swing gate")
		String swing = RegionWaitTags.autoGateWords(ir, body, "curtain_g1", "swing gate");
		assertEquals("Curtain wall's first swing gate", RegionWaitTags.capital(Objects.requireNonNull(swing)));
		assertEquals("Curtain wall's first swing gate waits for 2 \u00d7 iron door in the stockpile", MechCharges.billSay(swing, Map.of(
			"minecraft:iron_door", 2), id -> id.replace("minecraft:", "").replace('_', ' ')));
		assertEquals("Curtain wall's second swing gate waits for the wall to be built", RegionWaitTags.sayWithOf(ir, body, "curtain wall's second swing gate", "the wall"));
		// a wall without a label reads "the wall"
		assertEquals("the wall's first gate", RegionWaitTags.wordsOf(ir, body, "bare_g1"));
		// named gates keep their names; a gate id whose wall is no plan part keeps its words
		assertEquals("North gate", RegionWaitTags.wordsOf(ir, body, "north_gate"));
		assertEquals("North gate's swing gate", MechCharges.subject(RegionWaitTags.wordsOf(ir, body, "north_gate"), "swing"));
		assertEquals("curtain g1", RegionWaitTags.wordsOf(null, null, "curtain_g1"));
		assertEquals("other g1", RegionWaitTags.wordsOf(ir, body, "other_g1"));
		// a plan part named like an auto gate keeps its own label
		JsonObject named = JsonParser.parseString("{\"plan\":{\"connectors\":[{\"id\":\"curtain\",\"kind\":\"wall\"},{\"id\":\"curtain_g1\",\"kind\":\"gate\",\"label\":\"Postern\"}]}}")
			.getAsJsonObject();
		assertEquals("Postern", RegionWaitTags.wordsOf(ir, named, "curtain_g1"));
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
