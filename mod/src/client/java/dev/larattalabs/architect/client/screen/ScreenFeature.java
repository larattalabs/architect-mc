package dev.larattalabs.architect.client.screen;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.design.DesignForm;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.architect.client.launcher.Launcher;
import dev.larattalabs.architect.client.placement.BuildPlacement;
import dev.larattalabs.architect.client.placement.PlotMarker;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.site.SiteCommands;
import dev.larattalabs.architect.ui.Guard;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.input.MouseButtonInfo;

/**
 * Opens the Architect screen ({@code B}, {@code /architect}) and registers the DevBridge hooks for it, the design form, plot
 * marking, the launcher and the sidecar link, so the whole flow can be driven headlessly.
 */
public final class ScreenFeature {
	private ScreenFeature() {
	}

	public static void init() {
		Keys.ensureRegistered();
		SiteCommands.screenOpener = player -> Minecraft.getInstance().execute(() -> ArchitectScreen.open(null));
		DesignFeature.reopen = tab -> ArchitectScreen.open(ArchitectScreen.Tab.of(tab));
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("screen.key", () -> {
			while (Keys.screen.consumeClick()) {
				if (mc.player != null && mc.gui.screen() == null && !BuildPlacement.active() && !PlotMarker.active()) {
					ArchitectScreen.open(null);
				}
			}
		}));
		for (ArchitectScreen.Tab t : ArchitectScreen.Tab.values()) {
			DevBridge.registerScreen("architect_" + t.id(), mc -> new ArchitectScreen(t));
		}
		registerDev();
	}

	private static ArchitectScreen screen(Minecraft mc) {
		if (mc.gui.screen() instanceof ArchitectScreen s) {
			return s;
		}
		throw new DevBridge.DevException("the Architect screen is not open (dev.ui.open)");
	}

	private static void registerDev() {
		DevBridge.register("dev.ui.open", 10_000, "{tab?: design|library|designs|status} - open the Architect screen", (req, mc) -> {
			String tab = Fields.of(req).optStr("tab", null);
			ArchitectScreen.Tab t = tab == null ? null : ArchitectScreen.Tab.of(tab);
			if (tab != null && t == null) {
				throw new DevBridge.DevException("tab must be design, library, designs or status");
			}
			return DevBridge.onClient(mc, () -> {
				if (mc.player == null) {
					throw new DevBridge.DevException("not in a world");
				}
				return ArchitectScreen.open(t).stateJson();
			});
		});
		DevBridge.register("dev.ui.state", 10_000, "{} - the open Architect screen: tab, focus, controls [{id, label, state, x, y}] (GUI px)",
			(req, mc) -> DevBridge.onClient(mc, () -> screen(mc).stateJson()));
		DevBridge.register("dev.ui.click", 10_000, "{control} - press a control of the Architect screen by id (the field is not 'id': that is the request id) (see dev.ui.state controls)", (req, mc) -> {
			String id = Fields.of(req).nonBlank("control");
			return DevBridge.onClient(mc, () -> {
				ArchitectScreen s = screen(mc);
				boolean ran = s.click(id);
				JsonObject o = s.stateJson();
				o.addProperty("clicked", ran);
				if (!ran) {
					throw new DevBridge.DevException("no enabled control '" + id + "' on this tab");
				}
				return o;
			});
		});
		DevBridge.register("dev.ui.focus", 10_000, "{field: style|materials|name|notes|key|none} - focus a text field (then dev.type)", (req, mc) -> {
			String field = Fields.of(req).nonBlank("field");
			return DevBridge.onClient(mc, () -> {
				ArchitectScreen s = screen(mc);
				try {
					s.focus(field);
				} catch (IllegalArgumentException e) {
					throw new DevBridge.DevException("field must be style, materials, name, notes, key or none");
				}
				return s.stateJson();
			});
		});
		DevBridge.register("dev.click", 10_000, "{x, y, button?: 0} - a mouse click at GUI coordinates on the open screen", (req, mc) -> {
			Fields f = Fields.of(req);
			double x = f.num("x", -10_000, 10_000);
			double y = f.num("y", -10_000, 10_000);
			int button = f.optInt("button", 0, 0, 7);
			return DevBridge.onClient(mc, () -> {
				var s = mc.gui.screen();
				if (s == null) {
					throw new DevBridge.DevException("no screen is open");
				}
				boolean handled = s.mouseClicked(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)), false);
				s.mouseReleased(new MouseButtonEvent(x, y, new MouseButtonInfo(button, 0)));
				JsonObject o = new JsonObject();
				o.addProperty("handled", handled);
				o.addProperty("screen", s.getClass().getSimpleName());
				return o;
			});
		});
		DevBridge.register("dev.design.fill", 10_000, "{reset?, buildingType? (not type: that is the message type), style? (chip id or any text), materials?, features?: [..] | \"a,b\", size?: "
			+ "S|M|L|custom|plot, custom?: [x,y,z], remix?, name?, notes?} - set the Design tab's fields", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					fill(f);
					return designState(mc);
				});
			});
		DevBridge.register("dev.design.submit", 30_000, "{fields?} - fill (optional), then press Design it: replies after the ack with sent{designId, "
			+ "error} + the state", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> {
					if (f.has("fields")) {
						fill(f.obj("fields"));
					}
					return DesignFeature.submit();
				}).thenCompose(x -> x).thenCompose(sent -> DevBridge.onClient(mc, () -> {
					JsonObject o = designState(mc);
					JsonObject s = new JsonObject();
					s.addProperty("designId", sent.designId());
					s.addProperty("error", sent.error());
					o.add("sent", s);
					return o;
				}));
			});
		DevBridge.register("dev.design.state", 10_000, "{} - the Design form (fields, errors, the request as it would be sent), the sidecar's designs, "
			+ "plots", (req, mc) -> DevBridge.onClient(mc, () -> designState(mc)));
		DevBridge.register("dev.design.cancel", 20_000, "{designId} - design.cancel", (req, mc) -> {
			String id = Fields.of(req).nonBlank("designId");
			return DevBridge.onClient(mc, () -> DesignFeature.cancel(id)).thenCompose(x -> x).thenApply(ack -> {
				JsonObject o = new JsonObject();
				o.addProperty("ok", ack.ok());
				o.addProperty("ackError", ack.error());
				return o;
			});
		});
		DevBridge.register("dev.design.place", 10_000, "{blueprint} - Place on the plot (placement locked on the plot marked for it)", (req, mc) -> {
			String bp = Fields.of(req).nonBlank("blueprint");
			return DevBridge.onClient(mc, () -> {
				String why = DesignFeature.placeOnPlot(bp);
				if (why != null) {
					throw new DevBridge.DevException(why);
				}
				return dev.larattalabs.architect.client.placement.PlacementFeature.placeNow(bp) == null ? designState(mc) : designState(mc);
			});
		});
		DevBridge.register("dev.plot.start", 10_000, "{height?} - Mark a plot… (closes the screen; corners with dev.plot.corner)", (req, mc) -> {
			Fields f = Fields.of(req);
			return DevBridge.onClient(mc, () -> {
				if (f.has("height")) {
					DesignFeature.form().plot = null;
				}
				DesignFeature.startPlot();
				if (f.has("height")) {
					PlotMarker.setHeight(f.optInt("height", 16, 6, 64));
				}
				mc.gui.setScreen(null);
				return PlotMarker.state();
			});
		});
		DevBridge.register("dev.plot.corner", 10_000, "{x, y, z, front?, confirm?: true} - a plot corner (y = the surface); the second confirmed "
			+ "corner returns to the Design tab with the size filled", (req, mc) -> {
				Fields f = Fields.of(req);
				int x = f.optInt("x", 0, -30_000_000, 30_000_000);
				int y = f.optInt("y", 64, -2048, 2048);
				int z = f.optInt("z", 0, -30_000_000, 30_000_000);
				String front = f.optStr("front", null);
				boolean confirm = f.optBool("confirm", true);
				return DevBridge.onClient(mc, () -> {
					try {
						PlotMarker.corner(x, y, z, front, confirm);
					} catch (IllegalStateException | IllegalArgumentException e) {
						throw new DevBridge.DevException(e.getMessage());
					}
					return PlotMarker.state();
				});
			});
		DevBridge.register("dev.plot.state", 10_000, "{} - plot marking", (req, mc) -> DevBridge.onClient(mc, PlotMarker::state));
		DevBridge.register("dev.plot.cancel", 10_000, "{} - Esc while marking", (req, mc) -> DevBridge.onClient(mc, () -> {
			PlotMarker.cancel();
			return PlotMarker.state();
		}));
		DevBridge.register("dev.launcher.state", 10_000, "{} - the launcher: state, detail, source, node, pid, reuse, log tail", (req, mc) ->
			CompletableFuture.completedFuture(Launcher.json()));
		DevBridge.register("dev.launcher.restart", 10_000, "{} - Restart helper (Status tab)", (req, mc) -> {
			if (Launcher.startedByUs()) {
				Launcher.restart();
			} else {
				Launcher.start();
			}
			return CompletableFuture.completedFuture(Launcher.json());
		});
		DevBridge.register("dev.sidecar.state", 10_000, "{} - the sidecar link and state: status (no key), designs", (req, mc) -> DevBridge.onClient(mc,
			() -> Sidecar.state().json()));
		DevBridge.addStateContributor((mc, o) -> {
			JsonObject a = new JsonObject();
			a.addProperty("launcher", Launcher.state().wire());
			a.addProperty("link", Sidecar.state().link().phaseName());
			a.addProperty("screen", mc.gui.screen() instanceof ArchitectScreen s ? s.tab().id() : null);
			a.addProperty("placing", BuildPlacement.active());
			a.addProperty("plotMarking", PlotMarker.active());
			o.add("architect", a);
		});
	}

	private static void fill(Fields f) {
		if (f.optBool("reset", false)) {
			DesignFeature.resetForm();
		}
		DesignForm form = DesignFeature.form();
		if (f.has("buildingType")) {
			form.type = f.str("buildingType");
		}
		if (f.has("style")) {
			String s = f.str("style");
			if (dev.larattalabs.architect.design.DesignSpec.find(dev.larattalabs.architect.design.DesignSpec.STYLES, s) != null) {
				form.styleChip = s;
				form.styleText.clear();
			} else {
				form.styleText.set(s);
			}
		}
		if (f.has("materials")) {
			form.materials.set(f.str("materials"));
		}
		if (f.has("features")) {
			form.features.clear();
			JsonElement el = f.json().get("features");
			if (el.isJsonArray()) {
				for (JsonElement e : el.getAsJsonArray()) {
					form.features.add(e.getAsString());
				}
			} else {
				for (String s : el.getAsString().split(",")) {
					if (!s.isBlank()) {
						form.features.add(s.strip());
					}
				}
			}
		}
		if (f.has("size")) {
			form.size = f.str("size");
		}
		if (f.has("custom")) {
			JsonArray c = f.json().getAsJsonArray("custom");
			form.customX = c.get(0).getAsInt();
			form.customY = c.get(1).getAsInt();
			form.customZ = c.get(2).getAsInt();
			form.size = DesignForm.CUSTOM;
		}
		if (f.has("remix")) {
			form.remix = f.json().get("remix").isJsonNull() ? null : f.str("remix");
		}
		if (f.has("name")) {
			form.name.set(f.str("name"));
		}
		if (f.has("notes")) {
			form.notes.set(f.str("notes"));
		}
		form.sendError = null;
	}

	private static JsonObject designState(Minecraft mc) {
		JsonObject o = new JsonObject();
		o.add("form", DesignFeature.form().stateJson());
		o.addProperty("sending", DesignFeature.sending());
		o.addProperty("sidecarConnected", Sidecar.connected());
		o.addProperty("lastSent", DesignFeature.lastSent());
		o.addProperty("lastReload", DesignFeature.lastReload());
		o.add("sidecar", Sidecar.state().json());
		o.add("plotMode", PlotMarker.state());
		o.addProperty("screen", mc.gui.screen() instanceof ArchitectScreen s ? s.tab().id() : null);
		return o;
	}
}
