package dev.larattalabs.architect.devserver;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.devserver.gen.CoreHooks;
import dev.larattalabs.architect.devserver.gen.DeltaDev;
import dev.larattalabs.architect.devserver.gen.JournalDev;
import dev.larattalabs.architect.devserver.gen.PortedHooks;
import dev.larattalabs.architect.devserver.gen.RegionDev;
import dev.larattalabs.architect.devserver.gen.SliceVDev;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Predicate;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * The headless gate server's entrypoint (dev only: a development environment with ARCHITECT_HEADLESS=1; anything else leaves
 * this mod inert). It starts the line bridge (the DevBridge's transport to tools/run-headless-server.mjs), registers the
 * hooks, joins the bot once the server has started, and starts (or reuses) the sidecar.
 */
public final class DevServer implements ModInitializer {
	private static volatile @Nullable MinecraftServer server;
	private static volatile boolean stopping;
	private static volatile long ticks;
	private static volatile long lastTickNanos = System.nanoTime();
	private static final List<Predicate<MinecraftServer>> EVERY_TICK = new CopyOnWriteArrayList<>();

	public static @Nullable MinecraftServer server() {
		return server;
	}

	public static boolean stopping() {
		return stopping;
	}

	public static long ticks() {
		return ticks;
	}

	public static long msSinceLastTick() {
		return (System.nanoTime() - lastTickNanos) / 1_000_000;
	}

	/** Runs {@code check} at the end of every server tick until it answers true. */
	public static void everyTick(Predicate<MinecraftServer> check) {
		EVERY_TICK.add(check);
	}

	public static CompletableFuture<Void> afterTicks(int n) {
		long until = ticks + n;
		CompletableFuture<Void> f = new CompletableFuture<>();
		everyTick(s -> {
			if (ticks >= until) {
				f.complete(null);
				return true;
			}
			return false;
		});
		return f;
	}

	// ------------------------------------------------------------------ world switches in this process

	/** True between a dev.host.leave and the next world: the JVM stays up with no server (the client's title screen). */
	private static volatile boolean keepJvm;
	private static volatile boolean idle;
	private static volatile @Nullable Thread serverThread;
	private static volatile CompletableFuture<Void> stopped = CompletableFuture.completedFuture(null);
	private static final Object KEEPER = new Object();

	public static boolean keepJvm() {
		return keepJvm;
	}

	/** No server runs and the process waits for the next world (after dev.host.leave). */
	public static boolean idle() {
		return idle;
	}

	/**
	 * Saves and stops the server. {@code keep}: the process stays up for the next world (dev.host.open), as a client goes to
	 * its title screen; else it exits once the server has stopped. Completes when the server has stopped.
	 */
	public static CompletableFuture<Void> stopServer(boolean keep) {
		MinecraftServer s = server;
		keepJvm = keep;
		if (s == null) {
			if (!keep) {
				exit(0);
			}
			return CompletableFuture.completedFuture(null);
		}
		stopping = true;
		CompletableFuture<Void> f = stopped;
		s.halt(false);
		return f;
	}

	/** Starts the server on {@code world} in this process (server.properties is the host's, written before). */
	public static void openWorld(String world) {
		if (server != null || !idle) {
			throw new IllegalStateException("already in a world (dev.world.leave first)");
		}
		idle = false;
		Thread old = serverThread;
		Thread t = new Thread(() -> {
			try {
				if (old != null) {
					old.join(120_000);
				}
				ServerOpen.open(world);
			} catch (Throwable e) {
				Architect.LOGGER.error("devserver: opening {} failed", world, e);
				exit(1);
			}
		}, "devserver-open");
		t.setDaemon(false);
		t.start();
	}

	private static void exit(int code) {
		Architect.LOGGER.info("devserver: exiting ({})", code);
		Runtime.getRuntime().halt(code);
	}

	/** Keeps the process alive between worlds; exits it when a server stops for good (not a switch). */
	private static void startKeeper() {
		Thread k = new Thread(() -> {
			while (true) {
				synchronized (KEEPER) {
					try {
						KEEPER.wait();
					} catch (InterruptedException e) {
						return;
					}
				}
				Thread st = serverThread;
				if (st != null) {
					try {
						st.join(120_000);
					} catch (InterruptedException e) {
						return;
					}
				}
				if (!keepJvm) {
					exit(0);
				}
			}
		}, "devserver-keeper");
		k.setDaemon(false);
		k.start();
	}

	@Override
	public void onInitialize() {
		if (!FabricLoader.getInstance().isDevelopmentEnvironment() || !"1".equals(System.getenv("ARCHITECT_HEADLESS"))) {
			Architect.LOGGER.info("devserver: inert (needs a development environment and ARCHITECT_HEADLESS=1)");
			return;
		}
		String token = System.getenv("ARCHITECT_DEV_TOKEN");
		if (token == null || token.isBlank()) {
			Architect.LOGGER.error("devserver: no ARCHITECT_DEV_TOKEN; the headless bridge stays off");
			return;
		}
		CoreHooks.init();
		PortedHooks.init();
		JournalDev.init();
		RegionDev.init();
		dev.larattalabs.architect.devserver.gen.RegionDev6b.init();
		DeltaDev.init();
		SliceVDev.init();
		dev.larattalabs.architect.devserver.gen.SliceWDev.init();
		dev.larattalabs.architect.devserver.gen.SliceF2Dev.init();
		dev.larattalabs.architect.devserver.gen.SliceBDev.init(); // 6c B: dev.brush
		dev.larattalabs.architect.devserver.gen.SliceP0Dev.init(); // 6c P0: plan checks
		dev.larattalabs.architect.devserver.gen.StockpileDev.init();
		ServerSidecar.init();
		ServerLifecycleEvents.SERVER_STARTING.register(s -> {
			server = s;
			serverThread = Thread.currentThread();
			stopping = false;
			idle = false;
			keepJvm = false;
			stopped = new CompletableFuture<>();
			ServerSidecar.start();
		});
		ServerLifecycleEvents.SERVER_STARTED.register(s -> {
			if (!"0".equals(System.getenv("ARCHITECT_BOT"))) {
				Bot.spawn(s);
			}
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> stopping = true);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			ServerSidecar.worldStopped();
			ServerSidecar.setPausedQuiet(false);
			server = null;
			stopping = false;
			idle = true;
			stopped.complete(null);
			synchronized (KEEPER) {
				KEEPER.notifyAll();
			}
		});
		startKeeper();
		ServerTickEvents.END_SERVER_TICK.register(s -> {
			ticks++;
			lastTickNanos = System.nanoTime();
			Bot.tick(s);
			for (Predicate<MinecraftServer> p : EVERY_TICK) {
				boolean done;
				try {
					done = p.test(s);
				} catch (RuntimeException e) {
					Architect.LOGGER.warn("devserver: a tick check failed", e);
					done = true;
				}
				if (done) {
					EVERY_TICK.remove(p);
				}
			}
		});
		try {
			String socket = System.getenv("ARCHITECT_DEVSERVER_SOCKET");
			if (socket == null || socket.isBlank()) {
				Architect.LOGGER.error("devserver: no ARCHITECT_DEVSERVER_SOCKET; the headless bridge stays off");
				return;
			}
			LineBridge.start(Path.of(socket), token.strip());
		} catch (java.io.IOException e) {
			Architect.LOGGER.error("devserver: the line bridge did not start", e);
		}
	}
}
