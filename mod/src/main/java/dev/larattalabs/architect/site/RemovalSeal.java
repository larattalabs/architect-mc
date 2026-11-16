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
 * {@link UseBlockCallback}), a block item carrying contents placed into a box (a filled shulker box), an open menu
 * ({@code BaseContainerBlockEntity.stillValid} answers false: the click is refused, the menu closes next tick), an item put into an
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
	record Index(Map<String, Long2ObjectOpenHashMap<List<Anchors.Bounds>>> byDim, int boxes) {
		static final Index EMPTY = new Index(Map.of(), 0);

		boolean contains(String dim, int x, int y, int z) {
			Long2ObjectOpenHashMap<List<Anchors.Bounds>> m = byDim.get(dim);
			if (m == null) {
				return false;
			}
			List<Anchors.Bounds> l = m.get(chunk(x >> 4, z >> 4));
			if (l == null) {
				return false;
			}
			for (Anchors.Bounds b : l) {
				if (b.contains(x, y, z)) {
					return true;
				}
			}
			return false;
		}
	}

	/** A sealed box of a dimension. */
	record Sealed(String dim, Anchors.Bounds box) {
	}

	static long chunk(int cx, int cz) {
		return ((long) cx << 32) ^ (cz & 0xffffffffL);
	}

	/** (pure) The index of {@code boxes}. */
	static Index index(List<Sealed> boxes) {
		if (boxes.isEmpty()) {
			return Index.EMPTY;
		}
		Map<String, Long2ObjectOpenHashMap<List<Anchors.Bounds>>> out = new HashMap<>();
		for (Sealed s : boxes) {
			Long2ObjectOpenHashMap<List<Anchors.Bounds>> m = out.computeIfAbsent(s.dim(), d -> new Long2ObjectOpenHashMap<>());
			Anchors.Bounds b = s.box();
			for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++) {
				for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++) {
					m.computeIfAbsent(chunk(cx, cz), k -> new ArrayList<>()).add(b);
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
		return i == null ? null : new Sealed(i.dimension(), i.box());
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
		return ids;
	}

	private static Index index = Index.EMPTY;
	private static Object @Nullable [] builtFrom;
	private static int epoch;

	/** A removal's seal sources changed in a way the fingerprint does not see (a group removal's member list grew). */
	static void changed() {
		epoch++;
	}

	private static Object[] fingerprint(@Nullable MinecraftServer srv) {
		// any change of the sites state (records placed, pending, gone), the infra maps, the queue's jobs, the group removals; and while
		// anything is sealed, the tick (a member written or a list shrunk: the seal lifts at the next tick)
		return new Object[] {Sites.stateIdentity(), Infras.identity(), Infras.pendingIdentity(), Placement.jobMods(), Groups.sealMods(), epoch,
			index.boxes() > 0 && srv != null ? srv.getTickCount() : -1};
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
		MinecraftServer srv = dev.larattalabs.architect.placed.Placed.server();
		Object[] f = fingerprint(srv);
		if (!same(builtFrom, f)) {
			List<Sealed> boxes = new ArrayList<>();
			for (String id : sealedIds()) {
				Sealed s = boxOf(id);
				if (s != null) {
					boxes.add(s);
				}
			}
			index = index(boxes);
			builtFrom = fingerprint(srv); // the tick part follows what was just built
		}
		return index;
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

	/** (the player path, UseBlockCallback) Whether a player's use at {@code hit} is refused: a sealed holder, or contents placed into a box. */
	static boolean refusesUse(Player p, Level level, BlockPos hit, BlockPos placeAt, ItemStack held) {
		if (level.isClientSide() || !any()) {
			return false;
		}
		if (holder(level.getBlockEntity(hit)) && sealed(level, hit)) {
			count("use");
			return true;
		}
		if (carriesContents(held) && (sealed(level, hit) || sealed(level, placeAt))) {
			count("place");
			return true;
		}
		return false;
	}

	static void tell(Player p) {
		p.sendOverlayMessage(Component.literal(MESSAGE));
	}

	static void init() {
		UseBlockCallback.EVENT.register((player, world, hand, hit) -> {
			ItemStack held = player.getItemInHand(hand);
			if (!refusesUse(player, world, hit.getBlockPos(), hit.getBlockPos().relative(hit.getDirection()), held)) {
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
		ServerLifecycleEvents.SERVER_STARTED.register(RemovalSeal::loadPause);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			PAUSE.clear();
			pauseFile = null;
			index = Index.EMPTY;
			builtFrom = null;
		});
	}

	/** (TEST, {@code dev.seal.state}) What is sealed now and the refusals. */
	public static JsonObject stateJson() {
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
				ids.add(x);
			}
		}
		o.add("sealed", ids);
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
