package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.api.ApiClientBridge;
import dev.larattalabs.architect.site.Batches;
import java.util.concurrent.CompletableFuture;

/** Phase 6c slice 0a DevBridge hooks (docs/DEVBRIDGE.md): the crash windows the gate drives. */
public final class Slice0aDev {
	private Slice0aDev() {
	}

	public static void init() {
		DevBridge.register("dev.batch.skipSave", 5_000, "{batchId} - (6c 0a) skip the queue save right after that batch's BATCH_DONE (fire, mark "
			+ "fired, [save]): kill the JVM then, and BATCH_DONE fires once on the next load", (req, mc) -> {
				String id = Fields.of(req).str("batchId");
				Batches.SKIP_SAVE.add(id);
				JsonObject o = new JsonObject();
				o.addProperty("batchId", id);
				o.addProperty("armed", true);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.api.dropAck", 5_000, "{type} - (6c 0a) the mod drops the next helper ack of that message type (bible.request, "
			+ "design.group, ...): the request reaches the helper, the API future never completes (kill the client, restart, adopt by opKey)",
			(req, mc) -> {
				String type = Fields.of(req).str("type");
				ApiClientBridge.DROP_ACK.add(type);
				JsonObject o = new JsonObject();
				o.addProperty("type", type);
				o.addProperty("armed", true);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.api.pending", 5_000, "{} - (6c 0a) how many API futures are pending (WORLD_STOPPED sweeps them at SERVER_STOPPING)",
			(req, mc) -> {
				JsonObject o = new JsonObject();
				o.addProperty("pending", dev.larattalabs.architect.apiimpl.StopSweep.pending());
				return CompletableFuture.completedFuture(o);
			});
	}
}
