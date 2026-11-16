package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.serialization.Codec;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Consumer;
import java.util.function.Predicate;
import net.fabricmc.fabric.api.attachment.v1.AttachmentRegistry;
import net.fabricmc.fabric.api.attachment.v1.AttachmentType;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.CampfireBlockEntity;
import net.minecraft.world.level.block.entity.LecternBlockEntity;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (Slice LC, Steward's S-M5-12; slice LC2) A removal's late cargo: what an item holder of the removal holds in the tick its restore writes it.
 * The blocker scan runs ticks before the writes (a group, stage or region removal plans and commits over ticks), and the restore's writes skip
 * block-entity side effects, so an item put into any holder between the scan and the write would be erased. Right before a cell's write (in
 * the same tick), the holder there gives up its late cargo; it drops at the site, kept from the removal's drop clear (FK {@code writeBack}'s
 * rule for items with no slot: at the site, never lost).
 *
 * <p>(LC2) Which items are cargo, per holder cell the restore writes (its restored value {@code R}, the restore's undo group {@code G}):
 * <ol>
 * <li>a creative site's declared container holding at most its declaration stays with the write (FK §5); a provided item id in a fill site's
 * declared container stays (FK-b);</li>
 * <li>at a block entity of the site's own template that this removal has not written yet (no write mark of {@code G} at the cell):
 * every item is cargo (the site wrote that holder; the write recreates the terrain's {@code R} from the snapshot), whatever {@code R} holds;</li>
 * <li>anywhere else (terrain the site left, or a cell this removal wrote already): the excess over {@code R}'s totals per item (item and
 * components, in any slots) is cargo; what the write recreates stays (a restored stack moved to another slot is not taken twice).</li>
 * </ol>
 * The write mark ({@link Marks}, a chunk attachment) is set at each own-template cell in the tick it is written, so it is saved with the
 * chunk that holds the write: a restore that writes again after a restart tells its own restored holder from the site's.
 *
 * <p>Item holders ({@link #holder}, one table for the take and the removal's blocker scan): every {@link Container}, a lectern (its book),
 * a campfire (its four items).
 */
public final class LateCargo {
	private LateCargo() {
	}

	// ------------------------------------------------------------------ item holders (the adapter table)

	/** The item holder a block entity is, as slots, or null: a container itself, a lectern's book, a campfire's items. */
	static @Nullable Container holder(@Nullable BlockEntity be) {
		if (be instanceof Container c) {
			return c;
		}
		if (be instanceof LecternBlockEntity l) {
			return new LecternSlots(l);
		}
		if (be instanceof CampfireBlockEntity f) {
			return new CampfireSlots(f);
		}
		return null;
	}

	/** A lectern's book as one slot. */
	static final class LecternSlots implements Container {
		final LecternBlockEntity l;

		LecternSlots(LecternBlockEntity l) {
			this.l = l;
		}

		@Override
		public int getContainerSize() {
			return 1;
		}

		@Override
		public boolean isEmpty() {
			return l.getBook().isEmpty();
		}

		@Override
		public ItemStack getItem(int i) {
			return i == 0 ? l.getBook() : ItemStack.EMPTY;
		}

		@Override
		public ItemStack removeItem(int i, int n) {
			if (i != 0 || n <= 0 || l.getBook().isEmpty()) {
				return ItemStack.EMPTY;
			}
			ItemStack book = l.getBook().copy();
			ItemStack got = book.split(n);
			l.clearContent();
			if (!book.isEmpty()) {
				l.setBook(book);
			}
			l.setChanged();
			return got;
		}

		@Override
		public ItemStack removeItemNoUpdate(int i) {
			if (i != 0 || l.getBook().isEmpty()) {
				return ItemStack.EMPTY;
			}
			ItemStack got = l.getBook().copy();
			l.clearContent();
			l.setChanged();
			return got;
		}

		@Override
		public void setItem(int i, ItemStack st) {
			if (i == 0) {
				l.setBook(st);
			}
		}

		@Override
		public void setChanged() {
			l.setChanged();
		}

		@Override
		public boolean stillValid(Player p) {
			return true;
		}

		@Override
		public void clearContent() {
			l.clearContent();
		}
	}

	/** A campfire's cooking items as four slots. */
	static final class CampfireSlots implements Container {
		final CampfireBlockEntity f;

		CampfireSlots(CampfireBlockEntity f) {
			this.f = f;
		}

		@Override
		public int getContainerSize() {
			return f.getItems().size();
		}

		@Override
		public boolean isEmpty() {
			return f.getItems().stream().allMatch(ItemStack::isEmpty);
		}

		@Override
		public ItemStack getItem(int i) {
			return f.getItems().get(i);
		}

		@Override
		public ItemStack removeItem(int i, int n) {
			ItemStack st = f.getItems().get(i);
			ItemStack got = st.isEmpty() || n <= 0 ? ItemStack.EMPTY : st.split(n);
			f.setChanged();
			return got;
		}

		@Override
		public ItemStack removeItemNoUpdate(int i) {
			ItemStack st = f.getItems().get(i);
			f.getItems().set(i, ItemStack.EMPTY);
			f.setChanged();
			return st;
		}

		@Override
		public void setItem(int i, ItemStack st) {
			f.getItems().set(i, st);
			f.setChanged();
		}

		@Override
		public void setChanged() {
			f.setChanged();
		}

		@Override
		public boolean stillValid(Player p) {
			return true;
		}

		@Override
		public void clearContent() {
			f.clearContent();
		}
	}

	// ------------------------------------------------------------------ the write mark (saved with the chunk)

	/** (LC2) Own-template cells a removal wrote: {@code "<pos long>" -> undo group}, per chunk, persistent with it. */
	static final class Marks {
		private Marks() {
		}

		static final AttachmentType<Map<String, String>> TYPE = AttachmentRegistry.<Map<String, String>>builder().persistent(Codec.unboundedMap(Codec.STRING,
			Codec.STRING)).buildAndRegister(Architect.id("lc_written"));
	}

	/** Registers the attachment (mod init, before any chunk loads; its own class, so a unit JVM never loads the registry). */
	public static void init() {
		Architect.LOGGER.debug("LC attachment {}", Marks.TYPE.identifier());
	}

	/** Whether the removal of undo group {@code group} has written the own-template cell {@code p} (its mark, saved with the chunk). */
	static boolean written(ServerLevel level, BlockPos p, @Nullable String group) {
		if (group == null || !level.isLoaded(p)) {
			return false;
		}
		Map<String, String> m = level.getChunkAt(p).getAttached(Marks.TYPE);
		return m != null && group.equals(m.get(Long.toString(p.asLong())));
	}

	/** Marks the own-template cell {@code p} written by {@code group}, in the tick of its write (the chunk is saved with both). */
	static void markWritten(ServerLevel level, BlockPos p, @Nullable String group) {
		if (group == null || !level.isLoaded(p)) {
			return;
		}
		LevelChunk c = level.getChunkAt(p);
		Map<String, String> m = c.getAttached(Marks.TYPE);
		String k = Long.toString(p.asLong());
		if (m != null && group.equals(m.get(k))) {
			return;
		}
		Map<String, String> n = m == null ? new HashMap<>() : new HashMap<>(m);
		n.put(k, group);
		c.setAttached(Marks.TYPE, n);
		c.markUnsaved();
	}

	// ------------------------------------------------------------------ the rules (pure)

	/** (pure) Whether a whole container stays with the write: a creative site's declared container holding at most its declaration. */
	static boolean containerOurs(boolean instant, boolean declared, boolean withinDeclaration) {
		return instant && declared && withinDeclaration;
	}

	/** (pure) Whether one stack stays with the write: a provided item id in a fill site's declared container. */
	static boolean stackOurs(boolean declared, boolean providedId) {
		return declared && providedId;
	}

	/**
	 * (pure, LC2) What the write recreates that may stay in the holder: nothing at an own-template cell this removal has not written yet
	 * (every item is cargo, whatever the restored value holds); else the restored value's stacks.
	 */
	static List<ItemStack> recreated(boolean ownTemplate, boolean written, Map<Integer, ItemStack> restored) {
		return ownTemplate && !written ? List.of() : List.copyOf(restored.values());
	}

	/** (fix b5b) What one holder cell gave up: the stacks, and their units counted off the stacks returned. */
	record Taken(List<ItemStack> stacks, int units) {
	}

	/**
	 * (fix b5b, review findings 1 and 5; LC2) Takes a holder's late cargo: up to {@code recreated}'s total per item (the same item and
	 * components, summed over its stacks, in any slots) stays (the write puts it back); the rest, and every stack not {@code ours}, is taken
	 * out. The units are counted off the stacks the holder returns, never off the slot's stack after the removal (a single-item container,
	 * a decorated pot, splits its own stack to zero and returns a new one).
	 */
	static Taken takeCell(Container c, List<ItemStack> recreated, Predicate<ItemStack> ours) {
		List<ItemStack> left = new ArrayList<>();
		for (ItemStack w : recreated) {
			if (!w.isEmpty()) {
				left.add(w.copy());
			}
		}
		List<ItemStack> out = new ArrayList<>();
		int units = 0;
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack st = c.getItem(i);
			if (st.isEmpty() || ours.test(st)) {
				continue;
			}
			int keep = 0;
			for (ItemStack w : left) {
				if (w.getCount() > 0 && ItemStack.isSameItemSameComponents(st, w)) {
					keep = Math.min(w.getCount(), st.getCount());
					w.shrink(keep);
					break;
				}
			}
			int n = st.getCount() - keep;
			if (n <= 0) {
				continue;
			}
			ItemStack got = keep == 0 ? c.removeItemNoUpdate(i) : c.removeItem(i, n);
			if (!got.isEmpty()) {
				units += got.getCount();
				out.add(got);
			}
		}
		return new Taken(out, units);
	}

	/** The stacks a restored value's block entity data holds, by slot ({@code Items}; a single-item holder's {@code item}/{@code RecordItem}/{@code Book}: slot 0). */
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
		for (String k : new String[] {"item", "RecordItem", "Book"}) {
			if (nbt.get(k) instanceof net.minecraft.nbt.CompoundTag e) {
				ItemStack.CODEC.parse(ops, e).result().ifPresent(st -> out.put(0, st));
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ the pass (per tick of a restore's writes)

	/**
	 * (LC2) A removal's late-cargo pass over the cells its restore writes in one tick (or at once): {@link #cell} right before each cell's
	 * write takes that cell's cargo and marks an own-template cell written; {@link #finish} returns the stacks for the caller's drop. Block
	 * entities are read at the cell when it is written, never cached across ticks (a holder placed between a sliced restore's ticks is seen).
	 */
	static final class Pass {
		final ServerLevel level;
		final SiteJournal.Restore r;
		final @Nullable Site s;
		final @Nullable String group;
		final Map<BlockPos, Map<String, Integer>> declared;
		final Set<String> provided;
		final boolean instant;
		final Set<BlockPos> own;
		final List<ItemStack> out = new ArrayList<>();
		final List<String> where = new ArrayList<>();
		/** The first cell that gave something up (an infra's fallback drop cell), or null. */
		@Nullable BlockPos first;

		Pass(ServerLevel level, SiteJournal.Restore r, @Nullable Site s, @Nullable String group) {
			this.level = level;
			this.r = r;
			this.s = s;
			this.group = group;
			this.declared = s == null ? Map.of() : declaredCells(level, s);
			this.provided = s == null ? Set.of() : providedIds(level, s);
			this.instant = s == null || s.construction() == null;
			this.own = s == null ? Set.of() : Sites.ownBlockEntities(s);
		}

		/** Right before the restore writes {@code p}: its holder's late cargo out; an own-template cell marked written. */
		void cell(BlockPos p) {
			if (!level.isLoaded(p)) {
				return;
			}
			if (!PAUSE.isEmpty()) {
				reached(r.site(), p); // (TEST) dev.removal.pause's cell
			}
			boolean ownCell = own.contains(p);
			Container c = holder(level.getBlockEntity(p));
			if (c != null && !c.isEmpty()) {
				Value v = r.writes(p.asLong());
				if (v != null) {
					take(p, c, v, ownCell);
				}
			}
			if (ownCell && r.writes(p.asLong()) != null) {
				markWritten(level, p, group);
			}
		}

		private void take(BlockPos p, Container c, Value v, boolean ownCell) {
			Map<String, Integer> decl = declared.get(p);
			Map<String, Integer> now = decl == null ? null : Fills.plainCounts(c);
			if (containerOurs(instant, decl != null, now != null && Fills.within(now, decl))) {
				return;
			}
			List<ItemStack> keep = recreated(s != null && ownCell, written(level, p, group), restoredSlots(level, v.nbt()));
			Taken t = takeCell(c, keep, st -> stackOurs(decl != null, provided.contains(BuiltInRegistries.ITEM.getKey(st.getItem()).toString())));
			out.addAll(t.stacks());
			BlockEntity be = level.getBlockEntity(p);
			if (t.units() > 0 && first == null) {
				first = p.immutable();
			}
			if (t.units() > 0 && be != null) {
				Fills.touched(level, p, be);
				where.add(p.toShortString() + " (" + t.units() + ")");
			}
		}

		/** {@link #cell} for each of {@code cells}. */
		void cells(List<SiteJournal.CellWrite> cells) {
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			for (SiteJournal.CellWrite w : cells) {
				m.set(w.pos());
				if (level.isLoaded(m) && (level.getBlockEntity(m) != null || own.contains(m))) {
					cell(m.immutable());
				}
			}
		}

		/** {@link #cell} for every holder and own-template cell in {@code box} that the restore writes (a restore written at once). */
		void box(Anchors.@Nullable Bounds box) {
			Anchors.Bounds b = box;
			if (r.box() != null) {
				b = b == null ? r.box() : Sites.union(b, r.box());
			}
			if (b == null) {
				return;
			}
			Set<BlockPos> seen = new HashSet<>();
			Sites.forEachBlockEntity(level, b, be -> {
				if (holder(be) != null && r.writes(be.getBlockPos().asLong()) != null) {
					seen.add(be.getBlockPos().immutable());
				}
			});
			seen.addAll(own);
			for (BlockPos p : seen) {
				cell(p);
			}
		}

		/** The stacks taken (logged and recorded for {@code dev.removal.state}); the caller drops them ({@link #drop}). */
		List<ItemStack> finish() {
			if (!out.isEmpty()) {
				Architect.LOGGER.warn("Removal of {}: late cargo in its item holders at {}: {} stack(s) handed out at the site, not erased", r.site(), where,
					out.size());
				record(r.site(), out, where);
			}
			List<ItemStack> got = List.copyOf(out);
			out.clear();
			where.clear();
			return got;
		}
	}

	/** The positions of the item-holder cells in the box that {@code r} writes. */
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
			if (holder(be) != null && r.writes(be.getBlockPos().asLong()) != null) {
				out.add(be.getBlockPos().immutable());
			}
		});
		return out;
	}

	/**
	 * Takes the late cargo out of {@code cells} (holder cells {@code r} writes) in this tick, with no undo group (no write marks: every own
	 * template cell is unwritten). Kept for its callers; the removals call {@link #take(ServerLevel, SiteJournal.Restore, Site, List, String)}.
	 */
	static List<ItemStack> take(ServerLevel level, SiteJournal.Restore r, @Nullable Site s, List<BlockPos> cells) {
		return take(level, r, s, cells, null);
	}

	/**
	 * (LC2) Takes the late cargo of a restore written at once ({@code writeNow}'s before-hook): every holder in {@code cells} and every own
	 * template cell of {@code s} it writes, marked written by {@code group}. Returns the stacks; the caller drops them ({@link #drop}).
	 */
	static List<ItemStack> take(ServerLevel level, SiteJournal.Restore r, @Nullable Site s, List<BlockPos> cells, @Nullable String group) {
		Pass p = new Pass(level, r, s, group);
		Set<BlockPos> all = new HashSet<>(cells);
		all.addAll(p.own);
		for (BlockPos c : all) {
			p.cell(c);
		}
		return p.finish();
	}

	/** Drops {@code stacks} at {@code at} as item entities ({@code keep}: the removal's drop clear leaves them; every drop clear spares them a while). */
	static void drop(ServerLevel level, BlockPos at, List<ItemStack> stacks, @Nullable Consumer<ItemEntity> keep) {
		for (ItemStack st : stacks) {
			ItemEntity ie = new ItemEntity(level, at.getX() + 0.5, Builder.cellDropY(level, at), at.getZ() + 0.5, st, 0, 0, 0);
			ie.setDefaultPickUpDelay();
			level.addFreshEntity(ie);
			Sites.Drops.protect(level, ie);
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

	/** (TEST, {@code dev.removal.lateCargo}) Arms one injection: the next removal of {@code site} puts {@code items} into the holder at pos. */
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
		PAUSE.clear();
		WAITING.clear();
		LAST = null;
	}

	/** (TEST, {@code dev.removal.holder}) The holder at {@code p}: {@code items} put in, or slot {@code move[0]}'s stack moved to {@code move[1]}. */
	public static JsonObject devHolder(ServerLevel level, BlockPos p, Map<String, Integer> items, int @Nullable [] move) {
		JsonObject o = new JsonObject();
		BlockEntity be = level.isLoaded(p) ? level.getBlockEntity(p) : null;
		Container c = holder(be);
		o.addProperty("holder", c == null ? null : be.getClass().getSimpleName());
		if (c == null) {
			return o;
		}
		if (!items.isEmpty()) {
			inject(c, items);
		}
		if (move != null && move[0] != move[1]) {
			ItemStack st = c.removeItemNoUpdate(move[0]);
			c.setItem(move[1], st);
		}
		if (!items.isEmpty() || move != null) {
			Fills.touched(level, p, be);
		}
		JsonArray slots = new JsonArray();
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack st = c.getItem(i);
			if (!st.isEmpty()) {
				JsonArray e = new JsonArray();
				e.add(i);
				e.add(BuiltInRegistries.ITEM.getKey(st.getItem()).toString());
				e.add(st.getCount());
				slots.add(e);
			}
		}
		o.add("slots", slots);
		return o;
	}

	/** (TEST, LC2) Paused removal restores: site -> {after cell (null: before any write), reached}. */
	private static final Map<String, Object[]> PAUSE = new HashMap<>();
	private static final Set<String> WAITING = new HashSet<>();

	/**
	 * (TEST, {@code dev.removal.pause}) Arms a pause of {@code site}'s removal restore (a {@link RestoreJob}): with {@code after} null it
	 * writes nothing from its next tick on; else it pauses from the tick after the one that wrote {@code after}. {@code off}: resumes.
	 */
	public static synchronized void armPause(String site, @Nullable BlockPos after, boolean off) {
		WAITING.remove(site);
		if (off) {
			PAUSE.remove(site);
		} else {
			PAUSE.put(site, new Object[] {after == null ? null : after.immutable(), after == null});
		}
	}

	/** (TEST) Whether {@code site}'s restore pauses in this tick (it writes nothing). */
	static synchronized boolean pausedAt(String site) {
		Object[] p = PAUSE.get(site);
		if (p == null || !(Boolean) p[1]) {
			return false;
		}
		WAITING.add(site);
		return true;
	}

	private static synchronized void reached(String site, BlockPos at) {
		Object[] p = PAUSE.get(site);
		if (p != null && at.equals(p[0])) {
			p[1] = true;
		}
	}

	/**
	 * (TEST) Called by a removal right after its custody is saved, ticks before its writes: the armed items go into their holders (into
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
			BlockEntity be = level.getBlockEntity(p);
			Container c = holder(be);
			if (c == null || be == null) {
				Architect.LOGGER.warn("dev.removal.lateCargo: no item holder at {}", p.toShortString());
				continue;
			}
			inject(c, items);
			Fills.touched(level, p, be);
			Architect.LOGGER.warn("dev.removal.lateCargo: {} put into the holder at {} after {}'s removal scan (TEST)", items, p.toShortString(), site);
		}
	}

	/** (TEST) Puts {@code items} into free or matching slots of {@code c}. */
	static void inject(Container c, Map<String, Integer> items) {
		for (var e : items.entrySet()) {
			var item = BuiltInRegistries.ITEM.getValue(Identifier.parse(e.getKey()));
			int left = e.getValue();
			for (int i = 0; i < c.getContainerSize() && left > 0; i++) {
				ItemStack st = c.getItem(i);
				if (st.isEmpty()) {
					int n = Math.min(left, c instanceof LecternSlots ? 1 : item.getDefaultMaxStackSize());
					c.setItem(i, new ItemStack(item, n));
					left -= n;
				} else if (st.is(item) && st.getComponentsPatch().isEmpty() && st.getCount() < st.getMaxStackSize()) {
					int n = Math.min(left, st.getMaxStackSize() - st.getCount());
					st.grow(n);
					left -= n;
				}
			}
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
		JsonObject pz = new JsonObject();
		PAUSE.forEach((k, v) -> {
			JsonObject e = new JsonObject();
			e.addProperty("after", v[0] == null ? null : ((BlockPos) v[0]).toShortString());
			e.addProperty("reached", (Boolean) v[1]);
			e.addProperty("waiting", WAITING.contains(k));
			pz.add(k, e);
		});
		o.add("pause", pz);
		o.add("last", LAST == null ? null : LAST.deepCopy());
		return o;
	}
}
