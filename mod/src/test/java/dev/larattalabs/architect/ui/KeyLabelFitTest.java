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
	void hintsFitEachKeyToItsPairAndKeepTheVerbs() {
		String[] in = {"Mouse Button 4", "rotate", "Esc", "cancel"};
		// inner 200: both pairs fit alone, nothing cut
		assertArrayEquals(in, PlacingKeys.fitHints(in, 200, 4, W));
		// inner 80: the key's room is 80 - 4 (keycap pad) - 3 - 36 ("rotate") = 37 px, so "Mouse…" (36 px)
		String[] out = PlacingKeys.fitHints(in, 80, 4, W);
		assertEquals("Mouse" + PlacingKeys.ELLIPSIS, out[0]);
		assertEquals("rotate", out[1]);
		assertEquals("Esc", out[2]);
		assertEquals("cancel", out[3]);
		assertEquals("Mouse Button 4", in[0], "the input row is not changed");
	}
}
