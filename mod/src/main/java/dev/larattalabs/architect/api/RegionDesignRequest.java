package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A region design ({@link Regions#design}, docs/CONTRACT.md phase 6b §7): template-first. One structured pick among the
 * bundled region programs (the catalogue: {@code crater_works}, {@code rift_city}, {@code walled_hill}, {@code sky_isle},
 * {@code floating_islands}) against the brief, the claim's survey summary and the bible's roles. With a fit the plan runs with
 * no further model call; without one the result still offers the closest program ({@code fits: false}, Steward S-6b-3).
 * There is no authoring fallback in 6b and no {@code designLots} (Steward S7). Since 1.9.0.
 *
 * @param brief the player's text (also the card's {@code text} when the card has none)
 * @param card Steward's card fields (S-6b-2), or null: the pick reads them as structured hints alongside the brief
 * @param claim the columns (x/z) to design for; y is ignored (as {@link RegionPlanRequest#claim()})
 * @param mustPass checker rules the picked plan must pass (e.g. {@code ["M1", "M2", "M3", "M4"]}); a plan with a finding of
 *     one of them is reported in the design's result (it is still planned)
 * @param model null: the sidecar's default for picks
 * @param budgetUsd null: the sidecar's default cap for the pick
 * @param requireFit true: a pick without a fit ends the design {@code FAILED} with an error starting {@code NO_TEMPLATE}
 *     ({@link Reason#NO_TEMPLATE}); false (the default): it ends {@code DONE} with outcome {@code NO_TEMPLATE} and the closest
 *     program offered
 * @param owner the designs and the plan's owner (null: the player)
 */
public record RegionDesignRequest(String brief, @Nullable Card card, ServerLevel level, BoundingBox claim, @Nullable String bible, List<String> mustPass,
	@Nullable String model, @Nullable Double budgetUsd, boolean requireFit, @Nullable String owner, JsonObject ext) {
	public RegionDesignRequest {
		mustPass = mustPass == null ? List.of() : List.copyOf(mustPass);
		ext = ext == null ? new JsonObject() : ext;
	}

	/** The request as docs/CONTRACT.md phase 6b §6.2 writes it: no card, a fit not required. */
	public RegionDesignRequest(String brief, ServerLevel level, BoundingBox claim, @Nullable String bible, List<String> mustPass, @Nullable String model,
		@Nullable Double budgetUsd, @Nullable String owner, JsonObject ext) {
		this(brief, null, level, claim, bible, mustPass, model, budgetUsd, false, owner, ext);
	}

	/**
	 * Steward's card (S-6b-2), each field optional: the site ("giant meteor crater"), the purpose ("mining facility"), the
	 * style ("hellish evil lair") and the player's own text.
	 */
	public record Card(@Nullable String site, @Nullable String purpose, @Nullable String style, @Nullable String text) {
	}
}
