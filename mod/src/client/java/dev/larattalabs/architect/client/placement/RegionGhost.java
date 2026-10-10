package dev.larattalabs.architect.client.placement;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.labui.client.ui.Kit;
import dev.larattalabs.labui.client.ui.Panels;
import dev.larattalabs.labui.client.ui.TextUtil;
import dev.larattalabs.labui.client.ui.UiStyle;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.placement.CompositeMesh;
import dev.larattalabs.architect.region.GhostPlan;
import dev.larattalabs.architect.region.Packed;
import dev.larattalabs.architect.region.RegionsImpl;
import dev.larattalabs.architect.region.TileStream;
import dev.larattalabs.labui.ui.Guard;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElement;
import net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * The region ghost (docs/CONTRACT.md phase 6b §3.5, {@code ArchitectClientApi.previewRegion}, {@code PreviewStyle.REGION}):
 * <ul>
 * <li>within {@link #NEAR} blocks of the player, the cells of the plan's tiles, evaluated by the helper in preview mode over the
 * plan survey ({@code region.tiles.request {preview: true}}, kit/REGIONS.md "Ghost tiles"; never written), one composite key
 * per tile (each under the composite cell cap): added green, removed red frames, path (walk) tan, lot blue, floating violet (a
 * cell inside the bounds of an op of a floating part: preview frames carry no part id);</li>
 * <li>beyond: the claim outline (at the entrance anchor's height) and the lot boxes' edges;</li>
 * <li>a verdict line at the top of the screen: the checker summary and the cell budget.</li>
 * </ul>
 * It follows the player (re-checked twice a second); tiles that fall beyond {@link #DROP} blocks are dropped. Client thread.
 */
public final class RegionGhost {
	public static final int NEAR = 64;
	static final int DROP = 128;
	static final String KEY = "region-ghost:";
	static final int ADDED = 0xFF3CCB5A;
	static final int PATH = 0xFFC8A060;
	static final int LOT = 0xFF4A90E2;
	static final int FLOATING = 0xFFB070E0;

	private static @Nullable GhostPlan plan;
	private static long gen;
	private static final Set<String> REQUESTED = new HashSet<>();
	private static final Map<String, Integer> SHOWN = new HashMap<>();
	private static final List<String> ERRORS = new ArrayList<>();
	/** When a tile's preview last failed: asked again only after {@link #RETRY_MS}. */
	private static final Map<String, Long> FAILED_AT = new HashMap<>();
	static final long RETRY_MS = 10_000;
	private static int ticks;

	private RegionGhost() {
	}

	public static void init() {
		ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.run("architect_mc:placement.regionGhost", () -> tick(mc)));
		net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents.DISCONNECT.register((h, mc) -> mc.execute(RegionGhost::hide));
		HudElementRegistry.addLast(Architect.id("hud/region_ghost"), dev.larattalabs.labui.client.ui.GuardedHud.of("architect_mc:hud.region_ghost", new Hud()));
	}

	/** Shows the ghost of {@code planId} (stages up to {@code stage}; null: all), replacing any shown. */
	public static CompletableFuture<GhostPlan> show(String planId, @Nullable String stage) {
		hide();
		long g = ++gen;
		return ServerTasks.callOnServer(s -> {
			GhostPlan p = RegionsImpl.ghostPlan(planId, stage);
			if (p == null) {
				throw new IllegalArgumentException("no region plan " + planId);
			}
			return p;
		}).thenApply(p -> {
			Minecraft.getInstance().execute(() -> {
				if (gen == g) {
					plan = p;
					far(p);
				}
			});
			return p;
		});
	}

	public static void hide() {
		gen++;
		GhostPlan p = plan;
		plan = null;
		for (String k : CompositePreview.keys()) {
			if (k.startsWith(KEY)) {
				CompositePreview.clear(k);
			}
		}
		REQUESTED.clear();
		SHOWN.clear();
		ERRORS.clear();
		FAILED_AT.clear();
		if (p != null) {
			TileStream.forgetPreviews(p.planId());
		}
	}

	public static boolean on() {
		return plan != null;
	}

	/** DevBridge {@code dev.region.ghost}: what is shown. */
	public static JsonObject state() {
		JsonObject o = new JsonObject();
		GhostPlan p = plan;
		o.addProperty("on", p != null);
		if (p == null) {
			return o;
		}
		o.addProperty("planId", p.planId());
		if (p.stage() != null) {
			o.addProperty("stage", p.stage());
		}
		o.addProperty("tiles", p.tiles().size());
		o.addProperty("tilesRequested", REQUESTED.size());
		o.addProperty("tilesShown", SHOWN.size());
		o.addProperty("cellsShown", SHOWN.values().stream().mapToInt(Integer::intValue).sum());
		o.addProperty("verdict", p.verdict());
		com.google.gson.JsonArray e = new com.google.gson.JsonArray();
		ERRORS.stream().limit(10).forEach(e::add);
		o.add("errors", e);
		return o;
	}

	private static void tick(Minecraft mc) {
		GhostPlan p = plan;
		if (p == null || mc.player == null || ++ticks % 10 != 0) {
			return;
		}
		int px = mc.player.getBlockX();
		int pz = mc.player.getBlockZ();
		List<String> near = p.tilesNear(px, pz, NEAR);
		List<String> want = new ArrayList<>();
		long now = System.currentTimeMillis();
		for (String k : near) {
			Long failed = FAILED_AT.get(k);
			if (failed != null && now - failed < RETRY_MS) {
				continue;
			}
			if (REQUESTED.add(k)) {
				want.add(k);
			}
		}
		Set<String> keep = new HashSet<>(p.tilesNear(px, pz, DROP));
		for (String k : List.copyOf(REQUESTED)) {
			if (!keep.contains(k)) {
				REQUESTED.remove(k);
				SHOWN.remove(k);
				CompositePreview.clear(KEY + k);
			}
		}
		if (want.isEmpty()) {
			return;
		}
		long g = gen;
		List<CompletableFuture<TileStream.PreviewTile>> fs = TileStream.requestPreview(p.planId(), p.irSha(), p.stage(), want);
		for (int i = 0; i < fs.size(); i++) {
			String k = want.get(i);
			fs.get(i).whenComplete((t, e) -> {
				List<CompositePreview.CellLayer> layers = e != null || t == null || t.cells == null ? null : layers(p, k, t.cells);
				mc.execute(() -> {
					if (gen != g || !REQUESTED.contains(k)) {
						return;
					}
					if (layers == null) {
						String why = e != null ? e.getMessage() : t == null ? "no answer" : t.error;
						if (ERRORS.size() < 50) {
							ERRORS.add(k + ": " + why);
						}
						REQUESTED.remove(k); // asked again after RETRY_MS
						FAILED_AT.put(k, System.currentTimeMillis());
						return;
					}
					SHOWN.put(k, t.cells.size());
					CompositePreview.showCells(KEY + k, layers);
				});
			});
		}
	}

	/** A preview tile's cells as layers: the tints in one GHOST layer (per-cell colours), the removed cells as REMOVED frames. */
	static @Nullable List<CompositePreview.CellLayer> layers(GhostPlan p, String key, Packed.Tile t) {
		if (t.size() == 0) {
			return List.of();
		}
		int[] lo = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE};
		int[] hi = {Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
		for (long pos : t.pos()) {
			int[] c = {BlockPos.getX(pos), BlockPos.getY(pos), BlockPos.getZ(pos)};
			for (int a = 0; a < 3; a++) {
				lo[a] = Math.min(lo[a], c[a]);
				hi[a] = Math.max(hi[a], c[a]);
			}
		}
		int n = t.size();
		int[] gx = new int[n * 3];
		int[] ga = new int[n];
		int[] rx = new int[n * 3];
		int gn = 0;
		int rn = 0;
		int[] tint = {ADDED, 0, PATH, LOT, FLOATING};
		for (int i = 0; i < n; i++) {
			long pos = t.pos()[i];
			int x = BlockPos.getX(pos);
			int y = BlockPos.getY(pos);
			int z = BlockPos.getZ(pos);
			boolean air = t.states().get(t.state()[i]).isAir();
			int kind = p.kind(x, y, z, air, t.walk()[i]);
			if (kind == 1) {
				rx[rn * 3] = x - lo[0];
				rx[rn * 3 + 1] = y - lo[1];
				rx[rn * 3 + 2] = z - lo[2];
				rn++;
			} else {
				gx[gn * 3] = x - lo[0];
				gx[gn * 3 + 1] = y - lo[1];
				gx[gn * 3 + 2] = z - lo[2];
				ga[gn] = tint[kind];
				gn++;
			}
		}
		BlockPos origin = new BlockPos(lo[0], lo[1], lo[2]);
		int sx = hi[0] - lo[0] + 1;
		int sy = hi[1] - lo[1] + 1;
		int sz = hi[2] - lo[2] + 1;
		List<CompositePreview.CellLayer> out = new ArrayList<>();
		if (gn > 0) {
			out.add(new CompositePreview.CellLayer("region:" + p.planId() + ":" + key + ":tint", CompositeMesh.Style.GHOST, origin, sx, sy, sz,
				java.util.Arrays.copyOf(gx, gn * 3), java.util.Arrays.copyOf(ga, gn)));
		}
		if (rn > 0) {
			int[] ra = new int[rn];
			java.util.Arrays.fill(ra, 0xFFE0302A);
			out.add(new CompositePreview.CellLayer("region:" + p.planId() + ":" + key + ":removed", CompositeMesh.Style.REMOVED, origin, sx, sy, sz,
				java.util.Arrays.copyOf(rx, rn * 3), ra));
		}
		return out;
	}

	/** Beyond 64 blocks: the claim outline at the entrance's height, and every lot box's 12 edges. */
	static void far(GhostPlan p) {
		List<int[]> cells = new ArrayList<>(); // x, y, z, argb
		int[] c = p.claim();
		int y = p.groundY();
		for (int x = c[0]; x <= c[3]; x++) {
			cells.add(new int[] {x, y, c[2], ADDED});
			cells.add(new int[] {x, y, c[5], ADDED});
		}
		for (int z = c[2] + 1; z < c[5]; z++) {
			cells.add(new int[] {c[0], y, z, ADDED});
			cells.add(new int[] {c[3], y, z, ADDED});
		}
		for (int[] b : p.lots()) {
			for (int x = b[0]; x <= b[3]; x++) {
				for (int yy : new int[] {b[1], b[4]}) {
					cells.add(new int[] {x, yy, b[2], LOT});
					cells.add(new int[] {x, yy, b[5], LOT});
				}
			}
			for (int z = b[2] + 1; z < b[5]; z++) {
				for (int yy : new int[] {b[1], b[4]}) {
					cells.add(new int[] {b[0], yy, z, LOT});
					cells.add(new int[] {b[3], yy, z, LOT});
				}
			}
			for (int yy = b[1] + 1; yy < b[4]; yy++) {
				cells.add(new int[] {b[0], yy, b[2], LOT});
				cells.add(new int[] {b[3], yy, b[2], LOT});
				cells.add(new int[] {b[0], yy, b[5], LOT});
				cells.add(new int[] {b[3], yy, b[5], LOT});
			}
		}
		if (cells.isEmpty()) {
			return;
		}
		int[] lo = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE};
		int[] hi = {Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
		for (int[] e : cells) {
			for (int a = 0; a < 3; a++) {
				lo[a] = Math.min(lo[a], e[a]);
				hi[a] = Math.max(hi[a], e[a]);
			}
		}
		int[] xyz = new int[cells.size() * 3];
		int[] argb = new int[cells.size()];
		for (int i = 0; i < cells.size(); i++) {
			int[] e = cells.get(i);
			xyz[i * 3] = e[0] - lo[0];
			xyz[i * 3 + 1] = e[1] - lo[1];
			xyz[i * 3 + 2] = e[2] - lo[2];
			argb[i] = e[3];
		}
		CompositePreview.showCells(KEY + "far", List.of(new CompositePreview.CellLayer("region:" + p.planId() + ":far", CompositeMesh.Style.GHOST,
			new BlockPos(lo[0], lo[1], lo[2]), hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1, xyz, argb)));
	}

	/** The verdict line: the checker summary and the cell budget, at the top of the screen. */
	static final class Hud implements HudElement {
		@Override
		public void extractRenderState(GuiGraphicsExtractor g, DeltaTracker deltaTracker) {
			GhostPlan p = plan;
			Minecraft mc = Minecraft.getInstance();
			if (p == null || mc.player == null) {
				return;
			}
			Font font = mc.font;
			Kit.Padding pad = Kit.padding("tooltip");
			String head = "Region plan " + p.planId() + (p.stage() == null ? "" : " up to " + p.stage()) + " · " + SHOWN.size() + " of " + p.tiles().size()
				+ " tiles near";
			int maxW = Math.min(520, g.guiWidth() - 16);
			int inner = maxW - pad.left() - pad.right();
			int w = Math.min(maxW, Math.max(font.width(head), font.width(p.verdict())) + pad.left() + pad.right());
			int h = pad.top() + 20 + pad.bottom() - 1;
			int x = (g.guiWidth() - w) / 2;
			int y = 6;
			Panels.sprite(g, Kit.TOOLTIP, x, y, w, h, 0xF0FFFFFF);
			g.text(font, TextUtil.ellipsize(font, head, inner), x + pad.left(), y + pad.top(), UiStyle.CREAM, false);
			g.text(font, TextUtil.ellipsize(font, p.verdict(), inner), x + pad.left(), y + pad.top() + 10, p.verdict().contains("NOT ok") ? 0xFFF0A060
				: UiStyle.SAGE, false);
		}
	}
}
