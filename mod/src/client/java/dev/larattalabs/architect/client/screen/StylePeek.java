package dev.larattalabs.architect.client.screen;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.client.placement.CompositePreview;
import dev.larattalabs.architect.client.placement.TemplateCells;
import dev.larattalabs.architect.library.Palettes;
import dev.larattalabs.architect.library.StyleRoles;
import dev.larattalabs.architect.library.StyleSwap;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.CompositeMesh;
import dev.larattalabs.architect.placement.TemplateGrid;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.levelgen.Heightmap;
import org.jspecify.annotations.Nullable;

/**
 * (PR P1) Preview on ghost: a design shown in the world as a locked ghost wearing a Style, materials only ({@link StyleSwap}), in front
 * of the player and ground-snapped; never placed, never a server path, never a world scan. Variant mode uses the entry's cells; New mode a
 * bundled stand-in of the chosen type (cabin by default), labelled a sample. Cost limits: models cached per (entry, Style, version), LRU 8;
 * the swap off the client thread; past {@link #MAX_DRAWN} cells (or after {@link #SLOW_FRAMES} frames over {@link #SLOW_NANOS}) only
 * the outline and the top-down shell are drawn, and the strip says so.
 */
public final class StylePeek {
	static final String KEY = "architect_mc:style_peek";
	public static final int MAX_DRAWN = 60_000;
	public static final long SLOW_NANOS = 4_000_000L;
	public static final int SLOW_FRAMES = 10;
	static final int CACHE = 8;

	/** What the peek shows: an entry, whether it is a sample stand-in, and its name. */
	public record Target(String entry, boolean sample, String name) {
	}

	/** A built model: cells relative to the box corner, their colours, the box, and whether it was thinned. */
	record Model(int[] xyz, int[] argb, int sx, int sy, int sz, int groundY, boolean thinned, boolean close) {
	}

	private static final Map<String, Model> LRU = new LinkedHashMap<>(16, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, Model> e) {
			return size() > CACHE;
		}
	};
	private static long gen;
	private static @Nullable Model shown;
	private static boolean forceThin;
	private static int slow;

	private StylePeek() {
	}

	/** Variant mode (the Library's variant form open on a design): that design; else a bundled sample of the design form's type. */
	public static @Nullable Target target() {
		if (LibraryTab.dialog == LibraryTab.Dialog.VARIANTS && dev.larattalabs.architect.client.library.LibraryFeature.selected() != null) {
			var c = dev.larattalabs.architect.client.library.LibraryFeature.selected();
			if (Blueprints.entry(c.id()) != null) {
				return new Target(c.id(), false, c.name());
			}
		}
		var f = dev.larattalabs.architect.client.design.DesignFeature.form();
		String type = f == null ? "cabin" : f.type;
		Blueprints.Entry e = Blueprints.entry(type);
		String id = e != null && e.bundled() ? type : "cabin";
		return Blueprints.entry(id) == null ? null : new Target(id, true, "a sample " + id);
	}

	/** True when the shown Style changes under a tenth of the design's blocks. */
	public static boolean close() {
		return shown != null && shown.close();
	}

	public static boolean thinned() {
		return shown != null && shown.thinned();
	}

	/** Shows {@code t} wearing {@code style} (replacing any peek). Client thread. */
	public static void show(Target t, Bible style) {
		Blueprints.Entry e = Blueprints.entry(t.entry());
		TemplateGrid grid = e == null ? null : TemplateGrid.of(e);
		if (grid == null) {
			return;
		}
		String key = t.entry() + "|" + style.id() + "|" + style.version() + "|" + Blueprints.headVersion(e) + (forceThin ? "|thin" : "");
		long g = ++gen;
		Model cached;
		synchronized (LRU) {
			cached = LRU.get(key);
		}
		if (cached != null) {
			display(cached);
			return;
		}
		boolean thin = forceThin;
		CompletableFuture.supplyAsync(() -> build(grid, style, thin)).whenComplete((m, err) -> Minecraft.getInstance().execute(() -> {
			if (err != null || m == null || g != gen) {
				return;
			}
			synchronized (LRU) {
				LRU.put(key, m);
			}
			display(m);
		}));
	}

	/** The swap and the colours, off the client thread. */
	static Model build(TemplateGrid grid, Bible style, boolean thin) {
		StyleRoles table = StyleRoles.fallback();
		Map<String, Integer> counts = new HashMap<>();
		for (BlockState s : grid.states()) {
			counts.merge(BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString(), 1, Integer::sum);
		}
		Palettes.Inputs from = StyleSwap.inferMain(table, counts);
		Palettes.Inputs to = table.mainOf(style.roles());
		StyleSwap swap = new StyleSwap(table, from, to, style.roles(), id -> {
			Identifier rl = Identifier.tryParse(id);
			return rl != null && BuiltInRegistries.BLOCK.containsKey(rl);
		});
		var bp = grid.blueprint();
		int n = grid.count();
		boolean thinned = thinAt(n, thin);
		int sx = bp.sizeX();
		int sy = bp.sizeY();
		int sz = bp.sizeZ();
		boolean[] keep = thinned ? shell(grid.xyz(), n, sx, sz) : null;
		int ring = thinned ? 2 * (sx + sz) + 4 * sy + 8 : 0;
		int[] xyz = new int[(n + ring) * 3];
		int[] argb = new int[n + ring];
		int k = 0;
		int changed = 0;
		for (int i = 0; i < n; i++) {
			int x = grid.xyz()[i * 3];
			int y = grid.xyz()[i * 3 + 1];
			int z = grid.xyz()[i * 3 + 2];
			if (keep != null && !keep[i]) {
				continue; // only the outline (the box's sides) and the top-down shell
			}
			BlockState s = grid.states()[i];
			String id = BuiltInRegistries.BLOCK.getKey(s.getBlock()).toString();
			String to2 = swap.swap(id);
			if (!to2.equals(id)) {
				changed++;
			}
			BlockState out = to2.equals(id) ? s : copy(s, BuiltInRegistries.BLOCK.getValue(Identifier.parse(to2)));
			int c = TemplateCells.color(out);
			if ((c >>> 24) == 0) {
				continue;
			}
			xyz[k * 3] = x;
			xyz[k * 3 + 1] = y;
			xyz[k * 3 + 2] = z;
			argb[k] = (0x5A << 24) | (c & 0xFFFFFF);
			k++;
		}
		if (thinned) {
			// the footprint's ring on the ground row and the four corner posts, dark, so the thinned design still has its outline
			int gy = bp.groundY();
			for (int x = 0; x < sx; x++) {
				for (int z = 0; z < sz; z++) {
					boolean edge = x == 0 || z == 0 || x == sx - 1 || z == sz - 1;
					boolean corner = (x == 0 || x == sx - 1) && (z == 0 || z == sz - 1);
					if (!edge) {
						continue;
					}
					for (int y = gy; y < (corner ? sy : gy + 1); y++) {
						if (k >= argb.length) {
							break;
						}
						xyz[k * 3] = x;
						xyz[k * 3 + 1] = y;
						xyz[k * 3 + 2] = z;
						argb[k] = 0xE0111111;
						k++;
					}
				}
			}
		}
		// close: the Style changes under a tenth of the design's blocks (it is near the design's own materials)
		boolean close = n > 0 && changed * 10 < n;
		return new Model(java.util.Arrays.copyOf(xyz, k * 3), java.util.Arrays.copyOf(argb, k), sx, sy, sz, bp.groundY(), thinned, close);
	}

	/**
	 * The cells kept when a model is thinned: those on the box's four sides and the top cell of every column (the outline and the top-down
	 * shell). Pure ({@code StylePeekTest}).
	 */
	public static boolean[] shell(int[] xyz, int n, int sx, int sz) {
		int[] top = new int[sx * sz];
		java.util.Arrays.fill(top, -1);
		for (int i = 0; i < n; i++) {
			int c = xyz[i * 3] * sz + xyz[i * 3 + 2];
			top[c] = Math.max(top[c], xyz[i * 3 + 1]);
		}
		boolean[] keep = new boolean[n];
		for (int i = 0; i < n; i++) {
			int x = xyz[i * 3];
			int y = xyz[i * 3 + 1];
			int z = xyz[i * 3 + 2];
			keep[i] = x == 0 || z == 0 || x == sx - 1 || z == sz - 1 || top[x * sz + z] == y;
		}
		return keep;
	}

	/** True when a model of {@code n} cells is drawn thinned (over the cap, or after the frame-time fallback). */
	public static boolean thinAt(int n, boolean slowFrames) {
		return slowFrames || n > MAX_DRAWN;
	}

	/** {@code to}'s default state with every property {@code s} shares (facing, half, shape, …). */
	@SuppressWarnings({"unchecked", "rawtypes"})
	static BlockState copy(BlockState s, Block to) {
		BlockState out = to.defaultBlockState();
		for (Property p : s.getProperties()) {
			for (Property q : out.getProperties()) {
				if (q.getName().equals(p.getName()) && q.getPossibleValues().contains(s.getValue(p))) {
					out = out.setValue(q, (Comparable) s.getValue(p));
				}
			}
		}
		return out;
	}

	/** In front of the player, centred on their line of sight, its ground row on the surface there. */
	private static void display(Model m) {
		Minecraft mc = Minecraft.getInstance();
		if (mc.player == null || mc.level == null) {
			return;
		}
		double yaw = Math.toRadians(mc.player.getYRot());
		// far enough that the whole design is in view above the strip
		double d = Math.max(m.sx(), Math.max(m.sy(), m.sz())) * 1.3 + 6;
		int cx = (int) Math.floor(mc.player.getX() - Math.sin(yaw) * d);
		int cz = (int) Math.floor(mc.player.getZ() + Math.cos(yaw) * d);
		int surface = mc.level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, cx, cz);
		BlockPos origin = new BlockPos(cx - m.sx() / 2, surface - m.groundY(), cz - m.sz() / 2);
		shown = m;
		CompositePreview.showCells(KEY, java.util.List.of(new CompositePreview.CellLayer("style_peek", CompositeMesh.Style.PEEK, origin, m.sx(), m.sy(), m
			.sz(), m.xyz(), m.argb())));
	}

	/** Each frame while peeking: after {@link #SLOW_FRAMES} slow frames in a row, drop to the outline. Returns true when it just did. */
	static boolean frame() {
		if (shown == null || shown.thinned()) {
			slow = 0;
			return false;
		}
		slow = CompositePreview.lastFrameNanos() > SLOW_NANOS ? slow + 1 : 0;
		if (slow >= SLOW_FRAMES) {
			forceThin = true;
			slow = 0;
			return true;
		}
		return false;
	}

	/** (PR P1) DevBridge {@code dev.pr.peek}: open the strip from the open Style browser, step, use, back, force the outline. */
	public static void devInit() {
		dev.larattalabs.architect.client.dev.DevBridge.register("dev.pr.peek", 30_000, "{open?: bool, select?: <style id>, step?: n, thin?: bool, "
			+ "back?: bool, use?: bool} - (PR P1) Preview on ghost from the open Style browser -> the strip's state", (req, mc) -> {
				var f = dev.larattalabs.architect.client.dev.Fields.of(req);
				boolean open = f.optBool("open", false);
				String select = f.optStr("select", null);
				int step = f.optInt("step", 0, -50, 50);
				boolean thin = f.optBool("thin", false);
				boolean back = f.optBool("back", false);
				boolean use = f.optBool("use", false);
				return dev.larattalabs.architect.client.dev.DevBridge.onClient(mc, () -> {
					if (thin) {
						forceThin = true;
					}
					if (mc.gui.screen() instanceof StyleBrowserScreen b) {
						if (select != null && !b.select(select)) {
							throw new dev.larattalabs.architect.client.dev.DevBridge.DevException("no Style " + select);
						}
						if (open) {
							b.previewSelected();
						}
					}
					if (mc.gui.screen() instanceof StylePeekScreen p) {
						if (step != 0) {
							p.step(step);
						}
						if (thin) {
							p.refresh();
						}
						if (use) {
							p.use();
						} else if (back) {
							p.back();
						}
					}
					com.google.gson.JsonObject o = mc.gui.screen() instanceof StylePeekScreen p ? p.stateJson() : new com.google.gson.JsonObject();
					o.addProperty("screen", mc.gui.screen() == null ? null : mc.gui.screen().getClass().getSimpleName());
					o.addProperty("shown", shown != null);
					o.addProperty("cells", shown == null ? 0 : shown.argb().length);
					return o;
				});
			});
	}

	public static void clear() {
		gen++;
		shown = null;
		forceThin = false;
		slow = 0;
		CompositePreview.clear(KEY);
	}
}
