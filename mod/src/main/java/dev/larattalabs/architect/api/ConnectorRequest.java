package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Map;
import java.util.Objects;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * (7c) A request to {@link Sites#placeConnector}: a single 7a connector outside any region, between two points a player marks (or from
 * a site house's port to ground) (docs/CONTRACT.md "Phase 7c" §2, slice CX, §7.8, N-7b-1). Frozen by the 7c foundation; built by slice
 * CX (feature {@code "placeConnector"}). Since 1.55.0.
 *
 * <p>(8b, Steward's review, feature {@code "connectorCheck"}; Since NEXT) The typed trailing members, so a caller (Steward) can place a
 * survival connector under the same rules as a realise ({@link ApprovedRealise}): {@code owner}, {@code dimension} and {@code actor} win
 * over the {@code params["architect_mc:owner"]} and {@code params["architect_mc:dimension"]} keys (which still work when the typed member
 * is null); {@code maxBill} and {@code maxBillPerLot} are {@link ApprovedRealise#maxBill}'s and {@link ApprovedRealise#maxBillPerLot}'s,
 * enforced exactly as a realise's (the put-down refuses {@link Reason#BILL_CAP} before any write when the quote is past the cap, and a
 * later draw past it holds the target with {@link SiteWait#BILL_CAP}); a connector's plan has no lots, so a non-empty
 * {@code maxBillPerLot} is refused {@link Reason#BILL_CAP} with detail {@code unknown_lot:<id>}, as a realise naming a lot it does not
 * realise is; {@code ext} is the caller's, kept on the connector's region ({@link RegionView#ext}) as a realise's is.
 *
 * @param kind the connector's plan/0 kind, such as {@code rope_bridge}, {@code ladder}, {@code catwalk}, {@code rock_stair}
 * @param from the first end (world cell)
 * @param to the second end (world cell)
 * @param styleId the Style its blocks come from, or null (the default)
 * @param params the kind's own members, as its plan/0 def has them; null is empty
 * @param mode the placement mode
 * @param opKey the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}})
 * @param owner (Since NEXT) the owner whose stockpile feeds it in survival, or null (then {@code params["architect_mc:owner"]}, else none)
 * @param dimension (Since NEXT) its level, or null (then {@code params["architect_mc:dimension"]}, else the overworld)
 * @param actor (Since NEXT) the player it is placed for, or null; a {@link ServerPlayer}, as {@link ApprovedRealise#actor} is
 * @param maxBill (Since NEXT) the bound the caller approved (item id -> count), or null: no cap
 * @param maxBillPerLot (Since NEXT) per-lot caps, or null: none (a connector has no lots; see above)
 * @param ext (Since NEXT) the caller's ext, kept on the connector's region; null is empty
 */
public record ConnectorRequest(String kind, BlockPos from, BlockPos to, @Nullable String styleId, JsonObject params, Mode mode, String opKey,
	@Nullable String owner, @Nullable ResourceKey<Level> dimension, @Nullable ServerPlayer actor, @Nullable Map<String, Integer> maxBill,
	@Nullable Map<String, Map<String, Integer>> maxBillPerLot, JsonObject ext) {
	public ConnectorRequest {
		Objects.requireNonNull(kind, "kind");
		Objects.requireNonNull(from, "from");
		Objects.requireNonNull(to, "to");
		Objects.requireNonNull(mode, "mode");
		Objects.requireNonNull(opKey, "opKey");
		params = params == null ? new JsonObject() : params;
		maxBill = RealiseRequest.capOf(maxBill);
		maxBillPerLot = RealiseRequest.lotCapsOf(maxBillPerLot);
		ext = ext == null ? new JsonObject() : ext;
	}

	/** The 1.55.0 shape: no typed owner, dimension or actor, no cap, no ext. */
	public ConnectorRequest(String kind, BlockPos from, BlockPos to, @Nullable String styleId, JsonObject params, Mode mode, String opKey) {
		this(kind, from, to, styleId, params, mode, opKey, null, null, null, null, null, null);
	}

	/** (Since NEXT) The same request for this owner, dimension and actor (each null: as before). */
	public ConnectorRequest withParty(@Nullable String owner, @Nullable ResourceKey<Level> dimension, @Nullable ServerPlayer actor) {
		return new ConnectorRequest(kind, from, to, styleId, params, mode, opKey, owner, dimension, actor, maxBill, maxBillPerLot, ext);
	}

	/** (Since NEXT) The same request under these caps ({@link #maxBill}, {@link #maxBillPerLot}; null: none). */
	public ConnectorRequest withMaxBill(@Nullable Map<String, Integer> maxBill, @Nullable Map<String, Map<String, Integer>> maxBillPerLot) {
		return new ConnectorRequest(kind, from, to, styleId, params, mode, opKey, owner, dimension, actor, maxBill, maxBillPerLot, ext);
	}

	/** (Since NEXT) The same request with this ext (null: empty). */
	public ConnectorRequest withExt(@Nullable JsonObject ext) {
		return new ConnectorRequest(kind, from, to, styleId, params, mode, opKey, owner, dimension, actor, maxBill, maxBillPerLot, ext);
	}
}
