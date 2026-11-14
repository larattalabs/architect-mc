package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Objects;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7c) A request to {@link Regions#authorProgram}: an authoring session that writes a region program for a part no catalogue kind
 * fits (docs/CONTRACT.md "Phase 7c" §2, slice AU, S-7c-5). The program is installed world-local, owned by the caller, and a plan names
 * it as {@code program.authored {id, sha}}; the approved artifact freezes its source by sha ({@link Reason#AUTHORED_STALE} if it moves).
 * Frozen by the 7c foundation; built by slice AU (feature {@code "programAuthoring"}). Since 1.55.0.
 *
 * @param brief what the program is to make
 * @param claim the claim it is authored for
 * @param planId the plan the part belongs to, or null
 * @param partId the plan part it answers, or null
 * @param budgetUsd the session's spend cap, or null (the default)
 * @param opKey the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}})
 * @param ext the caller's namespaced members; (7c AU) the helper reads {@link #EXT_OWNER}, {@link #EXT_STYLE} and {@link #EXT_ROUNDS}; null is empty
 */
public record AuthorRequest(String brief, BoundingBox claim, @Nullable String planId, @Nullable String partId, @Nullable Double budgetUsd,
	String opKey, JsonObject ext) {
	/**
	 * (7c AU) {@code ext["architect_mc:owner"]}: the owner the authored program is installed for (a string; absent: the player). A plan
	 * names it only when checked for the same owner ({@link PlanRequest#owner()}). Since 1.59.0.
	 */
	public static final String EXT_OWNER = "architect_mc:owner";
	/** (7c AU) {@code ext["architect_mc:style"]}: the Style (bible id) the checker plans every round with (absent: the default roles). Since 1.59.0. */
	public static final String EXT_STYLE = "architect_mc:style";
	/** (7c AU) {@code ext["architect_mc:authorRounds"]}: at most this many rounds, 1 to 4 (absent: 4); other values refuse. Since 1.59.0. */
	public static final String EXT_ROUNDS = "architect_mc:authorRounds";

	public AuthorRequest {
		Objects.requireNonNull(brief, "brief");
		Objects.requireNonNull(claim, "claim");
		Objects.requireNonNull(opKey, "opKey");
		ext = ext == null ? new JsonObject() : ext;
	}
}
