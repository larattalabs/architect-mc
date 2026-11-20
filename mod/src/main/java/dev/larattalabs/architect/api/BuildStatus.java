package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * (8b BS, feature {@code "buildStatus"}; docs/CONTRACT.md "Phase 8b" §3.1 and Steward's review) One status vocabulary for every
 * construction target and region piece: a building site, a road, a lot ({@link LotState#status}), a plan part ({@link PartBuild#status}),
 * a queued batch item ({@link ItemEvent#status}). It is derived only from what Architect already keeps ({@link SiteWait}, a target's pause,
 * the batch item's typed wait, the region's state); nothing new is stored. A caller reads {@code state}, {@code reason} and
 * {@code waitsOn}, never {@code say}: {@code say} is one English line for display only. Since 1.69.0.
 *
 * @param state {@link #PLANNED}, {@link #PLACING}, {@link #BUILDING}, {@link #WAITING}, {@link #PAUSED}, {@link #BUILT}, {@link #REMOVING},
 *              {@link #REMOVED} or {@link #FAILED}; strings only ever appended
 * @param reason null unless {@code state} is {@link #WAITING} or {@link #FAILED} (a batch item's wait with no typed cause, such as
 *               {@code PLAN_STALE} or {@code JOURNAL_UNAVAILABLE}, is {@code waiting} with a null reason: never guessed): {@link #MATERIALS}, {@link #BILL_CAP},
 *               {@link #FILL_BLOCKED}, {@link #TXN_HELD}, {@link #TERRAIN}, {@link #STAGE}, {@link #APPROVAL}, {@link #NOT_LOADED},
 *               {@link #OCCUPIED}, {@link #PLAYER_IN_BOX}, or (state failed) {@code failed:<Reason>}; (Since NEXT) {@link #HELD_DECIDED} with state
 *               {@link #REMOVING}: a decided removal that finishes by itself; appended only
 * @param waitsOn always a typed id, never text: for {@link #TERRAIN} the part whose staged terrain it waits on; for {@link #STAGE} the
 *                target (site, road or item key) it waits for; for {@link #BILL_CAP}, {@link #MATERIALS}, {@link #FILL_BLOCKED} and
 *                {@link #TXN_HELD} the target itself; otherwise null
 * @param needs item to count, in build order: for {@link #MATERIALS} {@link SiteWait#nextNeeded()} (at most 8); for {@link #BILL_CAP} the
 *              capped items' units over the cap; else empty. A map of items (as {@link RegionBuild#outstanding}), so a view holding a status
 *              stays plain-Gson serialisable
 * @param moreUnits the units of the shortfalls past {@code needs} ({@link SiteWait#moreUnits()})
 * @param since the game tick the wait (or pause, or failure) began: for a target equal to {@link SiteWait#waitingSince()}, and stable while
 *              the wait changes kind (materials to bill_cap and back); 0 when not waiting, or not known
 * @param say one English line, display only (Steward words its own)
 * @param revision the rid of the revision the piece belongs to (0: the realised plan's): for a {@link #BILL_CAP} hold, the revision whose
 *                 {@code maxBill} holds it (Steward's TakeUp needs the region and the rid)
 * @param capScope for {@link #BILL_CAP}: {@link SiteWait#capScope()} ({@code region}, {@code lot:<id>}, or both); else null
 */
public record BuildStatus(String state, @Nullable String reason, @Nullable String waitsOn, java.util.Map<net.minecraft.world.item.Item, Integer> needs, int moreUnits, long since, String say,
	int revision, @Nullable String capScope) {
	public static final String PLANNED = "planned";
	public static final String PLACING = "placing";
	public static final String BUILDING = "building";
	public static final String WAITING = "waiting";
	public static final String PAUSED = "paused";
	public static final String BUILT = "built";
	public static final String REMOVING = "removing";
	public static final String REMOVED = "removed";
	public static final String FAILED = "failed";

	public static final String MATERIALS = "materials";
	public static final String BILL_CAP = SiteWait.BILL_CAP;
	public static final String FILL_BLOCKED = SiteWait.FILL_BLOCKED;
	public static final String TXN_HELD = SiteWait.TXN_HELD;
	public static final String TERRAIN = "terrain";
	public static final String STAGE = "stage";
	public static final String APPROVAL = "approval";
	public static final String NOT_LOADED = "not_loaded";
	public static final String OCCUPIED = "occupied";
	public static final String PLAYER_IN_BOX = "player_in_box";
	/**
	 * The reason of a {@link #REMOVING} status whose removal is decided and held (its txn finishes it by itself, then the site is absent; a
	 * {@code REMOVAL_FINISHED} follows). Since NEXT.
	 */
	public static final String HELD_DECIDED = "held(decided)";

	/**
	 * The precedence when several hold, highest first, a strict order (documented and pinned by a table test): a removal, a failure, a
	 * pause, a txn hold, an approval, a stage wait, a terrain wait, a bill cap, a blocked fill, materials, a batch item's occupied, then
	 * player_in_box wait, not loaded; then removed, placing, building, planned and built (a piece's own progress). An untyped wait ranks
	 * just above built. {@link #rank} reads it.
	 */
	public static final List<String> PRECEDENCE = List.of(REMOVING, FAILED, PAUSED, TXN_HELD, APPROVAL, STAGE, TERRAIN, BILL_CAP, FILL_BLOCKED, MATERIALS,
		OCCUPIED, PLAYER_IN_BOX, NOT_LOADED, REMOVED, PLACING, BUILDING, PLANNED, BUILT);

	public BuildStatus {
		Objects.requireNonNull(state, "state");
		needs = needs == null ? java.util.Map.of() : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(needs));
		say = say == null ? "" : say;
	}

	/** A status with no wait: {@code state} alone. */
	public static BuildStatus of(String state, int revision) {
		return new BuildStatus(state, null, null, java.util.Map.of(), 0, 0L, sayOf(state, null), revision, null);
	}

	/**
	 * The rank of a status by {@link #PRECEDENCE}: lower wins (twice the index). A wait or a failure ranks by its reason
	 * ({@code failed:<Reason>} as {@link #FAILED}), anything else by its state; an untyped wait or an unknown string ranks just above
	 * {@link #BUILT}.
	 */
	public int rank() {
		String k = FAILED.equals(state) ? FAILED : WAITING.equals(state) && reason != null ? reason : state;
		int i = PRECEDENCE.indexOf(k);
		return i < 0 ? 2 * PRECEDENCE.indexOf(BUILT) - 1 : 2 * i;
	}

	/** Whichever of the two wins by {@link #PRECEDENCE} ({@code a} on a tie). */
	public static BuildStatus winner(BuildStatus a, BuildStatus b) {
		return b.rank() < a.rank() ? b : a;
	}

	/**
	 * A construction target's status from what its view already holds (pure): its {@link State}, its {@link SiteWait} (null for an instant
	 * site), whether it is paused and whether its removal runs. {@code since} is {@link SiteWait#waitingSince()}, so it is the wait's own
	 * tick whatever its kind.
	 */
	public static BuildStatus ofTarget(String id, State st, @Nullable SiteWait w, boolean paused, boolean removing, int revision) {
		if (removing) {
			return of(REMOVING, revision);
		}
		if (st == State.PLACING) {
			return of(PLACING, revision);
		}
		if (st == State.BUILT) {
			return of(BUILT, revision);
		}
		if (paused) {
			return new BuildStatus(PAUSED, null, null, java.util.Map.of(), 0, 0L, sayOf(PAUSED, null), revision, null);
		}
		if (w != null && w.waiting()) {
			String why = w.blocked() != null ? w.blocked() : MATERIALS;
			return new BuildStatus(WAITING, why, id, needsOf(w.nextNeeded()), w.moreUnits(), w.waitingSince(), sayOf(WAITING, why), revision, BILL_CAP.equals(why)
				? w.capScope() : null);
		}
		return of(BUILDING, revision);
	}

	/** A region lot's status from its {@link LotState#state} string alone (no site to read): pad planned, queued planned, ... Pure. */
	public static BuildStatus ofLotState(@Nullable String lotState, int revision) {
		if (lotState == null || "pad".equals(lotState) || "queued".equals(lotState)) {
			return of(PLANNED, revision);
		}
		if ("placed".equals(lotState)) {
			return of(BUILT, revision);
		}
		if ("removed".equals(lotState)) {
			return of(REMOVED, revision);
		}
		if (lotState.startsWith("failed")) {
			String r = lotState.indexOf(':') > 0 ? "failed:" + lotState.substring(lotState.indexOf(':') + 1) : "failed:OTHER";
			return new BuildStatus(FAILED, r, null, java.util.Map.of(), 0, 0L, sayOf(FAILED, r), revision, null);
		}
		return of(PLANNED, revision);
	}

	/** A plan part's status from its {@link PartBuild#state} string alone: waiting (nothing built yet) building, ... Pure. */
	public static BuildStatus ofPartState(@Nullable String partState) {
		return of("built".equals(partState) ? BUILT : BUILDING, 0);
	}

	/** {@link SiteWait#nextNeeded()} as an ordered item map. */
	public static java.util.Map<net.minecraft.world.item.Item, Integer> needsOf(List<ItemCount> l) {
		java.util.Map<net.minecraft.world.item.Item, Integer> m = new java.util.LinkedHashMap<>();
		l.forEach(c -> m.merge(c.item(), c.count(), Integer::sum));
		return m;
	}

	/** The default English line of a state and reason (display only). */
	public static String sayOf(String state, @Nullable String reason) {
		if (!WAITING.equals(state)) {
			return switch (state) {
				case PLANNED -> "planned";
				case PLACING -> "being placed";
				case BUILDING -> "building";
				case PAUSED -> "paused";
				case BUILT -> "built";
				case REMOVING -> "being removed";
				case REMOVED -> "removed";
				case FAILED -> reason == null ? "failed" : "failed (" + reason.substring(reason.indexOf(':') + 1) + ")";
				default -> state;
			};
		}
		return switch (reason == null ? "" : reason) {
			case MATERIALS -> "waiting for materials";
			case BILL_CAP -> "held at its approved bill";
			case FILL_BLOCKED -> "waiting for its containers to be emptied";
			case TXN_HELD -> "held by an unfinished operation";
			case TERRAIN -> "waiting for the land to be shaped";
			case STAGE -> "waiting for an earlier part";
			case APPROVAL -> "waiting for approval";
			case NOT_LOADED -> "waiting for its chunks to load";
			case OCCUPIED -> "waiting for the area to clear";
			case PLAYER_IN_BOX -> "waiting for a player to step out";
			default -> "waiting";
		};
	}
}
