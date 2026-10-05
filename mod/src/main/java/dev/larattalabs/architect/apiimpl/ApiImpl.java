package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Designs;
import dev.larattalabs.architect.api.Jobs;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.Sites;
import dev.larattalabs.architect.api.Survey;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * The {@link ArchitectApi} singleton: thin facades over the internals. Created lazily (another mod may call
 * {@code ArchitectApi.get()} before Architect's initializer ran); {@link #init} hooks the server lifecycle. Internal.
 */
public final class ApiImpl implements ArchitectApi {
	/** Java-side features, always present. */
	static final Set<String> JAVA_FEATURES = Set.of("sites", "events", "survey", "designs", "library", "variants", "preview");

	private static final class Holder {
		static final ApiImpl INSTANCE = new ApiImpl();
	}

	private static volatile @Nullable MinecraftServer server;
	private static volatile @Nullable ClientBridge bridge;

	private final LibraryImpl library = new LibraryImpl();
	private final SurveyImpl survey = new SurveyImpl();
	private final JobsStub jobs = new JobsStub();
	private final DesignsImpl designs = new DesignsImpl();
	private final SiteEvents events = new SiteEvents() {
	};

	private ApiImpl() {
	}

	public static ApiImpl instance() {
		return Holder.INSTANCE;
	}

	/** Called from Architect's initializer. */
	public static void init() {
		ServerLifecycleEvents.SERVER_STARTING.register(s -> server = s);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> server = null);
		SurveyImpl.init();
	}

	/** The client side registers its sidecar link and Library feature here (client init). */
	public static void setClientBridge(@Nullable ClientBridge b) {
		bridge = b;
	}

	static @Nullable ClientBridge bridge() {
		return bridge;
	}

	static @Nullable MinecraftServer server() {
		return server;
	}

	/** Runs on the server thread (now when already there); dropped when no server runs. */
	static void runOnServer(Runnable r) {
		MinecraftServer s = server;
		if (s == null) {
			return;
		}
		if (s.isSameThread()) {
			r.run();
		} else {
			s.execute(r);
		}
	}

	/** {@code f}, completed on the server thread (as it completes when no server runs). */
	static <T> CompletableFuture<T> onServerFuture(CompletableFuture<T> f) {
		CompletableFuture<T> out = new CompletableFuture<>();
		f.whenComplete((v, e) -> {
			MinecraftServer s = server;
			Runnable done = () -> {
				if (e != null) {
					out.completeExceptionally(e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e);
				} else {
					out.complete(v);
				}
			};
			if (s == null || s.isSameThread()) {
				done.run();
			} else {
				s.execute(done);
			}
		});
		return out;
	}

	// ------------------------------------------------------------------ notifications from the client side (any thread)

	/** A design changed (design.upsert or a snapshot): DESIGN_UPDATED / DESIGN_DONE on the server thread. */
	public static void designChanged(JsonObject raw) {
		JsonObject copy = raw.deepCopy();
		runOnServer(() -> instance().designs.changed(server, copy));
	}

	/** A variant or import job finished. */
	public static void variantFinished(String variantId, boolean ok, @Nullable String blueprintId, @Nullable String error, boolean isImport) {
		runOnServer(() -> instance().library.variantFinished(server, variantId, ok, blueprintId, error, isImport));
	}

	// ------------------------------------------------------------------ ArchitectApi

	@Override
	public Library library() {
		return library;
	}

	@Override
	public Sites sites(MinecraftServer s) {
		return new SitesImpl(s);
	}

	@Override
	public Survey survey() {
		return survey;
	}

	@Override
	public SiteEvents events() {
		return events;
	}

	@Override
	public Jobs jobs() {
		return jobs;
	}

	@Override
	public Designs designs() {
		return designs;
	}

	@Override
	public Set<String> features() {
		Set<String> out = new TreeSet<>(JAVA_FEATURES);
		ClientBridge b = bridge;
		if (b != null && b.connected()) {
			out.addAll(b.sidecarFeatures());
			if (b.protocol() >= 2) {
				out.add("protocol2");
			}
		}
		return Set.copyOf(out);
	}
}
