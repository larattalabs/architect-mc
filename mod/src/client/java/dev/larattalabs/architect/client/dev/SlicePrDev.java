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
	}
}
