package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.apiimpl.ApiEvents;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchor;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.BedSafety;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.LeafGuard;
import dev.larattalabs.architect.placement.NaturalDrops;
import dev.larattalabs.architect.placement.Occupancy;
import dev.larattalabs.architect.placement.Reconcile;
import dev.larattalabs.architect.placement.SiteWarnings;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.stream.Stream;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Vec3i;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.ExperienceOrb;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.attribute.BedRule;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.Mirror;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.LecternBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.templatesystem.LiquidSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructurePlaceSettings;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.AABB;
import org.jspecify.annotations.Nullable;

/**
 * The placed designs of the running world (was AgentCraft's {@code Buildings}): persisted in
 * {@code <world>/architect-sites.json}, with what each one changed kept in the world journal ({@code journal.WorldJournal},
 * docs/CONTRACT.md "Phase 4e contract"). Loaded when any world starts and cleared when it stops. The world is only changed by
 * {@link #place}, {@link #remove} and {@link #move}, which run on explicit commands (or a ghost confirm) on the server thread;
 * reads are safe from any thread.
 *
 * <p><b>Placement contract</b> (kept from AgentCraft docs/BUILDINGS.md): terrain fit (foundation fill, cleared terrain),
 * the entrance approach, occupancy (players, pets and things that matter refuse; hostile mobs are removed), fluids (lava
 * refuses, water is a note), safe remove (the player's things in the box refuse unless forced), crash safety and move / undo
 * move.
 *
 * <p><b>The journal instead of 4d's box snapshots</b> (phase 4e): a site's restore box is its {@code site} BOX entry, its held
 * leaves a {@code leaves} CELL entry, a construction crate a {@code crate} entry ({@link SiteJournal}). Order of every change:
 * the journal first, then the site record, then the blocks. A site that overlaps nothing is placed and removed with exactly
 * 4d's block writes; the restore template is built from the undo's {@code written} values.
 */
public final class Sites {
	public static final String FILE = "architect-sites.json";
	public static final String SNAPSHOT_DIR = "architect-sites";
	/** Block update flags for placing and restoring: sync to clients, no drops, no container spills (no duplicated items on restore). */
	static final int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_SUPPRESS_DROPS | Block.UPDATE_SKIP_BLOCK_ENTITY_SIDEEFFECTS;
	/** Roads and cell sites write with these (phase 4e, as AgentCraft's roads do): sync to clients, no side effects. */
	static final int CELL_FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS;
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Immutable state: sites by id (placement order), the next id number, sites taken down since the last world start. */
	private record State(Map<String, Site> byId, int next, List<Site.Pending> pending) {
		static final State EMPTY = new State(Map.of(), 1, List.of());
	}

	private static volatile State state = State.EMPTY;
	/** The site groups (phase 4d), by id in creation order, saved in the sites file with the sites. */
	private static volatile Map<String, SiteGroupRec> groups = Map.of();
	private static volatile int nextGroup = 1;
	/** The sites file exists but could not be parsed: placing would overwrite it, so it is refused. */
	private static volatile boolean loadFailed;
	private static volatile @Nullable Path worldDir;
	private static final List<Consumer<List<Site>>> LISTENERS = new CopyOnWriteArrayList<>();

	/** Thrown by {@link #place} / {@link #remove} / {@link #move} with a message meant for the player. */
	public static final class SiteException extends Exception {
		private final Reason reason;

		public SiteException(String message) {
			this(Reason.OTHER, message);
		}

		public SiteException(Reason reason, String message) {
			super(message);
			this.reason = reason == null ? Reason.OTHER : reason;
		}

		/** The refusal's type (docs/CONTRACT.md phase 4a {@code Reason}), set where the refusal is made. */
		public Reason reason() {
			return reason;
		}
	}

	/** A refusal with its type. */
	public record Refusal(Reason reason, String message) {
	}

	private Sites() {
	}

	public static void init() {
		WorldJournal.init(); // the journal opens (and imports 4d worlds) before the sites load
		dev.larattalabs.architect.journal.JournalMigration.init();
		dev.larattalabs.architect.site.roads.RoadSync.init();
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			worldDir = server.getWorldPath(LevelResource.ROOT);
			load(server);
			SiteDeltas.server = server;
			reconcile(server, Placement.jobSites(server));
			SiteDeltas.atStart(server);
			notifyListeners();
		});
		Placement.init();
		Builder.init();
		ServerTickEvents.END_SERVER_TICK.register(server -> Drops.tick());
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			SiteDeltas.server = null;
			state = State.EMPTY;
			groups = Map.of();
			nextGroup = 1;
			reports.clear();
			Drops.reset();
			worldDir = null;
			notifyListeners();
		});
	}

	/** Whether the world's sites file exists but could not be read (nothing is loaded, placing is refused). */
	public static boolean loadFailed() {
		return loadFailed;
	}

	// ------------------------------------------------------------------ reads

	/** Every placed site in placement order. Any thread. */
	public static List<Site> all() {
		return List.copyOf(state.byId().values());
	}

	public static @Nullable Site get(String id) {
		return state.byId().get(id);
	}

	/** Called with the new list after every change (place, remove, move, load, world stop), on the thread that made it. */
	public static void addListener(Consumer<List<Site>> listener) {
		LISTENERS.add(listener);
	}

	/** What the last {@link #place} / {@link #move} had to say beside success (hostile mobs removed, water), or null. */
	public static @Nullable String lastNote() {
		return lastNote;
	}

	private static volatile @Nullable String lastNote;

	// ------------------------------------------------------------------ place

	/**
	 * Places {@code bp} with its rotated minimum corner at {@code origin} and records it as a site. Refuses when the box
	 * (foundation and approach included) leaves the build height, overlaps another site, has lava in or next to it, holds a
	 * player, pet or other entity that matters ({@link Occupancy}), cuts a door in half, or (unless {@code force}) would
	 * overwrite block entities. The terrain of the box is saved first; {@link #remove} restores it. Server thread.
	 */
	public static Site place(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force) throws SiteException {
		return place(level, bp, origin, rotation, force, null);
	}

	/**
	 * {@link #place}; in a survival world ({@link SurvivalWorld#on}) the placement becomes a construction site ({@link Builder#convert}):
	 * same checks and snapshot, then everything but the terrain clearing is taken out again and queued for the builder.
	 * {@code owner}: the placing player's UUID (the HUD line), or null.
	 */
	public static Site place(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String owner)
		throws SiteException {
		return place(level, bp, origin, rotation, force, owner, null, null, null, playerOf(level.getServer(), owner));
	}

	/** The online player with this UUID string, or null. */
	public static @Nullable ServerPlayer playerOf(MinecraftServer server, @Nullable String uuid) {
		if (uuid == null) {
			return null;
		}
		try {
			return server.getPlayerList().getPlayer(java.util.UUID.fromString(uuid));
		} catch (IllegalArgumentException e) {
			return null;
		}
	}

	/**
	 * {@link #place} with every option (docs/CONTRACT.md phase 4a): {@code construction} null = the world's toggle, true = a
	 * construction site, false = instant (the caller checked the permission rule); {@code siteOwner}/{@code ext} are stored
	 * on the site (R5); {@code actor} is who placed it (for the events). {@code placer}: the placing player's UUID (the HUD
	 * line). Fires {@code SITE_PLACED} after the record is saved, or {@code PLACE_FAILED} with the typed refusal. Server thread.
	 */
	public static Site place(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String placer,
		@Nullable Boolean construction, @Nullable String siteOwner, @Nullable JsonObject ext, @Nullable ServerPlayer actor) throws SiteException {
		return place(level, bp, origin, rotation, force, placer, construction, siteOwner, ext, actor, null);
	}

	/** {@link #place} for a batch item (phase 4d): the site joins {@code member}'s group. Server thread. */
	public static Site place(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String placer,
		@Nullable Boolean construction, @Nullable String siteOwner, @Nullable JsonObject ext, @Nullable ServerPlayer actor,
		Site.@Nullable Member member) throws SiteException {
		return place(level, bp, origin, rotation, force, placer, construction, siteOwner, ext, actor, member, false);
	}

	/** {@link #place}; {@code layer}: the LAYER overlap policy (phase 4e), else REFUSE. Server thread. */
	public static Site place(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String placer,
		@Nullable Boolean construction, @Nullable String siteOwner, @Nullable JsonObject ext, @Nullable ServerPlayer actor,
		Site.@Nullable Member member, boolean layer) throws SiteException {
		Site placed;
		try {
			placed = placeInternal(level, bp, origin, rotation, force, placer, construction, siteOwner, ext, member, layer);
		} catch (SiteException e) {
			ApiEvents.placeFailed(level, bp.id(), origin, rotation, force, construction, siteOwner, ext, actor,
				List.of(new Refusal(e.reason(), e.getMessage())));
			throw e;
		}
		ApiEvents.placed(level.getServer(), placed);
		return placed;
	}

	private static Site placeInternal(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String owner,
		@Nullable Boolean construction, @Nullable String siteOwner, @Nullable JsonObject ext, Site.@Nullable Member member) throws SiteException {
		return placeInternal(level, bp, origin, rotation, force, owner, construction, siteOwner, ext, member, false);
	}

	private static Site placeInternal(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String owner,
		@Nullable Boolean construction, @Nullable String siteOwner, @Nullable JsonObject ext, Site.@Nullable Member member, boolean layer)
		throws SiteException {
		MinecraftServer server = level.getServer();
		if (loadFailed) {
			throw new SiteException(Reason.OTHER, FILE + " could not be read when the world started (see the log); fix or move it, then restart");
		}
		SiteJournal.requireAvailable();
		String id = newSiteId();
		boolean survival = construction != null ? construction : SurvivalWorld.on();
		Built built = build(level, bp, origin, rotation, force, null, id, survival, layer, new Who(siteOwner, ext, member, owner));
		Construction cs = null;
		if (survival) {
			try {
				cs = Builder.convertNow(level, bp, built, id, owner);
			} catch (SiteException | RuntimeException e) {
				Architect.LOGGER.error("Making {} a construction site failed; taking the placement down", id, e);
				unbuild(level, built);
				throw e instanceof SiteException se ? se : new SiteException("Making the construction site failed (" + e.getMessage() + "); the area was restored");
			}
		}
		// P8: the record placed
		Site b = built.record().withPin(built.pin()).withConstruction(cs).withPlacing(false);
		replace(server, b);
		SiteJournal.updateMeta(id, b.toJson());
		lastNote = built.note();
		Architect.LOGGER.info("Placed site {} ({}) at {} rotation {}: box {}, journal box {}{}{}", id, bp.id(), origin.toShortString(), b.rotation(),
			Anchors.str(b.box()), Anchors.str(b.restoreBox()), force ? " (forced)" : "", built.note() == null ? "" : "; " + built.note());
		return b;
	}

	/** Who a placement is for: the site's owner and ext, its group membership, the placing player (the HUD line). */
	record Who(@Nullable String siteOwner, @Nullable JsonObject ext, Site.@Nullable Member member, @Nullable String placer) {
		static final Who NONE = new Who(null, null, null, null);
	}

	/** A new site id ({@code s<n>}): never one a record, a journal entry or a legacy snapshot file carries. */
	static String newSiteId() {
		State s = state;
		int next = s.next();
		while (idUsed("s" + next)) {
			next++;
		}
		state = new State(s.byId(), next + 1, s.pending());
		return "s" + next;
	}

	private static boolean idUsed(String id) {
		return state.byId().containsKey(id) || state.pending().stream().anyMatch(p -> p.site().id().equals(id)) || !SiteJournal.entries(id).isEmpty()
			|| snapshotUsed(id);
	}

	/** The file name a 0.8.0 record carries in {@code snapshot}: no such file exists, so 0.7.0 refuses to remove it (downgrade). */
	static String journalName(String id) {
		return id + "-" + System.currentTimeMillis() + ".journal";
	}

	/**
	 * A template put into the world: its placing record (P4), the pin and notes, and what the construction conversion needs.
	 */
	record Built(int turns, Anchors.Bounds box, Anchors.Bounds snapshotBox, Anchors.Bounds interior, Map<String, Anchor> anchors,
		Site.Pin pin, @Nullable String note, TemplateGrid grid, TerrainFit.Plan plan, Approach.Plan approach, Site record, List<String> entries) {
		String snapshot() {
			return record.snapshot();
		}
	}

	/** Takes a built site down again (a failed conversion or move): its undo written at once, its entries and record gone. */
	static void unbuild(ServerLevel level, Built built) {
		Site cur = get(built.record().id());
		abortPlacement(level, built.record().id(), cur != null && cur.placing(), built.entries());
	}

	/**
	 * Rolls a placement back in the same tick (it failed half way): the undo of its entries is committed and written, then the
	 * entries are released (it was never placed) and its record dropped ({@code dropRecord}).
	 */
	static void abortPlacement(ServerLevel level, String id, boolean dropRecord, List<String> entries) {
		try {
			Drops drops = null;
			Site rec = get(id);
			if (rec != null) {
				drops = Drops.before(level, rec.restoreBox());
			}
			String g = SiteJournal.group("abort-" + id);
			SiteJournal.Undone u = SiteJournal.undoEntries(level, entries, g);
			SiteJournal.await(u.commit(), "the rollback of " + id);
			SiteJournal.Restore r = SiteJournal.writeNow(level, id, g);
			SiteJournal.restoreRing(level, r.ring());
			if (drops != null) {
				drops.clearNew(level);
			}
			SiteJournal.releaseGroup(u.work().ids());
		} catch (SiteException | RuntimeException e) {
			Architect.LOGGER.error("Could not take the placement {} down again", id, e);
		}
		if (dropRecord && state.byId().containsKey(id)) {
			State s = state;
			Map<String, Site> map = new LinkedHashMap<>(s.byId());
			Site gone = map.remove(id);
			if (gone != null) {
				dropFromGroup(gone);
			}
			MinecraftServer server = level.getServer();
			commit(server, new State(Collections.unmodifiableMap(map), s.next(), s.pending()));
		}
	}

	/** Adds (or replaces) a record and saves: P4 of a placement. */
	static void putRecord(MinecraftServer server, Site b) {
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.put(b.id(), b);
		addToGroup(b);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), s.pending()));
	}

	/** What a site placed from {@code grid} with {@code turns} pins. */
	static Site.Pin pinFor(TemplateGrid grid, int turns) {
		return new Site.Pin(grid.fingerprint(), grid.blockEntityOffsets(turns));
	}

	// ------------------------------------------------------------------ held leaves (LeafGuard, phase 4e: leaves entries)

	/**
	 * After {@code box} got its old terrain back: standing sites near it hold again the leaves that hang on them, each as a new
	 * {@code leaves} entry (committed before the leaves are written).
	 */
	private static void reholdNear(ServerLevel level, Anchors.Bounds box) {
		String here = dimensionId(level);
		for (Site x : state.byId().values()) {
			if (!x.dimension().equals(here) || x.placing() || !near(x.restoreBox(), box, 2 * LeafGuard.RADIUS)) {
				continue;
			}
			List<Integer> more = SiteJournal.holdable(level, x.restoreBox());
			if (more.isEmpty()) {
				continue;
			}
			try {
				JournalStore s = SiteJournal.store();
				String id = s.newId();
				long layer = s.newLayer();
				JournalStore.Txn t = s.begin().label("rehold:" + x.id()).create(JournalStore.Meta.header(id, WorldJournal.LEAVES, x.id(), x.group(), here,
					Journal.Policy.CELL, layer, Journal.Status.ACTIVE, System.currentTimeMillis()), JournalStore.bySection(SiteJournal.leafCells(level, more,
						layer)), dev.larattalabs.architect.journal.JournalNbt.Head.EMPTY);
				SiteJournal.await(s.submit(t), "the leaves " + x.id() + " holds");
				LeafGuard.holdCells(level, more, FLAGS);
			} catch (SiteException e) {
				Architect.LOGGER.warn("Could not hold the leaves near {} again: {}", x.id(), e.getMessage());
			}
		}
	}

	private static boolean near(Anchors.Bounds a, Anchors.Bounds b, int d) {
		return a.minX() - d <= b.maxX() && b.minX() <= a.maxX() + d && a.minY() - d <= b.maxY() && b.minY() <= a.maxY() + d
			&& a.minZ() - d <= b.maxZ() && b.minZ() <= a.maxZ() + d;
	}

	private static Site withPin(Site x, Site.Pin pin) {
		return x.withPin(pin);
	}

	/** {@link #pinFor} without the bed cells a placement left out ({@link #removeUnsafeBeds}). */
	static Site.Pin pinFor(TemplateGrid grid, int turns, Set<Long> removedBeds, Anchors.Bounds box) {
		Site.Pin pin = pinFor(grid, turns);
		return pin.withoutBlockEntities(BedSafety.withoutCells(pin.blockEntities(), removedBeds, box.minX(), box.minY(), box.minZ()));
	}

	/** The template's beds a placement left out: every removed cell and the head cells, as {@link BlockPos#asLong}. */
	record BedsOut(Set<Long> cells, Set<Long> heads) {
	}

	/**
	 * Takes the template's own beds out again where the level's bed rule makes them dangerous (in the Nether and the End a
	 * bed explodes when used, which ends a Hardcore world): both halves become air (no drops, {@link #FLAGS}). The rule is
	 * read at each bed's head cell, as vanilla does. Only cells the template wrote a bed to are looked at. Server thread.
	 */
	static BedsOut removeUnsafeBeds(ServerLevel level, TemplateGrid grid, int turns, Anchors.Bounds box) {
		Set<Long> cells = new HashSet<>();
		Set<Long> heads = new HashSet<>();
		GhostModel m = grid.ghost(turns);
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int i = 0; i < m.count(); i++) {
			BlockState s = level.getBlockState(p.set(box.minX() + m.x(i), box.minY() + m.y(i), box.minZ() + m.z(i)));
			if (!(s.getBlock() instanceof BedBlock bed)) {
				continue;
			}
			Direction facing = s.getValue(BedBlock.FACING);
			BlockPos head = BedSafety.head(p.getX(), p.getY(), p.getZ(), s.getValue(BedBlock.PART) == BedPart.HEAD, facing.getStepX(), facing.getStepZ());
			BedRule rule = bed.getBedRule(level, head);
			if (!BedSafety.unsafe(rule.canSleep() == BedRule.Rule.NEVER, rule.destroyOnUse(), rule.destroyOnLeave())) {
				continue;
			}
			cells.add(p.asLong());
			heads.add(head.asLong());
		}
		for (long c : cells) {
			level.setBlock(BlockPos.of(c), Blocks.AIR.defaultBlockState(), FLAGS);
		}
		if (!cells.isEmpty()) {
			Architect.LOGGER.info("Left out {} bed(s) of {} in {}: beds are not safe there", heads.size(), grid.blueprint().id(), dimensionId(level));
		}
		return new BedsOut(Set.copyOf(cells), Set.copyOf(heads));
	}

	/** The loaded template grid of a site's design when it is the one the site was placed from (its pin), else null. */
	static @Nullable TemplateGrid ownGrid(Site b) {
		TemplateGrid grid = TemplateGrid.of(b.blueprint());
		if (grid != null && b.pin() != null && grid.fingerprint().equals(b.pin().template())) {
			return grid;
		}
		return SiteDeltas.gridOf(b); // phase 5b: a site at an older version of its entry
	}

	@FunctionalInterface
	private interface Refusals {
		void add(Reason reason, String message) throws SiteException;
	}

	private static final Refusals THROW = (r, m) -> {
		throw new SiteException(r, m);
	};

	/** A site that passed {@link #checkSite}: everything {@link #build} needs, so it never looks at the world twice. */
	private record SitePlan(StructureTemplate template, int turns, StructurePlaceSettings settings, BlockPos placePos, Anchors.Bounds box,
		TemplateGrid grid, TerrainFit.Plan plan, Approach.Plan approach, Anchors.Bounds snapBox, List<Occupancy.Found> found, SiteWarnings.Result site,
		List<String> layerNotes, List<SiteJournal.Hit> overlaps) {
	}

	/**
	 * The checks of a placement (place, move and the dry-run {@link #verdict}) in place()'s order. Each failing check goes to
	 * {@code out}. {@code dryRun}: the world is only read where its chunks are loaded. Null when the site could not be planned
	 * at all. {@code moving}: the site being moved. Server thread.
	 */
	private static @Nullable SitePlan checkSite(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force,
		@Nullable Site moving, Refusals out, boolean dryRun, boolean survival) throws SiteException {
		return checkSite(level, bp, origin, rotation, force, moving, out, dryRun, survival, false, null);
	}

	/**
	 * {@link #checkSite}; {@code layer}: the LAYER overlap policy (docs/CONTRACT.md phase 4e "Overlap"), else REFUSE;
	 * {@code owner}: the request's owner (a LAYER over another owner's site needs force).
	 */
	private static @Nullable SitePlan checkSite(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force,
		@Nullable Site moving, Refusals out, boolean dryRun, boolean survival, boolean layer, @Nullable String owner) throws SiteException {
		Blueprints.Entry entry = Blueprints.entry(bp.id());
		if (entry == null) {
			out.add(Reason.UNKNOWN_BLUEPRINT, "Design " + bp.id() + " has no loaded template");
			return null;
		}
		StructureTemplate template = entry.template();
		int turns = rotation.ordinal();
		StructurePlaceSettings settings = settings(rotation);
		// vanilla rotates about the template's origin cell: shift so the rotated box's minimum corner is `origin`
		BoundingBox atZero = template.getBoundingBox(settings, BlockPos.ZERO);
		BlockPos placePos = origin.offset(-atZero.minX(), -atZero.minY(), -atZero.minZ());
		BoundingBox bb = template.getBoundingBox(settings, placePos);
		if (bb.minX() != origin.getX() || bb.minY() != origin.getY() || bb.minZ() != origin.getZ()) {
			out.add(Reason.OTHER, "Internal: rotated box " + bb + " does not start at " + origin.toShortString());
			return null;
		}
		Anchors.Bounds box = new Anchors.Bounds(bb.minX(), bb.minY(), bb.minZ(), bb.maxX(), bb.maxY(), bb.maxZ());
		Trace tr = new Trace("checkSite " + bp.id());
		TemplateGrid grid = TemplateGrid.of(entry);
		tr.mark("grid");
		GhostModel model = grid.ghost(turns);
		tr.mark("ghost");
		boolean[] unloaded = {false};
		// phase 4e: standing roads' surface cells near the box (the approach stops at a road)
		int reach = bp.approach().length() + Approach.EXTEND + 2;
		it.unimi.dsi.fastutil.longs.LongOpenHashSet roads = dev.larattalabs.architect.site.roads.Roads.roadCells(dimensionId(level), box.grow(reach));
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		// the chunk of the last column read (a size-cap box reads 600k cells: no per-cell chunk lookup)
		net.minecraft.world.level.chunk.LevelChunk[] chunk = {null};
		long[] chunkAt = {Long.MIN_VALUE};
		TerrainFit.World world = (x, y, z) -> {
			long key = net.minecraft.world.level.ChunkPos.pack(x >> 4, z >> 4);
			if (key != chunkAt[0]) {
				chunkAt[0] = key;
				chunk[0] = dryRun ? level.getChunkSource().getChunkNow(x >> 4, z >> 4) : level.getChunk(x >> 4, z >> 4);
			}
			if (chunk[0] == null) {
				unloaded[0] = true;
				return 0;
			}
			int fl = y < level.getMinY() || y > level.getMaxY() ? TerrainFit.FILLABLE : TerrainFit.flags(chunk[0].getBlockState(mp.set(x, y, z)));
			return !roads.isEmpty() && roads.contains(BlockPos.asLong(x, y, z)) ? fl | TerrainFit.ROAD : fl;
		};
		TerrainFit.Plan plan = TerrainFit.plan(model, box.minX(), box.minY(), box.minZ(), world);
		tr.mark("terrain");
		Approach.Plan approach = Approach.forBlueprint(bp, turns, box, world);
		tr.mark("approach");
		SiteWarnings.Result site = SiteWarnings.forBlueprint(bp, turns, box, approach, world);
		tr.mark("warnings");
		Anchors.Bounds snapBox = snapshotBox(box, plan, approach);
		if (dryRun && (unloaded[0] || !loaded(level, snapBox))) {
			out.add(Reason.NOT_LOADED, "the site is not loaded on the server (walk closer)");
			return null;
		}
		if (snapBox.minY() < level.getMinY() || box.maxY() > level.getMaxY()) {
			out.add(Reason.BUILD_HEIGHT, "Box " + Anchors.str(snapBox) + " leaves the build height (" + level.getMinY() + ".." + level.getMaxY() + ")");
		}
		List<String> layerNotes = new ArrayList<>();
		if (approach.metRoad()) {
			int[] r = approach.road();
			String road = SiteJournal.ownerSite(dimensionId(level), BlockPos.asLong(r[0], r[1], r[2]));
			int[] feet = approach.feet();
			int last = feet.length == 0 ? box.minY() + bp.groundY() : feet[feet.length - 1];
			int step = Math.abs(r[1] + 1 - last);
			layerNotes.add(step > 1 ? "approach meets road " + road + " with a step of " + step : "approach meets road " + road);
		}
		List<SiteJournal.Hit> hits = overlapCheck(level, snapBox, moving, layer, owner, force, out, layerNotes);
		tr.mark("overlap");
		String lava = TerrainFit.lavaRefusal(plan);
		if (lava == null) {
			lava = Approach.lavaRefusal(approach);
		}
		if (lava != null) {
			out.add(Reason.LAVA, "Not here: " + lava + "; a building next to lava burns and floods");
		}
		if (!force) {
			List<String> foreign = foreignBlockEntities(level, snapBox);
			tr.mark("foreignBE");
			if (!foreign.isEmpty()) {
				out.add(Reason.BLOCK_ENTITIES, "Box " + Anchors.str(snapBox) + " contains " + foreign.size() + " block entit" + (foreign.size() == 1 ? "y" : "ies")
					+ " (" + String.join(", ", foreign.subList(0, Math.min(4, foreign.size()))) + (foreign.size() > 4 ? ", ..." : "")
					+ "); add force to overwrite them (they come back on remove)");
			}
		}
		List<String> doors = straddling(level, snapBox, true);
		tr.mark("doors");
		if (!doors.isEmpty()) {
			out.add(Reason.DOOR_CUT, "Not placed: a door is cut in half by the box edge (" + String.join(", ", doors.subList(0, Math.min(3, doors.size())))
				+ "); raise, lower or move the building so the door is fully in or out");
		}
		if (moving == null && survival) {
			List<String> creative = Builder.creativeOnly(grid, bp);
			if (!creative.isEmpty()) {
				out.add(Reason.CREATIVE_ONLY_BLOCK, "This design uses " + String.join(", ", creative.stream().map(c -> c.replace("minecraft:", "")).toList())
					+ ", which survival can't build");
			}
		}
		List<Occupancy.Found> found = Occupancy.scan(level, snapBox, e -> false);
		tr.mark("occupancy");
		List<String> occupied = Occupancy.refusals(found);
		if (!occupied.isEmpty()) {
			out.add(ApiRules.occupancyReason(found.stream().map(Occupancy.Found::kind).toList()), "Not placed: " + String.join("; ", occupied));
		}
		tr.done();
		return new SitePlan(template, turns, settings, placePos, box, grid, plan, approach, snapBox, found, site, layerNotes, hits);
	}

	/**
	 * The per-cell overlap test (docs/CONTRACT.md phase 4e "Overlap"): the predicted restore box against every standing or
	 * placing entry's cells (guard data never counts). REFUSE: any overlap refuses {@code OVERLAP}. LAYER: the new site goes on
	 * top, unless an overlapped site is busy ({@code OVERLAP_BUSY}: placing, a construction site still building, being
	 * removed), has another owner ({@code OVERLAP_OWNED} without force) or a cell would carry more than 8 layers
	 * ({@code LAYER_DEPTH}). Returns the hits.
	 */
	private static List<SiteJournal.Hit> overlapCheck(ServerLevel level, Anchors.Bounds snapBox, @Nullable Site moving, boolean layer,
		@Nullable String owner, boolean force, Refusals out, List<String> notes) throws SiteException {
		String why = SiteJournal.unavailable();
		if (why != null) {
			out.add(Reason.JOURNAL_UNAVAILABLE, why);
			return List.of();
		}
		List<SiteJournal.Hit> hits = SiteJournal.overlaps(dimensionId(level), snapBox, null);
		if (hits.isEmpty()) {
			return hits;
		}
		if (!layer || moving != null) {
			SiteJournal.Hit h = hits.get(0);
			out.add(Reason.OVERLAP, "Box " + Anchors.str(snapBox) + " overlaps " + (moving != null && h.site().equals(moving.id())
				? "where " + h.site() + " stands now (move it further)" : describe(h.site()) + " (remove it first or place elsewhere)"));
			return hits;
		}
		Map<String, Integer> bySite = new LinkedHashMap<>();
		for (SiteJournal.Hit h : hits) {
			bySite.merge(h.site(), h.cells(), Integer::sum);
		}
		for (SiteJournal.Hit h : hits) {
			String busy = busy(h.site(), h.status());
			if (busy != null) {
				out.add(Reason.OVERLAP_BUSY, "Not yet: " + describe(h.site()) + " " + busy + " (it waits)");
				return hits;
			}
		}
		for (String sid : bySite.keySet()) {
			String o = ownerOf(sid);
			if (!force && !java.util.Objects.equals(o, owner)) {
				out.add(Reason.OVERLAP_OWNED, describe(sid) + " is owned by " + (o == null ? "the player" : o) + "; placing on top of it needs force");
				return hits;
			}
		}
		int depth = hits.get(0).depth();
		if (depth + 1 > SiteJournal.MAX_DEPTH) {
			out.add(Reason.LAYER_DEPTH, "A cell would carry " + (depth + 1) + " layers (at most " + SiteJournal.MAX_DEPTH + ")");
			return hits;
		}
		bySite.forEach((sid, n) -> notes.add("on top of " + describe(sid) + " (" + n + " cell" + (n == 1 ? "" : "s") + ")"));
		return hits;
	}

	/** "site s3 (cabin)", "road r2", "cell site c1 (steward_mc:terrain)". */
	public static String describe(String siteId) {
		Site b = get(siteId);
		if (b != null) {
			return "site " + siteId + " " + Anchors.str(b.box());
		}
		Infra i = Infras.get(siteId);
		if (i != null) {
			return i.describe();
		}
		return siteId.startsWith("group:") ? "the shared crate of " + siteId.substring(6) : "site " + siteId;
	}

	/** The owner of a site, road or cell site (null: the player's). */
	public static @Nullable String ownerOf(String siteId) {
		Site b = get(siteId);
		if (b != null) {
			return b.owner();
		}
		Infra i = Infras.get(siteId);
		if (i != null) {
			return i.owner();
		}
		if (siteId.startsWith(SiteGroupRec.CRATE_PREFIX)) {
			SiteGroupRec g = group(siteId.substring(SiteGroupRec.CRATE_PREFIX.length()));
			return g == null ? null : g.owner();
		}
		return null;
	}

	/** Why a site can't be layered over now (temporary), or null: placing, a construction site building, being removed. */
	static @Nullable String busy(String siteId, Journal.Status status) {
		if (status == Journal.Status.PLACING) {
			return "is still being placed";
		}
		Site b = get(siteId);
		if (b != null && b.placing()) {
			return "is still being placed";
		}
		if (b != null && b.building()) {
			return "is a construction site still building";
		}
		if (Groups.removing(siteId)) {
			return "is being removed";
		}
		Placement.Job job = Placement.job(siteId);
		if (job != null && "remove".equals(job.kind())) {
			return "is being removed";
		}
		Infra i = Infras.get(siteId);
		if (i != null && i.placing()) {
			return "is still being placed";
		}
		return null;
	}

	/**
	 * The block entities in {@code box} that are not an Architect site's own (docs/CONTRACT.md phase 4e "Block entities"): a
	 * cell no entry owns, or one whose container contents differ from the owner's {@code after} (a migrated entry without
	 * {@code after} falls back to its site's pin, as 4d's removal blockers do). An empty template chest of a lower site is
	 * not foreign; a chest the player filled is.
	 */
	private static List<String> foreignBlockEntities(ServerLevel level, Anchors.Bounds box) {
		List<String> out = new ArrayList<>();
		String dim = dimensionId(level);
		forEachBlockEntity(level, box, be -> {
			BlockPos p = be.getBlockPos();
			String what = p.toShortString() + " " + be.getBlockState().getBlock().getDescriptionId().replace("block.minecraft.", "");
			List<WorldJournal.Layer> st;
			try {
				st = WorldJournal.stack(dim, p.asLong());
			} catch (IOException e) {
				st = List.of();
			}
			if (st.isEmpty()) {
				out.add(what);
				return;
			}
			WorldJournal.Layer top = st.get(st.size() - 1);
			Journal.Value after = top.cell().after();
			CompoundTag now = WorldJournal.beNbt(level, p);
			if (after != null) {
				if (!dev.larattalabs.architect.journal.StillOurs.holds(be.getBlockState(), now, WorldJournal.state(after), after.nbt())) {
					out.add(what);
				}
				return;
			}
			Site owner = get(top.meta().site());
			boolean own = owner != null && ownBlockEntities(owner).contains(p);
			if (!own || be instanceof Container c && !c.isEmpty()) {
				out.add(what);
			}
		});
		return out;
	}

	private static boolean loaded(ServerLevel level, Anchors.Bounds box) {
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				if (!level.hasChunk(cx, cz)) {
					return false;
				}
			}
		}
		return true;
	}

	/** The server's verdict on a site: every reason {@link #place} (or {@link #move}) would refuse it for, and its notes. */
	public record Verdict(List<String> refusals, List<String> notes, List<Refusal> typed, Anchors.@Nullable Bounds box,
		Anchors.@Nullable Bounds snapshotBox, boolean construction, List<SiteJournal.Hit> overlaps) {
		public Verdict {
			refusals = List.copyOf(refusals);
			notes = List.copyOf(notes);
			typed = List.copyOf(typed);
			overlaps = List.copyOf(overlaps);
		}

		public Verdict(List<String> refusals, List<String> notes, List<Refusal> typed, Anchors.@Nullable Bounds box, Anchors.@Nullable Bounds snapshotBox,
			boolean construction) {
			this(refusals, notes, typed, box, snapshotBox, construction, List.of());
		}

		public Verdict(List<String> refusals, List<String> notes) {
			this(refusals, notes, refusals.stream().map(r -> new Refusal(Reason.OTHER, r)).toList(), null, null, false);
		}

		public boolean ok() {
			return refusals.isEmpty();
		}
	}

	/** {@link Verdict} for placing {@code bp} (or moving {@code movingId} with it); changes nothing; never loads a chunk. Server thread. */
	public static Verdict verdict(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String movingId) {
		return verdict(level, bp, origin, rotation, force, movingId, true);
	}

	public static Verdict verdict(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String movingId,
		boolean dryRun) {
		return verdict(level, bp, origin, rotation, force, movingId, dryRun, null);
	}

	/** {@link #verdict}; {@code construction}: null = the world's toggle, else whether it would be a construction site. */
	public static Verdict verdict(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String movingId,
		boolean dryRun, @Nullable Boolean construction) {
		return verdict(level, bp, origin, rotation, force, movingId, dryRun, construction, false, null);
	}

	/** {@link #verdict}; {@code layer}: the LAYER overlap policy, {@code owner} the request's owner (phase 4e). */
	public static Verdict verdict(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String movingId,
		boolean dryRun, @Nullable Boolean construction, boolean layer, @Nullable String owner) {
		List<Refusal> typed = new ArrayList<>();
		Refusals out = (r, m) -> typed.add(new Refusal(r, m));
		boolean survival = construction != null ? construction : SurvivalWorld.on();
		Site moving = null;
		SitePlan site = null;
		try {
			if (loadFailed) {
				out.add(Reason.OTHER, FILE + " could not be read when the world started (see the log); fix or move it, then restart");
			}
			if (movingId != null) {
				moving = get(movingId);
				if (moving == null) {
					return verdictOf(List.of(new Refusal(Reason.OTHER, "No site " + movingId)), List.of(), null, survival);
				}
				String noMove = moveRefusal(moving);
				if (noMove != null) {
					return verdictOf(List.of(new Refusal(Reason.NOT_ALLOWED, noMove)), List.of(), null, survival);
				}
				ServerLevel oldLevel = levelOf(level.getServer(), moving);
				if (oldLevel == null) {
					out.add(Reason.NOT_LOADED, moving.dimension() + " is not loaded; nothing was moved");
				}
				Site m = moving;
				if (oldLevel != null && (!dryRun || loaded(oldLevel, m.restoreBox()))) {
					try {
						refusePlayerIn(oldLevel, m.restoreBox(), movingId, "moving it");
					} catch (SiteException e) {
						out.add(e.reason(), e.getMessage());
					}
					if (!force) {
						List<String> blockers = removalBlockers(oldLevel, moving);
						if (!blockers.isEmpty()) {
							out.add(Reason.BLOCK_ENTITIES, blockersMessage(movingId, blockers).replace("removing it", "moving it"));
						}
					}
				}
			}
			site = checkSite(level, bp, origin, rotation, force, moving, out, dryRun, survival && moving == null, layer, owner);
			if (site != null && typed.isEmpty() && moving == null) {
				checked = new Checked(checkKey(level, bp, origin, rotation, force, survival, layer, owner), level.getServer().getTickCount(), site);
			}
			List<String> notes = new ArrayList<>(site == null ? List.of() : siteNotes(site, site.found()));
			if (site != null) {
				notes.addAll(site.layerNotes());
			}
			return verdictOf(typed, notes, site, survival);
		} catch (SiteException | RuntimeException e) {
			typed.add(new Refusal(e instanceof SiteException se ? se.reason() : Reason.OTHER, e.getMessage() == null ? e.toString() : e.getMessage()));
			return verdictOf(typed, List.of(), site, survival);
		}
	}

	private static Verdict verdictOf(List<Refusal> typed, List<String> notes, @Nullable SitePlan site, boolean construction) {
		return new Verdict(typed.stream().map(Refusal::message).toList(), notes, typed, site == null ? null : site.box(),
			site == null ? null : site.snapBox(), construction, site == null ? List.of() : site.overlaps());
	}

	private static List<String> siteNotes(SitePlan s, List<Occupancy.Found> found) {
		List<String> notes = new ArrayList<>();
		String gone = Occupancy.removalNote(found);
		if (gone != null) {
			notes.add(gone);
		}
		String water = TerrainFit.waterWarning(s.plan());
		if (water != null) {
			notes.add(water + " (filled below the floor; water next to the walls stays)");
		}
		String wet = Approach.waterWarning(s.approach());
		if (wet != null) {
			notes.add(wet);
		}
		String shortOf = Approach.shortWarning(s.approach());
		if (shortOf != null) {
			notes.add(shortOf);
		}
		notes.addAll(s.site().warnings());
		return notes;
	}

	/**
	 * Checks a site (the first refusal thrown) and puts the template there (P1-P7 of docs/CONTRACT.md phase 4e "Crash safety"):
	 * the box captured into the journal (one tick) and committed PLACING first, then the record (placing; a move keeps the
	 * standing record), then the template, foundation, cleared terrain, the approach, and drops caused by it removed; then (an
	 * instant site) the {@code after} capture and the ACTIVE commit. A construction site's {@code after} is its target, taken by
	 * {@link Builder#convertNow}. Rolls back and throws when anything fails.
	 */
	private static Built build(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable Site moving, String id,
		boolean survival, boolean layer, Who who) throws SiteException {
		SitePlan site = checkSite(level, bp, origin, rotation, force, moving, THROW, false, survival, layer, who.siteOwner());
		if (site == null) {
			throw new SiteException("Internal: no site for " + bp.id());
		}
		MinecraftServer server = level.getServer();
		Anchors.Bounds box = site.box();
		TerrainFit.Plan plan = site.plan();
		Approach.Plan approach = site.approach();
		Anchors.Bounds snapBox = site.snapBox();
		int turns = site.turns();
		// P1: the capture (one tick), the leaves to hold (not other sites' cells), the leaf ring
		List<Integer> held = SiteJournal.holdable(level, snapBox);
		int[] ring = LeafGuard.ring(level, snapBox);
		Site rec = new Site(id, bp.id(), BlueprintTransform.rotationName(turns), box, BlueprintTransform.worldBounds(bp, turns, box.minX(), box.minY(),
			box.minZ()), BlueprintTransform.worldAnchors(bp, turns, box.minX(), box.minY(), box.minZ()), moving != null ? moving.placedAt()
				: System.currentTimeMillis(), dimensionId(level), snapBox, journalName(id), moving != null ? moving.movedFrom() : null,
			pinFor(site.grid(), turns), null, moving != null ? moving.owner() : who.siteOwner(), moving != null ? moving.ext() : who.ext(),
			moving != null ? moving.member() : who.member(), true);
		// P2-P3: the PLACING commit (a single Place commits synchronously); positions changed meanwhile are captured again
		List<BlockPos> cutPlants = straddlingPositions(level, snapBox, false);
		long[] cutAt = cutPlants.stream().mapToLong(BlockPos::asLong).toArray();
		SiteJournal.Placing placing = SiteJournal.begin(level, id, WorldJournal.SITE, rec.group(), snapBox, held, cutAt, rec.toJson(), ring, null);
		try {
			SiteJournal.await(placing.commit, "the terrain of " + id);
			for (java.util.concurrent.CompletableFuture<Void> f; (f = SiteJournal.retake(level, placing)) != null;) {
				SiteJournal.await(f, "the terrain of " + id);
			}
		} finally {
			placing.stopTracking();
		}
		WorldJournal.kill("K2");
		// P4: the record, placing
		if (moving == null) {
			putRecord(server, rec);
		}
		// P5: the blocks (4d's writes, unchanged)
		List<BlockPos> plants = straddlingPositions(level, snapBox, false);
		Drops drops = Drops.before(level, snapBox);
		// leaves outside the box that hang on logs inside it: kept from decaying while the site stands (before the box changes)
		LeafGuard.holdCells(level, held, FLAGS);
		try {
			int removed = 0;
			for (Entity e : level.getEntities((Entity) null, Occupancy.aabb(snapBox), e -> !(e instanceof Player) && e.isAlive())) {
				if (Occupancy.classify(e).removable()) {
					e.discard();
					removed++;
				}
			}
			if (!site.template().placeInWorld(level, site.placePos(), site.placePos(), site.settings(), level.getRandom(), FLAGS)) {
				throw new IllegalStateException("template " + bp.id() + " placed nothing (empty template?)");
			}
			BedsOut beds = removeUnsafeBeds(level, site.grid(), site.turns(), box);
			BlockState foundation = foundationState(bp);
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			for (int i = 0; i < plan.fill().length; i += 3) {
				level.setBlock(m.set(plan.fill()[i], plan.fill()[i + 1], plan.fill()[i + 2]), foundation, FLAGS);
			}
			for (int i = 0; i < plan.clear().length; i += 3) {
				level.setBlock(m.set(plan.clear()[i], plan.clear()[i + 1], plan.clear()[i + 2]), Blocks.AIR.defaultBlockState(), FLAGS);
			}
			applyApproach(level, bp, approach, foundation);
			// a tall plant whose other half was inside the box (now gone) would float: take its outside half too
			for (BlockPos half : plants) {
				BlockState outside = level.getBlockState(half);
				BlockPos inside = half.getY() < snapBox.minY() ? half.above() : half.below();
				if (!level.getBlockState(inside).is(outside.getBlock())) {
					level.setBlock(half, Blocks.AIR.defaultBlockState(), FLAGS);
				}
			}
			drops.clearNew(level);
			List<String> notes = new ArrayList<>();
			String bedNote = BedSafety.note(beds.heads().size(), dimensionId(level));
			if (bedNote != null) {
				notes.add(bedNote);
			}
			String gone = Occupancy.removalNote(site.found());
			if (gone != null && removed > 0) {
				notes.add(gone);
			}
			String water = TerrainFit.waterWarning(plan);
			if (water != null) {
				notes.add(water + " (filled below the floor; water next to the walls stays)");
			}
			if (plan.fillCount() > 0) {
				notes.add(plan.fillCount() + " foundation block" + (plan.fillCount() == 1 ? "" : "s"));
			}
			if (plan.clearCount() > 0) {
				notes.add(plan.clearCount() + " terrain block" + (plan.clearCount() == 1 ? "" : "s") + " cleared");
			}
			String wet = Approach.waterWarning(approach);
			if (wet != null) {
				notes.add(wet);
			}
			if (approach.rows() > 0) {
				notes.add("entrance approach " + approach.rows() + " rows (" + approach.changed() + " blocks)");
			}
			String shortOf = Approach.shortWarning(approach);
			if (shortOf != null) {
				notes.add(shortOf);
			}
			notes.addAll(site.site().warnings());
			notes.addAll(site.layerNotes());
			Site.Pin pin = pinFor(site.grid(), turns, beds.cells(), box);
			// P6-P7 (instant): the after capture and the ACTIVE commit; a construction site's after is its target (convertNow)
			if (!survival) {
				SiteJournal.await(SiteJournal.complete(id, WorldJournal.capture(level, snapBox), null), "the placement of " + id);
				WorldJournal.kill("K4");
			}
			return new Built(turns, box, snapBox, BlueprintTransform.worldBounds(bp, turns, box.minX(), box.minY(), box.minZ()),
				BlueprintTransform.worldAnchors(bp, turns, box.minX(), box.minY(), box.minZ()), pin, notes.isEmpty() ? null : String.join("; ", notes),
				site.grid(), plan, approach, rec, placing.entries());
		} catch (RuntimeException | SiteException e) {
			// never leave a half-built box behind: its journal entries put it back as it was captured
			Architect.LOGGER.error("Placing {} at {} failed; restoring box {}", bp.id(), origin.toShortString(), Anchors.str(snapBox), e);
			abortPlacement(level, id, moving == null, placing.entries());
			throw new SiteException("Placing " + bp.id() + " failed (" + e.getMessage() + "); the area was restored");
		}
	}

	/** Two-block-high blocks (doors, tall plants) cut by the box's top or bottom face. {@code doors}: only doors, else only the others. */
	public static List<String> straddling(net.minecraft.world.level.BlockGetter level, Anchors.Bounds box, boolean doors) {
		List<String> out = new ArrayList<>();
		for (BlockPos p : straddlingPositions(level, box, doors)) {
			out.add(p.toShortString());
		}
		return out;
	}

	private static List<BlockPos> straddlingPositions(net.minecraft.world.level.BlockGetter level, Anchors.Bounds box, boolean doors) {
		List<BlockPos> out = new ArrayList<>();
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (int z = box.minZ(); z <= box.maxZ(); z++) {
			for (int x = box.minX(); x <= box.maxX(); x++) {
				for (int[] face : new int[][] {{box.minY(), -1}, {box.maxY(), 1}}) {
					BlockState in = level.getBlockState(m.set(x, face[0], z));
					if (!in.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF)) {
						continue;
					}
					DoubleBlockHalf half = in.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF);
					if (face[1] < 0 ? half != DoubleBlockHalf.UPPER : half != DoubleBlockHalf.LOWER) {
						continue;
					}
					BlockPos outside = new BlockPos(x, face[0] + face[1], z);
					if (!level.getBlockState(outside).is(in.getBlock())) {
						continue;
					}
					boolean door = in.getBlock() instanceof DoorBlock;
					if (door == doors) {
						out.add(doors ? new BlockPos(x, face[0], z) : outside);
					}
				}
			}
		}
		return out;
	}

	/** The box a placement snapshots and restores: the template's box, grown down to the foundation and out over the approach. */
	public static Anchors.Bounds snapshotBox(Anchors.Bounds box, TerrainFit.Plan plan, Approach.Plan approach) {
		Anchors.Bounds u = approach.union(box);
		// one row more below the lowest written cell: the ground under the foundation changes while the site stands (grass
		// under a solid block turns to dirt), and Remove must put that back too
		return new Anchors.Bounds(u.minX(), Math.min(u.minY(), plan.minY()) - 1, u.minZ(), u.maxX(), u.maxY(), u.maxZ());
	}

	private static void applyApproach(ServerLevel level, Blueprint bp, Approach.Plan a, BlockState foundation) {
		if (a.rows() == 0) {
			return;
		}
		BlockState path = blockState(bp.approach().block(), Approach.DEFAULT_BLOCK, bp.id());
		BlockState slab = blockState(bp.approach().slab(), Approach.DEFAULT_SLAB, bp.id());
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		BlockState air = Blocks.AIR.defaultBlockState();
		for (int i = 0; i < a.clear().length; i += 3) {
			level.setBlock(m.set(a.clear()[i], a.clear()[i + 1], a.clear()[i + 2]), air, FLAGS);
		}
		for (int i = 0; i < a.fill().length; i += 3) {
			level.setBlock(m.set(a.fill()[i], a.fill()[i + 1], a.fill()[i + 2]), foundation, FLAGS);
		}
		for (int i = 0; i < a.path().length; i += 3) {
			level.setBlock(m.set(a.path()[i], a.path()[i + 1], a.path()[i + 2]), path, FLAGS);
		}
		for (int i = 0; i < a.slabs().length; i += 3) {
			level.setBlock(m.set(a.slabs()[i], a.slabs()[i + 1], a.slabs()[i + 2]), slab, FLAGS);
		}
	}

	private static BlockState blockState(@Nullable String id, String def, String bpId) {
		Identifier key = id == null ? null : Identifier.tryParse(id);
		Block b = key == null ? null : BuiltInRegistries.BLOCK.getOptional(key).orElse(null);
		if (b == null || b == Blocks.AIR) {
			Architect.LOGGER.warn("Design {}: approach block {} is not a block; using {}", bpId, id, def);
			b = BuiltInRegistries.BLOCK.getValue(Identifier.parse(def));
		}
		return b.defaultBlockState();
	}

	static BlockState foundationState(Blueprint bp) {
		Identifier key = Identifier.tryParse(bp.foundationBlock());
		Block b = key == null ? null : BuiltInRegistries.BLOCK.getOptional(key).orElse(null);
		if (b == null || b == Blocks.AIR) {
			Architect.LOGGER.warn("Design {}: foundationBlock {} is not a block; using {}", bp.id(), bp.foundationBlock(), Blueprint.DEFAULT_FOUNDATION);
			b = Blocks.STONE_BRICKS;
		}
		return b.defaultBlockState();
	}

	// ------------------------------------------------------------------ remove / move

	/** How a removal treats cells another site covers (docs/CONTRACT.md phase 4e {@code CoveredPolicy}). */
	public enum Covered {
		/** Hand-down: covered cells stay as they are; the site on top later restores the original ground. */
		KEEP,
		/** First remove every site that covers this one, top-down, recursively, as one undo group. */
		CASCADE,
		/** Refuse {@code COVERED} when another site covers any cell. */
		REFUSE
	}

	/**
	 * Puts back exactly what was in the site's box (foundation and approach included) before it was placed, then forgets the
	 * site. Refuses, listing them, when the box holds things the site did not bring ({@link #removalBlockers}) unless
	 * {@code force}. Its journal entries stay (undone) until the next world start confirms the restored terrain reached the
	 * disk. Server thread.
	 */
	public static Site remove(ServerLevel level, String id, boolean force) throws SiteException {
		return removeDetailed(level, id, force).site();
	}

	/**
	 * What a removal did: the site as it was and every item a deconstruct dropped (refunds, the player's blocks, the crate's
	 * stock; item id -> count; empty for an instant site); phase 4e: the cells restored, the CELL cells the player changed and
	 * kept, the cells handed down per covering site, and the sites a cascade removed first.
	 */
	public record Removed(Site site, Map<String, Integer> returned, int restored, int kept, Map<String, Integer> handedDown, List<String> cascaded,
		List<String> notes) {
		public Removed(Site site, Map<String, Integer> returned) {
			this(site, returned, 0, 0, Map.of(), List.of(), List.of());
		}
	}

	/** {@link #remove}, returning what it gave back. Fires {@code SITE_REMOVED}. Server thread. */
	public static Removed removeDetailed(ServerLevel level, String id, boolean force) throws SiteException {
		return removeDetailed(level, id, force, Covered.KEEP);
	}

	/**
	 * {@link #removeDetailed} with a covered policy: R1-R4 of docs/CONTRACT.md phase 4e "Remove" (one plan, one commit, the
	 * records pending, then the writes). Server thread.
	 */
	public static Removed removeDetailed(ServerLevel level, String id, boolean force, Covered covered) throws SiteException {
		Site b = get(id);
		if (b == null) {
			throw new SiteException("No site " + id + " (see /architect list)");
		}
		if (!b.dimension().equals(dimensionId(level))) {
			throw new SiteException(id + " is in " + b.dimension() + ", not in " + dimensionId(level) + ": remove it from there");
		}
		SiteJournal.requireAvailable();
		Trace tr = new Trace("remove " + id);
		MinecraftServer server = level.getServer();
		if (SiteJournal.active(id).isEmpty()) {
			throw new SiteException("The saved terrain of " + id + " (" + b.snapshot() + ") is not in the world journal, so it cannot be restored; "
				+ "/architect remove " + id + " forget drops the record and leaves the blocks");
		}
		refusePlayerIn(level, b.restoreBox(), id, "removing it");
		if (b.placing()) {
			// Remove during placing cancels the job and restores the box (phase 4d): it was never placed
			Placement.abort(server, id, "removed while it was being placed");
			return rollbackNow(level, b);
		}
		// the sites covering it (phase 4e)
		List<String> cascade = new ArrayList<>();
		List<String> cover = SiteJournal.coveringSites(id);
		if (!cover.isEmpty()) {
			if (covered == Covered.REFUSE) {
				throw new SiteException(Reason.COVERED, cover.size() + " site(s) cover cells of " + id + " (" + String.join(", ", cover.stream()
					.map(Sites::describe).toList()) + "); remove them first, or remove with KEEP or CASCADE");
			}
			if (covered == Covered.CASCADE) {
				cascade.addAll(cascadeOf(id));
			}
		}
		List<Site> all = new ArrayList<>();
		for (String c : cascade) {
			Site cs = get(c);
			if (cs == null) {
				if (Infras.get(c) != null) {
					continue; // a road or cell site in the cascade: its records are handled below
				}
				throw new SiteException("Cascade: " + describe(c) + " can't be removed with " + id);
			}
			if (cs.placing() || cs.building()) {
				throw new SiteException(Reason.OVERLAP_BUSY, "Cascade: " + c + (cs.placing() ? " is still being placed" : " is a construction site still building"));
			}
			refusePlayerIn(level, cs.restoreBox(), c, "removing it");
			all.add(cs);
		}
		all.add(b);
		if (!force) {
			for (Site x : all) {
				List<String> blockers = removalBlockers(level, x);
				if (!blockers.isEmpty()) {
					throw new SiteException(blockersMessage(x.id(), blockers));
				}
			}
		}
		tr.mark("checks");
		// a construction site deconstructs: refunds for paid cells still standing, against the stacks before the undo (rule 7)
		Map<String, Builder.Deconstruction> decs = new LinkedHashMap<>();
		for (Site x : all) {
			if (x.construction() != null) {
				decs.put(x.id(), Builder.prepareDeconstruct(level, x));
			}
		}
		Anchors.Bounds u = all.get(0).restoreBox();
		for (Site x : all) {
			u = union(u, x.restoreBox());
		}
		Drops drops = Drops.before(level, u);
		tr.mark("drops");
		List<String> ids = new ArrayList<>(all.stream().map(Site::id).toList());
		for (String c : cascade) {
			if (Infras.get(c) != null) {
				ids.add(0, c);
			}
		}
		WorldJournal.kill("K5");
		String group = SiteJournal.group(id);
		SiteJournal.Undone undone = SiteJournal.undo(level, ids, group);
		tr.mark("plan");
		SiteJournal.await(undone.commit(), "the removal of " + id);
		tr.mark("commit");
		WorldJournal.kill("K6");
		// R3: the records pending
		for (Site x : all) {
			markPending(server, x, "removed");
		}
		for (String c : cascade) {
			if (Infras.get(c) != null) {
				Infras.markPending(server, c);
			}
		}
		// R4: the writes, top first (the cascade is ordered top-down)
		Removed last = null;
		Map<String, Integer> handed = handedBySite(undone.work());
		tr.mark("pending");
		for (String c : cascade) {
			if (Infras.get(c) == null && Infras.pending(c) != null) {
				Infras.finishRemoval(level, c, group, true);
			}
		}
		for (Site x : all) {
			SiteJournal.Restore r = SiteJournal.writeNow(level, x.id(), group);
			tr.mark("write " + x.id());
			Journal.Stats st = statsOf(undone.work(), x.id());
			Removed done = afterRestore(level, x, decs.get(x.id()), drops, force, true, r.ring(), st, x.id().equals(id) ? handed : Map.of(),
				x.id().equals(id) ? cascade : List.of(), notesOf(level, r));
			tr.mark("after " + x.id());
			if (x.id().equals(id)) {
				last = done;
			}
		}
		tr.done();
		return last;
	}

	/**
	 * A large site's removal over ticks (phase 4e, the size cap: no tick over 50 ms): R1 planned per section over ticks, R2,
	 * R3, then R4 written by a {@link RestoreJob}. Null when the site is small (more than {@link SiteJournal#SYNC_CELLS} cells
	 * in its restore box qualify), a construction site, placing, or covered with CASCADE: those remove at once
	 * ({@link #removeDetailed}). The checks are the atomic removal's (a player in the box, the player's things, REFUSE). Server
	 * thread.
	 */
	public static java.util.concurrent.@Nullable CompletableFuture<Removed> removeLarge(ServerLevel level, String id, boolean force, Covered covered)
		throws SiteException {
		Site b = get(id);
		if (b == null || b.placing() || b.construction() != null || b.restoreBox().volume() <= SiteJournal.SYNC_CELLS) {
			return null;
		}
		Placement.Job running = Placement.job(id);
		if (running instanceof RestoreJob rj && RestoreJob.REMOVE.equals(rj.purpose)) {
			java.util.concurrent.CompletableFuture<Removed> f = new java.util.concurrent.CompletableFuture<>();
			rj.futures.add(f);
			return f;
		}
		if (!b.dimension().equals(dimensionId(level))) {
			throw new SiteException(id + " is in " + b.dimension() + ", not in " + dimensionId(level) + ": remove it from there");
		}
		SiteJournal.requireAvailable();
		List<String> cover = SiteJournal.coveringSites(id);
		if (!cover.isEmpty()) {
			if (covered == Covered.REFUSE) {
				throw new SiteException(Reason.COVERED, cover.size() + " site(s) cover cells of " + id + " (" + String.join(", ", cover.stream()
					.map(Sites::describe).toList()) + "); remove them first, or remove with KEEP or CASCADE");
			}
			if (covered == Covered.CASCADE) {
				return null;
			}
		}
		refusePlayerIn(level, b.restoreBox(), id, "removing it");
		if (!force) {
			List<String> blockers = removalBlockers(level, b);
			if (!blockers.isEmpty()) {
				throw new SiteException(blockersMessage(id, blockers));
			}
		}
		RestoreJob job = new RestoreJob(id, RestoreJob.REMOVE, null, null);
		java.util.concurrent.CompletableFuture<Removed> f = new java.util.concurrent.CompletableFuture<>();
		job.futures.add(f);
		Placement.add(level.getServer(), job);
		Architect.LOGGER.info("Removing {} over ticks ({} cells in its restore box)", id, b.restoreBox().volume());
		return f;
	}

	/** The sites covering {@code id}, recursively, top-down (the highest layer first). */
	private static List<String> cascadeOf(String id) {
		List<String> out = new ArrayList<>();
		java.util.ArrayDeque<String> todo = new java.util.ArrayDeque<>(SiteJournal.coveringSites(id));
		while (!todo.isEmpty()) {
			String c = todo.poll();
			if (out.contains(c) || c.equals(id)) {
				continue;
			}
			out.add(c);
			todo.addAll(SiteJournal.coveringSites(c));
		}
		out.sort(java.util.Comparator.comparingLong((String c) -> {
			JournalStore.Meta m = SiteJournal.main(c);
			return m == null ? 0 : m.layer();
		}).reversed());
		return out;
	}

	/** The stats of a site's entries in an undo, summed. */
	static Journal.Stats statsOf(WorldJournal.UndoWork w, String siteId) {
		int r = 0;
		int k = 0;
		int c = 0;
		for (JournalStore.Meta m : SiteJournal.entries(siteId)) {
			Journal.Stats s = w.plan().stats().get(m.id());
			if (s != null) {
				r += s.restored();
				k += s.changed();
				c += s.covered();
			}
		}
		return new Journal.Stats(r, k, c);
	}

	/** Hand-downs of an undo, per receiving site. */
	static Map<String, Integer> handedBySite(WorldJournal.UndoWork w) {
		Map<String, Integer> out = new java.util.TreeMap<>();
		JournalStore s = WorldJournal.storeOrNull();
		w.handedDown().forEach((entry, n) -> {
			JournalStore.Meta m = s == null ? null : s.meta(entry);
			out.merge(m == null ? entry : m.site(), n, Integer::sum);
		});
		return out;
	}

	/** Notes of a restore with holes: cells of the site on top that may now be unsupported stay as they are. */
	private static List<String> notesOf(ServerLevel level, SiteJournal.Restore r) {
		if (r.holes() == 0) {
			return List.of();
		}
		return List.of(r.holes() + " cell(s) covered by a site that stays were left as they are (they come back when it is removed)");
	}

	static Anchors.Bounds union(Anchors.Bounds a, Anchors.Bounds b) {
		return new Anchors.Bounds(Math.min(a.minX(), b.minX()), Math.min(a.minY(), b.minY()), Math.min(a.minZ(), b.minZ()), Math.max(a.maxX(), b.maxX()),
			Math.max(a.maxY(), b.maxY()), Math.max(a.maxZ(), b.maxZ()));
	}

	/** R3: a standing record becomes pending (its undo is committed; the writes follow). */
	/** {@link #markPending} for many sites in one change of state (one save; a group of 48 sites took 96 ms one by one). */
	static void markPendingAll(MinecraftServer server, List<Site> sites, String why) {
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		List<Site.Pending> pending = new ArrayList<>(s.pending());
		long now = System.currentTimeMillis();
		for (Site b : sites) {
			map.remove(b.id());
			pending.removeIf(p -> p.site().id().equals(b.id()) && p.site().placedAt() == b.placedAt() && "removed".equals(p.why()));
			pending.add(new Site.Pending(b, now, why));
			reports.remove(b.id());
			dropFromGroup(b);
		}
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), List.copyOf(pending)));
	}

	static void markPending(MinecraftServer server, Site b, String why) {
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.remove(b.id());
		List<Site.Pending> pending = new ArrayList<>(s.pending());
		pending.removeIf(p -> p.site().id().equals(b.id()) && p.site().placedAt() == b.placedAt() && "removed".equals(p.why()));
		pending.add(new Site.Pending(b, System.currentTimeMillis(), why));
		reports.remove(b.id());
		dropFromGroup(b);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), List.copyOf(pending)));
	}

	/** A placing site rolled back at once (Remove during placing): undo of its PLACING entries, the record pending, the writes. */
	private static Removed rollbackNow(ServerLevel level, Site b) throws SiteException {
		MinecraftServer server = level.getServer();
		Drops drops = Drops.before(level, b.restoreBox());
		String group = SiteJournal.group("rollback-" + b.id());
		SiteJournal.Undone undone = SiteJournal.undo(level, List.of(b.id()), group);
		SiteJournal.await(undone.commit(), "the rollback of " + b.id());
		markPending(server, b, "removed");
		SiteJournal.Restore r = SiteJournal.writeNow(level, b.id(), group);
		Architect.LOGGER.info("Rolled back site {} ({}) that was still being placed", b.id(), b.blueprint());
		return afterRestore(level, b, null, drops, true, false, r.ring(), statsOf(undone.work(), b.id()), Map.of(), List.of(), List.of());
	}

	/** {@link #restoreTemplate} with the leaf ticks it schedules dropped (the other ticks run as usual): the restored leaves
	 * keep their recorded distances instead of relaxing (phase 4d). */
	static void restoreQuietly(ServerLevel level, Anchors.Bounds box, CompoundTag tpl) {
		List<TickDeferral.Held> held = new ArrayList<>();
		TickDeferral.begin(level, held);
		try {
			restoreTemplate(level, box, tpl);
		} finally {
			TickDeferral.end();
		}
		TickDeferral.release(level, TickDeferral.withoutLeaves(held));
	}

	/**
	 * The rest of a removal once the box holds its old terrain again (the record already pending, R3): drops cleared (and a
	 * deconstruct's items dropped), the leaves near it held again by standing sites, the leaf ring given back. {@code event}:
	 * fire SITE_REMOVED.
	 */
	private static Removed afterRestore(ServerLevel level, Site b, Builder.@Nullable Deconstruction dec, Drops drops, boolean force, boolean event,
		int[] ring, Journal.Stats stats, Map<String, Integer> handed, List<String> cascaded, List<String> notes) {
		MinecraftServer server = level.getServer();
		String id = b.id();
		drops.clearNew(level);
		if (dec != null) {
			Builder.dropDeconstruction(level, b, dec, drops);
		} else {
			Builder.forget(server, id);
		}
		reholdNear(level, b.restoreBox());
		// the leaves around the box get the distances they had before the site (worldgen leaves relax once touched)
		SiteJournal.restoreRing(level, ring);
		save(server, state);
		notifyListeners();
		Architect.LOGGER.info("Removed site {} ({}): restored box {}{}; its journal entries are kept until the next world start", id, b.blueprint(),
			Anchors.str(b.restoreBox()), force ? " (forced)" : "");
		Removed r = new Removed(b, dec == null ? Map.of() : Map.copyOf(dec.all()), stats.restored(), stats.changed(), handed, cascaded, notes);
		if (event) {
			ApiEvents.removed(server, r);
		}
		return r;
	}

	/** Refuses when a player stands in (or next to) a box about to get its old terrain back: restoring it would bury them. */
	static void refusePlayerIn(ServerLevel level, Anchors.Bounds box, String id, String verb) throws SiteException {
		for (Occupancy.Found f : Occupancy.scan(level, box, e -> false)) {
			if (f.kind() == Occupancy.Kind.PLAYER) {
				throw new SiteException(Reason.PLAYER_IN_BOX, "Step out of " + id + " first (" + f.name() + " is in or next to it): " + verb
					+ " puts the old terrain back there; nothing was done");
			}
		}
	}

	public static String blockersMessage(String id, List<String> blockers) {
		return "Move these out of " + id + " first (removing it puts the old terrain back over them): "
			+ String.join(", ", blockers.subList(0, Math.min(6, blockers.size()))) + (blockers.size() > 6 ? ", ... (" + blockers.size() + " in all)" : "")
			+ ". Or confirm again with force: they are lost";
	}

	/**
	 * What a removal would destroy that the site did not bring: block entities where the template has none, template
	 * containers / lecterns the player filled, dropped items (not natural drops), pets, item frames, armor stands; phase 4e:
	 * only over the cells the site owns (a covered cell belongs to the site on top). Server thread.
	 */
	public static List<String> removalBlockers(ServerLevel level, Site b) {
		List<String> out = new ArrayList<>();
		Set<BlockPos> own = ownBlockEntities(b);
		Anchors.Bounds box = b.restoreBox();
		String dim = dimensionId(level);
		forEachBlockEntity(level, box, be -> {
			BlockPos p = be.getBlockPos();
			List<WorldJournal.Layer> st;
			try {
				st = WorldJournal.stack(dim, p.asLong());
			} catch (java.io.IOException e) {
				st = List.of();
			}
			WorldJournal.Layer top = st.isEmpty() ? null : st.get(st.size() - 1);
			if (top != null && !b.id().equals(top.meta().site())) {
				return; // another site's cell (it covers this one)
			}
			// phase 4e: a block entity in the site's journal after (a BOX site layered over another keeps what it stood on) is the site's
			boolean journalOwn = top != null && top.cell().after() != null && WorldJournal.holds(level, p.asLong(), top.cell().after());
			String what = be.getBlockState().getBlock().getName().getString().toLowerCase(java.util.Locale.ROOT) + " at " + p.toShortString();
			if (be instanceof LecternBlockEntity lectern) {
				if (lectern.hasBook() || !own.contains(p) && !journalOwn) {
					out.add(what + (lectern.hasBook() ? " (with a book)" : ""));
				}
				return;
			}
			if (be instanceof Container c && !c.isEmpty()) {
				out.add(what + " (" + items(c) + ")");
				return;
			}
			if (!own.contains(p) && !journalOwn) {
				out.add(what);
			}
		});
		int dropped = 0;
		for (Entity e : level.getEntities((Entity) null, Occupancy.aabb(box), e -> e.isAlive() && !(e instanceof Player))) {
			Occupancy.Found f = Occupancy.classify(e);
			if (f.kind() == Occupancy.Kind.ITEM && !(e instanceof ItemEntity)) {
				out.add(f.name() + " at " + e.blockPosition().toShortString());
			} else if (f.kind() == Occupancy.Kind.ITEM) {
				if (!(e instanceof ItemEntity item && NaturalDrops.natural(item))) {
					dropped++;
				}
			} else if (!f.removable()) {
				out.add(f.name() + " at " + e.blockPosition().toShortString());
			}
		}
		if (dropped > 0) {
			out.add(dropped + " dropped item stack" + (dropped == 1 ? "" : "s"));
		}
		return out;
	}

	private static String items(Container c) {
		int n = 0;
		for (int i = 0; i < c.getContainerSize(); i++) {
			n += c.getItem(i).getCount();
		}
		return n + " item" + (n == 1 ? "" : "s");
	}

	/** World positions of the block entities the site brought (its pin). */
	static Set<BlockPos> ownBlockEntities(Site b) {
		Set<BlockPos> out = new HashSet<>();
		if (b.pin() == null) {
			return out;
		}
		List<Integer> be = b.pin().blockEntities();
		for (int i = 0; i + 2 < be.size(); i += 3) {
			out.add(new BlockPos(b.box().minX() + be.get(i), b.box().minY() + be.get(i + 1), b.box().minZ() + be.get(i + 2)));
		}
		return out;
	}

	/**
	 * Drops the record of a site without touching the world: its blocks stay for good and its journal entries are released.
	 * Refused when an entry lies under it (forgetting it would make the lower site's undo wipe the forgotten blocks); a site
	 * with entries above it is fine (their befores hold its blocks).
	 */
	public static void forget(MinecraftServer server, String id) throws SiteException {
		State s = state;
		Site b = s.byId().get(id);
		if (b == null) {
			throw new SiteException("No site " + id);
		}
		String under = SiteJournal.below(id);
		if (under != null) {
			throw new SiteException(Reason.NOT_ALLOWED, id + " lies on top of " + describe(under) + ": forget or remove the sites under it first");
		}
		if (WorldJournal.unavailable() == null) {
			SiteJournal.await(SiteJournal.release(id), "forgetting " + id);
		}
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.remove(id);
		reports.remove(id);
		dropFromGroup(b);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), s.pending()));
		if (b.construction() != null) {
			Builder.forget(server, id);
		}
	}

	/** Replaces a standing site's record (construction state changes: built, paused, free cells) and saves. Server thread. */
	static void replace(MinecraftServer server, Site b) {
		State s = state;
		if (!s.byId().containsKey(b.id())) {
			return;
		}
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.put(b.id(), b);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), s.pending()));
	}

	/**
	 * Moves a site: the same id at a new place in {@code level}. The new place gets every check of {@link #place} (it may not
	 * overlap the old one); the old site must be clear of the player's things unless {@code force}. Places at the new site,
	 * then restores the old one (its entries kept until the next world start, as for a removal) and records the old place in
	 * {@link Site#movedFrom()}. Refused for a site with layers above or below it (phase 4e). Server thread.
	 */
	public static Site move(ServerLevel level, String id, BlockPos origin, Rotation rotation, boolean force) throws SiteException {
		MinecraftServer server = level.getServer();
		Site b = get(id);
		if (b == null) {
			throw new SiteException("No site " + id);
		}
		String noMove = moveRefusal(b);
		if (noMove != null) {
			throw new SiteException(noMove);
		}
		Blueprint bp = Blueprints.get(b.blueprint());
		if (bp == null) {
			throw new SiteException("Design " + b.blueprint() + " is not loaded; nothing was moved");
		}
		ServerLevel oldLevel = levelOf(server, b);
		if (oldLevel == null) {
			throw new SiteException(b.dimension() + " is not loaded; nothing was moved");
		}
		if (loadFailed) {
			throw new SiteException(FILE + " could not be read when the world started; nothing was moved");
		}
		SiteJournal.requireAvailable();
		List<String> oldEntries = SiteJournal.active(id).stream().map(JournalStore.Meta::id).toList();
		if (oldEntries.isEmpty()) {
			throw new SiteException("The saved terrain of " + id + " is not in the world journal; it can't be moved (forget drops the record)");
		}
		refusePlayerIn(oldLevel, b.restoreBox(), id, "moving it");
		if (!force) {
			List<String> blockers = removalBlockers(oldLevel, b);
			if (!blockers.isEmpty()) {
				throw new SiteException(blockersMessage(id, blockers).replace("removing it", "moving it"));
			}
		}
		Built built = build(level, bp, origin, rotation, force, b, id, false, false, Who.NONE);
		Site nb = new Site(id, b.blueprint(), BlueprintTransform.rotationName(built.turns()), built.box(), built.interior(), built.anchors(), b.placedAt(),
			dimensionId(level), built.snapshotBox(), built.snapshot(), b.location(), built.pin(), null, b.owner(), b.ext(), b.member(), false);
		String group = SiteJournal.group("move-" + id);
		Drops drops = Drops.before(oldLevel, b.restoreBox());
		SiteJournal.Undone undone;
		try {
			if (failNextMove) {
				failNextMove = false;
				throw new IllegalStateException("injected failure restoring the old site (dev.sites.failNextMove)");
			}
			undone = SiteJournal.undoEntries(oldLevel, oldEntries, group);
			SiteJournal.await(undone.commit(), "the move of " + id);
		} catch (RuntimeException | SiteException e) {
			Architect.LOGGER.error("Moving {}: restoring the old site failed; taking the new site down again", id, e);
			abortPlacement(level, id, false, built.entries());
			throw new SiteException("Moving " + id + " failed (" + e.getMessage() + "); the new site was restored, " + id + " stays where it was");
		}
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.put(id, nb);
		List<Site.Pending> pending = new ArrayList<>(s.pending());
		pending.add(new Site.Pending(b, System.currentTimeMillis(), "moved"));
		reports.remove(id);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), List.copyOf(pending)));
		SiteJournal.updateMeta(id, nb.toJson());
		SiteJournal.Restore r = SiteJournal.writeNow(oldLevel, id, group);
		drops.clearNew(oldLevel);
		// hold again what standing sites near the old place need (a short move shares leaves with the old site)
		reholdNear(oldLevel, b.restoreBox());
		SiteJournal.restoreRing(oldLevel, r.ring());
		lastNote = built.note();
		Architect.LOGGER.info("Moved site {} from {} ({}) to {} ({}){}", id, Anchors.str(b.box()), b.dimension(), Anchors.str(nb.box()), nb.dimension(),
			built.note() == null ? "" : "; " + built.note());
		ApiEvents.moved(server, b, nb);
		return nb;
	}

	private static volatile boolean failNextMove;

	/**
	 * Why a site may not move: in survival (the toggle on, or a construction site) a move would carry the building for free;
	 * phase 4e: a site with layers above or below it ("remove it and place it again").
	 */
	public static @Nullable String moveRefusal(Site b) {
		if (b.placing()) {
			return b.id() + " is still being placed; wait until it is done";
		}
		if (b.construction() != null || SurvivalWorld.on()) {
			return "Move is refused in survival: deconstruct " + b.id() + " and place it again";
		}
		if (SiteJournal.above(b.id()) != null || SiteJournal.below(b.id()) != null) {
			return b.id() + " has sites layered over or under it: remove it and place it again";
		}
		return null;
	}

	/** Test hook (DevBridge {@code dev.sites.failNextMove}): the next {@link #move} fails restoring the old site, so it rolls back. */
	public static void failNextMove() {
		failNextMove = true;
	}

	/** Moves a site back to where it stood before its last move ({@link Site#movedFrom()}). */
	public static Site undoMove(MinecraftServer server, String id, boolean force) throws SiteException {
		Site b = get(id);
		if (b == null) {
			throw new SiteException("No site " + id);
		}
		Site.Location from = b.movedFrom();
		if (from == null) {
			throw new SiteException(id + " was never moved");
		}
		Identifier key = Identifier.tryParse(from.dimension());
		ServerLevel level = key == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, key));
		if (level == null) {
			throw new SiteException(from.dimension() + " is not loaded; nothing was moved");
		}
		int turns = Math.max(0, BlueprintTransform.ROTATIONS.indexOf(from.rotation()));
		return move(level, id, new BlockPos(from.x(), from.y(), from.z()), Rotation.values()[turns], force);
	}

	public static @Nullable ServerLevel levelOf(MinecraftServer server, Site b) {
		Identifier key = Identifier.tryParse(b.dimension());
		return key == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, key));
	}

	// ------------------------------------------------------------------ ticked placement (docs/CONTRACT.md phase 4d, 4e)

	/** The placement settings {@code placeInWorld} gets for a rotation (shared with the ticked writer). */
	static StructurePlaceSettings placeSettings(Rotation rotation) {
		return settings(rotation);
	}

	public static @Nullable ServerLevel levelOf(MinecraftServer server, String dimension) {
		Identifier key = Identifier.tryParse(dimension);
		return key == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, key));
	}

	/** The approach's path block, or its slab. */
	static BlockState approachBlock(Blueprint bp, boolean slab) {
		return slab ? blockState(bp.approach().slab(), Approach.DEFAULT_SLAB, bp.id()) : blockState(bp.approach().block(), Approach.DEFAULT_BLOCK, bp.id());
	}

	static PlaceJob beginPlacing(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String siteOwner,
		@Nullable JsonObject ext, Site.@Nullable Member member) throws SiteException {
		return beginPlacing(level, bp, origin, rotation, force, siteOwner, ext, member, false, null, false);
	}

	/**
	 * Starts an instant placement written over ticks: exactly {@link #build}'s checks and its reads before the first write (P1:
	 * the capture, in one tick up to 50k cells, else sliced with change tracking ({@link PlaceJob}); the leaves to hold, the
	 * leaf ring, the tall plants the box cuts, the drops around it), then the PLACING commit is submitted (P2-P3, off the
	 * server thread). The job waits for it, records the site as placing (P4) and writes. {@code construction}: a survival
	 * construction site, converted ({@link Builder}) when its last cell is written. {@code placer}: the placing player's UUID.
	 * {@code layer}: the LAYER overlap policy. Server thread. The caller adds the returned job to {@link Placement}.
	 */
	static PlaceJob beginPlacing(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable String siteOwner,
		@Nullable JsonObject ext, Site.@Nullable Member member, boolean construction, @Nullable String placer, boolean layer) throws SiteException {
		if (loadFailed) {
			throw new SiteException(Reason.OTHER, FILE + " could not be read when the world started (see the log); fix or move it, then restart");
		}
		SiteJournal.requireAvailable();
		long tr0 = System.nanoTime();
		// a large batch item was checked in the tick before (its verdict): that plan is used, not made again
		Checked c = checked;
		checked = null;
		SitePlan site = c != null && c.key().equals(checkKey(level, bp, origin, rotation, force, construction, layer, siteOwner))
			&& level.getServer().getTickCount() - c.tick() <= 1 ? c.plan()
				: checkSite(level, bp, origin, rotation, force, null, THROW, false, construction, layer, siteOwner);
		if (site == null) {
			throw new SiteException("Internal: no site for " + bp.id());
		}
		long tr1 = System.nanoTime();
		String id = newSiteId();
		Anchors.Bounds box = site.box();
		TerrainFit.Plan plan = site.plan();
		Approach.Plan approach = site.approach();
		Anchors.Bounds snapBox = site.snapBox();
		List<BlockPos> plants = straddlingPositions(level, snapBox, false);
		long tr2 = System.nanoTime();
		Drops drops = Drops.before(level, snapBox);
		long tr3 = System.nanoTime();
		List<String> notes = new ArrayList<>();
		String gone = Occupancy.removalNote(site.found());
		if (gone != null && site.found().stream().anyMatch(f -> f.removable())) {
			notes.add(gone);
		}
		String water = TerrainFit.waterWarning(plan);
		if (water != null) {
			notes.add(water + " (filled below the floor; water next to the walls stays)");
		}
		if (plan.fillCount() > 0) {
			notes.add(plan.fillCount() + " foundation block" + (plan.fillCount() == 1 ? "" : "s"));
		}
		if (plan.clearCount() > 0) {
			notes.add(plan.clearCount() + " terrain block" + (plan.clearCount() == 1 ? "" : "s") + " cleared");
		}
		String wet = Approach.waterWarning(approach);
		if (wet != null) {
			notes.add(wet);
		}
		if (approach.rows() > 0) {
			notes.add("entrance approach " + approach.rows() + " rows (" + approach.changed() + " blocks)");
		}
		String shortOf = Approach.shortWarning(approach);
		if (shortOf != null) {
			notes.add(shortOf);
		}
		notes.addAll(site.site().warnings());
		notes.addAll(site.layerNotes());
		int turns = site.turns();
		long now = System.currentTimeMillis();
		Site rec = new Site(id, bp.id(), BlueprintTransform.rotationName(turns), box, BlueprintTransform.worldBounds(bp, turns, box.minX(), box.minY(),
			box.minZ()), BlueprintTransform.worldAnchors(bp, turns, box.minX(), box.minY(), box.minZ()), now, dimensionId(level), snapBox, journalName(id),
			null, pinFor(site.grid(), turns), null, siteOwner, ext == null ? new JsonObject() : ext, member, true);
		long[] cut = new long[plants.size()];
		for (int i = 0; i < cut.length; i++) {
			cut[i] = plants.get(i).asLong();
		}
		int[] none = new int[0];
		boolean a = approach.rows() > 0;
		PlaceJob job = new PlaceJob(id, dimensionId(level), bp.id(), turns, box, snapBox, site.placePos(), plan.fill(), plan.clear(),
			a ? approach.clear() : none, a ? approach.fill() : none, a ? approach.path() : none, a ? approach.slabs() : none, cut, drops.uuids(), notes,
			new ArrayList<>(), member == null ? null : member.batchId(), member == null ? null : member.itemKey());
		job.construction = construction;
		job.placer = placer;
		job.approachEnd = a ? approach.end() : null;
		job.record = rec;
		long tr4 = System.nanoTime();
		job.startCapture(level);
		if (System.getenv("ARCHITECT_TRACE_JOBS") != null) {
			Architect.LOGGER.info("TRACE beginPlacing {}: checks {} ms, plants {} ms, drops {} ms, record {} ms, startCapture {} ms", id, (tr1 - tr0) / 1e6,
				(tr2 - tr1) / 1e6, (tr3 - tr2) / 1e6, (tr4 - tr3) / 1e6, (System.nanoTime() - tr4) / 1e6);
		}
		Architect.LOGGER.info("Placing site {} ({}) over ticks at {} rotation {}: box {}, journal box {} ({} cells)", id, bp.id(), origin.toShortString(),
			rec.rotation(), Anchors.str(box), Anchors.str(snapBox), snapBox.volume());
		return job;
	}

	/** The last verdict without refusals (phase 4e: a large batch item's start, a tick later, uses its plan). */
	private record Checked(String key, int tick, SitePlan plan) {
	}

	private static @Nullable Checked checked;

	private static String checkKey(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, boolean survival, boolean layer,
		@Nullable String owner) {
		return dimensionId(level) + "|" + bp.id() + "|" + origin.asLong() + "|" + rotation + "|" + force + "|" + survival + "|" + layer + "|" + owner;
	}

	/** P4 of a ticked placement (its PLACING commit is durable): the record, placing. */
	static void startPlacing(MinecraftServer server, Site rec) {
		putRecord(server, rec);
	}

	/** A ticked placement wrote its last cell and its ACTIVE commit is durable (P8): the pin gets the beds bed safety left out, the site is placed. Fires SITE_PLACED. */
	static @Nullable Site finishPlacing(MinecraftServer server, PlaceJob job, Set<Long> bedCells, @Nullable String note) {
		Site cur = get(job.siteId);
		if (cur == null) {
			return null;
		}
		TemplateGrid grid = ownGrid(cur);
		Site.Pin pin = cur.pin();
		if (grid != null && pin != null) {
			pin = pinFor(grid, job.turns, bedCells, cur.box()).withHeldLeaves(pin.heldLeaves());
		}
		Site done = cur.withPin(pin).withPlacing(false);
		if (job.convert != null) {
			done = done.withConstruction(job.convert);
		}
		replace(server, done);
		SiteJournal.updateMeta(done.id(), done.toJson());
		lastNote = note;
		Architect.LOGGER.info("Placed site {} ({}) over ticks: box {}, journal box {}{}", done.id(), done.blueprint(), Anchors.str(done.box()),
			Anchors.str(done.restoreBox()), note == null ? "" : "; " + note);
		ApiEvents.placed(server, done);
		return done;
	}

	/** The {@link Built} of a ticked placement whose cells are written (its construction conversion's input), or null. */
	static @Nullable Built builtOf(PlaceJob job) {
		Site cur = get(job.siteId);
		Blueprint bp = Blueprints.get(job.blueprint);
		TemplateGrid grid = cur == null ? null : ownGrid(cur);
		if (cur == null || bp == null || grid == null) {
			return null;
		}
		Site.Pin pin = pinFor(grid, job.turns, job.bedCells, cur.box());
		int[] none = new int[0];
		return new Built(job.turns, cur.box(), cur.restoreBox(), cur.interior(), cur.anchors(), pin, null, grid,
			new TerrainFit.Plan(job.fill, job.clear, none, 0, none, 0, cur.restoreBox().minY() + 1), new Approach.Plan(job.aPath, job.aSlabs, job.aFill,
				job.aClear, none, 0, none, 0, none, none, null, job.approachEnd, Integer.MIN_VALUE), cur, List.of());
	}

	/** Saves the sites file now (roads and cell sites changed). */
	static void saveAll(MinecraftServer server) {
		save(server, state);
		notifyListeners();
	}

	/** The pin of a ticked placement as it will be (beds left out), for the construction conversion. */
	static Site.@Nullable Pin pinOf(PlaceJob job, Set<Long> bedCells) {
		Site cur = get(job.siteId);
		TemplateGrid grid = cur == null ? null : ownGrid(cur);
		return grid == null || cur.pin() == null ? cur == null ? null : cur.pin() : pinFor(grid, job.turns, bedCells, cur.box());
	}

	/** A placing site's box holds its old terrain again (its record pending): it was never placed (no SITE_REMOVED). */
	static Removed finishRollback(MinecraftServer server, ServerLevel level, Site b, Drops drops, int[] ring, Journal.Stats stats) {
		Architect.LOGGER.info("Rolled back site {} ({}) that was still being placed", b.id(), b.blueprint());
		return afterRestore(level, b, null, drops, true, false, ring, stats, Map.of(), List.of(), List.of());
	}

	/** An instant site restored over ticks ({@link RestoreJob}): the rest of the removal. Fires SITE_REMOVED. */
	static Removed finishTickedRemove(MinecraftServer server, ServerLevel level, Site b, Drops drops, int[] ring, Journal.Stats stats,
		Map<String, Integer> handed) {
		return afterRestore(level, b, null, drops, false, true, ring, stats, handed, List.of(), List.of());
	}

	/**
	 * A construction member of a group undo (its record pending, the undo committed): its writes at once, then its
	 * deconstruct items (tallied before the undo was planned) drop at its crate's cell. Fires SITE_REMOVED.
	 */
	static Removed finishGroupDeconstruct(ServerLevel level, Site b, String group, Map<String, Integer> items, @Nullable BlockPos at,
		Map<String, Integer> handed) throws SiteException {
		Drops drops = Drops.before(level, b.restoreBox());
		SiteJournal.Restore r = SiteJournal.writeNow(level, b.id(), group);
		drops.clearNew(level);
		BlockPos where = at != null ? at : Builder.dropPos(b);
		Builder.dropItems(level, where, items, drops);
		Builder.forget(level.getServer(), b.id());
		reholdNear(level, b.restoreBox());
		SiteJournal.restoreRing(level, r.ring());
		save(level.getServer(), state);
		notifyListeners();
		Removed done = new Removed(b, Map.copyOf(items), r.cells().size(), 0, handed, List.of(), notesOf(level, r));
		ApiEvents.removed(level.getServer(), done);
		return done;
	}

	/** A pending site's record as it was taken down (for a restore job that resumes after the record went pending). */
	static @Nullable Site pendingRecord(String id) {
		Site.Pending found = null;
		for (Site.Pending p : state.pending()) {
			if (p.site().id().equals(id)) {
				found = p;
			}
		}
		return found == null ? null : found.site();
	}

	/** A dry-run plan of a placement: its snapshot (restore) box and its approach's end, for choosing a shared crate's cell. */
	public record Prediction(Anchors.Bounds snapBox, int[] end, int[] out) {
	}

	/**
	 * Plans a placement without changing anything or loading a chunk (as the dry-run verdict does) and predicts its restore
	 * box and approach end. When its chunks are not loaded, a conservative guess: the template box grown by the worst-case
	 * approach on every side and the deepest foundation below, and the end {@code approach.length} rows out from the
	 * entrance. Server thread.
	 */
	public static Prediction predict(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation) {
		int turns = rotation.ordinal();
		int[] out = Approach.outward(BlueprintTransform.rotateDirection(bp.front(), turns));
		SitePlan p = null;
		try {
			p = checkSite(level, bp, origin, rotation, true, null, (r, m) -> {
			}, true, false);
		} catch (SiteException | RuntimeException e) {
			p = null;
		}
		Anchor entrance = BlueprintTransform.worldAnchors(bp, turns, origin.getX(), origin.getY(), origin.getZ()).get(Blueprint.ENTRANCE);
		if (p != null) {
			double[] end = p.approach().end();
			int[] e;
			if (end != null && p.approach().rows() > 0) {
				e = new int[] {(int) Math.floor(end[0]), (int) Math.floor(end[1]), (int) Math.floor(end[2])};
			} else if (entrance != null) {
				e = new int[] {(int) Math.floor(entrance.x()) + out[0], (int) Math.floor(entrance.y()), (int) Math.floor(entrance.z()) + out[1]};
			} else {
				e = new int[] {(p.snapBox().minX() + p.snapBox().maxX()) / 2, p.box().minY() + bp.groundY(), (p.snapBox().minZ() + p.snapBox().maxZ()) / 2};
			}
			return new Prediction(p.snapBox(), e, out);
		}
		int sx = BlueprintTransform.rotatedSizeX(bp.sizeX(), bp.sizeZ(), turns);
		int sz = BlueprintTransform.rotatedSizeZ(bp.sizeX(), bp.sizeZ(), turns);
		int m = dev.larattalabs.architect.batch.LotFitting.frontMargin(bp);
		Anchors.Bounds guess = new Anchors.Bounds(origin.getX() - m, origin.getY() - TerrainFit.MAX_FILL - 1, origin.getZ() - m, origin.getX() + sx - 1 + m,
			origin.getY() + bp.sizeY() - 1 + Approach.MAX_CUT, origin.getZ() + sz - 1 + m);
		int len = bp.approach().enabled() ? bp.approach().length() : 1;
		int[] e = entrance == null ? new int[] {origin.getX() + sx / 2, origin.getY() + bp.groundY(), origin.getZ() + sz / 2}
			: new int[] {(int) Math.floor(entrance.x()) + out[0] * len, origin.getY() + bp.groundY(), (int) Math.floor(entrance.z()) + out[1] * len};
		return new Prediction(guess, e, out);
	}

	// ------------------------------------------------------------------ site groups (docs/CONTRACT.md phase 4d)

	/** Every site group, in creation order. Any thread. */
	public static List<SiteGroupRec> groups() {
		return List.copyOf(groups.values());
	}

	public static @Nullable SiteGroupRec group(String id) {
		return groups.get(id);
	}

	/** A new group id ({@code g<n>}); the counter is saved with the next commit. */
	static String newGroupId() {
		int n = nextGroup;
		while (groups.containsKey("g" + n)) {
			n++;
		}
		nextGroup = n + 1;
		return "g" + n;
	}

	/** Adds or replaces a group and saves. Server thread. */
	static void putGroup(MinecraftServer server, SiteGroupRec g) {
		Map<String, SiteGroupRec> m = new LinkedHashMap<>(groups);
		m.put(g.id(), g);
		groups = Collections.unmodifiableMap(m);
		save(server, state);
		notifyListeners();
	}

	/** A site joins its group (and its stage): the caller commits. */
	private static void addToGroup(Site b) {
		Site.Member m = b.member();
		SiteGroupRec g = m == null ? null : groups.get(m.group());
		if (g == null) {
			return;
		}
		List<String> sites = new ArrayList<>(g.sites());
		if (!sites.contains(b.id())) {
			sites.add(b.id());
		}
		g = g.withSites(sites);
		if (m.itemKey() != null) {
			for (SiteGroupRec.StageRec st : g.stages()) {
				if (st.items().contains(m.itemKey()) && st.batchId().equals(m.batchId()) && !st.sites().contains(b.id())) {
					List<String> ss = new ArrayList<>(st.sites());
					ss.add(b.id());
					g = g.withStage(st.name(), x -> x.withSites(ss));
				}
			}
		}
		Map<String, SiteGroupRec> mm = new LinkedHashMap<>(groups);
		mm.put(g.id(), g);
		groups = Collections.unmodifiableMap(mm);
	}

	/** A removed site leaves its group and stage lists: the caller commits. */
	private static void dropFromGroup(Site b) {
		String gid = b.group();
		SiteGroupRec g = gid == null ? null : groups.get(gid);
		if (g == null) {
			return;
		}
		List<String> sites = new ArrayList<>(g.sites());
		sites.remove(b.id());
		List<SiteGroupRec.StageRec> stages = new ArrayList<>();
		for (SiteGroupRec.StageRec st : g.stages()) {
			List<String> ss = new ArrayList<>(st.sites());
			ss.remove(b.id());
			stages.add(st.withSites(ss));
		}
		Map<String, SiteGroupRec> mm = new LinkedHashMap<>(groups);
		mm.put(g.id(), g.withSites(sites).withStages(stages));
		groups = Collections.unmodifiableMap(mm);
	}

	/** A site placed through the atomic path for a batch item (a construction site) joins its group. Server thread. */
	static void joinGroup(MinecraftServer server, Site b) {
		addToGroup(b);
		save(server, state);
	}

	// ------------------------------------------------------------------ crash safety

	/** A check of the records against the world; {@code problem} false = a notice. */
	public record Report(String siteId, boolean problem, String message) {
	}

	private static final Map<String, Report> reports = new java.util.concurrent.ConcurrentHashMap<>();

	/** What the last world load found about the sites. Any thread. */
	public static Map<String, Report> reports() {
		return Map.copyOf(reports);
	}

	private static void report(String id, boolean problem, String message) {
		reports.merge(id, new Report(id, problem, message), (a, b) -> new Report(id, a.problem() || b.problem(), a.message() + " " + b.message()));
	}

	/** The sites taken down whose journal entries are kept until the next world start settles them. Any thread. */
	public static List<Site.Pending> pending() {
		return state.pending();
	}

	/**
	 * {matching non-air blocks, non-air template blocks} of a site's own template in the world, over the cells the site owns
	 * (phase 4e: a cell another standing entry owns is left out); {0, 0} when it cannot be checked.
	 */
	static int[] standing(MinecraftServer server, Site b, @Nullable TemplateGrid grid) {
		ServerLevel level = levelOf(server, b);
		if (grid == null || level == null) {
			return new int[] {0, 0};
		}
		GhostModel m = grid.ghost(Math.max(0, BlueprintTransform.ROTATIONS.indexOf(b.rotation())));
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		int total = 0;
		int match = 0;
		for (int i = 0; i < m.count(); i++) {
			BlockState want = grid.states()[i];
			if (want.isAir()) {
				continue;
			}
			p.set(b.box().minX() + m.x(i), b.box().minY() + m.y(i), b.box().minZ() + m.z(i));
			if (ownedByOther(b.dimension(), p.asLong(), b.id())) {
				continue;
			}
			total++;
			// by block, not state: players open doors
			if (level.getBlockState(p).is(want.getBlock())) {
				match++;
			}
		}
		return new int[] {match, total};
	}

	/** Whether {@code pos} is owned by a standing entry of another site. */
	private static boolean ownedByOther(String dim, long pos, String site) {
		String o = SiteJournal.ownerSite(dim, pos);
		return o != null && !o.equals(site);
	}

	private static @Nullable Boolean stands(MinecraftServer server, Site b) {
		int[] st = standing(server, b, ownGrid(b));
		return st[1] == 0 ? null : Reconcile.stands(st[0], st[1]);
	}

	/**
	 * The evidence of an undone site (docs/CONTRACT.md phase 4e "World-start settle"), over the cells of its main undone
	 * entry that no standing entry owns: {restored, stands} (null when it can't be told). With {@code after} known: cells where
	 * {@code before} and {@code after} differ, matched by block against each; a migrated entry ({@code after} unknown) uses its
	 * site's pin (the template), as 4d did. {@code covered}: every comparable cell is owned by a standing entry.
	 */
	record Evidence(@Nullable Boolean restored, @Nullable Boolean stands, boolean covered) {
	}

	static Evidence evidence(MinecraftServer server, Site b, String group) {
		return evidence(levelOf(server, b), b.id(), b, group);
	}

	/** {@link #evidence} for a road or cell site (CELL entries with {@code after}: no template). */
	static Evidence evidence(@Nullable ServerLevel level, String siteId, String group) {
		return evidence(level, siteId, null, group);
	}

	private static Evidence evidence(@Nullable ServerLevel level, String siteId, @Nullable Site b, String group) {
		JournalStore js = WorldJournal.storeOrNull();
		if (level == null || js == null) {
			return new Evidence(null, null, false);
		}
		JournalStore.Meta main = null;
		for (JournalStore.Meta m : SiteJournal.undone(siteId, group)) {
			// the site's own entry decides (a group undo with deltas: their cells lie inside or next to it)
			if (!m.kind().equals(WorldJournal.LEAVES) && !m.kind().equals(WorldJournal.CRATE) && (main == null || !main.kind().equals(WorldJournal.SITE))) {
				main = m;
			}
		}
		if (main == null) {
			return new Evidence(null, null, false);
		}
		int total = 0;
		int holdBefore = 0;
		int holdAfter = 0;
		int ownedOut = 0;
		TemplateGrid grid = b == null ? null : ownGrid(b);
		Map<Long, BlockState> template = new java.util.HashMap<>();
		if (grid != null) {
			GhostModel gm = grid.ghost(Math.max(0, BlueprintTransform.ROTATIONS.indexOf(b.rotation())));
			for (int i = 0; i < gm.count(); i++) {
				template.put(BlockPos.asLong(b.box().minX() + gm.x(i), b.box().minY() + gm.y(i), b.box().minZ() + gm.z(i)), grid.states()[i]);
			}
		}
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		// what the undo wrote: in a group undo the lowest entry writes a shared cell, so the value to look for there is the group's
		List<JournalStore.Meta> inGroup = new ArrayList<>(js.find(m -> group.equals(m.undoGroup())));
		inGroup.sort(java.util.Comparator.comparingLong(JournalStore.Meta::layer)); // the lowest writes last: its value wins
		try {
			for (long k : main.sections()) {
				var sc = js.section(main.id(), k);
				if (sc == null) {
					continue;
				}
				Map<Long, Journal.Value> wrote = new java.util.HashMap<>();
				for (JournalStore.Meta g : inGroup) {
					var gs = js.section(g.id(), k);
					if (gs != null) {
						gs.writtenMap().forEach(wrote::putIfAbsent);
					}
				}
				for (int i = 0; i < sc.size(); i++) {
					long pos = sc.pos(i);
					Journal.Value w = sc.written(i) != null ? sc.written(i) : wrote.get(pos);
					BlockState before = WorldJournal.state(w != null ? w : sc.before(i));
					Journal.Value av = sc.after(i);
					BlockState after = av != null ? WorldJournal.state(av) : template.get(pos);
					if (after == null || after.getBlock() == before.getBlock() || av == null && after.isAir()) {
						continue;
					}
					if (SiteJournal.owned(main.dimension(), pos)) {
						ownedOut++;
						continue;
					}
					total++;
					BlockState now = level.getBlockState(p.set(BlockPos.getX(pos), BlockPos.getY(pos), BlockPos.getZ(pos)));
					if (now.is(before.getBlock())) {
						holdBefore++;
					} else if (now.is(after.getBlock())) {
						holdAfter++;
					}
				}
			}
		} catch (IOException e) {
			return new Evidence(null, null, false);
		}
		if (total == 0) {
			return new Evidence(null, null, ownedOut > 0);
		}
		if (main.policy() == Journal.Policy.CELL) {
			// roads and cell sites (AgentCraft's road settle): most hold after -> it stands; else released
			boolean st = holdAfter * 2 > total;
			return new Evidence(!st, st, false);
		}
		return new Evidence(Reconcile.restored(holdBefore, total), Reconcile.stands(holdAfter, total), false);
	}

	/**
	 * At world start (docs/CONTRACT.md phase 4e "World-start settle"), checks the records against the journal and the world:
	 * <ul>
	 * <li>records come from the journal: an ACTIVE entry whose site has no record gets its record back from the entry's
	 * {@code meta}; a PLACING entry with no record and no job to resume is released (K2: no block was written before the
	 * record existed);</li>
	 * <li>pending sites are settled on evidence over the cells no standing entry owns: restored releases their entries,
	 * standing reactivates them (the hand-downs reversed) and brings the record back, doubtful keeps them; an undo group
	 * whose restore job was interrupted is not settled at this start;</li>
	 * <li>standing sites whose template no longer stands are reported.</li>
	 * </ul>
	 * Never changes the world. Server thread.
	 */
	static void reconcile(MinecraftServer server, Set<String> jobSites) {
		reports.clear();
		if (loadFailed) {
			return;
		}
		String why = WorldJournal.unavailable();
		if (why != null) {
			report("journal", true, why);
			return;
		}
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		List<Site.Pending> pending = new ArrayList<>(s.pending());
		boolean changed = false;
		JournalStore js = WorldJournal.storeOrNull();
		// records come from the journal
		Set<String> pendingIds = new HashSet<>();
		pending.forEach(p -> pendingIds.add(p.site().id()));
		List<String> releaseNow = new ArrayList<>();
		Map<String, List<JournalStore.Meta>> bySite = new LinkedHashMap<>();
		for (JournalStore.Meta m : js.index().entries().values()) {
			if (m.active()) {
				bySite.computeIfAbsent(m.site(), k -> new ArrayList<>()).add(m);
			}
		}
		for (var e : bySite.entrySet()) {
			String sid = e.getKey();
			if (map.containsKey(sid) || Infras.get(sid) != null || sid.startsWith(SiteGroupRec.CRATE_PREFIX) || jobSites.contains(sid)) {
				continue;
			}
			boolean placing = e.getValue().stream().anyMatch(m -> m.status() == Journal.Status.PLACING);
			JournalStore.Meta main = e.getValue().stream().filter(m -> !m.kind().equals(WorldJournal.LEAVES) && !m.kind().equals(WorldJournal.CRATE)
				&& !m.kind().equals(WorldJournal.DELTA)).findFirst().orElse(null);
			if (placing || main == null) {
				// K2: committed before its record, never written (or only guard entries left): released, nothing written
				e.getValue().forEach(m -> releaseNow.add(m.id()));
				Architect.LOGGER.info("Sites check: {} had journal entries but no record ({}); released them, nothing written", sid,
					placing ? "a placement that stopped before its record was saved" : "only guard entries");
				continue;
			}
			if (pendingIds.contains(sid)) {
				continue; // a removal whose undo was not committed: settled below
			}
			try {
				JsonObject meta = js.head(main.id()).meta();
				if (meta == null) {
					report(sid, true, "journal entry " + main.id() + " of " + sid + " has no record to rebuild it from; it stays in the journal");
					continue;
				}
				if (main.kind().equals(WorldJournal.SITE)) {
					Site rec = Site.fromJson(meta).withPlacing(false);
					map.put(sid, rec);
					changed = true;
					report(sid, false, sid + "'s record was rebuilt from the world journal (its record was lost: a downgrade, or a stop before it was saved)");
				} else {
					Infras.rebuild(server, main, meta);
					report(sid, false, sid + "'s record was rebuilt from the world journal");
				}
			} catch (IOException | RuntimeException ex) {
				report(sid, true, "could not rebuild " + sid + "'s record from the journal (" + ex.getMessage() + ")");
			}
		}
		if (!releaseNow.isEmpty()) {
			SiteJournal.releaseGroup(releaseNow);
		}
		// K6: the undo committed (R2) before the record went pending (R3): the record follows the journal, then the evidence decides
		for (Site b : List.copyOf(map.values())) {
			if (b.placing() || jobSites.contains(b.id()) || pendingIds.contains(b.id()) || !SiteJournal.active(b.id()).isEmpty()) {
				continue;
			}
			long at = Long.MIN_VALUE;
			for (JournalStore.Meta m : SiteJournal.entries(b.id())) {
				if (m.status() == Journal.Status.UNDONE && m.undoGroup() != null) {
					at = Math.max(at, m.undoneAt());
				}
			}
			if (at != Long.MIN_VALUE) {
				map.remove(b.id());
				pending.add(new Site.Pending(b, at, "removed"));
				pendingIds.add(b.id());
				changed = true;
				Architect.LOGGER.info("Sites check: {}'s removal was committed to the journal before its record went pending; it is settled now", b.id());
			}
		}
		Map<String, Boolean> standsNow = new java.util.HashMap<>();
		for (Site b : map.values()) {
			if (b.placing()) {
				// half written on purpose: its job resumes from the queue file (Placement), or rolls back
				report(b.id(), false, b.id() + " was still being placed; it resumes");
				continue;
			}
			if (b.construction() != null) {
				Builder.Run run = Builder.run(server, b);
				ServerLevel atStart = levelOf(server, b);
				if (run != null && atStart != null) {
					run.rescan(atStart, true); // built is derived from the world when it loads (the chunks are read here, as for every site)
				}
				if (run == null) {
					report(b.id(), true, b.id() + "'s construction plan (its journal entry's target) is missing; it can only be removed");
					continue;
				}
				if (b.building()) {
					ServerLevel lv = levelOf(server, b);
					Construction.Crate cr = b.construction().crate();
					if (lv != null && (cr == null || !(lv.getBlockEntity(new BlockPos(cr.x(), cr.y(), cr.z())) instanceof
						dev.larattalabs.architect.survival.CrateBlockEntity))) {
						report(b.id(), true, "crate missing: " + b.id() + " can't take items; Deconstruct from the Library still works (refunds placed "
							+ "cells only)");
					}
					report(b.id(), false, b.id() + " is a construction site: " + run.built.cardinality() + " of " + run.size() + " cells built");
					continue;
				}
			}
			if (ownGrid(b) == null) {
				if (TemplateGrid.of(b.blueprint()) != null) {
					report(b.id(), false, b.blueprint() + " changed since " + b.id() + " was placed; it was not checked");
				}
				continue;
			}
			Boolean st = stands(server, b);
			if (st != null) {
				standsNow.put(b.id(), st);
			}
		}
		Set<String> recovered = new HashSet<>();
		for (Site.Pending p : List.copyOf(pending)) {
			Site gone = p.site();
			boolean moved = "moved".equals(p.why());
			String group = null;
			long at = Long.MIN_VALUE;
			for (JournalStore.Meta m : SiteJournal.entries(gone.id())) {
				if (m.status() == Journal.Status.UNDONE && m.undoneAt() >= at) {
					at = m.undoneAt();
					group = m.undoGroup();
				}
			}
			if (group == null) {
				// nothing undone in the journal: the undo was never committed (the record went pending first) or it was released
				if (!map.containsKey(gone.id()) && !SiteJournal.active(gone.id()).isEmpty() && !moved) {
					map.put(gone.id(), gone);
					recovered.add(gone.id());
					report(gone.id(), false, gone.id() + "'s removal was not saved before the game stopped: it stands again (remove it again)");
				}
				pending.remove(p);
				changed = true;
				continue;
			}
			if (jobSites.contains(gone.id())) {
				report(gone.id(), false, gone.id() + "'s restore was interrupted; it runs again before this site is settled");
				continue;
			}
			Evidence ev = evidence(server, gone, group);
			Site current = map.get(gone.id());
			Reconcile.Action action = ev.covered() ? Reconcile.Action.RELEASE : Reconcile.decide(moved, ev.stands(), ev.restored(),
				Reconcile.Overlap.NONE, current != null, current == null ? null : standsNow.get(gone.id()));
			Architect.LOGGER.info("Sites check: {} site of {} at {} (stands {}, restored {}, covered {}): {}", p.why(), gone.id(), Anchors.str(gone.restoreBox()),
				ev.stands(), ev.restored(), ev.covered(), action);
			List<String> groupIds = SiteJournal.undone(gone.id(), group).stream().map(JournalStore.Meta::id).toList();
			switch (action) {
				case RELEASE -> {
					SiteJournal.releaseGroup(groupIds);
					pending.remove(p);
					changed = true;
				}
				case RECOVER -> {
					try {
						SiteJournal.reactivate(group);
					} catch (IOException e) {
						report(gone.id(), true, "could not bring " + gone.id() + " back (" + e.getMessage() + ")");
						continue;
					}
					if (moved && current != null) {
						// the move never reached the disk: the site is still at its old place; the new place's entries go
						List<String> newer = SiteJournal.active(gone.id()).stream().map(JournalStore.Meta::id).filter(i -> !groupIds.contains(i)).toList();
						SiteJournal.releaseGroup(newer);
						report(gone.id(), false, gone.id() + "'s move was not saved before the game stopped: it is back at its old place");
					} else {
						report(gone.id(), false, gone.id() + "'s removal was not saved before the game stopped: it stands again (remove it again)");
					}
					map.put(gone.id(), gone);
					recovered.add(gone.id());
					standsNow.put(gone.id(), true);
					pending.remove(p);
					changed = true;
				}
				case REPORT_KEEP -> report(current != null ? gone.id() : gone.id(), true, (moved ? gone.id() + " stands at its old place "
					+ Anchors.str(gone.box()) + " too: the move was only partly saved" : "removed " + gone.id() + " stands again but could not get its "
						+ "record back") + ". Its journal entries are kept; nothing was changed");
				case KEEP -> {
				}
			}
		}
		// pending roads and cell sites (R3 done): settled on the same evidence; an interrupted restore runs again first
		for (Infra gone : Infras.pendingAll()) {
			String group = null;
			long at = Long.MIN_VALUE;
			for (JournalStore.Meta m : SiteJournal.entries(gone.id())) {
				if (m.status() == Journal.Status.UNDONE && m.undoneAt() >= at) {
					at = m.undoneAt();
					group = m.undoGroup();
				}
			}
			if (group == null) {
				if (!SiteJournal.active(gone.id()).isEmpty()) {
					Infras.recover(server, gone.id());
					report(gone.id(), false, gone.id() + "'s removal was not saved before the game stopped: it stands again (remove it again)");
				} else {
					Infras.drop(server, gone.id());
				}
				continue;
			}
			if (jobSites.contains(gone.id())) {
				report(gone.id(), false, gone.id() + "'s restore was interrupted; it runs again before it is settled");
				continue;
			}
			Evidence ev = evidence(levelOf(server, gone.dimension()), gone.id(), group);
			List<String> groupIds = SiteJournal.undone(gone.id(), group).stream().map(JournalStore.Meta::id).toList();
			Architect.LOGGER.info("Sites check: removed {} at {} (stands {}, restored {}, covered {})", gone.id(), Anchors.str(gone.box()), ev.stands(),
				ev.restored(), ev.covered());
			if (ev.covered() || Boolean.TRUE.equals(ev.restored()) || ev.restored() == null && ev.stands() == null) {
				SiteJournal.releaseGroup(groupIds);
				Infras.drop(server, gone.id());
			} else if (Boolean.TRUE.equals(ev.stands())) {
				try {
					SiteJournal.reactivate(group);
					Infras.recover(server, gone.id());
					report(gone.id(), false, gone.id() + "'s removal was not saved before the game stopped: it stands again (remove it again)");
				} catch (IOException e) {
					report(gone.id(), true, "could not bring " + gone.id() + " back (" + e.getMessage() + ")");
				}
			}
		}
		for (Site b : map.values()) {
			Boolean st = standsNow.get(b.id());
			if (Boolean.FALSE.equals(st) && !recovered.contains(b.id()) && !b.placing()) {
				int[] n = standing(server, b, ownGrid(b));
				report(b.id(), true, Reconcile.mismatch(b.id(), n[0], n[1]));
			}
		}
		if (changed) {
			state = new State(Collections.unmodifiableMap(map), s.next(), List.copyOf(pending));
			for (Site b : map.values()) {
				addToGroup(b);
			}
			save(server, state);
		}
		reports.values().forEach(r -> Architect.LOGGER.warn("Sites check: {}", r.message()));
	}

	/** Legacy snapshot files (4d, or written by 0.7.0 after a downgrade) that no record names (kept, listed). */
	public static List<String> unreferenced() {
		Path dir = snapshotDir();
		if (dir == null || !Files.isDirectory(dir)) {
			return List.of();
		}
		Set<String> named = new HashSet<>();
		State s = state;
		s.byId().values().forEach(b -> named.add(b.snapshot()));
		s.pending().forEach(p -> named.add(p.site().snapshot()));
		try (Stream<Path> files = Files.list(dir)) {
			return files.map(f -> f.getFileName().toString()).filter(n -> n.endsWith(".nbt") && !named.contains(n)).sorted().toList();
		} catch (IOException e) {
			return List.of();
		}
	}

	// ------------------------------------------------------------------ snapshots (4d: read for the migration and late imports only)

	static @Nullable Path snapshotDir() {
		Path w = worldDir;
		return w == null ? null : w.resolve(SNAPSHOT_DIR);
	}

	static Path snapshotFile(String name) {
		Path dir = snapshotDir();
		if (dir == null) {
			throw new IllegalStateException("no world is running");
		}
		return dir.resolve(name);
	}

	/** Whether a legacy snapshot file carries this site id (ids are never reused while one does). */
	private static boolean snapshotUsed(String id) {
		Path w = worldDir;
		if (w == null) {
			return false;
		}
		for (Path dir : new Path[] {w.resolve(SNAPSHOT_DIR), w.resolve(JournalStore.DIR).resolve("legacy").resolve(SNAPSHOT_DIR)}) {
			if (!Files.isDirectory(dir)) {
				continue;
			}
			try (Stream<Path> files = Files.list(dir)) {
				if (files.anyMatch(f -> f.getFileName().toString().startsWith(id + "-"))) {
					return true;
				}
			} catch (IOException e) {
				// unreadable: not counted
			}
		}
		return false;
	}

	/** Captures a box as a structure template tag (blocks and block entities, air included, no entities). */
	public static CompoundTag capture(ServerLevel level, Anchors.Bounds box) throws IOException {
		BlockPos min = new BlockPos(box.minX(), box.minY(), box.minZ());
		Vec3i size = new Vec3i(box.maxX() - box.minX() + 1, box.maxY() - box.minY() + 1, box.maxZ() - box.minZ() + 1);
		StructureTemplate t = new StructureTemplate();
		t.setAuthor(Architect.MOD_ID);
		t.fillFromWorld(level, min, size, false, List.of());
		CompoundTag tag = t.save(new CompoundTag());
		long volume = (long) size.getX() * size.getY() * size.getZ();
		int captured = tag.getListOrEmpty("blocks").size();
		if (captured != volume) {
			throw new IOException("captured " + captured + " of " + volume + " blocks");
		}
		return tag;
	}

	/** Puts a captured template back over {@code box}. */
	public static void restoreTemplate(ServerLevel level, Anchors.Bounds box, CompoundTag tpl) {
		StructureTemplate t = new StructureTemplate();
		t.load(level.registryAccess().lookupOrThrow(Registries.BLOCK), tpl);
		BlockPos min = new BlockPos(box.minX(), box.minY(), box.minZ());
		t.placeInWorld(level, min, min, settings(Rotation.NONE), level.getRandom(), FLAGS);
	}

	/** A legacy snapshot (4d) by name, from {@code architect-sites/}. */
	static CompoundTag readSnapshot(String name) throws IOException {
		return NbtIo.readCompressed(snapshotFile(name), NbtAccounter.unlimitedHeap());
	}

	// ------------------------------------------------------------------ world work

	private static StructurePlaceSettings settings(Rotation rotation) {
		return new StructurePlaceSettings().setRotation(rotation).setMirror(Mirror.NONE).setIgnoreEntities(true)
			.setLiquidSettings(LiquidSettings.IGNORE_WATERLOGGING);
	}

	/** Positions + types of block entities in the box. */
	private static List<String> blockEntities(ServerLevel level, Anchors.Bounds box) {
		List<String> out = new ArrayList<>();
		forEachBlockEntity(level, box, be -> out.add(be.getBlockPos().toShortString() + " "
			+ be.getBlockState().getBlock().getDescriptionId().replace("block.minecraft.", "")));
		return out;
	}

	public static String dimensionId(ServerLevel level) {
		return level.dimension().identifier().toString();
	}

	private static void forEachBlockEntity(ServerLevel level, Anchors.Bounds box, Consumer<BlockEntity> action) {
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				for (BlockEntity be : List.copyOf(level.getChunk(cx, cz).getBlockEntities().values())) {
					BlockPos p = be.getBlockPos();
					if (box.contains(p.getX(), p.getY(), p.getZ())) {
						action.accept(be);
					}
				}
			}
		}
	}

	/**
	 * The dropped items and XP around a box before the mod changes it, so only the ones the change makes are removed
	 * afterwards (never the player's own drops lying there): once right after and once a few ticks later.
	 */
	static final class Drops {
		private final AABB area;
		private final Set<java.util.UUID> before = new HashSet<>();

		private Drops(AABB area) {
			this.area = area;
		}

		/** Drops around {@code box} that were there before, by entity UUID (a ticked placement's, saved in the queue file). */
		static Drops of(ServerLevel level, Anchors.Bounds box, @Nullable List<String> uuids) {
			Drops d = new Drops(Occupancy.aabb(box).inflate(1));
			if (uuids != null) {
				for (String u : uuids) {
					try {
						d.before.add(java.util.UUID.fromString(u));
					} catch (IllegalArgumentException ignored) {
						// skipped
					}
				}
			}
			return d;
		}

		/** The UUIDs that were there before (for the queue file). */
		List<String> uuids() {
			return before.stream().map(java.util.UUID::toString).sorted().toList();
		}

		static Drops before(ServerLevel level, Anchors.Bounds box) {
			Drops d = new Drops(Occupancy.aabb(box).inflate(1));
			level.getEntitiesOfClass(ItemEntity.class, d.area).forEach(e -> d.before.add(e.getUUID()));
			level.getEntitiesOfClass(ExperienceOrb.class, d.area).forEach(e -> d.before.add(e.getUUID()));
			return d;
		}

		void clearNew(ServerLevel level) {
			clear(level);
			LATER.add(new Object[] {this, level, 3});
		}

		/** An entity the change brings on purpose (a deconstruct's refunds): never cleared. */
		void keep(Entity e) {
			before.add(e.getUUID());
		}

		private int clear(ServerLevel level) {
			int n = 0;
			for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, area)) {
				if (!before.contains(e.getUUID())) {
					e.discard();
					n++;
				}
			}
			for (ExperienceOrb e : level.getEntitiesOfClass(ExperienceOrb.class, area)) {
				if (!before.contains(e.getUUID())) {
					e.discard();
					n++;
				}
			}
			return n;
		}

		private static final List<Object[]> LATER = new ArrayList<>();

		static void tick() {
			for (var it = LATER.iterator(); it.hasNext();) {
				Object[] x = it.next();
				int left = (Integer) x[2] - 1;
				if (left > 0) {
					x[2] = left;
					continue;
				}
				it.remove();
				((Drops) x[0]).clear((ServerLevel) x[1]);
			}
		}

		static void reset() {
			LATER.clear();
		}
	}

	// ------------------------------------------------------------------ state, persistence

	private static void commit(MinecraftServer server, State s) {
		state = s;
		save(server, s);
		notifyListeners();
	}

	private static void notifyListeners() {
		List<Site> list = all();
		for (Consumer<List<Site>> l : LISTENERS) {
			try {
				l.accept(list);
			} catch (Throwable t) {
				Architect.LOGGER.warn("Sites listener failed", t);
			}
		}
	}

	private static Path file(MinecraftServer server) {
		return server.getWorldPath(LevelResource.ROOT).resolve(FILE);
	}

	private static void save(MinecraftServer server, State s) {
		if (loadFailed) {
			return;
		}
		Path f = file(server);
		try {
			Path tmp = f.resolveSibling(FILE + ".tmp");
			JsonObject root = Site.fileJson(List.copyOf(s.byId().values()), s.next(), s.pending(), List.copyOf(groups.values()), nextGroup);
			// phase 4e: roads and cell sites in their own array (0.7.0 never sees them; its saves drop it; the journal rebuilds them)
			JsonArray infra = Infras.toJson();
			if (!infra.isEmpty()) {
				root.add("infra", infra);
			}
			Files.writeString(tmp, GSON.toJson(root), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}

	private static void load(MinecraftServer server) {
		loadFailed = false;
		groups = Map.of();
		nextGroup = 1;
		Infras.load(new JsonArray());
		Path f = file(server);
		if (!Files.exists(f)) {
			state = State.EMPTY;
			return;
		}
		try {
			JsonObject root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			Site.FileData data = Site.fileFromJson(root);
			Infras.load(root.has("infra") && root.get("infra").isJsonArray() ? root.getAsJsonArray("infra") : new JsonArray());
			Map<String, Site> map = new LinkedHashMap<>();
			for (Site b : data.sites()) {
				map.put(b.id(), b);
			}
			state = new State(Collections.unmodifiableMap(map), data.next(), data.pending());
			Map<String, SiteGroupRec> gs = new LinkedHashMap<>();
			data.groups().forEach(g -> gs.put(g.id(), g));
			groups = Collections.unmodifiableMap(gs);
			nextGroup = data.nextGroup();
			Architect.LOGGER.info("Loaded {} site(s) {}{}", map.size(), map.keySet(), data.pending().isEmpty() ? ""
				: "; " + data.pending().size() + " site(s) taken down before the last stop");
		} catch (Exception e) {
			Architect.LOGGER.warn("Could not read {}; no sites loaded (the file is left as is)", f, e);
			state = State.EMPTY;
			loadFailed = true;
		}
	}

	/** The sites as JSON for the DevBridge: records, pending, reports, unreferenced snapshot files. Any thread. */
	public static JsonObject json() {
		JsonObject o = new JsonObject();
		JsonArray sites = new JsonArray();
		all().forEach(b -> {
			JsonObject j = b.toJson();
			JsonArray ids = new JsonArray();
			SiteJournal.active(b.id()).forEach(m -> ids.add(m.id()));
			j.add("entries", ids);
			sites.add(j);
		});
		o.add("sites", sites);
		JsonArray pend = new JsonArray();
		pending().forEach(p -> {
			JsonObject j = p.toJson();
			List<JournalStore.Meta> es = SiteJournal.entries(p.site().id()).stream().filter(m -> m.status() == Journal.Status.UNDONE).toList();
			j.addProperty("snapshotExists", !es.isEmpty());
			JsonArray ids = new JsonArray();
			es.forEach(m -> ids.add(m.id()));
			j.add("entries", ids);
			pend.add(j);
		});
		o.add("infra", Infras.toJson());
		o.add("pending", pend);
		JsonObject rep = new JsonObject();
		reports().forEach((id, r) -> rep.addProperty(id, (r.problem() ? "problem: " : "note: ") + r.message()));
		o.add("reports", rep);
		JsonArray un = new JsonArray();
		unreferenced().forEach(un::add);
		o.add("unreferenced", un);
		o.addProperty("loadFailed", loadFailed);
		return o;
	}

	/** ARCHITECT_TRACE_JOBS: timings of the steps of one call, logged when it is done. */
	static final class Trace {
		static final boolean ON = System.getenv("ARCHITECT_TRACE_JOBS") != null;
		final String what;
		long t = System.nanoTime();
		final StringBuilder sb = new StringBuilder();

		Trace(String what) {
			this.what = what;
		}

		void mark(String label) {
			if (ON) {
				long n = System.nanoTime();
				sb.append(' ').append(label).append(' ').append(String.format(java.util.Locale.ROOT, "%.1f", (n - t) / 1e6));
				t = n;
			}
		}

		void done() {
			if (ON) {
				Architect.LOGGER.info("TRACE {}:{}", what, sb);
			}
		}
	}
}
