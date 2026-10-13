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
 */
public record ApprovedRealise(String artifactSha, Mode mode, @Nullable ServerPlayer actor, Map<String, String> lotEntries, @Nullable String opKey,
	JsonObject ext) {
	public ApprovedRealise {
		mode = mode == null ? Mode.INSTANT : mode;
		lotEntries = lotEntries == null ? Map.of() : Map.copyOf(lotEntries);
		ext = ext == null ? new JsonObject() : ext;
	}
}
