package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * What {@link SiteEvents#ITEM_PLACED}, {@link SiteEvents#ITEM_FAILED} and {@link SiteEvents#ITEM_WAITING} carry: the batch, the
 * item key and its merged ext (so a caller maps the item back to its lot), the site once there is one, and for a failure or a
 * wait the typed reason. Since 1.4.0.
 *
 * <p>(8b, Steward's S-8b-8; features {@code "buildStatus"}; Since 1.69.0) The typed homes of the ext keys a caller read: {@code region}
 * (ext {@code architect_mc:region}), {@code part} (the part the item builds, or its wait's part), {@code lot} ({@code architect_mc:lot}),
 * {@code revision} ({@code architect_mc:revision.rid}; 0 the realised plan's), and {@code status}, the item's {@link BuildStatus}: a wait's
 * typed reason and subject (the home of {@code architect_mc:waitsFor}: {@code kind} terrain gives reason {@code terrain} with
 * {@code waitsOn} the part; a stage wait {@code stage} with {@code waitsOn} the target it waits for; {@code bill_cap} with the over-cap
 * items in {@code needs} and its revision; {@code bill} (a whole charge the stockpile lacks) {@code materials} with {@code needs}; an
 * occupied box {@code occupied} or {@code player_in_box}; {@code not_loaded}), a placed item {@code built}, a failed one {@code failed}.
 * Null from the old constructor.
 */
public record ItemEvent(String batchId, String itemKey, JsonObject ext, Optional<String> siteId, Optional<Reason> reason, String message,
	@Nullable String region, @Nullable String part, @Nullable String lot, int revision, @Nullable BuildStatus status) {
	public ItemEvent {
		ext = ext == null ? new JsonObject() : ext;
		message = message == null ? "" : message;
	}

	/** The 1.4.0 constructor: no typed homes (null, revision 0). */
	public ItemEvent(String batchId, String itemKey, JsonObject ext, Optional<String> siteId, Optional<Reason> reason, String message) {
		this(batchId, itemKey, ext, siteId, reason, message, null, null, null, 0, null);
	}
}
