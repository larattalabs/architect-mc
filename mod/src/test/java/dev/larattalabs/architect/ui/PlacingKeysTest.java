package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mojang.blaze3d.platform.InputConstants;
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
	static final Map<Action, Integer> TODAY = Map.ofEntries(Map.entry(Action.CONFIRM, InputConstants.KEY_RETURN), Map.entry(Action.CANCEL,
		InputConstants.KEY_BACKSPACE), Map.entry(Action.ROTATE, InputConstants.KEY_R), Map.entry(Action.REDIRECT, InputConstants.KEY_R), Map.entry(Action.FORWARD,
			InputConstants.KEY_UP), Map.entry(Action.BACK, InputConstants.KEY_DOWN), Map.entry(Action.LEFT_, InputConstants.KEY_LEFT), Map.entry(Action.RIGHT_,
				InputConstants.KEY_RIGHT), Map.entry(Action.RAISE, InputConstants.KEY_PAGEUP), Map.entry(Action.LOWER, InputConstants.KEY_PAGEDOWN), Map.entry(
					Action.LOCK, InputConstants.KEY_L), Map.entry(Action.FIT, InputConstants.KEY_F), Map.entry(Action.LEGEND, InputConstants.KEY_H));

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
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_R, false, PlacingKeys::defaults));
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_R, true, PlacingKeys::defaults), "Shift+R is rotate (back)");
		assertEquals(Action.REDIRECT, PlacingKeys.resolve(Context.MASSING, InputConstants.KEY_R, false, PlacingKeys::defaults));
		assertNull(PlacingKeys.resolve(Context.PLOT, InputConstants.KEY_R, false, PlacingKeys::defaults), "R is not a plot key: it passes to vanilla");
		assertEquals(Action.FIT, PlacingKeys.resolve(Context.PLOT, InputConstants.KEY_F, true, PlacingKeys::defaults));
		assertNull(PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_F, false, PlacingKeys::defaults));
		assertEquals(Action.RAISE, PlacingKeys.resolve(Context.PLOT, InputConstants.KEY_PAGEUP, true, PlacingKeys::defaults));
		assertEquals(Action.LEGEND, PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_H, false, PlacingKeys::defaults));
	}

	@Test
	void theFixedCodesAre26point3InputConstants() {
		assertEquals(InputConstants.KEY_ESCAPE, PlacingKeys.ESCAPE);
		assertEquals(InputConstants.KEY_NUMPADENTER, PlacingKeys.NUMPAD_ENTER);
		assertEquals(InputConstants.KEY_DELETE, PlacingKeys.DELETE);
		assertEquals(InputConstants.KEY_SLASH, PlacingKeys.SLASH);
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
		b.put(Action.ROTATE, InputConstants.KEY_G);
		b.put(Action.LOCK, -1); // unbound
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_G, false, b::get));
		assertNull(PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_R, false, b::get), "R no longer rotates");
		assertNull(PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_L, false, b::get), "an unbound lock never fires");
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

	/** (PR2) A mouse-button binding is routed: Rotate on Mouse 4 rotates on that button, and never on the key whose scancode is 3. */
	@Test
	void mouseButtonBindingsResolveInTheirOwnCodeSpace() {
		int mouse4 = PlacingKeys.code(false, true, 3); // GLFW button 3 is Mouse 4
		assertEquals(PlacingKeys.mouse(3), mouse4);
		Map<Action, Integer> b = new EnumMap<>(Action.class);
		for (Action a : Action.values()) {
			b.put(a, a.defaultKey);
		}
		b.put(Action.ROTATE, mouse4);
		b.put(Action.CONFIRM, PlacingKeys.code(false, true, 4)); // Mouse 5
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, PlacingKeys.mouse(3), false, b::get));
		assertEquals(Action.ROTATE, PlacingKeys.resolve(Context.PLACE, PlacingKeys.mouse(3), true, b::get), "Shift+Mouse 4 rotates back");
		assertNull(PlacingKeys.resolve(Context.PLACE, 3, false, b::get), "a key with the button's number is not the button");
		assertNull(PlacingKeys.resolve(Context.PLACE, InputConstants.KEY_R, false, b::get), "R no longer rotates");
		assertEquals(Action.CONFIRM, PlacingKeys.resolve(Context.PLOT, PlacingKeys.mouse(4), false, b::get), "the plot hears it too");
		assertEquals(Action.CONFIRM, PlacingKeys.resolve(Context.MASSING, PlacingKeys.mouse(4), false, b::get), "and the massing bar");
		assertNull(PlacingKeys.resolve(Context.PLACE, PlacingKeys.mouse(0), false, b::get), "an unbound left click passes to vanilla");
		assertNull(PlacingKeys.resolve(Context.PLACE, PlacingKeys.mouse(1), false, PlacingKeys::defaults), "defaults bind no button");
	}

	/** (PR2) What a binding's type and value become: keys keep their code, buttons move up, anything else never matches. */
	@Test
	void bindingCodes() {
		assertEquals(InputConstants.KEY_R, PlacingKeys.code(true, false, InputConstants.KEY_R));
		assertEquals(PlacingKeys.MOUSE + 2, PlacingKeys.code(false, true, 2));
		assertEquals(-1, PlacingKeys.code(false, false, 30), "a scancode-only binding");
		assertEquals(-1, PlacingKeys.code(true, false, -1), "unbound");
		for (Action a : Action.values()) {
			assertTrue(a.defaultKey < PlacingKeys.MOUSE, a.id + ": keyboard codes stay below the mouse space");
		}
	}
}
