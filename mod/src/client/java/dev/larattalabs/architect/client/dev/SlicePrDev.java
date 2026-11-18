package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.help.ArchitectHelp;
import dev.larattalabs.labui.client.prefs.LabUiPrefs;
import dev.larattalabs.labui.ui.GhostPalette;

/** (PR) The player-ready pass's dev hooks: the ghost palette, the "what's this" lines, the text size (shots and tests). */
public final class SlicePrDev {
	private SlicePrDev() {
	}

	public static void init() {
		DevBridge.register("dev.pr.palette", 10_000, "{palette?: standard|okabe_ito} - (PR A2) the ghost palette, as Status sets it -> {palette}",
			(req, mc) -> {
				String p = Fields.of(req).optStr("palette", null);
				return DevBridge.onClient(mc, () -> {
					if (p != null) {
						LabUiPrefs.setGhostPalette(GhostPalette.Palette.of(p));
					}
					JsonObject o = new JsonObject();
					o.addProperty("palette", GhostPalette.current().id());
					return o;
				});
			});
		DevBridge.register("dev.pr.tips", 10_000, "{reset?: bool, hide?: <screen id>} - (PR W1) the what's-this lines: show all again or hide one "
			+ "-> {hidden: n}", (req, mc) -> {
				Fields f = Fields.of(req);
				boolean reset = f.optBool("reset", false);
				String hide = f.optStr("hide", null);
				return DevBridge.onClient(mc, () -> {
					if (reset) {
						ArchitectHelp.showTipsAgain();
					}
					if (hide != null) {
						if (!ArchitectHelp.TIPS.containsKey(hide)) {
							throw new DevBridge.DevException("no tip " + hide + "; known: " + ArchitectHelp.TIPS.keySet());
						}
						ArchitectHelp.tip(hide).hide();
					}
					JsonObject o = new JsonObject();
					o.addProperty("hidden", dev.larattalabs.architect.client.design.UiPrefs.tipsHiddenCount());
					return o;
				});
			});
		DevBridge.register("dev.pr.textScale", 10_000, "{percent?: 100|125|150} - (PR A3) the text size, as Status sets it -> {percent, applied, "
			+ "dropped} (applied: on the open screen)", (req, mc) -> {
				Integer p = Fields.of(req).has("percent") ? Fields.of(req).optInt("percent", 100, 0, 1000) : null;
				return DevBridge.onClient(mc, () -> {
					if (p != null) {
						dev.larattalabs.labui.client.prefs.TextScaleHost.set(p);
					}
					JsonObject o = new JsonObject();
					o.addProperty("percent", dev.larattalabs.labui.ui.TextScale.preference());
					if (mc.gui.screen() != null) {
						var r = dev.larattalabs.labui.client.prefs.TextScaleHost.result(mc.gui.screen(), "architect_mc");
						o.addProperty("applied", r.percent());
						o.addProperty("dropped", r.dropped());
					}
					return o;
				});
			});
		DevBridge.register("dev.pr.keys", 10_000, "{press?: bool} - (PR W1) the open screen's ? overlay: press F1 on the screen -> {screen, handled, "
			+ "toggles}", (req, mc) -> {
				boolean press = Fields.of(req).optBool("press", false);
				return DevBridge.onClient(mc, () -> {
					JsonObject o = new JsonObject();
					var s = mc.gui.screen();
					o.addProperty("screen", s == null ? null : s.getClass().getName());
					o.addProperty("toggles", dev.larattalabs.labui.ui.HelpKeys.toggles(com.mojang.blaze3d.platform.InputConstants.KEY_F1, false, false));
					if (press && s != null) {
						o.addProperty("handled", s.keyPressed(new net.minecraft.client.input.KeyEvent(com.mojang.blaze3d.platform.InputConstants.KEY_F1, 0, 0)));
					}
					return o;
				});
			});
		DevBridge.register("dev.pr.rebind", 10_000, "{action: <PlacingKeys id>, key?: <GLFW code> (absent: the default)} - (PR A4) rebind a placing key "
			+ "as Controls does -> {action, label}", (req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("action");
				Integer code = f.has("key") ? f.optInt("key", -1, -1, 400) : null;
				return DevBridge.onClient(mc, () -> {
					dev.larattalabs.architect.client.hud.PlacingKeys.Action a = null;
					for (var x : dev.larattalabs.architect.client.hud.PlacingKeys.Action.values()) {
						if (x.id.equals(id)) {
							a = x;
						}
					}
					if (a == null) {
						throw new DevBridge.DevException("no placing action " + id);
					}
					net.minecraft.client.KeyMapping k = dev.larattalabs.architect.client.hud.Keys.placing.get(a);
					k.setKey(code == null ? k.getDefaultKey() : com.mojang.blaze3d.platform.InputConstants.Type.KEYBOARD.getOrCreate(code));
					net.minecraft.client.KeyMapping.resetMapping();
					JsonObject o = new JsonObject();
					o.addProperty("action", a.id);
					o.addProperty("label", dev.larattalabs.architect.client.hud.Keys.label(a));
					return o;
				});
			});
		DevBridge.register("dev.pr.guide", 10_000, "{event?: <GuideModel.Event>, arg?, press?: <card button id>, reset?: bool} - (PR F1) the "
			+ "first-build tour -> {state, step, number, card}", (req, mc) -> {
				Fields f = Fields.of(req);
				String ev = f.optStr("event", null);
				String arg = f.optStr("arg", null);
				String press = f.optStr("press", null);
				boolean reset = f.optBool("reset", false);
				Boolean survival = f.optBool("survival");
				return DevBridge.onClient(mc, () -> {
					if (survival != null) {
						dev.larattalabs.architect.client.help.GuideFeature.model().survival(survival);
					}
					if (reset) {
						dev.larattalabs.architect.client.design.UiPrefs.setGuide("new", 0);
						dev.larattalabs.architect.client.help.GuideFeature.resetForDev();
					}
					if (ev != null) {
						dev.larattalabs.architect.client.help.GuideFeature.on(dev.larattalabs.architect.client.help.GuideModel.Event.valueOf(ev
							.toUpperCase(java.util.Locale.ROOT)), arg);
					}
					if (press != null) {
						dev.larattalabs.architect.client.help.GuideFeature.press(press);
					}
					var m = dev.larattalabs.architect.client.help.GuideFeature.model();
					JsonObject o = new JsonObject();
					o.addProperty("state", m.state().name());
					o.addProperty("step", m.step().name());
					o.addProperty("number", m.number());
					var c = dev.larattalabs.architect.client.help.GuideFeature.card();
					if (c != null) {
						o.addProperty("title", c.title());
						o.addProperty("body", c.body());
					}
					return o;
				});
			});
	}
}
