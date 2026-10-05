package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * A set of placements queued together ({@link Sites#queue}, docs/CONTRACT.md phase 4d): placed over ticks near the players,
 * waiting instead of refusing while something temporary is in the way, surviving relogs, with one undo for its
 * {@link SiteGroup}. Since 1.4.0.
 *
 * <p><b>Order:</b> by stage, then by {@code after} dependencies, then by list order; with {@code proximityFirst}, among the
 * items of the running stage whose dependencies are met, the one nearest any player goes first (ties keep list order).
 *
 * @param id the batch id, or null for a new one ({@code b<n>}); must be unused
 * @param owner the owner of the batch, its group and every site it places ({@code <modid>:<thing>}; null = the player). An
 *              existing {@code group} must have the same owner.
 * @param ext namespaced extra data; every site's ext is this merged with its item's {@code request.ext()} (item keys win)
 * @param group an existing site group to append to (its stages come after the group's own), or null for a new group (one
 *              is always made, so every batch has one undo)
 * @param items the placements; each item's {@code request} gives the design, level, origin, rotation, mode, force, actor and
 *              its own ext. The request's owner is ignored (the batch's owner wins).
 * @param stages named stages, in order; items name their stage in {@link Item#stage}, or are listed here (both work).
 *               Items in no stage form a stage named after the batch id, first, approved at once.
 * @param waitPolicy how long an item may wait for a temporary blocker before it fails {@link Reason#TIMED_OUT}
 * @param load {@link LoadPolicy#LOADED_ONLY} (wait for a player to come near) or {@code LOAD_BOUNDED(n)} (short-lived
 *             tickets for at most n chunks at a time)
 * @param proximityFirst null = the default: true with LOADED_ONLY, false with LOAD_BOUNDED
 * @param stopOnFailure a failed item stops the batch (as {@link Sites#cancelBatch}); otherwise the batch goes on
 * @param autoApprove stages are approved as they come; otherwise each named stage waits for {@link Sites#approveStage}
 * @param sharedCrate survival: one crate feeds every construction site of the group, in placement order
 * @param crateAt where the shared crate goes (null: one cell beside the first site's approach end)
 */
public record Batch(@Nullable String id, @Nullable String owner, JsonObject ext, @Nullable String group, List<Item> items, List<StageSpec> stages,
	WaitPolicy waitPolicy, LoadPolicy load, @Nullable Boolean proximityFirst, boolean stopOnFailure, boolean autoApprove, boolean sharedCrate,
	@Nullable BlockPos crateAt) {
	public Batch {
		ext = ext == null ? new JsonObject() : ext;
		items = items == null ? List.of() : List.copyOf(items);
		stages = stages == null ? List.of() : List.copyOf(stages);
		waitPolicy = waitPolicy == null ? WaitPolicy.DEFAULT : waitPolicy;
		load = load == null ? LoadPolicy.LOADED_ONLY : load;
	}

	/** A batch with the defaults: a new group, no stages, a 10 min wait, LOADED_ONLY, proximity first. */
	public static Batch of(@Nullable String owner, List<Item> items) {
		return new Batch(null, owner, new JsonObject(), null, items, List.of(), WaitPolicy.DEFAULT, LoadPolicy.LOADED_ONLY, null, false, false,
			false, null);
	}

	public Batch withId(@Nullable String batchId) {
		return new Batch(batchId, owner, ext, group, items, stages, waitPolicy, load, proximityFirst, stopOnFailure, autoApprove, sharedCrate, crateAt);
	}

	public Batch withExt(JsonObject e) {
		return new Batch(id, owner, e, group, items, stages, waitPolicy, load, proximityFirst, stopOnFailure, autoApprove, sharedCrate, crateAt);
	}

	public Batch withGroup(@Nullable String groupId) {
		return new Batch(id, owner, ext, groupId, items, stages, waitPolicy, load, proximityFirst, stopOnFailure, autoApprove, sharedCrate, crateAt);
	}

	public Batch withStages(List<StageSpec> s, boolean approveAutomatically) {
		return new Batch(id, owner, ext, group, items, s, waitPolicy, load, proximityFirst, stopOnFailure, approveAutomatically, sharedCrate, crateAt);
	}

	public Batch withWait(WaitPolicy w) {
		return new Batch(id, owner, ext, group, items, stages, w, load, proximityFirst, stopOnFailure, autoApprove, sharedCrate, crateAt);
	}

	public Batch withLoad(LoadPolicy l) {
		return new Batch(id, owner, ext, group, items, stages, waitPolicy, l, proximityFirst, stopOnFailure, autoApprove, sharedCrate, crateAt);
	}

	public Batch withProximityFirst(@Nullable Boolean p) {
		return new Batch(id, owner, ext, group, items, stages, waitPolicy, load, p, stopOnFailure, autoApprove, sharedCrate, crateAt);
	}

	public Batch withStopOnFailure(boolean s) {
		return new Batch(id, owner, ext, group, items, stages, waitPolicy, load, proximityFirst, s, autoApprove, sharedCrate, crateAt);
	}

	public Batch withSharedCrate(boolean shared, @Nullable BlockPos at) {
		return new Batch(id, owner, ext, group, items, stages, waitPolicy, load, proximityFirst, stopOnFailure, autoApprove, shared, at);
	}

	/** {@link #proximityFirst} with its default resolved. */
	public boolean nearestFirst() {
		return proximityFirst != null ? proximityFirst : !load.loads();
	}

	/**
	 * One placement of a batch.
	 *
	 * @param itemKey unique within the batch; events and {@link SiteView#itemKey()} carry it
	 * @param request what to place; its {@code mode} is resolved when the batch is queued (INSTANT or CONSTRUCTION) and its
	 *                {@code actor} is kept as a UUID only (attribution; an actor who logs out changes nothing)
	 * @param stage the stage it belongs to, or null (see {@link Batch#stages})
	 * @param after item keys of this batch that must be placed first (in the same or an earlier stage)
	 */
	public record Item(String itemKey, PlaceRequest request, @Nullable String stage, List<String> after) {
		public Item {
			after = after == null ? List.of() : List.copyOf(after);
		}

		public static Item of(String itemKey, PlaceRequest request) {
			return new Item(itemKey, request, null, List.of());
		}
	}

	/** A named stage and the item keys in it (more can name it in {@link Item#stage}). */
	public record StageSpec(String name, List<String> items) {
		public StageSpec {
			items = items == null ? List.of() : List.copyOf(items);
		}
	}

	/** The longest an item waits for a temporary blocker (a player or mob in the box, unloaded chunks), in seconds of game time. */
	public record WaitPolicy(int maxWaitSeconds) {
		public static final WaitPolicy DEFAULT = new WaitPolicy(600);

		public WaitPolicy {
			maxWaitSeconds = Math.max(1, maxWaitSeconds);
		}
	}
}
