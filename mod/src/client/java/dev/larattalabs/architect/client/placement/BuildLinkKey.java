package dev.larattalabs.architect.client.placement;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.site.SiteFit;
import dev.larattalabs.labui.client.hud.Toasts;
import dev.larattalabs.labui.ui.Guard;
import java.util.List;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.util.Util;
import org.jspecify.annotations.Nullable;

/**
 * (7c CX, docs/CONTRACT.md "Phase 7c" §3 row 11) The "Build a link" key ({@link Keys#buildLink}, K by default): the connector mode of the
 * plot marker ({@link PlotMarker#startConnector}). After a site house was placed whose entrance opens onto a drop ({@link SiteFit#dropsOf},
 * the warning's "build a link here"), the key starts the link from that port's outside cell (the first end marked: the player marks the
 * other end, on the ground or another site); otherwise both ends are marked. The remembered drop is used once, or forgotten after
 * {@value #KEEP_MS} ms. Ignored while placing, marking or with a screen open.
 */
public final class BuildLinkKey {
	static final long KEEP_MS = 10 * 60_000;
	private static @Nullable List<SiteFit.Drop> drops;
	private static long dropsAt;

	private BuildLinkKey() {
	}

	static void init() {
		Keys.ensureRegistered();
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("architect_mc:build_link.key", () -> {
			while (Keys.buildLink.consumeClick()) {
				press(mc);
			}
		}));
		DevBridge.register("dev.cx.key", 10_000, "{press?: true, kind?} - (7c CX) the Build a link key: {key, drop: {port, facing, at} | null (the port it would "
			+ "start from), marker: dev.plot.state}; press: as the key (starts the connector mode; ends then with dev.plot.corner); kind: F's pick "
			+ "(rope_bridge, ladder, catwalk, rock_stair, spiral)", (req, mc) -> DevBridge.onClient(mc, () -> {
				if (req.has("press") && req.get("press").getAsBoolean()) {
					press(mc);
				}
				if (req.has("kind")) {
					PlotMarker.setConnectorKind(req.get("kind").getAsString());
				}
				JsonObject o = new JsonObject();
				o.addProperty("key", Keys.buildLink == null ? null : Keys.label(Keys.buildLink));
				SiteFit.Drop d = drop();
				if (d == null) {
					o.add("drop", null);
				} else {
					JsonObject j = new JsonObject();
					j.addProperty("port", d.port());
					j.addProperty("facing", d.facing());
					JsonArray a = new JsonArray();
					a.add(d.at().getX());
					a.add(d.at().getY());
					a.add(d.at().getZ());
					j.add("at", a);
					o.add("drop", j);
				}
				o.add("marker", PlotMarker.state());
				return o;
			}));
	}

	/** A site house was placed with these drops: the key starts its link from the first. */
	static void remember(List<SiteFit.Drop> d) {
		if (d.isEmpty()) {
			return;
		}
		drops = List.copyOf(d);
		dropsAt = Util.getMillis();
		String k = Keys.buildLink == null ? "K" : Keys.label(Keys.buildLink);
		Toasts.push(Toasts.Spec.of(Toasts.Level.NEED, "The entrance opens onto a drop", "Port " + d.get(0).port() + " faces " + d.get(0).facing()
			+ " over a drop: " + SiteFit.LINK_HERE).hint(k, "build a link"));
	}

	private static SiteFit.@Nullable Drop drop() {
		List<SiteFit.Drop> d = drops;
		if (d == null || d.isEmpty() || Util.getMillis() - dropsAt > KEEP_MS) {
			return null;
		}
		return d.get(0);
	}

	private static void press(Minecraft mc) {
		if (mc.player == null || mc.gui.screen() != null || BuildPlacement.active() || PlotMarker.active()) {
			return;
		}
		SiteFit.Drop d = drop();
		int[] from = d == null ? null : new int[] {d.at().getX(), d.at().getY(), d.at().getZ()};
		drops = null;
		PlotMarker.startConnector(from, r -> Toasts.push(Toasts.Level.INFO, "Link placed", r.siteId().orElse("?") + (r.notes().isEmpty() ? "" : ": "
			+ r.notes().get(0))), () -> {
		});
	}
}
