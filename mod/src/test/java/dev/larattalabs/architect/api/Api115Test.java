package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.BitSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * API 1.15.0 (docs/CONTRACT.md phase 6c slice W §1): {@code Sample} gains a trailing {@code BitSet frozen} (the older
 * constructors give an empty set; {@code water} is unchanged), the feature {@code frozenWater} is always there and
 * {@code apronLights} comes with a W helper ({@code region.lightCover}).
 */
class Api115Test {
	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 15, ArchitectApi.VERSION); // later slices append (6c SCH: 1.20.0)
	}

	@Test
	void sampleFrozen() {
		int[] h = {64, 65};
		BitSet water = new BitSet();
		water.set(1);
		Sample s112 = new Sample(0, 0, 1, 0, 1, 2, 1, h, h, new int[2], List.of("minecraft:ice"), new int[2], water, new BitSet(), new BitSet(), new BitSet(),
			1, 1, new int[1], List.of(), List.of(), 1, h);
		assertTrue(s112.frozen().isEmpty(), "the 1.12.0 (1.14.0) constructor: no frozen columns");
		Sample s10 = new Sample(0, 0, 1, 0, 1, 2, 1, h, h, new int[2], List.of("minecraft:ice"), new int[2], water, new BitSet(), new BitSet(), new BitSet(),
			1, 1, new int[1], List.of(), List.of(), 1);
		assertTrue(s10.frozen().isEmpty(), "the 1.0 constructor: no frozen columns");
		BitSet frozen = new BitSet();
		frozen.set(0);
		Sample s = new Sample(0, 0, 1, 0, 1, 2, 1, h, h, new int[2], List.of("minecraft:ice"), new int[2], water, new BitSet(), new BitSet(), new BitSet(),
			1, 1, new int[1], List.of(), List.of(), 1, h, frozen);
		assertTrue(s.frozen().get(0));
		assertFalse(s.water().get(0), "water stays the top fluid only");
		assertTrue(s.toJson().has("frozen"));
		assertFalse(s112.toJson().has("frozen"), "a sample without frozen columns has the 1.13.0 JSON");
	}

	@Test
	void features() {
		Set<String> w = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut", "region.lightCover"));
		assertTrue(w.contains("apronLights"));
		assertTrue(w.contains("frozenWater"));
		Set<String> v = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut"));
		assertFalse(v.contains("apronLights"), "a V helper doesn't light aprons");
		assertTrue(ApiRules.features(1, List.of()).contains("frozenWater"), "the mod's own survey: always");
	}
}
