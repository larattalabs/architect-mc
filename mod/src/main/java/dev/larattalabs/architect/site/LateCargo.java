package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import org.jspecify.annotations.Nullable;

/**
 * (Slice LC, Steward's S-M5-12) A removal's late cargo: what a container cell of the removal holds in the tick its restore writes it. The
 * blocker scan runs ticks before the writes (a group, stage or region removal plans and commits over ticks), and the restore's writes skip
 * block-entity side effects, so an item put into any container cell between the scan and the write would be erased. In the write's own tick,
 * right before it, every container cell the restore writes (and that does not already hold the restored value) gives up its stacks; they drop
 * at the site, kept from the removal's drop clear (FK {@code writeBack}'s rule for items with no slot: at the site, never lost).
 *
 * <p>What stays with the write (never handed out): in a creative (instant) site's declared fill container, contents within the declaration
 * (FK §5: creative contents go with the cell's write); in any fill site's declared container, its provided item ids (FK-b: a provided item
 * never reaches survival). A survival site's declared containers are empty after the custody take, so anything in them is cargo.
 */
public final class LateCargo {
	private LateCargo() {
	}

	/** (pure) Whether a whole container stays with the write: a creative site's declared container holding at most its declaration. */
	static boolean containerOurs(boolean instant, boolean declared, boolean withinDeclaration) {
		return instant && declared && withinDeclaration;
	}

	/** (pure) Whether one stack stays with the write: a provided item id in a fill site's declared container. */
	static boolean stackOurs(boolean declared, boolean providedId) {
		return declared && providedId;
	}

	/** The positions of the container cells in the box that {@code r} writes. */
	static List<BlockPos> containerCells(ServerLevel level, SiteJournal.Restore r, Anchors.@Nullable Bounds box) {
		List<BlockPos> out = new ArrayList<>();
		Anchors.Bounds b = box;
		if (r.box() != null) {
			b = b == null ? r.box() : Sites.union(b, r.box());
		}
		if (b == null) {
			return out;
		}
		Sites.forEachBlockEntity(level, b, be -> {
			if (be instanceof Container && r.writes(be.getBlockPos().asLong()) != null) {
				out.add(be.getBlockPos().immutable());
			}
		});
		return out;
	}

	/**
	 * Takes the late cargo out of {@code cells} (container cells {@code r} writes) in this tick: each one that does not already hold the
	 * value the restore writes gives up every stack that isn't ours (see the class). Returns the stacks; the caller drops them after its
	 * drop clear ({@link #drop}).
	 */
	static List<ItemStack> take(ServerLevel level, SiteJournal.Restore r, @Nullable Site s, List<BlockPos> cells) {
		List<ItemStack> out = new ArrayList<>();
		if (cells.isEmpty()) {
			return out;
		}
		Map<BlockPos, Map<String, Integer>> declared = s == null ? Map.of() : declaredCells(level, s);
		Set<String> provided = s == null ? Set.of() : providedIds(level, s);
		boolean instant = s == null || s.construction() == null;
		List<String> where = new ArrayList<>();
		for (BlockPos p : cells) {
			if (!level.isLoaded(p) || !(level.getBlockEntity(p) instanceof Container c) || c.isEmpty()) {
				continue;
			}
			Value v = r.writes(p.asLong());
			if (v == null || WorldJournal.holds(level, p.asLong(), v)) {
				continue; // not this restore's cell, or already written back (its restored contents are the terrain's)
			}
			Map<String, Integer> decl = declared.get(p);
			Map<String, Integer> now = decl == null ? null : Fills.plainCounts(c);
			if (containerOurs(instant, decl != null, now != null && Fills.within(now, decl))) {
				continue;
			}
			int n = 0;
			for (int i = 0; i < c.getContainerSize(); i++) {
				ItemStack st = c.getItem(i);
				if (st.isEmpty() || stackOurs(decl != null, provided.contains(BuiltInRegistries.ITEM.getKey(st.getItem()).toString()))) {
					continue;
				}
				out.add(c.removeItemNoUpdate(i));
				n += st.getCount();
			}
			if (n > 0 && c instanceof BlockEntity be) {
				Fills.touched(level, p, be);
				where.add(p.toShortString() + " (" + n + ")");
			}
		}
		if (!out.isEmpty()) {
			Architect.LOGGER.warn("Removal of {}: late cargo in its container cells at {}: {} stack(s) handed out at the site, not erased", r.site(), where,
				out.size());
			record(r.site(), out, where);
		}
		return out;
	}

	/** Drops {@code stacks} at {@code at} as item entities ({@code keep}: the removal's drop clear leaves them). */
	static void drop(ServerLevel level, BlockPos at, List<ItemStack> stacks, @Nullable Consumer<ItemEntity> keep) {
		for (ItemStack st : stacks) {
			ItemEntity ie = new ItemEntity(level, at.getX() + 0.5, at.getY() + 0.25, at.getZ() + 0.5, st, 0, 0, 0);
			ie.setDefaultPickUpDelay();
			level.addFreshEntity(ie);
			if (keep != null) {
				keep.accept(ie);
			}
		}
		if (!stacks.isEmpty() && LAST != null) {
			LAST.addProperty("at", at.getX() + "," + at.getY() + "," + at.getZ());
		}
	}

	/** A note for the removal's result, or null. */
	static @Nullable String note(List<ItemStack> stacks, BlockPos at) {
		if (stacks.isEmpty()) {
			return null;
		}
		int n = stacks.stream().mapToInt(ItemStack::getCount).sum();
		return n + " item(s) put into its containers after the removal began were dropped at " + at.toShortString() + " (late cargo, not erased)";
	}

	private static Map<BlockPos, Map<String, Integer>> declaredCells(ServerLevel level, Site s) {
		Fills.Spec spec = Fills.of(level.getServer(), s);
		if (spec == null) {
			return Map.of();
		}
		Map<BlockPos, Map<String, Integer>> out = new HashMap<>();
		for (Fills.Box b : spec.containers()) {
			out.put(Fills.world(s, b.x(), b.y(), b.z()), b.counts());
		}
		return out;
	}

	private static Set<String> providedIds(ServerLevel level, Site s) {
		Fills.Spec spec = Fills.of(level.getServer(), s);
		return spec == null ? Set.of() : spec.provided().keySet();
	}

	// ------------------------------------------------------------------ TEST hooks (dev.removal.*, docs/DEVBRIDGE.md "Slice LC")

	private static final Map<String, List<Object[]>> INJECT = new HashMap<>();
	private static final Set<String> FAIL = new java.util.HashSet<>();
	private static @Nullable JsonObject LAST;

	/** (TEST, {@code dev.removal.lateCargo}) Arms one injection: the next removal of {@code site} puts {@code items} into the container at pos. */
	public static synchronized void armInject(String site, BlockPos pos, Map<String, Integer> items) {
		INJECT.computeIfAbsent(site, k -> new ArrayList<>()).add(new Object[] {pos.immutable(), new TreeMap<>(items)});
	}

	/** (TEST, {@code dev.removal.failAfterCustody}) Arms: the next removal of {@code site} ends unwritten right after its custody is saved. */
	public static synchronized void armFail(String site) {
		FAIL.add(site);
	}

	/** (TEST) Disarms everything. */
	public static synchronized void clear() {
		INJECT.clear();
		FAIL.clear();
		LAST = null;
	}

	/**
	 * (TEST) Called by a removal right after its custody is saved, ticks before its writes: the armed items go into their containers (into
	 * free or matching slots, as a hopper or a player's menu would), so the late-cargo window is hit on purpose.
	 */
	static synchronized void injectArmed(ServerLevel level, String site) {
		List<Object[]> todo = INJECT.remove(site);
		if (todo == null) {
			return;
		}
		for (Object[] t : todo) {
			BlockPos p = (BlockPos) t[0];
			@SuppressWarnings("unchecked")
			Map<String, Integer> items = (Map<String, Integer>) t[1];
			level.getChunk(p);
			if (!(level.getBlockEntity(p) instanceof Container c)) {
				Architect.LOGGER.warn("dev.removal.lateCargo: no container at {}", p.toShortString());
				continue;
			}
			for (var e : items.entrySet()) {
				var item = BuiltInRegistries.ITEM.getValue(Identifier.parse(e.getKey()));
				int left = e.getValue();
				for (int i = 0; i < c.getContainerSize() && left > 0; i++) {
					ItemStack st = c.getItem(i);
					if (st.isEmpty()) {
						int n = Math.min(left, item.getDefaultMaxStackSize());
						c.setItem(i, new ItemStack(item, n));
						left -= n;
					} else if (st.is(item) && st.getComponentsPatch().isEmpty() && st.getCount() < st.getMaxStackSize()) {
						int n = Math.min(left, st.getMaxStackSize() - st.getCount());
						st.grow(n);
						left -= n;
					}
				}
			}
			if (c instanceof BlockEntity be) {
				Fills.touched(level, p, be);
			}
			Architect.LOGGER.warn("dev.removal.lateCargo: {} put into the container at {} after {}'s removal scan (TEST)", items, p.toShortString(), site);
		}
	}

	/** (TEST) The first armed failure among {@code ids} (disarmed), or null. */
	static synchronized @Nullable String failArmed(List<String> ids) {
		for (String id : ids) {
			if (FAIL.remove(id)) {
				Architect.LOGGER.warn("dev.removal.failAfterCustody: the removal of {} ends unwritten after its custody was saved (TEST)", id);
				return id;
			}
		}
		return null;
	}

	private static synchronized void record(String site, List<ItemStack> stacks, List<String> where) {
		JsonObject o = new JsonObject();
		o.addProperty("site", site);
		JsonObject items = new JsonObject();
		Map<String, Integer> m = new TreeMap<>();
		for (ItemStack st : stacks) {
			m.merge(BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
		}
		m.forEach(items::addProperty);
		o.add("items", items);
		JsonArray w = new JsonArray();
		where.forEach(w::add);
		o.add("cells", w);
		LAST = o;
	}

	/** (TEST, {@code dev.removal.state}) The armed hooks and the last late cargo handed out. */
	public static synchronized JsonObject stateJson() {
		JsonObject o = new JsonObject();
		JsonArray in = new JsonArray();
		INJECT.keySet().forEach(in::add);
		o.add("injectArmed", in);
		JsonArray f = new JsonArray();
		FAIL.forEach(f::add);
		o.add("failArmed", f);
		o.add("last", LAST == null ? null : LAST.deepCopy());
		return o;
	}
}
