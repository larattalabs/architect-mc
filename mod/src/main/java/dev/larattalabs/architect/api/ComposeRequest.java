package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Objects;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7c) A request to {@link Regions#compose}: the standalone composer (docs/CONTRACT.md "Phase 7c" §2, slice CO, S-7c-2). For players
 * and tests with no Steward; Steward's own plan writer keeps composing plan/0. Frozen by the 7c foundation; built by slice CO
 * (feature {@code "compose"}). Since NEXT.
 *
 * @param brief the one-line brief the settlement is composed from
 * @param claim the claim the plan is composed over
 * @param styleId the Style to compose with, or null (the composer's default)
 * @param images send the planning images (a hillshade with affordance ids, two sections, an iso) to the composing job
 * @param budgetUsd the composing job's spend cap, or null (the default)
 * @param opKey the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}); the same key and body return the same design
 * @param ext the caller's namespaced members (never read); null is empty
 */
public record ComposeRequest(String brief, BoundingBox claim, @Nullable String styleId, boolean images, @Nullable Double budgetUsd, String opKey,
	JsonObject ext) {
	public ComposeRequest {
		Objects.requireNonNull(brief, "brief");
		Objects.requireNonNull(claim, "claim");
		Objects.requireNonNull(opKey, "opKey");
		ext = ext == null ? new JsonObject() : ext;
	}
}
