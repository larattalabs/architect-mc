package dev.larattalabs.architect.client.placement;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.dev.DevBridge;
import dev.larattalabs.architect.client.dev.Fields;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import dev.larattalabs.architect.ui.Guard;
import java.security.MessageDigest;
import java.util.HexFormat;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.TagValueOutput;
import org.jspecify.annotations.Nullable;

/**
 * Placement mode and plot marking (client): the ghost ({@link BuildPlacement}, {@link GhostRenderer}), its HUD
 * ({@link PlacementHud}) and keys handled before vanilla ({@code KeyboardHandlerMixin} -> {@link #onKey}): R rotate (Shift+R
 * back), arrows nudge, PgUp/PgDn raise/lower, L lock, Enter place, Shift+Enter force (after a block-entity refusal), Esc /
 * Backspace cancel. Plot marking ({@link PlotMarker}, {@link PlotHud}) shares the key capture.
 *
 * <p>Singleplayer only: confirm runs {@code Sites.place} on the integrated server. No cheats needed: placing is explicit and
 * reversible (Remove), and phase 1 places free in every game mode.
 *
 * <p>QA: {@code dev.build.*}, {@code dev.sites.*}, {@code dev.box.hash} (see {@link #registerDev}).
 */
public final class PlacementFeature {
	private PlacementFeature() {
	}

	public static void init() {
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("placement.tick", () -> {
			BuildPlacement.tick(mc);
			PlotMarker.tick(mc);
		}));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> mc.execute(() -> {
			BuildPlacement.cancel();
			PlotMarker.cancelQuietly();
		}));
		LevelRenderEvents.COLLECT_SUBMITS.register(ctx -> Guard.run("placement.ghost", () -> GhostRenderer.submit(ctx)));
		LevelRenderEvents.COLLECT_SUBMITS.register(ctx -> Guard.run("placement.plot", () -> GhostRenderer.submitPlot(ctx)));
		HudElementRegistry.addLast(Architect.id("hud/placement"), dev.larattalabs.architect.client.ui.GuardedHud.of("hud.placement", new PlacementHud()));
		HudElementRegistry.addLast(Architect.id("hud/plot_marker"), dev.larattalabs.architect.client.ui.GuardedHud.of("hud.plot_marker", new PlotHud()));
		registerDev();
	}

	/** Enters placement mode with a library design (closes any screen). Returns why it cannot, or null when the ghost is up. */
	public static @Nullable String placeNow(String blueprintId) {
		try {
			BuildPlacement.start(blueprintId);
			return null;
		} catch (IllegalArgumentException e) {
			return e.getMessage();
		}
	}

	/** {@link #placeNow}, then locks the ghost at {@code origin} with {@code turns} (a marked plot). */
	public static @Nullable String placeNowAt(String blueprintId, int[] origin, int turns) {
		String why = placeNow(blueprintId);
		if (why == null) {
			BuildPlacement.lockAt(origin[0], origin[1], origin[2], turns);
		}
		return why;
	}

	/** Placement mode to move site {@code id}. Returns why not, or null when the ghost is up. */
	public static @Nullable String startMove(String id) {
		try {
			BuildPlacement.startMove(id);
			return null;
		} catch (IllegalArgumentException e) {
			return e.getMessage();
		}
	}

	/**
	 * Placement-mode keys, called by the keyboard mixin before vanilla handles a key. Returns true when the key was consumed.
	 * Only while placing with no screen open; releases always pass.
	 */
	public static boolean onKey(int action, KeyEvent e) {
		if (action == InputConstants.RELEASE || !BuildPlacement.active() && !PlotMarker.active()) {
			return false;
		}
		Minecraft mc = Minecraft.getInstance();
		if (mc.gui.screen() != null) {
			return false;
		}
		boolean repeat = action != InputConstants.PRESS;
		if (PlotMarker.active()) {
			return plotKey(e, repeat);
		}
		switch (e.key()) {
			case InputConstants.KEY_R -> {
				if (!repeat) {
					BuildPlacement.rotate(e.hasShiftDown() ? -1 : 1);
				}
			}
			case InputConstants.KEY_UP -> BuildPlacement.nudge(1, 0, 0);
			case InputConstants.KEY_DOWN -> BuildPlacement.nudge(-1, 0, 0);
			case InputConstants.KEY_LEFT -> BuildPlacement.nudge(0, -1, 0);
			case InputConstants.KEY_RIGHT -> BuildPlacement.nudge(0, 1, 0);
			case InputConstants.KEY_PAGEUP -> BuildPlacement.nudge(0, 0, 1);
			case InputConstants.KEY_PAGEDOWN -> BuildPlacement.nudge(0, 0, -1);
			case InputConstants.KEY_L -> {
				if (!repeat) {
					BuildPlacement.setLocked(!BuildPlacement.locked());
				}
			}
			case InputConstants.KEY_RETURN, InputConstants.KEY_NUMPADENTER -> {
				if (!repeat) {
					BuildPlacement.confirm(e.hasShiftDown());
				}
			}
			case InputConstants.KEY_ESCAPE, InputConstants.KEY_BACKSPACE -> {
				if (!repeat) {
					BuildPlacement.cancel();
				}
			}
			default -> {
				return false;
			}
		}
		return true;
	}

	/** Plot-marking keys: Enter corner, PgUp/PgDn height (Shift: 4), Backspace back a corner, Esc cancel. */
	private static boolean plotKey(KeyEvent e, boolean repeat) {
		switch (e.key()) {
			case InputConstants.KEY_RETURN, InputConstants.KEY_NUMPADENTER -> {
				if (!repeat) {
					PlotMarker.confirm();
				}
			}
			case InputConstants.KEY_PAGEUP -> PlotMarker.adjustHeight(e.hasShiftDown() ? 4 : 1);
			case InputConstants.KEY_PAGEDOWN -> PlotMarker.adjustHeight(e.hasShiftDown() ? -4 : -1);
			case InputConstants.KEY_BACKSPACE -> {
				if (!repeat) {
					PlotMarker.back();
				}
			}
			case InputConstants.KEY_ESCAPE -> {
				if (!repeat) {
					PlotMarker.cancel();
				}
			}
			default -> {
				return false;
			}
		}
		return true;
	}

	// ------------------------------------------------------------------ dev

	static int[] xyz(Fields f, String field) {
		JsonElement el = f.json().get(field);
		if (el.isJsonArray()) {
			JsonArray a = el.getAsJsonArray();
			if (a.size() != 3) {
				throw new DevBridge.DevException(field + " must be [x, y, z]");
			}
			return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
		}
		String[] parts = el.getAsString().trim().split("[\\s,]+");
		if (parts.length != 3) {
			throw new DevBridge.DevException(field + " must be \"x y z\" or [x, y, z]");
		}
		try {
			return new int[] {Integer.parseInt(parts[0]), Integer.parseInt(parts[1]), Integer.parseInt(parts[2])};
		} catch (NumberFormatException e) {
			throw new DevBridge.DevException(field + " must hold integers");
		}
	}

	private static void registerDev() {
		DevBridge.register("dev.build.start", 10_000, "{blueprint, origin?: [x,y,z] (rotated box minimum; locks the ghost there), ground?: false "
			+ "(origin's y replaced by the footprint's median surface), turns?: 0-3 | rotation name, move?: siteId} - enter placement mode", (req, mc) -> {
				Fields f = Fields.of(req);
				String bp = f.optStr("blueprint", null);
				String move = f.optStr("move", null);
				if (bp == null && move == null) {
					throw new DevBridge.DevException("blueprint (or move: siteId) is required");
				}
				int[] origin = f.has("origin") ? xyz(f, "origin") : null;
				boolean ground = f.optBool("ground", false);
				int turns = 0;
				if (f.has("turns")) {
					JsonElement t = f.json().get("turns");
					turns = t.getAsJsonPrimitive().isNumber() ? t.getAsInt() : BlueprintTransform.parseTurns(t.getAsString());
					if (turns < 0 || turns > 3) {
						throw new DevBridge.DevException("turns must be 0-3 or a rotation name");
					}
				}
				int fturns = turns;
				return DevBridge.onClient(mc, () -> {
					try {
						if (move != null) {
							BuildPlacement.startMove(move);
						} else {
							BuildPlacement.start(bp);
						}
					} catch (IllegalArgumentException e) {
						throw new DevBridge.DevException(e.getMessage());
					}
					if (origin != null) {
						BuildPlacement.lockAt(origin[0], origin[1], origin[2], fturns, ground);
					} else if (fturns != 0) {
						BuildPlacement.rotate(fturns);
					}
					return BuildPlacement.state();
				});
			});
		DevBridge.register("dev.build.state", 10_000, "{} - placement mode: blueprint, origin, rotation, box, conflicts {obstructed, blockEntities, "
			+ "refusals, wouldPlace, approach, site}, serverVerdict, ready, render stats, last result", (req, mc) -> DevBridge.onClient(mc,
				BuildPlacement::state));
		DevBridge.register("dev.build.rotate", 10_000, "{turns?: 1} - rotate the ghost by quarter turns (clockwise; negative = back)", (req, mc) -> {
			int t = Fields.of(req).optInt("turns", 1, -3, 3);
			return DevBridge.onClient(mc, () -> {
				requireActive();
				BuildPlacement.rotate(t);
				return BuildPlacement.state();
			});
		});
		DevBridge.register("dev.build.nudge", 10_000, "{forward?, right?, up?} - move the ghost (blocks, relative to where the player faces)",
			(req, mc) -> {
				Fields f = Fields.of(req);
				int fw = f.optInt("forward", 0, -256, 256);
				int rt = f.optInt("right", 0, -256, 256);
				int up = f.optInt("up", 0, -256, 256);
				return DevBridge.onClient(mc, () -> {
					requireActive();
					BuildPlacement.nudge(fw, rt, up);
					return BuildPlacement.state();
				});
			});
		DevBridge.register("dev.build.lock", 10_000, "{on?: bool (default: toggle)} - lock the ghost where it is / follow the look again",
			(req, mc) -> {
				Boolean on = Fields.of(req).optBool("on");
				return DevBridge.onClient(mc, () -> {
					requireActive();
					BuildPlacement.setLocked(on == null ? !BuildPlacement.locked() : on);
					return BuildPlacement.state();
				});
			});
		DevBridge.register("dev.build.confirm", 30_000, "{force?: bool} - place it (Enter; force = Shift+Enter, only after a block-entity "
			+ "refusal); replies when the server answered: {placed, siteId, message} + state", (req, mc) -> {
				boolean force = Fields.of(req).optBool("force", false);
				return DevBridge.onClient(mc, () -> {
					requireActive();
					return BuildPlacement.confirm(force);
				}).thenCompose(f -> f).thenCompose(r -> DevBridge.onClient(mc, () -> {
					JsonObject o = BuildPlacement.state();
					o.addProperty("placed", r.placed());
					o.addProperty("siteId", r.buildingId());
					o.addProperty("message", r.message());
					return o;
				}));
			});
		DevBridge.register("dev.build.cancel", 10_000, "{} - leave placement mode (Esc)", (req, mc) -> DevBridge.onClient(mc, () -> {
			BuildPlacement.cancel();
			return BuildPlacement.state();
		}));
		DevBridge.register("dev.sites.state", 10_000, "{} - the placed sites of this world, the sites taken down (pending until the next world "
			+ "start settles them, with snapshotExists), the world-start reports and snapshot files no site names", (req, mc) -> DevBridge.onClient(mc,
				Sites::json));
		DevBridge.register("dev.sites.remove", 30_000, "{site, force?: false} - Remove (restores the terrain) as the Library's Remove does",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("site");
				boolean force = f.optBool("force", false);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					try {
						Site s = Sites.get(id);
						ServerLevel sl = s == null ? level : Sites.levelOf(level.getServer(), s);
						Site gone = Sites.remove(sl == null ? level : sl, id, force);
						o.addProperty("removed", true);
						o.addProperty("restoreBox", Anchors.str(gone.restoreBox()));
					} catch (Sites.SiteException e) {
						o.addProperty("removed", false);
						o.addProperty("message", e.getMessage());
					}
					return o;
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.sites.failNextMove", 10_000, "{} - test hook: the next move fails restoring the old site and rolls back",
			(req, mc) -> DevBridge.onClient(mc, () -> {
				Sites.failNextMove();
				JsonObject o = new JsonObject();
				o.addProperty("armed", true);
				return o;
			}));
		DevBridge.register("dev.capture", 30_000, "{min: [x,y,z], max: [x,y,z], name} - save the box as a structure template (as a structure block "
			+ "would) to <gameDir>/architect/captures/<name>.nbt (authoring library designs by hand)", (req, mc) -> {
				Fields f = Fields.of(req);
				int[] a = xyz(f, "min");
				int[] b = xyz(f, "max");
				String name = f.nonBlank("name");
				if (!dev.larattalabs.architect.placement.Blueprint.ID.matcher(name).matches()) {
					throw new DevBridge.DevException("name must match [a-z0-9_]+");
				}
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					try {
						Anchors.Bounds box = new Anchors.Bounds(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]),
							Math.max(a[1], b[1]), Math.max(a[2], b[2]));
						CompoundTag tag = Sites.capture(level, box);
						java.nio.file.Path out = dev.larattalabs.architect.placement.Blueprints.gameDataDir().resolve("captures").resolve(name + ".nbt");
						java.nio.file.Files.createDirectories(out.getParent());
						net.minecraft.nbt.NbtIo.writeCompressed(tag, out);
						JsonObject o = new JsonObject();
						o.addProperty("path", out.toString());
						o.addProperty("size", (box.maxX() - box.minX() + 1) + "x" + (box.maxY() - box.minY() + 1) + "x" + (box.maxZ() - box.minZ() + 1));
						o.addProperty("dataVersion", tag.getIntOr("DataVersion", -1));
						return o;
					} catch (java.io.IOException e) {
						throw new IllegalStateException(e.getMessage(), e);
					}
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.box.hash", 60_000, "{min: [x,y,z], max: [x,y,z], cells?: false} - SHA-256 over every block state and block-entity NBT in the "
			+ "box (the player's dimension, loads chunks): before/after a place + remove proves the terrain came back exactly", (req, mc) -> {
				Fields f = Fields.of(req);
				int[] a = xyz(f, "min");
				int[] b = xyz(f, "max");
				boolean withCells = f.optBool("cells", false);
				long volume = (long) (Math.abs(b[0] - a[0]) + 1) * (Math.abs(b[1] - a[1]) + 1) * (Math.abs(b[2] - a[2]) + 1);
				if (volume > 4_000_000) {
					throw new DevBridge.DevException("box too large (" + volume + " blocks)");
				}
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> hashBox(level, a, b, withCells))).thenCompose(x -> x);
			});
	}

	/** {@code dev.box.hash}: SHA-256 of every cell's state and block entity NBT, plus counts. Server thread. */
	static JsonObject hashBox(ServerLevel level, int[] a, int[] b, boolean withCells) {
		java.util.List<String> cells = withCells ? new java.util.ArrayList<>() : null;
		try {
			MessageDigest md = MessageDigest.getInstance("SHA-256");
			BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
			int air = 0;
			int blockEntities = 0;
			for (int y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) {
				for (int z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) {
					for (int x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) {
						p.set(x, y, z);
						BlockState s = level.getBlockState(p);
						if (s.isAir()) {
							air++;
						}
						String st = NbtUtils.writeBlockState(s).toString();
						if (cells != null) {
							cells.add(x + "," + y + "," + z + " " + st);
						}
						md.update(st.getBytes(java.nio.charset.StandardCharsets.UTF_8));
						BlockEntity be = level.getBlockEntity(p);
						if (be != null) {
							blockEntities++;
							TagValueOutput out = TagValueOutput.createWithContext(ProblemReporter.DISCARDING, level.registryAccess());
							be.saveWithFullMetadata(out);
							CompoundTag t = out.buildResult();
							md.update(t.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
						}
						md.update((byte) '|');
					}
				}
			}
			JsonObject o = new JsonObject();
			o.addProperty("sha256", HexFormat.of().formatHex(md.digest()));
			o.addProperty("air", air);
			o.addProperty("blockEntities", blockEntities);
			o.addProperty("dimension", Sites.dimensionId(level));
			if (cells != null) {
				com.google.gson.JsonArray ca = new com.google.gson.JsonArray();
				cells.forEach(ca::add);
				o.add("cells", ca);
			}
			return o;
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	private static void requireActive() {
		if (!BuildPlacement.active()) {
			throw new DevBridge.DevException("not in placement mode (dev.build.start first)");
		}
	}
}
