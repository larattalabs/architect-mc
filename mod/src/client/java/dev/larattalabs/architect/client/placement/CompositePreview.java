package dev.larattalabs.architect.client.placement;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.PreviewLayer;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.CompositeMesh;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.MassingFiles;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.labui.ui.Guard;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderContext;
import net.fabricmc.fabric.api.client.rendering.v1.level.LevelRenderEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Composite previews ({@code ArchitectClientApi.previewComposite}, docs/CONTRACT.md "Phase 4c contract" and "4c review folded
 * in" item 6): several layers per key, several keys at once, each layer a library entry or a massing in a style's tint. A
 * layer's mesh is built once ({@link CompositeMesh}, from the placement ghost's {@link GhostModel}) on a worker thread; each
 * frame streams the prebuilt arrays with the camera offset, one {@code submitCustomGeometry} per key. Over the per-key cell cap,
 * or further than {@value CompositeMesh#FULL_DISTANCE} blocks, a layer draws as its box outline. Everything clears on world
 * leave. Client thread (the builds run on "Architect-Composite").
 */
public final class CompositePreview {
	private static final ExecutorService BUILD = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "Architect-Composite");
		t.setDaemon(true);
		return t;
	});

	/** One layer as drawn: where, and its mesh (null while building). */
	record Layer(String source, BlockPos origin, int turns, CompositeMesh.Style style, int onlyCells, @Nullable CompositeMesh mesh, boolean overCap,
		@Nullable String error) {
	}

	/** A key's composite: its generation (a newer call or a clear drops older builds) and its layers. */
	static final class Composite {
		final long generation;
		final List<PreviewLayer> request;
		volatile List<Layer> layers;
		volatile boolean built;
		volatile long buildMs;

		Composite(long generation, List<PreviewLayer> request, List<Layer> layers) {
			this.generation = generation;
			this.request = request;
			this.layers = layers;
		}
	}

	private static final Map<String, Composite> KEYS = new LinkedHashMap<>();
	private static long generation;
	// per frame stats (any thread reads)
	static volatile int lastQuads;
	static volatile int lastOutlines;
	static volatile long lastNanos;
	static volatile long maxNanos;
	static volatile long frames;
	/** Per layer at the last frame: "cells", "outline:cap" or "outline:distance" (key -> list). */
	private static volatile Map<String, List<String>> lastModes = Map.of();

	private CompositePreview() {
	}

	public static void init() {
		LevelRenderEvents.COLLECT_SUBMITS.register(ctx -> Guard.run("architect_mc:placement.composite", () -> submit(ctx)));
		ClientPlayConnectionEvents.DISCONNECT.register((handler, mc) -> mc.execute(CompositePreview::clearAll));
		dev.larattalabs.architect.client.dev.DevBridge.register("dev.composite.state", 10_000, "{reset?: false} - the composite previews: per key "
			+ "its layers (source, origin, style, cells, quads, mode cells | outline:cap | outline:distance, error), the build and the last frame "
			+ "(quads, outlines, ms, maxMs); reset clears maxMs", (req, mc) -> {
				boolean reset = req.has("reset") && req.get("reset").getAsBoolean();
				return dev.larattalabs.architect.client.dev.DevBridge.onClient(mc, () -> {
					JsonObject o = stateJson();
					if (reset) {
						resetStats();
					}
					return o;
				});
			});
		dev.larattalabs.architect.client.dev.DevBridge.register("dev.composite.clear", 10_000, "{key?} - clear one composite key, or all",
			(req, mc) -> dev.larattalabs.architect.client.dev.DevBridge.onClient(mc, () -> {
				if (req.has("key")) {
					clear(req.get("key").getAsString());
				} else {
					clearAll();
				}
				return stateJson();
			}));
	}

	static CompositeMesh.Style style(dev.larattalabs.architect.api.PreviewStyle s) {
		return CompositeMesh.Style.valueOf(s.name());
	}

	/** Whether {@code id} names a library entry or an installed massing (version). */
	public static boolean known(String id) {
		return Blueprints.entry(id) != null || MassingFiles.exists(id) || entryVersion(id) != null;
	}

	/** {@code <entry>@<version>} (phase 5b: library entries too, as 4c's massings): that version's entry, or null. */
	static Blueprints.@Nullable Entry entryVersion(String id) {
		int at = id.lastIndexOf('@');
		if (at <= 0 || Blueprints.entry(id.substring(0, at)) == null) {
			return null;
		}
		try {
			var server = Minecraft.getInstance().getSingleplayerServer();
			if (server == null) {
				return null;
			}
			Blueprints.Version v = Blueprints.version(server, id.substring(0, at), Integer.parseInt(id.substring(at + 1)));
			return v == null ? null : v.entry();
		} catch (NumberFormatException e) {
			return null;
		}
	}

	/** Shows {@code layers} under {@code key} (replacing it). Client thread. Throws IllegalArgumentException as the API says. */
	public static void show(String key, List<PreviewLayer> layers) {
		if (key == null || key.isBlank()) {
			throw new IllegalArgumentException("a composite needs a key");
		}
		if (Minecraft.getInstance().level == null) {
			throw new IllegalArgumentException("Not in a world");
		}
		for (PreviewLayer l : layers) {
			if (!known(l.blueprintId())) {
				throw new IllegalArgumentException("No design or massing " + l.blueprintId());
			}
		}
		List<PreviewLayer> req = List.copyOf(layers);
		long gen = ++generation;
		List<Layer> pending = new ArrayList<>();
		for (PreviewLayer l : req) {
			pending.add(new Layer(l.blueprintId(), l.origin(), l.rotation().ordinal(), style(l.style()), l.onlyCells() == null ? -1 : l.onlyCells().size(),
				null, false, null));
		}
		Composite c = new Composite(gen, req, pending);
		KEYS.put(key, c);
		long t0 = System.nanoTime();
		CompletableFuture.supplyAsync(() -> build(req), BUILD).whenComplete((built, err) -> Minecraft.getInstance().execute(() -> {
			Composite now = KEYS.get(key);
			if (now == null || now.generation != gen) {
				return; // replaced or cleared meanwhile
			}
			if (err != null) {
				Architect.LOGGER.warn("Composite {}: build failed", key, err);
				List<Layer> failed = new ArrayList<>();
				for (Layer l : now.layers) {
					failed.add(new Layer(l.source(), l.origin(), l.turns(), l.style(), l.onlyCells(), null, false, String.valueOf(err.getMessage())));
				}
				now.layers = failed;
			} else {
				now.layers = built;
			}
			now.buildMs = (System.nanoTime() - t0) / 1_000_000;
			now.built = true;
		}));
	}

	/** Builds every layer's mesh (worker thread): the cap decides which layers keep their cells. */
	private static List<Layer> build(List<PreviewLayer> req) {
		List<GhostModel> models = new ArrayList<>();
		List<String> errors = new ArrayList<>();
		int[] counts = new int[req.size()];
		for (int i = 0; i < req.size(); i++) {
			PreviewLayer l = req.get(i);
			try {
				Blueprints.Entry e = Blueprints.entry(l.blueprintId());
				if (e == null) {
					e = entryVersion(l.blueprintId());
				}
				if (e == null) {
					e = MassingFiles.read(l.blueprintId());
				}
				GhostModel.Cells cells = TemplateGrid.of(e).cells(TemplateCells::color);
				Set<Long> only = null;
				if (l.onlyCells() != null) {
					only = new HashSet<>();
					for (BlockPos p : l.onlyCells()) {
						only.add(CompositeMesh.cellKey(p.getX(), p.getY(), p.getZ()));
					}
				}
				GhostModel m = GhostModel.of(CompositeMesh.filter(cells, only, 0xFFB0B0B0), l.rotation().ordinal());
				models.add(m);
				counts[i] = m.visibleCount();
				errors.add(null);
			} catch (Exception ex) {
				models.add(null);
				errors.add(ex.getMessage() == null ? ex.toString() : ex.getMessage());
			}
		}
		boolean[] over = CompositeMesh.overCap(counts, CompositeMesh.MAX_CELLS);
		List<Layer> out = new ArrayList<>();
		for (int i = 0; i < req.size(); i++) {
			PreviewLayer l = req.get(i);
			GhostModel m = models.get(i);
			CompositeMesh.Style s = style(l.style());
			CompositeMesh mesh = m == null ? null : over[i] ? CompositeMesh.outlineOnly(s, m.sizeX, m.sizeY, m.sizeZ, counts[i]) : CompositeMesh.build(m, s);
			out.add(new Layer(l.blueprintId(), l.origin(), l.rotation().ordinal(), s, l.onlyCells() == null ? -1 : l.onlyCells().size(), mesh, over[i],
				errors.get(i)));
		}
		return out;
	}

	/** A layer of world cells (phase 5b, the delta ghost): a style, the box corner, and cells relative to it with their colours. */
	public record CellLayer(String source, CompositeMesh.Style style, BlockPos origin, int sizeX, int sizeY, int sizeZ, int[] xyz, int[] argb) {
	}

	/** Shows world-cell layers under {@code key} (replacing it): a delta ghost (ADDED, REMOVED, CHANGED, KEPT). Client thread. */
	public static void showCells(String key, List<CellLayer> layers) {
		if (Minecraft.getInstance().level == null) {
			throw new IllegalArgumentException("Not in a world");
		}
		long gen = ++generation;
		List<Layer> pending = new ArrayList<>();
		for (CellLayer l : layers) {
			pending.add(new Layer(l.source(), l.origin(), 0, l.style(), l.argb().length, null, false, null));
		}
		Composite c = new Composite(gen, List.of(), pending);
		KEYS.put(key, c);
		long t0 = System.nanoTime();
		CompletableFuture.supplyAsync(() -> {
			int[] counts = new int[layers.size()];
			List<GhostModel> models = new ArrayList<>();
			for (int i = 0; i < layers.size(); i++) {
				CellLayer l = layers.get(i);
				GhostModel m = GhostModel.of(new GhostModel.Cells(Math.max(1, l.sizeX()), Math.max(1, l.sizeY()), Math.max(1, l.sizeZ()), 0, l.xyz(), l
					.argb()), 0);
				models.add(m);
				counts[i] = m.visibleCount();
			}
			boolean[] over = CompositeMesh.overCap(counts, CompositeMesh.MAX_CELLS);
			List<Layer> out = new ArrayList<>();
			for (int i = 0; i < layers.size(); i++) {
				CellLayer l = layers.get(i);
				GhostModel m = models.get(i);
				CompositeMesh mesh = over[i] ? CompositeMesh.outlineOnly(l.style(), m.sizeX, m.sizeY, m.sizeZ, counts[i]) : CompositeMesh.build(m, l.style());
				out.add(new Layer(l.source(), l.origin(), 0, l.style(), counts[i], mesh, over[i], null));
			}
			return out;
		}, BUILD).whenComplete((built, err) -> Minecraft.getInstance().execute(() -> {
			Composite now = KEYS.get(key);
			if (now == null || now.generation != gen) {
				return;
			}
			if (err == null) {
				now.layers = built;
			} else {
				Architect.LOGGER.warn("Composite {}: build failed", key, err);
			}
			now.buildMs = (System.nanoTime() - t0) / 1_000_000;
			now.built = true;
		}));
	}

	/** Removes a key. */
	public static boolean clear(String key) {
		generation++;
		return KEYS.remove(key) != null;
	}

	/** Removes every key (world leave). */
	public static void clearAll() {
		generation++;
		KEYS.clear();
		lastModes = Map.of();
	}

	public static Set<String> keys() {
		return Set.copyOf(KEYS.keySet());
	}

	// ------------------------------------------------------------------ drawing

	private static void submit(LevelRenderContext ctx) {
		if (KEYS.isEmpty()) {
			return;
		}
		Vec3 cam = ctx.levelState().cameraRenderState.pos;
		if (cam == null) {
			return;
		}
		Map<String, List<String>> modes = new LinkedHashMap<>();
		int[] quads = {0};
		int[] outlines = {0};
		long[] nanos = {0};
		int[] pending = {KEYS.size()};
		for (Map.Entry<String, Composite> en : KEYS.entrySet()) {
			List<Layer> layers = en.getValue().layers;
			List<String> m = new ArrayList<>();
			for (Layer l : layers) {
				if (l.mesh() == null) {
					m.add(l.error() != null ? "error" : "building");
					continue;
				}
				CompositeMesh mesh = l.mesh();
				double d = CompositeMesh.distanceToBox(cam.x, cam.y, cam.z, l.origin().getX(), l.origin().getY(), l.origin().getZ(), l.origin().getX()
					+ mesh.sizeX, l.origin().getY() + mesh.sizeY, l.origin().getZ() + mesh.sizeZ);
				m.add(l.overCap() || !mesh.hasCells() ? "outline:cap" : CompositeMesh.tooFar(d) ? "outline:distance" : "cells");
			}
			modes.put(en.getKey(), m);
			ctx.submitNodeCollector().submitCustomGeometry(new PoseStack(), RenderTypes.debugFilledBox(), (pose, vc) -> {
				long t0 = System.nanoTime();
				for (int i = 0; i < layers.size(); i++) {
					Layer l = layers.get(i);
					CompositeMesh mesh = l.mesh();
					if (mesh == null) {
						continue;
					}
					float bx = (float) (l.origin().getX() - cam.x);
					float by = (float) (l.origin().getY() - cam.y);
					float bz = (float) (l.origin().getZ() - cam.z);
					boolean cells = "cells".equals(m.get(i));
					if (cells) {
						float[] v = mesh.xyz;
						int[] c = mesh.argb;
						// the pose is the identity (a fresh PoseStack): no matrix per vertex
						for (int q = 0; q < mesh.quads; q++) {
							int o = q * 12;
							int col = c[q];
							vc.addVertex(bx + v[o], by + v[o + 1], bz + v[o + 2]).setColor(col);
							vc.addVertex(bx + v[o + 3], by + v[o + 4], bz + v[o + 5]).setColor(col);
							vc.addVertex(bx + v[o + 6], by + v[o + 7], bz + v[o + 8]).setColor(col);
							vc.addVertex(bx + v[o + 9], by + v[o + 10], bz + v[o + 11]).setColor(col);
						}
						quads[0] += mesh.quads;
					}
					// the box outline: every layer that does not draw its cells, and every massing (its extent reads in a row)
					if (!cells || mesh.style == CompositeMesh.Style.MASSING) {
						double dist = Math.sqrt((l.origin().getX() + mesh.sizeX / 2.0 - cam.x) * (l.origin().getX() + mesh.sizeX / 2.0 - cam.x) + (l
							.origin().getZ() + mesh.sizeZ / 2.0 - cam.z) * (l.origin().getZ() + mesh.sizeZ / 2.0 - cam.z));
						float t = Math.max(cells ? 0.03f : 0.06f, (float) dist * 0.0025f);
						quads[0] += box(pose, vc, bx, by, bz, mesh.sizeX, mesh.sizeY, mesh.sizeZ, t, CompositeMesh.outlineColor(mesh.style));
						outlines[0]++;
					}
				}
				nanos[0] += System.nanoTime() - t0;
				if (--pending[0] == 0) {
					lastQuads = quads[0];
					lastOutlines = outlines[0];
					lastNanos = nanos[0];
					maxNanos = Math.max(maxNanos, nanos[0]);
					frames++;
				}
			});
		}
		lastModes = modes;
	}

	/** The 12 edges of a box as thin bars of half-thickness {@code t}. */
	private static int box(PoseStack.Pose p, VertexConsumer vc, float x, float y, float z, float w, float h, float d, float t, int argb) {
		int n = 0;
		for (int a = 0; a <= 1; a++) {
			for (int b = 0; b <= 1; b++) {
				n += bar(p, vc, x - t, y + a * h - t, z + b * d - t, x + w + t, y + a * h + t, z + b * d + t, argb);
				n += bar(p, vc, x + b * w - t, y + a * h - t, z - t, x + b * w + t, y + a * h + t, z + d + t, argb);
				n += bar(p, vc, x + a * w - t, y - t, z + b * d - t, x + a * w + t, y + h + t, z + b * d + t, argb);
			}
		}
		return n;
	}

	private static int bar(PoseStack.Pose p, VertexConsumer vc, float x0, float y0, float z0, float x1, float y1, float z1, int c) {
		quad(p, vc, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, c);
		quad(p, vc, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, c);
		quad(p, vc, x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, c);
		quad(p, vc, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, c);
		quad(p, vc, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, c);
		quad(p, vc, x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, c);
		return 6;
	}

	private static void quad(PoseStack.Pose p, VertexConsumer vc, float ax, float ay, float az, float bx, float by, float bz, float cx, float cy,
		float cz, float dx, float dy, float dz, int argb) {
		vc.addVertex(p, ax, ay, az).setColor(argb);
		vc.addVertex(p, bx, by, bz).setColor(argb);
		vc.addVertex(p, cx, cy, cz).setColor(argb);
		vc.addVertex(p, dx, dy, dz).setColor(argb);
	}

	// ------------------------------------------------------------------ DevBridge

	/** For the DevBridge ({@code dev.composite.state}): per key its layers, cells, mode and why, the build and the last frame. */
	public static JsonObject stateJson() {
		JsonObject o = new JsonObject();
		JsonObject keys = new JsonObject();
		Map<String, List<String>> modes = lastModes;
		for (Map.Entry<String, Composite> en : KEYS.entrySet()) {
			Composite c = en.getValue();
			JsonObject k = new JsonObject();
			k.addProperty("generation", c.generation);
			k.addProperty("built", c.built);
			k.addProperty("buildMs", c.buildMs);
			JsonArray ls = new JsonArray();
			int cells = 0;
			int quads = 0;
			List<String> m = modes.getOrDefault(en.getKey(), List.of());
			for (int i = 0; i < c.layers.size(); i++) {
				Layer l = c.layers.get(i);
				JsonObject j = new JsonObject();
				j.addProperty("source", l.source());
				j.addProperty("origin", l.origin().getX() + "," + l.origin().getY() + "," + l.origin().getZ());
				j.addProperty("turns", l.turns());
				j.addProperty("style", l.style().name());
				j.addProperty("onlyCells", l.onlyCells());
				if (l.mesh() != null) {
					j.addProperty("cells", l.mesh().cells);
					j.addProperty("quads", l.mesh().quads);
					j.addProperty("size", l.mesh().sizeX + "x" + l.mesh().sizeY + "x" + l.mesh().sizeZ);
					if (!l.overCap()) {
						cells += l.mesh().cells;
					}
					quads += l.mesh().quads;
				}
				j.addProperty("overCap", l.overCap());
				j.addProperty("mode", i < m.size() ? m.get(i) : "not drawn yet");
				j.addProperty("error", l.error());
				ls.add(j);
			}
			k.add("layers", ls);
			k.addProperty("cells", cells);
			k.addProperty("quads", quads);
			keys.add(en.getKey(), k);
		}
		o.add("keys", keys);
		o.addProperty("maxCells", CompositeMesh.MAX_CELLS);
		o.addProperty("fullDistance", CompositeMesh.FULL_DISTANCE);
		JsonObject f = new JsonObject();
		f.addProperty("quads", lastQuads);
		f.addProperty("outlines", lastOutlines);
		f.addProperty("ms", lastNanos / 1e6);
		f.addProperty("maxMs", maxNanos / 1e6);
		f.addProperty("frames", frames);
		o.add("lastFrame", f);
		return o;
	}

	/** Resets the frame-time maximum (DevBridge, before a measurement). */
	public static void resetStats() {
		maxNanos = 0;
	}
}
