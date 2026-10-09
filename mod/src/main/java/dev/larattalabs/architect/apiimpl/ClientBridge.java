package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * What the server-side API needs from the client side of the same singleplayer process: the one sidecar link and the
 * Library's client-held state (the bundled-entry overlay, the trash). The client registers it at init
 * ({@link ApiImpl#setClientBridge}); on a dedicated server there is none and these features report unavailable.
 * Every method is thread-safe; futures may complete on any thread (the API hops to the server thread). Internal.
 *
 * <p>The client side reports what the sidecar sends back through {@link ApiImpl}'s static notifications
 * ({@code designChanged}, {@code variantFinished}, {@code jobsSnapshot}, {@code jobChanged}, {@code toolCall},
 * {@code linkChanged}).
 */
public interface ClientBridge {
	/** The link is synced with a sidecar. */
	boolean connected();

	/** The protocol the sidecar chose: 1 when its snapshot names none (a phase 1-3 sidecar), 0 when not connected. */
	int protocol();

	/** The sidecar's {@code features} (empty for protocol 1). */
	Set<String> sidecarFeatures();

	/** {@code design.request {request}}; completes with the design id. */
	CompletableFuture<String> designRequest(JsonObject request);

	CompletableFuture<Void> designCancel(String designId);

	/** The designs the sidecar reports now, as received (copies). */
	List<JsonObject> designs();

	/** {@code variant.request {from, palette?, values?, name?}}; completes with the variant job id. */
	CompletableFuture<String> variantRequest(JsonObject payload);

	/** The Library's delete (to the trash, then a reload); false when refused (bundled, unknown). */
	CompletableFuture<Boolean> deleteEntry(String id);

	/** The Library's tag edit (in place, or the overlay for bundled entries). */
	CompletableFuture<Void> setTags(String id, List<String> tags);

	/**
	 * Sends one protocol message ({@code v} and {@code id} are added); completes with its ack as {@code {ok, error?, result?}}
	 * ({@code ok:false} is a normal completion), or fails when the link is down, on the ack timeout or when the link drops.
	 */
	CompletableFuture<JsonObject> send(JsonObject message);

	/** The bytes of a blob the sidecar stored ({@code <data>/blobs/<id>}), read off the calling thread. */
	CompletableFuture<byte[]> readBlob(String blobId);

	/** (6b) The helper's {@code kitVersion}, {@code irFormats} and {@code irKinds} from its snapshot, or null when unknown. */
	default com.google.gson.@org.jspecify.annotations.Nullable JsonObject sidecarVersions() {
		return null;
	}

	/**
	 * (6b, the START_SIDECAR nudge) Asks the launcher to (re)start the helper. Answers what happened: {@code "starting"} (a start
	 * was requested), {@code "already starting"}, {@code "connected"} (nothing to do), or why it can't.
	 */
	default String restartSidecar() {
		return "no launcher on this side";
	}
}
