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
 */
public record RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
	boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext, int maxWaitSeconds) {
	public RealiseRequest {
		mode = mode == null ? Mode.AUTO : mode;
		lotEntries = lotEntries == null ? Map.of() : Map.copyOf(lotEntries);
		stages = stages == null ? null : List.copyOf(stages);
		ext = ext == null ? new JsonObject() : ext;
		maxWaitSeconds = Math.max(0, maxWaitSeconds);
	}

	/** Without a wait limit (S8's default). */
	public RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
		boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext) {
		this(planId, mode, actor, lotEntries, load, autoApprove, stages, force, ext, 0);
	}
}
