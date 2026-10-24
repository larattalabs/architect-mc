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
import dev.larattalabs.labui.ui.Guard;
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
		SiteCommands.libraryOpener = (player, site) -> Minecraft.getInstance().execute(() -> ArchitectScreen.openPlaced(site)); // UI-2b
		DesignFeature.reopen = tab -> ArchitectScreen.open(ArchitectScreen.Tab.of(tab));
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("architect_mc:screen.key", () -> {
			while (Keys.siteHud.consumeClick()) {
				// UI-2b: the construction HUD full -> one line -> hidden
				var m = dev.larattalabs.architect.client.design.UiPrefs.siteHud().next();
				dev.larattalabs.architect.client.design.UiPrefs.setSiteHud(m);
				if (mc.player != null) {
					mc.gui.hud.setOverlayMessage(net.minecraft.network.chat.Component.literal("Construction HUD: " + switch (m) {
						case FULL -> "full";
						case LINE -> "one line";
						case HIDDEN -> "hidden (" + Keys.label(Keys.siteHud) + " shows it again)";
					}), false);
				}
			}
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
		LibraryDev.register();
		SetDev.register();
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
		DevBridge.register("dev.design.fill", 10_000, "{reset?, buildingType? (not type: that is the message type; a non-preset one is an open type), openType?, profile?: [rules], "
			+ "bible?: id|none (U2: a Claude-made Style is set mode, a built-in or hand-made one is picked), style? (chip id = a built-in Style, or any text = none), "
			+ "styleOps?: [[pick, id] | [unpick] | [revert] | [main, wood|stone|roof|accent, value] | [role, role, block] | [feature, id]] (U2, in order), materials?, "
			+ "features?: [..] | \"a,b\", size?: "
			+ "S|M|L|custom|plot, custom?: [x,y,z], remix?, name?, notes?, massingFirst?: bool|null (4c; null = the default for the size), critique?: bool, "
			+ "maxRevisions?: 1|2 (5a)} - set the Design tab's fields", (req, mc) -> {
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
		DevBridge.register("dev.design.saveStyle", 30_000, "{name?} - (Style unification U2) Save as style…: the Design tab's Style as it is (a custom mix "
			+ "or a copy) saved as a new hand-made Style (bible.save, free); the form then picks it -> {saved: {styleId, version, origin, editable, basedOn, "
			+ "suggestedFeatures, tags, roles}, request (the bible.save Style as sent)} + the state, or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String name = f.optStr("name", null);
				return DevBridge.onClient(mc, () -> {
					JsonObject sent = DesignFeature.form().styleForm.saveRequest(name);
					return DesignFeature.saveStyle(name).handle((b, err) -> DevBridge.onClient(mc, () -> {
						JsonObject o = designState(mc);
						o.add("request", sent);
						if (err != null) {
							Throwable c = err instanceof java.util.concurrent.CompletionException && err.getCause() != null ? err.getCause() : err;
							o.addProperty("refused", String.valueOf(c.getMessage()));
						} else {
							JsonObject sb = new JsonObject();
							sb.addProperty("styleId", b.id());
							sb.addProperty("version", b.version());
							sb.addProperty("origin", b.origin());
							sb.addProperty("editable", b.editable());
							b.basedOn().ifPresent(p -> sb.addProperty("basedOn", p.id() + " v" + p.version()));
							JsonArray sf = new JsonArray();
							b.suggestedFeatures().forEach(sf::add);
							sb.add("suggestedFeatures", sf);
							JsonArray tg = new JsonArray();
							b.tags().forEach(tg::add);
							sb.add("tags", tg);
							JsonObject r = new JsonObject();
							b.roles().forEach(r::addProperty);
							sb.add("roles", r);
							o.add("saved", sb);
						}
						return o;
					})).thenCompose(x -> x);
				}).thenCompose(x -> x);
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
				return designState(mc);
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
				form.pickChip(s);
			} else {
				form.styleText.set(s);
			}
		}
		// (U3) words alongside the picked Style; "Own words" (the words are the style, no Style)
		if (f.has("styleNote")) {
			form.styleNote.set(f.str("styleNote"));
		}
		if (f.has("ownWords")) {
			if (f.bool("ownWords")) {
				form.useOwnWords();
			} else {
				form.ownWordsMode = false;
				form.styleText.clear();
			}
		}
		if (f.has("materials")) {
			form.materials.set(f.str("materials"));
		}
		if (f.has("features")) {
			java.util.List<String> feats = new java.util.ArrayList<>();
			JsonElement el = f.json().get("features");
			if (el.isJsonArray()) {
				for (JsonElement e : el.getAsJsonArray()) {
					feats.add(e.getAsString());
				}
			} else {
				for (String s : el.getAsString().split(",")) {
					if (!s.isBlank()) {
						feats.add(s.strip());
					}
				}
			}
			try {
				form.styleForm.setFeatures(feats);
			} catch (IllegalArgumentException | IllegalStateException e) {
				throw new DevBridge.DevException("features: " + e.getMessage());
			}
		}
		// (Style unification U2) Style operations on the Design tab's StyleForm, in order (kit formApply's ops)
		if (f.has("styleOps")) {
			for (JsonElement oe : f.json().getAsJsonArray("styleOps")) {
				JsonArray op = oe.getAsJsonArray();
				String k = op.get(0).getAsString();
				try {
					switch (k) {
						case "pick" -> {
							String id = op.get(1).getAsString();
							var installed = dev.larattalabs.architect.client.design.SetFeature.bible(id);
							if (installed.isPresent() && !installed.get().builtin()) {
								form.pickBible(installed.get());
							} else {
								form.pickChip(id);
							}
						}
						case "unpick" -> form.styleForm.unpick();
						case "revert" -> form.styleForm.revert();
						case "main" -> form.styleForm.editMain(op.get(1).getAsString(), op.get(2).getAsString());
						case "role" -> form.styleForm.setRole(op.get(1).getAsString(), op.get(2).getAsString());
						case "feature" -> form.styleForm.toggleFeature(op.get(1).getAsString());
						default -> throw new IllegalArgumentException("unknown style op " + k + " (pick, unpick, revert, main, role, feature)");
					}
				} catch (IllegalArgumentException | IllegalStateException e) {
					throw new DevBridge.DevException("styleOps " + op + ": " + e.getMessage());
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
		// phase 4b: an open type (buildingType "other" + openType, or any non-preset buildingType), its profile, a bible
		if (f.has("openType")) {
			form.type = DesignForm.OTHER;
			form.openType.set(f.str("openType"));
		} else if (f.has("buildingType") && !DesignForm.OTHER.equals(form.type)
			&& !dev.larattalabs.architect.design.DesignSpec.isPreset(form.type)) {
			form.openType.set(form.type);
			form.type = DesignForm.OTHER;
		}
		if (f.has("profile")) {
			form.profile.clear();
			for (JsonElement e : f.json().getAsJsonArray("profile")) {
				form.profile.add(e.getAsString());
			}
		}
		if (f.has("bible")) {
			// (U2) a Claude-made Style is set mode; a built-in or hand-made one is picked (materials only); an unknown id stays set mode
			String bid = f.isExplicitNull("bible") || "none".equals(f.str("bible")) ? null : f.str("bible");
			var known = bid == null ? java.util.Optional.<dev.larattalabs.architect.api.Bible>empty() : dev.larattalabs.architect.client.design.SetFeature.bible(bid);
			if (known.isPresent()) {
				form.pickBible(known.get());
			} else {
				form.bible = bid;
			}
		}
		if (f.has("massingFirst")) {
			// (4c) true / false, or null = the default for the size (on for L and plot)
			form.massingFirst = f.isExplicitNull("massingFirst") ? null : f.bool("massingFirst");
		}
		// (5a) "Critique and revise" and its revisions
		if (f.has("critique")) {
			form.critique = f.bool("critique");
		}
		if (f.has("maxRevisions")) {
			form.maxRevisions = dev.larattalabs.architect.design.CritiqueRules.revisions((int) f.num("maxRevisions", 1, 2));
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
