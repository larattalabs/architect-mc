package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.survival.CellBits;
import java.util.Arrays;
import java.util.BitSet;
import org.jspecify.annotations.Nullable;

/**
 * What a construction site adds to its {@link Site} record (docs/CONTRACT.md phase 3 "Site record additions"). Pure data,
 * persisted in {@code architect-sites.json} on state changes and world saves, never per tick. What the builder has built
 * is not here: it is derived from the world ({@code built}); the ledger is in the crate's block entity.
 *
 * @param state {@link #BUILDING} or {@link #BUILT}
 * @param queue the cells to build, in build order: indexes into the site's snapshot box ({@link #index}), covering the
 *              template's cells, the foundation fill and the approach (path, slabs, fill)
 * @param target the file in {@code <world>/architect-sites/} holding what an instant placement wrote over the snapshot box
 *               (block states and block-entity NBT): what each queued cell gets
 * @param crate the construction crate's cell and what it held before; kept once the site is built (the crate block is gone, a
 *              deconstruct drops its refunds there, outside the box)
 * @param free queue positions whose cells were placed without payment ({@code /architect site finish})
 * @param paused the builder waits
 * @param owner the UUID of the player who placed it (the HUD line), or null
 */
public record Construction(String state, int[] queue, String target, @Nullable Crate crate, BitSet free, boolean paused, @Nullable String owner,
	@Nullable String delta, BitSet swap) {
	public static final String BUILDING = "building";
	public static final String BUILT = "built";

	/**
	 * The construction crate: its cell and what the cell held before (block state and block-entity NBT as SNBT), put back
	 * when the crate goes.
	 */
	public record Crate(int x, int y, int z, String snapshotState, @Nullable String snapshotNbt) {
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			JsonArray p = new JsonArray();
			p.add(x);
			p.add(y);
			p.add(z);
			o.add("pos", p);
			JsonObject s = new JsonObject();
			s.addProperty("state", snapshotState);
			if (snapshotNbt != null) {
				s.addProperty("nbt", snapshotNbt);
			}
			o.add("snapshot", s);
			return o;
		}

		public static Crate fromJson(JsonObject o) {
			JsonArray p = o.getAsJsonArray("pos");
			JsonObject s = o.getAsJsonObject("snapshot");
			return new Crate(p.get(0).getAsInt(), p.get(1).getAsInt(), p.get(2).getAsInt(), s.get("state").getAsString(),
				s.has("nbt") ? s.get("nbt").getAsString() : null);
		}
	}

	public Construction {
		queue = queue.clone();
		free = (BitSet) free.clone();
		swap = swap == null ? new BitSet() : (BitSet) swap.clone();
		if (!BUILDING.equals(state) && !BUILT.equals(state)) {
			throw new IllegalArgumentException("state must be building or built: " + state);
		}
	}

	/** Without a construction delta (phases 3-4e). */
	public Construction(String state, int[] queue, String target, @Nullable Crate crate, BitSet free, boolean paused, @Nullable String owner) {
		this(state, queue, target, crate, free, paused, owner, null, new BitSet());
	}

	/**
	 * Phase 5b: a construction delta's queue ({@code delta}: its journal entry, whose {@code before} holds the old blocks of the
	 * {@code swap} cells: changed cells that keep the old version's block until their swap, when the new item is in the crate).
	 */
	public Construction withDelta(int[] q, BitSet f, @Nullable Crate c, @Nullable String d, BitSet sw) {
		return new Construction(BUILDING, q, target, c, f, false, owner, d, sw);
	}

	@Override
	public BitSet swap() {
		return (BitSet) swap.clone();
	}

	@Override
	public int[] queue() {
		return queue.clone();
	}

	@Override
	public BitSet free() {
		return (BitSet) free.clone();
	}

	public int size() {
		return queue.length;
	}

	/** The queue index {@code i}'s box index (no copy). */
	public int cell(int i) {
		return queue[i];
	}

	public boolean building() {
		return BUILDING.equals(state);
	}

	public Construction withState(String s, @Nullable Crate c) {
		return new Construction(s, queue, target, c, free, paused, owner, delta, swap);
	}

	public Construction withFree(BitSet f) {
		return new Construction(state, queue, target, crate, f, paused, owner, delta, swap);
	}

	public Construction withPaused(boolean p) {
		return new Construction(state, queue, target, crate, free, p, owner, delta, swap);
	}

	public Construction withCrate(@Nullable Crate c) {
		return new Construction(state, queue, target, c, free, paused, owner, delta, swap);
	}

	/** A cell's index in a box {@code dx} x {@code dy} x {@code dz} (x fastest, then z, then y). Pure. */
	public static int index(int x, int y, int z, int dx, int dz) {
		return (y * dz + z) * dx + x;
	}

	/** {x, y, z} offsets of a box index. */
	public static int[] offsets(int index, int dx, int dz) {
		int x = index % dx;
		int rest = index / dx;
		return new int[] {x, rest / dz, rest % dz};
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("state", state);
		o.addProperty("queueSize", queue.length);
		o.addProperty("queue", CellBits.intsBase64(queue));
		o.addProperty("target", target);
		if (crate != null) {
			o.add("crate", crate.toJson());
		}
		o.addProperty("free", CellBits.base64(free));
		if (paused) {
			o.addProperty("paused", true);
		}
		if (owner != null) {
			o.addProperty("owner", owner);
		}
		if (delta != null) {
			o.addProperty("delta", delta);
			o.addProperty("swap", CellBits.base64(swap));
		}
		return o;
	}

	public static Construction fromJson(JsonObject o) {
		int[] queue = CellBits.intsFromBase64(o.has("queue") ? o.get("queue").getAsString() : "");
		if (o.has("queueSize") && o.get("queueSize").getAsInt() != queue.length) {
			throw new IllegalArgumentException("construction queue holds " + queue.length + " cells, queueSize says " + o.get("queueSize").getAsInt());
		}
		return new Construction(o.has("state") ? o.get("state").getAsString() : BUILT, queue, o.get("target").getAsString(),
			o.has("crate") && o.get("crate").isJsonObject() ? Crate.fromJson(o.getAsJsonObject("crate")) : null,
			CellBits.fromBase64(o.has("free") ? o.get("free").getAsString() : ""), o.has("paused") && o.get("paused").getAsBoolean(),
			o.has("owner") ? o.get("owner").getAsString() : null, o.has("delta") ? o.get("delta").getAsString() : null, CellBits.fromBase64(o.has("swap")
				? o.get("swap").getAsString() : ""));
	}

	@Override
	public boolean equals(Object other) {
		return other instanceof Construction c && state.equals(c.state) && Arrays.equals(queue, c.queue) && target.equals(c.target)
			&& java.util.Objects.equals(crate, c.crate) && free.equals(c.free) && paused == c.paused && java.util.Objects.equals(owner, c.owner);
	}

	@Override
	public int hashCode() {
		return java.util.Objects.hash(state, Arrays.hashCode(queue), target, crate, free, paused, owner);
	}
}
