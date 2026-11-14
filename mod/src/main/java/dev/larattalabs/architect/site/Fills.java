package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FaceAttachedHorizontalDirectionalBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import org.jspecify.annotations.Nullable;

/**
 * (M5 FK, S-M5-3) Filled containers of a given-program entry (docs/CONTRACT.md "### FK contract"): the entry's sidecar {@code fill}
 * ({@code kit/lib/fill.mjs}) declares containers (template cell, slot, item, count) and lock cells (a lever's {@code powered}); a site of
 * it is built with its locks locked and its containers empty, filled once after every core cell stands (one keyed, journaled step whose
 * commit point is the stockpile ledger's {@link StockLedger#markFilled} saved with the charge), then unlocked; at removal its containers'
 * contents go into the ledger's custody in the tick the credit is fixed and refund with the blocks, capped by the paid record.
 *
 * <p>The site's progress is its ext {@code architect_mc:fillState {phase}} ({@link #FILLING}, {@link #FILLED}, {@link #UNLOCKED}), saved
 * with the sites file (synchronously). Server thread throughout.
 */
public final class Fills {
	public static final String EXT_STATE = "architect_mc:fillState";
	public static final String FILLING = "FILLING";
	public static final String FILLED = "FILLED";
	public static final String UNLOCKED = "UNLOCKED";
	public static final int CONTAINERS_MAX = dev.larattalabs.architect.api.Limits.FILL_CONTAINERS_MAX;
	public static final int LOCKS_MAX = dev.larattalabs.architect.api.Limits.FILL_LOCKS_MAX;
	/** (Steward's review A) the lock properties vanilla keeps as written, per block (kit/lib/fill.mjs LOCK_PROPS). */
	static final Map<Block, Set<String>> LOCK_PROPS = Map.of(Blocks.LEVER, Set.of("powered"));

	private Fills() {
	}

	/** One declared stack. */
	public record Stack(int slot, String item, int count) {
	}

	/** A declared container: its template cell and stacks. */
	public record Box(int x, int y, int z, List<Stack> items) {
		public Box {
			items = List.copyOf(items);
		}

		/** Its declaration per item. */
		public Map<String, Integer> counts() {
			Map<String, Integer> m = new TreeMap<>();
			items.forEach(s -> m.merge(s.item(), s.count(), Integer::sum));
			return m;
		}
	}

	/** A lock cell: its template cell and the properties of its locked state. */
	public record Lock(int x, int y, int z, Map<String, String> props) {
		public Lock {
			props = Map.copyOf(props);
		}
	}

	/** An entry's fill. */
	public record Spec(List<Box> containers, List<Lock> locks) {
		public Spec {
			containers = List.copyOf(containers);
			locks = List.copyOf(locks);
		}

		/** Every declared item, summed: the fill's bill. */
		public Map<String, Integer> items() {
			Map<String, Integer> m = new TreeMap<>();
			containers.forEach(b -> b.counts().forEach((k, v) -> m.merge(k, v, Integer::sum)));
			return m;
		}

		public List<SurvivalItems.Cost> costs() {
			List<SurvivalItems.Cost> out = new ArrayList<>();
			items().forEach((k, v) -> out.add(new SurvivalItems.Cost(k, v)));
			return out;
		}
	}

	// ------------------------------------------------------------------ the declaration

	/**
	 * Parses an entry's sidecar {@code fill} (null: the entry has none). Throws {@link IllegalArgumentException} with a plain reason when
	 * it is not usable: not a given-program entry, a bad shape, an unknown item, a count over the item's max stack, a bound, a lock that
	 * is not a kept property. The kit's checker refuses the same shapes first (rule {@code fill}).
	 */
	public static @Nullable Spec parse(@Nullable JsonObject entry) {
		if (entry == null || !entry.has("fill") || entry.get("fill").isJsonNull()) {
			return null;
		}
		if (!entry.has("givenProgram")) {
			throw new IllegalArgumentException("a fill is only for given-program entries (Designs.fromProgram)");
		}
		JsonObject f = entry.getAsJsonObject("fill");
		JsonArray cs = f.has("containers") ? f.getAsJsonArray("containers") : new JsonArray();
		JsonArray ls = f.has("locks") ? f.getAsJsonArray("locks") : new JsonArray();
		if (cs.isEmpty() || cs.size() > CONTAINERS_MAX) {
			throw new IllegalArgumentException("a fill declares 1.." + CONTAINERS_MAX + " containers (has " + cs.size() + ")");
		}
		if (ls.size() > LOCKS_MAX) {
			throw new IllegalArgumentException("a fill declares at most " + LOCKS_MAX + " lock cells (has " + ls.size() + ")");
		}
		List<Box> boxes = new ArrayList<>();
		Set<Long> seen = new java.util.HashSet<>();
		for (JsonElement e : cs) {
			JsonObject c = e.getAsJsonObject();
			int[] at = at(c, seen);
			List<Stack> items = new ArrayList<>();
			Set<Integer> slots = new java.util.HashSet<>();
			for (JsonElement ie : c.getAsJsonArray("items")) {
				JsonObject it = ie.getAsJsonObject();
				int slot = it.get("slot").getAsInt();
				String id = it.get("id").getAsString();
				int count = it.get("count").getAsInt();
				Identifier rl = Identifier.tryParse(id);
				Optional<Item> item = rl == null ? Optional.empty() : BuiltInRegistries.ITEM.getOptional(rl);
				if (item.isEmpty() || item.get() == Items.AIR) {
					throw new IllegalArgumentException("fill item " + id + " is not an item");
				}
				int max = Stockpiles.maxStack(BuiltInRegistries.ITEM.getKey(item.get()).toString());
				if (count < 1 || count > max) {
					throw new IllegalArgumentException("fill " + id + " x" + count + ": 1.." + max + " per slot");
				}
				if (slot < 0 || !slots.add(slot)) {
					throw new IllegalArgumentException("fill slot " + slot + " at " + at[0] + "," + at[1] + "," + at[2] + " is bad or used twice");
				}
				items.add(new Stack(slot, BuiltInRegistries.ITEM.getKey(item.get()).toString(), count));
			}
			if (items.isEmpty()) {
				throw new IllegalArgumentException("a declared container lists no stack");
			}
			boxes.add(new Box(at[0], at[1], at[2], items));
		}
		List<Lock> locks = new ArrayList<>();
		for (JsonElement e : ls) {
			JsonObject l = e.getAsJsonObject();
			int[] at = at(l, seen);
			Map<String, String> props = new TreeMap<>();
			l.getAsJsonObject("locked").entrySet().forEach(p -> props.put(p.getKey(), p.getValue().getAsString()));
			if (props.isEmpty()) {
				throw new IllegalArgumentException("a lock sets no property");
			}
			locks.add(new Lock(at[0], at[1], at[2], props));
		}
		return new Spec(boxes, locks);
	}

	private static int[] at(JsonObject o, Set<Long> seen) {
		JsonArray a = o.getAsJsonArray("at");
		int[] v = {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
		if (!seen.add(BlockPos.asLong(v[0], v[1], v[2]))) {
			throw new IllegalArgumentException("fill cell " + v[0] + "," + v[1] + "," + v[2] + " is declared twice");
		}
		return v;
	}

	/** Why an entry's fill can't be placed, or null (no fill, or a sound one). */
	public static @Nullable String refusal(@Nullable JsonObject entry) {
		try {
			parse(entry);
			return null;
		} catch (RuntimeException e) {
			return e.getMessage() == null ? e.toString() : e.getMessage();
		}
	}

	private static final Map<String, Optional<Spec>> CACHE = new ConcurrentHashMap<>();

	/** The fill of the entry a site stands at (its version, else the head), or null. A fill that doesn't parse counts as none (logged). */
	public static @Nullable Spec of(@Nullable MinecraftServer srv, Site s) {
		JsonObject json = entryJson(srv, s);
		if (json == null || !json.has("fill")) {
			return null;
		}
		String key = s.blueprint() + "|" + s.versioning().version() + "|" + Blueprints.revision();
		return CACHE.computeIfAbsent(key, k -> {
			try {
				return Optional.ofNullable(parse(json));
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Fill of {} ignored: {}", s.blueprint(), e.getMessage());
				return Optional.empty();
			}
		}).orElse(null);
	}

	/** The fill of an entry (its head), or null. */
	public static @Nullable Spec ofEntry(String entryId) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		if (e == null || !e.json().has("fill")) {
			return null;
		}
		try {
			return parse(e.json());
		} catch (RuntimeException ex) {
			return null;
		}
	}

	private static @Nullable JsonObject entryJson(@Nullable MinecraftServer srv, Site s) {
		int v = s.versioning().version();
		if (srv != null && v > 0) {
			Blueprints.Version ver = Blueprints.version(srv, s.blueprint(), v);
			if (ver != null) {
				return ver.entry().json();
			}
		}
		Blueprints.Entry e = Blueprints.entry(s.blueprint());
		return e == null ? null : e.json();
	}

	/** A template cell of a site in the world (the placement's rotation from the template box's corner). */
	static BlockPos world(Site s, int x, int y, int z) {
		Blueprint bp = Blueprints.get(s.blueprint());
		int turns = BlueprintTransform.parseTurns(s.rotation());
		int sx = bp != null ? bp.sizeX() : s.box().maxX() - s.box().minX() + 1;
		int sz = bp != null ? bp.sizeZ() : s.box().maxZ() - s.box().minZ() + 1;
		int[] rc = BlueprintTransform.rotateBlock(x, z, sx, sz, Math.max(0, turns));
		return new BlockPos(s.box().minX() + rc[0], s.box().minY() + y, s.box().minZ() + rc[1]);
	}

	/** The declared containers' world cells, in declaration order. */
	static List<BlockPos> containerCells(Site s, Spec spec) {
		List<BlockPos> out = new ArrayList<>();
		for (Box b : spec.containers()) {
			out.add(world(s, b.x(), b.y(), b.z()));
		}
		return out;
	}

	/** The lock cells by world cell. */
	static Map<Long, Lock> lockCells(Site s, Spec spec) {
		Map<Long, Lock> out = new LinkedHashMap<>();
		for (Lock l : spec.locks()) {
			out.put(world(s, l.x(), l.y(), l.z()).asLong(), l);
		}
		return out;
	}

	/** A state with a lock's properties set (only kept properties of that block; anything else is left as it is). */
	static BlockState locked(BlockState st, Lock l) {
		Set<String> kept = LOCK_PROPS.getOrDefault(st.getBlock(), Set.of());
		BlockState out = st;
		for (var e : l.props().entrySet()) {
			if (!kept.contains(e.getKey())) {
				continue;
			}
			Property<?> p = st.getBlock().getStateDefinition().getProperty(e.getKey());
			if (p != null) {
				out = with(out, p, e.getValue());
			}
		}
		return out;
	}

	/** A state with the lock's properties as {@code template} has them (the unlocked state). */
	static BlockState unlocked(BlockState now, BlockState template, Lock l) {
		BlockState out = now;
		for (String k : l.props().keySet()) {
			Property<?> p = now.getBlock().getStateDefinition().getProperty(k);
			if (p != null && template.hasProperty(p)) {
				out = copy(out, template, p);
			}
		}
		return out;
	}

	private static <T extends Comparable<T>> BlockState with(BlockState st, Property<T> p, String v) {
		return p.getValue(v).map(x -> st.setValue(p, x)).orElse(st);
	}

	private static <T extends Comparable<T>> BlockState copy(BlockState st, BlockState from, Property<T> p) {
		return st.setValue(p, from.getValue(p));
	}

	// ------------------------------------------------------------------ the site's progress

	public static @Nullable String phase(@Nullable Site s) {
		if (s == null) {
			return null;
		}
		JsonObject ext = s.ext();
		if (!ext.has(EXT_STATE) || !ext.get(EXT_STATE).isJsonObject()) {
			return null;
		}
		JsonObject o = ext.getAsJsonObject(EXT_STATE);
		return o.has("phase") ? o.get("phase").getAsString() : null;
	}

	/** Writes the phase into the site's record (the sites file, saved now). Returns the new record. */
	static Site setPhase(MinecraftServer srv, Site s, String phase) {
		JsonObject ext = s.ext();
		JsonObject o = new JsonObject();
		o.addProperty("phase", phase);
		ext.add(EXT_STATE, o);
		Site n = s.withOwnership(s.owner(), ext);
		Sites.replace(srv, n);
		Site now = Sites.get(s.id());
		return now != null ? now : n;
	}

	/** Whether a declared container holds exactly its declaration (plain stacks, per item, in any slots). */
	static boolean holdsExactly(Container c, Box b) {
		Map<String, Integer> now = plainCounts(c);
		return now != null && now.equals(b.counts());
	}

	/** A container's contents per item, or null when a stack carries components (never ours). */
	static @Nullable Map<String, Integer> plainCounts(Container c) {
		Map<String, Integer> m = new TreeMap<>();
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack st = c.getItem(i);
			if (st.isEmpty()) {
				continue;
			}
			if (!st.getComponentsPatch().isEmpty()) {
				return null;
			}
			m.merge(BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
		}
		return m;
	}

	/** Whether {@code now} is within {@code declared} (every item declared, none over its count). */
	static boolean within(Map<String, Integer> now, Map<String, Integer> declared) {
		for (var e : now.entrySet()) {
			if (e.getValue() > declared.getOrDefault(e.getKey(), 0)) {
				return false;
			}
		}
		return true;
	}

	/** After a write into a container: saved with its chunk, and comparators re-read it (Steward's review C). */
	static void touched(ServerLevel level, BlockPos p, BlockEntity be) {
		be.setChanged();
		level.updateNeighbourForOutputSignal(p, level.getBlockState(p).getBlock());
	}

	/** Writes a box's declared stacks into its (empty) container. */
	static void write(ServerLevel level, BlockPos p, Container c, Box b) {
		for (Stack st : b.items()) {
			Item item = BuiltInRegistries.ITEM.getValue(Identifier.parse(st.item()));
			if (st.slot() < c.getContainerSize()) {
				c.setItem(st.slot(), new ItemStack(item, st.count()));
			}
		}
		if (c instanceof BlockEntity be) {
			touched(level, p, be);
		}
	}

	/**
	 * A lock cell written with neighbour updates (the drops still suppressed), so the circuit reacts: the lever's own neighbours and the
	 * block it hangs on (vanilla's {@code LeverBlock.updateNeighbours}).
	 */
	static void writeLock(ServerLevel level, BlockPos p, BlockState st) {
		dev.larattalabs.architect.placed.Placed.set(level, p, st, Block.UPDATE_ALL | Block.UPDATE_SUPPRESS_DROPS);
		level.updateNeighborsAt(p, st.getBlock());
		if (st.getBlock() instanceof FaceAttachedHorizontalDirectionalBlock && st.hasProperty(FaceAttachedHorizontalDirectionalBlock.FACE)) {
			Direction to = switch (st.getValue(FaceAttachedHorizontalDirectionalBlock.FACE)) {
				case CEILING -> Direction.DOWN;
				case FLOOR -> Direction.UP;
				default -> st.getValue(FaceAttachedHorizontalDirectionalBlock.FACING);
			};
			level.updateNeighborsAt(p.relative(to.getOpposite()), st.getBlock());
		}
	}

	// ------------------------------------------------------------------ the fill step (survival)

	/** (TEST, {@code dev.fk}) Kill point FK3: the commit's chunks are flushed, then the JVM halts before the ledger is written. */
	static boolean haltBeforeLedger() {
		return inCommit && "FK3".equals(WorldJournal.armed());
	}

	/** Set around the fill's own commit save (so FK3 fires there, never at another save). */
	private static boolean inCommit;

	/**
	 * The fill step of a stockpile target whose queued cells all stand (called where the builder would complete it). Returns true when
	 * the site may complete now (no fill, or filled and unlocked); false while it waits (a declared container not empty, the stock short,
	 * a chunk not loaded).
	 */
	static boolean step(MinecraftServer srv, ServerLevel level, Site s, Builder.Run r, Builder.Purse purse) {
		String ph = phase(s);
		if (UNLOCKED.equals(ph)) {
			return true;
		}
		Spec spec = of(srv, s);
		if (spec == null) {
			return true;
		}
		StockLedger led = purse.ledger();
		if (led == null) {
			// a crate-fed site is refused at placement; one left from before (it can't be: FK is new) completes without a fill
			Architect.LOGGER.error("Construction site {}: a fill needs a stockpile; completed without it", s.id());
			return true;
		}
		String key = Builder.creditKey(s);
		if (FILLED.equals(ph) || led.filled(key)) {
			// the commit is on disk: never filled again, even into a container now empty (a player may have taken from it)
			if (!FILLED.equals(ph)) {
				s = setPhase(srv, s, FILLED);
			}
			unlock(srv, level, s, spec, r);
			return true;
		}
		List<BlockPos> cells = containerCells(s, spec);
		for (BlockPos p : cells) {
			if (Builder.stateIfLoaded(level, p) == null) {
				return false; // its chunk is not loaded: wait (the fill writes all of them in one tick)
			}
		}
		for (Lock l : spec.locks()) {
			if (Builder.stateIfLoaded(level, world(s, l.x(), l.y(), l.z())) == null) {
				return false;
			}
		}
		boolean replay = FILLING.equals(ph);
		List<BlockPos> blocked = new ArrayList<>();
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			BlockEntity be = level.getBlockEntity(p);
			if (!(be instanceof Container c)) {
				blocked.add(p); // the declared block is not a container (it can't stand: the cells are built); never filled
				continue;
			}
			if (c.isEmpty()) {
				continue;
			}
			if (replay && holdsExactly(c, spec.containers().get(i))) {
				// (FK3) the world got ahead of the ledger (chunks flushed, the ledger not): ours, uncharged: cleared with no credit
				c.clearContent();
				touched(level, p, be);
				Architect.LOGGER.warn("Construction site {}: fill at {} cleared after an unclean stop (the world was saved ahead of the ledger)", s.id(),
					p.toShortString());
				continue;
			}
			blocked.add(p);
		}
		if (!blocked.isEmpty()) {
			SiteWaits.fillBlocked(srv, s.id(), blocked);
			return false;
		}
		SiteWaits.fillUnblocked(srv, s.id());
		for (var e : spec.items().entrySet()) {
			if (purse.stock(e.getKey()) < e.getValue()) {
				SiteWaits.observe(srv, level, s.id(), dev.larattalabs.architect.survival.WaitCalc.Outcome.STARVED);
				return false;
			}
		}
		// (a) the intent, synchronous
		if (!replay) {
			s = setPhase(srv, s, FILLING);
		}
		WorldJournal.kill("FK1");
		// (c) one tick: the locks locked, the charge, the containers written
		for (var e : lockCells(s, spec).entrySet()) {
			BlockPos p = BlockPos.of(e.getKey());
			BlockState now = level.getBlockState(p);
			BlockState lk = locked(now, e.getValue());
			if (lk != now) {
				writeLock(level, p, lk);
			}
		}
		purse.pay(spec.costs());
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			write(level, p, (Container) level.getBlockEntity(p), spec.containers().get(i));
		}
		led.markFilled(key);
		purse.changed();
		Architect.LOGGER.info("Construction site {}: filled {} containers ({} items: {})", s.id(), cells.size(), dev.larattalabs.architect.survival.Refunds
			.Tally.total(spec.items()), spec.items());
		WorldJournal.kill("FK2");
		// (d) the commit: players, the chunks flushed, then the ledger with the marker and the charge
		inCommit = true;
		try {
			Stockpiles.saveWithWorld(srv);
		} finally {
			inCommit = false;
		}
		s = setPhase(srv, s, FILLED);
		WorldJournal.kill("FK4");
		unlock(srv, level, s, spec, r);
		return true;
	}

	/** Every lock cell back to its template state (with neighbour updates), then {@link #UNLOCKED}. Idempotent. */
	static void unlock(MinecraftServer srv, ServerLevel level, Site s, Spec spec, Builder.Run r) {
		for (var e : lockCells(s, spec).entrySet()) {
			BlockPos p = BlockPos.of(e.getKey());
			BlockState now = level.getBlockState(p);
			BlockState template = r.templateAt(p);
			if (template == null || !now.is(template.getBlock())) {
				continue; // gone or another block: nothing to unlock
			}
			BlockState un = unlocked(now, template, e.getValue());
			if (un != now) {
				writeLock(level, p, un);
			}
		}
		r.dropFill();
		setPhase(srv, s, UNLOCKED);
		Architect.LOGGER.info("Construction site {}: unlocked ({} lock cells)", s.id(), spec.locks().size());
	}

	// ------------------------------------------------------------------ creative

	/**
	 * An instant (creative) site of a fill entry, just placed or found at load still {@link #FILLING}: the declared stacks written (no bill)
	 * into each empty container (one already holding exactly its declaration is left), then {@link #UNLOCKED}. The template wrote the
	 * unlocked states.
	 */
	public static void creative(MinecraftServer srv, ServerLevel level, Site s) {
		if (s.construction() != null || UNLOCKED.equals(phase(s))) {
			return;
		}
		Spec spec = of(srv, s);
		if (spec == null) {
			return;
		}
		s = setPhase(srv, s, FILLING);
		List<BlockPos> cells = containerCells(s, spec);
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			level.getChunk(p);
			BlockEntity be = level.getBlockEntity(p);
			if (!(be instanceof Container c)) {
				continue;
			}
			if (c.isEmpty()) {
				write(level, p, c, spec.containers().get(i));
			} else if (!holdsExactly(c, spec.containers().get(i))) {
				Architect.LOGGER.warn("Site {}: the container at {} holds other items; not filled", s.id(), p.toShortString());
			}
		}
		setPhase(srv, s, UNLOCKED);
	}

	// ------------------------------------------------------------------ removal

	/** The declared containers of a filled site (FILLED or UNLOCKED), by world cell, with their declarations; empty for any other site. */
	public static Map<BlockPos, Map<String, Integer>> declaredOurs(@Nullable MinecraftServer srv, Site s) {
		String ph = phase(s);
		if (!FILLED.equals(ph) && !UNLOCKED.equals(ph)) {
			return Map.of();
		}
		Spec spec = of(srv, s);
		if (spec == null) {
			return Map.of();
		}
		Map<BlockPos, Map<String, Integer>> out = new java.util.HashMap<>();
		for (Box b : spec.containers()) {
			out.put(world(s, b.x(), b.y(), b.z()), b.counts());
		}
		return out;
	}

	/**
	 * A survival removal of a filled site, in the tick its credit is fixed: each declared container's contents out of the world into the
	 * ledger's custody under the site's key (at most its declaration). Returns a blocker message when a container holds more (cargo; not
	 * {@code force}), with nothing taken; null when done (or nothing to take). The caller saves with the world after.
	 */
	public static @Nullable String takeCustody(ServerLevel level, Site s, boolean force) {
		MinecraftServer srv = level.getServer();
		String ph = phase(s);
		if (!FILLED.equals(ph) && !UNLOCKED.equals(ph)) {
			return null; // before the commit nothing was filled (any content is cargo, refused by the blockers)
		}
		Spec spec = of(srv, s);
		Stockpiles.Pile pile = Stockpiles.pileOf(s);
		if (spec == null || pile == null) {
			return null;
		}
		List<BlockPos> cells = containerCells(s, spec);
		List<Map<String, Integer>> take = new ArrayList<>();
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			level.getChunk(p);
			BlockEntity be = level.getBlockEntity(p);
			Map<String, Integer> now = be instanceof Container c ? plainCounts(c) : Map.of();
			Map<String, Integer> declared = spec.containers().get(i).counts();
			if (now == null || !within(now, declared)) {
				if (!force) {
					return s.id() + ": the container at " + p.toShortString() + " holds more than its fill (cargo)";
				}
				Map<String, Integer> capped = new TreeMap<>();
				if (now != null) {
					now.forEach((k, v) -> {
						int n = Math.min(v, declared.getOrDefault(k, 0));
						if (n > 0) {
							capped.put(k, n);
						}
					});
				}
				now = capped;
			}
			take.add(now);
		}
		Map<String, Integer> all = new TreeMap<>();
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			if (level.getBlockEntity(p) instanceof Container c && level.getBlockEntity(p) instanceof BlockEntity be) {
				c.clearContent();
				touched(level, p, be);
			}
			take.get(i).forEach((k, v) -> all.merge(k, v, Integer::sum));
		}
		String key = Builder.creditKey(s);
		pile.ledger().holdCustody(key, all);
		Stockpiles.changed(pile);
		Architect.LOGGER.info("Site {}: its declared containers' contents taken into custody for the removal: {}", s.id(), all);
		return null;
	}

	/**
	 * A removal that ends without removing {@code s} (or a custody found at load whose site still stands, no removal holding it): its
	 * custody written back into its containers by their declarations, free, and dropped from the ledger.
	 */
	public static void writeBack(ServerLevel level, Site s) {
		Stockpiles.Pile pile = Stockpiles.pileOf(s);
		Spec spec = of(level.getServer(), s);
		if (pile == null || spec == null) {
			return;
		}
		String key = Builder.creditKey(s);
		Map<String, Integer> held = new TreeMap<>(pile.ledger().releaseCustody(key));
		if (held.isEmpty()) {
			return;
		}
		List<BlockPos> cells = containerCells(s, spec);
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			level.getChunk(p);
			if (!(level.getBlockEntity(p) instanceof Container c)) {
				continue;
			}
			for (Stack st : spec.containers().get(i).items()) {
				int n = Math.min(st.count(), held.getOrDefault(st.item(), 0));
				if (n <= 0 || st.slot() >= c.getContainerSize() || !c.getItem(st.slot()).isEmpty()) {
					continue;
				}
				c.setItem(st.slot(), new ItemStack(BuiltInRegistries.ITEM.getValue(Identifier.parse(st.item())), n));
				held.merge(st.item(), -n, Integer::sum);
			}
			if (c instanceof BlockEntity be) {
				touched(level, p, be);
			}
		}
		held.values().removeIf(v -> v <= 0);
		if (!held.isEmpty()) {
			Builder.dropItems(level, Builder.dropPos(s), held, null); // no slot left for them: at the site, never lost
		}
		Stockpiles.changed(pile);
		Architect.LOGGER.info("Site {}: its custody went back into its containers (the removal ended unwritten)", s.id());
	}

	// ------------------------------------------------------------------ load

	/**
	 * At an unclean or clean start, after the stockpiles and RL's reconcile, before players act: creative sites still {@link #FILLING}
	 * finish; a survival site {@link #FILLING} whose ledger has no commit has any container holding exactly its declaration cleared
	 * (the world saved ahead of the ledger: ours, uncharged); a custody whose site stands with no removal holding it goes back.
	 */
	public static void atStart(MinecraftServer srv) {
		for (Site s : Sites.all()) {
			String ph = phase(s);
			if (ph == null || UNLOCKED.equals(ph)) {
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, s);
			if (level == null) {
				continue;
			}
			if (s.construction() == null) {
				creative(srv, level, s);
				continue;
			}
			Stockpiles.Pile pile = Stockpiles.pileOf(s);
			Spec spec = of(srv, s);
			if (!FILLING.equals(ph) || pile == null || spec == null || pile.ledger().filled(Builder.creditKey(s))) {
				continue;
			}
			List<BlockPos> cells = containerCells(s, spec);
			for (int i = 0; i < cells.size(); i++) {
				BlockPos p = cells.get(i);
				level.getChunk(p);
				if (level.getBlockEntity(p) instanceof Container c && holdsExactly(c, spec.containers().get(i)) && c instanceof BlockEntity be) {
					c.clearContent();
					touched(level, p, be);
					Architect.LOGGER.warn("Site {}: fill at {} cleared at load (the world was saved ahead of the ledger; it fills once again)", s.id(),
						p.toShortString());
				}
			}
		}
		for (Stockpiles.Pile pile : Stockpiles.all()) {
			for (String key : pile.ledger().custodyKeys()) {
				Site s = siteOfKey(key);
				if (s != null && !Groups.leaving(s.id())) {
					ServerLevel level = Sites.levelOf(srv, s);
					if (level != null) {
						writeBack(level, s);
					}
				}
			}
		}
	}

	private static @Nullable Site siteOfKey(String key) {
		for (Site s : Sites.all()) {
			if (key.equals(Builder.creditKey(s))) {
				return s;
			}
		}
		return null;
	}

	// ------------------------------------------------------------------ dev

	/** (TEST, {@code dev.fk.state}) A site's fill: phase, cells, what each container holds, the ledger's marker and custody. */
	public static JsonObject stateJson(MinecraftServer srv, String id) {
		JsonObject o = new JsonObject();
		Site s = Sites.get(id);
		if (s == null) {
			o.addProperty("error", "no site " + id);
			return o;
		}
		Spec spec = of(srv, s);
		o.addProperty("phase", phase(s));
		o.addProperty("hasFill", spec != null);
		String key = Builder.creditKey(s);
		o.addProperty("key", key);
		Stockpiles.Pile pile = Stockpiles.pileOf(s);
		if (pile != null) {
			o.addProperty("filled", pile.ledger().filled(key));
			o.add("custody", Builder.counts(pile.ledger().custody(key)));
			Map<String, Integer> paid = pile.ledger().paid().get(key);
			o.add("paid", Builder.counts(paid == null ? Map.of() : paid));
		}
		if (spec == null) {
			return o;
		}
		o.add("fillItems", Builder.counts(spec.items()));
		ServerLevel level = Sites.levelOf(srv, s);
		JsonArray cs = new JsonArray();
		for (int i = 0; i < spec.containers().size(); i++) {
			BlockPos p = world(s, spec.containers().get(i).x(), spec.containers().get(i).y(), spec.containers().get(i).z());
			JsonObject c = new JsonObject();
			c.addProperty("at", p.getX() + "," + p.getY() + "," + p.getZ());
			c.add("declared", Builder.counts(spec.containers().get(i).counts()));
			if (level != null && level.isLoaded(p) && level.getBlockEntity(p) instanceof Container ct) {
				Map<String, Integer> now = plainCounts(ct);
				c.add("holds", now == null ? null : Builder.counts(now));
			}
			cs.add(c);
		}
		o.add("containers", cs);
		JsonArray ls = new JsonArray();
		for (Lock l : spec.locks()) {
			BlockPos p = world(s, l.x(), l.y(), l.z());
			JsonObject c = new JsonObject();
			c.addProperty("at", p.getX() + "," + p.getY() + "," + p.getZ());
			if (level != null && level.isLoaded(p)) {
				c.addProperty("state", level.getBlockState(p).toString());
			}
			ls.add(c);
		}
		o.add("locks", ls);
		return o;
	}
}
