package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.placement.RegionGhost;
import dev.larattalabs.labui.client.hud.HudZones;
import dev.larattalabs.labui.client.hud.Toasts;

/**
 * Slice UI-0.3 DevBridge hooks (docs/DEVBRIDGE.md): lab-ui's HUD zone layout of the last frame, a preview of the region ghost's
 * verdict panel (which otherwise needs a planned region), and a toast pushed through {@code Toasts.Spec}, for the "every HUD piece
 * at once" shot. Client only; no world state changes.
 */
public final class SliceUi03Dev {
	private SliceUi03Dev() {
	}

	public static void init() {
		DevBridge.register("dev.hud.zones", 10_000, "{} - (UI-0.3) lab-ui HudZones.json(): each zone's bounds, its slots by id {x, y, w, h, "
			+ "collapsed}, hidden pieces, overflow, vanilla's pieces (boss bars, effects, toasts, Now playing) and the registrations",
			(req, mc) -> DevBridge.onClient(mc, HudZones::json));
		DevBridge.register("dev.ui03.regionHudPreview", 10_000, "{planId?: string|null, tiles?, verdict?} - (UI-0.3) draw the region ghost's "
			+ "verdict panel with these words while no region ghost is shown (planId null: off), for a shot", (req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.optStr("planId", null);
				String tiles = f.optStr("tiles", "12 of 40 tiles near");
				String verdict = f.optStr("verdict", "checker: ok · 31 204 of 200 000 cells");
				return DevBridge.onClient(mc, () -> {
					RegionGhost.previewHud(id == null ? null : new String[] {id, tiles, verdict});
					JsonObject o = new JsonObject();
					o.addProperty("preview", id);
					return o;
				});
			});
		DevBridge.register("dev.ui03.toast", 10_000, "{level?: info|warn|need, title, body, subject?, lines?: 1-3} - (UI-0.3) push a toast "
			+ "through lab-ui Toasts.push(Spec)", (req, mc) -> {
				Fields f = Fields.of(req);
				String level = f.optStr("level", "info");
				String title = f.optStr("title", "Toast");
				String body = f.optStr("body", "");
				String subject = f.optStr("subject", null);
				int lines = f.optInt("lines", 2, 1, 3);
				return DevBridge.onClient(mc, () -> {
					Toasts.Level l = switch (level) {
						case "warn" -> Toasts.Level.WARN;
						case "need" -> Toasts.Level.NEED;
						default -> Toasts.Level.INFO;
					};
					Toasts.push(Toasts.Spec.of(l, title, body).subject(subject).bodyLines(lines));
					JsonObject o = new JsonObject();
					o.addProperty("pushed", title);
					return o;
				});
			});
	}
}
