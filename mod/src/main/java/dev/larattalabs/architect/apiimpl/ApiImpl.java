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
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * The {@link ArchitectApi} singleton: thin facades over the internals. Created lazily (another mod may call
 * {@code ArchitectApi.get()} before Architect's initializer ran); {@link #init} hooks the server lifecycle. Internal.
 */
public final class ApiImpl implements ArchitectApi {

	private static final class Holder {
		static final ApiImpl INSTANCE = new ApiImpl();
	}

	private static volatile @Nullable MinecraftServer server;
	private static volatile boolean stopping;
	private static volatile @Nullable ClientBridge bridge;
	private static volatile boolean linkUp;
	/** Work that needs a running server, from while none ran (a variant that finished on the title screen). */
	private static final java.util.Queue<Runnable> DEFERRED = new java.util.concurrent.ConcurrentLinkedQueue<>();
	private static final java.util.concurrent.ScheduledExecutorService TIMERS = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
		Thread t = new Thread(r, "Architect-ApiTimers");
		t.setDaemon(true);
		return t;
	});

	private final LibraryImpl library = new LibraryImpl();
	private final SurveyImpl survey = new SurveyImpl();
	private final JobsImpl jobs = new JobsImpl();
	private final DesignsImpl designs = new DesignsImpl();
	private final BiblesImpl bibles = new BiblesImpl();
	private final SiteEvents events = new SiteEvents() {
	};

	private ApiImpl() {
	}

	public static ApiImpl instance() {
		return Holder.INSTANCE;
	}

	/** Called from Architect's initializer. */
	public static void init() {
		ServerLifecycleEvents.SERVER_STARTING.register(s -> {
			server = s;
			stopping = false;
		});
		ServerLifecycleEvents.SERVER_STARTED.register(ApiImpl::started);
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> stopping = true);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			stopping = false;
		});
		SurveyImpl.init();
		TIMERS.scheduleAtFixedRate(() -> {
			try {
				long now = System.currentTimeMillis();
				instance().library.expire(now);
				instance().designs.expire(now);
			} catch (Throwable t) {
				dev.larattalabs.architect.Architect.LOGGER.warn("API timers failed", t);
			}
		}, 1, 1, java.util.concurrent.TimeUnit.SECONDS);
	}

	/**
	 * A world loaded (server thread): what finished while none was loaded fires now: deferred variants, designs and jobs not
	 * reported yet (DESIGN_DONE / VARIANT_DONE / JOB_DONE).
	 */
	private static void started(MinecraftServer s) {
		for (Runnable r; (r = DEFERRED.poll()) != null;) {
			try {
				r.run();
			} catch (Throwable t) {
				dev.larattalabs.architect.Architect.LOGGER.warn("Deferred API work failed", t);
			}
		}
		ClientBridge b = bridge;
		if (b != null) {
			instance().designs.catchUp(s, b.designs());
		}
		instance().jobs.catchUp(s);
		instance().designs.catchUpGroups();
		instance().bibles.catchUp();
		instance().library.catchUpReskins();
		Versioned.catchUp(s); // phase 5b: ENTRY_VERSIONED missed while no world was loaded
		if (!pinsHooked) {
			pinsHooked = true;
			dev.larattalabs.architect.site.Sites.addListener(x -> Versioned.sendPins());
		}
	}

	private static boolean pinsHooked;

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

	/** The server, unless none runs or it is stopping (work queued on a stopping server may never run). */
	static @Nullable MinecraftServer workingServer() {
		return stopping ? null : server;
	}

	/** Runs on the server thread, or, when no server runs (or it is stopping), once the next world has loaded. */
	static void runOnServerOrDefer(Runnable r) {
		MinecraftServer s = workingServer();
		if (s == null) {
			DEFERRED.add(r);
		} else if (s.isSameThread()) {
			r.run();
		} else {
			s.execute(r);
		}
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

	/** A variant or import job finished (VARIANT_DONE now, or when the next world has loaded). */
	public static void variantFinished(String variantId, boolean ok, @Nullable String blueprintId, @Nullable String error, boolean isImport) {
		runOnServerOrDefer(() -> instance().library.variantFinished(server, variantId, ok, blueprintId, error, isImport));
	}

	/** {@code snapshot.jobs} (protocol 2), as received. */
	public static void jobsSnapshot(java.util.List<JsonObject> jobs) {
		instance().jobs.snapshot(jobs.stream().map(JsonObject::deepCopy).toList());
	}

	/** {@code job.upsert {job}}. */
	public static void jobChanged(JsonObject job) {
		instance().jobs.upsert(job.deepCopy());
	}

	/** {@code job.tool.call}: the handler registered for (owner, name) answers. */
	public static void toolCall(JsonObject call) {
		instance().jobs.toolCall(call.deepCopy());
	}

	/** (4b) {@code snapshot.groups} / {@code group.upsert {group}}, as received. */
	public static void groupChanged(JsonObject group) {
		instance().designs.groupChanged(group);
	}

	/** (4b) {@code snapshot.bibles} / {@code bible.upsert {bible}}: a bible job. */
	public static void bibleJobChanged(JsonObject job) {
		instance().bibles.jobChanged(job);
	}

	/** (4b) {@code snapshot.bibleIndex} / {@code bible.index {bibles}}. */
	public static void bibleIndex(java.util.List<JsonObject> bibles) {
		instance().bibles.index(bibles);
	}

	/** (4b) {@code snapshot.reskins} / {@code reskin.upsert {reskin}}. */
	public static void reskinChanged(JsonObject reskin) {
		instance().library.reskinChanged(reskin);
	}

	/** (4c) {@code massing.upsert {massing}} or a snapshot's massing: merged, MASSING_DONE once per installed version. */
	public static void massingChanged(JsonObject massing) {
		instance().designs.massingChanged(massing.deepCopy(), true);
	}

	/** (4c) {@code massing.removed {massingId}}. */
	public static void massingRemoved(String massingId) {
		instance().designs.massingRemoved(massingId);
	}

	/** (4c) The link synced with a massing helper: fetch every massing ({@code massing.list}) so the API's list is complete. */
	public static void massingsSync() {
		instance().designs.refreshMassings();
	}

	/** The designs facade, for the client UI (massings, approval). */
	public static Designs designsImpl() {
		return instance().designs;
	}

	/** The bibles, for the client UI (installed + built in). */
	public static BiblesImpl biblesImpl() {
		return instance().bibles;
	}

	/** The link synced, or dropped: futures waiting for a variant fail when it drops. */
	public static void linkChanged(boolean synced) {
		boolean was = linkUp;
		if (synced && !was) {
			Versioned.resetPins();
			runOnServer(Versioned::sendPins);
		}
		linkUp = synced;
		if (was && !synced) {
			int n = instance().library.linkLost();
			if (n > 0) {
				dev.larattalabs.architect.Architect.LOGGER.info("API: the helper disconnected; {} variant request(s) failed", n);
			}
		}
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
	public dev.larattalabs.architect.api.Bibles bibles() {
		return bibles;
	}

	@Override
	public Set<String> features() {
		ClientBridge b = bridge;
		boolean on = b != null && b.connected();
		return ApiRules.features(on ? b.protocol() : 0, on ? b.sidecarFeatures() : Set.of());
	}
}
