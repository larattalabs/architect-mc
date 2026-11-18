package dev.larattalabs.architect.api;

import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A region lot: its site once placed; {@code state} is {@code pad}, {@code queued}, {@code placed} or {@code failed:<reason>}. Since 1.8.0.
 *
 * <p>Since 1.43.0 (6d RV): {@code removed} (its site removed alone, its pad standing: a refill builds it again), and {@code revision}, the rid
 * of the revision that added or last refilled it (0: the realised plan's).
 *
 * <p>(8b BS, features {@code "buildStatus"} and {@code "regionLayout"}; Since NEXT) {@code box}, the lot's box (pads too, both modes; null
 * when the plan can't be read), and {@code status}, its {@link BuildStatus}: never null. A pad or a queued lot is {@code planned} (a queued
 * lot whose item waits says why: occupied, player_in_box, terrain, stage, not_loaded); a placed lot is its site's status; a removed lot
 * {@code removed}; a failed one {@code failed} with {@code failed:<Reason>}; every lot of a removing region {@code removing}.
 */
public record LotState(String id, @Nullable String siteId, String state, int revision, @Nullable BoundingBox box, BuildStatus status) {
	public LotState {
		status = status == null ? BuildStatus.ofLotState(state, revision) : status;
	}

	/** The 1.43.0 constructor: no box; the status from {@code state} alone. */
	public LotState(String id, @Nullable String siteId, String state, int revision) {
		this(id, siteId, state, revision, null, null);
	}

	/** The 1.8.0 constructor (revision 0). */
	public LotState(String id, @Nullable String siteId, String state) {
		this(id, siteId, state, 0);
	}
}
