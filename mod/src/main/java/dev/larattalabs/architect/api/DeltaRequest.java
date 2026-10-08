package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * A delta of a placed site to another version of its entry (docs/CONTRACT.md phase 5b). {@code toVersion} 0 = the entry's
 * head; {@code playerEdits} null = {@link PlayerEdits#KEEP}; {@code overlap} null = {@link OverlapPolicy#REFUSE} (growth into
 * another site's cells); {@code actor}: as for placement (INSTANT in a survival world needs permission; otherwise the delta
 * is a construction delta); {@code force}: a site of another owner (the owner rule) and a LAYER over another owner's site.
 * Since 1.7.0.
 */
public record DeltaRequest(String siteId, int toVersion, @Nullable PlayerEdits playerEdits, @Nullable OverlapPolicy overlap,
	@Nullable ServerPlayer actor, boolean force, JsonObject ext) {
	public DeltaRequest {
		ext = ext == null ? new JsonObject() : ext.deepCopy();
	}

	/** To the head, KEEP, REFUSE overlap, no actor, no force. */
	public DeltaRequest(String siteId) {
		this(siteId, 0, null, null, null, false, new JsonObject());
	}

	@Override
	public JsonObject ext() {
		return ext.deepCopy();
	}
}
