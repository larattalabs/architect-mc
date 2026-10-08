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
 * @param force realise although the land drifted from the plan ({@link Reason#DRIFTED}) or the claim overlaps another
 *              owner's region
 */
public record RealiseRequest(String planId, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable LoadPolicy load,
	boolean autoApprove, @Nullable List<String> stages, boolean force, JsonObject ext) {
	public RealiseRequest {
		mode = mode == null ? Mode.AUTO : mode;
		lotEntries = lotEntries == null ? Map.of() : Map.copyOf(lotEntries);
		stages = stages == null ? null : List.copyOf(stages);
		ext = ext == null ? new JsonObject() : ext;
	}
}
