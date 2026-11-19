package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.hud.PlacingKeys;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/** (PR3) Keycap labels: the full name, cut only by measured width with an ellipsis (not at 9 characters). */
class KeyLabelFitTest {
	/** A fake font: 6 px a character. */
	static final ToIntFunction<String> W = s -> 6 * s.codePointCount(0, s.length());

	@Test
	void readableKeepsLongNamesWhole() {
		assertEquals("Mouse Button 4", Keys.readable("Mouse Button 4"));
		assertEquals("Mouse Button 4", PlacingKeys.readable("Mouse Button 4"));
		assertEquals("Backtick", Keys.readable("`"));
		assertEquals("Semicolon", PlacingKeys.readable(";"));
	}

	@Test
	void aLabelThatFitsIsUnchanged() {
		assertEquals("Mouse Button 4", PlacingKeys.fit("Mouse Button 4", 14 * 6, W));
		assertEquals("R", PlacingKeys.fit("R", 6, W));
	}

	@Test
	void aWideLabelIsCutByWidthWithAnEllipsis() {
		String f = PlacingKeys.fit("Mouse Button 4", 60, W);
		assertTrue(W.applyAsInt(f) <= 60, f);
		assertTrue(f.endsWith(PlacingKeys.ELLIPSIS), f);
		assertEquals("Mouse But" + PlacingKeys.ELLIPSIS, f); // the longest prefix that fits: 9 + 1 characters at 6 px
		// trailing spaces before the ellipsis are dropped
		assertEquals("Mouse" + PlacingKeys.ELLIPSIS, PlacingKeys.fit("Mouse Button 4", 42, W));
		// by measured width, not a character count: a wider font cuts sooner
		assertEquals("Mous" + PlacingKeys.ELLIPSIS, PlacingKeys.fit("Mouse Button 4", 60, s -> 12 * s.length()));
	}

	@Test
	void aKeycapNeverLooksEmpty() {
		assertEquals("M", PlacingKeys.fit("Mouse Button 4", 6, W));
		assertEquals("M", PlacingKeys.fit("Mouse Button 4", 0, W));
		assertFalse(PlacingKeys.fit("Mouse Button 4", -5, W).isEmpty());
		assertEquals("", PlacingKeys.fit("", 10, W));
	}

	@Test
	void hintsFitEachKeyToTheRowAndKeepTheVerbs() {
		String[] in = {"Mouse Button 4", "rotate", "Esc", "cancel"};
		// inner 200: the row (188 px) fits, nothing cut
		assertArrayEquals(in, PlacingKeys.fitHints(in, 200, 4, W));
		// inner 140: the Esc pair (61 px) and the gap leave the mouse pair 70 px: its key 70 - 4 - 3 - 36 = 27 px, so "Mou…" (24 px)
		String[] out = PlacingKeys.fitHints(in, 140, 4, W);
		assertEquals("Mou" + PlacingKeys.ELLIPSIS, out[0]);
		assertEquals("rotate", out[1]);
		assertEquals("Esc", out[2]);
		assertEquals("cancel", out[3]);
		assertEquals("Mouse Button 4", in[0], "the input row is not changed");
	}

	/** lab-ui UiBits.hintsWidth with the fake font: keycap max(12, label + pad), 3 px, verb, 9 px between pairs. */
	static int rowWidth(String[] kv, int capPad) {
		int w = 0;
		for (int i = 0; i + 1 < kv.length; i += 2) {
			w += Math.max(12, W.applyAsInt(kv[i]) + capPad) + 3 + W.applyAsInt(kv[i + 1]) + 9;
		}
		return Math.max(0, w - 9);
	}

	@Test
	void aRowOfLongBindingsIsBudgetedAsAWhole() {
		// (v0.84 review P2) each pair fits 240 alone, but the row (399 px) did not: the HUD dropped it or drew past the panel
		String[] in = {"Mouse Button 4", "confirm", "Mouse Button 5", "re-mark", "Mouse Button 6", "back"};
		assertTrue(rowWidth(in, 4) > 240);
		String[] out = PlacingKeys.fitHints(in, 240, 4, W);
		assertTrue(rowWidth(out, 4) <= 240, "the whole row fits: " + rowWidth(out, 4) + " " + String.join("|", out));
		for (int i = 1; i < in.length; i += 2) {
			assertEquals(in[i], out[i], "every verb kept");
			assertFalse(out[i - 1].isEmpty(), "no empty keycap");
		}
	}

	@Test
	void theLongestKeyIsCutFirst() {
		String[] in = {"Mouse Button 4", "rotate", "Esc", "cancel"};
		// row 188 px; at 160 only the mouse label is cut, Esc stays whole
		String[] out = PlacingKeys.fitHints(in, 160, 4, W);
		assertTrue(rowWidth(out, 4) <= 160, String.join("|", out));
		assertTrue(out[0].endsWith(PlacingKeys.ELLIPSIS), out[0]);
		assertEquals("Esc", out[2]);
	}

	@Test
	void aWrappingListStillFitsEachPairAlone() {
		String[] in = {"Mouse Button 4", "rotate", "Esc", "cancel"};
		String[] out = PlacingKeys.fitEachPair(in, 80, 4, W);
		assertEquals("Mouse" + PlacingKeys.ELLIPSIS, out[0]); // 80 - 4 - 3 - 36 ("rotate") = 37 px
		assertEquals("Esc", out[2]);
		assertArrayEquals(in, PlacingKeys.fitEachPair(in, 200, 4, W));
	}
}
