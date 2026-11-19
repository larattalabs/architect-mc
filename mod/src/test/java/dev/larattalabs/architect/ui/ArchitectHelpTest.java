package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.client.help.ArchitectGlossary;
import dev.larattalabs.architect.client.help.ArchitectHelp;
import dev.larattalabs.labui.client.help.KeysOverlay;
import dev.larattalabs.labui.ui.HelpKeys;
import dev.larattalabs.labui.ui.WordingLint;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/** (PR W1) Every screen and HUD has one "what's this" line; its terms are in the glossary; the "?" overlay reads labels live. */
class ArchitectHelpTest {
	@Test
	void everyScreenAndHudHasATip() {
		List<String> ids = List.of("design", "library", "designs", "status", "styles", "style_editor", "add_parts", "describe_style", "crate", "redirect",
			"hud.placement", "hud.plot", "hud.site");
		assertEquals(ids, List.copyOf(ArchitectHelp.TIPS.keySet()));
		ArchitectHelp.TIPS.forEach((id, t) -> {
			assertTrue(HelpKeys.tipFits(t), id + " is longer than one line: " + t.length());
			assertTrue(WordingLint.breaks(t).isEmpty(), id);
		});
		assertEquals("architect_mc:library", ArchitectHelp.key("library"));
	}

	@Test
	void tipTermsAreGlossaryTerms() {
		ArchitectHelp.TERMS.forEach((id, terms) -> {
			assertFalse(terms.isEmpty(), id);
			for (String t : terms) {
				assertTrue(ArchitectGlossary.section().find(t) != null, id + ": " + t + " is not in the glossary");
			}
		});
	}

	@Test
	void theOverlayReadsLabelsLive() {
		AtomicReference<String> bound = new AtomicReference<>("R");
		KeysOverlay o = new KeysOverlay("Placing", () -> List.of(new HelpKeys.Row(bound.get(), "rotate")), List.of("ghost"));
		assertEquals("R", o.rows().get(0).key());
		bound.set("G"); // rebound in Controls
		assertEquals("G", o.rows().get(0).key(), "the overlay shows the new binding without a re-open");
		assertEquals("close this", o.rows().get(o.rows().size() - 1).verb());
	}
}
