package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** UI-2b: "did you mean" for an unknown design id. */
class DidYouMeanTest {
	static final List<String> IDS = List.of("cabin", "cabin_dark", "log_cabin", "tower_stone", "farmhouse", "gen_a1b2_market_hall", "well");

	@Test
	void typosFindTheClosestIds() {
		assertEquals("cabin", DidYouMean.suggest("cabn", IDS, 5).get(0), "a dropped letter");
		assertEquals("cabin", DidYouMean.suggest("cbain", IDS, 5).get(0), "two letters swapped");
		assertEquals(List.of("tower_stone"), DidYouMean.suggest("towr_stone", IDS, 5));
		assertTrue(DidYouMean.suggest("farmhuose", IDS, 5).contains("farmhouse"));
	}

	@Test
	void prefixesAndWordsMatchBeforeTypos() {
		List<String> s = DidYouMean.suggest("cab", IDS, 5);
		assertEquals(List.of("cabin", "cabin_dark", "log_cabin"), s, "TextMatch: a whole-label prefix first, then a word prefix");
		assertEquals(List.of("gen_a1b2_market_hall"), DidYouMean.suggest("market", IDS, 5), "a word of a generated id");
		assertEquals(List.of("gen_a1b2_market_hall"), DidYouMean.suggest("market-hall", IDS, 5), "separators count as spaces");
	}

	@Test
	void farOffInputsAndEmptyLibrariesSuggestNothing() {
		assertEquals(List.of(), DidYouMean.suggest("zzzzzz", IDS, 5));
		assertEquals(List.of(), DidYouMean.suggest("cabin", List.of(), 5));
		assertEquals(List.of(), DidYouMean.suggest("", IDS, 5));
		assertEquals(List.of(), DidYouMean.suggest("wel", List.of("tower_stone"), 5), "a short input allows one edit only");
	}

	@Test
	void atMostFive() {
		List<String> many = new ArrayList<>();
		for (int i = 0; i < 40; i++) {
			many.add("house_" + i);
		}
		assertEquals(5, DidYouMean.suggest("house", many, DidYouMean.MAX).size());
		assertEquals(List.of("house_0", "house_1", "house_2", "house_3", "house_4"), DidYouMean.suggest("house", many, DidYouMean.MAX), "ties keep the order");
	}

	@Test
	void theMessageIsShortAndNeverListsTheLibrary() {
		List<String> many = new ArrayList<>(IDS);
		for (int i = 0; i < 200; i++) {
			many.add("generated_design_number_" + i);
		}
		String m = DidYouMean.message("cabn", many);
		assertEquals("Unknown design 'cabn'. Did you mean cabin, cabin_dark, log_cabin? See /architect list", m);
		assertEquals("Unknown design 'qqq'. See /architect list", DidYouMean.message("qqq", many));
	}

	@Test
	void distanceCountsASwapAsOneEdit() {
		assertEquals(1, DidYouMean.distance("ab", "ba"));
		assertEquals(0, DidYouMean.distance("abc", "abc"));
		assertEquals(3, DidYouMean.distance("", "abc"));
	}
}
