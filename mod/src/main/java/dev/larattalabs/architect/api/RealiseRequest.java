package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * {@link Regions#realise}. Since 1.8.0.
 *
 * @param mode INSTANT (or AUTO in a creative or survival-toggle-off world); CONSTRUCTION refuses NOT_ALLOWED
 * @param lotEntries lot id -> library entry id ({@code id} or {@code id@version}); unmapped lots stay pads
 * @param load null: {@code GENERATED_ONLY(max(64, the largest item's chunks + 36))}; {@code LOADED_ONLY} for staged builds near
 *             the player (no tickets, no prepare needed)
 * @param stages null: every stage of the plan, in order
 * @param force realise although the land drifted from the plan at region start ({@link Reason#DRIFTED}) or the claim overlaps
 *              another owner's region
 * @param maxWaitSeconds 0 (the default): the region's items wait without a time limit (Steward S8; the wait reason is shown in
 *              {@link RegionView#waiting()}). Above 0, opt-in: an item that has waited that long in all, for any reason (the
 *              player's chunks, the helper, its turn for the chunk budget), fails {@link Reason#TIMED_OUT} with the wait reason in
 *              its message. A stage held for drift is not an item wait and does not count.
 * @param opKey (since 1.14.0) the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}), scoped by (the plan's owner, "region.realise",
 *     opKey); a null key is the old behaviour. The same key with the same body returns the existing realise's region id, in any state
 *     (also while the realise is still starting); with a different body the future fails {@link ArchitectRefused}
 *     {@link Reason#OP_KEY_CONFLICT}. The body is every other component (the actor by UUID). Found after a restart by
 *     {@link Regions#realiseByKey}, including a realise that was interrupted and resumed; kept as long as the region exists (removing the
 *     region ends its key). The plan's lot {@code ext} needs no request member: the realise copies it onto each lot's site.
 */
public record RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
	boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext, int maxWaitSeconds, @Nullable String opKey) {
	public RealiseRequest {
		mode = mode == null ? Mode.AUTO : mode;
		lotEntries = lotEntries == null ? Map.of() : Map.copyOf(lotEntries);
		stages = stages == null ? null : List.copyOf(stages);
		ext = ext == null ? new JsonObject() : ext;
		maxWaitSeconds = Math.max(0, maxWaitSeconds);
	}

	/** The 1.13.0 constructor (no opKey). */
	public RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
		boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext, int maxWaitSeconds) {
		this(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, maxWaitSeconds, null);
	}

	/** Without a wait limit (S8's default) or an opKey. */
	public RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
		boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext) {
		this(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, 0, null);
	}
}
