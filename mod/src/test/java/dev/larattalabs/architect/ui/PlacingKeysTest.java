package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.client.hud.PlacingKeys;
import dev.larattalabs.architect.client.hud.PlacingKeys.Action;
import dev.larattalabs.architect.client.hud.PlacingKeys.Context;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** (PR A4) The rebindable placing, plot and massing keys: today's defaults, the Shift rule, Esc, rebinding, no clash within a context. */
class PlacingKeysTest {
	static final Map<Action, Integer> TODAY = Map.ofEntries(Map.entry(Action.CONFIRM, 257), Map.entry(Action.CANCEL, 259), Map.entry(Action.ROTATE,
		(int) 'R'), Map.entry(Action.REDIRECT, (int) 'R'), Map.entry(Action.FORWARD, 265), Map.entry(Action.BACK, 264), Map.entry(Action.LEFT_, 263),
		Map.entry(Action.RIGHT_, 262), Map.entry(Action.RAISE, 266), Map.entry(Action.LOWER, 267), Map.entry(Action.LOCK, (int) 'L'), Map.entry(Action.FIT,
			(int) 'F'), Map.entry(Action.LEGEND, (int) 'H'));

	@Test
	void defaultCodesAreTodaysKeys() {
		for (Action a : Action.values()) {
			assertEquals(TODAY.get(a), a.defaultKey, a.id);
		}
	}

	@Test
	void noClashWithinAContextAndNoneOfStewardsKeys() {
		for (Context c : Context.values()) {
			Set<Integer> seen = new HashSet<>();
			for (Action a : PlacingKeys.of(c)) {
				assertTrue(seen.add(a.defaultKey), c + ": " + a.id + " shares its default");
				assertFalse(dev.larattalabs.labui.ui.KeyDefaults.STEWARD_RESERVED.contains(a.defaultKey), a.id + " is one of Steward's Y/I/U");
			}
		}
	}

	@Test
	void eachContextResolvesTodaysKeys() {
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, 'R', false, PlacingKeys::defaults));
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, 'R', true, PlacingKeys::defaults), "Shift+R is rotate (back)");
		assertEquals(Action.REDIRECT, PlacingKeys.resolve(Context.MASSING, 'R', false, PlacingKeys::defaults));
		assertNull(PlacingKeys.resolve(Context.PLOT, 'R', false, PlacingKeys::defaults), "R is not a plot key: it passes to vanilla");
		assertEquals(Action.FIT, PlacingKeys.resolve(Context.PLOT, 'F', true, PlacingKeys::defaults));
		assertNull(PlacingKeys.resolve(Context.PLACE, 'F', false, PlacingKeys::defaults));
		assertEquals(Action.RAISE, PlacingKeys.resolve(Context.PLOT, 266, true, PlacingKeys::defaults));
		assertEquals(Action.LEGEND, PlacingKeys.resolve(Context.PLACE, 'H', false, PlacingKeys::defaults));
	}

	@Test
	void fixedKeys() {
		for (Context c : Context.values()) {
			assertEquals(Action.CANCEL, PlacingKeys.resolve(c, PlacingKeys.ESCAPE, false, a -> -1), c + ": Esc cancels whatever is bound");
			assertEquals(Action.CONFIRM, PlacingKeys.resolve(c, PlacingKeys.NUMPAD_ENTER, false, a -> -1));
		}
		assertEquals(Action.LEGEND, PlacingKeys.resolve(Context.PLACE, PlacingKeys.SLASH, true, PlacingKeys::defaults), "Shift+/ is ?");
		assertNull(PlacingKeys.resolve(Context.PLACE, PlacingKeys.SLASH, false, PlacingKeys::defaults), "plain / opens chat");
		assertEquals(Action.CANCEL, PlacingKeys.resolve(Context.MASSING, PlacingKeys.DELETE, false, PlacingKeys::defaults));
	}

	@Test
	void reboundKeysMoveAndTheOldKeyPasses() {
		Map<Action, Integer> b = new EnumMap<>(Action.class);
		for (Action a : Action.values()) {
			b.put(a, a.defaultKey);
		}
		b.put(Action.ROTATE, (int) 'G');
		b.put(Action.LOCK, -1); // unbound
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, 'G', false, b::get));
		assertNull(PlacingKeys.resolve(Context.PLACE, 'R', false, b::get), "R no longer rotates");
		assertNull(PlacingKeys.resolve(Context.PLACE, 'L', false, b::get), "an unbound lock never fires");
	}

	@Test
	void shiftStaysAFixedModifier() {
		assertEquals(Set.of(Action.ROTATE, Action.CONFIRM, Action.RAISE, Action.LOWER, Action.FIT), PlacingKeys.SHIFTED);
	}

	@Test
	void escIsNotConsumedWhenIdle() {
		assertFalse(PlacingKeys.listening(false, false, false, false), "not placing: Esc opens pause as before");
		assertFalse(PlacingKeys.listening(true, false, true, false), "a screen is open");
		assertFalse(PlacingKeys.listening(true, false, false, true), "an API preview has no keys");
		assertTrue(PlacingKeys.listening(true, false, false, false));
		assertTrue(PlacingKeys.listening(false, true, false, false));
	}

	@Test
	void everyActionHasALangName() throws Exception {
		String lang = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/assets/architect_mc/lang/en_us.json"));
		for (Action a : Action.values()) {
			assertTrue(lang.contains("\"" + a.translationKey() + "\""), a.id);
		}
		assertTrue(lang.contains("key.category.architect_mc.architect_placing"));
		assertEquals(13, List.of(Action.values()).size());
	}
}
