package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Anchors;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.ItemContainerContents;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BrushableBlockEntity;
import net.minecraft.world.level.block.entity.CampfireBlockEntity;
import net.minecraft.world.level.block.entity.LecternBlockEntity;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (Slice LC3, Steward's S-M5-12) A removal's cells are SEALED: from the moment a ticked removal, undo or restore exists until it ends,
 * no item enters an item holder (a container, a lectern, a campfire, a shelf, a pot, a jukebox, a chiseled bookshelf) or an item frame in
 * its boxes. With nothing able to enter, the restore write never meets late cargo: nothing to take, drop, protect or merge. Items already
 * in a holder at the removal's blocker scan are as before (the scan refuses).
 *
 * <p><b>The seal set</b> is derived each time from the persisted removal state, never kept on its own: every {@link RestoreJob} in the
 * placement queue (remove and rollback), every {@link DeltaJob} revert, and every group or stage removal (running or stalled: its
 * members not yet written and the one being written). The queue file holds all of them and loads before the first tick, so a crash and
 * restart mid-removal re-seals the same boxes. A box is its site's restore box (standing or pending record) or its road's or cell site's
 * box. An atomic removal (one call, one tick) needs no seal: nothing runs between its scan and its writes.
 *
 * <p><b>The paths sealed:</b> automation through {@code HopperBlockEntity.canPlaceItemInContainer} (a hopper's push and pull, an item
 * entity picked up, a dropper's and a crafter's push; {@code HopperHoldMixin}, with FL's fill rule), a copper golem's put-down
 * ({@code CopperGolemSealMixin}), the Fabric Transfer API's insert ({@code ContainerSlotWrapperMixin}, optional); a player's use of a
 * holder (opening its menu, a book on a lectern, food on a campfire, an item into a pot, a shelf, a jukebox or a chiseled bookshelf:
 * {@link UseBlockCallback}), a block item carrying contents placed into a box by anyone (a filled shulker box; {@code BlockItemSealMixin}),
 * an open menu ({@code ContainerStillValidMixin}: the click is refused, the menu closes next tick), an item put into an
 * empty item frame ({@code ItemFrameSealMixin}). A brushable block has no insertion path. Server thread.
 */
public final class RemovalSeal {
	private RemovalSeal() {
	}

	/** The refusal a player sees. */
	public static final String MESSAGE = "This is being taken down";

	/** (TEST, {@code dev.seal.state}) Refusals since the start, per path. */
	public static final Map<String, Long> REFUSED = new TreeMap<>();

	/** A list whose structural changes are counted (its {@code modCount}): the seal's index follows them. */
	static final class Counted<T> extends ArrayList<T> {
		int mods() {
			return modCount;
		}
	}

	// ------------------------------------------------------------------ the index

	/** (pure) The sealed boxes, per dimension, filed by every chunk column they touch. */
	record Index(Map<String, Long2ObjectOpenHashMap<List<Sealed>>> byDim, int boxes) {
		static final Index EMPTY = new Index(Map.of(), 0);

		boolean contains(String dim, int x, int y, int z) {
			Long2ObjectOpenHashMap<List<Sealed>> m = byDim.get(dim);
			if (m == null) {
				return false;
			}
			List<Sealed> l = m.get(chunk(x >> 4, z >> 4));
			if (l == null) {
				return false;
			}
			for (Sealed s : l) {
				if (s.box().contains(x, y, z) && (s.cells() == null || s.cells().contains(BlockPos.asLong(x, y, z)))) {
					return true;
				}
			}
			return false;
		}
	}

	/**
	 * A sealed box of a dimension. {@code cells} (null: the whole box): a road's or cell site's write footprint, the cells its journal
	 * entries hold (its restore writes no other cell), so a holder in its bounding box but off its cells is not sealed.
	 */
	record Sealed(String dim, Anchors.Bounds box, it.unimi.dsi.fastutil.longs.@Nullable LongSet cells) {
		Sealed(String dim, Anchors.Bounds box) {
			this(dim, box, null);
		}
	}

	static long chunk(int cx, int cz) {
		return ((long) cx << 32) ^ (cz & 0xffffffffL);
	}

	/** (pure) The index of {@code boxes}. */
	static Index index(List<Sealed> boxes) {
		if (boxes.isEmpty()) {
			return Index.EMPTY;
		}
		Map<String, Long2ObjectOpenHashMap<List<Sealed>>> out = new HashMap<>();
		for (Sealed s : boxes) {
			Long2ObjectOpenHashMap<List<Sealed>> m = out.computeIfAbsent(s.dim(), d -> new Long2ObjectOpenHashMap<>());
			Anchors.Bounds b = s.box();
			for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++) {
				for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++) {
					m.computeIfAbsent(chunk(cx, cz), k -> new ArrayList<>()).add(s);
				}
			}
		}
		return new Index(out, boxes.size());
	}

	/** The box of a site, road or cell site being removed (standing or pending record), or null (gone: written, or never there). */
	static @Nullable Sealed boxOf(String id) {
		Site s = Sites.get(id);
		if (s == null) {
			s = Sites.pendingRecord(id);
		}
		if (s != null) {
			return new Sealed(s.dimension(), s.restoreBox());
		}
		Infra i = Infras.get(id);
		if (i == null) {
			i = Infras.pending(id);
		}
		return i == null ? null : new Sealed(i.dimension(), i.box(), footprint(i));
	}

	/** (slice LC3 fix) Roads' and cell sites' write footprints, per id and placement (they never change while it stands). */
	private static final Map<String, it.unimi.dsi.fastutil.longs.LongSet> FOOTPRINTS = new HashMap<>();

	/**
	 * The cells {@code i}'s journal entries hold, every status (its undo restores those and no other): its write footprint; null (seal the
	 * whole box) when the journal can't be read or holds no cell of it.
	 */
	static it.unimi.dsi.fastutil.longs.@Nullable LongSet footprint(Infra i) {
		String key = i.id() + "@" + i.placedAt();
		it.unimi.dsi.fastutil.longs.LongSet f = FOOTPRINTS.get(key);
		if (f != null) {
			return f;
		}
		dev.larattalabs.architect.journal.JournalStore js = dev.larattalabs.architect.journal.WorldJournal.storeOrNull();
		if (js == null) {
			return null;
		}
		it.unimi.dsi.fastutil.longs.LongOpenHashSet cells = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		try {
			for (dev.larattalabs.architect.journal.JournalStore.Meta m : SiteJournal.entries(i.id())) {
				for (long k : m.sections()) {
					dev.larattalabs.architect.journal.SectionCells sc = js.section(m.id(), k);
					if (sc != null) {
						for (int n = 0; n < sc.size(); n++) {
							cells.add(sc.pos(n));
						}
					}
				}
			}
		} catch (IOException | RuntimeException e) {
			return null; // fail closed: the whole box
		}
		if (cells.isEmpty()) {
			return null;
		}
		FOOTPRINTS.put(key, cells);
		return cells;
	}

	/** The ids whose boxes are sealed now: from the queue's jobs and the group removals (their persisted state). */
	static List<String> sealedIds() {
		List<String> ids = new ArrayList<>();
		for (Placement.Job j : Placement.jobs()) {
			if (j instanceof RestoreJob rj && !rj.done) {
				ids.add(rj.siteId);
			} else if (j instanceof DeltaJob dj && DeltaJob.REVERT.equals(dj.kind)) {
				ids.add(dj.siteId);
			}
		}
		Groups.sealedIds(ids);
		return List.copyOf(new java.util.LinkedHashSet<>(ids));
	}

	private static Index index = Index.EMPTY;
	private static Object @Nullable [] builtFrom;
	private static int epoch;
	/** The boxes of the last build, by id. */
	private static Map<String, Sealed> built = Map.of();

	/**
	 * (slice LC3 fix) A box whose removal just ended (its job or group removal left the queue) stays sealed until the queue file without it
	 * is on disk: a crash before that reloads the removal, which writes the box again. (LC3 fix 2) "On disk" is a confirmed queue file
	 * generation ({@link Placement#writtenGen}), not the saver's barrier: the box waits for a generation requested after it left the seal
	 * set ({@code need}: the state then excludes it) to be written, forced and renamed with no exception. A failed write leaves it sealed;
	 * the placement tick retries the save ({@link Placement#wantSave}, the retry every 5 s).
	 */
	record Linger(Sealed box, long need) {
	}

	private static final Map<String, Linger> LINGER = new java.util.LinkedHashMap<>();

	/** (pure) Whether a lingering box may unseal: the generation it waits for is written. */
	static boolean released(Linger l, long writtenGen) {
		return writtenGen >= l.need();
	}

	/** Drops the lingering boxes whose queue file generation is written; answers whether any went (the index then rebuilds). */
	private static boolean pruneLinger() {
		if (LINGER.isEmpty()) {
			return false;
		}
		long w = Placement.writtenGen();
		return LINGER.values().removeIf(l -> released(l, w));
	}

	/** (TEST, units) The lingering boxes now, by id. */
	static Map<String, Linger> lingering() {
		return java.util.Collections.unmodifiableMap(LINGER);
	}

	/** A removal's seal sources changed in a way the fingerprint does not see (a group removal's member list grew). */
	static void changed() {
		epoch++;
	}

	private static Object[] fingerprint(@Nullable MinecraftServer srv) {
		if (pruneLinger()) {
			epoch++;
		}
		// any change of the sites state (records placed, pending, gone), the infra maps, the queue's jobs, the group removals (their lists and
		// their members: a member written leaves its removal's list)
		return new Object[] {Sites.stateIdentity(), Infras.identity(), Infras.pendingIdentity(), Placement.jobMods(), Groups.sealMods(), epoch};
	}

	private static boolean same(Object @Nullable [] a, Object[] b) {
		if (a == null || a.length != b.length) {
			return false;
		}
		for (int i = 0; i < a.length; i++) {
			if (a[i] instanceof Integer x && b[i] instanceof Integer y ? !x.equals(y) : a[i] != b[i]) {
				return false;
			}
		}
		return true;
	}

	static Index current() {
		Object[] f = fingerprint(null);
		if (!same(builtFrom, f)) {
			Map<String, Sealed> now = new java.util.LinkedHashMap<>();
			for (String id : sealedIds()) {
				Sealed s = boxOf(id);
				if (s != null) {
					now.put(id, s);
				}
			}
			long need = -1;
			for (var e : built.entrySet()) {
				if (!now.containsKey(e.getKey())) {
					if (need < 0) {
						// (LC3 fix 2) a generation requested from now on excludes it (this may run in the middle of a change, from a mixin:
						// the save is the tick's, never made here); its removal's own end save may be earlier and is not trusted
						need = Placement.requestedGen() + 1;
						Placement.wantSave();
					}
					LINGER.put(e.getKey(), new Linger(e.getValue(), need));
				}
			}
			for (String id : now.keySet()) {
				LINGER.remove(id);
			}
			List<Sealed> boxes = new ArrayList<>(now.values());
			LINGER.values().forEach(l -> boxes.add(l.box()));
			built = now;
			index = index(boxes);
			builtFrom = f; // (a linger made now whose save is already written goes at the next check's prune)
		}
		return index;
	}

	/**
	 * (LC3 fix 2) The placement tick's check, between its steps: the seal set is rebuilt when its sources changed, so a box whose removal
	 * ended lingers even when no holder was asked about in between (the lazy checks alone would never see it sealed).
	 */
	static void observe() {
		try {
			current();
		} catch (RuntimeException e) {
			Architect.LOGGER.warn("Removal seal: could not rebuild the sealed boxes", e);
		}
	}

	/** Whether {@code pos} of {@code level} lies in a box being removed. Server levels only. */
	public static boolean sealed(@Nullable Level level, BlockPos pos) {
		if (!(level instanceof ServerLevel sl)) {
			return false;
		}
		Index ix = current();
		return ix.boxes() > 0 && ix.contains(Sites.dimensionId(sl), pos.getX(), pos.getY(), pos.getZ());
	}

	/** Whether anything is sealed now (the cheap first check of every path). */
	public static boolean any() {
		return current().boxes() > 0;
	}

	private static void count(String path) {
		REFUSED.merge(path, 1L, Long::sum);
	}

	// ------------------------------------------------------------------ the paths

	/** (from {@code HopperHoldMixin}) Whether an automated insertion into slot {@code slot} of {@code dest} is refused. */
	public static boolean refusesInsert(Container dest, int slot) {
		if (!any()) {
			return false;
		}
		FillGuard.Cell cell = FillGuard.resolve(dest, slot);
		if (cell == null || !sealed(cell.be().getLevel(), cell.be().getBlockPos())) {
			return false;
		}
		count("hopper");
		return true;
	}

	/**
	 * (LC3 fix, review 3; from {@code HopperGuardMixin}) A hopper's or hopper minecart's pull out of slot {@code slot} of {@code source}
	 * ({@code tryTakeInItemFromSlot}, before it removes anything): refused when that slot's block is sealed. A restore job that restarts
	 * writes its holders' contents again, so an item taken out of a restored holder mid-removal would come back twice.
	 */
	public static boolean refusesExtract(Container source, int slot) {
		if (!any()) {
			return false;
		}
		FillGuard.Cell cell = FillGuard.resolve(source, slot);
		if (cell == null || !sealed(cell.be().getLevel(), cell.be().getBlockPos())) {
			return false;
		}
		count("extract");
		return true;
	}

	/** (LC3 fix, review 3; from {@code HopperGuardMixin}) A sealed hopper pushes nothing out ({@code ejectItems}). */
	public static boolean refusesPush(Level level, BlockPos hopper) {
		if (!any() || !sealed(level, hopper)) {
			return false;
		}
		count("extract");
		return true;
	}

	/** (LC3 fix, review 3; from {@code DispenseSealMixin}) A sealed dispenser or dropper fires nothing (its contents stay). */
	public static boolean refusesDispense(Level level, BlockPos at) {
		if (!any() || !sealed(level, at)) {
			return false;
		}
		count("dispense");
		return true;
	}

	/**
	 * (LC3 fix, review 4; from {@code CrafterSealMixin}) A crafter crafts nothing while it, or the cell its output goes to, is sealed: refused
	 * before {@code dispenseFrom} assembles anything, so no ingredient is consumed, no leftover ejected, and no output dropped into a box
	 * being cleared.
	 */
	public static boolean refusesCraft(Level level, BlockPos at, net.minecraft.core.Direction front) {
		if (!any() || !sealed(level, at) && !sealed(level, at.relative(front))) {
			return false;
		}
		count("crafter");
		return true;
	}

	/** (LC3 fix, review 5; from {@code VaultSealMixin}) A vault in a sealed box takes no key ({@code tryInsertKey}: nothing consumed). */
	public static boolean refusesVaultKey(Level level, BlockPos at, @Nullable Player p) {
		if (!any() || !sealed(level, at)) {
			return false;
		}
		count("vault");
		if (p != null) {
			tell(p);
		}
		return true;
	}

	/** (LC3 fix, review 3; from {@code CopperGolemSealMixin}) A copper golem takes nothing out of a sealed container. */
	public static boolean refusesGolemTake(Container c) {
		if (!sealedContainer(c)) {
			return false;
		}
		count("golem");
		return true;
	}

	/** (LC3 fix, review 3; from {@code ContainerSlotWrapperMixin}) A Fabric Transfer API extract from a sealed block's slot extracts 0. */
	public static boolean refusesTransferExtract(Object wrapper) {
		if (!any()) {
			return false;
		}
		Object[] cs = FillGuard.wrapperSlot(wrapper);
		if (cs == null) {
			count("transfer");
			return true; // fail closed
		}
		FillGuard.Cell cell = FillGuard.resolve((Container) cs[0], (Integer) cs[1]);
		if (cell == null || !sealed(cell.be().getLevel(), cell.be().getBlockPos())) {
			return false;
		}
		count("transfer");
		return true;
	}

	/** Whether any block part of {@code c} (both halves of a double chest) is sealed. */
	public static boolean sealedContainer(Container c) {
		if (!any()) {
			return false;
		}
		int n = c.getContainerSize();
		if (n == 0) {
			FillGuard.Cell cell = FillGuard.resolve(c, 0);
			return cell != null && sealed(cell.be().getLevel(), cell.be().getBlockPos());
		}
		FillGuard.Cell a = FillGuard.resolve(c, 0);
		FillGuard.Cell b = FillGuard.resolve(c, n - 1);
		return a != null && sealed(a.be().getLevel(), a.be().getBlockPos()) || b != null && sealed(b.be().getLevel(), b.be().getBlockPos());
	}

	/** (from {@code CopperGolemSealMixin}) A copper golem's put-down into {@code c}: refused (it keeps the item). */
	public static boolean refusesGolem(Container c) {
		if (!sealedContainer(c)) {
			return false;
		}
		count("golem");
		return true;
	}

	/** (from {@code ContainerSlotWrapperMixin}) A Fabric Transfer API insert into the wrapper's slot: refused when its block is sealed. */
	public static boolean refusesTransferInsert(Object wrapper) {
		if (!any()) {
			return false;
		}
		Object[] cs = FillGuard.wrapperSlot(wrapper);
		if (cs == null) {
			count("transfer");
			return true; // fail closed: something is sealed and the wrapper is unreadable
		}
		FillGuard.Cell cell = FillGuard.resolve((Container) cs[0], (Integer) cs[1]);
		if (cell == null || !sealed(cell.be().getLevel(), cell.be().getBlockPos())) {
			return false;
		}
		count("transfer");
		return true;
	}

	/** (from {@code ContainerStillValidMixin}) An open menu of a sealed block container is no longer valid (its clicks refused, closed). */
	public static boolean refusesMenu(BlockEntity be, Player p) {
		if (p.level().isClientSide() || !sealed(be.getLevel(), be.getBlockPos())) {
			return false;
		}
		count("menu");
		return true;
	}

	/**
	 * (from {@code BlockItemSealMixin}) A block item carrying contents (a filled shulker box) placed into a box being removed, by a player, a
	 * dispenser or any other caller of {@code BlockItem.place}: refused at the real placement cell.
	 */
	public static boolean refusesPlace(ItemStack st, Level level, BlockPos at, @Nullable Player p) {
		if (level.isClientSide() || !any() || !carriesContents(st) || !sealed(level, at)) {
			return false;
		}
		count("place");
		if (p != null) {
			tell(p);
		}
		return true;
	}

	/** (from {@code ItemFrameSealMixin}) An item put into an empty item frame inside a sealed box: refused. */
	public static boolean refusesFrame(Player p, ItemStack hand, ItemStack inFrame, Level level, BlockPos at) {
		if (level.isClientSide() || hand.isEmpty() || !inFrame.isEmpty() || !sealed(level, at)) {
			return false;
		}
		count("frame");
		tell(p);
		return true;
	}

	/** Whether {@code be} holds items a restore write would replace: a container, a lectern, a campfire, a brushable block. */
	public static boolean holder(@Nullable BlockEntity be) {
		return be instanceof Container || be instanceof LecternBlockEntity || be instanceof CampfireBlockEntity || be instanceof BrushableBlockEntity;
	}

	/** Whether {@code st} is a block item that brings contents with it (a filled shulker box, a block with saved block-entity data). */
	static boolean carriesContents(ItemStack st) {
		if (!(st.getItem() instanceof BlockItem)) {
			return false;
		}
		ItemContainerContents c = st.get(DataComponents.CONTAINER);
		return c != null && c.nonEmptyItemCopyStream().findAny().isPresent() || st.has(DataComponents.BLOCK_ENTITY_DATA);
	}

	/**
	 * (the player path, UseBlockCallback) Whether a player's use of the block at {@code hit} is refused: a holder in a sealed box, or (LC3 fix,
	 * review 1) a chained block (a powered shelf: {@code ShelfBlock.swapHotbar} swaps the hotbar into every connected shelf) any of whose
	 * connected blocks is a sealed holder.
	 */
	static boolean refusesUse(Player p, Level level, BlockPos hit) {
		if (level.isClientSide() || !any() || !holder(level.getBlockEntity(hit))) {
			return false;
		}
		if (!sealed(level, hit) && !chainSealed(level, hit)) {
			return false;
		}
		count("use");
		return true;
	}

	/** Whether a block chained to {@code at} (a connected shelf; none when it can't connect) is a sealed holder. */
	static boolean chainSealed(Level level, BlockPos at) {
		if (!(level.getBlockState(at).getBlock() instanceof net.minecraft.world.level.block.SideChainPartBlock chain)) {
			return false;
		}
		for (BlockPos q : chain.getAllBlocksConnectedTo(level, at)) {
			if (sealed(level, q) && holder(level.getBlockEntity(q))) {
				return true;
			}
		}
		return false;
	}

	/** (LC3 fix, review 3; a player's block break) A holder in a sealed box is not broken (its contents would drop, and a restart restores them). */
	static boolean refusesBreak(Player p, Level level, BlockPos at, @Nullable BlockEntity be) {
		if (level.isClientSide() || !any() || !holder(be) || !sealed(level, at)) {
			return false;
		}
		count("break");
		return true;
	}

	/**
	 * (slice PSVLC3 fix round, GPT P1 5) Not a player: an explosion (TNT, a creeper, a bed or anchor) or a piston at a holder in a sealed box
	 * leaves it standing (its contents would drop, and the restore or a restart brings them back), as a player's break is refused.
	 */
	public static boolean refusesBlast(Level level, BlockPos at) {
		if (level.isClientSide() || !any() || !sealed(level, at) || !holder(level.getBlockEntity(at))) {
			return false;
		}
		count("blast");
		return true;
	}

		static void tell(Player p) {
		p.sendOverlayMessage(Component.literal(MESSAGE));
	}

	static void init() {
		UseBlockCallback.EVENT.register((player, world, hand, hit) -> {
			if (!refusesUse(player, world, hit.getBlockPos())) {
				return InteractionResult.PASS;
			}
			tell(player);
			if (player instanceof ServerPlayer sp) {
				// the client may have shown the use: the cells and the inventory as they are
				sp.connection.send(new ClientboundBlockUpdatePacket(world, hit.getBlockPos()));
				sp.connection.send(new ClientboundBlockUpdatePacket(world, hit.getBlockPos().relative(hit.getDirection())));
				sp.containerMenu.sendAllDataToRemote();
			}
			return InteractionResult.FAIL;
		});
		net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents.BEFORE.register((world, player, pos, state, be) -> {
			if (!refusesBreak(player, world, pos, be)) {
				return true;
			}
			tell(player);
			if (player instanceof ServerPlayer sp) {
				sp.connection.send(new ClientboundBlockUpdatePacket(world, pos));
			}
			return false;
		});
		ServerLifecycleEvents.SERVER_STARTED.register(RemovalSeal::loadPause);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			PAUSE.clear();
			pauseFile = null;
			index = Index.EMPTY;
			builtFrom = null;
			built = Map.of();
			LINGER.clear();
			FOOTPRINTS.clear();
		});
	}

	/** (TEST, {@code dev.seal.state}) What is sealed now and the refusals. */
	public static JsonObject stateJson() {
		current(); // (LC3 fix 2) the seal set as a check sees it now: a removal that just ended lingers before this answers
		JsonObject o = new JsonObject();
		com.google.gson.JsonArray ids = new com.google.gson.JsonArray();
		for (String id : sealedIds()) {
			Sealed s = boxOf(id);
			if (s != null) {
				JsonObject x = new JsonObject();
				x.addProperty("id", id);
				x.addProperty("dim", s.dim());
				Anchors.Bounds b = s.box();
				x.addProperty("box", b.minX() + "," + b.minY() + "," + b.minZ() + " " + b.maxX() + "," + b.maxY() + "," + b.maxZ());
				// one sealed cell (a test sets a holder there): a footprint's highest cell, else the box's middle two above its floor
				long c = BlockPos.asLong((b.minX() + b.maxX()) / 2, Math.min(b.maxY(), b.minY() + 2), (b.minZ() + b.maxZ()) / 2);
				if (s.cells() != null) {
					x.addProperty("footprint", s.cells().size());
					c = s.cells().longStream().reduce((p, q) -> BlockPos.getY(q) > BlockPos.getY(p) ? q : p).orElse(c);
				}
				x.addProperty("cell", BlockPos.getX(c) + "," + BlockPos.getY(c) + "," + BlockPos.getZ(c));
				ids.add(x);
			}
		}
		o.add("sealed", ids);
		// (LC3 fix) every group or stage removal's member: whether its record is still pending (a restart can still write it) and sealed
		com.google.gson.JsonArray mem = new com.google.gson.JsonArray();
		List<String> all = new ArrayList<>();
		Groups.sealedIds(all);
		for (String id : new java.util.LinkedHashSet<>(all)) {
			JsonObject x = new JsonObject();
			x.addProperty("id", id);
			x.addProperty("pending", Sites.pendingRecord(id) != null || Infras.pending(id) != null);
			x.addProperty("standing", Sites.get(id) != null || Infras.get(id) != null);
			x.addProperty("sealed", boxOf(id) != null);
			mem.add(x);
		}
		o.add("members", mem);
		// (LC3 fix 2) boxes kept sealed until a queue file generation is written, and the generations
		com.google.gson.JsonArray lg = new com.google.gson.JsonArray();
		LINGER.forEach((id, l) -> {
			JsonObject x = new JsonObject();
			x.addProperty("id", id);
			x.addProperty("need", l.need());
			lg.add(x);
		});
		o.add("lingering", lg);
		// (LC3 fix 2) the stalled removals (sealed until retried): their members written and not
		com.google.gson.JsonArray stl = new com.google.gson.JsonArray();
		Groups.stalledJson(stl);
		o.add("stalled", stl);
		o.addProperty("queueRequested", Placement.requestedGen());
		o.addProperty("queueWritten", Placement.writtenGen());
		o.addProperty("queueWriteFailing", Placement.writeFailing());
		com.google.gson.JsonArray jobs = new com.google.gson.JsonArray();
		for (Placement.Job j : Placement.jobs()) {
			JsonObject x = new JsonObject();
			x.addProperty("site", j.siteId());
			x.addProperty("kind", j.kind());
			x.addProperty("progress", j instanceof RestoreJob rj && rj.writer != null ? rj.writer.progress() : j.progress());
			x.addProperty("cells", j instanceof RestoreJob rj ? rj.cellCursor : 0);
			jobs.add(x);
		}
		o.add("jobs", jobs);
		JsonObject r = new JsonObject();
		REFUSED.forEach(r::addProperty);
		o.add("refused", r);
		JsonObject pz = new JsonObject();
		PAUSE.forEach(pz::addProperty);
		o.add("pause", pz);
		return o;
	}

	// ------------------------------------------------------------------ (TEST) a removal's restore paused, across a restart

	/** (TEST, {@code dev.removal.pause}) Paused restores: site -> cells written before it pauses (0: before any write). */
	private static final Map<String, Integer> PAUSE = new TreeMap<>();
	private static @Nullable Path pauseFile;
	private static final String PAUSE_FILE = "dev-removal-pause.json";

	/** (TEST) Whether {@code site}'s restore writes nothing more now ({@code written} cells done so far). */
	static boolean paused(String site, int written) {
		if (PAUSE.isEmpty()) {
			return false;
		}
		Integer after = PAUSE.get(site);
		if (after == null) {
			after = PAUSE.get("*"); // every removal restore
		}
		return after != null && written >= after;
	}

	/**
	 * (TEST, {@code dev.removal.pause}) Pauses {@code site}'s ({@code *}: every) removal restore once it has written {@code after} cells (0: before any), or
	 * resumes it ({@code off}). Kept in the world's {@code architect/dev-removal-pause.json} so a restart keeps it (the file exists only
	 * while a pause is armed).
	 */
	public static synchronized void armPause(MinecraftServer srv, String site, int after, boolean off) {
		if (off) {
			PAUSE.remove(site);
		} else {
			PAUSE.put(site, Math.max(0, after));
		}
		Path f = srv.getWorldPath(LevelResource.ROOT).resolve("architect").resolve(PAUSE_FILE);
		try {
			if (PAUSE.isEmpty()) {
				Files.deleteIfExists(f);
			} else {
				JsonObject o = new JsonObject();
				PAUSE.forEach(o::addProperty);
				Files.createDirectories(f.getParent());
				Files.writeString(f, o.toString(), StandardCharsets.UTF_8);
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("TEST: could not keep the removal pause in {}", f, e);
		}
	}

	private static void loadPause(MinecraftServer srv) {
		PAUSE.clear();
		Path f = srv.getWorldPath(LevelResource.ROOT).resolve("architect").resolve(PAUSE_FILE);
		pauseFile = f;
		if (!Files.exists(f)) {
			return;
		}
		try {
			JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject().entrySet()
				.forEach(e -> PAUSE.put(e.getKey(), e.getValue().getAsInt()));
			Architect.LOGGER.warn("TEST: removal restores paused from {}: {}", f, PAUSE);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("TEST: could not read {}", f, e);
		}
	}
}
