package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.serialization.Codec;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.site.Sites;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.fabricmc.fabric.api.attachment.v1.AttachmentRegistry;
import net.fabricmc.fabric.api.attachment.v1.AttachmentType;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1) The test-only kind {@code test.move}: items from one container to another, driven only by the dev hook {@code dev.txn.run}
 * (no real caller is migrated in T1). Effect 0 takes from the source container into transit (B, prepare); effect 1 puts them into the sink
 * (B, after the commit). Each receipt ({@code tx-n/i}, its compensation {@code tx-n/i!c}) goes in the chunk attachment
 * {@code architect_mc:txn_receipts} (§3.4 B: it survives the BE's replacement) in the same change as the container edit, and the chunk is
 * marked unsaved, so the receipt and the items reach the region file in one snapshot. A probe of an unloaded chunk is UNKNOWN.
 */
public final class TestMove {
	private TestMove() {
	}

	public static final String NAME = "test.move";
	/** The receipts of every txn effect applied in a chunk: persistent, saved with the chunk's snapshot, never synced to clients. */
	public static final AttachmentType<List<String>> RECEIPTS = AttachmentRegistry.<List<String>>builder().persistent(Codec.STRING.listOf())
		.buildAndRegister(Architect.id("txn_receipts"));

	static void init() {
		Architect.LOGGER.debug("Txn receipts attachment {}", RECEIPTS.identifier());
	}

	static final Adapter ADAPTER = new Adapter();

	public static final TxnKind KIND = new TxnKind() {
		@Override
		public String name() {
			return NAME;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.Adapter adapter(Effect e) {
			return "test.take".equals(e.op()) || "test.put".equals(e.op()) ? ADAPTER : null;
		}

		@Override
		public JsonObject result(TxnEntry t) {
			JsonObject r = new JsonObject();
			r.addProperty("moved", true);
			return r;
		}
	};

	/** A box resource: {@code box:<dim>@x,y,z}. */
	public static String box(String dim, BlockPos p) {
		return "box:" + dim + "@" + p.getX() + "," + p.getY() + "," + p.getZ();
	}

	/**
	 * dev.txn.run: plans and runs one move of {@code items} from {@code from} to {@code to} (both containers in {@code dim}), checking now
	 * that the source holds them and the sink has room (R-1). Answers the begin's status, the txn id, its phase and decision after the
	 * forward drive, or why it was refused.
	 */
	static JsonObject run(MinecraftServer srv, String dim, BlockPos from, BlockPos to, Map<String, Integer> items, @Nullable String key) {
		JsonObject o = new JsonObject();
		String bad = TestMoveCells.dimRefusal(dim);
		if (bad != null) {
			o.addProperty("refused", bad); // (T1b, P2) a non-canonical key would name a box the hold mixins never look up
			return o;
		}
		ServerLevel level = Sites.levelOf(srv, dim);
		if (level == null) {
			o.addProperty("refused", "no dimension " + dim);
			return o;
		}
		dim = level.dimension().identifier().toString(); // the hold key boxHeld builds, exactly
		TxnCore c = TxnServer.core();
		TxnCore.Started s = c.begin(NAME, key, List.of(box(dim, from), box(dim, to)), null);
		o.addProperty("begin", s.status().name());
		if (s.detail() != null) {
			o.addProperty("detail", s.detail());
		}
		if (s.status() != TxnCore.Begin.NEW) {
			// (T1 review P3) an open attempt or a committed result answers before the current contents are judged
			if (s.entry() != null) {
				o.addProperty("txn", s.entry().id);
			}
			if (s.done() != null) {
				o.addProperty("txn", s.done().id());
				o.add("result", s.done().result());
				o.addProperty("replayed", true);
			}
			return o;
		}
		BlockEntity sb = level.getBlockEntity(from);
		BlockEntity db = level.getBlockEntity(to);
		// (T1b) single plain chests only: the T1 holds don't cover a double chest's partner, per-type writers or other BE types (§6.1, T2)
		String cell = TestMoveCells.refusal(from, sb);
		if (cell == null) {
			cell = TestMoveCells.refusal(to, db);
		}
		if (cell != null) {
			o.addProperty("refused", cell);
			return o;
		}
		if (Sites.ownsCell(dim, from) || Sites.ownsCell(dim, to)) {
			o.addProperty("refused", "an Architect site or road covers a cell (the TEST kind stays clear of every legacy writer)");
			return o;
		}
		Container src = (Container) sb;
		Container dst = (Container) db;
		for (var e : items.entrySet()) {
			if (count(src, item(e.getKey())) < e.getValue()) {
				o.addProperty("refused", "the source holds fewer than " + e.getValue() + " " + e.getKey());
				return o;
			}
		}
		if (!fits(dst, items)) {
			o.addProperty("refused", "the sink has no room");
			return o;
		}
		TxnEntry t = s.entry();
		c.plan(t, Effect.of("test.take", EffectClass.B).prepare().items(items).move("container", Effect.TRANSIT).data("dim", dim).data("pos", pos(from)));
		c.plan(t, Effect.of("test.put", EffectClass.B).items(items).move(Effect.TRANSIT, "container").data("dim", dim).data("pos", pos(to)));
		JsonObject payload = new JsonObject();
		payload.addProperty("from", box(dim, from));
		payload.addProperty("to", box(dim, to));
		c.payload(t, "test_moved", payload);
		DurableFile.Outcome p = c.persist(t);
		o.addProperty("txn", t.id);
		o.addProperty("persist", p.name());
		if (p == DurableFile.Outcome.OK) {
			o.addProperty("status", c.drive(t).name());
		}
		o.addProperty("phase", t.phase().name());
		o.addProperty("decision", t.decision() == null ? null : t.decision().v());
		o.addProperty("held", t.held());
		return o;
	}

	static JsonArray pos(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}

	static BlockPos posOf(Effect e) {
		JsonArray a = e.data().getAsJsonArray("pos");
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	/** The chest at {@code p} (its own 27 slots), or null when the cell no longer holds a chest block entity. */
	static @Nullable Container container(ServerLevel level, BlockPos p) {
		BlockEntity be = level.getBlockEntity(p);
		return be != null && be.getType() == net.minecraft.world.level.block.entity.BlockEntityTypes.CHEST && be instanceof Container c ? c : null;
	}

	static Item item(String id) {
		Identifier k = Identifier.tryParse(id);
		Item it = k == null ? null : BuiltInRegistries.ITEM.getOptional(k).orElse(null);
		if (it == null) {
			throw new IllegalArgumentException("unknown item " + id);
		}
		return it;
	}

	static int count(Container c, Item it) {
		int n = 0;
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack s = c.getItem(i);
			if (s.is(it)) {
				n += s.getCount();
			}
		}
		return n;
	}

	/** Whether {@code items} fit in {@code c}'s empty slots and the room on its stacks of the same item. */
	static boolean fits(Container c, Map<String, Integer> items) {
		int free = 0;
		for (int i = 0; i < c.getContainerSize(); i++) {
			if (c.getItem(i).isEmpty()) {
				free++;
			}
		}
		int need = 0;
		for (var e : items.entrySet()) {
			Item it = item(e.getKey());
			int room = 0;
			for (int i = 0; i < c.getContainerSize(); i++) {
				ItemStack s = c.getItem(i);
				if (s.is(it)) {
					room += s.getMaxStackSize() - s.getCount();
				}
			}
			int left = Math.max(0, e.getValue() - room);
			need += (left + it.getDefaultMaxStackSize() - 1) / it.getDefaultMaxStackSize();
		}
		return need <= free;
	}

	static void takeFrom(Container c, Item it, int n) {
		for (int i = c.getContainerSize() - 1; i >= 0 && n > 0; i--) {
			ItemStack s = c.getItem(i);
			if (s.is(it)) {
				int k = Math.min(n, s.getCount());
				s.shrink(k);
				c.setItem(i, s.isEmpty() ? ItemStack.EMPTY : s);
				n -= k;
			}
		}
	}

	static void putInto(Container c, Item it, int n) {
		for (int i = 0; i < c.getContainerSize() && n > 0; i++) {
			ItemStack s = c.getItem(i);
			if (s.is(it) && s.getCount() < s.getMaxStackSize()) {
				int k = Math.min(n, s.getMaxStackSize() - s.getCount());
				s.grow(k);
				c.setItem(i, s);
				n -= k;
			}
		}
		for (int i = 0; i < c.getContainerSize() && n > 0; i++) {
			if (c.getItem(i).isEmpty()) {
				int k = Math.min(n, it.getDefaultMaxStackSize());
				c.setItem(i, new ItemStack(it, k));
				n -= k;
			}
		}
		if (n > 0) {
			throw new IllegalStateException("no room for " + n + " more");
		}
	}

	/** The receipts of the chunk at {@code p}, or null when the chunk is not loaded (the probe is UNKNOWN). */
	static @Nullable LevelChunk chunk(ServerLevel level, BlockPos p) {
		return level.getChunkSource().getChunkNow(p.getX() >> 4, p.getZ() >> 4);
	}

	/** A recovered txn's chunk is loaded for it (the recovery slot runs before anything else touches the box); a live one only reads. */
	static @Nullable LevelChunk chunkFor(TxnEntry t, ServerLevel level, BlockPos p) {
		LevelChunk ch = chunk(level, p);
		if (ch == null && !t.live) {
			ch = level.getChunk(p.getX() >> 4, p.getZ() >> 4);
		}
		return ch;
	}

	static List<String> receipts(LevelChunk ch) {
		List<String> r = ch.getAttached(RECEIPTS);
		return r == null ? List.of() : r;
	}

	static void addReceipt(LevelChunk ch, String key) {
		List<String> r = new ArrayList<>(receipts(ch));
		r.add(key);
		ch.setAttached(RECEIPTS, List.copyOf(r));
		ch.markUnsaved();
	}

	static final class Adapter implements TxnKind.Adapter {
		@Nullable ServerLevel level(Effect e) {
			MinecraftServer s = TxnServer.server();
			return s == null ? null : Sites.levelOf(s, e.data().get("dim").getAsString());
		}

		@Override
		public @Nullable String invalid(Effect e) {
			if (!(e.data().get("dim") instanceof com.google.gson.JsonPrimitive d) || !d.isString() || !(e.data().get("pos") instanceof JsonArray a)
				|| a.size() != 3) {
				return "dim (a string) and pos [x, y, z] are required";
			}
			String bad = TestMoveCells.dimRefusal(d.getAsString());
			if (bad != null) {
				return bad;
			}
			for (int i = 0; i < 3; i++) {
				if (!a.get(i).isJsonPrimitive() || !a.get(i).getAsJsonPrimitive().isNumber()) {
					return "pos must be three integers";
				}
			}
			if (e.items().isEmpty()) {
				return "no items";
			}
			for (String k : e.items().keySet()) {
				Identifier id = Identifier.tryParse(k);
				if (id == null || BuiltInRegistries.ITEM.getOptional(id).isEmpty()) {
					return "unknown item " + k;
				}
			}
			return null;
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			LevelChunk ch = level == null ? null : chunkFor(t, level, posOf(e));
			if (ch == null) {
				return Probe.UNKNOWN;
			}
			List<String> r = receipts(ch);
			if (r.contains(e.compKey(t.id))) {
				return Probe.COMPENSATED;
			}
			return r.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			LevelChunk ch = level == null ? null : chunkFor(t, level, posOf(e));
			Container c = level == null ? null : container(level, posOf(e));
			if (ch == null || c == null) {
				throw new IllegalStateException("its container is not loaded or gone");
			}
			boolean take = "test.take".equals(e.op());
			Map<String, Integer> items = new TreeMap<>(e.items());
			String cell = take ? TestMoveCells.refusal(posOf(e), level.getBlockEntity(posOf(e))) : null;
			if (cell != null) {
				throw new IllegalStateException(cell); // the prepare re-judges the cell: it may have become half of a double chest since the plan
			}
			if (take) {
				for (var x : items.entrySet()) {
					if (count(c, item(x.getKey())) < x.getValue()) {
						throw new IllegalStateException("the source no longer holds " + x.getValue() + " " + x.getKey());
					}
				}
			} else if (!fits(c, items)) {
				throw new IllegalStateException("the sink has no room");
			}
			items.forEach((k, n) -> {
				if (take) {
					takeFrom(c, item(k), n);
				} else {
					putInto(c, item(k), n);
				}
			});
			addReceipt(ch, e.key(t.id)); // the same tick, the same chunk: one snapshot holds both
			c.setChanged();
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			LevelChunk ch = level == null ? null : chunkFor(t, level, posOf(e));
			Container c = level == null ? null : container(level, posOf(e));
			if (ch == null || c == null) {
				throw new IllegalStateException("its container is not loaded or gone");
			}
			if (!fits(c, e.items())) {
				throw new IllegalStateException("no room to give back " + e.items()); // checked before any change: never a partial give-back
			}
			e.items().forEach((k, n) -> putInto(c, item(k), n));
			addReceipt(ch, e.compKey(t.id));
			c.setChanged();
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			BlockPos p = posOf(e);
			return "chunk " + (p.getX() >> 4) + "," + (p.getZ() >> 4);
		}
	}
}
