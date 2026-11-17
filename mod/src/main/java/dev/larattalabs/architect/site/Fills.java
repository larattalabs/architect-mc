package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.txn.TxnServer;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
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
	/** (FK-b, dev) Provided items destroyed by a break's strip ({@link FillGuard#strip}), since the server started. Server thread. */
	public static long STRIPPED;
	/** (Steward's review A) the lock properties vanilla keeps as written, per block (kit/lib/fill.mjs LOCK_PROPS). */
	static final Map<Block, Set<String>> LOCK_PROPS = Map.of(Blocks.LEVER, Set.of("powered"));

	private Fills() {
	}

	/** One declared stack; (FK-b) {@code provided}: module-provided (an allow-listed item, written unbilled, never refunded). */
	public record Stack(int slot, String item, int count, boolean provided) {
		public Stack(int slot, String item, int count) {
			this(slot, item, count, false);
		}
	}

	/** (FK-b) Whether an item id is one a fill may mark provided ({@link dev.larattalabs.architect.api.Limits#FILL_PROVIDED_ITEMS}). */
	public static boolean providedItem(String item) {
		return dev.larattalabs.architect.api.Limits.FILL_PROVIDED_ITEMS.contains(item);
	}

	/** (FK-b) An item-count map's provided part ({@code provided} true) or billed part. */
	static Map<String, Integer> part(Map<String, Integer> m, boolean provided) {
		Map<String, Integer> out = new TreeMap<>();
		m.forEach((k, v) -> {
			if (providedItem(k) == provided && v > 0) {
				out.put(k, v);
			}
		});
		return out;
	}

	/** A declared container: its template cell and stacks. */
	public record Box(int x, int y, int z, List<Stack> items) {
		public Box {
			items = List.copyOf(items);
		}

		/** Its declaration per item (provided items included: ours, never cargo). */
		public Map<String, Integer> counts() {
			Map<String, Integer> m = new TreeMap<>();
			items.forEach(s -> m.merge(s.item(), s.count(), Integer::sum));
			return m;
		}

		/** (FK-b) The items its declaration marks provided. */
		public Set<String> providedItems() {
			Set<String> out = new java.util.TreeSet<>();
			items.forEach(s -> {
				if (s.provided()) {
					out.add(s.item());
				}
			});
			return out;
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

		/** Every declared item, summed (provided ones included): what the fill writes. */
		public Map<String, Integer> items() {
			Map<String, Integer> m = new TreeMap<>();
			containers.forEach(b -> b.counts().forEach((k, v) -> m.merge(k, v, Integer::sum)));
			return m;
		}

		/** (FK-b) The fill's bill: every declared item but the provided ones (the pay, the stock check, the outstanding, the quote). */
		public Map<String, Integer> billed() {
			return part(items(), false);
		}

		/** (FK-b) The provided items, summed: written unbilled, never refunded. */
		public Map<String, Integer> provided() {
			return part(items(), true);
		}

		/** The bill as costs (the provided items left out). */
		public List<SurvivalItems.Cost> costs() {
			List<SurvivalItems.Cost> out = new ArrayList<>();
			billed().forEach((k, v) -> out.add(new SurvivalItems.Cost(k, v)));
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
				String key = BuiltInRegistries.ITEM.getKey(item.get()).toString();
				items.add(new Stack(slot, key, count, provided(it, key)));
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

	/** (FK-b) An item's {@code provided}, refused as the kit's rule {@code fill} refuses it (docs/CONTRACT.md "### FK-b contract" 1). */
	private static boolean provided(JsonObject it, String id) {
		boolean p = false;
		if (it.has("provided")) {
			JsonElement v = it.get("provided");
			if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isBoolean()) {
				throw new IllegalArgumentException("fill: provided must be true or false");
			}
			p = v.getAsBoolean();
		}
		boolean allowed = providedItem(id);
		if (p && !allowed) {
			throw new IllegalArgumentException("fill: " + id + " can't be module-provided (allowed: " + String.join(", ",
				new java.util.TreeSet<>(dev.larattalabs.architect.api.Limits.FILL_PROVIDED_ITEMS)) + ")");
		}
		if (!p && allowed) {
			throw new IllegalArgumentException("fill: " + id + " is creative-only; declare it provided: true");
		}
		return p;
	}

	/** (FK-b) The containers a provided item can't go in (they eject their contents when powered). */
	static final Set<Block> PROVIDED_NOT_IN = Set.of(Blocks.DROPPER, Blocks.DISPENSER);

	/**
	 * (FK-b) Why an entry's fill can't be placed, the template's blocks included (a provided item declared in a dropper or dispenser), or null.
	 * The placement paths call this one.
	 */
	public static @Nullable String refusal(Blueprints.@Nullable Entry e) {
		if (e == null) {
			return null;
		}
		String no = refusal(e.json());
		if (no != null || !e.json().has("fill")) {
			return no;
		}
		Spec spec = parse(e.json());
		if (spec == null || spec.provided().isEmpty() || e.template() == null) {
			return null;
		}
		dev.larattalabs.architect.placement.TemplateGrid g = dev.larattalabs.architect.placement.TemplateGrid.of(e);
		return providedCellRefusal(spec, (x, y, z) -> {
			for (int i = 0; i < g.states().length; i++) {
				if (g.xyz()[3 * i] == x && g.xyz()[3 * i + 1] == y && g.xyz()[3 * i + 2] == z) {
					return g.states()[i].getBlock();
				}
			}
			return null;
		});
	}

	/** A template cell's block, or null. */
	@FunctionalInterface
	interface BlockAt {
		@Nullable Block at(int x, int y, int z);
	}

	/** (FK-b, pure) The refusal of a provided item declared in a dropper or dispenser, or null. */
	static @Nullable String providedCellRefusal(Spec spec, BlockAt blocks) {
		for (Box b : spec.containers()) {
			if (b.providedItems().isEmpty()) {
				continue;
			}
			Block bl = blocks.at(b.x(), b.y(), b.z());
			if (bl != null && PROVIDED_NOT_IN.contains(bl)) {
				return "fill: a provided item can't go in a " + BuiltInRegistries.BLOCK.getKey(bl).getPath();
			}
		}
		return null;
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
		Blueprints.Entry e = entryOf(srv, s);
		return e == null ? null : e.json();
	}

	private static Blueprints.@Nullable Entry entryOf(@Nullable MinecraftServer srv, Site s) {
		int v = s.versioning().version();
		if (srv != null && v > 0) {
			Blueprints.Version ver = Blueprints.version(srv, s.blueprint(), v);
			if (ver != null) {
				return ver.entry();
			}
		}
		return Blueprints.entry(s.blueprint());
	}

	/** (FK-b fix) Per site version: each declared container's template block, by its template cell ({@link BlockPos#asLong}). */
	private static final Map<String, Map<Long, Block>> DECLARED_BLOCKS = new ConcurrentHashMap<>();

	/** (FK-b fix) The template's block at a declared container's cell, or null (no template, or no block there). */
	static @Nullable Block declaredBlock(@Nullable MinecraftServer srv, Site s, Box b) {
		String key = s.blueprint() + "|" + s.versioning().version() + "|" + Blueprints.revision();
		Map<Long, Block> m = DECLARED_BLOCKS.computeIfAbsent(key, k -> {
			Blueprints.Entry e = entryOf(srv, s);
			Spec spec = of(srv, s);
			if (e == null || e.template() == null || spec == null) {
				return Map.of();
			}
			dev.larattalabs.architect.placement.TemplateGrid g = dev.larattalabs.architect.placement.TemplateGrid.of(e);
			java.util.Set<Long> want = new java.util.HashSet<>();
			for (Box bx : spec.containers()) {
				want.add(BlockPos.asLong(bx.x(), bx.y(), bx.z()));
			}
			Map<Long, Block> out = new java.util.HashMap<>();
			for (int i = 0; i < g.states().length; i++) {
				long at = BlockPos.asLong(g.xyz()[3 * i], g.xyz()[3 * i + 1], g.xyz()[3 * i + 2]);
				if (want.contains(at)) {
					out.put(at, g.states()[i].getBlock());
				}
			}
			return Map.copyOf(out);
		});
		return m.get(BlockPos.asLong(b.x(), b.y(), b.z()));
	}

	/**
	 * (FK-b fix) Whether provided items may be written into the live block at a declared container's cell: always for a box with none;
	 * else the live block is the template's declared block and never a dropper or dispenser ({@link #PROVIDED_NOT_IN}). A swapped block
	 * (a hopper replaced by a dropper between rescans) or an unknown template is refused: fail closed.
	 */
	static boolean providedFits(@Nullable MinecraftServer srv, Site s, Box b, BlockState live) {
		if (b.providedItems().isEmpty()) {
			return true;
		}
		return providedFits(declaredBlock(srv, s, b), live.getBlock());
	}

	/** (FK-b fix; TEST, {@code dev.fk.guard}) How many fill attempts found a declared container's block swapped (no provided item written). */
	public static long SWAP_REFUSED;

	/** (FK-b fix, pure) The rule of {@link #providedFits(MinecraftServer, Site, Box, BlockState)} for a box with provided items. */
	static boolean providedFits(@Nullable Block declared, Block live) {
		return declared != null && live == declared && !PROVIDED_NOT_IN.contains(live);
	}

	/** A template cell of a site in the world (the placement's rotation from the template box's corner). */
	static BlockPos world(Site s, int x, int y, int z) {
		return world(s.box(), s.rotation(), x, y, z);
	}

	/**
	 * (FK-b fix, the release verification) A template cell in the world from the site's own stored footprint and rotation, never the
	 * library head's size: a fill's declaration belongs to the placed version, and a later head of another size must not move its cells
	 * (a resized head once moved a rotated site's guard off its hoppers). {@code box} is the rotated template's world box, so its extents
	 * are the template's, swapped for an odd number of turns.
	 */
	static BlockPos world(Anchors.Bounds box, String rotation, int x, int y, int z) {
		int turns = Math.max(0, BlueprintTransform.parseTurns(rotation));
		int ex = box.maxX() - box.minX() + 1;
		int ez = box.maxZ() - box.minZ() + 1;
		boolean odd = (turns & 1) == 1;
		int[] rc = BlueprintTransform.rotateBlock(x, z, odd ? ez : ex, odd ? ex : ez, turns);
		return new BlockPos(box.minX() + rc[0], box.minY() + y, box.minZ() + rc[1]);
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
		FillGuard.invalidate(); // (FK-b) the guard index follows the filled sites
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
			if (TxnServer.boxHeld(level, p) || TxnServer.held("site:" + s.id())) {
				return false; // (slice T1, §3.6 "Holds") an open txn holds the container or the site: the fill waits
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
			if (!providedFits(srv, s, spec.containers().get(i), level.getBlockState(p))) {
				// (FK-b fix) another block stands there (a hopper swapped for a dropper): no provided item is written; the fill waits
				SWAP_REFUSED++;
				blocked.add(p);
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
		for (var e : spec.billed().entrySet()) {
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
			if (now.getBlock() == lk.getBlock()) {
				// always with neighbour updates: a lock built (FLAGS, no updates) may never have told its circuit (Steward's review A)
				writeLock(level, p, lk);
			}
		}
		purse.pay(spec.costs());
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			write(level, p, (Container) level.getBlockEntity(p), spec.containers().get(i));
		}
		led.markFilled(key, spec.provided()); // (FK-b) the provided items with the marker: unbilled, never in paid[key]
		purse.changed();
		FillGuard.invalidate(); // (FK-b) its declared containers guarded from this tick
		Architect.LOGGER.info("Construction site {}: filled {} containers ({} billed items: {}; provided, unbilled: {})", s.id(), cells.size(),
			dev.larattalabs.architect.survival.Refunds.Tally.total(spec.billed()), spec.billed(), spec.provided());
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
			if (!providedFits(srv, s, spec.containers().get(i), level.getBlockState(p))) {
				Architect.LOGGER.warn("Site {}: the container at {} is not its declared block; its provided items not written", s.id(), p.toShortString());
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

	/**
	 * Whether a site's fill was written: its record FILLED or UNLOCKED, or (a survival site) its stockpile ledger holds the fill's commit
	 * marker (kept until the key's credit), so a record that lost its phase never turns filled hoppers into cargo.
	 */
	static boolean filledSite(Site s) {
		String ph = phase(s);
		if (FILLED.equals(ph) || UNLOCKED.equals(ph)) {
			return true;
		}
		Stockpiles.Pile pile = s.construction() == null ? null : Stockpiles.pileOf(s);
		return pile != null && pile.ledger().filled(Builder.creditKey(s));
	}

	/**
	 * (FK-b fix) Whether a site's declared containers are guarded ({@link FillGuard}): its fill written ({@link #filledSite}) or being
	 * written ({@link #FILLING}: a survival fill the world saved ahead of its ledger, FK3, holds its items until the reconcile at start).
	 */
	static boolean guardedSite(Site s) {
		return FILLING.equals(phase(s)) || filledSite(s);
	}

	/** The declared containers of a filled site (FILLED or UNLOCKED), by world cell, with their declarations; empty for any other site. */
	public static Map<BlockPos, Map<String, Integer>> declaredOurs(@Nullable MinecraftServer srv, Site s) {
		if (!filledSite(s)) {
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
		if (!filledSite(s)) {
			return null; // before the commit nothing was filled (any content is cargo, refused by the blockers)
		}
		Spec spec = of(srv, s);
		Stockpiles.Pile pile = Stockpiles.pileOf(s);
		if (spec == null || pile == null) {
			return null;
		}
		List<BlockPos> cells = containerCells(s, spec);
		if (TxnServer.held("site:" + s.id()) || cells.stream().anyMatch(p -> TxnServer.boxHeld(level, p))) {
			return s.id() + ": an open transaction holds it (" + TxnServer.heldWhy("site:" + s.id()) + ")"; // (slice T1) nothing taken
		}
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
		// (FK-b) billed items into custody (refunded with the blocks), provided ones apart (taken back, never refunded): the same change and save
		pile.ledger().holdCustody(key, part(all, false));
		pile.ledger().holdProvided(key, part(all, true));
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
		if (TxnServer.held("site:" + s.id()) || containerCells(s, spec).stream().anyMatch(p -> TxnServer.boxHeld(level, p))) {
			// (slice T1, §3.6 "Holds") an open txn holds the site or a container: the custody stays in the ledger, written back later
			Architect.LOGGER.warn("Site {}: custody write-back deferred: an open transaction holds it", s.id());
			return;
		}
		Map<String, Integer> held = new TreeMap<>(pile.ledger().custody(key));
		pile.ledger().heldProvided(key).forEach((k, v) -> held.merge(k, v, Integer::sum)); // (FK-b) the provided items go back too
		if (held.isEmpty()) {
			return;
		}
		// (slice T2, the custody residual) each cell's writes carry a receipt in its chunk (the same snapshot as its slots), so a retry after
		// a crash (the chunk saved, the ledger not: the custody still held) deducts what reached a cell instead of writing or paying it again;
		// what has no slot enters the stock under a keyed credit, in the custody release's own ledger write: never an item entity
		String wb = FillsWriteBack.key(key, pile.ledger().creditedKeys());
		List<BlockPos> cells = containerCells(s, spec);
		List<List<Stack>> decls = new ArrayList<>();
		List<Boolean> fits = new ArrayList<>();
		List<FillsWriteBack.Cell> now = new ArrayList<>();
		for (int i = 0; i < cells.size(); i++) {
			BlockPos p = cells.get(i);
			net.minecraft.world.level.chunk.LevelChunk ch = level.getChunkAt(p);
			decls.add(spec.containers().get(i).items());
			// (FK-b fix) a swapped block takes no provided item back (they end destroyed below, never dropped); billed items still go back
			fits.add(providedFits(level.getServer(), s, spec.containers().get(i), level.getBlockState(p)));
			Map<Integer, Stack> rc = FillsWriteBack.parse(dev.larattalabs.architect.txn.ChunkReceipts.of(ch), wb, p.getX(), p.getY(), p.getZ());
			if (!(level.getBlockEntity(p) instanceof Container c)) {
				now.add(new FillsWriteBack.Cell(false, 0, java.util.Set.of(), rc));
				continue;
			}
			java.util.Set<Integer> occ = new java.util.HashSet<>();
			for (int k = 0; k < c.getContainerSize(); k++) {
				if (!c.getItem(k).isEmpty()) {
					occ.add(k);
				}
			}
			now.add(new FillsWriteBack.Cell(true, c.getContainerSize(), occ, rc));
		}
		FillsWriteBack.Plan plan = FillsWriteBack.plan(held, decls, fits, now);
		pile.ledger().releaseCustody(key);
		pile.ledger().releaseProvided(key);
		for (int i = 0; i < cells.size(); i++) {
			Map<Integer, Stack> w = plan.writes().get(i);
			BlockPos p = cells.get(i);
			if (w.isEmpty() || !(level.getBlockEntity(p) instanceof Container c)) {
				continue;
			}
			for (Stack st : w.values()) {
				c.setItem(st.slot(), new ItemStack(BuiltInRegistries.ITEM.getValue(Identifier.parse(st.item())), st.count()));
			}
			dev.larattalabs.architect.txn.ChunkReceipts.add(level.getChunkAt(p), FillsWriteBack.receipt(wb, p.getX(), p.getY(), p.getZ(), w));
			if (c instanceof BlockEntity be) {
				touched(level, p, be);
			}
		}
		if (!plan.already().isEmpty()) {
			Architect.LOGGER.info("Site {}: custody already written back before a restart (chunk receipts {}): {}", s.id(), wb, plan.already());
		}
		if (!plan.destroyed().isEmpty()) {
			// (FK-b) a provided item with no free slot is destroyed, never dropped: it never reaches survival
			Architect.LOGGER.warn("Site {}: provided fill items with no free slot destroyed (never dropped): {}", s.id(), plan.destroyed());
		}
		// the rest, keyed: credited once (the key and the stock in one ledger write, with the custody's release), past capacity if need be
		pile.ledger().credit(wb, plan.stock(), Stockpiles.capacity(level.getServer(), pile), Stockpiles::maxStack);
		if (!plan.stock().isEmpty()) {
			Architect.LOGGER.info("Site {}: custody with no free slot entered the stock under {}: {}", s.id(), wb, plan.stock());
		}
		Stockpiles.changed(pile);
		DurableBarrier.Result br = Stockpiles.barrier(level.getServer());
		if (br.ok()) {
			// the ledger holding the release is durable over the chunks with the slots: the receipts are stale
			for (BlockPos p : cells) {
				dev.larattalabs.architect.txn.ChunkReceipts.remove(level.getChunkAt(p), r -> r.startsWith(wb + "@"));
			}
		} else {
			Architect.LOGGER.warn("Site {}: custody write-back saved later ({}): its chunk receipts stay until then", s.id(), br.outcome());
		}
		Architect.LOGGER.info("Site {}: its custody went back into its containers (the removal ended unwritten)", s.id());
	}

	// ------------------------------------------------------------------ other writers (XR)

	/**
	 * (M5 FK, the coordinator's ruling on the contract's XR row) Another writer (a lot or any site placement, a road, a tile or region
	 * target, a cell site) whose cells include a filled site's declared container or lock cell is refused before any write: an overwrite
	 * would destroy or double-refund the fill. Null when no such cell is hit; else the refusal's message naming the cell.
	 */
	public static @Nullable String overwriteRefusal(ServerLevel level, java.util.function.LongPredicate writes, @Nullable String self) {
		MinecraftServer srv = level.getServer();
		String dim = Sites.dimensionId(level);
		for (Site s : Sites.all()) {
			if (s.id().equals(self) || !dim.equals(s.dimension()) || phase(s) == null && !filledSite(s)) {
				continue;
			}
			Spec spec = of(srv, s);
			String hit = spec == null ? null : firstHit(spec, (x, y, z) -> world(s, x, y, z), writes);
			if (hit != null) {
				return "it would write over " + s.id() + "'s " + hit + " (a filled-container entry's cells are never overwritten)";
			}
		}
		return null;
	}

	/** A template cell to the world. */
	@FunctionalInterface
	interface ToWorld {
		BlockPos at(int x, int y, int z);
	}

	/** (pure) The first declared container or lock cell {@code writes} holds, as "filled container at x, y, z" / "lock cell at ...", or null. */
	static @Nullable String firstHit(Spec spec, ToWorld world, java.util.function.LongPredicate writes) {
		for (Box b : spec.containers()) {
			BlockPos p = world.at(b.x(), b.y(), b.z());
			if (writes.test(p.asLong())) {
				return "filled container at " + p.toShortString();
			}
		}
		for (Lock l : spec.locks()) {
			BlockPos p = world.at(l.x(), l.y(), l.z());
			if (writes.test(p.asLong())) {
				return "lock cell at " + p.toShortString();
			}
		}
		return null;
	}

	/** {@link #overwriteRefusal} over a list of written cells, thrown as NOT_ALLOWED. */
	static void refuseOverwrite(ServerLevel level, long[] positions, String what) throws Sites.SiteException {
		if (positions == null || positions.length == 0) {
			return;
		}
		it.unimi.dsi.fastutil.longs.LongOpenHashSet set = new it.unimi.dsi.fastutil.longs.LongOpenHashSet(positions);
		String no = overwriteRefusal(level, set::contains, null);
		if (no != null) {
			throw new Sites.SiteException(dev.larattalabs.architect.api.Reason.NOT_ALLOWED, what + ": " + no);
		}
	}

	// ------------------------------------------------------------------ load

	/**
	 * At an unclean or clean start, after the stockpiles and RL's reconcile, before players act: creative sites still {@link #FILLING}
	 * finish; a survival site {@link #FILLING} whose ledger has no commit has any container holding exactly its declaration cleared
	 * (the world saved ahead of the ledger: ours, uncharged); a custody whose site stands with no removal holding it goes back.
	 */
	public static void atStart(MinecraftServer srv) {
		Stockpiles.settlePendingCredits(srv); // (J2) a settled removal's pending credit books (custody included) before any write-back below
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
				if (TxnServer.boxHeld(level, p) || TxnServer.held("site:" + s.id())) {
					continue; // (slice T1) an open txn holds it: never cleared here (the fill waits while held)
				}
				level.getChunk(p);
				if (level.getBlockEntity(p) instanceof Container c && holdsExactly(c, spec.containers().get(i)) && c instanceof BlockEntity be) {
					c.clearContent();
					touched(level, p, be);
					Architect.LOGGER.warn("Site {}: fill at {} cleared at load (the world was saved ahead of the ledger; it fills once again)", s.id(),
						p.toShortString());
				}
			}
		}
		FillGuard.invalidate(); // (FK-b) the guard index from the loaded sites
		FillGuard.checkTransferGuard(); // (FK-b, 5d) a WARN when the optional Transfer API guard did not apply
		for (Stockpiles.Pile pile : Stockpiles.all()) {
			Set<String> keys = new java.util.TreeSet<>(pile.ledger().custodyKeys());
			keys.addAll(pile.ledger().heldProvidedKeys()); // (FK-b) a fill of provided items only has no billed custody
			for (String key : keys) {
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
		o.addProperty("state", s.construction() == null ? "INSTANT" : s.building() ? "BUILDING" : "BUILT");
		o.add("wait", SiteWaits.json(SiteWaits.view(srv, id), Sites.levelOf(srv, s)));
		String key = Builder.creditKey(s);
		o.addProperty("key", key);
		Stockpiles.Pile pile = Stockpiles.pileOf(s);
		if (pile != null) {
			o.addProperty("filled", pile.ledger().filled(key));
			o.add("custody", Builder.counts(pile.ledger().custody(key)));
			o.add("provided", Builder.counts(pile.ledger().provided(key))); // (FK-b) the fill's provided items, with the marker
			o.add("heldProvided", Builder.counts(pile.ledger().heldProvided(key))); // (FK-b) taken back by a removal, never refunded
			Map<String, Integer> paid = pile.ledger().paid().get(key);
			o.add("paid", Builder.counts(paid == null ? Map.of() : paid));
		}
		if (spec == null) {
			return o;
		}
		o.add("fillItems", Builder.counts(spec.billed())); // (FK-b) the bill (the provided items apart)
		o.add("providedItems", Builder.counts(spec.provided()));
		o.addProperty("stripped", STRIPPED);
		o.addProperty("guarded", FillGuard.declaredCount(srv, s));
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
				c.add("providedHolds", now == null ? null : Builder.counts(part(now, true))); // (FK-b)
			}
			c.add("providedDeclared", Builder.counts(part(spec.containers().get(i).counts(), true)));
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
