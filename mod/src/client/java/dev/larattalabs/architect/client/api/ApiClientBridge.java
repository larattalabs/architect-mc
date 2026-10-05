package dev.larattalabs.architect.client.api;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.apiimpl.ApiImpl;
import dev.larattalabs.architect.apiimpl.ClientBridge;
import dev.larattalabs.architect.client.library.LibraryFeature;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.sidecar.SidecarLink;
import dev.larattalabs.architect.client.sidecar.SidecarState;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import org.jspecify.annotations.Nullable;

/**
 * The client side of the public API: the server-side API reaches the sidecar link and the Library feature through this
 * {@link ClientBridge}; design and variant changes from the sidecar (whoever started them) go to the API's events. Also
 * sends {@code client.paused} when the singleplayer game pauses or resumes, to a protocol-2 sidecar only.
 */
public final class ApiClientBridge implements ClientBridge {
	private static final Set<String> VARIANTS_SEEN = new HashSet<>();
	/** The designs as last received, readable from the server thread. */
	private static final java.util.Map<String, JsonObject> DESIGNS = new java.util.concurrent.ConcurrentHashMap<>();
	private static @Nullable Boolean lastPaused;

	private ApiClientBridge() {
	}

	public static void init() {
		ApiImpl.setClientBridge(new ApiClientBridge());
		Sidecar.state().addListener(new SidecarState.Listener() {
			@Override
			public void onSnapshot() {
				DESIGNS.clear();
				for (JsonObject d : Sidecar.state().designsRaw()) {
					DESIGNS.put(d.has("id") ? d.get("id").getAsString() : "?", d);
				}
			}

			@Override
			public void onDesign(SidecarState.@Nullable Design previous, SidecarState.Design d) {
				DESIGNS.put(d.id(), d.raw().deepCopy());
				ApiImpl.designChanged(d.raw());
			}

			@Override
			public void onVariant(SidecarState.@Nullable Variant previous, SidecarState.Variant v) {
				if (v.status().isRunning() || v.status() == SidecarState.VariantStatus.UNKNOWN) {
					return;
				}
				if (!VARIANTS_SEEN.add(v.id() + "@" + v.createdAt())) {
					return;
				}
				ApiImpl.variantFinished(v.id(), v.status() == SidecarState.VariantStatus.DONE, v.blueprintId(), v.error(), v.isImport());
			}
		});
		ClientTickEvents.END_CLIENT_TICK.register(ApiClientBridge::tick);
	}

	/** {@code client.paused {paused}} on every change of the singleplayer pause state, when the sidecar speaks protocol 2. */
	private static void tick(Minecraft mc) {
		boolean paused = mc.hasSingleplayerServer() && mc.isPaused();
		if (lastPaused != null && lastPaused == paused) {
			return;
		}
		boolean first = lastPaused == null;
		lastPaused = paused;
		if (first && !paused) {
			return;
		}
		if (Sidecar.connected() && Sidecar.state().protocol() >= 2) {
			JsonObject m = new JsonObject();
			m.addProperty("type", "client.paused");
			m.addProperty("paused", paused);
			Sidecar.link().send(m).exceptionally(t -> null);
		}
	}

	private static <T> CompletableFuture<T> onClient(java.util.function.Supplier<CompletableFuture<T>> work) {
		CompletableFuture<T> out = new CompletableFuture<>();
		Minecraft.getInstance().execute(() -> {
			try {
				work.get().whenComplete((v, e) -> {
					if (e != null) {
						out.completeExceptionally(e);
					} else {
						out.complete(v);
					}
				});
			} catch (Throwable t) {
				out.completeExceptionally(t);
			}
		});
		return out;
	}

	private static String idOf(SidecarLink.Ack ack, String... keys) {
		if (!ack.ok()) {
			throw new IllegalStateException(ack.error() == null ? "refused by the helper" : ack.error());
		}
		JsonObject r = ack.result();
		if (r != null) {
			for (String k : keys) {
				if (r.has(k) && r.get(k).isJsonPrimitive()) {
					return r.get(k).getAsString();
				}
			}
		}
		throw new IllegalStateException("the helper sent no id");
	}

	@Override
	public boolean connected() {
		return Sidecar.connected();
	}

	@Override
	public int protocol() {
		return Sidecar.connected() ? Sidecar.state().protocol() : 0;
	}

	@Override
	public Set<String> sidecarFeatures() {
		return Sidecar.state().features();
	}

	@Override
	public CompletableFuture<String> designRequest(JsonObject request) {
		return onClient(() -> Sidecar.designRequest(request).thenApply(ack -> {
			String id = idOf(ack, "designId", "id");
			Architect.LOGGER.info("API: design {} requested", id);
			return id;
		}));
	}

	@Override
	public CompletableFuture<Void> designCancel(String designId) {
		return onClient(() -> Sidecar.designCancel(designId).thenApply(ack -> null));
	}

	@Override
	public List<JsonObject> designs() {
		return DESIGNS.values().stream().map(JsonObject::deepCopy).toList();
	}

	@Override
	public CompletableFuture<String> variantRequest(JsonObject payload) {
		return onClient(() -> Sidecar.variantRequest(payload).thenApply(ack -> idOf(ack, "variantId", "id")));
	}

	@Override
	public CompletableFuture<Boolean> deleteEntry(String id) {
		return onClient(() -> LibraryFeature.delete(id));
	}

	@Override
	public CompletableFuture<Void> setTags(String id, List<String> tags) {
		return onClient(() -> {
			if (!LibraryFeature.setTags(id, tags)) {
				return CompletableFuture.failedFuture(new IllegalStateException(String.valueOf(LibraryFeature.message())));
			}
			return CompletableFuture.completedFuture(null);
		});
	}
}
