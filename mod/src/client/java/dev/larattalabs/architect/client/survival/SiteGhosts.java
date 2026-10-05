package dev.larattalabs.architect.client.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.Builder;
import dev.larattalabs.architect.site.Construction;
import dev.larattalabs.architect.survival.CellBits;
import dev.larattalabs.architect.survival.SiteNet;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.BitSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * The client's construction-site ghosts (docs/CONTRACT.md phase 3 "Ghost"): built from {@code site_ghost} (queue cells,
 * their states, the built bitset) and kept current by {@code site_progress} deltas; {@code site_status} adds the HUD line
 * and which items the crate holds (the green tint). Client thread.
 */
public final class SiteGhosts {
	/** How many of the next remaining cells (queue order) may be tinted green when their item is in the crate. */
	static final int NEXT = 48;

	/** One site's ghost. Cells are queue indexes; {@code faces} is the 6-bit exposed-face mask of each remaining cell. */
	static final class Ghost {
		final String siteId;
		final String blueprint;
		final String name;
		final int ox;
		final int oy;
		final int oz;
		final int dx;
		final int dz;
		final int[] queue;
		final BlockState[] states;
		final BitSet built;
		final int[] item; // index into items per cell (its first cost item), -1 = none
		final List<String> items;
		int[] faces;
		SiteNet.@Nullable SiteStatus status;
		long version;

		Ghost(SiteNet.SiteGhost p) {
			this.siteId = p.siteId();
			this.blueprint = p.blueprintId();
			this.name = p.name();
			this.ox = p.ox();
			this.oy = p.oy();
			this.oz = p.oz();
			this.dx = p.dx();
			this.dz = p.dz();
			this.queue = CellBits.decodeInts(p.queue());
			this.states = new BlockState[queue.length];
			this.built = CellBits.fromWords(p.built());
			this.item = new int[queue.length];
			Map<String, Integer> itemIdx = new LinkedHashMap<>();
			for (int i = 0; i < queue.length; i++) {
				states[i] = i < p.stateIds().length ? Block.stateById(p.stateIds()[i]) : Block.stateById(0);
				List<SurvivalItems.Cost> c = Builder.costOf(states[i]);
				item[i] = c.isEmpty() ? -1 : itemIdx.computeIfAbsent(c.get(0).item(), k -> itemIdx.size());
			}
			this.items = List.copyOf(itemIdx.keySet());
			recomputeFaces();
		}

		int x(int i) {
			return ox + queue[i] % dx;
		}

		int y(int i) {
			return oy + queue[i] / dx / dz;
		}

		int z(int i) {
			return oz + queue[i] / dx % dz;
		}

		int remaining() {
			return queue.length - built.cardinality();
		}

		void recomputeFaces() {
			Set<Integer> rest = new HashSet<>();
			for (int i = built.nextClearBit(0); i < queue.length; i = built.nextClearBit(i + 1)) {
				rest.add(queue[i]);
			}
			int[] f = new int[queue.length];
			int layer = dx * dz;
			for (int i = built.nextClearBit(0); i < queue.length; i = built.nextClearBit(i + 1)) {
				int k = queue[i];
				int x = k % dx;
				int z = k / dx % dz;
				int m = 0;
				if (!rest.contains(k - layer)) m |= 1;
				if (!rest.contains(k + layer)) m |= 2;
				if (z == 0 || !rest.contains(k - dx)) m |= 4;
				if (z == dz - 1 || !rest.contains(k + dx)) m |= 8;
				if (x == 0 || !rest.contains(k - 1)) m |= 16;
				if (x == dx - 1 || !rest.contains(k + 1)) m |= 32;
				f[i] = m;
			}
			faces = f;
			version++;
		}

		/** The next {@link #NEXT} remaining cells whose item the crate holds (green). */
		Set<Integer> nextDelivered() {
			Set<Integer> out = new HashSet<>();
			SiteNet.SiteStatus s = status;
			if (s == null) {
				return out;
			}
			Set<String> have = new HashSet<>(s.available());
			int seen = 0;
			for (int i = built.nextClearBit(0); i < queue.length && seen < NEXT * 4 && out.size() < NEXT; i = built.nextClearBit(i + 1)) {
				seen++;
				if (item[i] < 0 || have.contains(items.get(item[i]))) {
					out.add(i);
				}
			}
			return out;
		}
	}

	private static final Map<String, Ghost> GHOSTS = new HashMap<>();

	private SiteGhosts() {
	}

	static Map<String, Ghost> all() {
		return GHOSTS;
	}

	static void onGhost(SiteNet.SiteGhost p) {
		Ghost old = GHOSTS.get(p.siteId());
		Ghost g = new Ghost(p);
		if (old != null) {
			g.status = old.status;
		}
		GHOSTS.put(p.siteId(), g);
	}

	static void onProgress(SiteNet.SiteProgress p) {
		Ghost g = GHOSTS.get(p.siteId());
		if (g == null) {
			return;
		}
		if (CellBits.apply(g.built, CellBits.decodeInts(p.newlyBuilt()), g.queue.length) > 0) {
			g.recomputeFaces();
		}
	}

	static void onStatus(SiteNet.SiteStatus s) {
		Ghost g = GHOSTS.get(s.siteId());
		if (g != null) {
			g.status = s;
		}
	}

	static void onClear(SiteNet.SiteClear c) {
		GHOSTS.remove(c.siteId());
	}

	static void clear() {
		GHOSTS.clear();
	}

	/** DevBridge {@code dev.ghosts.state}: what the client holds for each building site. */
	public static JsonObject json() {
		JsonObject o = new JsonObject();
		JsonArray arr = new JsonArray();
		for (Ghost g : GHOSTS.values()) {
			JsonObject j = new JsonObject();
			j.addProperty("site", g.siteId);
			j.addProperty("name", g.name);
			j.addProperty("blueprint", g.blueprint);
			j.addProperty("cells", g.queue.length);
			j.addProperty("built", g.built.cardinality());
			j.addProperty("remaining", g.remaining());
			j.addProperty("green", g.nextDelivered().size());
			if (g.status != null) {
				j.addProperty("hud", SiteHud.line(g));
				j.addProperty("paused", g.status.paused());
				j.addProperty("blocked", g.status.blocked());
			}
			arr.add(j);
		}
		o.add("ghosts", arr);
		return o;
	}

	static int index(int x, int y, int z, Ghost g) {
		return Construction.index(x - g.ox, y - g.oy, z - g.oz, g.dx, g.dz);
	}
}
