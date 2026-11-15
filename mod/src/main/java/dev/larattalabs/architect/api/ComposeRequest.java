package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Objects;
import net.minecraft.server.level.ServerLevel;
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
 *     {@link #EXT_REPAIR_ROUNDS}, {@link #EXT_SKIP_PICK}, {@link #EXT_VOCAB},
 *     {@link #EXT_STREET_FIX}); null is empty
 * @param level (7c CP) the level the claim is in, or null: the Overworld (as before CP). It is carried to the design, but regions are still
 *     Overworld only: a compose in another level ends {@code NO_PLAN} at once ($0, no pick or round) with {@code refused} {@code "NOT_ALLOWED:
 *     regions are Overworld only in this version"} and the summary "regions can only be built in the Overworld for now". Since 1.63.0.
 * @param owner (7c CP) the design's and its plans' owner, or null: the player (as before CP). Every round's check gets it as its {@code
 *     PlanRequest.owner}. Since 1.63.0.
 */
public record ComposeRequest(String brief, BoundingBox claim, @Nullable String styleId, boolean images, @Nullable Double budgetUsd, String opKey,
	JsonObject ext, @Nullable ServerLevel level, @Nullable String owner) {
	/**
	 * (7c CO) {@code ext[EXT_HINTS]}: the caller's structured hints, a JSON object (for example {@code {zones: [...], parts: [...]}}: the zones
	 * and parts it wants), at most 16,000 characters as JSON, shown to every composing round. Its {@code anchors} member, {@code {name: [x, y,
	 * z]}} (names {@code [a-z][a-z0-9_]{0,31}}, not a built-in {@code claim_*} one, at most 64), is the caller's named places: the composer
	 * may name them and every round's {@link Regions#checkPlan} gets them as its {@code anchors}. Since 1.58.0.
	 */
	public static final String EXT_HINTS = "architect_mc:composeHints";
	/**
	 * (7c CO) {@code ext[EXT_SYSTEM]}: the caller's rules, a string of at most 30,000 characters, appended to the composer's system prompt
	 * under its own heading (the whole system stays under the structured job's 120,000). Since 1.58.0.
	 */
	public static final String EXT_SYSTEM = "architect_mc:composeSystem";
	/** (7c CO) {@code ext[EXT_REPAIR_ROUNDS]}: repair rounds after the first, an integer 0 to 2 (default 1). Since 1.58.0. */
	public static final String EXT_REPAIR_ROUNDS = "architect_mc:repairRounds";
	/**
	 * (7c CP) {@code ext[EXT_SKIP_PICK]}: {@code true} composes the brief from plan/0's parts with no template pick first (no {@code region.design}
	 * pick, no pick cost, never PICKED; the result's {@code pick.outcome} is {@code SKIPPED}); absent or false: the pick first. Since 1.63.0.
	 */
	public static final String EXT_SKIP_PICK = "architect_mc:skipPick";
	/**
	 * (7c CP) {@code ext[EXT_VOCAB]}: {@code "families"} adds vocab/1's block families (the family names, groups, dyed families and the palette
	 * line) to the composer's system, for a palette rule's {@code family}; the check still refuses a name it does not know. Absent: none. Since
	 * 1.63.0.
	 */
	public static final String EXT_VOCAB = "architect_mc:composeVocab";
	/**
	 * (7c CP) {@code ext[EXT_STREET_FIX]}: {@code false} turns off the $0 street round (default on: after a paid round, a zone refused NO_ROOM
	 * whose evidence names the street layout gets its {@code wouldFit} fragment applied, as a free round the mod checks; no job). Since 1.63.0.
	 */
	public static final String EXT_STREET_FIX = "architect_mc:streetFix";

	public ComposeRequest {
		Objects.requireNonNull(brief, "brief");
		Objects.requireNonNull(claim, "claim");
		Objects.requireNonNull(opKey, "opKey");
		ext = ext == null ? new JsonObject() : ext;
	}

	/** The request as slice CO froze it: the Overworld, owner null (the player). */
	public ComposeRequest(String brief, BoundingBox claim, @Nullable String styleId, boolean images, @Nullable Double budgetUsd, String opKey,
		JsonObject ext) {
		this(brief, claim, styleId, images, budgetUsd, opKey, ext, null, null);
	}
}
