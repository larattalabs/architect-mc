package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Objects;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7c) A request to {@link Regions#compose}: the standalone composer (docs/CONTRACT.md "Phase 7c" §2, slice CO, S-7c-2). For players
 * and tests with no Steward; Steward's own plan writer keeps composing plan/0. Frozen by the 7c foundation; built by slice CO
 * (feature {@code "compose"}). Since 1.55.0.
 *
 * @param brief the one-line brief the settlement is composed from
 * @param claim the claim the plan is composed over
 * @param styleId the Style to compose with, or null (the composer's default)
 * @param images send the planning images (a hillshade with affordance ids, two sections, an iso) to the composing job
 * @param budgetUsd the composing job's spend cap, or null (the default)
 * @param opKey the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}); the same key and body return the same design
 * @param ext the caller's namespaced members (never read, but for Architect's own keys below: {@link #EXT_HINTS}, {@link #EXT_SYSTEM},
 *     {@link #EXT_REPAIR_ROUNDS}); null is empty
 */
public record ComposeRequest(String brief, BoundingBox claim, @Nullable String styleId, boolean images, @Nullable Double budgetUsd, String opKey,
	JsonObject ext) {
	/**
	 * (7c CO) {@code ext[EXT_HINTS]}: the caller's structured hints, a JSON object (for example {@code {zones: [...], parts: [...]}}: the zones
	 * and parts it wants), at most 16,000 characters as JSON, shown to every composing round. Its {@code anchors} member, {@code {name: [x, y,
	 * z]}} (names {@code [a-z][a-z0-9_]{0,31}}, not a built-in {@code claim_*} one, at most 64), is the caller's named places: the composer
	 * may name them and every round's {@link Regions#checkPlan} gets them as its {@code anchors}. Since NEXT.
	 */
	public static final String EXT_HINTS = "architect_mc:composeHints";
	/**
	 * (7c CO) {@code ext[EXT_SYSTEM]}: the caller's rules, a string of at most 30,000 characters, appended to the composer's system prompt
	 * under its own heading (the whole system stays under the structured job's 120,000). Since NEXT.
	 */
	public static final String EXT_SYSTEM = "architect_mc:composeSystem";
	/** (7c CO) {@code ext[EXT_REPAIR_ROUNDS]}: repair rounds after the first, an integer 0 to 2 (default 1). Since NEXT. */
	public static final String EXT_REPAIR_ROUNDS = "architect_mc:repairRounds";

	public ComposeRequest {
		Objects.requireNonNull(brief, "brief");
		Objects.requireNonNull(claim, "claim");
		Objects.requireNonNull(opKey, "opKey");
		ext = ext == null ? new JsonObject() : ext;
	}
}
