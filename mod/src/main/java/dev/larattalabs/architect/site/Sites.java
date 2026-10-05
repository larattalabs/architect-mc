package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
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
 * {@code <world>/architect-sites.json}, with the terrain each one replaced kept as a structure snapshot in
 * {@code <world>/architect-sites/<file>.nbt}. Loaded when any world starts and cleared when it stops. The world is only
 * changed by {@link #place}, {@link #remove} and {@link #move}, which run on explicit commands (or a ghost confirm) on the
 * server thread; reads are safe from any thread.
 *
 * <p><b>Placement contract</b> (kept from AgentCraft docs/BUILDINGS.md): terrain fit (foundation fill, cleared terrain),
 * the entrance approach, occupancy (players, pets and things that matter refuse; hostile mobs are removed), fluids (lava
 * refuses, water is a note), safe remove (the player's things in the box refuse unless forced), crash safety (a taken-down
 * site's snapshot is kept until the next world start finds the restored terrain on disk) and move / undo move.
 *
 * <p><b>Snapshots instead of AgentCraft's world journal.</b> Sites never overlap and there are no roads or trophies, so each
 * site owns one snapshot file, named in its record. Order of every change: the snapshot file first (written, then renamed
 * into place), then the blocks, then the record file. A file that no record or pending entry names is kept and reported
 * at world start (never deleted).
 */
public final class Sites {
	public static final String FILE = "architect-sites.json";
	public static final String SNAPSHOT_DIR = "architect-sites";
	/** Block update flags for placing and restoring: sync to clients, no drops, no container spills (no duplicated items on restore). */
	static final int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_SUPPRESS_DROPS | Block.UPDATE_SKIP_BLOCK_ENTITY_SIDEEFFECTS;
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** Immutable state: sites by id (placement order), the next id number, sites taken down since the last world start. */
	private record State(Map<String, Site> byId, int next, List<Site.Pending> pending) {
		static final State EMPTY = new State(Map.of(), 1, List.of());
	}

	private static volatile State state = State.EMPTY;
	/** The sites file exists but could not be parsed: placing would overwrite it, so it is refused. */
	private static volatile boolean loadFailed;
	private static volatile @Nullable Path worldDir;
	private static final List<Consumer<List<Site>>> LISTENERS = new CopyOnWriteArrayList<>();

	/** Thrown by {@link #place} / {@link #remove} / {@link #move} with a message meant for the player. */
	public static final class SiteException extends Exception {
		public SiteException(String message) {
			super(message);
		}
	}

	private Sites() {
	}

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			worldDir = server.getWorldPath(LevelResource.ROOT);
			load(server);
			reconcile(server);
			notifyListeners();
		});
		Builder.init();
		ServerTickEvents.END_SERVER_TICK.register(server -> Drops.tick());
		ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			state = State.EMPTY;
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
		MinecraftServer server = level.getServer();
		if (loadFailed) {
			throw new SiteException(FILE + " could not be read when the world started (see the log); fix or move it, then restart");
		}
		State s = state;
		int next = s.next();
		while (snapshotUsed("s" + next)) {
			next++; // never reuse an id a snapshot file still carries
		}
		String id = "s" + next;
		boolean survival = SurvivalWorld.on();
		Built built = build(level, bp, origin, rotation, force, null, id);
		Construction construction = null;
		if (survival) {
			try {
				construction = Builder.convert(level, bp, built, id, owner);
			} catch (SiteException | RuntimeException e) {
				Architect.LOGGER.error("Making {} a construction site failed; taking the placement down", id, e);
				unbuild(level, built);
				throw e instanceof SiteException se ? se : new SiteException("Making the construction site failed (" + e.getMessage() + "); the area was restored");
			}
		}
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		long now = System.currentTimeMillis();
		Site b = new Site(id, bp.id(), BlueprintTransform.rotationName(built.turns()), built.box(), built.interior(), built.anchors(), now,
			dimensionId(level), built.snapshotBox(), built.snapshot(), null, built.pin(), construction);
		map.put(id, b);
		commit(server, new State(Collections.unmodifiableMap(map), next + 1, s.pending()));
		lastNote = built.note();
		Architect.LOGGER.info("Placed site {} ({}) at {} rotation {}: box {}, snapshot {} over {}{}{}", id, bp.id(), origin.toShortString(), b.rotation(),
			Anchors.str(b.box()), b.snapshot(), Anchors.str(b.restoreBox()), force ? " (forced)" : "", built.note() == null ? "" : "; " + built.note());
		return b;
	}

	/** A template put into the world (not recorded yet): its snapshot file (written) and the terrain tag (to roll back). */
	record Built(int turns, Anchors.Bounds box, Anchors.Bounds snapshotBox, Anchors.Bounds interior, Map<String, Anchor> anchors,
		Site.Pin pin, @Nullable String note, String snapshot, CompoundTag before, TemplateGrid grid, TerrainFit.Plan plan, Approach.Plan approach) {
	}

	/** Takes a built but unrecorded site down again and deletes its snapshot file. */
	static void unbuild(ServerLevel level, Built built) {
		try {
			Drops drops = Drops.before(level, built.snapshotBox());
			restoreTemplate(level, built.snapshotBox(), built.before());
			drops.clearNew(level);
			releaseHeld(level, built.pin().heldLeaves());
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Could not take the site {} down again (its saved terrain is {})", Anchors.str(built.snapshotBox()), built.snapshot(), e);
			return;
		}
		deleteSnapshot(built.snapshot());
	}

	/** What a site placed from {@code grid} with {@code turns} pins. */
	static Site.Pin pinFor(TemplateGrid grid, int turns) {
		return new Site.Pin(grid.fingerprint(), grid.blockEntityOffsets(turns));
	}

	// ------------------------------------------------------------------ held leaves (LeafGuard)

	/** Releases held leaves, except cells inside a standing site's box in this dimension (they are that site's now). */
	private static void releaseHeld(ServerLevel level, List<Integer> held) {
		if (held.isEmpty()) {
			return;
		}
		String here = dimensionId(level);
		List<Anchors.Bounds> boxes = state.byId().values().stream().filter(x -> x.dimension().equals(here)).map(Site::restoreBox).toList();
		List<Integer> free = new ArrayList<>(held.size());
		for (int i = 0; i + 3 < held.size(); i += 4) {
			int x = held.get(i);
			int y = held.get(i + 1);
			int z = held.get(i + 2);
			if (boxes.stream().noneMatch(bx -> LeafGuard.distanceTo(bx, x, y, z) == 0)) {
				free.addAll(held.subList(i, i + 4));
			}
		}
		LeafGuard.release(level, free, FLAGS);
	}

	/**
	 * Before a new snapshot of {@code box}: leaves standing sites hold inside it get their natural state back and leave
	 * those sites' records (the new site's snapshot keeps them natural; the new site's own hold covers what it needs).
	 */
	private static void releaseHeldInside(ServerLevel level, Anchors.Bounds box) {
		State s = state;
		String here = dimensionId(level);
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		boolean changed = false;
		for (Site x : s.byId().values()) {
			if (!x.dimension().equals(here) || x.pin() == null || x.pin().heldLeaves().isEmpty()) {
				continue;
			}
			List<Integer> held = x.pin().heldLeaves();
			List<Integer> keep = new ArrayList<>(held.size());
			List<Integer> inside = new ArrayList<>();
			for (int i = 0; i + 3 < held.size(); i += 4) {
				boolean in = LeafGuard.distanceTo(box, held.get(i), held.get(i + 1), held.get(i + 2)) == 0;
				(in ? inside : keep).addAll(held.subList(i, i + 4));
			}
			if (inside.isEmpty()) {
				continue;
			}
			LeafGuard.release(level, inside, FLAGS);
			map.put(x.id(), withPin(x, x.pin().withHeldLeaves(keep)));
			changed = true;
		}
		if (changed) {
			state = new State(Collections.unmodifiableMap(map), s.next(), s.pending()); // the caller's commit writes it
		}
	}

	/** After {@code box} got its old terrain back: standing sites near it hold again the leaves that hang on them. */
	private static void reholdNear(ServerLevel level, Anchors.Bounds box) {
		State s = state;
		String here = dimensionId(level);
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		boolean changed = false;
		for (Site x : s.byId().values()) {
			if (!x.dimension().equals(here) || x.pin() == null || !near(x.restoreBox(), box, 2 * LeafGuard.RADIUS)) {
				continue;
			}
			List<Integer> more = LeafGuard.hold(level, x.restoreBox(), FLAGS);
			if (more.isEmpty()) {
				continue;
			}
			List<Integer> all = new ArrayList<>(x.pin().heldLeaves());
			all.addAll(more);
			map.put(x.id(), withPin(x, x.pin().withHeldLeaves(all)));
			changed = true;
		}
		if (changed) {
			state = new State(Collections.unmodifiableMap(map), s.next(), s.pending()); // the caller's commit writes it
		}
	}

	private static boolean near(Anchors.Bounds a, Anchors.Bounds b, int d) {
		return a.minX() - d <= b.maxX() && b.minX() <= a.maxX() + d && a.minY() - d <= b.maxY() && b.minY() <= a.maxY() + d
			&& a.minZ() - d <= b.maxZ() && b.minZ() <= a.maxZ() + d;
	}

	private static Site withPin(Site x, Site.Pin pin) {
		return new Site(x.id(), x.blueprint(), x.rotation(), x.box(), x.interior(), x.anchors(), x.placedAt(), x.dimension(), x.snapshotBox(),
			x.snapshot(), x.movedFrom(), pin, x.construction());
	}

	/** {@link #pinFor} without the bed cells a placement left out ({@link #removeUnsafeBeds}). */
	static Site.Pin pinFor(TemplateGrid grid, int turns, Set<Long> removedBeds, Anchors.Bounds box) {
		Site.Pin pin = pinFor(grid, turns);
		return pin.withoutBlockEntities(BedSafety.withoutCells(pin.blockEntities(), removedBeds, box.minX(), box.minY(), box.minZ()));
	}

	/** The template's beds a placement left out: every removed cell and the head cells, as {@link BlockPos#asLong}. */
	private record BedsOut(Set<Long> cells, Set<Long> heads) {
	}

	/**
	 * Takes the template's own beds out again where the level's bed rule makes them dangerous (in the Nether and the End a
	 * bed explodes when used, which ends a Hardcore world): both halves become air (no drops, {@link #FLAGS}). The rule is
	 * read at each bed's head cell, as vanilla does. Only cells the template wrote a bed to are looked at. Server thread.
	 */
	private static BedsOut removeUnsafeBeds(ServerLevel level, TemplateGrid grid, int turns, Anchors.Bounds box) {
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
		return grid != null && b.pin() != null && grid.fingerprint().equals(b.pin().template()) ? grid : null;
	}

	@FunctionalInterface
	private interface Refusals {
		void add(String message) throws SiteException;
	}

	private static final Refusals THROW = m -> {
		throw new SiteException(m);
	};

	/** A site that passed {@link #checkSite}: everything {@link #build} needs, so it never looks at the world twice. */
	private record SitePlan(StructureTemplate template, int turns, StructurePlaceSettings settings, BlockPos placePos, Anchors.Bounds box,
		TemplateGrid grid, TerrainFit.Plan plan, Approach.Plan approach, Anchors.Bounds snapBox, List<Occupancy.Found> found, SiteWarnings.Result site) {
	}

	/**
	 * The checks of a placement (place, move and the dry-run {@link #verdict}) in place()'s order. Each failing check goes to
	 * {@code out}. {@code dryRun}: the world is only read where its chunks are loaded. Null when the site could not be planned
	 * at all. {@code moving}: the site being moved. Server thread.
	 */
	private static @Nullable SitePlan checkSite(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force,
		@Nullable Site moving, Refusals out, boolean dryRun) throws SiteException {
		Blueprints.Entry entry = Blueprints.entry(bp.id());
		if (entry == null) {
			out.add("Design " + bp.id() + " has no loaded template");
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
			out.add("Internal: rotated box " + bb + " does not start at " + origin.toShortString());
			return null;
		}
		Anchors.Bounds box = new Anchors.Bounds(bb.minX(), bb.minY(), bb.minZ(), bb.maxX(), bb.maxY(), bb.maxZ());
		TemplateGrid grid = TemplateGrid.of(entry);
		GhostModel model = grid.ghost(turns);
		boolean[] unloaded = {false};
		TerrainFit.World world = dryRun ? (x, y, z) -> {
			if (!level.hasChunk(x >> 4, z >> 4)) {
				unloaded[0] = true;
				return 0;
			}
			return TerrainFit.flags(level, new BlockPos(x, y, z));
		} : (x, y, z) -> TerrainFit.flags(level, new BlockPos(x, y, z));
		TerrainFit.Plan plan = TerrainFit.plan(model, box.minX(), box.minY(), box.minZ(), world);
		Approach.Plan approach = Approach.forBlueprint(bp, turns, box, world);
		SiteWarnings.Result site = SiteWarnings.forBlueprint(bp, turns, box, approach, world);
		Anchors.Bounds snapBox = snapshotBox(box, plan, approach);
		if (dryRun && (unloaded[0] || !loaded(level, snapBox))) {
			out.add("the site is not loaded on the server (walk closer)");
			return null;
		}
		if (snapBox.minY() < level.getMinY() || box.maxY() > level.getMaxY()) {
			out.add("Box " + Anchors.str(snapBox) + " leaves the build height (" + level.getMinY() + ".." + level.getMaxY() + ")");
		}
		String here = dimensionId(level);
		for (Site other : state.byId().values()) {
			if (other.dimension().equals(here) && Anchors.intersects(other.restoreBox(), snapBox)) {
				out.add("Box " + Anchors.str(snapBox) + " overlaps " + (moving != null && other.id().equals(moving.id())
					? "where " + other.id() + " stands now (move it further)" : "site " + other.id() + " " + Anchors.str(other.box())
					+ " (remove it first or place elsewhere)"));
				break;
			}
		}
		String lava = TerrainFit.lavaRefusal(plan);
		if (lava == null) {
			lava = Approach.lavaRefusal(approach);
		}
		if (lava != null) {
			out.add("Not here: " + lava + "; a building next to lava burns and floods");
		}
		if (!force) {
			List<String> foreign = blockEntities(level, snapBox);
			if (!foreign.isEmpty()) {
				out.add("Box " + Anchors.str(snapBox) + " contains " + foreign.size() + " block entit" + (foreign.size() == 1 ? "y" : "ies")
					+ " (" + String.join(", ", foreign.subList(0, Math.min(4, foreign.size()))) + (foreign.size() > 4 ? ", ..." : "")
					+ "); add force to overwrite them (they come back on remove)");
			}
		}
		List<String> doors = straddling(level, snapBox, true);
		if (!doors.isEmpty()) {
			out.add("Not placed: a door is cut in half by the box edge (" + String.join(", ", doors.subList(0, Math.min(3, doors.size())))
				+ "); raise, lower or move the building so the door is fully in or out");
		}
		if (moving == null && SurvivalWorld.on()) {
			List<String> creative = Builder.creativeOnly(grid, bp);
			if (!creative.isEmpty()) {
				out.add("This design uses " + String.join(", ", creative.stream().map(c -> c.replace("minecraft:", "")).toList())
					+ ", which survival can't build");
			}
		}
		List<Occupancy.Found> found = Occupancy.scan(level, snapBox, e -> false);
		List<String> occupied = Occupancy.refusals(found);
		if (!occupied.isEmpty()) {
			out.add("Not placed: " + String.join("; ", occupied));
		}
		return new SitePlan(template, turns, settings, placePos, box, grid, plan, approach, snapBox, found, site);
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
	public record Verdict(List<String> refusals, List<String> notes) {
		public Verdict {
			refusals = List.copyOf(refusals);
			notes = List.copyOf(notes);
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
		List<String> refusals = new ArrayList<>();
		Refusals out = refusals::add;
		Site moving = null;
		try {
			if (loadFailed) {
				refusals.add(FILE + " could not be read when the world started (see the log); fix or move it, then restart");
			}
			if (movingId != null) {
				moving = get(movingId);
				if (moving == null) {
					return new Verdict(List.of("No site " + movingId), List.of());
				}
				String noMove = moveRefusal(moving);
				if (noMove != null) {
					return new Verdict(List.of(noMove), List.of());
				}
				ServerLevel oldLevel = levelOf(level.getServer(), moving);
				if (oldLevel == null) {
					refusals.add(moving.dimension() + " is not loaded; nothing was moved");
				}
				Site m = moving;
				if (oldLevel != null && (!dryRun || loaded(oldLevel, m.restoreBox()))) {
					try {
						refusePlayerIn(oldLevel, m.restoreBox(), movingId, "moving it");
					} catch (SiteException e) {
						refusals.add(e.getMessage());
					}
					if (!force) {
						List<String> blockers = removalBlockers(oldLevel, moving);
						if (!blockers.isEmpty()) {
							refusals.add(blockersMessage(movingId, blockers).replace("removing it", "moving it"));
						}
					}
				}
			}
			SitePlan site = checkSite(level, bp, origin, rotation, force, moving, out, dryRun);
			return new Verdict(refusals, site == null ? List.of() : siteNotes(site, site.found()));
		} catch (SiteException | RuntimeException e) {
			refusals.add(e.getMessage() == null ? e.toString() : e.getMessage());
			return new Verdict(refusals, List.of());
		}
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
	 * Checks a site (the first refusal thrown) and puts the template there: the terrain captured and its snapshot file
	 * written first, then the template, foundation, cleared terrain, the approach, and drops caused by it removed.
	 * Restores the terrain and throws when anything fails.
	 */
	private static Built build(ServerLevel level, Blueprint bp, BlockPos origin, Rotation rotation, boolean force, @Nullable Site moving, String id)
		throws SiteException {
		SitePlan site = checkSite(level, bp, origin, rotation, force, moving, THROW, false);
		if (site == null) {
			throw new SiteException("Internal: no site for " + bp.id());
		}
		Anchors.Bounds box = site.box();
		TerrainFit.Plan plan = site.plan();
		Approach.Plan approach = site.approach();
		Anchors.Bounds snapBox = site.snapBox();
		// leaves other sites (or this one, when moving) hold inside the new box: natural again before the snapshot, so a
		// later Remove of this site does not bring them back persistent (they are this site's terrain now)
		releaseHeldInside(level, snapBox);
		CompoundTag before;
		String snapshot = id + "-" + System.currentTimeMillis() + ".nbt";
		try {
			before = capture(level, snapBox);
			writeSnapshot(snapshot, before);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save the snapshot of {}", Anchors.str(snapBox), e);
			throw new SiteException("Could not save the terrain snapshot (" + e.getMessage() + "); nothing was placed");
		}
		List<BlockPos> plants = straddlingPositions(level, snapBox, false);
		Drops drops = Drops.before(level, snapBox);
		// leaves outside the box that hang on logs inside it: kept from decaying while the site stands (before the box changes)
		List<Integer> held = LeafGuard.hold(level, snapBox, FLAGS);
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
			int turns = site.turns();
			return new Built(turns, box, snapBox, BlueprintTransform.worldBounds(bp, turns, box.minX(), box.minY(), box.minZ()),
				BlueprintTransform.worldAnchors(bp, turns, box.minX(), box.minY(), box.minZ()),
				pinFor(site.grid(), turns, beds.cells(), box).withHeldLeaves(held), notes.isEmpty() ? null : String.join("; ", notes), snapshot, before,
				site.grid(), plan, approach);
		} catch (RuntimeException e) {
			// never leave a half-built, unrecorded box behind: put the site back as it was captured
			Architect.LOGGER.error("Placing {} at {} failed; restoring box {}", bp.id(), origin.toShortString(), Anchors.str(snapBox), e);
			restoreTemplate(level, snapBox, before);
			releaseHeld(level, held);
			deleteSnapshot(snapshot);
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

	/**
	 * Puts back exactly what was in the site's box (foundation and approach included) before it was placed, then forgets the
	 * site. Refuses, listing them, when the box holds things the site did not bring ({@link #removalBlockers}) unless
	 * {@code force}. The snapshot is kept until the next world start confirms the restored terrain reached the disk. Server thread.
	 */
	public static Site remove(ServerLevel level, String id, boolean force) throws SiteException {
		Site b = get(id);
		if (b == null) {
			throw new SiteException("No site " + id + " (see /architect list)");
		}
		if (!b.dimension().equals(dimensionId(level))) {
			throw new SiteException(id + " is in " + b.dimension() + ", not in " + dimensionId(level) + ": remove it from there");
		}
		MinecraftServer server = level.getServer();
		CompoundTag before = readSnapshot(b);
		refusePlayerIn(level, b.restoreBox(), id, "removing it");
		if (!force) {
			List<String> blockers = removalBlockers(level, b);
			if (!blockers.isEmpty()) {
				throw new SiteException(blockersMessage(id, blockers));
			}
		}
		// a construction site deconstructs: refunds for paid cells still standing, the player's blocks and the crate's stock
		Builder.Deconstruction dec = b.construction() != null ? Builder.prepareDeconstruct(level, b, before) : null;
		Drops drops = Drops.before(level, b.restoreBox());
		restoreTemplate(level, b.restoreBox(), before);
		drops.clearNew(level);
		if (dec != null) {
			Builder.dropDeconstruction(level, b, dec, drops);
		}
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.remove(id);
		state = new State(Collections.unmodifiableMap(map), s.next(), s.pending());
		if (b.pin() != null) {
			releaseHeld(level, b.pin().heldLeaves());
		}
		reholdNear(level, b.restoreBox());
		s = state;
		map = new LinkedHashMap<>(s.byId());
		List<Site.Pending> pending = new ArrayList<>(s.pending());
		pending.add(new Site.Pending(b, System.currentTimeMillis(), "removed"));
		reports.remove(id);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), List.copyOf(pending)));
		Architect.LOGGER.info("Removed site {} ({}): restored box {}{}; snapshot {} kept until the next world start", id, b.blueprint(),
			Anchors.str(b.restoreBox()), force ? " (forced)" : "", b.snapshot());
		return b;
	}

	/** The snapshot of a standing site, or a refusal naming the way out. */
	private static CompoundTag readSnapshot(Site b) throws SiteException {
		try {
			return readSnapshot(b.snapshot());
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not read the snapshot {} of {}", b.snapshot(), b.id(), e);
			throw new SiteException("The saved terrain of " + b.id() + " (" + SNAPSHOT_DIR + "/" + b.snapshot() + ") cannot be read, so it cannot be "
				+ "restored; /architect remove " + b.id() + " forget drops the record and leaves the blocks");
		}
	}

	/** Refuses when a player stands in (or next to) a box about to get its old terrain back: restoring it would bury them. */
	static void refusePlayerIn(ServerLevel level, Anchors.Bounds box, String id, String verb) throws SiteException {
		for (Occupancy.Found f : Occupancy.scan(level, box, e -> false)) {
			if (f.kind() == Occupancy.Kind.PLAYER) {
				throw new SiteException("Step out of " + id + " first (" + f.name() + " is in or next to it): " + verb
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
	 * containers / lecterns the player filled, dropped items (not natural drops), pets, item frames, armor stands. Server thread.
	 */
	public static List<String> removalBlockers(ServerLevel level, Site b) {
		List<String> out = new ArrayList<>();
		Set<BlockPos> own = ownBlockEntities(b);
		Anchors.Bounds box = b.restoreBox();
		forEachBlockEntity(level, box, be -> {
			BlockPos p = be.getBlockPos();
			String what = be.getBlockState().getBlock().getName().getString().toLowerCase(java.util.Locale.ROOT) + " at " + p.toShortString();
			if (be instanceof LecternBlockEntity lectern) {
				if (lectern.hasBook() || !own.contains(p)) {
					out.add(what + (lectern.hasBook() ? " (with a book)" : ""));
				}
				return;
			}
			if (be instanceof Container c && !c.isEmpty()) {
				out.add(what + " (" + items(c) + ")");
				return;
			}
			if (!own.contains(p)) {
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

	/** Drops the record of a site without touching the world: its blocks stay for good, its snapshot file is deleted. */
	public static void forget(MinecraftServer server, String id) throws SiteException {
		State s = state;
		Site b = s.byId().get(id);
		if (b == null) {
			throw new SiteException("No site " + id);
		}
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.remove(id);
		reports.remove(id);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), s.pending()));
		deleteSnapshot(b.snapshot());
		if (b.construction() != null) {
			Builder.forget(server, id);
			deleteSnapshot(b.construction().target());
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
	 * then restores the old one (its snapshot kept until the next world start, as for a removal) and records the old place in
	 * {@link Site#movedFrom()}. Server thread.
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
		CompoundTag oldTerrain = readSnapshot(b);
		refusePlayerIn(oldLevel, b.restoreBox(), id, "moving it");
		if (!force) {
			List<String> blockers = removalBlockers(oldLevel, b);
			if (!blockers.isEmpty()) {
				throw new SiteException(blockersMessage(id, blockers).replace("removing it", "moving it"));
			}
		}
		Built built = build(level, bp, origin, rotation, force, b, id);
		long now = System.currentTimeMillis();
		Site nb = new Site(id, b.blueprint(), BlueprintTransform.rotationName(built.turns()), built.box(), built.interior(), built.anchors(), b.placedAt(),
			dimensionId(level), built.snapshotBox(), built.snapshot(), b.location(), built.pin());
		try {
			if (failNextMove) {
				failNextMove = false;
				throw new IllegalStateException("injected failure restoring the old site (dev.sites.failNextMove)");
			}
			Drops drops = Drops.before(oldLevel, b.restoreBox());
			restoreTemplate(oldLevel, b.restoreBox(), oldTerrain);
			drops.clearNew(oldLevel);
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Moving {}: restoring the old site failed; taking the new site down again", id, e);
			unbuild(level, built);
			throw new SiteException("Moving " + id + " failed (" + e.getMessage() + "); the new site was restored, " + id + " stays where it was");
		}
		// the old record as it is now (building the new site may have taken some of its held leaves into the new box)
		Site cur = get(id);
		State s0 = state;
		Map<String, Site> m0 = new LinkedHashMap<>(s0.byId());
		m0.put(id, nb);
		state = new State(Collections.unmodifiableMap(m0), s0.next(), s0.pending());
		Site.Pin oldPin = cur != null && cur.placedAt() == b.placedAt() && cur.box().equals(b.box()) ? cur.pin() : b.pin();
		if (oldPin != null) {
			releaseHeld(oldLevel, oldPin.heldLeaves());
		}
		// hold again what standing sites near the old place need (a short move shares leaves with the old site)
		reholdNear(oldLevel, b.restoreBox());
		nb = get(id) != null ? get(id) : nb;
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		map.put(id, nb);
		List<Site.Pending> pending = new ArrayList<>(s.pending());
		pending.add(new Site.Pending(b, now, "moved"));
		reports.remove(id);
		commit(server, new State(Collections.unmodifiableMap(map), s.next(), List.copyOf(pending)));
		lastNote = built.note();
		Architect.LOGGER.info("Moved site {} from {} ({}) to {} ({}){}", id, Anchors.str(b.box()), b.dimension(), Anchors.str(nb.box()), nb.dimension(),
			built.note() == null ? "" : "; " + built.note());
		return nb;
	}

	private static volatile boolean failNextMove;

	/** Why a site may not move: in survival (the toggle on, or a construction site) a move would carry the building for free. */
	public static @Nullable String moveRefusal(Site b) {
		if (b.construction() != null || SurvivalWorld.on()) {
			return "Move is refused in survival: deconstruct " + b.id() + " and place it again";
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

	/** The sites taken down whose snapshots are kept until the next world start settles them. Any thread. */
	public static List<Site.Pending> pending() {
		return state.pending();
	}

	/** {matching non-air blocks, non-air template blocks} of a site's own template in the world; {0, 0} when it cannot be checked. */
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
			total++;
			// by block, not state: players open doors
			if (level.getBlockState(p.set(b.box().minX() + m.x(i), b.box().minY() + m.y(i), b.box().minZ() + m.z(i))).is(want.getBlock())) {
				match++;
			}
		}
		return new int[] {match, total};
	}

	private static @Nullable Boolean stands(MinecraftServer server, Site b) {
		int[] st = standing(server, b, ownGrid(b));
		return st[1] == 0 ? null : Reconcile.stands(st[0], st[1]);
	}

	/** Whether a taken-down site shows its saved terrain again ({@link Reconcile#restored}); null when it cannot be told. */
	static @Nullable Boolean restored(MinecraftServer server, Site b) {
		ServerLevel level = levelOf(server, b);
		if (level == null) {
			return null;
		}
		TemplateGrid saved;
		try {
			StructureTemplate t = new StructureTemplate();
			t.load(level.registryAccess().lookupOrThrow(Registries.BLOCK), readSnapshot(b.snapshot()));
			saved = TemplateGrid.read(null, t);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Sites check: could not read the snapshot {}", b.snapshot(), e);
			return null;
		}
		Anchors.Bounds rb = b.restoreBox();
		Map<Long, BlockState> terrain = new java.util.HashMap<>();
		for (int i = 0; i < saved.count(); i++) {
			terrain.put(BlockPos.asLong(rb.minX() + saved.xyz()[i * 3], rb.minY() + saved.xyz()[i * 3 + 1], rb.minZ() + saved.xyz()[i * 3 + 2]),
				saved.states()[i]);
		}
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		int total = 0;
		int match = 0;
		TemplateGrid grid = ownGrid(b);
		if (grid != null) {
			GhostModel m = grid.ghost(Math.max(0, BlueprintTransform.ROTATIONS.indexOf(b.rotation())));
			for (int i = 0; i < m.count(); i++) {
				p.set(b.box().minX() + m.x(i), b.box().minY() + m.y(i), b.box().minZ() + m.z(i));
				BlockState was = terrain.get(p.asLong());
				if (was == null || was.is(grid.states()[i].getBlock())) {
					continue;
				}
				total++;
				if (level.getBlockState(p).is(was.getBlock())) {
					match++;
				}
			}
		}
		return Reconcile.restored(match, total);
	}

	/**
	 * At world start, checks the records against the world and settles the sites taken down before the game stopped: a
	 * snapshot is only deleted on positive evidence ({@link Reconcile#decide}). A removal or move that never reached the disk
	 * gets its record back; doubtful cases are reported and keep their snapshot. A site whose template no longer stands is
	 * reported. Snapshot files nobody names are listed. Never deletes a record or changes the world. Server thread.
	 */
	static void reconcile(MinecraftServer server) {
		reports.clear();
		if (loadFailed) {
			return;
		}
		State s = state;
		Map<String, Site> map = new LinkedHashMap<>(s.byId());
		List<Site.Pending> pending = new ArrayList<>(s.pending());
		boolean changed = false;
		Map<String, Boolean> standsNow = new java.util.HashMap<>();
		for (Site b : map.values()) {
			if (b.construction() != null) {
				Builder.Run run = Builder.run(server, b);
				if (run == null) {
					report(b.id(), true, b.id() + "'s construction plan " + SNAPSHOT_DIR + "/" + b.construction().target() + " is missing; it can only be "
						+ "removed");
					continue;
				}
				if (b.building()) {
					// half built is not "doesn't match its blueprint": what is built was just derived from the world
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
			if (!Files.exists(snapshotFile(gone.snapshot()))) {
				Architect.LOGGER.warn("Sites check: the snapshot {} of {}'s {} site is missing; dropping the entry", gone.snapshot(), gone.id(), p.why());
				pending.remove(p);
				changed = true;
				continue;
			}
			List<Reconcile.Site> sites = new ArrayList<>();
			for (Site o : map.values()) {
				sites.add(new Reconcile.Site(o.id(), o.dimension(), o.restoreBox(), standsNow.get(o.id())));
			}
			Reconcile.Found found = Reconcile.overlap(new Reconcile.Site(gone.id(), gone.dimension(), gone.restoreBox(), null), sites);
			String over = found.by() == null || found.by().equals(gone.id()) ? null : found.by();
			Site current = map.get(gone.id());
			Boolean stands = stands(server, gone);
			Boolean restored = restored(server, gone);
			Reconcile.Action action = Reconcile.decide(moved, stands, restored, found.overlap(), current != null,
				current == null ? null : standsNow.get(gone.id()));
			Architect.LOGGER.info("Sites check: {} site of {} at {} (stands {}, restored {}, overlap {}): {}", p.why(), gone.id(),
				Anchors.str(gone.restoreBox()), stands, restored, found.overlap(), action);
			switch (action) {
				case RELEASE -> {
					// the same file may still be a current record's (undo move back onto it never reuses names, but be safe)
					if (map.values().stream().noneMatch(o -> o.snapshot().equals(gone.snapshot()))) {
						deleteSnapshot(gone.snapshot());
					}
					if (gone.construction() != null && map.values().stream().noneMatch(o -> o.construction() != null
						&& o.construction().target().equals(gone.construction().target()))) {
						deleteSnapshot(gone.construction().target());
					}
					pending.remove(p);
					changed = true;
				}
				case RECOVER -> {
					if (moved && current != null) {
						// the move never reached the disk: the site is still at its old place; the new place's snapshot stays as a file
						report(gone.id(), false, gone.id() + "'s move was not saved before the game stopped: it is back at its old place (the new "
							+ "place's snapshot " + current.snapshot() + " is kept)");
					} else {
						report(gone.id(), false, gone.id() + "'s removal was not saved before the game stopped: it stands again (remove it again)");
					}
					map.put(gone.id(), gone);
					recovered.add(gone.id());
					standsNow.put(gone.id(), true);
					pending.remove(p);
					changed = true;
				}
				case REPORT_KEEP -> {
					String on = current != null ? gone.id() : over != null ? over : gone.id();
					String what = over != null && current == null
						? "a copy of " + gone.id() + " (" + p.why() + " before the game stopped, not saved) still stands partly under " + over
						: moved ? gone.id() + " stands at its old place " + Anchors.str(gone.box()) + " too: the move was only partly saved"
						: "removed " + gone.id() + " stands again but could not get its record back";
					report(on, true, what + ". Its saved terrain is kept as " + SNAPSHOT_DIR + "/" + gone.snapshot() + "; nothing was changed");
				}
				case KEEP -> {
				}
			}
		}
		for (Site b : map.values()) {
			Boolean st = standsNow.get(b.id());
			if (Boolean.FALSE.equals(st) && !recovered.contains(b.id())) {
				int[] n = standing(server, b, ownGrid(b));
				report(b.id(), true, Reconcile.mismatch(b.id(), n[0], n[1]));
			}
		}
		if (changed) {
			state = new State(Collections.unmodifiableMap(map), s.next(), List.copyOf(pending));
			save(server, state);
		}
		for (String f : unreferenced()) {
			Architect.LOGGER.warn("Sites check: snapshot {}/{} belongs to no site (a placement whose record was not saved?); kept", SNAPSHOT_DIR, f);
		}
		reports.values().forEach(r -> Architect.LOGGER.warn("Sites check: {}", r.message()));
	}

	/** Snapshot files that no record and no pending entry names (kept, listed for the player / DevBridge). */
	public static List<String> unreferenced() {
		Path dir = snapshotDir();
		if (dir == null || !Files.isDirectory(dir)) {
			return List.of();
		}
		Set<String> named = new HashSet<>();
		State s = state;
		s.byId().values().forEach(b -> named.add(b.snapshot()));
		s.pending().forEach(p -> named.add(p.site().snapshot()));
		s.byId().values().forEach(b -> {
			if (b.construction() != null) {
				named.add(b.construction().target());
			}
		});
		s.pending().forEach(p -> {
			if (p.site().construction() != null) {
				named.add(p.site().construction().target());
			}
		});
		try (Stream<Path> files = Files.list(dir)) {
			return files.map(f -> f.getFileName().toString()).filter(n -> n.endsWith(".nbt") && !named.contains(n)).sorted().toList();
		} catch (IOException e) {
			return List.of();
		}
	}

	// ------------------------------------------------------------------ snapshots

	private static @Nullable Path snapshotDir() {
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

	/** Whether a snapshot file carries this site id (ids are never reused while one does). */
	private static boolean snapshotUsed(String id) {
		Path dir = snapshotDir();
		if (dir == null || !Files.isDirectory(dir)) {
			return false;
		}
		try (Stream<Path> files = Files.list(dir)) {
			return files.anyMatch(f -> f.getFileName().toString().startsWith(id + "-"));
		} catch (IOException e) {
			return false;
		}
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

	static void writeSnapshotFile(String name, CompoundTag tag) throws IOException {
		writeSnapshot(name, tag);
	}

	static void deleteSnapshotFile(String name) {
		deleteSnapshot(name);
	}

	private static void writeSnapshot(String name, CompoundTag tag) throws IOException {
		Path f = snapshotFile(name);
		Files.createDirectories(f.getParent());
		Path tmp = f.resolveSibling(name + ".tmp");
		NbtIo.writeCompressed(tag, tmp);
		// read it back before it counts: a full disk or a broken write refuses the placement, not the later removal
		NbtIo.readCompressed(tmp, NbtAccounter.unlimitedHeap());
		Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
	}

	static CompoundTag readSnapshot(String name) throws IOException {
		return NbtIo.readCompressed(snapshotFile(name), NbtAccounter.unlimitedHeap());
	}

	private static void deleteSnapshot(String name) {
		try {
			Files.deleteIfExists(snapshotFile(name));
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not delete the snapshot {}", name, e);
		}
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
			Files.writeString(tmp, GSON.toJson(Site.fileJson(List.copyOf(s.byId().values()), s.next(), s.pending())), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}

	private static void load(MinecraftServer server) {
		loadFailed = false;
		Path f = file(server);
		if (!Files.exists(f)) {
			state = State.EMPTY;
			return;
		}
		try {
			Site.FileData data = Site.fileFromJson(JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject());
			Map<String, Site> map = new LinkedHashMap<>();
			for (Site b : data.sites()) {
				map.put(b.id(), b);
			}
			state = new State(Collections.unmodifiableMap(map), data.next(), data.pending());
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
		all().forEach(b -> sites.add(b.toJson()));
		o.add("sites", sites);
		JsonArray pend = new JsonArray();
		pending().forEach(p -> {
			JsonObject j = p.toJson();
			Path d = snapshotDir();
			j.addProperty("snapshotExists", d != null && Files.exists(d.resolve(p.site().snapshot())));
			pend.add(j);
		});
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
}
