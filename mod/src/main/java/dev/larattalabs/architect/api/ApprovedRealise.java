package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Map;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * (6c P0) Realise an approved plan check ({@link Regions#realiseApproved}; docs/CONTRACT.md "Phase 6c slice P0" §6): the artifact
 * sha the approval bound, the mode (regions are INSTANT only in this version), the actor, the library entries for provisional
 * lots ({@code lotId -> entry or entry@version}; a lot that named its entry in the plan needs none), an operation key (the
 * realise's: {@link Regions#realiseByKey} finds it after a restart) and the caller's {@code ext} (kept on the region). Since 1.23.0.
 *
 * <p>(BC, S-M5-9, since 1.60.0) {@code maxBill}: as {@link RealiseRequest#maxBill}, the bound the caller approved (item id -> count); null:
 * no cap.
 */
public record ApprovedRealise(String artifactSha, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable String opKey,
	JsonObject ext, @Nullable Map<String, Integer> maxBill) {
	public ApprovedRealise {
		mode = mode == null ? Mode.INSTANT : mode;
		lotEntries = lotEntries == null ? Map.of() : Map.copyOf(lotEntries);
		ext = ext == null ? new JsonObject() : ext;
		maxBill = RealiseRequest.capOf(maxBill);
	}

	/** The 1.23.0 shape: no cap. */
	public ApprovedRealise(String artifactSha, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable String opKey,
		JsonObject ext) {
		this(artifactSha, mode, actor, lotEntries, opKey, ext, null);
	}
}
