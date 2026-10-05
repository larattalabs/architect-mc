package dev.larattalabs.architect.client.design;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.placement.CompositePreview;
import java.util.Locale;
import net.minecraft.client.Minecraft;
import net.minecraft.client.input.KeyEvent;

/**
 * DevBridge hooks for the phase 4c UI (docs/DEVBRIDGE.md "Massings (phase 4c)"): the massing review bar and its keys, the
 * Redirect… dialog, a set's massings in a row. Client thread.
 */
final class MassingDev {
	private MassingDev() {
	}

	private static JsonObject state() {
		JsonObject o = MassingReview.stateJson();
		o.add("composite", CompositePreview.stateJson());
		Minecraft mc = Minecraft.getInstance();
		o.addProperty("screen", mc.gui.screen() == null ? null : mc.gui.screen().getClass().getSimpleName());
		if (mc.gui.screen() instanceof RedirectScreen r) {
			o.addProperty("redirectNotes", r.notes.value());
		}
		return o;
	}

	static void register() {
		DevBridge.register("dev.massing.state", 10_000, "{} - the massing review (massing, version, origin, on a plot), the massing jobs it waits for, "
			+ "the set shown in a row (group, items left to right), the status line, the bar's rect, the open dialog, and dev.composite.state",
			(req, mc) -> DevBridge.onClient(mc, MassingDev::state));
		DevBridge.register("dev.massing.review", 10_000, "{massing} - Review massing: its latest version as a massing ghost (on its plot, else in front "
			+ "of the player) with the Approve / Redirect… / Cancel bar", (req, mc) -> {
				String id = Fields.of(req).nonBlank("massing");
				return DevBridge.onClient(mc, () -> {
					String why = MassingReview.open(id);
					if (why != null) {
						throw new DevBridge.DevException(why);
					}
					return state();
				});
			});
		DevBridge.register("dev.massing.key", 10_000, "{key: enter|r|backspace|escape} - press a review-bar key through the same path as the keyboard "
			+ "(no screen open): Enter approves, R opens Redirect…, Backspace/Esc cancels -> {consumed} + the state", (req, mc) -> {
				String k = Fields.of(req).nonBlank("key").toLowerCase(Locale.ROOT);
				int code = switch (k) {
					case "enter", "return" -> InputConstants.KEY_RETURN;
					case "r" -> InputConstants.KEY_R;
					case "backspace" -> InputConstants.KEY_BACKSPACE;
					case "escape", "esc" -> InputConstants.KEY_ESCAPE;
					default -> throw new DevBridge.DevException("unknown review key " + k);
				};
				return DevBridge.onClient(mc, () -> {
					boolean consumed = MassingReview.onKey(InputConstants.PRESS, new KeyEvent(code, 0, 0));
					JsonObject o = state();
					o.addProperty("consumed", consumed);
					return o;
				});
			});
		DevBridge.register("dev.massing.redirect", 10_000, "{notes, submit?: true} - in the open Redirect… dialog: type the notes and press Redirect "
			+ "(massing.redirect) -> the state", (req, mc) -> {
				Fields f = Fields.of(req);
				String notes = f.nonBlank("notes");
				boolean submit = !f.has("submit") || f.bool("submit");
				return DevBridge.onClient(mc, () -> {
					if (!(mc.gui.screen() instanceof RedirectScreen r)) {
						throw new DevBridge.DevException("the Redirect… dialog is not open (dev.massing.key {key: r})");
					}
					r.typeNotes(notes);
					if (submit && !r.submit()) {
						throw new DevBridge.DevException("the dialog refused the notes");
					}
					return state();
				});
			});
		DevBridge.register("dev.massing.showSet", 10_000, "{group} - Show massings: a set's massings in a row in front of the player", (req, mc) -> {
			String g = Fields.of(req).nonBlank("group");
			return DevBridge.onClient(mc, () -> {
				String why = MassingReview.showSet(g);
				if (why != null) {
					throw new DevBridge.DevException(why);
				}
				return state();
			});
		});
		DevBridge.register("dev.massing.hideSet", 10_000, "{} - hide the set shown in a row", (req, mc) -> DevBridge.onClient(mc, () -> {
			MassingReview.hideSet();
			return state();
		}));
	}
}
