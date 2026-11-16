package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Journal.Value;
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
		Set<BlockPos> own = s == null ? Set.of() : Sites.ownBlockEntities(s);
		List<String> where = new ArrayList<>();
		for (BlockPos p : cells) {
			if (!level.isLoaded(p) || !(level.getBlockEntity(p) instanceof Container c) || c.isEmpty()) {
				continue;
			}
			Value v = r.writes(p.asLong());
			if (v == null) {
				continue; // not this restore's cell
			}
			Map<String, Integer> decl = declared.get(p);
			Map<String, Integer> now = decl == null ? null : Fills.plainCounts(c);
			if (containerOurs(instant, decl != null, now != null && Fills.within(now, decl))) {
				continue;
			}
			// (fix b5b, review finding 5) "already restored" is the restored value's contents exactly, not the block alone (ownership's holds
			// takes any contents for a filled container). Else: at a block entity of the site's own template every item is cargo (the site
			// wrote that container; the write recreates the terrain's contents from the snapshot); at any other cell (terrain the site left,
			// or a cell written back already) what the write recreates stays, slot by slot, and everything past it is cargo.
			Map<Integer, ItemStack> restored = restoredSlots(level, v.nbt());
			if (sameContents(c, restored)) {
				continue;
			}
			Map<Integer, ItemStack> want = s == null || own.contains(p) ? Map.of() : restored;
			Taken t = takeCell(c, want::get, st -> stackOurs(decl != null, provided.contains(BuiltInRegistries.ITEM.getKey(st.getItem()).toString())));
			out.addAll(t.stacks());
			if (t.units() > 0 && c instanceof BlockEntity be) {
				Fills.touched(level, p, be);
				where.add(p.toShortString() + " (" + t.units() + ")");
			}
		}
		if (!out.isEmpty()) {
			Architect.LOGGER.warn("Removal of {}: late cargo in its container cells at {}: {} stack(s) handed out at the site, not erased", r.site(), where,
				out.size());
			record(r.site(), out, where);
		}
		return out;
	}

	/** (fix b5b) What one container cell gave up: the stacks, and their units counted off the stacks returned. */
	record Taken(List<ItemStack> stacks, int units) {
	}

	/**
	 * (fix b5b, review findings 1 and 5) Takes a container's late cargo: per slot, a stack the write recreates as it is ({@code want} of the
	 * slot: the same item and components) keeps up to that count (the write puts it back); the rest of the slot, and every slot that is not
	 * {@code ours}, is taken out. The units are counted off the stacks the container returns, never off the slot's stack after the removal (a
	 * single-item container, a decorated pot, splits its own stack to zero and returns a new one).
	 */
	static Taken takeCell(Container c, java.util.function.IntFunction<@Nullable ItemStack> want, java.util.function.Predicate<ItemStack> ours) {
		List<ItemStack> out = new ArrayList<>();
		int units = 0;
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack st = c.getItem(i);
			if (st.isEmpty() || ours.test(st)) {
				continue;
			}
			int n = takeUnits(st, want.apply(i));
			if (n <= 0) {
				continue;
			}
			ItemStack got = n >= st.getCount() ? c.removeItemNoUpdate(i) : c.removeItem(i, n);
			if (!got.isEmpty()) {
				units += got.getCount();
				out.add(got);
			}
		}
		return new Taken(out, units);
	}

	/** (pure) Whether {@code c} holds exactly {@code restored}: slot by slot, the same item, components and count; nothing else. */
	static boolean sameContents(Container c, Map<Integer, ItemStack> restored) {
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack st = c.getItem(i), w = restored.get(i);
			boolean we = w == null || w.isEmpty();
			if (st.isEmpty() != we || !st.isEmpty() && (!ItemStack.isSameItemSameComponents(st, w) || st.getCount() != w.getCount())) {
				return false;
			}
		}
		return true;
	}

	/** (pure) The units of {@code now} to take when the write recreates {@code want} in its slot. */
	static int takeUnits(ItemStack now, @Nullable ItemStack want) {
		if (want == null || want.isEmpty() || !ItemStack.isSameItemSameComponents(now, want)) {
			return now.getCount();
		}
		return Math.max(0, now.getCount() - want.getCount());
	}

	/** The stacks a restored value's block entity data holds, by slot ({@code Items}; a single-item container's {@code item}/{@code RecordItem}: slot 0). */
	static Map<Integer, ItemStack> restoredSlots(ServerLevel level, net.minecraft.nbt.@Nullable CompoundTag nbt) {
		return restoredSlots(level.registryAccess().createSerializationContext(net.minecraft.nbt.NbtOps.INSTANCE), nbt);
	}

	static Map<Integer, ItemStack> restoredSlots(com.mojang.serialization.DynamicOps<net.minecraft.nbt.Tag> ops, net.minecraft.nbt.@Nullable CompoundTag nbt) {
		Map<Integer, ItemStack> out = new HashMap<>();
		if (nbt == null) {
			return out;
		}
		if (nbt.get("Items") instanceof net.minecraft.nbt.ListTag l) {
			for (net.minecraft.nbt.Tag t : l) {
				if (t instanceof net.minecraft.nbt.CompoundTag e) {
					int slot = e.getByteOr("Slot", (byte) 0) & 255;
					ItemStack.CODEC.parse(ops, e).result().ifPresent(st -> out.put(slot, st));
				}
			}
		}
		for (String k : new String[] {"item", "RecordItem"}) {
			if (nbt.get(k) instanceof net.minecraft.nbt.CompoundTag e) {
				ItemStack.CODEC.parse(ops, e).result().ifPresent(st -> out.put(0, st));
			}
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
