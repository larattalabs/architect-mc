package dev.larattalabs.architect.client.survival;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.hud.Toasts;
import dev.larattalabs.labui.client.ui.GuardedHud;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.site.Builder;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import dev.larattalabs.architect.survival.SiteNet;
import dev.larattalabs.architect.survival.SurvivalWorld;
import dev.larattalabs.labui.ui.Guard;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.server.permissions.Permissions;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.AABB;

/**
 * Client side of survival construction sites (docs/CONTRACT.md phase 3): the ghost payloads ({@link SiteGhosts}), the
 * remaining-cell renderer, the HUD line, the crate screen, the "built" toast and the DevBridge hooks
 * ({@code dev.survival.*}, {@code dev.site.*}, {@code dev.crate.*}, {@code dev.ghosts.state}).
 */
public final class SurvivalFeature {
	private SurvivalFeature() {
	}

	public static void init() {
		ClientPlayNetworking.registerGlobalReceiver(SiteNet.SiteGhost.TYPE, (p, ctx) -> Guard.run("architect_mc:survival.ghost", () -> SiteGhosts.onGhost(p)));
		ClientPlayNetworking.registerGlobalReceiver(SiteNet.SiteProgress.TYPE, (p, ctx) -> Guard.run("architect_mc:survival.progress", () -> SiteGhosts.onProgress(p)));
		ClientPlayNetworking.registerGlobalReceiver(SiteNet.SiteStatus.TYPE, (p, ctx) -> Guard.run("architect_mc:survival.status", () -> SiteGhosts.onStatus(p)));
		ClientPlayNetworking.registerGlobalReceiver(SiteNet.SiteClear.TYPE, (p, ctx) -> Guard.run("architect_mc:survival.clear", () -> {
			SiteGhosts.onClear(p);
			if (p.finished()) {
				Toasts.push(Toasts.Level.INFO, p.name() + " is built", "The construction site " + p.siteId() + " is finished; the crate gave back its leftovers");
			}
		}));
		ClientPlayNetworking.registerGlobalReceiver(SiteNet.CrateOpen.TYPE, (p, ctx) -> Guard.run("architect_mc:survival.crate", () ->
			Minecraft.getInstance().gui.setScreen(new CrateScreen(p.siteId()))));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> mc.execute(SiteGhosts::clear));
		LevelRenderEvents.COLLECT_SUBMITS.register(ctx -> Guard.run("architect_mc:survival.ghost.render", () -> SiteGhostRenderer.submit(ctx)));
		HudElementRegistry.addLast(Architect.id("hud/construction"), GuardedHud.of("architect_mc:hud.construction", new SiteHud()));
		registerDev();
	}

	/** Whether the local player may change the survival toggle (permission level 2: cheats on, or op). */
	public static boolean mayToggle() {
		Minecraft mc = Minecraft.getInstance();
		return mc.player != null && mc.player.permissions().hasPermission(Permissions.COMMANDS_GAMEMASTER);
	}

	private static void registerDev() {
		DevBridge.register("dev.survival.state", 10_000, "{} - this world's survival toggle, blocksPerTick, and whether the player may change it",
			(req, mc) -> DevBridge.onClient(mc, () -> {
				JsonObject o = new JsonObject();
				o.addProperty("loaded", SurvivalWorld.loaded());
				o.addProperty("survival", SurvivalWorld.on());
				o.addProperty("blocksPerTick", SurvivalWorld.blocksPerTick());
				o.addProperty("mayToggle", mayToggle());
				return o;
			}));
		DevBridge.register("dev.survival.set", 10_000, "{on: bool} - set the survival toggle (dev hook: bypasses the permission rule; the Status "
			+ "tab and /architect survival enforce it)", (req, mc) -> {
				boolean on = Fields.of(req).optBool("on", true);
				return DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> {
					SurvivalWorld.set(server, on);
					JsonObject o = new JsonObject();
					o.addProperty("survival", SurvivalWorld.on());
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.site.state", 10_000, "{site} - a construction site: state, queue length, built count, BOM rows, ledger, blocked "
			+ "cells, notes, the last deconstruct's tally", (req, mc) -> {
				String id = Fields.of(req).nonBlank("site");
				return DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> {
					try {
						return Builder.state(server, id);
					} catch (Sites.SiteException e) {
						throw new DevBridge.DevException(e.getMessage());
					}
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.crate.insert", 30_000, "{site, items?: {item: count}, inventory?: true} - book items into the crate as a hopper "
			+ "would (counting equivalents), or move the player's needed items in (Insert from inventory) -> what went in", (req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("site");
				boolean inv = f.optBool("inventory", false);
				Map<String, Integer> items = new LinkedHashMap<>();
				if (f.json().has("items")) {
					f.json().getAsJsonObject("items").entrySet().forEach(e -> items.put(e.getKey(), e.getValue().getAsInt()));
				}
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					try {
						if (inv) {
							o.addProperty("moved", Builder.insertFromInventory(player, id));
						} else {
							JsonObject in = new JsonObject();
							Builder.insertItems(level.getServer(), id, items).forEach(in::addProperty);
							o.add("accepted", in);
						}
					} catch (Sites.SiteException e) {
						throw new DevBridge.DevException(e.getMessage());
					}
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.crate.open", 10_000, "{site} - open the crate screen of a site (as a right-click on its crate does)", (req, mc) -> {
			String id = Fields.of(req).nonBlank("site");
			return DevBridge.onClient(mc, () -> {
				CrateScreen s = new CrateScreen(id);
				mc.gui.setScreen(s);
				return s.json();
			});
		});
		DevBridge.register("dev.crate.state", 10_000, "{} - the open crate screen: controls, flash, the site state it shows", (req, mc) ->
			DevBridge.onClient(mc, () -> {
				if (!(mc.gui.screen() instanceof CrateScreen s)) {
					throw new DevBridge.DevException("the crate screen is not open (dev.crate.open)");
				}
				return s.json();
			}));
		DevBridge.register("dev.crate.press", 10_000, "{control: insert|pause|deconstruct|close} - press a crate screen button", (req, mc) -> {
			String c = Fields.of(req).nonBlank("control");
			return DevBridge.onClient(mc, () -> {
				if (!(mc.gui.screen() instanceof CrateScreen s)) {
					throw new DevBridge.DevException("the crate screen is not open (dev.crate.open)");
				}
				if (!s.press(c)) {
					throw new DevBridge.DevException("no enabled control " + c);
				}
				return s.json();
			});
		});
		DevBridge.register("dev.site.finish", 30_000, "{site} - /architect site finish (dev hook: no permission check): the remaining cells, free",
			(req, mc) -> {
				String id = Fields.of(req).nonBlank("site");
				return DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> {
					JsonObject o = new JsonObject();
					try {
						o.addProperty("placed", Builder.finish(server, id));
					} catch (Sites.SiteException e) {
						o.addProperty("error", e.getMessage());
					}
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.site.deconstruct", 60_000, "{site, force?: false} - Deconstruct (as the crate screen / Library Remove): refunds, "
			+ "the player's blocks and the crate's stock drop at the crate; the terrain comes back -> the tally", (req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("site");
				boolean force = f.optBool("force", false);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					try {
						Site s = Sites.get(id);
						var sl = s == null ? level : Sites.levelOf(level.getServer(), s);
						Site gone = Sites.remove(sl == null ? level : sl, id, force);
						o.addProperty("removed", true);
						o.addProperty("restoreBox", dev.larattalabs.architect.placement.Anchors.str(gone.restoreBox()));
						JsonObject st = gone.construction() != null ? Builder.lastDeconstructionJson() : null;
						if (st != null) {
							o.add("tally", st);
						}
					} catch (Sites.SiteException e) {
						o.addProperty("removed", false);
						o.addProperty("message", e.getMessage());
					}
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.site.mine", 30_000, "{pos: [x,y,z], pickup?: true} - the player mines a block as in survival (vanilla drops), "
			+ "then picks up its drops", (req, mc) -> {
				Fields f = Fields.of(req);
				var a = f.json().getAsJsonArray("pos");
				BlockPos pos = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
				boolean pickup = f.optBool("pickup", true);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					String was = level.getBlockState(pos).toString();
					java.util.Set<java.util.UUID> before = new java.util.HashSet<>();
					AABB area = new AABB(pos).inflate(2);
					level.getEntitiesOfClass(ItemEntity.class, area).forEach(e -> before.add(e.getUUID()));
					boolean ok = player.gameMode.destroyBlock(pos);
					o.addProperty("mined", ok);
					o.addProperty("was", was);
					o.addProperty("now", level.getBlockState(pos).toString());
					int picked = 0;
					com.google.gson.JsonArray got = new com.google.gson.JsonArray();
					if (pickup) {
						for (ItemEntity e : List.copyOf(level.getEntitiesOfClass(ItemEntity.class, area))) {
							if (!before.contains(e.getUUID())) {
								got.add(e.getItem().getCount() + " " + e.getItem().getItem());
								e.setNoPickUpDelay();
								e.playerTouch(player);
								picked++;
							}
						}
					}
					o.addProperty("pickedUp", picked);
					o.add("drops", got);
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.items.near", 10_000, "{pos: [x,y,z], radius?: 8} - dropped item entities near a point: stacks and items per id; and "
			+ "the player's inventory per id (refund checks)", (req, mc) -> {
				Fields f = Fields.of(req);
				var a = f.json().getAsJsonArray("pos");
				double r = f.optNum("radius", 8, 0.5, 64);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					AABB box = new AABB(a.get(0).getAsDouble(), a.get(1).getAsDouble(), a.get(2).getAsDouble(), a.get(0).getAsDouble() + 1,
						a.get(1).getAsDouble() + 1, a.get(2).getAsDouble() + 1).inflate(r);
					Map<String, Integer> items = new java.util.TreeMap<>();
					int stacks = 0;
					for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) {
						stacks++;
						items.merge(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(e.getItem().getItem()).toString(), e.getItem().getCount(),
							Integer::sum);
					}
					JsonObject io = new JsonObject();
					items.forEach(io::addProperty);
					o.addProperty("stacks", stacks);
					o.add("items", io);
					Map<String, Integer> inv = new java.util.TreeMap<>();
					var pi = player.getInventory();
					for (int i = 0; i < pi.getContainerSize(); i++) {
						var st = pi.getItem(i);
						if (!st.isEmpty()) {
							inv.merge(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
						}
					}
					JsonObject iv = new JsonObject();
					inv.forEach(iv::addProperty);
					o.add("inventory", iv);
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.ghosts.state", 10_000, "{} - the construction-site ghosts this client holds (cells, built, remaining, HUD line)",
			(req, mc) -> DevBridge.onClient(mc, SiteGhosts::json));
	}
}
