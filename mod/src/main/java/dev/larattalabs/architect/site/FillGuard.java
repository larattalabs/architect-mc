package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.CompoundContainer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import org.jspecify.annotations.Nullable;

/**
 * (FK-b, docs/CONTRACT.md "### FK-b contract" 5) Keeps a fill's module-provided items ({@link dev.larattalabs.architect.api.Limits#FILL_PROVIDED_ITEMS})
 * out of survival. Every hook asks {@link #guarded}: the stack's item is allow-listed (an identity check, almost always no), its container
 * is a declared container of a filled site (a per-dimension position index, never a scan of {@code Sites.all()}), and that container's
 * declaration marks the item provided. Petrified slabs anywhere else behave as vanilla.
 *
 * <p>The hooks: a break's strip ({@code BlockEntityStripMixin}, at the head of {@code preRemoveSideEffects}, before vanilla drops the
 * rest), a menu take ({@code SlotMayPickupMixin}, a non-creative player), a hopper's pull and push ({@code HopperGuardMixin}), and the
 * Fabric Transfer API ({@code ContainerSlotWrapperMixin}, optional: {@link #transferGuardApplied()}).
 *
 * <p>The index is rebuilt lazily after {@link #invalidate} (any fill phase written, a fill's commit, the load), from the sites whose fill
 * is written or being written ({@link Fills#guardedSite}: FILLING, FILLED, UNLOCKED or the ledger's marker, so creative sites count, and
 * so does a FILLING site the world saved ahead of its ledger (FK3) until the reconcile at start has run). An entry stays while its site's record
 * stands (a removal's custody take keeps it: a removal ending unwritten writes the slabs back), and a hit is checked against the live
 * record, so a removed site's cells stop being guarded at once. Server thread.
 */
public final class FillGuard {
	private FillGuard() {
	}

	/** A declared container: its site and the items its declaration marks provided. */
	record Entry(String site, Set<Item> provided) {
	}

	private static volatile @Nullable Set<Item> items;
	private static final Map<String, Long2ObjectOpenHashMap<Entry>> INDEX = new HashMap<>();
	private static volatile boolean dirty = true;

	/** The allow-listed items (resolved once). */
	static Set<Item> providedItems() {
		Set<Item> s = items;
		if (s == null) {
			java.util.Set<Item> out = new java.util.HashSet<>();
			for (String id : dev.larattalabs.architect.api.Limits.FILL_PROVIDED_ITEMS) {
				BuiltInRegistries.ITEM.getOptional(Identifier.parse(id)).ifPresent(out::add);
			}
			s = items = Set.copyOf(out);
		}
		return s;
	}

	/** Whether an item is allow-listed (the hot paths' first check). */
	public static boolean allowListed(ItemStack st) {
		return !st.isEmpty() && providedItems().contains(st.getItem());
	}

	/** The index is stale: rebuilt at the next lookup. */
	public static void invalidate() {
		dirty = true;
	}

	private static void rebuild(MinecraftServer srv) {
		INDEX.clear();
		for (Site s : Sites.all()) {
			if (Fills.phase(s) == null && s.construction() == null) {
				continue; // never a fill site (a fill's site always carries its phase from its first step)
			}
			declared(srv, s).forEach((pos, set) -> INDEX.computeIfAbsent(s.dimension(), d -> new Long2ObjectOpenHashMap<>()).put(pos.longValue(),
				new Entry(s.id(), set)));
		}
		dirty = false;
	}

	/** A site's declared containers with provided items, by world cell, when its fill is written or being written; empty otherwise. */
	static Map<Long, Set<Item>> declared(MinecraftServer srv, Site s) {
		Fills.Spec spec = Fills.of(srv, s);
		if (spec == null || spec.provided().isEmpty() || !Fills.guardedSite(s)) {
			return Map.of();
		}
		Map<Long, Set<Item>> out = new HashMap<>();
		for (Fills.Box b : spec.containers()) {
			if (b.providedItems().isEmpty()) {
				continue;
			}
			Set<Item> set = new java.util.HashSet<>();
			b.providedItems().forEach(id -> BuiltInRegistries.ITEM.getOptional(Identifier.parse(id)).ifPresent(set::add));
			out.put(Fills.world(s, b.x(), b.y(), b.z()).asLong(), Set.copyOf(set));
		}
		return out;
	}

	/** (dev) How many of a site's declared containers are guarded now. */
	static int declaredCount(MinecraftServer srv, Site s) {
		return declared(srv, s).size();
	}

	/** The declared container at a cell of a filled site, checked against the live record; null for any other cell. */
	static @Nullable Entry at(ServerLevel level, BlockPos pos) {
		if (dirty) {
			rebuild(level.getServer());
		}
		Long2ObjectOpenHashMap<Entry> m = INDEX.get(Sites.dimensionId(level));
		Entry e = m == null ? null : m.get(pos.asLong());
		if (e == null) {
			return null;
		}
		Site s = Sites.get(e.site());
		if (s == null || !Fills.guardedSite(s)) {
			dirty = true; // the site left (removed, or its record changed): the index follows at the next lookup
			return null;
		}
		return e;
	}

	/** Whether {@code st} is a provided stack in the declared container at {@code pos}. */
	public static boolean guarded(@Nullable Level level, BlockPos pos, ItemStack st) {
		if (!(level instanceof ServerLevel sl) || !allowListed(st)) {
			return false;
		}
		Entry e = at(sl, pos);
		return e != null && e.provided().contains(st.getItem());
	}

	/** A container slot resolved to its block entity (a double chest's half by slot), or null (not a block's container). */
	record Cell(BlockEntity be, int slot) {
	}

	static @Nullable Cell resolve(Container c, int slot) {
		if (c instanceof CompoundContainer cc && cc instanceof dev.larattalabs.architect.mixin.CompoundContainerAccessor acc) {
			Container first = acc.architect$first();
			int n = first.getContainerSize();
			return slot < n ? resolve(first, slot) : resolve(acc.architect$second(), slot - n);
		}
		return c instanceof BlockEntity be ? new Cell(be, slot) : null;
	}

	/** Whether the stack in slot {@code slot} of {@code c} is a guarded provided stack. */
	public static boolean guardedSlot(Container c, int slot, ItemStack st) {
		if (!allowListed(st)) {
			return false;
		}
		Cell cell = resolve(c, slot);
		return cell != null && guarded(cell.be().getLevel(), cell.be().getBlockPos(), st);
	}

	/** (5b) A menu slot: a non-creative player can't pick up a guarded provided stack. */
	public static boolean refusesPickup(Container c, int slot, ItemStack st, Player player) {
		return !player.isCreative() && guardedSlot(c, slot, st);
	}

	/**
	 * (5a) A declared container about to go (any break; vanilla drops its contents next): its provided stacks destroyed and counted
	 * ({@link Fills#STRIPPED}). Writes no ledger record: {@code provided[key]} stays until the removal.
	 */
	public static void strip(ServerLevel level, BlockPos pos, Container c) {
		boolean any = false;
		for (int i = 0; i < c.getContainerSize() && !any; i++) {
			any = allowListed(c.getItem(i));
		}
		if (!any) {
			return;
		}
		Entry e = at(level, pos);
		if (e == null) {
			return;
		}
		int n = 0;
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack st = c.getItem(i);
			if (!st.isEmpty() && e.provided().contains(st.getItem())) {
				n += st.getCount();
				c.setItem(i, ItemStack.EMPTY);
			}
		}
		if (n > 0) {
			Fills.STRIPPED += n;
			Architect.LOGGER.info("Site {}: the declared container at {} went; its {} provided item(s) destroyed, never dropped", e.site(), pos.toShortString(), n);
		}
	}

	// ------------------------------------------------------------------ (5d) the Fabric Transfer API guard

	/** The Fabric impl class the optional guard targets. */
	public static final String TRANSFER_WRAPPER = "net.fabricmc.fabric.impl.transfer.item.ContainerSlotWrapper";

	/** Whether the optional Transfer API guard applied (its config plugin's record, {@code TransferGuardPlugin}). */
	public static boolean transferGuardApplied() {
		return dev.larattalabs.architect.compat.TransferGuardPlugin.applied;
	}

	private static boolean warned;

	private static volatile java.lang.reflect.@Nullable Field storageField;
	private static volatile java.lang.reflect.@Nullable Field containerField;
	private static volatile java.lang.reflect.@Nullable Field slotField;

	/**
	 * At start: loads the wrapper (so the optional mixin has had its chance to apply) and logs a WARN when the guard is off. Returns
	 * whether it is on.
	 */
	public static boolean checkTransferGuard() {
		try {
			Class.forName(TRANSFER_WRAPPER, false, FillGuard.class.getClassLoader());
		} catch (ClassNotFoundException | LinkageError e) {
			// no wrapper: the guard can't apply
		}
		boolean on = transferGuardApplied();
		if (!on && !warned) {
			warned = true;
			Architect.LOGGER.warn("fill-provided guard for the Fabric Transfer API inactive: provided items can be extracted by pipe mods");
		}
		return on;
	}

	/**
	 * (5d, from the optional mixin) Whether a Transfer API extraction of {@code item} from the wrapper's slot is refused (0 extracted). The
	 * wrapper's container and slot are read by reflection (Fabric impl fields), only for an allow-listed item.
	 */
	/**
	 * (slice T1, §3.6 "Holds") Whether a Transfer API move through the wrapper touches a container an open txn holds (0 moved): the
	 * Fabric Transfer API's hopper fallback and other mods' pipes. O(1) with no txn open; an unreadable wrapper fails closed while any
	 * txn is open.
	 */
	public static boolean txnHeld(Object wrapper) {
		if (dev.larattalabs.architect.txn.TxnServer.core().holds().isEmpty()) {
			return false;
		}
		try {
			java.lang.reflect.Field sf = storageField;
			if (sf == null) {
				sf = wrapper.getClass().getDeclaredField("storage");
				sf.setAccessible(true);
				storageField = sf;
			}
			Object storage = sf.get(wrapper);
			java.lang.reflect.Field cf = containerField;
			if (cf == null) {
				cf = storage.getClass().getDeclaredField("container");
				cf.setAccessible(true);
				containerField = cf;
			}
			Object c = cf.get(storage);
			return c instanceof net.minecraft.world.level.block.entity.BlockEntity be && dev.larattalabs.architect.txn.TxnServer.boxHeld(be.getLevel(), be
				.getBlockPos());
		} catch (ReflectiveOperationException | RuntimeException e) {
			Architect.LOGGER.error("txn hold guard for the Fabric Transfer API: {} (move refused while a txn is open)", e.toString());
			return true;
		}
	}

	public static boolean refusesExtract(Object wrapper, Item item) {
		if (!providedItems().contains(item)) {
			return false;
		}
		try {
			java.lang.reflect.Field sf = storageField;
			if (sf == null) {
				sf = wrapper.getClass().getDeclaredField("storage");
				sf.setAccessible(true);
				storageField = sf;
			}
			Object storage = sf.get(wrapper);
			java.lang.reflect.Field cf = containerField;
			if (cf == null) {
				cf = storage.getClass().getDeclaredField("container");
				cf.setAccessible(true);
				containerField = cf;
			}
			java.lang.reflect.Field lf = slotField;
			if (lf == null) {
				lf = wrapper.getClass().getDeclaredField("slot");
				lf.setAccessible(true);
				slotField = lf;
			}
			Container c = (Container) cf.get(storage);
			int slot = lf.getInt(wrapper);
			return slot < c.getContainerSize() && guardedSlot(c, slot, c.getItem(slot));
		} catch (ReflectiveOperationException | RuntimeException e) {
			Architect.LOGGER.error("fill-provided guard for the Fabric Transfer API: {} (extraction refused)", e.toString());
			return true; // fail closed: an allow-listed item, the wrapper unreadable
		}
	}
}
