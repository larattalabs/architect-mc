package dev.larattalabs.architect.design;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** Style unification U3: words alongside a picked Style go first in the notes, on their own line, and a remix reads them back. */
class StyleNoteTest {
	@Test
	void composeAndSplit() {
		assertEquals("rooms for two", StyleNote.compose("", "rooms for two"));
		assertEquals("rooms for two", StyleNote.compose(null, "rooms for two"));
		assertEquals("Style: mossy, lived-in", StyleNote.compose("  mossy, lived-in ", ""));
		assertEquals("Style: mossy lived-in\n\nrooms for two", StyleNote.compose("mossy\nlived-in", "rooms for two"));
		assertEquals(new StyleNote.Split("mossy lived-in", "rooms for two"), StyleNote.split("Style: mossy lived-in\n\nrooms for two"));
		assertEquals(new StyleNote.Split("mossy", ""), StyleNote.split("Style: mossy"));
		assertEquals(new StyleNote.Split("", "Stylish rooms"), StyleNote.split("Stylish rooms"));
		assertEquals(new StyleNote.Split("", ""), StyleNote.split(null));
		// a round trip keeps both
		String sent = StyleNote.compose("weathered", "a second floor\nand a porch");
		assertEquals(new StyleNote.Split("weathered", "a second floor\nand a porch"), StyleNote.split(sent));
	}
}
